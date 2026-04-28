import { BLOCK_SIZE } from "../core/constants";
import type { Camera } from "../renderer/Camera";
import type { World } from "../world/World";
import { signMarkupToHtml } from "./signFormatting";

const HOVER_MAX_BLOCK_DISTANCE = 4.25;

export class SignHoverOverlay {
  private root: HTMLDivElement | null = null;
  private bubble: HTMLDivElement | null = null;
  private lastHtml = "";
  private lastTransform = "";

  init(mount: HTMLElement): void {
    if (this.root !== null) return;
    const root = document.createElement("div");
    root.style.cssText = [
      "position:absolute",
      "left:0",
      "top:0",
      "width:100%",
      "height:100%",
      "pointer-events:none",
      "z-index:9",
      "overflow:visible",
    ].join(";");
    const bubble = document.createElement("div");
    bubble.style.cssText = [
      "position:absolute",
      "left:0",
      "top:0",
      "max-width:320px",
      "min-width:90px",
      "padding:10px 12px",
      "border-radius:14px",
      "border:1px solid rgba(255,255,255,0.24)",
      "background:rgba(26,25,30,0.93)",
      "color:#f6f4ff",
      "font:16px/1.25 'M5x7', monospace",
      "text-shadow:0 1px 0 rgba(0,0,0,0.55)",
      "display:none",
      "transform:translate(-50%,-100%)",
      "box-shadow:0 8px 22px rgba(0,0,0,0.45)",
      "white-space:normal",
      "overflow-wrap:anywhere",
    ].join(";");
    root.appendChild(bubble);
    mount.appendChild(root);
    this.root = root;
    this.bubble = bubble;
  }

  update(
    world: World,
    camera: Camera,
    canvas: HTMLCanvasElement,
    mouseWorldX: number,
    mouseWorldY: number,
    playerWorldX: number,
    playerWorldY: number,
  ): void {
    if (this.root === null || this.bubble === null) return;
    const wx = Math.floor(mouseWorldX / BLOCK_SIZE);
    const wy = Math.floor(-mouseWorldY / BLOCK_SIZE);
    const block = world.getBlock(wx, wy);
    if (!world.isSignBlockId(block.id)) {
      this.bubble.style.display = "none";
      return;
    }
    const dx = mouseWorldX - playerWorldX;
    const dy = mouseWorldY - playerWorldY;
    const maxDistPx = HOVER_MAX_BLOCK_DISTANCE * BLOCK_SIZE;
    if (dx * dx + dy * dy > maxDistPx * maxDistPx) {
      this.bubble.style.display = "none";
      return;
    }
    const tile = world.getSignTile(wx, wy);
    const html = signMarkupToHtml(tile?.text ?? "");
    if (html.trim().length <= 0) {
      this.bubble.style.display = "none";
      return;
    }
    if (this.lastHtml !== html) {
      this.lastHtml = html;
      this.bubble.innerHTML = html;
    }
    const { x, y } = camera.worldToScreen((wx + 0.5) * BLOCK_SIZE, -(wy + 0.18) * BLOCK_SIZE);
    const rect = canvas.getBoundingClientRect();
    const sx = Math.round((x / Math.max(1, canvas.width)) * rect.width);
    const sy = Math.round((y / Math.max(1, canvas.height)) * rect.height);
    const transform = `translate3d(${sx}px,${sy}px,0) translate(-50%,calc(-100% - 12px))`;
    if (this.lastTransform !== transform) {
      this.lastTransform = transform;
      this.bubble.style.transform = transform;
    }
    this.bubble.style.display = "block";
  }

  destroy(): void {
    this.bubble = null;
    this.root?.remove();
    this.root = null;
    this.lastHtml = "";
    this.lastTransform = "";
  }
}
