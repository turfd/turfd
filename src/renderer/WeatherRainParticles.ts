/**
 * Diagonal streaks in the same space as the rain tiling (viewport-sized local coords, world-root parent).
 * Blend mode `add` approximates Minecraft's translucent rain particle pass (brightening against dark sky).
 */
import { Container, Graphics } from "pixi.js";

/** Slightly denser than before; tuned for world-space viewport. */
const DROP_COUNT = 150;

type Drop = {
  x: number;
  y: number;
  vy: number;
  len: number;
  a: number;
  wind: number;
};

export class WeatherRainParticles {
  private readonly root: Container;
  private readonly g: Graphics;
  private readonly drops: Drop[] = [];
  private rw = 0;
  private rh = 0;

  constructor(parent: Container) {
    this.root = new Container();
    this.g = new Graphics();
    this.root.addChild(this.g);
    this.root.visible = false;
    this.root.label = "weatherRainParticles";
    this.root.eventMode = "none";
    /** Minecraft-style rain: additive-ish particles over the tiling layer. */
    this.root.blendMode = "add";
    parent.addChild(this.root);
    for (let i = 0; i < DROP_COUNT; i++) {
      this.drops.push({
        x: 0,
        y: 0,
        vy: 720,
        len: 10,
        a: 0.18,
        wind: -0.9,
      });
    }
  }

  destroy(): void {
    this.root.parent?.removeChild(this.root);
    this.root.destroy({ children: true });
  }

  private spawn(i: number): void {
    const rng = Math.random;
    const w = Math.max(1, this.rw);
    const h = Math.max(1, this.rh);
    this.drops[i]!.x = rng() * w;
    this.drops[i]!.y = -30 - rng() * h * 0.55;
    this.drops[i]!.vy = 620 + rng() * 420;
    this.drops[i]!.len = 3 + rng() * 7;
    this.drops[i]!.a = 0.08 + rng() * 0.22;
    this.drops[i]!.wind = -1.1 + rng() * 2.2;
  }

  /**
   * @param viewW view width in **world** pixels (screen px / zoom)
   * @param viewH view height in world pixels
   * @param zoom effective camera zoom — streak speeds are defined in screen px/s and scaled by `1/zoom`
   *            so apparent motion stays consistent while coords stay world-space.
   */
  update(dtSec: number, active: boolean, viewW: number, viewH: number, zoom: number): void {
    if (!active || viewW <= 0 || viewH <= 0) {
      this.root.visible = false;
      return;
    }
    const z = Math.max(0.001, zoom);
    if (viewW !== this.rw || viewH !== this.rh) {
      this.rw = viewW;
      this.rh = viewH;
      for (let i = 0; i < DROP_COUNT; i++) {
        this.spawn(i);
      }
    }
    this.root.visible = true;
    this.g.clear();
    const w = this.rw;
    const h = this.rh;
    const invZ = 1 / z;
    for (let i = 0; i < DROP_COUNT; i++) {
      const d = this.drops[i]!;
      if (d.y > h + 40) {
        this.spawn(i);
      }
      d.y += d.vy * dtSec * invZ;
      d.x += d.wind * dtSec * 26 * invZ;
      if (d.x < -50) {
        d.x = w + 30;
      }
      if (d.x > w + 50) {
        d.x = -25;
      }
      const tilt = d.wind * 0.1;
      this.g.moveTo(d.x, d.y);
      this.g.lineTo(d.x + tilt, d.y + d.len);
      this.g.stroke({
        width: Math.max(0.45, 0.75 / z),
        color: 0xa8c8ff,
        alpha: d.a,
      });
    }
  }
}
