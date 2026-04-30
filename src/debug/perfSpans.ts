type SpanNode = {
  name: string;
  startMs: number;
  childMs: number;
};

type SpanAggregate = {
  selfMs: number;
  totalMs: number;
  calls: number;
};

type BottomUpEntry = {
  functionName: string;
  selfMs: number;
  totalMs: number;
  samples: number;
  percent: number;
};

type ActiveCapture = {
  startedAtMs: number;
  durationMs: number;
  stack: SpanNode[];
  totals: Map<string, SpanAggregate>;
};

let activeCapture: ActiveCapture | null = null;

function ensureRunning(nowMs: number): ActiveCapture | null {
  const capture = activeCapture;
  if (capture === null) {
    return null;
  }
  if (nowMs - capture.startedAtMs > capture.durationMs) {
    activeCapture = null;
    return null;
  }
  return capture;
}

export function startPerfSpanCapture(durationMs: number): void {
  activeCapture = {
    startedAtMs: performance.now(),
    durationMs,
    stack: [],
    totals: new Map<string, SpanAggregate>(),
  };
}

export function beginPerfSpan(name: string): number {
  const now = performance.now();
  const capture = ensureRunning(now);
  if (capture === null) {
    return 0;
  }
  capture.stack.push({ name, startMs: now, childMs: 0 });
  return capture.stack.length;
}

export function endPerfSpan(token: number): void {
  const now = performance.now();
  const capture = ensureRunning(now);
  if (capture === null || token <= 0) {
    return;
  }
  if (capture.stack.length !== token) {
    return;
  }
  const node = capture.stack.pop();
  if (node === undefined) {
    return;
  }
  const totalMs = Math.max(0, now - node.startMs);
  const selfMs = Math.max(0, totalMs - node.childMs);
  const agg = capture.totals.get(node.name) ?? { selfMs: 0, totalMs: 0, calls: 0 };
  agg.selfMs += selfMs;
  agg.totalMs += totalMs;
  agg.calls += 1;
  capture.totals.set(node.name, agg);
  const parent = capture.stack[capture.stack.length - 1];
  if (parent !== undefined) {
    parent.childMs += totalMs;
  }
}

export function withPerfSpan<T>(name: string, fn: () => T): T {
  if (activeCapture === null) {
    return fn();
  }
  const token = beginPerfSpan(name);
  try {
    return fn();
  } finally {
    endPerfSpan(token);
  }
}

export function stopPerfSpanCapture(topN: number): BottomUpEntry[] {
  const capture = activeCapture;
  activeCapture = null;
  if (capture === null) {
    return [];
  }
  const totalSelfMs = [...capture.totals.values()].reduce((sum, item) => sum + item.selfMs, 0);
  return [...capture.totals.entries()]
    .map(([functionName, item]) => ({
      functionName,
      selfMs: Number(item.selfMs.toFixed(3)),
      totalMs: Number(item.totalMs.toFixed(3)),
      samples: item.calls,
      percent: totalSelfMs > 0 ? Number(((item.selfMs / totalSelfMs) * 100).toFixed(2)) : 0,
    }))
    .sort((a, b) => b.selfMs - a.selfMs)
    .slice(0, Math.max(1, topN));
}
