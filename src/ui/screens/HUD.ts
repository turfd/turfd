/**
 * In-game HUD: coords, world title, save flash — DOM + EventBus.
 */
import type { EventBus } from "../../core/EventBus";

export class HUD {
  private container: HTMLDivElement | null = null;
  private unsubs: (() => void)[] = [];
  private saveHideTimer: ReturnType<typeof setTimeout> | null = null;
  private bgModeLabel: HTMLDivElement | null = null;

  init(mount: HTMLElement, bus: EventBus): void {
    const wrap = document.createElement("div");
    wrap.id = "hud-root";
    wrap.style.cssText =
      "position:absolute;inset:0;pointer-events:none;z-index:9;overflow:visible;";

    const coords = document.createElement("div");
    coords.style.cssText = [
      "position:absolute",
      "top:0.75rem",
      "left:0.75rem",
      "color:#fff",
      "font:0.85rem system-ui,sans-serif",
      "text-shadow:0 1px 2px #000",
    ].join(";");
    coords.textContent = "X: 0  Y: 0";

    const bgMode = document.createElement("div");
    bgMode.style.cssText = [
      "position:absolute",
      "top:2.25rem",
      "left:0.75rem",
      "color:#c8e6ff",
      "font:0.8rem system-ui,sans-serif",
      "text-shadow:0 1px 2px #000",
      "opacity:0",
      "transition:opacity 0.15s ease",
    ].join(";");
    bgMode.textContent = "Back wall (Tab)";
    this.bgModeLabel = bgMode;

    const worldTitle = document.createElement("div");
    worldTitle.style.cssText = [
      "position:absolute",
      "top:0.75rem",
      "left:50%",
      "transform:translateX(-50%)",
      "color:#fff",
      "font:0.95rem system-ui,sans-serif",
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
      "color:#cfcfcf",
      "font:0.85rem system-ui,sans-serif",
      "text-shadow:0 1px 2px #000",
      "opacity:0",
      "transition:opacity 0.5s ease",
    ].join(";");
    saveIndicator.textContent = "World Saved";

    this.unsubs.push(
      bus.on("player:moved", (e) => {
        coords.textContent = `X: ${e.blockX}  Y: ${e.blockY}`;
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

  setBackgroundEditMode(active: boolean): void {
    if (this.bgModeLabel !== null) {
      this.bgModeLabel.style.opacity = active ? "1" : "0";
    }
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
    this.bgModeLabel = null;
  }
}
