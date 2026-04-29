/**
 * World-space nametags (M5x7) over local + remote players.
 */
import { PLAYER_HEIGHT } from "../core/constants";
import { chunkPerfLog, chunkPerfNow } from "../debug/chunkPerf";
import type { Camera } from "../renderer/Camera";
import type { RemotePlayer } from "../world/entities/RemotePlayer";

const BASE_URL = import.meta.env.BASE_URL;

function ensureFonts(): void {
  if (document.getElementById("stratum-nametag-fonts")) {
    return;
  }
  const style = document.createElement("style");
  style.id = "stratum-nametag-fonts";
  style.textContent = `
    @font-face {
      font-family: 'M5x7';
      src: url('${BASE_URL}assets/fonts/m5x7.ttf') format('truetype');
      font-weight: normal;
      font-style: normal;
    }
  `;
  document.head.appendChild(style);
}

export type NametagRosterEntry = { displayName: string };

/** Gap from nametag bottom to head anchor (px). */
const NAMETAG_GAP_ABOVE_HEAD_PX = 14;

type NametagView = {
  el: HTMLDivElement;
  lastText: string;
  lastTransform: string;
};

export class NametagOverlay {
  private layer: HTMLDivElement | null = null;
  private readonly tags = new Map<string, NametagView>();
  private readonly staleIds = new Set<string>();
  /** Even frames apply tag transforms; odd frames skip when position unchanged (cuts style/layout churn). */
  private spatialPhase = 0;
  private observedCanvas: HTMLCanvasElement | null = null;
  private canvasResizeObserver: ResizeObserver | null = null;
  private canvasCssW = 1;
  private canvasCssH = 1;
  private canvasMetricsDirty = true;

  private readonly onCanvasMetricsInvalidated = (): void => {
    this.canvasMetricsDirty = true;
  };

  init(mount: HTMLElement): void {
    ensureFonts();
    const layer = document.createElement("div");
    layer.id = "stratum-nametag-layer";
    layer.style.cssText = [
      "position:absolute",
      "pointer-events:none",
      "z-index:8",
      "overflow:visible",
      "left:0",
      "top:0",
      "width:100%",
      "height:100%",
      "box-sizing:border-box",
    ].join(";");
    mount.appendChild(layer);
    this.layer = layer;
    window.addEventListener("resize", this.onCanvasMetricsInvalidated);
  }

  private observeCanvas(canvas: HTMLCanvasElement): void {
    if (this.observedCanvas === canvas) {
      return;
    }
    this.canvasResizeObserver?.disconnect();
    this.observedCanvas = canvas;
    this.canvasMetricsDirty = true;
    if (typeof ResizeObserver !== "undefined") {
      this.canvasResizeObserver = new ResizeObserver(
        this.onCanvasMetricsInvalidated,
      );
      this.canvasResizeObserver.observe(canvas);
    }
  }

  private updateCanvasMetrics(canvas: HTMLCanvasElement): void {
    const rect = canvas.getBoundingClientRect();
    // Prefer rect dimensions (includes CSS transforms/zoom) over clientWidth/Height.
    this.canvasCssW = Math.max(1, rect.width || canvas.clientWidth || 1);
    this.canvasCssH = Math.max(1, rect.height || canvas.clientHeight || 1);
    this.canvasMetricsDirty = false;
  }

  /**
   * Nametag positions are driven only from this render-tick path (`Game.render`); do not attach
   * `placeTag` / `update` to DOM pointer events — once per frame is sufficient.
   *
   * @param alpha Interpolation factor for local player.
   * @param nowMs Wall time for remote `RemotePlayer.getDisplayPose`.
   */
  update(
    _mount: HTMLElement,
    canvas: HTMLCanvasElement,
    camera: Camera,
    alpha: number,
    nowMs: number,
    local: {
      prevX: number;
      prevY: number;
      x: number;
      y: number;
      displayName: string;
    },
    remotes: ReadonlyMap<string, RemotePlayer>,
    roster: ReadonlyMap<string, NametagRosterEntry>,
    localPeerId: string | null,
  ): void {
    const t0 = import.meta.env.DEV ? chunkPerfNow() : 0;
    const layer = this.layer;
    if (layer === null) {
      return;
    }
    this.observeCanvas(canvas);
    if (this.canvasMetricsDirty) {
      this.updateCanvasMetrics(canvas);
    }

    /** Match {@link InputManager#updateMouseWorldPos}: camera/worldToScreen use logical pixels. */
    const lw = Math.max(1, canvas.clientWidth || this.canvasCssW);
    const lh = Math.max(1, canvas.clientHeight || this.canvasCssH);
    const cssPerLogicalX = this.canvasCssW / lw;
    const cssPerLogicalY = this.canvasCssH / lh;

    this.spatialPhase = (this.spatialPhase + 1) & 1;
    const applySpatialThisFrame = this.spatialPhase === 0;

    const placeTag = (
      id: string,
      text: string,
      worldX: number,
      worldY: number,
    ): void => {
      let view = this.tags.get(id);
      if (view === undefined) {
        const el = document.createElement("div");
        el.style.cssText = [
          "position:absolute",
          "left:0",
          "top:0",
          "font-family:'M5x7',monospace",
          "font-size:20px",
          "color:#f2f2f7",
          "text-shadow:0 1px 2px #000,0 0 4px #000",
          "white-space:nowrap",
          "max-width:280px",
          "box-sizing:border-box",
          "padding:0 5px",
          "overflow:hidden",
          "text-overflow:ellipsis",
          "pointer-events:none",
          "will-change:transform",
        ].join(";");
        layer.appendChild(el);
        view = { el, lastText: "", lastTransform: "" };
        this.tags.set(id, view);
      }
      const textChanged = view.lastText !== text;
      if (textChanged) {
        view.lastText = text;
        view.el.textContent = text;
      }
      if (!textChanged && !applySpatialThisFrame) {
        return;
      }
      const headY = -worldY - PLAYER_HEIGHT;
      const { x: sx, y: sy } = camera.worldToScreen(worldX, headY);
      const px = Math.round(sx * cssPerLogicalX);
      const py = Math.round(sy * cssPerLogicalY);
      const transform = `translate3d(${px}px,${py}px,0) translate(-50%,calc(-100% - ${NAMETAG_GAP_ABOVE_HEAD_PX}px))`;
      if (view.lastTransform !== transform) {
        view.lastTransform = transform;
        view.el.style.transform = transform;
      }
    };

    const lx = local.prevX + (local.x - local.prevX) * alpha;
    const ly = local.prevY + (local.y - local.prevY) * alpha;
    const localId = localPeerId ?? "__local__";
    placeTag(localId, local.displayName, lx, ly);

    const stale = this.staleIds;
    stale.clear();
    for (const id of this.tags.keys()) {
      stale.add(id);
    }
    stale.delete(localId);

    for (const [peerId, rp] of remotes) {
      stale.delete(peerId);
      const entry = roster.get(peerId);
      const label = entry?.displayName ?? peerId;
      const d = rp.getDisplayPose(nowMs);
      placeTag(peerId, label, d.x, d.y);
    }

    for (const id of stale) {
      const view = this.tags.get(id);
      view?.el.remove();
      this.tags.delete(id);
    }
    stale.clear();
    if (import.meta.env.DEV) {
      chunkPerfLog("nametagOverlay:update", chunkPerfNow() - t0, {
        tags: this.tags.size,
        remotes: remotes.size,
      });
    }
  }

  clear(): void {
    for (const view of this.tags.values()) {
      view.el.remove();
    }
    this.tags.clear();
  }

  destroy(): void {
    this.clear();
    window.removeEventListener("resize", this.onCanvasMetricsInvalidated);
    this.canvasResizeObserver?.disconnect();
    this.canvasResizeObserver = null;
    this.observedCanvas = null;
    this.layer?.remove();
    this.layer = null;
  }
}
