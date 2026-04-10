import { Container, Rectangle, Sprite, Texture } from "pixi.js";

const FLAKE_COUNT = 90;
const SNOW_FRAME_SIZE = 16;

type Flake = {
  sprite: Sprite;
  x: number;
  y: number;
  vx: number;
  vy: number;
  driftPhase: number;
  driftSpeed: number;
  driftAmp: number;
  alpha: number;
};

export class WeatherSnowParticles {
  private readonly root: Container;
  private readonly flakes: Flake[] = [];
  private readonly frames: Texture[];
  private rw = 0;
  private rh = 0;

  constructor(parent: Container, texture: Texture) {
    this.root = new Container({ label: "weatherSnowParticles" });
    this.root.eventMode = "none";
    this.root.visible = false;
    parent.addChild(this.root);
    this.frames = this.sliceFrames(texture);

    for (let i = 0; i < FLAKE_COUNT; i++) {
      const sprite = new Sprite(this.frames[0] ?? texture);
      sprite.anchor.set(0.5, 0.5);
      sprite.roundPixels = true;
      this.root.addChild(sprite);
      this.flakes.push({
        sprite,
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        driftPhase: 0,
        driftSpeed: 0,
        driftAmp: 0,
        alpha: 0,
      });
    }
  }

  destroy(): void {
    for (const flake of this.flakes) {
      flake.sprite.destroy({ texture: false });
    }
    this.flakes.length = 0;
    this.root.parent?.removeChild(this.root);
    this.root.destroy({ children: false });
  }

  private spawn(i: number): void {
    const rng = Math.random;
    const w = Math.max(1, this.rw);
    const h = Math.max(1, this.rh);
    const flake = this.flakes[i]!;
    flake.x = rng() * w;
    flake.y = -12 - rng() * h * 0.45;
    flake.vx = -10 + rng() * 20;
    flake.vy = 28 + rng() * 44;
    flake.driftPhase = rng() * Math.PI * 2;
    flake.driftSpeed = 0.7 + rng() * 1.1;
    flake.driftAmp = 3 + rng() * 8;
    flake.alpha = 0.24 + rng() * 0.38;
    flake.sprite.texture =
      this.frames[Math.floor(rng() * this.frames.length)] ?? flake.sprite.texture;

    const scale = 0.42 + rng() * 0.38;
    flake.sprite.scale.set(scale, scale);
    flake.sprite.rotation = rng() * Math.PI * 2;
  }

  update(
    dtSec: number,
    intensity: number,
    viewW: number,
    viewH: number,
    topLeftX: number,
    topLeftY: number,
    zoom: number,
  ): void {
    if (intensity <= 0.01 || viewW <= 0 || viewH <= 0) {
      this.root.visible = false;
      return;
    }
    if (viewW !== this.rw || viewH !== this.rh) {
      this.rw = viewW;
      this.rh = viewH;
      for (let i = 0; i < this.flakes.length; i++) {
        this.spawn(i);
      }
    }

    this.root.visible = true;
    this.root.position.set(topLeftX, topLeftY);

    const invZ = 1 / Math.max(0.001, zoom);
    const width = this.rw;
    const height = this.rh;
    for (let i = 0; i < this.flakes.length; i++) {
      const flake = this.flakes[i]!;
      if (flake.y > height + 22) {
        this.spawn(i);
      }
      flake.driftPhase += dtSec * flake.driftSpeed;
      flake.x += (flake.vx + Math.sin(flake.driftPhase) * flake.driftAmp) * dtSec * invZ;
      flake.y += flake.vy * dtSec * invZ;
      if (flake.x < -24) {
        flake.x = width + 12;
      } else if (flake.x > width + 24) {
        flake.x = -12;
      }
      flake.sprite.position.set(flake.x, flake.y);
      flake.sprite.alpha = flake.alpha * intensity;
      flake.sprite.rotation += dtSec * 0.25;
    }
  }

  private sliceFrames(texture: Texture): Texture[] {
    const sourceW = texture.frame.width;
    const sourceH = texture.frame.height;
    const cols = Math.max(1, Math.floor(sourceW / SNOW_FRAME_SIZE));
    const rows = Math.max(1, Math.floor(sourceH / SNOW_FRAME_SIZE));
    const out: Texture[] = [];
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        out.push(
          new Texture({
            source: texture.source,
            frame: new Rectangle(
              texture.frame.x + x * SNOW_FRAME_SIZE,
              texture.frame.y + y * SNOW_FRAME_SIZE,
              SNOW_FRAME_SIZE,
              SNOW_FRAME_SIZE,
            ),
          }),
        );
      }
    }
    return out.length > 0 ? out : [texture];
  }
}
