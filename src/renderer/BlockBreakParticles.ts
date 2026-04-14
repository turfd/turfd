/**
 * Block debris: 1×1 and 2×2 quads from terrain atlas — mining, break pop, and footstep kick-up (kick always drawn 2×2).
 */
import { Container, Rectangle, Sprite, Texture } from "pixi.js";
import {
  BLOCK_BREAK_PARTICLE_LIFETIME_SEC,
  BLOCK_BREAK_PARTICLE_MAX,
  BLOCK_BREAK_PARTICLE_MIN,
  BLOCK_BREAK_PARTICLES_PER_PROGRESS,
  BLOCK_SIZE,
  BLOCK_STEP_KICK_LIFETIME_SEC,
  BLOCK_STEP_KICK_PARTICLE_MAX,
  BLOCK_STEP_KICK_PARTICLE_MIN,
  BLOCK_STEP_KICK_PARTICLE_SPRINT_EXTRA,
  ITEM_GRAVITY,
  PLAYER_REMOTE_SPRINT_VEL_THRESHOLD,
} from "../core/constants";
import type { EventBus } from "../core/EventBus";
import type { GameEvent } from "../core/types";
import type { BreakTargetLayer } from "../entities/Player";
import type { BlockRegistry } from "../world/blocks/BlockRegistry";
import type { AtlasLoader } from "./AtlasLoader";
import type { RenderPipeline } from "./RenderPipeline";
import { ObjectPool } from "../utils/pool";

const breakSpritePool = new ObjectPool<Sprite>(
  () => new Sprite(),
  (s) => { s.visible = false; s.removeFromParent(); },
  0,
  512,
);

const MAX_ALIVE = 320;

/** Same hashing as terrain mesh so break crumbs match the broken tile variant / flip. */
function shouldFlipTextureX(wx: number, wy: number, blockId: number): boolean {
  let h = wx * 374761393 + wy * 668265263 + blockId * 1103515245;
  h ^= h >>> 13;
  h = Math.imul(h, 1274126177);
  h ^= h >>> 16;
  return (h & 1) !== 0;
}

function pickTextureVariant(
  wx: number,
  wy: number,
  blockId: number,
  variantCount: number,
): number {
  if (variantCount <= 1) {
    return 0;
  }
  let h = wx * 2654435761 + wy * 2246822519 + blockId * 3266489917;
  h ^= h >>> 15;
  h = Math.imul(h, 2246822519);
  h ^= h >>> 13;
  return (h >>> 0) % variantCount;
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

type BreakParticle = {
  sprite: Sprite;
  tex: Texture;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
};

function resolveBreakTextureName(blockId: number, registry: BlockRegistry): string {
  const def = registry.getById(blockId);
  if (def.identifier === "stratum:chest") {
    return "chest";
  }
  return def.textureName;
}

export type LocalMiningBreakSync = {
  wx: number;
  wy: number;
  layer: BreakTargetLayer;
  blockId: number;
  progress: number;
};

export class BlockBreakParticles {
  private readonly busUnsubs: (() => void)[];
  private readonly particles: BreakParticle[] = [];
  private readonly root: Container;

  private miningKey: string | null = null;
  private miningLastProgress = 0;
  private miningProgressCarry = 0;
  private miningSpawnSeq = 0;
  private groundKickSeq = 0;

  constructor(
    bus: EventBus,
    private readonly worldSeed: number,
    private readonly airBlockId: number,
    private readonly atlas: AtlasLoader,
    private readonly registry: BlockRegistry,
    pipeline: RenderPipeline,
  ) {
    this.root = new Container();
    pipeline.layerParticles.addChild(this.root);
    this.busUnsubs = [
      bus.on("game:block-changed", (e) => this.onBlockChanged(e)),
      bus.on("entity:ground-kick", (e) => this.onGroundKick(e)),
    ];
  }

  /**
   * Call after local player physics each tick while they hold break on a block.
   * Spawns a trickle of particles proportional to {@link BLOCK_BREAK_PARTICLES_PER_PROGRESS} × d(progress).
   */
  syncLocalMiningBreak(active: LocalMiningBreakSync | null): void {
    if (active === null || active.progress <= 0 || active.blockId === this.airBlockId) {
      this.miningKey = null;
      this.miningLastProgress = 0;
      this.miningProgressCarry = 0;
      return;
    }

    const key = `${active.wx},${active.wy},${active.layer}`;
    if (this.miningKey !== key) {
      this.miningKey = key;
      this.miningLastProgress = 0;
      this.miningProgressCarry = 0;
    }

    const delta = active.progress - this.miningLastProgress;
    this.miningLastProgress = active.progress;
    if (delta <= 0) {
      return;
    }

    this.miningProgressCarry += delta * BLOCK_BREAK_PARTICLES_PER_PROGRESS;
    while (this.miningProgressCarry >= 1) {
      this.miningProgressCarry -= 1;
      const rng = mulberry32(
        mixSeed(
          this.worldSeed,
          active.wx,
          active.wy,
          active.blockId,
          this.miningSpawnSeq++,
          0x91a2b3,
        ),
      );
      if (!this.spawnOne(active.wx, active.wy, active.blockId, rng, false)) {
        break;
      }
    }
  }

  private onBlockChanged(e: Extract<GameEvent, { type: "game:block-changed" }>): void {
    if (e.blockId !== this.airBlockId) {
      return;
    }
    if (e.previousBlockId === undefined || e.previousBlockId === this.airBlockId) {
      return;
    }
    this.spawnBurst(e.wx, e.wy, e.previousBlockId);
  }

  private onGroundKick(e: Extract<GameEvent, { type: "entity:ground-kick" }>): void {
    if (e.blockId === this.airBlockId) {
      return;
    }
    let def;
    try {
      def = this.registry.getById(e.blockId);
    } catch {
      return;
    }
    if (def.water) {
      return;
    }

    const bx = Math.floor(e.feetWorldX / BLOCK_SIZE);
    const by = Math.floor(e.feetWorldY / BLOCK_SIZE) - 1;
    const seed = mixSeed(
      this.worldSeed,
      bx,
      by,
      e.blockId,
      this.groundKickSeq++,
      0x7e11,
    );
    const rng = mulberry32(seed);
    let n =
      BLOCK_STEP_KICK_PARTICLE_MIN +
      Math.floor(
        rng() * (BLOCK_STEP_KICK_PARTICLE_MAX - BLOCK_STEP_KICK_PARTICLE_MIN + 1),
      );
    if (Math.abs(e.velocityX) >= PLAYER_REMOTE_SPRINT_VEL_THRESHOLD) {
      n += BLOCK_STEP_KICK_PARTICLE_SPRINT_EXTRA;
    }
    n = Math.min(n, 6);

    let room = MAX_ALIVE - this.particles.length;
    for (let i = 0; i < n && room > 0; i++) {
      const prng = mulberry32(mixSeed(seed, i + 0x50d));
      if (
        this.spawnKickOne(
          bx,
          by,
          e.blockId,
          e.feetWorldX,
          e.feetWorldY,
          e.velocityX,
          prng,
        )
      ) {
        room -= 1;
      }
    }
  }

  /** Kicked debris: same atlas quads as break, biased backward and upward from the feet. */
  private spawnKickOne(
    blockWx: number,
    blockWy: number,
    blockId: number,
    feetWorldX: number,
    feetWorldY: number,
    velocityX: number,
    rng: () => number,
  ): boolean {
    let textureName: string;
    try {
      textureName = resolveBreakTextureName(blockId, this.registry);
      this.atlas.getTextureVariants(textureName);
    } catch {
      return false;
    }

    if (this.particles.length >= MAX_ALIVE) {
      return false;
    }

    const variants = this.atlas.getTextureVariants(textureName);
    const ti = pickTextureVariant(blockWx, blockWy, blockId, variants.length);
    const baseTex = variants[ti]!;
    const flipX = shouldFlipTextureX(blockWx, blockWy, blockId);
    const fr = baseTex.frame;
    const tw = Math.max(1, Math.floor(fr.width));
    const th = Math.max(1, Math.floor(fr.height));

    const can2 = tw >= 2 && th >= 2;
    // Foot-kick dust: always 2×2 screen pixels (2×2 atlas sample when available).
    let pw = can2 ? 2 : 1;
    let ph = can2 ? 2 : 1;
    pw = Math.min(pw, tw);
    ph = Math.min(ph, th);
    const ox = Math.floor(rng() * (tw - pw + 1));
    const oy = Math.floor(rng() * (th - ph + 1));

    const sub = new Texture({
      source: baseTex.source,
      frame: new Rectangle(fr.x + ox, fr.y + oy, pw, ph),
    });
    sub.source.scaleMode = "nearest";

    const sprite = breakSpritePool.acquire();
    sprite.texture = sub;
    sprite.anchor.set(0.5, 0.5);
    sprite.roundPixels = true;
    sprite.visible = true;
    sprite.alpha = 1;
    sprite.rotation = 0;
    sprite.width = 2;
    sprite.height = 2;
    if (flipX) {
      sprite.scale.x *= -1;
    }

    const backward = -(Math.sign(velocityX) || 1);
    const worldX =
      feetWorldX +
      backward * (3 + rng() * 7) +
      (rng() - 0.5) * 6 +
      (rng() - 0.5) * 2;
    // Screen y = −worldY; larger worldY moves dust up on screen (+3 vs pre-tweak baseline).
    const worldY = feetWorldY - (1 + rng() * 6) + 3;

    const px = worldX;
    const pyPixi = -worldY;
    sprite.position.set(px, pyPixi);

    const speedMul = Math.min(1.4, 0.72 + Math.abs(velocityX) / 200);
    const vx =
      (backward * (38 + rng() * 52) + (rng() - 0.5) * 28) * speedMul;
    const vy = -(20 + rng() * 42) * speedMul;

    const life = BLOCK_STEP_KICK_LIFETIME_SEC;
    this.root.addChild(sprite);
    this.particles.push({
      sprite,
      tex: sub,
      x: px,
      y: pyPixi,
      vx,
      vy,
      life,
      maxLife: life,
    });
    return true;
  }

  private spawnBurst(wx: number, wy: number, blockId: number): void {
    let textureName: string;
    try {
      textureName = resolveBreakTextureName(blockId, this.registry);
      this.atlas.getTextureVariants(textureName);
    } catch {
      return;
    }

    const countRng = mulberry32(
      mixSeed(this.worldSeed, wx, wy, blockId, 0x5eed),
    );
    const n = Math.min(
      BLOCK_BREAK_PARTICLE_MAX,
      BLOCK_BREAK_PARTICLE_MIN +
        Math.floor(
          countRng() * (BLOCK_BREAK_PARTICLE_MAX - BLOCK_BREAK_PARTICLE_MIN + 1),
        ),
    );

    let room = MAX_ALIVE - this.particles.length;
    if (room <= 0) {
      return;
    }
    const spawnN = Math.min(n, room);

    for (let i = 0; i < spawnN; i++) {
      const rng = mulberry32(
        mixSeed(this.worldSeed, wx, wy, blockId, i + 0xc20b5),
      );
      if (!this.spawnOne(wx, wy, blockId, rng, true)) {
        break;
      }
    }
  }

  /**
   * @param burstVel - slightly stronger scatter for the final break pop
   */
  private spawnOne(
    wx: number,
    wy: number,
    blockId: number,
    rng: () => number,
    burstVel: boolean,
  ): boolean {
    let textureName: string;
    try {
      textureName = resolveBreakTextureName(blockId, this.registry);
      this.atlas.getTextureVariants(textureName);
    } catch {
      return false;
    }

    if (this.particles.length >= MAX_ALIVE) {
      return false;
    }

    const variants = this.atlas.getTextureVariants(textureName);
    const ti = pickTextureVariant(wx, wy, blockId, variants.length);
    const baseTex = variants[ti]!;
    const flipX = shouldFlipTextureX(wx, wy, blockId);
    const fr = baseTex.frame;
    const tw = Math.max(1, Math.floor(fr.width));
    const th = Math.max(1, Math.floor(fr.height));

    const can2 = tw >= 2 && th >= 2;
    const use2x2 = can2 && rng() >= 0.5;
    let pw = use2x2 ? 2 : 1;
    let ph = use2x2 ? 2 : 1;
    pw = Math.min(pw, tw);
    ph = Math.min(ph, th);
    const ox = Math.floor(rng() * (tw - pw + 1));
    const oy = Math.floor(rng() * (th - ph + 1));

    const sub = new Texture({
      source: baseTex.source,
      frame: new Rectangle(fr.x + ox, fr.y + oy, pw, ph),
    });
    sub.source.scaleMode = "nearest";

    const sprite = breakSpritePool.acquire();
    sprite.texture = sub;
    sprite.anchor.set(0.5, 0.5);
    sprite.roundPixels = true;
    sprite.visible = true;
    sprite.alpha = 1;
    sprite.rotation = 0;
    sprite.width = pw;
    sprite.height = ph;
    if (flipX) {
      sprite.scale.x *= -1;
    }

    const bx = wx * BLOCK_SIZE;
    const by = wy * BLOCK_SIZE;
    const px = bx + ox + pw * 0.5;
    const pyWorld = by + oy + ph * 0.5;
    sprite.position.set(px, -pyWorld);

    const vMul = burstVel ? 1 : 0.62;
    const vx = (rng() * 2 - 1) * 52 * vMul;
    const vy = (rng() * 2 - 1) * 46 * vMul - 22 * vMul;

    this.root.addChild(sprite);
    this.particles.push({
      sprite,
      tex: sub,
      x: px,
      y: -pyWorld,
      vx,
      vy,
      life: BLOCK_BREAK_PARTICLE_LIFETIME_SEC,
      maxLife: BLOCK_BREAK_PARTICLE_LIFETIME_SEC,
    });
    return true;
  }

  update(dtSec: number): void {
    const g = ITEM_GRAVITY * BLOCK_SIZE;
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i]!;
      p.life -= dtSec;
      p.vy += g * dtSec;
      p.x += p.vx * dtSec;
      p.y += p.vy * dtSec;
      p.vx *= 0.985;
      p.sprite.position.set(p.x, p.y);
      p.sprite.alpha = Math.max(0, p.life / p.maxLife);
      if (p.life <= 0) {
        breakSpritePool.release(p.sprite);
        p.tex.destroy(false);
        this.particles[i] = this.particles[this.particles.length - 1]!;
        this.particles.pop();
      }
    }
  }

  destroy(): void {
    for (const u of this.busUnsubs) {
      u();
    }
    for (const p of this.particles) {
      breakSpritePool.release(p.sprite);
      p.tex.destroy(false);
    }
    this.particles.length = 0;
    this.root.parent?.removeChild(this.root);
    this.root.destroy({ children: false });
  }
}
