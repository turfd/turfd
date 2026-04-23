/**
 * In-game HUD: coords, world title, save flash — DOM + EventBus.
 */
import type { EventBus } from "../../core/EventBus";

export class HUD {
  private container: HTMLDivElement | null = null;
  private unsubs: (() => void)[] = [];
  private saveHideTimer: ReturnType<typeof setTimeout> | null = null;
  private lastCoordsText = "X: 0  Y: 0";

  init(mount: HTMLElement, bus: EventBus): void {
    const wrap = document.createElement("div");
    wrap.id = "hud-root";
    wrap.style.cssText =
      "position:absolute;inset:0;pointer-events:none;z-index:9;overflow:visible;";

    const coords = document.createElement("div");
    coords.style.cssText = [
      "position:absolute",
      "top:12px",
      "left:12px",
      "color:#f2f2f7",
      "font-family:'M5x7',monospace",
      "font-size:20px",
      "-webkit-font-smoothing:none",
      "text-shadow:0 1px 2px #000",
    ].join(";");
    coords.textContent = this.lastCoordsText;

    const bgMode = document.createElement("div");
    bgMode.style.cssText = [
      "position:absolute",
      "top:36px",
      "left:12px",
      "color:#aeaeb2",
      "font-family:'M5x7',monospace",
      "font-size:18px",
      "-webkit-font-smoothing:none",
      "text-shadow:0 1px 2px #000",
      "opacity:0",
      "transition:opacity 0.15s ease",
    ].join(";");
    bgMode.textContent = "Back wall (Tab)";

    const worldTitle = document.createElement("div");
    worldTitle.style.cssText = [
      "position:absolute",
      "top:12px",
      "left:50%",
      "transform:translateX(-50%)",
      "color:#f2f2f7",
      "font-family:'BoldPixels',monospace",
      "font-size:17px",
      "-webkit-font-smoothing:none",
      "text-shadow:0 1px 2px #000",
      "max-width:90vw",
      "text-align:center",
      "white-space:nowrap",
      "overflow:hidden",
      "text-overflow:ellipsis",
    ].join(";");
    worldTitle.textContent = "";

    const saveIndicator = document.createElement("div");
    saveIndicator.style.cssText = [
      "position:absolute",
      "bottom:5rem",
      "right:1rem",
      "color:#aeaeb2",
      "font-family:'M5x7',monospace",
      "font-size:20px",
      "-webkit-font-smoothing:none",
      "text-shadow:0 1px 2px #000",
      "opacity:0",
      "transition:opacity 0.5s ease",
    ].join(";");
    saveIndicator.textContent = "World Saved";

    this.unsubs.push(
      bus.on("player:moved", (e) => {
        const next = `X: ${e.blockX}  Y: ${e.blockY}`;
        if (next !== this.lastCoordsText) {
          this.lastCoordsText = next;
          coords.textContent = next;
        }
      }),
    );
    this.unsubs.push(
      bus.on("game:worldLoaded", (e) => {
        worldTitle.textContent = e.name;
      }),
    );
    this.unsubs.push(
      bus.on("game:saved", () => {
        if (this.saveHideTimer !== null) {
          clearTimeout(this.saveHideTimer);
        }
        saveIndicator.style.opacity = "1";
        this.saveHideTimer = setTimeout(() => {
          saveIndicator.style.opacity = "0";
          this.saveHideTimer = null;
        }, 2000);
      }),
    );

    wrap.appendChild(coords);
    wrap.appendChild(bgMode);
    wrap.appendChild(worldTitle);
    wrap.appendChild(saveIndicator);
    mount.appendChild(wrap);
    this.container = wrap;
  }

  destroy(): void {
    if (this.saveHideTimer !== null) {
      clearTimeout(this.saveHideTimer);
      this.saveHideTimer = null;
    }
    for (const u of this.unsubs) {
      u();
    }
    this.unsubs = [];
    this.container?.remove();
    this.container = null;
    this.lastCoordsText = "X: 0  Y: 0";
  }
}
