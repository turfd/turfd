/**
 * Client-only ambient butterflies near flower blocks: light drift, 2-frame flap,
 * hue-shifted variants, despawn after sustained off-screen time.
 */
import { Container, Sprite, Texture, TextureSource } from "pixi.js";
import {
  BLOCK_SIZE,
  BUTTERFLY_FLAP_SEC,
  BUTTERFLY_FLOWER_LOCATE_SAMPLES,
  BUTTERFLY_HUE_BUCKETS,
  BUTTERFLY_HUE_CACHE_MAX,
  BUTTERFLY_MAX_RISE_BLOCKS,
  BUTTERFLY_MAX_ONSCREEN,
  BUTTERFLY_MAX_PARTICLES,
  BUTTERFLY_MAX_SPEED,
  BUTTERFLY_OFFSCREEN_DESPAWN_SEC,
  BUTTERFLY_SCALE,
  BUTTERFLY_SPAWN_CHANCE,
  BUTTERFLY_SPAWN_CHUNK_RADIUS,
  BUTTERFLY_SPAWN_POOL_CHEB,
  BUTTERFLY_SPAWN_TRIES_PER_TICK,
  BUTTERFLY_VEL_DAMP_PER_SEC,
  BUTTERFLY_VIEW_MARGIN_SCREEN_PX,
  BUTTERFLY_WANDER_ACCEL,
  BUTTERFLY_WANDER_SINE_STRENGTH,
  CHUNK_SIZE,
} from "../core/constants";
import type { BlockRegistry } from "../world/blocks/BlockRegistry";
import { worldToChunk } from "../world/chunk/ChunkCoord";
import type { World } from "../world/World";
import {
  createAABB,
  overlaps,
  sweepAABB,
  type AABB,
} from "../entities/physics/AABB";
import { getSolidAABBs } from "../entities/physics/Collision";
import type { Camera } from "./Camera";
import type { RenderPipeline } from "./RenderPipeline";
import { ObjectPool } from "../utils/pool";

const FLOWER_IDENTIFIERS = [
  "stratum:dandelion",
  "stratum:poppy",
] as const;

const SHEET_PATH =
  "assets/mods/resource_packs/stratum-core/textures/particles/butterfly_sheet.png";

const VARIANT_COUNT = 3;

/**
 * Packed spritesheet layout (all frames height 5):
 * [open 7w][3px gap][closed 3w][gap][…] × 3 color variants.
 * The gap **between** variants is inferred from `naturalWidth` so e.g. 45px (2×3px) and
 * 47px (2×4px) both load; width must equal `3 * slotW + 2 * gap` for an integer `gap ≥ 0`.
 */
const SHEET_OPEN_W = 7;
const SHEET_OPEN_H = 5;
const SHEET_CLOSED_W = 3;
const SHEET_CLOSED_H = 5;
const SHEET_GAP_OPEN_TO_CLOSED_PX = 3;

const SHEET_VARIANT_SLOT_W =
  SHEET_OPEN_W + SHEET_GAP_OPEN_TO_CLOSED_PX + SHEET_CLOSED_W;

const RECOLOR_ALPHA_MIN = 10;

function pointInsideRect(
  x: number,
  y: number,
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
): boolean {
  return x >= minX && x <= maxX && y >= minY && y <= maxY;
}

/**
 * Pick a world position outside the tight viewport, always offset from the flower so
 * vertical position stays near the blossom (camera-edge fallbacks alone can pick sky).
 */
function pickSpawnOffTightView(
  flowerX: number,
  flowerY: number,
  tightMinWX: number,
  tightMaxWX: number,
  tightMinWY: number,
  tightMaxWY: number,
  rng: () => number,
): { x: number; y: number } {
  const outsideTight = (x: number, y: number): boolean =>
    !pointInsideRect(x, y, tightMinWX, tightMaxWX, tightMinWY, tightMaxWY);

  for (let n = 0; n < 96; n++) {
    const ang = rng() * Math.PI * 2;
    const dist = 48 + rng() * 620;
    const x = flowerX + Math.cos(ang) * dist;
    const y = flowerY + Math.sin(ang) * dist;
    if (outsideTight(x, y)) {
      return { x, y };
    }
  }

  for (let d = 40; d <= 800; d += 28) {
    for (let k = 0; k < 32; k++) {
      const ang = (k / 32) * Math.PI * 2;
      const x = flowerX + Math.cos(ang) * d;
      const y = flowerY + Math.sin(ang) * d;
      if (outsideTight(x, y)) {
        return { x, y };
      }
    }
  }

  const vJitter = (): number => (rng() - 0.5) * BLOCK_SIZE * 5;
  for (let n = 0; n < 32; n++) {
    const sign = rng() < 0.5 ? -1 : 1;
    const padH = 48 + rng() * 220;
    const x =
      sign < 0 ? tightMinWX - padH : tightMaxWX + padH;
    const y = flowerY + vJitter();
    if (outsideTight(x, y)) {
      return { x, y };
    }
  }

  for (let n = 0; n < 24; n++) {
    const sign = rng() < 0.5 ? -1 : 1;
    const x = flowerX + sign * (320 + rng() * BLOCK_SIZE * 14);
    const y = flowerY + (rng() - 0.5) * BLOCK_SIZE * 4;
    if (outsideTight(x, y)) {
      return { x, y };
    }
  }

  return {
    x: flowerX + (rng() < 0.5 ? -1 : 1) * (BLOCK_SIZE * 18 + rng() * BLOCK_SIZE * 10),
    y: flowerY + (rng() - 0.5) * BLOCK_SIZE * 3,
  };
}

function publicAssetUrl(relativePath: string): string {
  const base = import.meta.env.BASE_URL;
  const path = relativePath.replace(/^\/+/, "");
  return `${base}${path}`;
}

function loadImageElement(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load image: ${url}`));
    img.src = url;
  });
}

function mixSeed(...parts: number[]): number {
  let h = 0;
  for (const p of parts) {
    h = Math.imul(h ^ p, 0x9e3779b9);
    h ^= h >>> 16;
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  return () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rgbToHsl01(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) {
    return { h: 0, s: 0, l };
  }
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  switch (max) {
    case r:
      h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
      break;
    case g:
      h = ((b - r) / d + 2) / 6;
      break;
    default:
      h = ((r - g) / d + 4) / 6;
  }
  return { h, s, l };
}

function hslToRgb01(h: number, s: number, l: number): { r: number; g: number; b: number } {
  let hh = ((h % 1) + 1) % 1;
  if (s <= 0) {
    return { r: l, g: l, b: l };
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue2rgb = (t: number): number => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 0.5) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  return {
    r: hue2rgb(hh + 1 / 3),
    g: hue2rgb(hh),
    b: hue2rgb(hh - 1 / 3),
  };
}

type BakePadOpts = {
  /** If wider/taller than source, source is drawn centered on transparent canvas. */
  padToW?: number;
  padToH?: number;
};

function bakeFrameHueShift(
  img: HTMLImageElement,
  sx: number,
  sy: number,
  fw: number,
  fh: number,
  deltaHue: number,
  pad?: BakePadOpts,
): Texture {
  const w = Math.max(1, Math.floor(fw));
  const h = Math.max(1, Math.floor(fh));
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (ctx === null) {
    throw new Error("ButterflyAmbientParticles: 2D context unavailable");
  }
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, sx, sy, w, h, 0, 0, w, h);
  const im = ctx.getImageData(0, 0, w, h);
  const px = im.data;
  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3]!;
    if (a < RECOLOR_ALPHA_MIN) {
      continue;
    }
    const hsl = rgbToHsl01(px[i]! / 255, px[i + 1]! / 255, px[i + 2]! / 255);
    const nh = (hsl.h + deltaHue) % 1;
    const o = hslToRgb01(nh, hsl.s, hsl.l);
    px[i] = Math.round(o.r * 255);
    px[i + 1] = Math.round(o.g * 255);
    px[i + 2] = Math.round(o.b * 255);
  }
  ctx.putImageData(im, 0, 0);

  const tw = pad?.padToW ?? w;
  const th = pad?.padToH ?? h;
  if (tw === w && th === h) {
    const source = TextureSource.from(c);
    source.scaleMode = "nearest";
    return new Texture({ source });
  }

  const pc = document.createElement("canvas");
  pc.width = Math.max(w, tw);
  pc.height = Math.max(h, th);
  const pCtx = pc.getContext("2d", { willReadFrequently: true });
  if (pCtx === null) {
    throw new Error("ButterflyAmbientParticles: 2D context unavailable");
  }
  pCtx.imageSmoothingEnabled = false;
  pCtx.clearRect(0, 0, pc.width, pc.height);
  const ox = Math.floor((pc.width - w) / 2);
  const oy = Math.floor((pc.height - h) / 2);
  pCtx.drawImage(c, ox, oy);
  const source = TextureSource.from(pc);
  source.scaleMode = "nearest";
  return new Texture({ source });
}

type ButterflyParticle = {
  sprite: Sprite;
  frames: readonly [Texture, Texture];
  x: number;
  y: number;
  vx: number;
  vy: number;
  secondsOffScreen: number;
  flapAccum: number;
  nextImpulseT: number;
  wanderT: number;
  wanderP0: number;
  wanderP1: number;
  /** Off-screen spawns are ignored for despawn until the butterfly has been on-camera once. */
  hasEnteredTightView: boolean;
  /** Pixi Y at spawn; {@link BUTTERFLY_MAX_RISE_BLOCKS} limits how far negative Y may go from here. */
  spawnYPixi: number;
};

const butterflySpritePool = new ObjectPool<Sprite>(
  () => new Sprite(),
  (s) => {
    s.visible = false;
    s.removeFromParent();
  },
  0,
  64,
);

export class ButterflyAmbientParticles {
  private readonly root: Container;
  private readonly particles: ButterflyParticle[] = [];
  private readonly flowerIds: ReadonlySet<number>;
  private readonly huePairCache = new Map<string, readonly [Texture, Texture]>();
  private readonly hueInsertOrder: string[] = [];
  private readonly solidScratch: AABB[] = [];
  private spawnSeq = 0;
  private updateSeq = 0;
  private ready = false;
  private sheetImg: HTMLImageElement | null = null;
  /** Pixels between variant strips; set in {@link init} from sheet width. */
  private sheetGapBetweenVariantsPx = 0;

  constructor(
    private readonly worldSeed: number,
    private readonly world: World,
    registry: BlockRegistry,
    pipeline: RenderPipeline,
  ) {
    this.root = new Container();
    this.root.label = "butterflyAmbient";
    pipeline.layerParticles.addChild(this.root);

    const ids = new Set<number>();
    for (const id of FLOWER_IDENTIFIERS) {
      ids.add(registry.getByIdentifier(id).id);
    }
    this.flowerIds = ids;
  }

  async init(): Promise<void> {
    let img: HTMLImageElement;
    try {
      img = await loadImageElement(publicAssetUrl(SHEET_PATH));
    } catch {
      this.ready = false;
      return;
    }
    const tw = img.naturalWidth;
    const th = img.naturalHeight;
    const slotW = SHEET_VARIANT_SLOT_W;
    const gapSpace = tw - VARIANT_COUNT * slotW;
    const nBetween = VARIANT_COUNT - 1;
    if (
      th < SHEET_OPEN_H ||
      gapSpace < 0 ||
      gapSpace % nBetween !== 0
    ) {
      this.ready = false;
      return;
    }
    this.sheetGapBetweenVariantsPx = gapSpace / nBetween;
    this.sheetImg = img;
    this.ready = true;
  }

  private variantStripOriginX(variant: number): number {
    return (
      variant *
      (SHEET_VARIANT_SLOT_W + this.sheetGapBetweenVariantsPx)
    );
  }

  update(
    dtSec: number,
    _playerWorldX: number,
    playerFeetUpY: number,
    camera: Camera,
    screenW: number,
    screenH: number,
  ): void {
    if (!this.ready || this.sheetImg === null) {
      return;
    }

    this.updateSeq = (this.updateSeq + 1) >>> 0;

    const z = camera.getZoom();
    const marginWorld = BUTTERFLY_VIEW_MARGIN_SCREEN_PX / Math.max(z, 0.0001);
    const c0 = camera.screenToWorld(0, 0);
    const c1 = camera.screenToWorld(screenW, 0);
    const c2 = camera.screenToWorld(0, screenH);
    const c3 = camera.screenToWorld(screenW, screenH);
    const tightMinWX = Math.min(c0.x, c1.x, c2.x, c3.x);
    const tightMaxWX = Math.max(c0.x, c1.x, c2.x, c3.x);
    const tightMinWY = Math.min(c0.y, c1.y, c2.y, c3.y);
    const tightMaxWY = Math.max(c0.y, c1.y, c2.y, c3.y);
    const minWX = tightMinWX - marginWorld;
    const maxWX = tightMaxWX + marginWorld;
    const minWY = tightMinWY - marginWorld;
    const maxWY = tightMaxWY + marginWorld;

    const damp = Math.exp(-BUTTERFLY_VEL_DAMP_PER_SEC * dtSec);
    const maxSp = BUTTERFLY_MAX_SPEED;

    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i]!;
      p.flapAccum += dtSec;
      const fi = Math.floor(p.flapAccum / BUTTERFLY_FLAP_SEC) % 2;
      p.sprite.texture = p.frames[fi]!;

      p.nextImpulseT -= dtSec;
      if (p.nextImpulseT <= 0) {
        const rng = mulberry32(
          mixSeed(
            this.worldSeed,
            Math.floor(p.x * 10),
            Math.floor(p.y * 10),
            i,
            this.updateSeq,
            0xb7e7,
          ),
        );
        p.nextImpulseT = 0.25 + rng() * 0.55;
        const ax = (rng() - 0.5) * BUTTERFLY_WANDER_ACCEL;
        const ay = (rng() - 0.5) * BUTTERFLY_WANDER_ACCEL;
        p.vx += ax * dtSec;
        p.vy += ay * dtSec;
      }

      p.vx *= damp;
      p.vy *= damp;

      p.wanderT += dtSec;
      p.vx +=
        Math.sin(p.wanderT * 1.22 + p.wanderP0) *
        BUTTERFLY_WANDER_SINE_STRENGTH *
        dtSec;
      p.vy +=
        Math.cos(p.wanderT * 0.91 + p.wanderP1) *
        BUTTERFLY_WANDER_SINE_STRENGTH *
        dtSec;

      const sp = Math.hypot(p.vx, p.vy);
      if (sp > maxSp) {
        const k = maxSp / sp;
        p.vx *= k;
        p.vy *= k;
      }

      const bw = SHEET_OPEN_W;
      const bh = SHEET_OPEN_H;
      const mover = createAABB(p.x - bw * 0.5, p.y - bh * 0.5, bw, bh);
      const dx = p.vx * dtSec;
      const dy = p.vy * dtSec;
      const pad = 2;
      const query = createAABB(
        Math.min(mover.x, mover.x + dx) - pad,
        Math.min(mover.y, mover.y + dy) - pad,
        Math.abs(dx) + mover.width + pad * 2,
        Math.abs(dy) + mover.height + pad * 2,
      );
      getSolidAABBs(this.world, query, this.solidScratch);
      const { hitX, hitY } = sweepAABB(mover, dx, dy, this.solidScratch);
      p.x = mover.x + bw * 0.5;
      p.y = mover.y + bh * 0.5;
      if (hitX) {
        p.vx = 0;
      }
      if (hitY) {
        p.vy = 0;
      }

      const minYPixi =
        p.spawnYPixi - BUTTERFLY_MAX_RISE_BLOCKS * BLOCK_SIZE;
      if (p.y < minYPixi) {
        p.y = minYPixi;
        if (p.vy < 0) {
          p.vy *= 0.2;
        }
      }

      p.sprite.position.set(p.x, p.y);

      const inTight = pointInsideRect(
        p.x,
        p.y,
        tightMinWX,
        tightMaxWX,
        tightMinWY,
        tightMaxWY,
      );
      if (inTight) {
        p.hasEnteredTightView = true;
      }

      const inLoose = pointInsideRect(
        p.x,
        p.y,
        minWX,
        maxWX,
        minWY,
        maxWY,
      );
      if (!p.hasEnteredTightView || inLoose) {
        p.secondsOffScreen = 0;
      } else {
        p.secondsOffScreen += dtSec;
        if (p.secondsOffScreen >= BUTTERFLY_OFFSCREEN_DESPAWN_SEC) {
          this.recycleParticle(i);
        }
      }
    }

    this.cullExcessOnscreen(
      tightMinWX,
      tightMaxWX,
      tightMinWY,
      tightMaxWY,
    );

    let onTightForSpawn = 0;
    for (const p of this.particles) {
      if (
        pointInsideRect(
          p.x,
          p.y,
          tightMinWX,
          tightMaxWX,
          tightMinWY,
          tightMaxWY,
        )
      ) {
        onTightForSpawn += 1;
      }
    }
    if (onTightForSpawn >= BUTTERFLY_MAX_ONSCREEN) {
      return;
    }

    const room = BUTTERFLY_MAX_PARTICLES - this.particles.length;
    if (room <= 0) {
      return;
    }

    const { cx: pcx, cy: pcy } = worldToChunk(
      Math.floor(_playerWorldX / BLOCK_SIZE),
      Math.floor(playerFeetUpY / BLOCK_SIZE),
    );

    const candidates = this.chunksNear(pcx, pcy);
    if (candidates.length === 0) {
      return;
    }

    const poolNear: [number, number][] = [];
    for (const c of candidates) {
      if (
        Math.abs(c[0] - pcx) <= BUTTERFLY_SPAWN_POOL_CHEB &&
        Math.abs(c[1] - pcy) <= BUTTERFLY_SPAWN_POOL_CHEB
      ) {
        poolNear.push(c);
      }
    }
    const chunkPool = poolNear.length > 0 ? poolNear : candidates;

    let spawned = 0;
    for (
      let t = 0;
      t < BUTTERFLY_SPAWN_TRIES_PER_TICK && spawned < room;
      t++
    ) {
      const rng = mulberry32(
        mixSeed(this.worldSeed, pcx, pcy, this.spawnSeq++, 0xb077, t),
      );
      const pick = chunkPool[Math.floor(rng() * chunkPool.length)]!;

      let wx = 0;
      let wy = 0;
      let foundFlower = false;
      for (let s = 0; s < BUTTERFLY_FLOWER_LOCATE_SAMPLES; s++) {
        const lx = Math.floor(rng() * CHUNK_SIZE);
        const ly = Math.floor(rng() * CHUNK_SIZE);
        wx = pick[0] * CHUNK_SIZE + lx;
        wy = pick[1] * CHUNK_SIZE + ly;
        const b = this.world.getBlock(wx, wy);
        if (this.flowerIds.has(b.id)) {
          foundFlower = true;
          break;
        }
      }
      if (!foundFlower) {
        continue;
      }
      if (rng() > BUTTERFLY_SPAWN_CHANCE) {
        continue;
      }

      const here = this.world.getBlock(wx, wy);
      if (!this.flowerIds.has(here.id)) {
        continue;
      }

      const variant = Math.floor(rng() * VARIANT_COUNT);
      const bucket = Math.floor(rng() * BUTTERFLY_HUE_BUCKETS);
      const deltaHue = bucket / BUTTERFLY_HUE_BUCKETS;
      const frames = this.getHuePairTextures(variant, bucket, deltaHue);

      const footOff = here.plantFootOffsetPx ?? 0;
      const feetY =
        (wy + 1) * BLOCK_SIZE -
        3 -
        rng() * (5 + footOff * 0.3);
      const flowerX = wx * BLOCK_SIZE + BLOCK_SIZE * 0.5;
      const flowerY = -feetY;

      let spawnX = flowerX;
      let spawnY = flowerY;
      let foundClearSpawn = false;
      for (let att = 0; att < 20; att++) {
        const spawnRng = mulberry32(
          mixSeed(
            this.worldSeed,
            wx,
            wy,
            this.spawnSeq,
            0x5b00d,
            t,
            att,
          ),
        );
        const c = pickSpawnOffTightView(
          flowerX,
          flowerY,
          tightMinWX,
          tightMaxWX,
          tightMinWY,
          tightMaxWY,
          spawnRng,
        );
        if (!this.butterflyCenterOverlapsSolid(c.x, c.y)) {
          spawnX = c.x;
          spawnY = c.y;
          foundClearSpawn = true;
          break;
        }
      }
      if (!foundClearSpawn) {
        continue;
      }

      const sprite = butterflySpritePool.acquire();
      sprite.texture = frames[0]!;
      sprite.anchor.set(0.5, 0.5);
      sprite.roundPixels = true;
      sprite.visible = true;
      sprite.alpha = 1;
      sprite.scale.set(BUTTERFLY_SCALE);
      sprite.position.set(spawnX, spawnY);

      const dx = spawnX - flowerX;
      const dy = spawnY - flowerY;
      const dist = Math.hypot(dx, dy) || 1;
      const tx = -dy / dist;
      const ty = dx / dist;
      const cruise = 14 + rng() * 22;
      const vx = tx * cruise + (rng() - 0.5) * 26;
      const vy = ty * cruise + (rng() - 0.5) * 26;

      this.root.addChild(sprite);
      this.particles.push({
        sprite,
        frames,
        x: spawnX,
        y: spawnY,
        vx,
        vy,
        secondsOffScreen: 0,
        flapAccum: rng() * BUTTERFLY_FLAP_SEC * 2,
        nextImpulseT: rng() * 0.4,
        wanderT: rng() * 12.56,
        wanderP0: rng() * 12.56,
        wanderP1: rng() * 12.56,
        hasEnteredTightView: false,
        spawnYPixi: spawnY,
      });
      spawned += 1;
    }
  }

  private getHuePairTextures(
    variant: number,
    bucket: number,
    deltaHue: number,
  ): readonly [Texture, Texture] {
    const key = `${variant}_${bucket}`;
    const hit = this.huePairCache.get(key);
    if (hit !== undefined) {
      return hit;
    }

    const img = this.sheetImg!;
    const ox = this.variantStripOriginX(variant);
    const closedSx =
      ox + SHEET_OPEN_W + SHEET_GAP_OPEN_TO_CLOSED_PX;

    while (this.huePairCache.size >= BUTTERFLY_HUE_CACHE_MAX) {
      const oldest = this.hueInsertOrder.shift();
      if (oldest === undefined) {
        break;
      }
      const pair = this.huePairCache.get(oldest);
      if (pair !== undefined) {
        pair[0].destroy(true);
        pair[1].destroy(true);
        this.huePairCache.delete(oldest);
      }
    }

    const a = bakeFrameHueShift(
      img,
      ox,
      0,
      SHEET_OPEN_W,
      SHEET_OPEN_H,
      deltaHue,
    );
    const b = bakeFrameHueShift(
      img,
      closedSx,
      0,
      SHEET_CLOSED_W,
      SHEET_CLOSED_H,
      deltaHue,
      { padToW: SHEET_OPEN_W, padToH: SHEET_OPEN_H },
    );
    const tuple: readonly [Texture, Texture] = [a, b];
    this.huePairCache.set(key, tuple);
    this.hueInsertOrder.push(key);
    return tuple;
  }

  /** True if the butterfly hitbox (open-frame size) at center overlaps any collidable solid. */
  private butterflyCenterOverlapsSolid(cx: number, cyPixi: number): boolean {
    const bw = SHEET_OPEN_W;
    const bh = SHEET_OPEN_H;
    const mover = createAABB(cx - bw * 0.5, cyPixi - bh * 0.5, bw, bh);
    const pad = 2;
    const q = createAABB(
      mover.x - pad,
      mover.y - pad,
      mover.width + pad * 2,
      mover.height + pad * 2,
    );
    getSolidAABBs(this.world, q, this.solidScratch);
    for (const s of this.solidScratch) {
      if (overlaps(mover, s)) {
        return true;
      }
    }
    return false;
  }

  private chunksNear(pcx: number, pcy: number): [number, number][] {
    const out: [number, number][] = [];
    for (const [cx, cy] of this.world.loadedChunkCoords()) {
      const d = Math.max(Math.abs(cx - pcx), Math.abs(cy - pcy));
      if (d <= BUTTERFLY_SPAWN_CHUNK_RADIUS) {
        out.push([cx, cy]);
      }
    }
    return out;
  }

  /** If more than {@link BUTTERFLY_MAX_ONSCREEN} overlap the tight view, recycle extras. */
  private cullExcessOnscreen(
    tightMinWX: number,
    tightMaxWX: number,
    tightMinWY: number,
    tightMaxWY: number,
  ): void {
    while (true) {
      let count = 0;
      let victim = -1;
      for (let i = 0; i < this.particles.length; i++) {
        const p = this.particles[i]!;
        if (
          pointInsideRect(
            p.x,
            p.y,
            tightMinWX,
            tightMaxWX,
            tightMinWY,
            tightMaxWY,
          )
        ) {
          count += 1;
          victim = i;
        }
      }
      if (count <= BUTTERFLY_MAX_ONSCREEN || victim < 0) {
        return;
      }
      this.recycleParticle(victim);
    }
  }

  private recycleParticle(index: number): void {
    const p = this.particles[index]!;
    butterflySpritePool.release(p.sprite);
    this.particles[index] = this.particles[this.particles.length - 1]!;
    this.particles.pop();
  }

  destroy(): void {
    for (const p of this.particles) {
      butterflySpritePool.release(p.sprite);
    }
    this.particles.length = 0;
    for (const [a, b] of this.huePairCache.values()) {
      a.destroy(true);
      b.destroy(true);
    }
    this.huePairCache.clear();
    this.hueInsertOrder.length = 0;
    this.ready = false;
    this.sheetImg = null;
    this.root.parent?.removeChild(this.root);
    this.root.destroy({ children: false });
  }
}
