/**
 * Floating combat text: upward kick, gravity arc; fades by time and by height before “ground”.
 * HTML overlay + camera projection.
 */
import type { Camera } from "../renderer/Camera";
import type { EventBus } from "../core/EventBus";

const BASE_URL = import.meta.env.BASE_URL;

const MAX_POPUPS = 48;
/** Seconds until popup is removed (ballistic arc + fade). */
const DEFAULT_LIFE_SEC = 0.86;
/** World-space downward acceleration (feet Y up → subtract from vy each tick). */
const GRAVITY_PX_PER_SEC2 = 620;
/** Initial speed out of the launch cone (px/s). */
const BOUNCE_SPEED_MIN = 180;
const BOUNCE_SPEED_MAX = 300;
/**
 * Launch directions are limited to this cone around **world up** (π/2 rad),
 * so digits always pop upward first, then arc down under gravity.
 */
const LAUNCH_CONE_HALF_RAD = 0.82;
/** Horizontal damping (air); keeps long sideways drifts subtle. */
const HORIZONTAL_DRAG_PER_SEC = 1.8;
/**
 * World Y is feet-up. After the arc falls this many px **below** the spawn point, opacity
 * ramps down so text vanishes before it reads as sitting on / in the terrain.
 */
const FADE_HEIGHT_DROP_START_PX = 12;
/** Fully transparent by this much drop below spawn (tuned ~torso → feet for typical anchors). */
const FADE_HEIGHT_DROP_END_PX = 34;
/** Normalized time before time-based fade begins (earlier = quicker overall fade). */
const TIME_FADE_START_T = 0.2;
/** Steeper = faster toward transparent after `TIME_FADE_START_T`. */
const TIME_FADE_POWER = 2.35;
/** Height ramp exponent (>2 = fades out faster on the descent). */
const HEIGHT_FADE_POWER = 2.4;

function ensureM5x7Font(): void {
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

type Popup = {
  el: HTMLDivElement;
  worldX: number;
  worldY: number;
  /** Feet-up Y at spawn; used to fade before the digit visually reaches the ground. */
  spawnWorldY: number;
  vx: number;
  vy: number;
  ageSec: number;
  lifeSec: number;
  damage: number;
};

export class DamageNumbersOverlay {
  private layer: HTMLDivElement | null = null;
  private readonly pops: Popup[] = [];
  private observedCanvas: HTMLCanvasElement | null = null;
  private canvasResizeObserver: ResizeObserver | null = null;
  private canvasCssW = 1;
  private canvasCssH = 1;
  private canvasMetricsDirty = true;
  private unsub: (() => void) | null = null;

  private readonly onCanvasMetricsInvalidated = (): void => {
    this.canvasMetricsDirty = true;
  };

  constructor(private readonly bus: EventBus) {}

  init(mount: HTMLElement): void {
    ensureM5x7Font();
    const layer = document.createElement("div");
    layer.id = "stratum-damage-numbers-layer";
    layer.style.cssText = [
      "position:absolute",
      "pointer-events:none",
      "z-index:9",
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

    this.unsub = this.bus.on("fx:damage-number", (ev) => {
      if (ev.damage <= 0) {
        return;
      }
      this.spawn(ev.worldAnchorX, ev.worldAnchorY, ev.damage);
    });
  }

  private observeCanvas(canvas: HTMLCanvasElement): void {
    if (this.observedCanvas === canvas) {
      return;
    }
    this.canvasResizeObserver?.disconnect();
    this.observedCanvas = canvas;
    this.canvasMetricsDirty = true;
    if (typeof ResizeObserver !== "undefined") {
      this.canvasResizeObserver = new ResizeObserver(this.onCanvasMetricsInvalidated);
      this.canvasResizeObserver.observe(canvas);
    }
  }

  private updateCanvasMetrics(canvas: HTMLCanvasElement): void {
    const rect = canvas.getBoundingClientRect();
    this.canvasCssW = Math.max(1, rect.width || canvas.clientWidth || 1);
    this.canvasCssH = Math.max(1, rect.height || canvas.clientHeight || 1);
    this.canvasMetricsDirty = false;
  }

  private spawn(worldAnchorX: number, worldAnchorY: number, damage: number): void {
    const layer = this.layer;
    if (layer === null) {
      return;
    }
    while (this.pops.length >= MAX_POPUPS) {
      const old = this.pops.shift();
      old?.el.remove();
    }

    const el = document.createElement("div");
    const big = damage >= 7;
    el.style.cssText = [
      "position:absolute",
      "left:0",
      "top:0",
      "font-family:'M5x7',monospace",
      big ? "font-size:42px" : "font-size:36px",
      big ? "color:#ffe566" : "color:#fff8f0",
      "font-weight:bold",
      "text-shadow:-2px 0 #000,2px 0 #000,0 -2px #000,0 2px #000,0 3px 8px rgba(0,0,0,0.92)",
      "white-space:nowrap",
      "pointer-events:none",
      "will-change:transform,opacity",
    ].join(";");
    el.textContent = String(Math.round(damage));
    layer.appendChild(el);

    const jitterX = (Math.random() - 0.5) * 14;
    const jitterY = (Math.random() - 0.5) * 8;
    const speed =
      BOUNCE_SPEED_MIN +
      Math.random() * (BOUNCE_SPEED_MAX - BOUNCE_SPEED_MIN);
    const angle =
      Math.PI * 0.5 +
      (Math.random() - 0.5) * (2 * LAUNCH_CONE_HALF_RAD);
    const vx = Math.cos(angle) * speed;
    const vy = Math.sin(angle) * speed;
    const y0 = worldAnchorY + jitterY;
    this.pops.push({
      el,
      worldX: worldAnchorX + jitterX,
      worldY: y0,
      spawnWorldY: y0,
      vx,
      vy,
      ageSec: 0,
      lifeSec: DEFAULT_LIFE_SEC + (big ? 0.08 : 0),
      damage,
    });
  }

  update(canvas: HTMLCanvasElement, camera: Camera, dtSec: number): void {
    const layer = this.layer;
    if (layer === null) {
      return;
    }
    this.observeCanvas(canvas);
    if (this.canvasMetricsDirty) {
      this.updateCanvasMetrics(canvas);
    }

    const lw = Math.max(1, canvas.clientWidth || this.canvasCssW);
    const lh = Math.max(1, canvas.clientHeight || this.canvasCssH);
    const cssPerLogicalX = this.canvasCssW / lw;
    const cssPerLogicalY = this.canvasCssH / lh;

    for (let i = this.pops.length - 1; i >= 0; i--) {
      const p = this.pops[i]!;
      p.ageSec += dtSec;
      p.vy -= GRAVITY_PX_PER_SEC2 * dtSec;
      p.worldX += p.vx * dtSec;
      p.worldY += p.vy * dtSec;
      p.vx *= Math.exp(-HORIZONTAL_DRAG_PER_SEC * dtSec);

      const t = p.ageSec / p.lifeSec;
      if (t >= 1) {
        p.el.remove();
        this.pops.splice(i, 1);
        continue;
      }

      // Quick pop-in, then settle while the number arcs.
      const popT = Math.min(1, p.ageSec / 0.14);
      const overshoot = Math.sin(popT * Math.PI) * 0.14;
      const scale = 0.88 + 0.28 * popT + overshoot;
      // Time-based fade (starts earlier, steeper curve).
      const timeFade =
        t < TIME_FADE_START_T
          ? 1
          : Math.max(
              0,
              1 -
                ((t - TIME_FADE_START_T) / (1 - TIME_FADE_START_T)) **
                  TIME_FADE_POWER,
            );
      // Height-based fade: falling below spawn → invisible before “ground” read.
      const dropBelowSpawn = p.spawnWorldY - p.worldY;
      let heightFade = 1;
      if (dropBelowSpawn > FADE_HEIGHT_DROP_START_PX) {
        const span = FADE_HEIGHT_DROP_END_PX - FADE_HEIGHT_DROP_START_PX;
        const u = Math.min(
          1,
          Math.max(0, (dropBelowSpawn - FADE_HEIGHT_DROP_START_PX) / span),
        );
        heightFade = 1 - u ** HEIGHT_FADE_POWER;
      }
      const fade = Math.min(timeFade, heightFade);

      const { x: sx, y: sy } = camera.worldToScreen(p.worldX, -p.worldY);
      const px = Math.round(sx * cssPerLogicalX);
      const py = Math.round(sy * cssPerLogicalY);
      const transform = `translate3d(${px}px,${py}px,0) translate(-50%,-50%) scale(${scale})`;
      p.el.style.transform = transform;
      p.el.style.opacity = String(Math.max(0, Math.min(1, fade)));

      // Remove early once fully faded on the descent so dead DOM nodes don’t linger.
      if (fade <= 0.02 && dropBelowSpawn > FADE_HEIGHT_DROP_START_PX) {
        p.el.remove();
        this.pops.splice(i, 1);
        continue;
      }
    }
  }

  clear(): void {
    for (const p of this.pops) {
      p.el.remove();
    }
    this.pops.length = 0;
  }

  destroy(): void {
    this.unsub?.();
    this.unsub = null;
    this.clear();
    window.removeEventListener("resize", this.onCanvasMetricsInvalidated);
    this.canvasResizeObserver?.disconnect();
    this.canvasResizeObserver = null;
    this.observedCanvas = null;
    this.layer?.remove();
    this.layer = null;
  }
}
