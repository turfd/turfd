/**
 * World-space nametags (M5x7) over local + remote players.
 */
import { PLAYER_HEIGHT } from "../core/constants";
import type { Camera } from "../renderer/Camera";

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

export class NametagOverlay {
  private layer: HTMLDivElement | null = null;
  private readonly tags = new Map<string, HTMLDivElement>();

  init(mount: HTMLElement): void {
    ensureFonts();
    const layer = document.createElement("div");
    layer.id = "stratum-nametag-layer";
    layer.style.cssText = [
      "position:absolute",
      "pointer-events:none",
      "z-index:8",
      "overflow:visible",
    ].join(";");
    mount.appendChild(layer);
    this.layer = layer;
  }

  /**
   * Size the overlay to the mount, not the canvas rect delta. The game canvas is `width/height: 100%`
   * on the mount; using `getBoundingClientRect()` math (`cr - mr`) drifts on some DPR / fractional
   * layouts while `100%` stays aligned with the same containing block as the canvas.
   */
  syncLayout(_mount: HTMLElement, _canvas: HTMLCanvasElement): void {
    const layer = this.layer;
    if (layer === null) {
      return;
    }
    layer.style.left = "0";
    layer.style.top = "0";
    layer.style.width = "100%";
    layer.style.height = "100%";
    layer.style.boxSizing = "border-box";
  }

  /**
   * @param alpha Interpolation factor for local player.
   */
  update(
    mount: HTMLElement,
    canvas: HTMLCanvasElement,
    camera: Camera,
    alpha: number,
    local: {
      prevX: number;
      prevY: number;
      x: number;
      y: number;
      displayName: string;
    },
    remotes: ReadonlyMap<
      string,
      { prevX: number; prevY: number; x: number; y: number }
    >,
    roster: ReadonlyMap<string, NametagRosterEntry>,
    localPeerId: string | null,
  ): void {
    const layer = this.layer;
    if (layer === null) {
      return;
    }
    this.syncLayout(mount, canvas);

    const cw = Math.max(1, canvas.width);
    const ch = Math.max(1, canvas.height);
    const cr = canvas.getBoundingClientRect();
    // Same mapping as InputManager (buffer ↔ CSS via canvas rect).
    const cssPerBufX = cr.width / cw;
    const cssPerBufY = cr.height / ch;
    const bufPerCssX = cw / Math.max(cr.width, 1e-6);
    const bufPerCssY = ch / Math.max(cr.height, 1e-6);
    const uniform =
      Math.abs(bufPerCssX - bufPerCssY) < 1e-3
        ? (cssPerBufX + cssPerBufY) * 0.5
        : null;

    const placeTag = (id: string, text: string, worldX: number, worldY: number): void => {
      let el = this.tags.get(id);
      if (el === undefined) {
        el = document.createElement("div");
        el.style.cssText = [
          "position:absolute",
          `transform:translate(-50%,calc(-100% - ${NAMETAG_GAP_ABOVE_HEAD_PX}px))`,
          "font-family:'M5x7',monospace",
          "font-size:20px",
          "color:#f2f2f7",
          "text-shadow:0 1px 2px #000,0 0 4px #000",
          "white-space:nowrap",
          "max-width:280px",
          "box-sizing:border-box",
          /* Inset keeps M5x7 glyph edges + shadow from clipping under overflow:hidden */
          "padding:0 5px",
          "overflow:hidden",
          "text-overflow:ellipsis",
          "pointer-events:none",
        ].join(";");
        layer.appendChild(el);
        this.tags.set(id, el);
      }
      el.textContent = text;
      const headX = worldX;
      const headY = -worldY - PLAYER_HEIGHT;
      const { x: sx, y: sy } = camera.worldToScreen(headX, headY);
      const px = uniform !== null ? sx * uniform : sx * cssPerBufX;
      const py = uniform !== null ? sy * uniform : sy * cssPerBufY;
      el.style.left = `${px}px`;
      el.style.top = `${py}px`;
    };

    const lx = local.prevX + (local.x - local.prevX) * alpha;
    const ly = local.prevY + (local.y - local.prevY) * alpha;
    const localId = localPeerId ?? "__local__";
    placeTag(localId, local.displayName, lx, ly);

    const stale = new Set(this.tags.keys());
    stale.delete(localId);

    for (const [peerId, rp] of remotes) {
      stale.delete(peerId);
      const entry = roster.get(peerId);
      const label = entry?.displayName ?? peerId;
      const rx = rp.prevX + (rp.x - rp.prevX) * alpha;
      const ry = rp.prevY + (rp.y - rp.prevY) * alpha;
      placeTag(peerId, label, rx, ry);
    }

    for (const id of stale) {
      const el = this.tags.get(id);
      el?.remove();
      this.tags.delete(id);
    }
  }

  clear(): void {
    for (const el of this.tags.values()) {
      el.remove();
    }
    this.tags.clear();
  }

  destroy(): void {
    this.clear();
    this.layer?.remove();
    this.layer = null;
  }
}
