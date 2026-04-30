/**
 * In-game F3 overlay with Minecraft-inspired layout and chart hotkeys.
 * Draw counts wrap only the main Pixi GL context; composite passes share the same context.
 */
import type { RenderPipeline } from "../renderer/RenderPipeline";
import { VIEW_DISTANCE_CHUNKS } from "../core/constants";
import { getVideoPrefs } from "../ui/settings/videoPrefs";

type GlLike = WebGLRenderingContext | WebGL2RenderingContext;

type HookState = {
  kind: "webgl" | "webgpu";
  gl?: GlLike;
  restore: () => void;
};

export type DebugTargetedTile =
  | {
      kind: "chest";
      slotCount: number;
      filledSlots: number;
      lootTableId: string | null;
      lootRolled: boolean;
      anchorX: number;
      anchorY: number;
      isDouble: boolean;
    }
  | {
      kind: "furnace";
      fuelKey: string | null;
      fuelCount: number;
      fuelRemainingSec: number;
      cookProgressSec: number;
      queueLength: number;
      queueHeadRecipe: string | null;
      queueHeadBatches: number | null;
      outputUsedSlots: number;
      outputSlotCount: number;
    }
  | {
      kind: "sign";
      text: string;
    };

export type DebugTargetedBlockInfo = {
  wx: number;
  wy: number;
  inReach: boolean;
  fgIdentifier: string;
  fgDisplayName: string;
  fgId: number;
  bgIdentifier: string;
  bgId: number;
  hardness: number;
  lightEmission: number;
  lightAbsorption: number;
  blockLight: number;
  skyLight: number;
  metadata: number;
  tile: DebugTargetedTile | null;
};

export type DebugHudSnapshot = {
  versionLabel: string;
  memoryUsedMiB: number | null;
  memoryLimitMiB: number | null;
  memoryPercent: number | null;
  playerX: number;
  playerY: number;
  playerBlockX: number;
  playerBlockY: number;
  playerVx: number;
  playerVy: number;
  chunkX: number;
  chunkY: number;
  loadedChunks: number;
  entityCount: number;
  remotePlayers: number;
  mobs: number;
  droppedItems: number;
  arrows: number;
  soundsPlaying: number;
  soundSpatial: number;
  soundOneShots: number;
  soundPlayerLike: number;
  soundAmbientLoops: number;
  soundRainLoops: number;
  soundMusic: number;
  txPerTick: number | null;
  rxPerTick: number | null;
  pingMs: number | null;
  tpsMs: number | null;
  profiler: Array<{ name: string; ms: number }>;
  targeted: DebugTargetedBlockInfo | null;
};

let hook: HookState | null = null;
let drawsThisFrame = 0;

const GRAPH_HISTORY = 240;

type HudGraphMode = "none" | "all" | "profiler" | "perf" | "network";
type DebugProfileName = "default" | "performance";
type DebugPartMode = "off" | "overlay" | "always";
type DebugPartKey =
  | "fps"
  | "position"
  | "chunks"
  | "entities"
  | "memory"
  | "audio"
  | "network"
  | "system"
  | "targeted";

type DebugProfileConfig = Record<DebugPartKey, DebugPartMode>;

const DEFAULT_PROFILE: DebugProfileConfig = {
  fps: "overlay",
  position: "overlay",
  chunks: "overlay",
  entities: "overlay",
  memory: "overlay",
  audio: "overlay",
  network: "overlay",
  system: "overlay",
  targeted: "overlay",
};

const PERFORMANCE_PROFILE: DebugProfileConfig = {
  fps: "overlay",
  position: "off",
  chunks: "overlay",
  entities: "overlay",
  memory: "overlay",
  audio: "off",
  network: "overlay",
  system: "overlay",
  targeted: "overlay",
};

function resetDrawCounter(): void {
  drawsThisFrame = 0;
}

function readDrawCount(): number {
  return drawsThisFrame;
}

function uninstallGlHooks(): void {
  if (hook === null) {
    return;
  }
  hook.restore();
  hook = null;
}

function installGlHooks(gl: GlLike): void {
  if (hook?.kind === "webgl" && hook.gl === gl) {
    return;
  }
  uninstallGlHooks();
  const originals: Array<{ key: string; fn: unknown }> = [];
  const wrap = (key: string): void => {
    const orig = (gl as unknown as Record<string, unknown>)[key];
    if (typeof orig !== "function") {
      return;
    }
    originals.push({ key, fn: orig });
    (gl as unknown as Record<string, unknown>)[key] = function (
      this: GlLike,
      ...args: unknown[]
    ) {
      drawsThisFrame += 1;
      return (orig as (...a: unknown[]) => unknown).apply(this, args);
    };
  };
  wrap("drawArrays");
  wrap("drawElements");
  wrap("drawArraysInstanced");
  wrap("drawElementsInstanced");
  if (typeof (gl as WebGL2RenderingContext).drawRangeElements === "function") {
    wrap("drawRangeElements");
  }
  hook = {
    kind: "webgl",
    gl,
    restore: () => {
      for (const { key, fn } of originals) {
        (gl as unknown as Record<string, unknown>)[key] = fn;
      }
    },
  };
}

function installWebGpuHooks(): boolean {
  if (hook?.kind === "webgpu") {
    return true;
  }
  uninstallGlHooks();
  const g = globalThis as unknown as Record<string, unknown>;
  const passCtor = g.GPURenderPassEncoder as
    | { prototype?: Record<string, unknown> }
    | undefined;
  const bundleCtor = g.GPURenderBundleEncoder as
    | { prototype?: Record<string, unknown> }
    | undefined;
  const originals: Array<{
    target: Record<string, unknown>;
    key: string;
    fn: unknown;
  }> = [];
  const wrapOn = (target: Record<string, unknown>, key: string): void => {
    const orig = target[key];
    if (typeof orig !== "function") {
      return;
    }
    originals.push({ target, key, fn: orig });
    target[key] = function (...args: unknown[]) {
      drawsThisFrame += 1;
      return (orig as (...a: unknown[]) => unknown).apply(this, args);
    };
  };
  const passProto = passCtor?.prototype;
  if (passProto !== undefined) {
    wrapOn(passProto, "draw");
    wrapOn(passProto, "drawIndexed");
    wrapOn(passProto, "drawIndirect");
    wrapOn(passProto, "drawIndexedIndirect");
  }
  const bundleProto = bundleCtor?.prototype;
  if (bundleProto !== undefined) {
    wrapOn(bundleProto, "draw");
    wrapOn(bundleProto, "drawIndexed");
    wrapOn(bundleProto, "drawIndirect");
    wrapOn(bundleProto, "drawIndexedIndirect");
  }
  if (originals.length === 0) {
    return false;
  }
  hook = {
    kind: "webgpu",
    restore: () => {
      for (const { target, key, fn } of originals) {
        target[key] = fn;
      }
    },
  };
  return true;
}

function readGpuStrings(gl: GlLike): { vendor: string; renderer: string } {
  const ext = gl.getExtension("WEBGL_debug_renderer_info");
  if (ext !== null) {
    return {
      vendor: String(gl.getParameter(ext.UNMASKED_VENDOR_WEBGL)),
      renderer: String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)),
    };
  }
  return {
    vendor: String(gl.getParameter(gl.VENDOR)),
    renderer: String(gl.getParameter(gl.RENDERER)),
  };
}

function readStaticGlBlock(gl: GlLike): string {
  const lines: string[] = [];
  const gpu = readGpuStrings(gl);
  lines.push(`VENDOR  ${gpu.vendor}`);
  lines.push(`RENDER  ${gpu.renderer}`);
  lines.push(`GL      ${gl.getParameter(gl.VERSION)}`);
  lines.push(`SL      ${gl.getParameter(gl.SHADING_LANGUAGE_VERSION)}`);
  lines.push(
    `MAX_TEX ${gl.getParameter(gl.MAX_TEXTURE_SIZE)}  MAX_VP ${gl.getParameter(gl.MAX_VIEWPORT_DIMS)}`,
  );
  const extAniso = gl.getExtension("EXT_texture_filter_anisotropic");
  if (extAniso) {
    const max = gl.getParameter(extAniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT);
    lines.push(`ANISO   max ${max}`);
  }
  return lines.join("\n");
}

class HistoryBuffer {
  private readonly values: Float32Array;
  private head = 0;
  private size = 0;

  constructor(length: number) {
    this.values = new Float32Array(length);
  }

  clear(): void {
    this.head = 0;
    this.size = 0;
  }

  push(value: number): void {
    this.values[this.head] = value;
    this.head = (this.head + 1) % this.values.length;
    this.size = Math.min(this.size + 1, this.values.length);
  }

  stats(): { min: number; avg: number; max: number; size: number } {
    if (this.size <= 0) {
      return { min: 0, avg: 0, max: 0, size: 0 };
    }
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    let sum = 0;
    for (let i = 0; i < this.size; i++) {
      const idx = (this.head - this.size + i + this.values.length) % this.values.length;
      const v = this.values[idx] ?? 0;
      min = Math.min(min, v);
      max = Math.max(max, v);
      sum += v;
    }
    return { min, avg: sum / this.size, max, size: this.size };
  }

  forEachNewestToOldest(limit: number, fn: (v: number, i: number) => void): void {
    const n = Math.min(this.size, limit);
    for (let i = 0; i < n; i++) {
      const idx = (this.head - 1 - i + this.values.length) % this.values.length;
      fn(this.values[idx] ?? 0, i);
    }
  }
}

type HudGraphCard = {
  root: HTMLDivElement;
  title: HTMLDivElement;
  stats: HTMLDivElement;
  canvas: HTMLCanvasElement;
};

function buildGraphCard(label: string): HudGraphCard {
  const root = document.createElement("div");
  root.style.cssText = [
    "display:none",
    "flex-direction:column",
    "background:rgba(0,0,0,0.64)",
    "border:1px solid rgba(255,255,255,0.18)",
    "padding:4px 6px",
    "margin:0",
    "box-sizing:border-box",
    "gap:2px",
    "flex:0 0 auto",
    "min-width:240px",
  ].join(";");
  const title = document.createElement("div");
  title.style.cssText =
    "font:bold 12px/1.2 ui-monospace,Menlo,Consolas,monospace;color:#e9eef5;letter-spacing:0.02em;";
  title.textContent = label;
  const stats = document.createElement("div");
  stats.style.cssText =
    "font:11px/1.2 ui-monospace,Menlo,Consolas,monospace;color:#cfd5dd;";
  stats.textContent = "min/avg/max: -";
  const canvas = document.createElement("canvas");
  canvas.width = 240;
  canvas.height = 64;
  canvas.style.cssText =
    "display:block;width:240px;height:64px;background:#0d0f12;image-rendering:pixelated;margin-top:2px;";
  root.appendChild(title);
  root.appendChild(stats);
  root.appendChild(canvas);
  return { root, title, stats, canvas };
}

export class GpuDebugHud {
  private root: HTMLDivElement | null = null;
  private leftPre: HTMLPreElement | null = null;
  private rightPre: HTMLPreElement | null = null;
  private targetedPre: HTMLPreElement | null = null;
  private cardFrame: HudGraphCard | null = null;
  private cardBandwidth: HudGraphCard | null = null;
  private cardTps: HudGraphCard | null = null;
  private cardPing: HudGraphCard | null = null;
  private cardProfiler: HudGraphCard | null = null;
  private open = false;
  private fpsEma = 0;
  private staticGl: string | null = null;
  private graphMode: HudGraphMode = "all";
  private profileName: DebugProfileName = "default";
  private profileConfig: DebugProfileConfig = { ...DEFAULT_PROFILE };
  private readonly frameMsHistory = new HistoryBuffer(GRAPH_HISTORY);
  private readonly tpsMsHistory = new HistoryBuffer(GRAPH_HISTORY);
  private readonly bandwidthHistory = new HistoryBuffer(GRAPH_HISTORY);
  private readonly pingHistory = new HistoryBuffer(GRAPH_HISTORY);
  private lastSnapshot: DebugHudSnapshot | null = null;

  init(mount: HTMLElement): void {
    for (const stale of document.querySelectorAll("#stratum-gpu-debug-hud")) {
      stale.remove();
    }
    if (this.root !== null) {
      this.destroy();
    }
    const root = document.createElement("div");
    root.id = "stratum-gpu-debug-hud";
    root.style.cssText = [
      "display:none",
      "position:fixed",
      "left:0",
      "top:0",
      "right:0",
      "bottom:0",
      "z-index:15000",
      "pointer-events:none",
    ].join(";");
    const leftPanel = document.createElement("div");
    leftPanel.style.cssText = [
      "position:absolute",
      "left:8px",
      "top:8px",
      "display:flex",
      "flex-direction:column",
      "align-items:flex-start",
      "gap:6px",
      "max-width:min(45vw,440px)",
      "max-height:calc(50vh - 16px)",
      "padding:0",
      "color:#ffffff",
      "font:13px/1.22 ui-monospace,Menlo,Consolas,monospace",
      "text-shadow:1px 1px 0 rgba(0,0,0,0.95)",
      "box-sizing:border-box",
      "overflow:hidden",
    ].join(";");
    const rightPanel = document.createElement("div");
    rightPanel.style.cssText = [
      "position:absolute",
      "right:8px",
      "top:8px",
      "display:flex",
      "flex-direction:column",
      "align-items:stretch",
      "gap:6px",
      "max-width:min(45vw,440px)",
      "max-height:calc(50vh - 16px)",
      "padding:0",
      "color:#ffffff",
      "font:13px/1.22 ui-monospace,Menlo,Consolas,monospace",
      "text-shadow:1px 1px 0 rgba(0,0,0,0.95)",
      "box-sizing:border-box",
      "overflow:hidden",
    ].join(";");
    const graphBar = document.createElement("div");
    graphBar.style.cssText = [
      "position:absolute",
      "left:8px",
      "right:8px",
      "bottom:8px",
      "display:flex",
      "flex-direction:row",
      "flex-wrap:wrap",
      "align-items:flex-end",
      "justify-content:flex-start",
      "gap:8px",
      "padding:0",
      "color:#ffffff",
      "font:12px/1.2 ui-monospace,Menlo,Consolas,monospace",
      "text-shadow:1px 1px 0 rgba(0,0,0,0.95)",
      "box-sizing:border-box",
      "max-height:calc(45vh - 16px)",
    ].join(";");
    const leftPre = document.createElement("pre");
    leftPre.style.cssText =
      "display:block;margin:0;white-space:pre-wrap;font:inherit;max-width:100%;background:rgba(0,0,0,0.64);padding:6px 7px;box-sizing:border-box;align-self:stretch;";
    leftPre.textContent = "F3 debug";
    const rightPre = document.createElement("pre");
    rightPre.style.cssText =
      "margin:0;white-space:pre-wrap;font:inherit;background:rgba(0,0,0,0.64);padding:6px 7px;box-sizing:border-box;";
    rightPre.textContent = "";
    const targetedPre = document.createElement("pre");
    targetedPre.style.cssText =
      "margin:0;white-space:pre-wrap;font:inherit;background:rgba(0,0,0,0.64);padding:6px 7px;box-sizing:border-box;border-left:2px solid rgba(180,210,255,0.45);";
    targetedPre.textContent = "Targeted Block: -";
    const cardFrame = buildGraphCard("FPS  (frame ms)");
    const cardBandwidth = buildGraphCard("Bandwidth  (KiB / tick)");
    const cardTps = buildGraphCard("TPS  (tick ms)");
    const cardPing = buildGraphCard("Ping  (ms)");
    const cardProfiler = buildGraphCard("Profiler  (top frame phases)");
    cardProfiler.canvas.width = 320;
    cardProfiler.canvas.height = 110;
    cardProfiler.canvas.style.width = "320px";
    cardProfiler.canvas.style.height = "110px";
    leftPanel.appendChild(leftPre);
    rightPanel.appendChild(rightPre);
    rightPanel.appendChild(targetedPre);
    graphBar.appendChild(cardFrame.root);
    graphBar.appendChild(cardTps.root);
    graphBar.appendChild(cardBandwidth.root);
    graphBar.appendChild(cardPing.root);
    graphBar.appendChild(cardProfiler.root);
    root.appendChild(leftPanel);
    root.appendChild(rightPanel);
    root.appendChild(graphBar);
    mount.appendChild(root);
    this.root = root;
    this.leftPre = leftPre;
    this.rightPre = rightPre;
    this.targetedPre = targetedPre;
    this.cardFrame = cardFrame;
    this.cardBandwidth = cardBandwidth;
    this.cardTps = cardTps;
    this.cardPing = cardPing;
    this.cardProfiler = cardProfiler;
  }

  /** Toggle overlay; installs draw hooks when opening with a WebGL context. */
  setOpen(next: boolean, pipeline: RenderPipeline | null): void {
    if (
      this.root === null ||
      this.leftPre === null ||
      this.rightPre === null ||
      this.targetedPre === null ||
      this.cardFrame === null ||
      this.cardBandwidth === null ||
      this.cardTps === null ||
      this.cardPing === null ||
      this.cardProfiler === null
    ) {
      return;
    }
    if (next === this.open) {
      return;
    }
    this.open = next;
    this.root.style.display = next ? "block" : "none";
    if (next) {
      this.graphMode = "all";
      const gl = pipeline?.getWebGLContext() ?? null;
      if (gl !== null) {
        if (this.staticGl === null) {
          try {
            this.staticGl = readStaticGlBlock(gl);
          } catch {
            this.staticGl = "(failed to read GL parameters)";
          }
        }
        installGlHooks(gl);
      } else {
        const backend = pipeline?.getGraphicsBackend() ?? null;
        if (backend === "webgpu") {
          const webGpuHooked = installWebGpuHooks();
          this.staticGl = webGpuHooked
            ? "WebGPU draw-call hook active (draw* encoder methods)."
            : "WebGPU renderer active, but encoder prototypes were unavailable for draw-call hook.";
        } else {
          this.staticGl =
            this.staticGl ??
            "No WebGL context on this renderer (likely Canvas2D). Draw-call hook is unavailable.";
        }
      }
      this.fpsEma = 0;
      this.frameMsHistory.clear();
      this.tpsMsHistory.clear();
      this.bandwidthHistory.clear();
      this.pingHistory.clear();
      this.lastSnapshot = null;
      this.leftPre.textContent = this.buildLeftText(0, 0, 0, null);
      this.rightPre.textContent = this.buildRightText("(warming up…)", pipeline);
      this.targetedPre.textContent = this.buildTargetedText(null);
      this.syncGraphModeUi();
      this.drawGraphs();
    } else {
      uninstallGlHooks();
      this.staticGl = null;
    }
  }

  toggle(pipeline: RenderPipeline | null): void {
    this.setOpen(!this.open, pipeline);
  }

  setGraphMode(mode: HudGraphMode): void {
    if (this.graphMode === mode) {
      this.graphMode = "all";
    } else {
      this.graphMode = mode;
    }
    this.syncGraphModeUi();
    this.drawGraphs();
  }

  cycleProfile(): void {
    if (this.profileName === "default") {
      this.profileName = "performance";
      this.profileConfig = { ...PERFORMANCE_PROFILE };
    } else {
      this.profileName = "default";
      this.profileConfig = { ...DEFAULT_PROFILE };
    }
    if (
      this.lastSnapshot !== null &&
      this.leftPre !== null &&
      this.rightPre !== null &&
      this.targetedPre !== null
    ) {
      this.leftPre.textContent = this.buildLeftText(0, this.fpsEma, readDrawCount(), this.lastSnapshot);
      this.rightPre.textContent = this.buildRightText(this.staticGl ?? "", null);
      this.targetedPre.textContent = this.buildTargetedText(this.lastSnapshot.targeted);
    }
  }

  isOpen(): boolean {
    return this.open;
  }

  /** Call at the start of each frame before `RenderPipeline.render` while the HUD is open. */
  beginFrame(): void {
    if (!this.open) {
      return;
    }
    resetDrawCounter();
  }

  /**
   * Call after `RenderPipeline.render` with the same `dtSec` used for the game render tick.
   */
  sync(
    pipeline: RenderPipeline | null,
    dtSec: number,
    snapshot: DebugHudSnapshot | null,
  ): void {
    if (
      !this.open ||
      this.leftPre === null ||
      this.rightPre === null ||
      this.targetedPre === null
    ) {
      return;
    }
    const draws = readDrawCount();
    const frameMs = dtSec > 0 ? dtSec * 1000 : 0;
    const instFps = dtSec > 0 ? 1 / dtSec : 0;
    this.fpsEma =
      this.fpsEma <= 0 ? instFps : this.fpsEma + (instFps - this.fpsEma) * 0.08;
    this.frameMsHistory.push(frameMs);
    this.tpsMsHistory.push(snapshot?.tpsMs ?? frameMs);
    this.bandwidthHistory.push((snapshot?.txPerTick ?? 0) + (snapshot?.rxPerTick ?? 0));
    this.pingHistory.push(snapshot?.pingMs ?? 0);
    this.lastSnapshot = snapshot;
    this.leftPre.textContent = this.buildLeftText(
      frameMs,
      this.fpsEma,
      draws,
      snapshot,
    );
    this.rightPre.textContent = this.buildRightText(this.staticGl ?? "", pipeline);
    this.targetedPre.textContent = this.buildTargetedText(snapshot?.targeted ?? null);
    this.drawGraphs();
  }

  private partEnabled(part: DebugPartKey): boolean {
    const mode = this.profileConfig[part];
    return mode === "overlay" || mode === "always";
  }

  private buildLeftText(
    frameMs: number,
    fpsEma: number,
    draws: number,
    snapshot: DebugHudSnapshot | null,
  ): string {
    const lines: string[] = [];
    lines.push(
      `${snapshot?.versionLabel ?? "Stratum"} (${this.profileName === "default" ? "Default" : "Performance"} profile)`,
    );
    if (this.partEnabled("fps")) {
      lines.push(`${fpsEma.toFixed(0)} fps  (${frameMs.toFixed(2)} ms)  C: ${draws} draw calls`);
    }
    if (snapshot !== null) {
      if (this.partEnabled("position")) {
        lines.push(
          `XYZ: ${snapshot.playerX.toFixed(2)} / ${snapshot.playerY.toFixed(2)}  Block: ${snapshot.playerBlockX} ${snapshot.playerBlockY}`,
        );
        lines.push(
          `Vel: ${snapshot.playerVx.toFixed(2)} / ${snapshot.playerVy.toFixed(2)}  Chunk: ${snapshot.chunkX} ${snapshot.chunkY}`,
        );
      }
      if (this.partEnabled("chunks")) {
        lines.push(`C: ${snapshot.loadedChunks} loaded, D: ${VIEW_DISTANCE_CHUNKS}`);
      }
      if (this.partEnabled("entities")) {
        lines.push(
          `E: ${snapshot.entityCount}  RP: ${snapshot.remotePlayers}  M: ${snapshot.mobs}  D: ${snapshot.droppedItems}  A: ${snapshot.arrows}`,
        );
      }
      if (this.partEnabled("memory")) {
        const mem = snapshot.memoryPercent;
        const used = snapshot.memoryUsedMiB;
        const lim = snapshot.memoryLimitMiB;
        lines.push(
          mem === null || used === null || lim === null
            ? "Mem: ?"
            : `Mem: ${mem.toFixed(0)}%  ${used.toFixed(0)}/${lim.toFixed(0)} MiB`,
        );
      }
      if (this.partEnabled("audio")) {
        lines.push(
          `Sounds: ${snapshot.soundsPlaying} (${snapshot.soundOneShots} one, ${snapshot.soundSpatial} spatial, ${snapshot.soundPlayerLike} player)`,
        );
        lines.push(
          `Loops: ambient ${snapshot.soundAmbientLoops} rain ${snapshot.soundRainLoops} music ${snapshot.soundMusic}`,
        );
      }
      if (this.partEnabled("network")) {
        lines.push(
          `Net: ${snapshot.txPerTick ?? "?"} tx  ${snapshot.rxPerTick ?? "?"} rx  Ping: ${snapshot.pingMs ?? "?"} ms`,
        );
      }
    } else {
      lines.push("XYZ: - / -  Block: - -");
      lines.push("Vel: - / -  Chunk: - -");
      lines.push("C: - loaded, D: -");
      lines.push("E: -  RP: -  M: -  D: -  A: -");
      lines.push("Mem: ?");
      lines.push("Sounds: -");
      lines.push("Net: ? tx  ? rx  Ping: ? ms");
    }
    lines.push("");
    lines.push("For help: press F3 + Q. To edit profile: F3 + F6");
    return lines.join("\n");
  }

  private buildTargetedText(target: DebugTargetedBlockInfo | null): string {
    if (!this.partEnabled("targeted")) {
      return "";
    }
    const lines: string[] = [];
    lines.push("Targeted Block");
    if (target === null) {
      lines.push("  (aim cursor at a block)");
      return lines.join("\n");
    }
    const reachTag = target.inReach ? "" : "  [out of reach]";
    lines.push(`  C: ${target.wx}, ${target.wy}${reachTag}`);
    lines.push(`  B: ${target.fgIdentifier}  (#${target.fgId})`);
    if (target.fgDisplayName.length > 0) {
      lines.push(`     ${target.fgDisplayName}`);
    }
    if (target.bgId !== 0) {
      lines.push(`  Bg: ${target.bgIdentifier}  (#${target.bgId})`);
    }
    lines.push(
      `  Hardness: ${target.hardness.toFixed(1)}  Emit: ${target.lightEmission}  Absorb: ${target.lightAbsorption}`,
    );
    lines.push(
      `  Light: ${Math.max(target.skyLight, target.blockLight)} (${target.skyLight} sky, ${target.blockLight} block)`,
    );
    if (target.metadata !== 0) {
      lines.push(`  Meta: 0x${target.metadata.toString(16)}`);
    }
    const tile = target.tile;
    if (tile !== null) {
      if (tile.kind === "chest") {
        lines.push(
          `  Tile: chest  ${tile.filledSlots}/${tile.slotCount} slots  ${tile.isDouble ? "double" : "single"}`,
        );
        lines.push(`        anchor (${tile.anchorX}, ${tile.anchorY})`);
        if (tile.lootTableId !== null) {
          lines.push(
            `        loot ${tile.lootTableId}  rolled=${tile.lootRolled ? "yes" : "no"}`,
          );
        }
      } else if (tile.kind === "furnace") {
        const fuel =
          tile.fuelKey === null ? "(empty)" : `${tile.fuelKey} x${tile.fuelCount}`;
        lines.push(`  Tile: furnace  fuel: ${fuel}`);
        lines.push(
          `        burn ${tile.fuelRemainingSec.toFixed(1)}s  cook ${tile.cookProgressSec.toFixed(1)}s`,
        );
        const head =
          tile.queueHeadRecipe === null
            ? "queue empty"
            : `head ${tile.queueHeadRecipe} x${tile.queueHeadBatches ?? 0}`;
        lines.push(`        ${head} (queue ${tile.queueLength})`);
        lines.push(
          `        output ${tile.outputUsedSlots}/${tile.outputSlotCount}`,
        );
      } else if (tile.kind === "sign") {
        const text = tile.text.length === 0 ? "(blank)" : tile.text;
        const truncated = text.length > 64 ? `${text.slice(0, 64)}…` : text;
        lines.push(`  Tile: sign  "${truncated}"`);
      }
    }
    return lines.join("\n");
  }

  private buildRightText(staticBlock: string, pipeline: RenderPipeline | null): string {
    const lines: string[] = [];
    lines.push("System");
    if (pipeline !== null) {
      try {
        const app = pipeline.pixiApp;
        const r = app.renderer;
        const name = String((r as unknown as { name?: string }).name ?? r.constructor?.name ?? "?");
        const res = r.resolution;
        const logicalW = Math.max(1, Math.round(r.width));
        const logicalH = Math.max(1, Math.round(r.height));
        const cvs = app.canvas;
        const bufW = Math.max(1, cvs.width);
        const bufH = Math.max(1, cvs.height);
        const vp = getVideoPrefs();
        const api = pipeline.getGraphicsBackend() ?? "webgl";
        if (this.partEnabled("system")) {
          lines.push(`Renderer: ${name} (${api})`);
          lines.push(`Display: ${logicalW}x${logicalH} (${bufW}x${bufH}) @${res.toFixed(2)}x`);
          lines.push(
            `Video: scale ${Math.round(vp.renderScale * 100)}%  bloom ${vp.bloomEnabled ? "on" : "off"}  view ${VIEW_DISTANCE_CHUNKS}`,
          );
        }
      } catch {
        lines.push("(unavailable)");
      }
    }
    lines.push("");
    lines.push("GPU");
    lines.push(staticBlock);
    return lines.join("\n");
  }

  private syncGraphModeUi(): void {
    const visibility: Record<
      "frame" | "bandwidth" | "tps" | "ping" | "profiler",
      boolean
    > = {
      frame: false,
      bandwidth: false,
      tps: false,
      ping: false,
      profiler: false,
    };
    if (this.graphMode === "all") {
      visibility.frame = true;
      visibility.bandwidth = true;
      visibility.tps = true;
      visibility.ping = true;
      visibility.profiler = true;
    } else if (this.graphMode === "perf") {
      visibility.frame = true;
      visibility.tps = true;
    } else if (this.graphMode === "network") {
      visibility.bandwidth = true;
      visibility.ping = true;
    } else if (this.graphMode === "profiler") {
      visibility.frame = true;
      visibility.profiler = true;
    }
    const apply = (card: HudGraphCard | null, on: boolean): void => {
      if (card === null) {
        return;
      }
      card.root.style.display = on ? "flex" : "none";
    };
    apply(this.cardFrame, visibility.frame);
    apply(this.cardBandwidth, visibility.bandwidth);
    apply(this.cardTps, visibility.tps);
    apply(this.cardPing, visibility.ping);
    apply(this.cardProfiler, visibility.profiler);
  }

  private drawBars(
    canvas: HTMLCanvasElement,
    series: HistoryBuffer,
    maxValue: number,
    thresholdMid: number,
    thresholdBad: number,
  ): void {
    const ctx = canvas.getContext("2d");
    if (ctx === null) {
      return;
    }
    const w = canvas.width;
    const h = canvas.height;
    ctx.fillStyle = "#0d0f12";
    ctx.fillRect(0, 0, w, h);
    if (series.stats().size <= 0) {
      return;
    }
    const yForValue = (value: number): number => {
      const clamped = Math.max(0, Math.min(maxValue, value));
      return Math.round(h - (clamped / maxValue) * (h - 1));
    };
    ctx.strokeStyle = "rgba(120,220,120,0.35)";
    ctx.beginPath();
    ctx.moveTo(0, yForValue(thresholdMid));
    ctx.lineTo(w, yForValue(thresholdMid));
    ctx.stroke();
    ctx.strokeStyle = "rgba(235,200,90,0.35)";
    ctx.beginPath();
    ctx.moveTo(0, yForValue(thresholdBad));
    ctx.lineTo(w, yForValue(thresholdBad));
    ctx.stroke();
    const bars = Math.min(w, GRAPH_HISTORY);
    series.forEachNewestToOldest(bars, (value, i) => {
      const x = w - 1 - i;
      const y = yForValue(value);
      ctx.strokeStyle =
        value > thresholdBad
          ? "#ff6767"
          : value > thresholdMid
            ? "#ffd166"
            : "#89ff89";
      ctx.beginPath();
      ctx.moveTo(x, h - 1);
      ctx.lineTo(x, y);
      ctx.stroke();
    });
  }

  private drawCard(
    card: HudGraphCard | null,
    series: HistoryBuffer,
    statLabel: string,
    unitLabel: string,
    maxValue: number,
    thresholdMid: number,
    thresholdBad: number,
  ): void {
    if (card === null || card.root.style.display === "none") {
      return;
    }
    const stats = series.stats();
    card.stats.textContent =
      stats.size <= 0
        ? `${statLabel} ${unitLabel}: -`
        : `${statLabel} ${unitLabel}: ${stats.min.toFixed(2)} / ${stats.avg.toFixed(2)} / ${stats.max.toFixed(2)}`;
    this.drawBars(card.canvas, series, maxValue, thresholdMid, thresholdBad);
  }

  private drawGraphs(): void {
    if (this.graphMode === "none") {
      return;
    }
    this.drawCard(this.cardFrame, this.frameMsHistory, "min/avg/max", "ms", 50, 16.67, 33.33);
    this.drawCard(this.cardBandwidth, this.bandwidthHistory, "min/avg/max", "KiB", 32, 8, 20);
    this.drawCard(this.cardTps, this.tpsMsHistory, "min/avg/max", "ms", 50, 16.67, 33.33);
    this.drawCard(this.cardPing, this.pingHistory, "min/avg/max", "ms", 300, 80, 180);
    if (this.cardProfiler !== null && this.cardProfiler.root.style.display !== "none") {
      const data = this.lastSnapshot?.profiler ?? [];
      const total = data.reduce((s, x) => s + Math.max(0, x.ms), 0);
      this.cardProfiler.stats.textContent =
        data.length <= 0 ? "no slices yet" : `total: ${total.toFixed(2)} ms`;
      this.drawProfilerBreakdown(this.cardProfiler.canvas);
    }
  }

  private drawProfilerBreakdown(canvas: HTMLCanvasElement): void {
    const ctx = canvas.getContext("2d");
    if (ctx === null) {
      return;
    }
    const w = canvas.width;
    const h = canvas.height;
    ctx.fillStyle = "#0d0f12";
    ctx.fillRect(0, 0, w, h);
    const data = this.lastSnapshot?.profiler ?? [];
    if (data.length <= 0) {
      ctx.fillStyle = "#dddddd";
      ctx.font = "11px ui-monospace,Menlo,Consolas,monospace";
      ctx.fillText("No profiler slices yet.", 6, 16);
      return;
    }
    const total = Math.max(0.0001, data.reduce((s, x) => s + Math.max(0, x.ms), 0));
    const barH = Math.min(20, Math.max(8, Math.floor((h - 6) / 5)));
    const colors = ["#7ed957", "#ffd166", "#ff7b7b", "#b084f5", "#72d6ff"];
    const max = Math.min(data.length, 5);
    for (let i = 0; i < max; i++) {
      const entry = data[i]!;
      const ratio = Math.max(0, entry.ms) / total;
      const barW = Math.max(2, Math.round(ratio * (w - 8)));
      const y = 4 + i * (barH + 2);
      ctx.fillStyle = colors[i % colors.length]!;
      ctx.fillRect(4, y, barW, barH);
      ctx.fillStyle = "#ffffff";
      ctx.font = "10px ui-monospace,Menlo,Consolas,monospace";
      ctx.fillText(
        `${entry.name}  ${entry.ms.toFixed(2)}ms`,
        6,
        y + barH - 4,
      );
    }
  }

  destroy(): void {
    uninstallGlHooks();
    this.root?.remove();
    this.root = null;
    this.leftPre = null;
    this.rightPre = null;
    this.targetedPre = null;
    this.cardFrame = null;
    this.cardBandwidth = null;
    this.cardTps = null;
    this.cardPing = null;
    this.cardProfiler = null;
    this.open = false;
    this.staticGl = null;
    this.fpsEma = 0;
  }
}
