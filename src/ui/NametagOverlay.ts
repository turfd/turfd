/**
 * World-space nametags (M5x7) over local + remote players.
 */
import { PLAYER_HEIGHT } from "../core/constants";
import type { Camera } from "../renderer/Camera";

const BASE_URL = import.meta.env.BASE_URL;

function ensureFonts(): void {
  if (document.getElementById("turfd-nametag-fonts")) {
    return;
  }
  const style = document.createElement("style");
  style.id = "turfd-nametag-fonts";
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

export class NametagOverlay {
  private layer: HTMLDivElement | null = null;
  private readonly tags = new Map<string, HTMLDivElement>();

  init(mount: HTMLElement): void {
    ensureFonts();
    const layer = document.createElement("div");
    layer.id = "turfd-nametag-layer";
    layer.style.cssText = [
      "position:absolute",
      "pointer-events:none",
      "z-index:8",
      "overflow:visible",
    ].join(";");
    mount.appendChild(layer);
    this.layer = layer;
  }

  syncLayout(mount: HTMLElement, canvas: HTMLCanvasElement): void {
    const layer = this.layer;
    if (layer === null) {
      return;
    }
    const mr = mount.getBoundingClientRect();
    const cr = canvas.getBoundingClientRect();
    layer.style.left = `${cr.left - mr.left}px`;
    layer.style.top = `${cr.top - mr.top}px`;
    layer.style.width = `${cr.width}px`;
    layer.style.height = `${cr.height}px`;
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
    remotes: ReadonlyMap<string, { x: number; y: number }>,
    roster: ReadonlyMap<string, NametagRosterEntry>,
    localPeerId: string | null,
  ): void {
    const layer = this.layer;
    if (layer === null) {
      return;
    }
    this.syncLayout(mount, canvas);

    const cw = canvas.width;
    const ch = canvas.height;
    const cr = canvas.getBoundingClientRect();
    const scaleX = cr.width / Math.max(1, cw);
    const scaleY = cr.height / Math.max(1, ch);

    const placeTag = (id: string, text: string, worldX: number, worldY: number): void => {
      let el = this.tags.get(id);
      if (el === undefined) {
        el = document.createElement("div");
        el.style.cssText = [
          "position:absolute",
          "transform:translate(-50%,calc(-100% - 4px))",
          "font-family:'M5x7',monospace",
          "font-size:20px",
          "color:#f2f2f7",
          "text-shadow:0 1px 2px #000,0 0 4px #000",
          "white-space:nowrap",
          "max-width:280px",
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
      const px = sx * scaleX;
      const py = sy * scaleY;
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
      placeTag(peerId, label, rp.x, rp.y);
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
