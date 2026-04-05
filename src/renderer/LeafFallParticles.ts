/**
 * Subtle ambient leaf fall from canopy tiles: hue-matched to oak / spruce / birch leaves,
 * slow swaying fall, fade near non-leaf ground. Client-side only.
 */
import { Container, Rectangle, Sprite, Texture, TextureSource } from "pixi.js";
import {
  BLOCK_SIZE,
  CHUNK_SIZE,
  FIXED_HZ,
  ITEM_GRAVITY,
  LEAF_FALL_AIR_DRAG,
  LEAF_FALL_DESPAWN_CLEARANCE_PX,
  LEAF_FALL_FRAME_COUNT,
  LEAF_FALL_GRAVITY_MUL,
  LEAF_FALL_GROUND_FADE_PX,
  LEAF_FALL_INTERIOR_LEAF_FRACTION,
  LEAF_FALL_MAX_LIFETIME_SEC,
  LEAF_FALL_MAX_PARTICLES,
  LEAF_FALL_SPAWN_CHANCE,
  LEAF_FALL_SPAWN_CHUNK_RADIUS,
  LEAF_FALL_SPAWN_TRIES_PER_TICK,
  LEAF_FALL_SWAY_AMP_PX,
  LEAF_FALL_SWAY_OMEGA,
  WORLD_Y_MIN,
} from "../core/constants";
import type { BlockRegistry } from "../world/blocks/BlockRegistry";
import type { World } from "../world/World";
import { worldToChunk } from "../world/chunk/ChunkCoord";
import type { AtlasLoader } from "./AtlasLoader";
import type { RenderPipeline } from "./RenderPipeline";

const LEAF_SPECIES: readonly {
  identifier: string;
  atlasHueKey: string;
}[] = [
  { identifier: "stratum:oak_leaves", atlasHueKey: "oak_leaves" },
  { identifier: "stratum:spruce_leaves", atlasHueKey: "spruce_leaves" },
  { identifier: "stratum:birch_leaves", atlasHueKey: "birch_leaves" },
];

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

function smoothstep01(x: number): number {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
}

/** Match {@link AtlasLoader} sampling threshold. */
const RECOLOR_ALPHA_MIN = 10;

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

/**
 * Per-pixel recolor: map particle toward leaf block average hue/sat and scale lightness so
 * bright particle art matches leaf darkness (hue-rotate alone keeps highlights neon).
 */
function bakeLeafRegionRecolor(
  atlasCanvas: HTMLCanvasElement,
  fr: Rectangle,
  baseHsl: { h: number; s: number; l: number },
  leafHsl: { h: number; s: number; l: number },
): Texture {
  const w = Math.max(1, Math.floor(fr.width));
  const h = Math.max(1, Math.floor(fr.height));
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (ctx === null) {
    throw new Error("LeafFallParticles: 2D context unavailable");
  }
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(atlasCanvas, fr.x, fr.y, w, h, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  const px = img.data;

  const baseL = Math.max(baseHsl.l, 0.1);
  const leafL = Math.max(leafHsl.l, 0.06);
  const lRatio = leafL / baseL;
  const leafHue = leafHsl.h;
  const leafSat = leafHsl.s;
  const useLeafHue = leafSat >= 0.04;

  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3]!;
    if (a < RECOLOR_ALPHA_MIN) {
      continue;
    }
    const hsl = rgbToHsl01(px[i]! / 255, px[i + 1]! / 255, px[i + 2]! / 255);
    const newH = useLeafHue ? leafHue : hsl.h;
    const newS = hsl.s + (leafSat - hsl.s) * 0.88;
    const newL = Math.min(1, Math.max(0, hsl.l * lRatio));
    const o = hslToRgb01(newH, Math.min(1, Math.max(0, newS)), newL);
    px[i] = Math.round(o.r * 255);
    px[i + 1] = Math.round(o.g * 255);
    px[i + 2] = Math.round(o.b * 255);
  }
  ctx.putImageData(img, 0, 0);
  const source = TextureSource.from(c);
  source.scaleMode = "nearest";
  return new Texture({ source });
}

type LeafParticle = {
  sprite: Sprite;
  tex: Texture;
  x: number;
  y: number;
  vx: number;
  vy: number;
  swayT: number;
  swayOmega: number;
  swayPhase: number;
  swayAmp: number;
  rotVel: number;
  life: number;
  /** World block row of the leaf we fell from — ignore closer “ground” (log/trunk) for fade. */
  spawnLeafRow: number;
};

export class LeafFallParticles {
  private readonly root: Container;
  private readonly particles: LeafParticle[] = [];
  private readonly bakedByBlockId = new Map<number, Texture[]>();
  private readonly leafIds: ReadonlySet<number>;
  private spawnSeq = 0;
  private ready = false;

  constructor(
    private readonly worldSeed: number,
    private readonly world: World,
    private readonly registry: BlockRegistry,
    private readonly atlas: AtlasLoader,
    private readonly airBlockId: number,
    pipeline: RenderPipeline,
  ) {
    this.root = new Container();
    pipeline.layerParticles.addChild(this.root);

    const ids = new Set<number>();
    for (const s of LEAF_SPECIES) {
      ids.add(registry.getByIdentifier(s.identifier).id);
    }
    this.leafIds = ids;
  }

  /** Build leaf-matched textures (HSL remap + lightness vs block average); no-op if atlas missing. */
  init(): void {
    const canvas = this.atlas.getAtlasCanvas();
    if (canvas === null) {
      return;
    }

    const baseRgb = this.atlas.sampleAverageRgb01("leaf_0");
    const baseHsl = baseRgb
      ? rgbToHsl01(baseRgb.r, baseRgb.g, baseRgb.b)
      : { h: 0.28, s: 0.4, l: 0.5 };

    for (const spec of LEAF_SPECIES) {
      const blockId = this.registry.getByIdentifier(spec.identifier).id;
      const leafRgb =
        this.atlas.sampleAverageRgb01(spec.atlasHueKey) ?? baseRgb;
      const leafHsl = leafRgb
        ? rgbToHsl01(leafRgb.r, leafRgb.g, leafRgb.b)
        : baseHsl;
      const frames: Texture[] = [];
      for (let i = 0; i < LEAF_FALL_FRAME_COUNT; i++) {
        const srcTex = this.atlas.getTexture(`leaf_${i}`);
        frames.push(
          bakeLeafRegionRecolor(canvas, srcTex.frame, baseHsl, leafHsl),
        );
      }
      this.bakedByBlockId.set(blockId, frames);
    }
    this.ready = true;
  }

  update(dtSec: number, playerWorldX: number, playerFeetUpY: number): void {
    if (!this.ready || this.bakedByBlockId.size === 0) {
      return;
    }

    const g = ITEM_GRAVITY * BLOCK_SIZE * LEAF_FALL_GRAVITY_MUL;
    const dragPow = Math.pow(LEAF_FALL_AIR_DRAG, dtSec * FIXED_HZ);

    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i]!;
      p.life -= dtSec;

      p.vy += g * dtSec;
      p.vy *= dragPow;
      p.vx *= dragPow;
      p.x += p.vx * dtSec;
      p.y += p.vy * dtSec;
      p.swayT += dtSec;

      const sway =
        Math.sin(p.swayT * p.swayOmega + p.swayPhase) * p.swayAmp;
      p.sprite.rotation += p.rotVel * dtSec;
      p.sprite.position.set(p.x + sway, p.y);

      const feetUp = -p.y;
      const bx = Math.floor(p.x / BLOCK_SIZE);
      const groundTop = this.findNonLeafGroundTopFeetUp(
        bx,
        feetUp,
        p.spawnLeafRow,
      );

      let alpha = 1;
      if (groundTop !== null) {
        const clearance = feetUp - groundTop;
        if (clearance <= LEAF_FALL_DESPAWN_CLEARANCE_PX) {
          this.recycleParticle(i);
          continue;
        }
        alpha *= smoothstep01(clearance / LEAF_FALL_GROUND_FADE_PX);
      }

      if (p.life <= 0 || alpha < 0.02) {
        this.recycleParticle(i);
        continue;
      }

      p.sprite.alpha = alpha;
    }

    const room = LEAF_FALL_MAX_PARTICLES - this.particles.length;
    if (room <= 0) {
      return;
    }

    const { cx: pcx, cy: pcy } = worldToChunk(
      Math.floor(playerWorldX / BLOCK_SIZE),
      Math.floor(playerFeetUpY / BLOCK_SIZE),
    );

    const candidates = this.chunksNear(pcx, pcy);
    if (candidates.length === 0) {
      return;
    }

    let spawned = 0;
    for (let t = 0; t < LEAF_FALL_SPAWN_TRIES_PER_TICK && spawned < room; t++) {
      const rng = mulberry32(
        mixSeed(
          this.worldSeed,
          pcx,
          pcy,
          this.spawnSeq++,
          0x1eaf,
          t,
        ),
      );
      const pick = candidates[Math.floor(rng() * candidates.length)]!;
      const lx = Math.floor(rng() * CHUNK_SIZE);
      const ly = Math.floor(rng() * CHUNK_SIZE);
      const wx = pick[0] * CHUNK_SIZE + lx;
      const wy = pick[1] * CHUNK_SIZE + ly;

      const here = this.world.getBlock(wx, wy);
      if (!this.leafIds.has(here.id)) {
        continue;
      }
      const allowInterior = rng() < LEAF_FALL_INTERIOR_LEAF_FRACTION;
      if (!allowInterior) {
        // Larger wy is up; toward ground is wy - 1 (skip interior stack of leaves).
        const towardGround = this.world.getBlock(wx, wy - 1);
        if (this.leafIds.has(towardGround.id)) {
          continue;
        }
      }
      if (rng() > LEAF_FALL_SPAWN_CHANCE) {
        continue;
      }

      const frames = this.bakedByBlockId.get(here.id);
      if (frames === undefined) {
        continue;
      }

      const fi = Math.floor(rng() * LEAF_FALL_FRAME_COUNT);
      const tex = frames[fi]!;
      // Spawn from upper/mid canopy so the first visible motion isn’t clipped by the trunk row.
      const feetY =
        wy * BLOCK_SIZE +
        BLOCK_SIZE * 0.25 +
        rng() * (BLOCK_SIZE * 0.65);
      const worldX = wx * BLOCK_SIZE + rng() * BLOCK_SIZE;
      const pixiY = -feetY;

      const sprite = new Sprite(tex);
      sprite.anchor.set(0.5, 0.5);
      sprite.roundPixels = true;
      sprite.position.set(worldX, pixiY);
      sprite.alpha = 1;

      this.root.addChild(sprite);
      this.particles.push({
        sprite,
        tex,
        x: worldX,
        y: pixiY,
        vx: (rng() - 0.5) * 14,
        vy: -rng() * 9,
        swayT: rng() * 6.28,
        swayOmega: LEAF_FALL_SWAY_OMEGA * (0.75 + rng() * 0.55),
        swayPhase: rng() * 6.28,
        swayAmp: LEAF_FALL_SWAY_AMP_PX * (0.55 + rng() * 0.65),
        rotVel: (rng() - 0.5) * 1.1,
        life: LEAF_FALL_MAX_LIFETIME_SEC,
        spawnLeafRow: wy,
      });
      spawned += 1;
    }
  }

  private chunksNear(pcx: number, pcy: number): [number, number][] {
    const out: [number, number][] = [];
    for (const [cx, cy] of this.world.loadedChunkCoords()) {
      const d = Math.max(Math.abs(cx - pcx), Math.abs(cy - pcy));
      if (d <= LEAF_FALL_SPAWN_CHUNK_RADIUS) {
        out.push([cx, cy]);
      }
    }
    return out;
  }

  /**
   * Feet-up Y of the top face of the highest relevant non-leaf collider strictly below `feetUp`.
   * Skips rows above `spawnLeafRow - 2` so the trunk under the canopy is not “ground” for fade.
   */
  private findNonLeafGroundTopFeetUp(
    bx: number,
    feetUp: number,
    spawnLeafRow: number,
  ): number | null {
    const particleRow = Math.floor(feetUp / BLOCK_SIZE);
    const maxRowExclusive = spawnLeafRow - 2;
    for (let w = particleRow; w >= WORLD_Y_MIN; w--) {
      if (w > maxRowExclusive) {
        continue;
      }
      const b = this.world.getBlock(bx, w);
      if (b.id === this.airBlockId || this.leafIds.has(b.id)) {
        continue;
      }
      if (!b.collides) {
        continue;
      }
      const topY = (w + 1) * BLOCK_SIZE;
      if (topY < feetUp) {
        return topY;
      }
    }
    return null;
  }

  private recycleParticle(index: number): void {
    const p = this.particles[index]!;
    this.root.removeChild(p.sprite);
    p.sprite.destroy({ texture: false });
    this.particles.splice(index, 1);
  }

  destroy(): void {
    for (const p of this.particles) {
      this.root.removeChild(p.sprite);
      p.sprite.destroy({ texture: false });
    }
    this.particles.length = 0;
    for (const frames of this.bakedByBlockId.values()) {
      for (const t of frames) {
        t.destroy(true);
      }
    }
    this.bakedByBlockId.clear();
    this.ready = false;
    this.root.parent?.removeChild(this.root);
    this.root.destroy({ children: false });
  }
}
