import type { EventBus } from "../EventBus";
import type { GameEvent } from "../types";
import { getStratumBuildInfo } from "../../versionInfo";
import type { ClientDiagnosticsSnapshot } from "./clientDiagnostics";
import { collectClientDiagnostics } from "./clientDiagnostics";

type CrashSource = "error" | "unhandledrejection" | "freeze" | "manual_test";

type CrashUiPayload = Extract<GameEvent, { type: "ui:crash-log" }>;

type CrashReportSeverity = "crash" | "error";

export type ModCrashSummary = {
  modId: string;
  version: string;
  name: string;
};

type CrashReportPayload = {
  crashId: string;
  sessionId: string;
  severity: CrashReportSeverity;
  source: CrashSource;
  message: string;
  stack: string;
  name: string;
  url: string;
  userAgent: string;
  timestampIso: string;
  build: ReturnType<typeof getStratumBuildInfo>;
  diagnostics: ClientDiagnosticsSnapshot;
  mods: readonly ModCrashSummary[];
  sim: {
    tickIndex: number | null;
    worldTimeMs: number | null;
    playerBlockX: number | null;
    playerBlockY: number | null;
    roomFingerprint: string | null;
  };
  context: {
    worldName: string | null;
    worldUuid: string | null;
    networkRole: "offline" | "host" | "client" | "unknown";
    lastCommand: string | null;
    lastUiError: string | null;
    lastRenderAtMs: number | null;
    freezeThresholdMs: number;
    visibilityState: DocumentVisibilityState;
    recentEvents: string[];
  };
};

type CrashReporterOptions = {
  sendReport: (payload: CrashReportPayload) => Promise<{ ok: boolean; detail?: string }>;
  freezeThresholdMs?: number;
  /** Workshop / dev packs installed in IndexedDB (best-effort). */
  getModSummaries?: () => readonly ModCrashSummary[];
};

type SessionContextPatch = {
  worldName?: string | null;
  worldUuid?: string | null;
};

const DEFAULT_FREEZE_THRESHOLD_MS = 10_000;
const FOREGROUND_GRACE_MS = 2500;
const MAX_BREADCRUMBS = 24;

function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  const ts = Date.now().toString(36);
  return `${prefix}_${ts}_${rand}`;
}

function toErrorLike(value: unknown): { name: string; message: string; stack: string } {
  if (value instanceof Error) {
    return {
      name: value.name || "Error",
      message: value.message || "Unknown error",
      stack: value.stack ?? "",
    };
  }
  if (typeof value === "string") {
    return { name: "Error", message: value, stack: "" };
  }
  try {
    return {
      name: "Error",
      message: JSON.stringify(value),
      stack: "",
    };
  } catch {
    return { name: "Error", message: String(value), stack: "" };
  }
}

/**
 * Browser noise that should not trigger crash reports (still may appear as `window` "error").
 * Chromium may fire "ResizeObserver loop completed with undelivered notifications" during layout;
 * it is not an application bug.
 */
export function isBenignWindowError(reason: unknown): boolean {
  const { name, message } = toErrorLike(reason);
  const combined = `${name}\n${message}`.toLowerCase();
  if (combined.includes("resizeobserver loop completed with undelivered notifications")) {
    return true;
  }
  if (combined.includes("resizeobserver loop limit exceeded")) {
    return true;
  }
  return false;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) {
    return s;
  }
  return `${s.slice(0, max)}…`;
}

function severityForSource(source: CrashSource): CrashReportSeverity {
  return source === "freeze" || source === "manual_test" ? "crash" : "error";
}

function fingerprintRoomCode(code: string | null): string | null {
  if (code === null) {
    return null;
  }
  const t = code.trim();
  if (t === "") {
    return null;
  }
  let h = 2166136261;
  for (let i = 0; i < t.length; i++) {
    h ^= t.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function prettyCrashLog(report: CrashReportPayload, sendStatus: string): string {
  return [
    `Crash ID: ${report.crashId}`,
    `Session ID: ${report.sessionId}`,
    `Severity: ${report.severity}`,
    `Crash source: ${report.source}`,
    `Message: ${report.message}`,
    `Name: ${report.name}`,
    `Time: ${report.timestampIso}`,
    `URL: ${report.url}`,
    `Network role: ${report.context.networkRole}`,
    `World: ${report.context.worldName ?? "unknown"} (${report.context.worldUuid ?? "n/a"})`,
    `Last command: ${report.context.lastCommand ?? "n/a"}`,
    `Last UI error: ${report.context.lastUiError ?? "n/a"}`,
    `Last render (ms): ${
      report.context.lastRenderAtMs === null
        ? "n/a"
        : Math.max(0, Date.now() - report.context.lastRenderAtMs)
    } ago`,
    `Tick: ${report.sim.tickIndex ?? "n/a"} worldTimeMs: ${report.sim.worldTimeMs ?? "n/a"}`,
    `Player block: ${report.sim.playerBlockX ?? "n/a"}, ${report.sim.playerBlockY ?? "n/a"}`,
    `Room fp: ${report.sim.roomFingerprint ?? "n/a"}`,
    `Viewport: ${report.diagnostics.viewportCss} dpr=${report.diagnostics.devicePixelRatio} screen=${report.diagnostics.screenCss}`,
    `HW: cores=${report.diagnostics.hardwareConcurrency ?? "?"} memGb=${report.diagnostics.deviceMemoryGb ?? "?"} touch=${report.diagnostics.maxTouchPoints}`,
    `Locale: ${report.diagnostics.languages} | ${report.diagnostics.timeZone} | online=${report.diagnostics.onLine}`,
    `WebGL: ${report.diagnostics.webglVendor} | ${report.diagnostics.webglRenderer}`,
    `Storage MB: used=${report.diagnostics.storageUsedMb ?? "?"} quota=${report.diagnostics.storageQuotaMb ?? "?"}`,
    `Mods (${report.mods.length}): ${report.mods.map((m) => `${m.name} (${m.modId}@${m.version})`).join("; ") || "none"}`,
    `Report status: ${sendStatus}`,
    "",
    "Recent events:",
    ...(report.context.recentEvents.length > 0 ? report.context.recentEvents : ["(none recorded)"]),
    "",
    "Stack:",
    report.stack || "(no stack available)",
  ].join("\n");
}

export class CrashReporter {
  private readonly sendReport: CrashReporterOptions["sendReport"];
  private readonly getModSummaries: CrashReporterOptions["getModSummaries"];
  private readonly freezeThresholdMs: number;
  private readonly buildInfo = getStratumBuildInfo();
  private readonly sessionId = createId("session");
  private bus: EventBus | null = null;
  private unsubscribers: Array<() => void> = [];
  private watchdogTimer: number | null = null;
  private lastRenderAtMs: number | null = null;
  private networkRole: "offline" | "host" | "client" | "unknown" = "unknown";
  private worldName: string | null = null;
  private worldUuid: string | null = null;
  private lastCommand: string | null = null;
  private lastUiError: string | null = null;
  private lastTickIndex: number | null = null;
  private lastWorldTimeMs: number | null = null;
  private lastPlayerBlockX: number | null = null;
  private lastPlayerBlockY: number | null = null;
  private roomFingerprint: string | null = null;
  private hasCrashed = false;
  private lastSignature = "";
  private lastReportAtMs = 0;
  private lastReportName = "";
  private lastReportMessage = "";
  private lastForegroundAtMs = Date.now();
  private readonly breadcrumbs: string[] = [];
  private onVisibilityChange: (() => void) | null = null;
  private onFocus: (() => void) | null = null;

  constructor(opts: CrashReporterOptions) {
    this.sendReport = opts.sendReport;
    this.getModSummaries = opts.getModSummaries;
    this.freezeThresholdMs = opts.freezeThresholdMs ?? DEFAULT_FREEZE_THRESHOLD_MS;
  }

  setSessionContext(patch: SessionContextPatch): void {
    if (patch.worldName !== undefined) {
      this.worldName = patch.worldName;
    }
    if (patch.worldUuid !== undefined) {
      this.worldUuid = patch.worldUuid;
    }
  }

  private addBreadcrumb(event: string, detail?: string): void {
    const stamp = new Date().toISOString();
    const line = detail && detail.trim() !== "" ? `${stamp} ${event}: ${detail}` : `${stamp} ${event}`;
    this.breadcrumbs.push(truncate(line, 220));
    if (this.breadcrumbs.length > MAX_BREADCRUMBS) {
      this.breadcrumbs.splice(0, this.breadcrumbs.length - MAX_BREADCRUMBS);
    }
  }

  attachBus(bus: EventBus): void {
    this.detachBus();
    this.bus = bus;
    this.unsubscribers.push(
      bus.on("game:render", () => {
        this.lastRenderAtMs = Date.now();
      }),
      bus.on("game:network-role", (e) => {
        this.networkRole = e.role;
        this.addBreadcrumb("network-role", e.role);
      }),
      bus.on("game:worldLoaded", (e) => {
        this.worldName = e.name;
        this.lastRenderAtMs = Date.now();
        this.addBreadcrumb("world-loaded", e.name);
      }),
      bus.on("game:chat-submit", (e) => {
        this.lastCommand = e.text.trim().slice(0, 160);
        this.addBreadcrumb("chat-submit", this.lastCommand);
      }),
      bus.on("net:error", (e) => {
        this.lastUiError = e.message.slice(0, 240);
        this.addBreadcrumb("net-error", this.lastUiError);
      }),
      bus.on("game:tick", (e) => {
        this.lastTickIndex = e.tickIndex;
        this.lastWorldTimeMs = e.worldTimeMs;
      }),
      bus.on("player:moved", (e) => {
        this.lastPlayerBlockX = e.blockX;
        this.lastPlayerBlockY = e.blockY;
      }),
      bus.on("net:room-code", (e) => {
        this.roomFingerprint = fingerprintRoomCode(e.roomCode);
        if (this.roomFingerprint !== null) {
          this.addBreadcrumb("room-code", `fp:${this.roomFingerprint}`);
        }
      }),
    );
    this.lastRenderAtMs = Date.now();
    this.lastForegroundAtMs = Date.now();
    this.onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        this.lastForegroundAtMs = Date.now();
        this.lastRenderAtMs = Date.now();
      }
    };
    this.onFocus = () => {
      this.lastForegroundAtMs = Date.now();
      this.lastRenderAtMs = Date.now();
    };
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    window.addEventListener("focus", this.onFocus);
    this.watchdogTimer = window.setInterval(() => {
      if (this.hasCrashed || document.visibilityState !== "visible" || !document.hasFocus()) {
        return;
      }
      if (this.lastRenderAtMs === null) {
        return;
      }
      const foregroundMs = Date.now() - this.lastForegroundAtMs;
      if (foregroundMs < FOREGROUND_GRACE_MS) {
        return;
      }
      const idleMs = Date.now() - this.lastRenderAtMs;
      if (idleMs >= this.freezeThresholdMs) {
        this.addBreadcrumb("freeze-watchdog", `${idleMs}ms idle`);
        void this.report(
          "freeze",
          new Error(
            `Render heartbeat stalled for ${idleMs}ms (threshold ${this.freezeThresholdMs}ms).`,
          ),
        );
      }
    }, 1000);
  }

  detachBus(): void {
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];
    if (this.watchdogTimer !== null) {
      window.clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    if (this.onVisibilityChange !== null) {
      document.removeEventListener("visibilitychange", this.onVisibilityChange);
      this.onVisibilityChange = null;
    }
    if (this.onFocus !== null) {
      window.removeEventListener("focus", this.onFocus);
      this.onFocus = null;
    }
    this.bus = null;
  }

  async report(source: CrashSource, reason: unknown): Promise<void> {
    if (
      (source === "error" || source === "unhandledrejection") &&
      isBenignWindowError(reason)
    ) {
      return;
    }
    const err = toErrorLike(reason);
    const crashId = createId("crash");
    const signature = `${source}|${err.name}|${err.message}|${err.stack.slice(0, 240)}`;
    const nowMs = Date.now();
    const duplicateBurst =
      nowMs - this.lastReportAtMs < 2000 &&
      this.lastReportName === err.name &&
      this.lastReportMessage === err.message;
    if (duplicateBurst) {
      return;
    }
    if (this.hasCrashed && this.lastSignature === signature) {
      return;
    }
    this.hasCrashed = true;
    this.lastSignature = signature;
    this.lastReportAtMs = nowMs;
    this.lastReportName = err.name;
    this.lastReportMessage = err.message;
    this.addBreadcrumb("crash-report", `${source} ${err.name}`);

    const diagnostics = await collectClientDiagnostics();
    const modList = this.getModSummaries?.() ?? [];
    const mods = modList.map((m) => ({
      modId: truncate(m.modId, 64),
      version: truncate(m.version, 32),
      name: truncate(m.name, 64),
    }));

    const payload: CrashReportPayload = {
      crashId,
      sessionId: this.sessionId,
      severity: severityForSource(source),
      source,
      name: truncate(err.name, 120),
      message: truncate(err.message, 1800),
      stack: truncate(err.stack, 6000),
      url: window.location.href,
      userAgent: navigator.userAgent,
      timestampIso: new Date().toISOString(),
      build: this.buildInfo,
      diagnostics,
      mods,
      sim: {
        tickIndex: this.lastTickIndex,
        worldTimeMs: this.lastWorldTimeMs,
        playerBlockX: this.lastPlayerBlockX,
        playerBlockY: this.lastPlayerBlockY,
        roomFingerprint: this.roomFingerprint,
      },
      context: {
        worldName: this.worldName,
        worldUuid: this.worldUuid,
        networkRole: this.networkRole,
        lastCommand: this.lastCommand,
        lastUiError: this.lastUiError,
        lastRenderAtMs: this.lastRenderAtMs,
        freezeThresholdMs: this.freezeThresholdMs,
        visibilityState: document.visibilityState,
        recentEvents: [...this.breadcrumbs],
      },
    };

    let sendStatus = "queued";
    let sentToDeveloper = false;
    try {
      const send = await this.sendReport(payload);
      sentToDeveloper = send.ok;
      sendStatus = send.ok ? "reported to developer" : `report failed: ${send.detail ?? "unknown"}`;
    } catch (sendErr) {
      const details = toErrorLike(sendErr);
      sendStatus = `report failed: ${details.message}`;
    }

    if (this.bus !== null) {
      const uiPayload: CrashUiPayload = {
        type: "ui:crash-log",
        title: "Game crash detected",
        message: sentToDeveloper
          ? "The game ran into a crash and your report was already sent to the developer. You can reload to recover."
          : "The game ran into a crash. We could not reach crash reporting right now, but your logs are shown below. You can reload to recover.",
        sendStatus,
        log: prettyCrashLog(payload, sendStatus),
      };
      this.bus.emit(uiPayload);
    }
  }
}
