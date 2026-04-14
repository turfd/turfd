/**
 * In-game HUD: coords, world title, save flash — DOM + EventBus.
 */
import type { EventBus } from "../../core/EventBus";

export class HUD {
  private container: HTMLDivElement | null = null;
  private unsubs: (() => void)[] = [];
  private saveHideTimer: ReturnType<typeof setTimeout> | null = null;
  private bgModeHideTimer: ReturnType<typeof setTimeout> | null = null;
  private bgModeLabel: HTMLDivElement | null = null;
  private bgModeIndicator: HTMLDivElement | null = null;
  private bgModeStatusText: HTMLDivElement | null = null;
  private lastBgModeActive: boolean | null = null;
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
    this.bgModeLabel = bgMode;

    const bgModeIndicator = document.createElement("div");
    bgModeIndicator.style.cssText = [
      "position:absolute",
      "left:50%",
      // Keep this vertically centered with the hotbar strip while offset to its left.
      "bottom:calc(1.1rem + 78px)",
      "width:26px",
      "height:52px",
      "transform:translateX(-50%)",
      "pointer-events:none",
      "opacity:0",
      "display:flex",
      "flex-direction:column",
      "align-items:center",
      "justify-content:flex-start",
      "gap:6px",
      "transition:opacity 0.14s ease",
    ].join(";");
    bgModeIndicator.setAttribute("aria-hidden", "true");
    bgModeIndicator.setAttribute("title", "Build layer");

    const bgModeSquares = document.createElement("div");
    bgModeSquares.style.cssText = [
      "position:relative",
      "width:26px",
      "height:26px",
      "display:block",
    ].join(";");

    const bgModeSquareBack = document.createElement("div");
    bgModeSquareBack.style.cssText = [
      "position:absolute",
      "left:0",
      "top:0",
      "width:18px",
      "height:18px",
      "box-sizing:border-box",
      "border:2px solid rgba(242,242,247,0.95)",
      "background:rgba(242,242,247,0.95)",
      "box-shadow:0 1px 2px rgba(0,0,0,0.45)",
      "transition:background 0.15s ease, border-color 0.15s ease",
    ].join(";");
    bgModeSquareBack.className = "hud-layer-square hud-layer-square--back";

    const bgModeSquareFront = document.createElement("div");
    bgModeSquareFront.style.cssText = [
      "position:absolute",
      "right:0",
      "bottom:0",
      "width:18px",
      "height:18px",
      "box-sizing:border-box",
      "border:2px solid rgba(242,242,247,0.95)",
      "background:transparent",
      "box-shadow:0 1px 2px rgba(0,0,0,0.45)",
      "transition:background 0.15s ease, border-color 0.15s ease",
    ].join(";");
    bgModeSquareFront.className = "hud-layer-square hud-layer-square--front";

    const bgModeStatusText = document.createElement("div");
    bgModeStatusText.style.cssText = [
      "line-height:1",
      "font-family:'M5x7',monospace",
      "font-size:24px",
      "-webkit-font-smoothing:none",
      "text-shadow:1px 1px 0 #0d0d0d",
      "text-transform:lowercase",
      "letter-spacing:0.01em",
      "color:#f2f2f7",
      "opacity:0.98",
      "text-align:center",
      "min-width:130px",
    ].join(";");
    this.bgModeStatusText = bgModeStatusText;

    bgModeSquares.appendChild(bgModeSquareBack);
    bgModeSquares.appendChild(bgModeSquareFront);
    bgModeIndicator.appendChild(bgModeSquares);
    bgModeIndicator.appendChild(bgModeStatusText);
    this.bgModeIndicator = bgModeIndicator;

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
    wrap.appendChild(bgModeIndicator);
    wrap.appendChild(worldTitle);
    wrap.appendChild(saveIndicator);
    mount.appendChild(wrap);
    this.container = wrap;
  }

  setBackgroundEditMode(active: boolean): void {
    if (this.bgModeLabel !== null) {
      this.bgModeLabel.style.opacity = "0";
    }
    if (this.lastBgModeActive === active) {
      return;
    }
    this.lastBgModeActive = active;

    const indicator = this.bgModeIndicator;
    if (indicator !== null) {
      const back = indicator.querySelector(
        ".hud-layer-square--back",
      ) as HTMLDivElement | null;
      const front = indicator.querySelector(
        ".hud-layer-square--front",
      ) as HTMLDivElement | null;
      if (back !== null && front !== null) {
        // Foreground mode: front square is solid. Background mode: back square is solid.
        back.style.background = active
          ? "rgba(242,242,247,0.95)"
          : "transparent";
        front.style.background = active
          ? "transparent"
          : "rgba(242,242,247,0.95)";
        // Quick swap animation to make mode changes obvious.
        back.animate(
          [
            { transform: "scale(0.9)", opacity: 0.72 },
            { transform: "scale(1.08)", opacity: 1 },
            { transform: "scale(1)", opacity: 1 },
          ],
          { duration: 170, easing: "cubic-bezier(0.22,1,0.36,1)" },
        );
        front.animate(
          [
            { transform: "scale(0.9)", opacity: 0.72 },
            { transform: "scale(1.08)", opacity: 1 },
            { transform: "scale(1)", opacity: 1 },
          ],
          { duration: 170, easing: "cubic-bezier(0.22,1,0.36,1)" },
        );
      }
      if (this.bgModeStatusText !== null) {
        this.bgModeStatusText.textContent = active ? "background" : "foreground";
      }
      indicator.setAttribute(
        "title",
        active ? "Building in background (Tab)" : "Building in foreground (Tab)",
      );
      indicator.style.opacity = "0.95";
      if (this.bgModeHideTimer !== null) {
        clearTimeout(this.bgModeHideTimer);
      }
      this.bgModeHideTimer = setTimeout(() => {
        indicator.style.opacity = "0";
        this.bgModeHideTimer = null;
      }, 900);
    }
  }

  destroy(): void {
    if (this.saveHideTimer !== null) {
      clearTimeout(this.saveHideTimer);
      this.saveHideTimer = null;
    }
    if (this.bgModeHideTimer !== null) {
      clearTimeout(this.bgModeHideTimer);
      this.bgModeHideTimer = null;
    }
    for (const u of this.unsubs) {
      u();
    }
    this.unsubs = [];
    this.container?.remove();
    this.container = null;
    this.bgModeLabel = null;
    this.bgModeIndicator = null;
    this.bgModeStatusText = null;
    this.lastBgModeActive = null;
    this.lastCoordsText = "X: 0  Y: 0";
  }
}
