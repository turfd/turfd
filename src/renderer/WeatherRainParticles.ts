/**
 * Diagonal streaks in the same space as the rain tiling (viewport-sized local coords, world-root parent).
 * Blend mode `overlay` tints the scene beneath (stronger contrast than normal, less blow-out than add).
 *
 * Uses a single Mesh with quad-per-streak geometry instead of 150 per-frame Graphics strokes.
 */
import { Container, Mesh, MeshGeometry, Texture } from "pixi.js";

/** Slightly denser than before; tuned for world-space viewport. */
const DROP_COUNT = 150;

/** Half-width of each streak quad (screen pixels before zoom compensation). */
const HALF_W_BASE = 0.375;

/** Rain streak colour packed as normalised RGBA (used to tint via vertex color). */
const R_NORM = 0xa8 / 255;
const G_NORM = 0xc8 / 255;
const B_NORM = 0xff / 255;

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
  private readonly mesh: Mesh;
  private readonly positions: Float32Array;
  private readonly uvs: Float32Array;
  private readonly colors: Float32Array;
  private readonly indices: Uint32Array;
  private readonly geo: MeshGeometry;
  private readonly drops: Drop[] = [];
  private rw = 0;
  private rh = 0;

  constructor(parent: Container) {
    this.root = new Container();
    this.root.visible = false;
    this.root.label = "weatherRainParticles";
    this.root.eventMode = "none";
    this.root.blendMode = "overlay";
    parent.addChild(this.root);

    const verts = DROP_COUNT * 4;
    this.positions = new Float32Array(verts * 2);
    this.uvs = new Float32Array(verts * 2);
    this.colors = new Float32Array(verts * 4);
    this.indices = new Uint32Array(DROP_COUNT * 6);

    for (let i = 0; i < DROP_COUNT; i++) {
      const base = i * 4;
      const ii = i * 6;
      this.indices[ii + 0] = base + 0;
      this.indices[ii + 1] = base + 1;
      this.indices[ii + 2] = base + 2;
      this.indices[ii + 3] = base + 2;
      this.indices[ii + 4] = base + 1;
      this.indices[ii + 5] = base + 3;
    }

    this.geo = new MeshGeometry({
      positions: this.positions,
      uvs: this.uvs,
      indices: this.indices,
    });

    this.mesh = new Mesh({ geometry: this.geo, texture: Texture.WHITE });
    this.root.addChild(this.mesh);

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
    const w = this.rw;
    const h = this.rh;
    const invZ = 1 / z;
    const halfW = Math.max(0.225, HALF_W_BASE / z);
    const pos = this.positions;
    const col = this.colors;

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
      const x0 = d.x;
      const y0 = d.y;
      const x1 = d.x + tilt;
      const y1 = d.y + d.len;

      const pi = i * 8;
      pos[pi + 0] = x0 - halfW;
      pos[pi + 1] = y0;
      pos[pi + 2] = x0 + halfW;
      pos[pi + 3] = y0;
      pos[pi + 4] = x1 - halfW;
      pos[pi + 5] = y1;
      pos[pi + 6] = x1 + halfW;
      pos[pi + 7] = y1;

      const ci = i * 16;
      const a = d.a;
      col[ci + 0] = R_NORM; col[ci + 1] = G_NORM; col[ci + 2] = B_NORM; col[ci + 3] = a;
      col[ci + 4] = R_NORM; col[ci + 5] = G_NORM; col[ci + 6] = B_NORM; col[ci + 7] = a;
      col[ci + 8] = R_NORM; col[ci + 9] = G_NORM; col[ci + 10] = B_NORM; col[ci + 11] = a;
      col[ci + 12] = R_NORM; col[ci + 13] = G_NORM; col[ci + 14] = B_NORM; col[ci + 15] = a;
    }

    const posAttr = this.geo.attributes.aPosition;
    if (posAttr !== undefined) {
      posAttr.buffer.update();
    }
  }
}
