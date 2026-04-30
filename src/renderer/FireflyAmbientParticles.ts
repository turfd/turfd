/**
 * Ambient fireflies near water-adjacent ground.
 * Rendered as tiny 2x2 pixel dots; bloom/lighting handles glow.
 */
import { Container, Sprite, Texture, TextureSource } from "pixi.js";
import {
  BLOCK_SIZE,
  CHUNK_SIZE,
  FIREFLY_GROUND_LOCATE_SAMPLES,
  FIREFLY_LIGHT_BLOOM_OFFSET_SCREEN_PX,
  FIREFLY_LIGHT_MAX_EMITTERS,
  FIREFLY_LIGHT_STRENGTH,
  FIREFLY_MAX_ONSCREEN,
  FIREFLY_MAX_PARTICLES,
  FIREFLY_MAX_RISE_BLOCKS,
  FIREFLY_MAX_SPEED,
  FIREFLY_MIN_WATER_DISTANCE_BLOCKS,
  FIREFLY_NEAR_WATER_RADIUS_BLOCKS,
  FIREFLY_OFFSCREEN_DESPAWN_SEC,
  FIREFLY_SPAWN_CHANCE,
  FIREFLY_SPAWN_CHUNK_RADIUS,
  FIREFLY_SPAWN_POOL_CHEB,
  FIREFLY_SPAWN_TRIES_PER_TICK,
  FIREFLY_VEL_DAMP_PER_SEC,
  FIREFLY_VIEW_MARGIN_SCREEN_PX,
  FIREFLY_WANDER_ACCEL,
  FIREFLY_WANDER_SINE_STRENGTH,
} from "../core/constants";
import type { DynamicLightEmitter } from "../core/types";
import {
  createAABB,
  overlaps,
  sweepAABB,
  type AABB,
} from "../entities/physics/AABB";
import { getSolidAABBs } from "../entities/physics/Collision";
import { ObjectPool } from "../utils/pool";
import type { World } from "../world/World";
import type { Camera } from "./Camera";
import type { RenderPipeline } from "./RenderPipeline";

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

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

type FireflyParticle = {
  sprite: Sprite;
  x: number;
  y: number;
  vx: number;
  vy: number;
  secondsOffScreen: number;
  hasEnteredTightView: boolean;
  spawnYPixi: number;
  nextImpulseT: number;
  wanderT: number;
  wanderP0: number;
  wanderP1: number;
  flickerT: number;
  flickerPhase: number;
  brightness: number;
};

const FIREFLY_SIZE_PX = 2;
const MIN_FIREFLY_SPACING_PX = BLOCK_SIZE * 3;

const fireflySpritePool = new ObjectPool<Sprite>(
  () => new Sprite(),
  (s) => {
    s.visible = false;
    s.removeFromParent();
  },
  0,
  32,
);

let fireflyTextureBank: Texture[] | null = null;

function makeFireflyTexture(seed: number): Texture {
  const rng = mulberry32(seed);
  const c = document.createElement("canvas");
  c.width = FIREFLY_SIZE_PX;
  c.height = FIREFLY_SIZE_PX;
  const ctx = c.getContext("2d");
  if (ctx === null) {
    throw new Error("FireflyAmbientParticles: 2D context unavailable");
  }
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, FIREFLY_SIZE_PX, FIREFLY_SIZE_PX);

  for (let y = 0; y < FIREFLY_SIZE_PX; y++) {
    for (let x = 0; x < FIREFLY_SIZE_PX; x++) {
      const r = 245 + Math.floor(rng() * 10);
      const g = 218 + Math.floor(rng() * 22);
      const b = 74 + Math.floor(rng() * 16);
      ctx.fillStyle = `rgba(${r},${g},${b},1)`;
      ctx.fillRect(x, y, 1, 1);
    }
  }

  const source = TextureSource.from(c);
  source.scaleMode = "nearest";
  return new Texture({ source });
}

function getFireflyTextureBank(): Texture[] {
  if (fireflyTextureBank !== null) {
    return fireflyTextureBank;
  }
  fireflyTextureBank = [
    makeFireflyTexture(0x1001),
    makeFireflyTexture(0x1002),
    makeFireflyTexture(0x1003),
  ];
  return fireflyTextureBank;
}

/**
 * Pack (wx, wy) into a unique Number key for per-tick caches.
 * Safe for |wx|,|wy| up to ~1e6 (far exceeds FIREFLY spawn radius in practice).
 */
function packWxWyKey(wx: number, wy: number): number {
  return ((wx + 1_048_576) * 2_097_152) + (wy + 1_048_576);
}

/** Spawn search runs at most every N fixed/render ticks (cheap throttle). */
const FIREFLY_SPAWN_SEARCH_EVERY_N_TICKS = 2;
/** If we recently ran a long frame, further reduce spawn work to recover. */
const FIREFLY_HEAVY_FRAME_DT_SEC = 1 / 45;
/** Refresh the cached near-player chunk list at least this often (ticks). */
const FIREFLY_NEIGHBOR_CHUNKS_REFRESH_TICKS = 30;

export class FireflyAmbientParticles {
  private readonly root: Container;
  private readonly particles: FireflyParticle[] = [];
  private readonly solidScratch: AABB[] = [];
  private spawnSeq = 0;
  private updateSeq = 0;

  /** Per-tick nearest-water result cache keyed by packed (wx, wy). Value -1 = no water. */
  private readonly _nearestWaterCache = new Map<number, number>();
  /** Reused by spawn pool filtering to avoid reallocations each tick. */
  private readonly _poolNearScratch: [number, number][] = [];
  private readonly _poolVisibleScratch: [number, number][] = [];
  /** Best-N scratch for dynamic light emitter ranking (no full sort). */
  private readonly _emitterCandidateIdx: number[] = [];
  private readonly _emitterCandidateD2: number[] = [];

  /** Cached near-player chunk list; invalidated on player-chunk crossing or periodic refresh. */
  private readonly _neighborChunkList: [number, number][] = [];
  private _neighborChunkPcx: number | null = null;
  private _neighborChunkPcy: number | null = null;
  private _neighborChunkRefreshAt = 0;

  constructor(
    private readonly worldSeed: number,
    private readonly world: World,
    pipeline: RenderPipeline,
  ) {
    this.root = new Container();
    this.root.label = "fireflyAmbient";
    pipeline.layerParticles.addChild(this.root);
  }

  update(
    dtSec: number,
    playerWorldX: number,
    playerFeetUpY: number,
    camera: Camera,
    screenW: number,
    screenH: number,
    nightActive: boolean,
  ): void {
    if (!nightActive) {
      this.clearParticles();
      return;
    }
    this.updateSeq = (this.updateSeq + 1) >>> 0;
    // Nearest-water results are derived from current block state; invalidate each tick so
    // block changes propagate, but they remain valid across the multiple spawn attempts
    // inside this single update() call.
    this._nearestWaterCache.clear();

    const z = camera.getZoom();
    const marginWorld = FIREFLY_VIEW_MARGIN_SCREEN_PX / Math.max(z, 0.0001);
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

    this.updateExistingParticles(
      dtSec,
      tightMinWX,
      tightMaxWX,
      tightMinWY,
      tightMaxWY,
      minWX,
      maxWX,
      minWY,
      maxWY,
    );
    this.cullExcessOnscreen(tightMinWX, tightMaxWX, tightMinWY, tightMaxWY);

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
    if (onTightForSpawn >= FIREFLY_MAX_ONSCREEN) {
      return;
    }

    const room = FIREFLY_MAX_PARTICLES - this.particles.length;
    if (room <= 0) {
      return;
    }

    // Throttle the expensive spawn probe loop. Spawn is non-critical; running
    // every N ticks still produces steady firefly density because FIREFLY_MAX_PARTICLES
    // is small and updated particles are sticky (several seconds on-screen).
    if (this.updateSeq % FIREFLY_SPAWN_SEARCH_EVERY_N_TICKS !== 0) {
      return;
    }

    const playerBy = Math.floor(playerFeetUpY / BLOCK_SIZE);
    const pcx = Math.floor(playerWorldX / BLOCK_SIZE / CHUNK_SIZE);
    const pcy = Math.floor(playerFeetUpY / BLOCK_SIZE / CHUNK_SIZE);
    const candidates = this.getNeighborChunks(pcx, pcy);
    if (candidates.length === 0) {
      return;
    }

    const minViewBlockX = Math.floor(minWX / BLOCK_SIZE);
    const maxViewBlockX = Math.floor(maxWX / BLOCK_SIZE);
    const minViewChunkX = Math.floor(minViewBlockX / CHUNK_SIZE);
    const maxViewChunkX = Math.floor(maxViewBlockX / CHUNK_SIZE);

    const poolNear = this._poolNearScratch;
    const poolVisible = this._poolVisibleScratch;
    poolNear.length = 0;
    poolVisible.length = 0;
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i]!;
      const cx = c[0];
      const cy = c[1];
      const inViewX = cx >= minViewChunkX && cx <= maxViewChunkX;
      if (inViewX) {
        poolVisible.push(c);
        if (
          Math.abs(cx - pcx) <= FIREFLY_SPAWN_POOL_CHEB &&
          Math.abs(cy - pcy) <= FIREFLY_SPAWN_POOL_CHEB
        ) {
          poolNear.push(c);
        }
      }
    }
    const chunkPool =
      poolNear.length > 0
        ? poolNear
        : poolVisible.length > 0
          ? poolVisible
          : candidates;

    // Adaptive workload: when recent frame time was high, reduce spawn probing
    // so fixed tick stays inside its budget and we don't pile up on slow frames.
    const heavy = dtSec > FIREFLY_HEAVY_FRAME_DT_SEC;
    const triesThisTick = heavy
      ? Math.max(1, Math.floor(FIREFLY_SPAWN_TRIES_PER_TICK / 2))
      : FIREFLY_SPAWN_TRIES_PER_TICK;
    const samplesThisTry = heavy
      ? Math.max(3, Math.floor(FIREFLY_GROUND_LOCATE_SAMPLES / 2))
      : FIREFLY_GROUND_LOCATE_SAMPLES;

    const bank = getFireflyTextureBank();
    let spawned = 0;

    for (
      let t = 0;
      t < triesThisTick && spawned < room;
      t++
    ) {
      const rng = mulberry32(
        mixSeed(this.worldSeed, pcx, pcy, this.spawnSeq++, 0xf173f1, t),
      );
      const pick = chunkPool[Math.floor(rng() * chunkPool.length)]!;

      let wx = 0;
      let wy: number | null = null;
      for (let s = 0; s < samplesThisTry; s++) {
        const lx = Math.floor(rng() * CHUNK_SIZE);
        wx = pick[0] * CHUNK_SIZE + lx;
        wy = this.findSpawnGroundY(wx, playerBy);
        if (wy !== null) {
          break;
        }
      }
      if (wy === null || rng() > FIREFLY_SPAWN_CHANCE) {
        continue;
      }

      const px = wx * BLOCK_SIZE + BLOCK_SIZE * (0.2 + rng() * 0.6);
      const feetY = (wy + 1) * BLOCK_SIZE + (2 + rng() * 7.5);
      const py = -feetY;
      if (!pointInsideRect(px, py, minWX, maxWX, minWY, maxWY)) {
        continue;
      }
      if (this.isTooCloseToOtherFirefly(px, py, MIN_FIREFLY_SPACING_PX)) {
        continue;
      }
      if (this.fireflyCenterOverlapsSolid(px, py)) {
        continue;
      }

      const sprite = fireflySpritePool.acquire();
      sprite.texture = bank[Math.floor(rng() * bank.length)]!;
      sprite.anchor.set(0.5, 0.5);
      sprite.roundPixels = true;
      sprite.scale.set(1);
      sprite.visible = true;
      sprite.alpha = 1;
      sprite.position.set(px, py);
      sprite.blendMode = "normal";

      this.root.addChild(sprite);
      this.particles.push({
        sprite,
        x: px,
        y: py,
        vx: (rng() - 0.5) * 16,
        vy: (rng() - 0.5) * 9,
        secondsOffScreen: 0,
        hasEnteredTightView: false,
        spawnYPixi: py,
        nextImpulseT: rng() * 0.45,
        wanderT: rng() * 20,
        wanderP0: rng() * 12.56,
        wanderP1: rng() * 12.56,
        flickerT: rng() * 30,
        flickerPhase: rng() * 12.56,
        brightness: 0.8,
      });
      spawned += 1;
    }
  }

  collectDynamicLightEmitters(
    viewCenterWorldBlockX: number,
    viewCenterWorldBlockY: number,
    out: DynamicLightEmitter[],
  ): void {
    if (this.particles.length === 0) {
      return;
    }

    // Fixed-size best-N selection — keeps only the N closest candidates without
    // allocating intermediate arrays or doing a full sort. N (5) is small, so
    // insertion-sort into parallel typed-ish arrays is strictly faster than
    // filter+map+sort.
    const maxN = FIREFLY_LIGHT_MAX_EMITTERS;
    const bestIdx = this._emitterCandidateIdx;
    const bestD2 = this._emitterCandidateD2;
    bestIdx.length = 0;
    bestD2.length = 0;

    const parts = this.particles;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i]!;
      if (!p.hasEnteredTightView) {
        continue;
      }
      const wx =
        (p.x + FIREFLY_LIGHT_BLOOM_OFFSET_SCREEN_PX) / BLOCK_SIZE;
      const wy = -p.y / BLOCK_SIZE;
      const dx = wx - viewCenterWorldBlockX;
      const dy = wy - viewCenterWorldBlockY;
      const d2 = dx * dx + dy * dy;

      if (bestD2.length < maxN) {
        let j = bestD2.length;
        while (j > 0 && bestD2[j - 1]! > d2) {
          bestD2[j] = bestD2[j - 1]!;
          bestIdx[j] = bestIdx[j - 1]!;
          j--;
        }
        bestD2[j] = d2;
        bestIdx[j] = i;
      } else if (d2 < bestD2[maxN - 1]!) {
        let j = maxN - 1;
        while (j > 0 && bestD2[j - 1]! > d2) {
          bestD2[j] = bestD2[j - 1]!;
          bestIdx[j] = bestIdx[j - 1]!;
          j--;
        }
        bestD2[j] = d2;
        bestIdx[j] = i;
      }
    }

    for (let k = 0; k < bestIdx.length; k++) {
      const p = parts[bestIdx[k]!]!;
      out.push({
        worldBlockX:
          (p.x + FIREFLY_LIGHT_BLOOM_OFFSET_SCREEN_PX) / BLOCK_SIZE,
        worldBlockY: -p.y / BLOCK_SIZE,
        strength: FIREFLY_LIGHT_STRENGTH * (0.7 + p.brightness * 0.3),
        bloomTipShiftScale: 0,
      });
    }
  }

  private updateExistingParticles(
    dtSec: number,
    tightMinWX: number,
    tightMaxWX: number,
    tightMinWY: number,
    tightMaxWY: number,
    minWX: number,
    maxWX: number,
    minWY: number,
    maxWY: number,
  ): void {
    const damp = Math.exp(-FIREFLY_VEL_DAMP_PER_SEC * dtSec);
    const maxSp = FIREFLY_MAX_SPEED;
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i]!;

      p.nextImpulseT -= dtSec;
      if (p.nextImpulseT <= 0) {
        const rng = mulberry32(
          mixSeed(
            this.worldSeed,
            Math.floor(p.x * 8),
            Math.floor(p.y * 8),
            i,
            this.updateSeq,
            0xf1e5,
          ),
        );
        p.nextImpulseT = 0.2 + rng() * 0.7;
        p.vx += (rng() - 0.5) * FIREFLY_WANDER_ACCEL * dtSec;
        p.vy += (rng() - 0.5) * (FIREFLY_WANDER_ACCEL * 0.8) * dtSec;
      }

      p.vx *= damp;
      p.vy *= damp;
      p.wanderT += dtSec;
      p.vx +=
        Math.sin(p.wanderT * 1.2 + p.wanderP0) *
        FIREFLY_WANDER_SINE_STRENGTH *
        dtSec;
      p.vy +=
        Math.cos(p.wanderT * 0.9 + p.wanderP1) *
        (FIREFLY_WANDER_SINE_STRENGTH * 0.9) *
        dtSec;

      const sp = Math.hypot(p.vx, p.vy);
      if (sp > maxSp) {
        const k = maxSp / sp;
        p.vx *= k;
        p.vy *= k;
      }

      const half = FIREFLY_SIZE_PX * 0.5;
      const mover = createAABB(
        p.x - half,
        p.y - half,
        FIREFLY_SIZE_PX,
        FIREFLY_SIZE_PX,
      );
      const dx = p.vx * dtSec;
      const dy = p.vy * dtSec;
      const q = createAABB(
        Math.min(mover.x, mover.x + dx) - 2,
        Math.min(mover.y, mover.y + dy) - 2,
        Math.abs(dx) + mover.width + 4,
        Math.abs(dy) + mover.height + 4,
      );
      getSolidAABBs(this.world, q, this.solidScratch);
      const { hitX, hitY } = sweepAABB(mover, dx, dy, this.solidScratch);
      p.x = mover.x + half;
      p.y = mover.y + half;
      if (hitX) p.vx *= -0.25;
      if (hitY) p.vy *= -0.25;

      const minYPixi = p.spawnYPixi - FIREFLY_MAX_RISE_BLOCKS * BLOCK_SIZE;
      const maxYPixi = p.spawnYPixi + BLOCK_SIZE * 1.2;
      if (p.y < minYPixi) {
        p.y = minYPixi;
        if (p.vy < 0) p.vy *= 0.2;
      } else if (p.y > maxYPixi) {
        p.y = maxYPixi;
        if (p.vy > 0) p.vy *= 0.2;
      }

      p.flickerT += dtSec;
      const flicker =
        Math.sin(p.flickerT * 5.2 + p.flickerPhase) * 0.25 +
        Math.sin(p.flickerT * 9.1 + p.flickerPhase * 1.2) * 0.15;
      p.brightness = clamp01(0.8 + flicker);
      // Fade the sprite slightly too so flicker is visible even with bloom disabled.
      p.sprite.alpha = 0.72 + p.brightness * 0.24;
      p.sprite.tint =
        (0xff << 16) |
        ((222 + Math.floor(p.brightness * 20)) << 8) |
        (80 + Math.floor(p.brightness * 12));
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

      const inLoose = pointInsideRect(p.x, p.y, minWX, maxWX, minWY, maxWY);
      if (!p.hasEnteredTightView || inLoose) {
        p.secondsOffScreen = 0;
      } else {
        p.secondsOffScreen += dtSec;
        if (p.secondsOffScreen >= FIREFLY_OFFSCREEN_DESPAWN_SEC) {
          this.recycleParticle(i);
        }
      }
    }
  }

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
      if (count <= FIREFLY_MAX_ONSCREEN || victim < 0) {
        return;
      }
      this.recycleParticle(victim);
    }
  }

  private checkGroundSpawnCell(wx: number, wy: number): boolean {
    const world = this.world;
    const groundId = world.getForegroundBlockId(wx, wy);
    if (
      !world.isSolidBlockId(groundId) ||
      world.isWaterBlockId(groundId) ||
      world.isReplaceableBlockId(groundId) ||
      !world.isCollidesBlockId(groundId)
    ) {
      return false;
    }
    const headId = world.getForegroundBlockId(wx, wy + 1);
    const upperId = world.getForegroundBlockId(wx, wy + 2);
    if (
      world.isWaterBlockId(headId) ||
      world.isWaterBlockId(upperId) ||
      world.isCollidesBlockId(headId) ||
      world.isCollidesBlockId(upperId)
    ) {
      return false;
    }
    const waterDist = this.nearestWaterDistance(wx, wy);
    return (
      waterDist !== null &&
      waterDist <= FIREFLY_NEAR_WATER_RADIUS_BLOCKS &&
      waterDist >= FIREFLY_MIN_WATER_DISTANCE_BLOCKS
    );
  }

  private findSpawnGroundY(wx: number, playerBy: number): number | null {
    const surface = this.world.getSurfaceHeight(wx);
    // Cheap surface-band gate: fireflies past this vertical distance from the player
    // are off-screen / irrelevant at any reasonable zoom. Skipping these probes saves
    // most of the cost when the player is deep underground or high in the sky — both
    // cases where the surface-band would otherwise run nearestWaterDistance() on
    // cells the player can't see.
    const surfaceNearPlayer = Math.abs(surface - playerBy) <= 80;
    if (surfaceNearPlayer) {
      // Surface band first — the overwhelmingly common success case at night.
      if (this.checkGroundSpawnCell(wx, surface + 2)) return surface + 2;
      if (this.checkGroundSpawnCell(wx, surface + 1)) return surface + 1;
      if (this.checkGroundSpawnCell(wx, surface)) return surface;
      if (this.checkGroundSpawnCell(wx, surface - 1)) return surface - 1;
      if (this.checkGroundSpawnCell(wx, surface - 2)) return surface - 2;
    }
    // Player band (caves above / below): probes progressively deeper ledges near the player.
    const playerCandidates: number[] = [
      playerBy + 24,
      playerBy + 16,
      playerBy + 8,
      playerBy,
      playerBy - 8,
      playerBy - 16,
      playerBy - 24,
      playerBy - 32,
      playerBy - 40,
      playerBy - 48,
      playerBy - 56,
      playerBy - 64,
    ];
    for (const wy of playerCandidates) {
      if (this.checkGroundSpawnCell(wx, wy)) {
        return wy;
      }
    }
    return null;
  }

  private nearestWaterDistance(wx: number, wy: number): number | null {
    const cacheKey = packWxWyKey(wx, wy);
    const cached = this._nearestWaterCache.get(cacheKey);
    if (cached !== undefined) {
      return cached < 0 ? null : cached;
    }
    const world = this.world;
    const r = FIREFLY_NEAR_WATER_RADIUS_BLOCKS;
    let best: number | null = null;
    for (let dy = -3; dy <= 1; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (!world.isWaterBlockId(world.getForegroundBlockId(wx + dx, wy + dy))) {
          continue;
        }
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        best = best === null ? d : Math.min(best, d);
      }
    }
    this._nearestWaterCache.set(cacheKey, best === null ? -1 : best);
    return best;
  }

  /**
   * Returns the cached list of chunk coords within {@link FIREFLY_SPAWN_CHUNK_RADIUS}
   * of the player. Rebuilt only when the player crosses a chunk boundary or every
   * {@link FIREFLY_NEIGHBOR_CHUNKS_REFRESH_TICKS} ticks to pick up newly streamed chunks.
   */
  private getNeighborChunks(pcx: number, pcy: number): [number, number][] {
    const staleByMove =
      this._neighborChunkPcx !== pcx || this._neighborChunkPcy !== pcy;
    const staleByTime = this.updateSeq >= this._neighborChunkRefreshAt;
    if (!staleByMove && !staleByTime) {
      return this._neighborChunkList;
    }
    // Bounded iteration (O(R²)) instead of scanning every loaded chunk.
    this.world.collectLoadedChunkCoordsWithinDistance(
      pcx,
      pcy,
      FIREFLY_SPAWN_CHUNK_RADIUS,
      this._neighborChunkList,
    );
    this._neighborChunkPcx = pcx;
    this._neighborChunkPcy = pcy;
    this._neighborChunkRefreshAt =
      this.updateSeq + FIREFLY_NEIGHBOR_CHUNKS_REFRESH_TICKS;
    return this._neighborChunkList;
  }

  private fireflyCenterOverlapsSolid(cx: number, cyPixi: number): boolean {
    const half = FIREFLY_SIZE_PX * 0.5;
    const mover = createAABB(
      cx - half,
      cyPixi - half,
      FIREFLY_SIZE_PX,
      FIREFLY_SIZE_PX,
    );
    const q = createAABB(
      mover.x - 2,
      mover.y - 2,
      mover.width + 4,
      mover.height + 4,
    );
    getSolidAABBs(this.world, q, this.solidScratch);
    for (const s of this.solidScratch) {
      if (overlaps(mover, s)) {
        return true;
      }
    }
    return false;
  }

  private isTooCloseToOtherFirefly(x: number, y: number, minDistPx: number): boolean {
    const minD2 = minDistPx * minDistPx;
    for (const p of this.particles) {
      const dx = p.x - x;
      const dy = p.y - y;
      if (dx * dx + dy * dy < minD2) {
        return true;
      }
    }
    return false;
  }

  private recycleParticle(index: number): void {
    const p = this.particles[index]!;
    fireflySpritePool.release(p.sprite);
    this.particles[index] = this.particles[this.particles.length - 1]!;
    this.particles.pop();
  }

  private clearParticles(): void {
    if (this.particles.length === 0) {
      return;
    }
    for (const p of this.particles) {
      fireflySpritePool.release(p.sprite);
    }
    this.particles.length = 0;
  }

  destroy(): void {
    this.clearParticles();
    this.root.parent?.removeChild(this.root);
    this.root.destroy({ children: false });
  }
}
