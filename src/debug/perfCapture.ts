import { getStratumBuildInfo } from "../versionInfo";
import { buildPerfReportFilename, exportPerfReportJson } from "./perfExport";
import { startPerfSpanCapture, stopPerfSpanCapture } from "./perfSpans";

type PerfSamplePoint = {
  tMs: number;
  fps: number;
  frameMs: number;
  memoryMb: number | null;
};

type BottomUpEntry = {
  functionName: string;
  selfMs: number;
  totalMs: number;
  samples: number;
  percent: number;
};

/** Optional world/scene counts at capture start (from {@link Game}). */
export type PerfWorldSnapshot = {
  loadedChunkCount: number;
  activeMobCount: number;
  worldTimeMs: number;
  viewDistanceChunks: number;
  streamCentreChunk: { cx: number; cy: number } | null;
};

type HotStackEntry = {
  stackLabel: string;
  totalMs: number;
  samples: number;
  percent: number;
};

type LongTaskEntry = {
  startTimeMs: number;
  durationMs: number;
  name: string;
};

type PerfCaptureOptions = {
  durationMs?: number;
  sampleIntervalMs?: number;
  /** Max rows in each bottom-up table (native + instrumented). Default 40. */
  topBottomUpEntries?: number;
  /** Distinct full JS stacks from self-profiling, ranked by sampled time. Default 15. */
  hotStackCount?: number;
  /** JS Self-Profiling API buffer size. Default 120_000. */
  maxProfilerBufferSize?: number;
  worldName: string;
  worldUuid: string;
  networkRole: "offline" | "host" | "client";
  worldSnapshot?: PerfWorldSnapshot;
};

type PerfCaptureResult = {
  outputPath: string;
  filename: string;
  summary: {
    fpsAvg: number;
    fpsMin: number;
    fpsP1Low: number;
    frameMsAvg: number;
    frameMsP95: number;
    frameMsMax: number;
    memoryMbPeak: number | null;
  };
  bottomUpAvailable: boolean;
  /** Prefer native self-profile bottom-up when present; else instrumented (same as report `bottomUpTop` legacy field). */
  bottomUpTop: BottomUpEntry[];
};

type MaybeProfiler = {
  stop: () => Promise<unknown>;
};

const DEFAULT_DURATION_MS = 30_000;
const DEFAULT_SAMPLE_INTERVAL_MS = 16;
const DEFAULT_TOP_BOTTOM_UP_ENTRIES = 40;
const DEFAULT_HOT_STACK_COUNT = 15;
const DEFAULT_MAX_PROFILER_BUFFER = 120_000;

type ProfilerSampleRow = { timestamp: number; stack: string[] };

function average(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[idx] ?? 0;
}

function safeFunctionName(raw: unknown): string {
  if (typeof raw !== "string") {
    return "(anonymous)";
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : "(anonymous)";
}

function memoryUsageMb(): number | null {
  const perf = performance as Performance & {
    memory?: { usedJSHeapSize?: number };
  };
  const used = perf.memory?.usedJSHeapSize;
  if (typeof used !== "number" || !Number.isFinite(used)) {
    return null;
  }
  return used / (1024 * 1024);
}

function estimateBottomUpFromSamples(
  sampleRows: readonly ProfilerSampleRow[],
  topN: number,
): BottomUpEntry[] {
  if (sampleRows.length === 0) {
    return [];
  }
  const totals = new Map<string, { selfMs: number; totalMs: number; samples: number }>();
  for (const [i, row] of sampleRows.entries()) {
    const nextTs = sampleRows[i + 1]?.timestamp ?? row.timestamp;
    const dtMs = Math.max(0, nextTs - row.timestamp);
    const stack = row.stack;
    if (stack.length === 0) {
      continue;
    }
    const leaf = stack[stack.length - 1];
    if (leaf === undefined) {
      continue;
    }
    const leafEntry = totals.get(leaf) ?? { selfMs: 0, totalMs: 0, samples: 0 };
    leafEntry.selfMs += dtMs;
    leafEntry.totalMs += dtMs;
    leafEntry.samples += 1;
    totals.set(leaf, leafEntry);
    for (let s = 0; s < stack.length - 1; s += 1) {
      const fn = stack[s];
      if (fn === undefined) {
        continue;
      }
      const entry = totals.get(fn) ?? { selfMs: 0, totalMs: 0, samples: 0 };
      entry.totalMs += dtMs;
      totals.set(fn, entry);
    }
  }
  const totalSelfMs = [...totals.values()].reduce((sum, entry) => sum + entry.selfMs, 0);
  return [...totals.entries()]
    .map(([functionName, entry]) => ({
      functionName,
      selfMs: Number(entry.selfMs.toFixed(3)),
      totalMs: Number(entry.totalMs.toFixed(3)),
      samples: entry.samples,
      percent: totalSelfMs > 0 ? Number(((entry.selfMs / totalSelfMs) * 100).toFixed(2)) : 0,
    }))
    .sort((a, b) => b.selfMs - a.selfMs)
    .slice(0, Math.max(1, topN));
}

function parseProfilerSampleRows(payload: unknown): ProfilerSampleRow[] {
  const data = payload as {
    samples?: Array<{ timestamp?: number; stackId?: string }>;
    stacks?: Array<{ id?: string; parentId?: string; frameId?: string }>;
    frames?: Array<{ frameId?: string; name?: string }>;
  };
  if (!Array.isArray(data.samples) || !Array.isArray(data.stacks) || !Array.isArray(data.frames)) {
    return [];
  }
  const stackById = new Map<string, { parentId: string | null; frameId: string | null }>();
  for (const stack of data.stacks) {
    if (typeof stack.id !== "string") {
      continue;
    }
    stackById.set(stack.id, {
      parentId: typeof stack.parentId === "string" ? stack.parentId : null,
      frameId: typeof stack.frameId === "string" ? stack.frameId : null,
    });
  }
  const frameNameById = new Map<string, string>();
  for (const frame of data.frames) {
    if (typeof frame.frameId !== "string") {
      continue;
    }
    frameNameById.set(frame.frameId, safeFunctionName(frame.name));
  }
  const rows: ProfilerSampleRow[] = [];
  for (const sample of data.samples) {
    if (typeof sample.timestamp !== "number" || typeof sample.stackId !== "string") {
      continue;
    }
    const stack: string[] = [];
    let node = stackById.get(sample.stackId) ?? null;
    let guard = 0;
    while (node !== null && guard < 120) {
      const frameName = node.frameId !== null ? frameNameById.get(node.frameId) : null;
      if (frameName !== undefined && frameName !== null) {
        stack.push(frameName);
      }
      node = node.parentId !== null ? (stackById.get(node.parentId) ?? null) : null;
      guard += 1;
    }
    stack.reverse();
    rows.push({ timestamp: sample.timestamp, stack });
  }
  rows.sort((a, b) => a.timestamp - b.timestamp);
  return rows;
}

function hotStacksFromSampleRows(rows: readonly ProfilerSampleRow[], topN: number): HotStackEntry[] {
  if (rows.length === 0) {
    return [];
  }
  const totals = new Map<string, { totalMs: number; samples: number }>();
  for (const [i, row] of rows.entries()) {
    const nextTs = rows[i + 1]?.timestamp ?? row.timestamp;
    const dtMs = Math.max(0, nextTs - row.timestamp);
    if (row.stack.length === 0) {
      continue;
    }
    const key = row.stack.join(" > ");
    const e = totals.get(key) ?? { totalMs: 0, samples: 0 };
    e.totalMs += dtMs;
    e.samples += 1;
    totals.set(key, e);
  }
  const totalWeight = [...totals.values()].reduce((s, x) => s + x.totalMs, 0);
  return [...totals.entries()]
    .map(([stackLabel, v]) => ({
      stackLabel,
      totalMs: Number(v.totalMs.toFixed(3)),
      samples: v.samples,
      percent: totalWeight > 0 ? Number(((v.totalMs / totalWeight) * 100).toFixed(2)) : 0,
    }))
    .sort((a, b) => b.totalMs - a.totalMs)
    .slice(0, Math.max(1, topN));
}

function maybeCreateProfiler(
  sampleIntervalMs: number,
  maxBufferSize: number,
): MaybeProfiler | null {
  const globalWithProfiler = globalThis as typeof globalThis & {
    Profiler?: new (options: { sampleInterval: number; maxBufferSize: number }) => MaybeProfiler;
  };
  if (typeof globalWithProfiler.Profiler !== "function") {
    return null;
  }
  try {
    return new globalWithProfiler.Profiler({
      sampleInterval: Math.max(10, Math.round(sampleIntervalMs * 1000)),
      maxBufferSize: Math.max(10_000, Math.floor(maxBufferSize)),
    });
  } catch {
    return null;
  }
}

type ProfilerCapability = {
  available: boolean;
  reason: string;
  isSecureContext: boolean;
  crossOriginIsolated: boolean;
};

function getProfilerCapability(): ProfilerCapability {
  const available = typeof (globalThis as { Profiler?: unknown }).Profiler === "function";
  return {
    available,
    reason: available ? "available" : "Profiler API unavailable in runtime/browser.",
    isSecureContext: globalThis.isSecureContext,
    crossOriginIsolated: globalThis.crossOriginIsolated,
  };
}

function startLongTaskObserver(): {
  disconnect: () => void;
  drain: () => LongTaskEntry[];
  observerActive: boolean;
} {
  const entries: LongTaskEntry[] = [];
  let obs: PerformanceObserver | null = null;
  let observerActive = false;
  try {
    obs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        entries.push({
          startTimeMs: Number(e.startTime.toFixed(3)),
          durationMs: Number(e.duration.toFixed(3)),
          name: typeof e.name === "string" && e.name.length > 0 ? e.name : "longtask",
        });
      }
    });
    obs.observe({ type: "longtask", buffered: true } as PerformanceObserverInit);
    observerActive = true;
  } catch {
    obs = null;
  }
  return {
    disconnect: () => {
      obs?.disconnect();
    },
    drain: () => entries,
    observerActive,
  };
}

export async function captureAndSavePerformanceReport(
  options: PerfCaptureOptions,
): Promise<PerfCaptureResult> {
  const durationMs = options.durationMs ?? DEFAULT_DURATION_MS;
  const sampleIntervalMs = options.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS;
  const topBottomUp = options.topBottomUpEntries ?? DEFAULT_TOP_BOTTOM_UP_ENTRIES;
  const hotStackCount = options.hotStackCount ?? DEFAULT_HOT_STACK_COUNT;
  const maxProfilerBufferSize = options.maxProfilerBufferSize ?? DEFAULT_MAX_PROFILER_BUFFER;

  const profilerCapability = getProfilerCapability();
  const profiler = maybeCreateProfiler(sampleIntervalMs, maxProfilerBufferSize);
  const longTaskObs = startLongTaskObserver();
  startPerfSpanCapture(durationMs + 250);
  const samples: PerfSamplePoint[] = [];
  const start = performance.now();
  let previousFrameTs = start;
  let lastSampleTs = start;
  while (true) {
    const ts = await new Promise<number>((resolve) => {
      requestAnimationFrame((rafTs) => resolve(rafTs));
    });
    const elapsedMs = ts - start;
    const frameMs = Math.max(0.001, ts - previousFrameTs);
    previousFrameTs = ts;
    if (ts - lastSampleTs >= sampleIntervalMs) {
      lastSampleTs = ts;
      samples.push({
        tMs: Number(elapsedMs.toFixed(2)),
        fps: Number((1000 / frameMs).toFixed(2)),
        frameMs: Number(frameMs.toFixed(3)),
        memoryMb: memoryUsageMb(),
      });
    }
    if (elapsedMs >= durationMs) {
      break;
    }
  }
  longTaskObs.disconnect();
  const longTasks = longTaskObs.drain();
  const longTaskObserverActive = longTaskObs.observerActive;

  const rawProfile = profiler !== null ? await profiler.stop().catch(() => null) : null;
  const profilerRows =
    rawProfile === null ? [] : parseProfilerSampleRows(rawProfile);
  const nativeBottomUp =
    profilerRows.length === 0 ? [] : estimateBottomUpFromSamples(profilerRows, topBottomUp);
  const hotStacksTop =
    profilerRows.length === 0 ? [] : hotStacksFromSampleRows(profilerRows, hotStackCount);
  const spanBottomUp = stopPerfSpanCapture(topBottomUp);
  const bottomUpTop =
    nativeBottomUp.length > 0 ? nativeBottomUp : spanBottomUp;
  const fpsSeries = samples.map((s) => s.fps);
  const frameSeries = samples.map((s) => s.frameMs);
  const memorySeries = samples
    .map((s) => s.memoryMb)
    .filter((m): m is number => m !== null);
  const summary = {
    fpsAvg: Number(average(fpsSeries).toFixed(2)),
    fpsMin: Number((fpsSeries.length > 0 ? Math.min(...fpsSeries) : 0).toFixed(2)),
    fpsP1Low: Number(percentile(fpsSeries, 0.01).toFixed(2)),
    frameMsAvg: Number(average(frameSeries).toFixed(3)),
    frameMsP95: Number(percentile(frameSeries, 0.95).toFixed(3)),
    frameMsMax: Number(Math.max(...frameSeries, 0).toFixed(3)),
    memoryMbPeak:
      memorySeries.length > 0 ? Number(Math.max(...memorySeries).toFixed(2)) : null,
  };

  const nativePresent = nativeBottomUp.length > 0;
  const instrumentedPresent = spanBottomUp.length > 0;
  let samplingMode: string;
  if (nativePresent && instrumentedPresent) {
    samplingMode = "js-self-profiling+instrumented";
  } else if (nativePresent) {
    samplingMode = "js-self-profiling";
  } else if (instrumentedPresent) {
    samplingMode = "instrumented-bottom-up";
  } else {
    samplingMode = "frame-metrics-fallback";
  }

  const report = {
    meta: {
      createdAtIso: new Date().toISOString(),
      build: getStratumBuildInfo(),
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      language: navigator.language,
      worldName: options.worldName,
      worldUuid: options.worldUuid,
      networkRole: options.networkRole,
      productionBundle: import.meta.env.PROD,
      gpuSpikeHint:
        "Chrome DevTools → Performance: enable GPU track + Frame stats to see whether spikes are main-thread vs GPU queue.",
      viewport: {
        cssWidth: typeof window !== "undefined" ? window.innerWidth : null,
        cssHeight: typeof window !== "undefined" ? window.innerHeight : null,
        devicePixelRatio:
          typeof window !== "undefined" && typeof window.devicePixelRatio === "number"
            ? window.devicePixelRatio
            : null,
      },
      worldSnapshot: options.worldSnapshot ?? null,
    },
    capture: {
      durationMs,
      sampleIntervalMs,
      topBottomUpEntries: topBottomUp,
      hotStackCount,
      maxProfilerBufferSize,
      bottomUpAvailable: bottomUpTop.length > 0,
      samplingMode,
      profilerCapability,
      longTaskObserverActive,
    },
    summary,
    bottomUpTop,
    bottomUpNative: nativeBottomUp,
    bottomUpInstrumented: spanBottomUp,
    hotStacksTop,
    longTasks,
    samples,
  };

  const filename = buildPerfReportFilename();
  const exported = await exportPerfReportJson(filename, report);
  return {
    outputPath: exported.outputPath,
    filename,
    summary,
    bottomUpAvailable: bottomUpTop.length > 0,
    bottomUpTop,
  };
}
