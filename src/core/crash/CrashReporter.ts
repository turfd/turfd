import type { EventBus } from "../EventBus";
import type { GameEvent } from "../types";
import { getStratumBuildInfo } from "../../versionInfo";

type CrashSource = "error" | "unhandledrejection" | "freeze" | "manual_test";

type CrashUiPayload = Extract<GameEvent, { type: "ui:crash-log" }>;

type CrashReportPayload = {
  source: CrashSource;
  message: string;
  stack: string;
  name: string;
  url: string;
  userAgent: string;
  timestampIso: string;
  build: ReturnType<typeof getStratumBuildInfo>;
  context: {
    worldName: string | null;
    worldUuid: string | null;
    networkRole: "offline" | "host" | "client" | "unknown";
    lastCommand: string | null;
    lastUiError: string | null;
    lastRenderAtMs: number | null;
    freezeThresholdMs: number;
    visibilityState: DocumentVisibilityState;
  };
};

type CrashReporterOptions = {
  sendReport: (payload: CrashReportPayload) => Promise<{ ok: boolean; detail?: string }>;
  freezeThresholdMs?: number;
};

type SessionContextPatch = {
  worldName?: string | null;
  worldUuid?: string | null;
};

const DEFAULT_FREEZE_THRESHOLD_MS = 10_000;
const FOREGROUND_GRACE_MS = 2500;

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

function truncate(s: string, max: number): string {
  if (s.length <= max) {
    return s;
  }
  return `${s.slice(0, max)}…`;
}

function prettyCrashLog(report: CrashReportPayload, sendStatus: string): string {
  return [
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
    `Report status: ${sendStatus}`,
    "",
    "Stack:",
    report.stack || "(no stack available)",
  ].join("\n");
}

export class CrashReporter {
  private readonly sendReport: CrashReporterOptions["sendReport"];
  private readonly freezeThresholdMs: number;
  private readonly buildInfo = getStratumBuildInfo();
  private bus: EventBus | null = null;
  private unsubscribers: Array<() => void> = [];
  private watchdogTimer: number | null = null;
  private lastRenderAtMs: number | null = null;
  private networkRole: "offline" | "host" | "client" | "unknown" = "unknown";
  private worldName: string | null = null;
  private worldUuid: string | null = null;
  private lastCommand: string | null = null;
  private lastUiError: string | null = null;
  private hasCrashed = false;
  private lastSignature = "";
  private lastReportAtMs = 0;
  private lastReportName = "";
  private lastReportMessage = "";
  private lastForegroundAtMs = Date.now();
  private onVisibilityChange: (() => void) | null = null;
  private onFocus: (() => void) | null = null;

  constructor(opts: CrashReporterOptions) {
    this.sendReport = opts.sendReport;
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

  attachBus(bus: EventBus): void {
    this.detachBus();
    this.bus = bus;
    this.unsubscribers.push(
      bus.on("game:render", () => {
        this.lastRenderAtMs = Date.now();
      }),
      bus.on("game:network-role", (e) => {
        this.networkRole = e.role;
      }),
      bus.on("game:worldLoaded", (e) => {
        this.worldName = e.name;
      }),
      bus.on("game:chat-submit", (e) => {
        this.lastCommand = e.text.trim().slice(0, 160);
      }),
      bus.on("net:error", (e) => {
        this.lastUiError = e.message.slice(0, 240);
      }),
      bus.on("debug:trigger-crash", () => {
        void this.report("manual_test", new Error("[CrashTest] /crash invoked"));
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
    const err = toErrorLike(reason);
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

    const payload: CrashReportPayload = {
      source,
      name: truncate(err.name, 120),
      message: truncate(err.message, 1800),
      stack: truncate(err.stack, 7000),
      url: window.location.href,
      userAgent: navigator.userAgent,
      timestampIso: new Date().toISOString(),
      build: this.buildInfo,
      context: {
        worldName: this.worldName,
        worldUuid: this.worldUuid,
        networkRole: this.networkRole,
        lastCommand: this.lastCommand,
        lastUiError: this.lastUiError,
        lastRenderAtMs: this.lastRenderAtMs,
        freezeThresholdMs: this.freezeThresholdMs,
        visibilityState: document.visibilityState,
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
