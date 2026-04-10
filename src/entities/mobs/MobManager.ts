/**
 * Host-authoritative mobs with performance-focused lifecycle:
 * - **Hard global cap** ({@link MOB_GLOBAL_CAP})
 * - **Passive spawn cycles** (Minecraft-style: periodic attempts in loaded chunks **near players**,
 *   not tied to chunk generation—terrain is already there; we only roll spawns where chunks are loaded)
 * - **Immediate despawn** when the chunk under the mob unloads (no simulation off loaded terrain)
 * - **Chunk column index** for O(1) spawn density checks near a column
 */
import {
  BLOCK_SIZE,
  CHUNK_SIZE,
  PLAYER_HEIGHT,
  PLAYER_WIDTH,
  SIMULATION_DISTANCE_CHUNKS,
} from "../../core/constants";
import type { ItemId, ItemStack } from "../../core/itemDefinition";
import type { LootResolver } from "../../items/LootResolver";
import { worldToChunk } from "../../world/chunk/ChunkCoord";
import type { World } from "../../world/World";
import type { GeneratorContext } from "../../world/gen/GeneratorContext";
import type { AABB } from "../physics/AABB";
import {
  HOSTILE_MOB_SPAWN_INTERVAL_SEC,
  HOSTILE_SPAWN_ATTEMPTS_PER_CYCLE,
  MOB_GLOBAL_CAP,
  PASSIVE_CHUNK_SPAWN_RADIUS,
  PASSIVE_MOB_SPAWN_INTERVAL_SEC,
  PASSIVE_SPAWN_ATTEMPTS_PER_CYCLE,
  PIG_DAMAGE_INVULN_SEC,
  PIG_DEATH_ANIM_SEC,
  PIG_MAX_HEALTH,
  PIG_MAX_PER_COLUMN,
  PIG_HEIGHT_PX,
  PIG_SPAWN_MIN_COMBINED_LIGHT,
  PIG_WIDTH_PX,
  SHEEP_DAMAGE_INVULN_SEC,
  SHEEP_DEATH_ANIM_SEC,
  SHEEP_KNOCKBACK_HAND_PX,
  SHEEP_MAX_HEALTH,
  SHEEP_MAX_PER_COLUMN,
  SHEEP_MELEE_DAMAGE,
  SHEEP_HEIGHT_PX,
  SHEEP_SPAWN_MIN_COMBINED_LIGHT,
  SHEEP_WIDTH_PX,
  ZOMBIE_ATTACK_DAMAGE,
  ZOMBIE_ATTACK_INTERVAL_SEC,
  ZOMBIE_ATTACK_SWING_VISUAL_SEC,
  ZOMBIE_SUN_BURN_DAMAGE_INTERVAL_SEC,
  ZOMBIE_SUN_BURN_DAMAGE_PER_TICK,
  ZOMBIE_SUN_BURN_MIN_SKY_LIGHT,
  ZOMBIE_SUN_BURN_VISUAL_REFRESH_SEC,
  ZOMBIE_DAMAGE_INVULN_SEC,
  ZOMBIE_DEATH_ANIM_SEC,
  ZOMBIE_HEIGHT_PX,
  ZOMBIE_MAX_HEALTH,
  ZOMBIE_MAX_PER_COLUMN,
  ZOMBIE_SPAWN_MAX_COMBINED_LIGHT,
  ZOMBIE_WIDTH_PX,
  combinedLight,
  feetPxFromSurfaceBlockY,
  isWorldTimeLateEnoughForSunBurn,
  isWorldTimeNightForPassiveSpawns,
} from "./mobConstants";
import {
  MobType,
  type MobPigState,
  type MobSheepState,
  type MobZombieState,
} from "./mobTypes";
import {
  applyPigKnockback,
  applyPigPanic,
  tickPigPhysics,
} from "./pigPhysics";
import {
  applyZombieKnockback,
  tickZombiePhysics,
  zombieFeetInMeleeRangeOfPlayerFeet,
} from "./zombiePhysics";
import {
  applySheepKnockback,
  applySheepPanic,
  tickSheepPhysics,
} from "./sheepPhysics";
import {
  getWoolItemKeyForColor,
  normalizeSheepWoolColor,
  rollAnySheepWoolColor,
  rollNaturalSheepWoolColor,
} from "./sheepWool";

/** Avoid huge catch-up bursts after a long pause (debugger / tab background). */
const MAX_PASSIVE_SPAWN_CYCLES_PER_TICK = 5;

export type MobRecord = MobSheepState | MobPigState | MobZombieState;

export type MobPublicView = Readonly<{
  id: number;
  type: MobType;
  x: number;
  y: number;
  vx: number;
  vy: number;
  hp: number;
  hurt: boolean;
  /** Zombie-only: brief swing/hit pose right after attacking. */
  attacking: boolean;
  /** Zombie-only: currently burning in daylight (fire overlay). */
  burning: boolean;
  /** Dye ordinal 0–15. */
  woolColor: number;
  facingRight: boolean;
  panic: boolean;
  walking: boolean;
  /** Seconds left in death pose (`0` = not dying). */
  deathAnimRemainSec: number;
}>;

function toPublic(m: MobRecord): MobPublicView {
  const dying = m.deathAnimRemainSec > 0;
  const panic =
    !dying &&
    (m.kind === "sheep" || m.kind === "pig") &&
    m.panicRemainSec > 0;
  const walking =
    !dying &&
    Math.abs(m.vx) > 8 &&
    (m.onGround || m.inWater);
  const type =
    m.kind === "sheep"
      ? MobType.Sheep
      : m.kind === "pig"
        ? MobType.Pig
        : MobType.Zombie;
  return {
    id: m.id,
    type,
    x: m.x,
    y: m.y,
    vx: m.vx,
    vy: m.vy,
    hp: m.hp,
    hurt: m.hurtRemainSec > 0,
    attacking: m.kind === "zombie" && m.attackSwingRemainSec > 0,
    burning: m.kind === "zombie" && m.burnRemainSec > 0,
    woolColor: m.kind === "sheep" ? m.woolColor : 0,
    facingRight: m.facingRight,
    panic,
    walking,
    deathAnimRemainSec: m.deathAnimRemainSec,
  };
}

export class MobManager {
  private readonly world: World;
  private readonly lootResolver: LootResolver;
  private readonly mobs = new Map<number, MobRecord>();
  /** Sheep count per world block column `wx` (spawn density). */
  private readonly sheepPerColumn = new Map<number, number>();
  /** Pig count per world block column `wx` (spawn density). */
  private readonly pigPerColumn = new Map<number, number>();
  /** Zombie count per world block column `wx` (spawn density). */
  private readonly zombiePerColumn = new Map<number, number>();
  private nextNetId = 1;
  private passiveSpawnCycleAccumSec = 0;
  private hostileSpawnCycleAccumSec = 0;
  private readonly solidScratch: AABB[] = [];
  /** Throttle network replication: last sent state signature per id. */
  private readonly lastBroadcastSig = new Map<number, string>();
  private broadcastCooldown = 0;
  private readonly pendingSpawn: Array<{
    id: number;
    type: MobType;
    x: number;
    y: number;
    woolColor: number;
  }> = [];
  private readonly pendingDespawn: number[] = [];

  constructor(world: World, lootResolver: LootResolver) {
    this.world = world;
    this.lootResolver = lootResolver;
  }

  /**
   * Host/solo: restore mobs from a world save. Best-effort:
   * - Skips unknown types
   * - Skips mobs whose supporting chunks are not loaded (they would immediately cull)
   */
  restoreFromSave(
    mobs: ReadonlyArray<{
      id: number;
      type: number;
      x: number;
      y: number;
      woolColor?: number;
      persistent?: boolean;
    }>,
  ): void {
    this.clear();
    let maxId = 0;
    for (const p of mobs) {
      if (
        p.type !== MobType.Sheep &&
        p.type !== MobType.Pig &&
        p.type !== MobType.Zombie
      ) {
        continue;
      }
      const bx = Math.floor(p.x / BLOCK_SIZE);
      const by = Math.floor(p.y / BLOCK_SIZE);
      if (
        this.world.getChunkAt(bx, by) === undefined ||
        this.world.getChunkAt(bx, by - 1) === undefined
      ) {
        continue;
      }
      const id = Math.max(1, Math.floor(p.id));
      const m: MobRecord =
        p.type === MobType.Sheep
          ? {
              kind: "sheep",
              id,
              x: p.x,
              y: p.y,
              vx: 0,
              vy: 0,
              hp: SHEEP_MAX_HEALTH,
              hurtRemainSec: 0,
              noDamageSec: 0,
              woolColor: normalizeSheepWoolColor(p.woolColor),
              facingRight: true,
              targetVx: 0,
              panicRemainSec: 0,
              panicFlipTimerSec: 0,
              wanderTimerSec: 1,
              onGround: true,
              inWater: false,
              hitKnockVx: 0,
              damageInvulnRemainSec: 0,
              deathAnimRemainSec: 0,
              persistent: p.persistent ?? false,
              despawnFarSec: 0,
            }
          : p.type === MobType.Pig
            ? {
                kind: "pig",
                id,
                x: p.x,
                y: p.y,
                vx: 0,
                vy: 0,
                hp: PIG_MAX_HEALTH,
                hurtRemainSec: 0,
                noDamageSec: 0,
                facingRight: true,
                targetVx: 0,
                panicRemainSec: 0,
                panicFlipTimerSec: 0,
                wanderTimerSec: 1,
                onGround: true,
                inWater: false,
                hitKnockVx: 0,
                damageInvulnRemainSec: 0,
                deathAnimRemainSec: 0,
                persistent: p.persistent ?? false,
                despawnFarSec: 0,
              }
            : {
                kind: "zombie",
                id,
                x: p.x,
                y: p.y,
                vx: 0,
                vy: 0,
                hp: ZOMBIE_MAX_HEALTH,
                hurtRemainSec: 0,
                noDamageSec: 0,
                facingRight: true,
                targetVx: 0,
                wanderTimerSec: 1,
                onGround: true,
                inWater: false,
                hitKnockVx: 0,
                damageInvulnRemainSec: 0,
                deathAnimRemainSec: 0,
                persistent: p.persistent ?? false,
                despawnFarSec: 0,
                attackCooldownRemainSec: 0,
                attackSwingRemainSec: 0,
                burnRemainSec: 0,
                burnDamageAccumSec: 0,
              };
      this.mobs.set(id, m);
      const wx = Math.floor(m.x / BLOCK_SIZE);
      if (m.kind === "sheep") {
        this.sheepPerColumn.set(wx, (this.sheepPerColumn.get(wx) ?? 0) + 1);
      } else if (m.kind === "pig") {
        this.pigPerColumn.set(wx, (this.pigPerColumn.get(wx) ?? 0) + 1);
      } else {
        this.zombiePerColumn.set(wx, (this.zombiePerColumn.get(wx) ?? 0) + 1);
      }
      if (id > maxId) {
        maxId = id;
      }
    }
    this.nextNetId = maxId + 1;
  }

  getAll(): IterableIterator<MobRecord> {
    return this.mobs.values();
  }

  getPublicViews(): MobPublicView[] {
    const out: MobPublicView[] = [];
    for (const m of this.mobs.values()) {
      out.push(toPublic(m));
    }
    return out;
  }

  getById(id: number): MobRecord | undefined {
    return this.mobs.get(id);
  }

  /**
   * **O(1)** remove: Map delete, column counter, clears replication throttle for this id.
   * Call when despawning; networking layer sends ENTITY_DESPAWN separately.
   */
  private removeMob(id: number, pushDespawn: boolean): MobRecord | undefined {
    const m = this.mobs.get(id);
    if (m === undefined) {
      return undefined;
    }
    this.mobs.delete(id);
    this.lastBroadcastSig.delete(id);
    if (pushDespawn) {
      this.pendingDespawn.push(id);
    }
    const wx = Math.floor(m.x / BLOCK_SIZE);
    if (m.kind === "sheep") {
      const n = this.sheepPerColumn.get(wx) ?? 0;
      if (n <= 1) {
        this.sheepPerColumn.delete(wx);
      } else {
        this.sheepPerColumn.set(wx, n - 1);
      }
    } else if (m.kind === "pig") {
      const n = this.pigPerColumn.get(wx) ?? 0;
      if (n <= 1) {
        this.pigPerColumn.delete(wx);
      } else {
        this.pigPerColumn.set(wx, n - 1);
      }
    } else {
      const n = this.zombiePerColumn.get(wx) ?? 0;
      if (n <= 1) {
        this.zombiePerColumn.delete(wx);
      } else {
        this.zombiePerColumn.set(wx, n - 1);
      }
    }
    return m;
  }

  despawn(id: number): MobRecord | undefined {
    return this.removeMob(id, true);
  }

  /**
   * Drops spawn items via {@link World.spawnItem} (same replication path as block drops).
   */
  private dropSheepLoot(m: MobSheepState, rng: GeneratorContext): void {
    const px = m.x;
    const py = m.y + SHEEP_WIDTH_PX * 0.25;
    const woolKey = getWoolItemKeyForColor(m.woolColor);
    const blocks = this.world.getRegistry();
    /** Colored wool always exists as a block; block id matches the block-item stack id. */
    const woolId: ItemId | undefined = blocks.isRegistered(woolKey)
      ? (blocks.getByIdentifier(woolKey).id as ItemId)
      : this.lootResolver.tryGetItemIdByKey(woolKey);
    if (woolId !== undefined) {
      this.spawnItemStackAt({ itemId: woolId, count: 1 }, px, py);
    }
    const bonus = this.lootResolver.resolveEntityLoot(MobType.Sheep, rng);
    for (const s of bonus) {
      this.spawnItemStackAt(s, px, py);
    }
  }

  private dropPigLoot(m: MobPigState, rng: GeneratorContext): void {
    const px = m.x;
    const py = m.y + PIG_WIDTH_PX * 0.25;
    const bonus = this.lootResolver.resolveEntityLoot(MobType.Pig, rng);
    for (const s of bonus) {
      this.spawnItemStackAt(s, px, py);
    }
  }

  private spawnItemStackAt(stack: ItemStack, x: number, y: number): void {
    const dmg = "damage" in stack && stack.damage !== undefined ? stack.damage : 0;
    this.world.spawnItem(stack.itemId, stack.count, x, y, 0, 0, dmg);
  }

  /** Drops loot once, freezes AI/movement; {@link tickHost} removes after {@link SHEEP_DEATH_ANIM_SEC}. */
  private startSheepDeath(m: MobSheepState, rng: GeneratorContext): void {
    if (m.deathAnimRemainSec > 0) {
      return;
    }
    this.dropSheepLoot(m, rng);
    m.hp = 0;
    m.deathAnimRemainSec = SHEEP_DEATH_ANIM_SEC;
    m.vx = 0;
    m.vy = 0;
    m.targetVx = 0;
    m.panicRemainSec = 0;
    m.hitKnockVx = 0;
    m.damageInvulnRemainSec = 0;
  }

  private startPigDeath(m: MobPigState, rng: GeneratorContext): void {
    if (m.deathAnimRemainSec > 0) {
      return;
    }
    this.dropPigLoot(m, rng);
    m.hp = 0;
    m.deathAnimRemainSec = PIG_DEATH_ANIM_SEC;
    m.vx = 0;
    m.vy = 0;
    m.targetVx = 0;
    m.panicRemainSec = 0;
    m.hitKnockVx = 0;
    m.damageInvulnRemainSec = 0;
  }

  private dropZombieLoot(m: MobZombieState, rng: GeneratorContext): void {
    const px = m.x;
    const py = m.y + ZOMBIE_WIDTH_PX * 0.25;
    const bonus = this.lootResolver.resolveEntityLoot(MobType.Zombie, rng);
    for (const s of bonus) {
      this.spawnItemStackAt(s, px, py);
    }
  }

  private startZombieDeath(m: MobZombieState, rng: GeneratorContext): void {
    if (m.deathAnimRemainSec > 0) {
      return;
    }
    this.dropZombieLoot(m, rng);
    m.hp = 0;
    m.deathAnimRemainSec = ZOMBIE_DEATH_ANIM_SEC;
    m.vx = 0;
    m.vy = 0;
    m.targetVx = 0;
    m.hitKnockVx = 0;
    m.damageInvulnRemainSec = 0;
  }

  /**
   * Remove any mob whose feet are in an **unloaded** chunk — critical for performance when the
   * player moves and {@link World} evicts distant chunks.
   */
  cullMobsInUnloadedChunks(): void {
    for (const [id, m] of this.mobs) {
      const bx = Math.floor(m.x / BLOCK_SIZE);
      const by = Math.floor(m.y / BLOCK_SIZE);
      if (
        this.world.getChunkAt(bx, by) === undefined ||
        this.world.getChunkAt(bx, by - 1) === undefined
      ) {
        this.removeMob(id, true);
      }
    }
  }

  spawnSheepAt(x: number, y: number, rng: GeneratorContext): number | null {
    if (this.mobs.size >= MOB_GLOBAL_CAP) {
      return null;
    }
    const wx = Math.floor(x / BLOCK_SIZE);
    if ((this.sheepPerColumn.get(wx) ?? 0) >= SHEEP_MAX_PER_COLUMN) {
      return null;
    }
    const id = this.nextNetId++;
    const woolColor = rollNaturalSheepWoolColor(rng);
    const m: MobSheepState = {
      kind: "sheep",
      id,
      x,
      y,
      vx: 0,
      vy: 0,
      hp: SHEEP_MAX_HEALTH,
      hurtRemainSec: 0,
      noDamageSec: 0,
      woolColor,
      facingRight: rng.nextFloat() < 0.5,
      targetVx: 0,
      panicRemainSec: 0,
      panicFlipTimerSec: 0,
      wanderTimerSec: 0.5 + rng.nextFloat(),
      onGround: true,
      inWater: false,
      hitKnockVx: 0,
      damageInvulnRemainSec: 0,
      deathAnimRemainSec: 0,
      persistent: false,
      despawnFarSec: 0,
    };
    this.mobs.set(id, m);
    this.sheepPerColumn.set(wx, (this.sheepPerColumn.get(wx) ?? 0) + 1);
    this.pendingSpawn.push({ id, type: MobType.Sheep, x, y, woolColor });
    return id;
  }

  spawnPigAt(x: number, y: number, rng: GeneratorContext): number | null {
    if (this.mobs.size >= MOB_GLOBAL_CAP) {
      return null;
    }
    const wx = Math.floor(x / BLOCK_SIZE);
    if ((this.pigPerColumn.get(wx) ?? 0) >= PIG_MAX_PER_COLUMN) {
      return null;
    }
    const id = this.nextNetId++;
    const m: MobPigState = {
      kind: "pig",
      id,
      x,
      y,
      vx: 0,
      vy: 0,
      hp: PIG_MAX_HEALTH,
      hurtRemainSec: 0,
      noDamageSec: 0,
      facingRight: rng.nextFloat() < 0.5,
      targetVx: 0,
      panicRemainSec: 0,
      panicFlipTimerSec: 0,
      wanderTimerSec: 0.5 + rng.nextFloat(),
      onGround: true,
      inWater: false,
      hitKnockVx: 0,
      damageInvulnRemainSec: 0,
      deathAnimRemainSec: 0,
      persistent: false,
      despawnFarSec: 0,
    };
    this.mobs.set(id, m);
    this.pigPerColumn.set(wx, (this.pigPerColumn.get(wx) ?? 0) + 1);
    this.pendingSpawn.push({ id, type: MobType.Pig, x, y, woolColor: 0 });
    return id;
  }

  spawnSummonedSheepAt(x: number, y: number, rng: GeneratorContext): number | null {
    if (this.mobs.size >= MOB_GLOBAL_CAP) {
      return null;
    }
    const wx = Math.floor(x / BLOCK_SIZE);
    if ((this.sheepPerColumn.get(wx) ?? 0) >= SHEEP_MAX_PER_COLUMN) {
      return null;
    }
    const id = this.nextNetId++;
    const woolColor = rollAnySheepWoolColor(rng);
    const m: MobSheepState = {
      kind: "sheep",
      id,
      x,
      y,
      vx: 0,
      vy: 0,
      hp: SHEEP_MAX_HEALTH,
      hurtRemainSec: 0,
      noDamageSec: 0,
      woolColor,
      facingRight: rng.nextFloat() < 0.5,
      targetVx: 0,
      panicRemainSec: 0,
      panicFlipTimerSec: 0,
      wanderTimerSec: 0.5 + rng.nextFloat(),
      onGround: true,
      inWater: false,
      hitKnockVx: 0,
      damageInvulnRemainSec: 0,
      deathAnimRemainSec: 0,
      persistent: false,
      despawnFarSec: 0,
    };
    this.mobs.set(id, m);
    this.sheepPerColumn.set(wx, (this.sheepPerColumn.get(wx) ?? 0) + 1);
    this.pendingSpawn.push({ id, type: MobType.Sheep, x, y, woolColor });
    return id;
  }

  spawnSummonedSheepWithColorAt(
    x: number,
    y: number,
    woolColor: number,
    rng: GeneratorContext,
  ): number | null {
    if (this.mobs.size >= MOB_GLOBAL_CAP) {
      return null;
    }
    const wx = Math.floor(x / BLOCK_SIZE);
    if ((this.sheepPerColumn.get(wx) ?? 0) >= SHEEP_MAX_PER_COLUMN) {
      return null;
    }
    const id = this.nextNetId++;
    const normalizedWoolColor = normalizeSheepWoolColor(woolColor);
    const m: MobSheepState = {
      kind: "sheep",
      id,
      x,
      y,
      vx: 0,
      vy: 0,
      hp: SHEEP_MAX_HEALTH,
      hurtRemainSec: 0,
      noDamageSec: 0,
      woolColor: normalizedWoolColor,
      facingRight: rng.nextFloat() < 0.5,
      targetVx: 0,
      panicRemainSec: 0,
      panicFlipTimerSec: 0,
      wanderTimerSec: 0.5 + rng.nextFloat(),
      onGround: true,
      inWater: false,
      hitKnockVx: 0,
      damageInvulnRemainSec: 0,
      deathAnimRemainSec: 0,
      persistent: true,
      despawnFarSec: 0,
    };
    this.mobs.set(id, m);
    this.sheepPerColumn.set(wx, (this.sheepPerColumn.get(wx) ?? 0) + 1);
    this.pendingSpawn.push({
      id,
      type: MobType.Sheep,
      x,
      y,
      woolColor: normalizedWoolColor,
    });
    return id;
  }

  spawnSummonedPigAt(x: number, y: number, rng: GeneratorContext): number | null {
    const id = this.spawnPigAt(x, y, rng);
    if (id === null) {
      return null;
    }
    const m = this.mobs.get(id);
    if (m !== undefined) {
      m.persistent = true;
      m.despawnFarSec = 0;
    }
    return id;
  }

  spawnZombieAt(x: number, y: number, rng: GeneratorContext): number | null {
    if (this.mobs.size >= MOB_GLOBAL_CAP) {
      return null;
    }
    const wx = Math.floor(x / BLOCK_SIZE);
    if ((this.zombiePerColumn.get(wx) ?? 0) >= ZOMBIE_MAX_PER_COLUMN) {
      return null;
    }
    const id = this.nextNetId++;
    const m: MobZombieState = {
      kind: "zombie",
      id,
      x,
      y,
      vx: 0,
      vy: 0,
      hp: ZOMBIE_MAX_HEALTH,
      hurtRemainSec: 0,
      noDamageSec: 0,
      facingRight: rng.nextFloat() < 0.5,
      targetVx: 0,
      wanderTimerSec: 0,
      onGround: true,
      inWater: false,
      hitKnockVx: 0,
      damageInvulnRemainSec: 0,
      deathAnimRemainSec: 0,
      persistent: false,
      despawnFarSec: 0,
      attackCooldownRemainSec: 0,
      attackSwingRemainSec: 0,
      burnRemainSec: 0,
      burnDamageAccumSec: 0,
    };
    this.mobs.set(id, m);
    this.zombiePerColumn.set(wx, (this.zombiePerColumn.get(wx) ?? 0) + 1);
    this.pendingSpawn.push({ id, type: MobType.Zombie, x, y, woolColor: 0 });
    return id;
  }

  spawnSummonedZombieAt(x: number, y: number, rng: GeneratorContext): number | null {
    const id = this.spawnZombieAt(x, y, rng);
    if (id === null) {
      return null;
    }
    const m = this.mobs.get(id);
    if (m !== undefined) {
      m.persistent = true;
      m.despawnFarSec = 0;
    }
    return id;
  }

  /**
   * Loaded chunks whose centre is within {@link PASSIVE_CHUNK_SPAWN_RADIUS} (Chebyshev) of the
   * local stream centre and each remote player’s chunk (host). Matches “near player” passive spawning.
   */
  private getSpawnCandidateChunks(): Array<[number, number]> {
    const centres: Array<{ cx: number; cy: number }> = [];
    const sc = this.world.getStreamCentre();
    if (sc !== null) {
      centres.push(sc);
    }
    for (const rp of this.world.getRemotePlayers().values()) {
      const f = rp.getAuthorityFeet();
      centres.push(
        worldToChunk(Math.floor(f.x / BLOCK_SIZE), Math.floor(f.y / BLOCK_SIZE)),
      );
    }
    if (centres.length === 0) {
      return [...this.world.loadedChunkCoords()] as Array<[number, number]>;
    }
    const R = PASSIVE_CHUNK_SPAWN_RADIUS;
    const out: Array<[number, number]> = [];
    for (const [cx, cy] of this.world.loadedChunkCoords()) {
      if (
        centres.some(
          (c) => Math.max(Math.abs(cx - c.cx), Math.abs(cy - c.cy)) <= R,
        )
      ) {
        out.push([cx, cy]);
      }
    }
    return out;
  }

  /**
   * Host-only: one random surface spawn attempt. Sheep **only** spawn when the surface block is
   * `stratum:grass` (not dirt, short grass, flowers, etc.), plus light and caps.
   */
  private tryOnePassiveMobSpawn(rng: GeneratorContext): number | null {
    if (this.mobs.size >= MOB_GLOBAL_CAP) {
      return null;
    }
    const coords = this.getSpawnCandidateChunks();
    if (coords.length === 0) {
      return null;
    }
    const pick = coords[Math.floor(rng.nextFloat() * coords.length)]!;
    const cx = pick[0];
    const wx = cx * CHUNK_SIZE + Math.floor(rng.nextFloat() * CHUNK_SIZE);
    if (this.world.isDesertColumn(wx)) {
      return null;
    }
    const surfaceY = this.world.getSurfaceHeight(wx);
    const grass = this.world.getRegistry().getByIdentifier("stratum:grass");
    const top = this.world.getBlock(wx, surfaceY);
    if (top.id !== grass.id) {
      return null;
    }
    const spawnLightWy = surfaceY + 1;
    const sky = this.world.getSkyLight(wx, spawnLightWy);
    const blk = this.world.getBlockLight(wx, spawnLightWy);
    const feetY = feetPxFromSurfaceBlockY(surfaceY);
    const x = (wx + 0.5) * BLOCK_SIZE;
    if (rng.nextFloat() < 0.5) {
      if (combinedLight(sky, blk) < SHEEP_SPAWN_MIN_COMBINED_LIGHT) {
        return null;
      }
      return this.spawnSheepAt(x, feetY, rng);
    }
    if (combinedLight(sky, blk) < PIG_SPAWN_MIN_COMBINED_LIGHT) {
      return null;
    }
    return this.spawnPigAt(x, feetY, rng);
  }

  /**
   * Passive cycle: periodic spawn rolls in loaded chunks near players.
   * Timer does not advance at night — no burst spawns at dawn.
   */
  private passiveSpawnTick(
    dt: number,
    rng: GeneratorContext,
    worldTimeMs: number,
  ): void {
    if (isWorldTimeNightForPassiveSpawns(worldTimeMs)) {
      return;
    }
    this.passiveSpawnCycleAccumSec += dt;
    let cycles = 0;
    while (
      cycles < MAX_PASSIVE_SPAWN_CYCLES_PER_TICK &&
      this.passiveSpawnCycleAccumSec >= PASSIVE_MOB_SPAWN_INTERVAL_SEC
    ) {
      this.passiveSpawnCycleAccumSec -= PASSIVE_MOB_SPAWN_INTERVAL_SEC;
      cycles++;
      for (let i = 0; i < PASSIVE_SPAWN_ATTEMPTS_PER_CYCLE; i++) {
        void this.tryOnePassiveMobSpawn(rng);
      }
    }
  }

  /**
   * Night-only surface spawns (dark grass columns). Uses a separate timer from passive spawns so
   * toggling day/night does not dump extra cycles.
   */
  private hostileSpawnTick(
    dt: number,
    rng: GeneratorContext,
    worldTimeMs: number,
  ): void {
    if (!isWorldTimeNightForPassiveSpawns(worldTimeMs)) {
      this.hostileSpawnCycleAccumSec = 0;
      return;
    }
    this.hostileSpawnCycleAccumSec += dt;
    let cycles = 0;
    while (
      cycles < MAX_PASSIVE_SPAWN_CYCLES_PER_TICK &&
      this.hostileSpawnCycleAccumSec >= HOSTILE_MOB_SPAWN_INTERVAL_SEC
    ) {
      this.hostileSpawnCycleAccumSec -= HOSTILE_MOB_SPAWN_INTERVAL_SEC;
      cycles++;
      for (let i = 0; i < HOSTILE_SPAWN_ATTEMPTS_PER_CYCLE; i++) {
        void this.tryOneZombieSpawn(rng);
      }
    }
  }

  /** One random night zombie spawn on dark grass (loaded chunks near players). */
  private tryOneZombieSpawn(rng: GeneratorContext): number | null {
    if (this.mobs.size >= MOB_GLOBAL_CAP) {
      return null;
    }
    const coords = this.getSpawnCandidateChunks();
    if (coords.length === 0) {
      return null;
    }
    const pick = coords[Math.floor(rng.nextFloat() * coords.length)]!;
    const cx = pick[0];
    const wx = cx * CHUNK_SIZE + Math.floor(rng.nextFloat() * CHUNK_SIZE);
    if (this.world.isDesertColumn(wx)) {
      return null;
    }
    const surfaceY = this.world.getSurfaceHeight(wx);
    const grass = this.world.getRegistry().getByIdentifier("stratum:grass");
    const top = this.world.getBlock(wx, surfaceY);
    if (top.id !== grass.id) {
      return null;
    }
    const spawnLightWy = surfaceY + 1;
    const sky = this.world.getSkyLight(wx, spawnLightWy);
    const blk = this.world.getBlockLight(wx, spawnLightWy);
    if (combinedLight(sky, blk) > ZOMBIE_SPAWN_MAX_COMBINED_LIGHT) {
      return null;
    }
    const feetY = feetPxFromSurfaceBlockY(surfaceY);
    const x = (wx + 0.5) * BLOCK_SIZE;
    return this.spawnZombieAt(x, feetY, rng);
  }

  private pickNearestPlayerTarget(
    x: number,
    y: number,
    targets: ReadonlyArray<{ x: number; y: number; halfW: number; height: number }>,
  ): { x: number; y: number; halfW: number; height: number } | null {
    let best: { x: number; y: number; halfW: number; height: number } | null =
      null;
    let bestD = Number.POSITIVE_INFINITY;
    for (const t of targets) {
      const d2 = (x - t.x) ** 2 + (y - t.y) ** 2;
      if (d2 < bestD) {
        bestD = d2;
        best = t;
      }
    }
    return best;
  }

  private nearestPlayerDistanceSq(
    x: number,
    y: number,
    localPlayerFeet: { x: number; y: number },
  ): number {
    let best = (x - localPlayerFeet.x) ** 2 + (y - localPlayerFeet.y) ** 2;
    for (const rp of this.world.getRemotePlayers().values()) {
      const f = rp.getAuthorityFeet();
      const d2 = (x - f.x) ** 2 + (y - f.y) ** 2;
      if (d2 < best) {
        best = d2;
      }
    }
    return best;
  }

  private shouldDespawnByDistance(
    m: MobRecord,
    _dt: number,
    rng: GeneratorContext,
    localPlayerFeet: { x: number; y: number },
  ): boolean {
    if (m.persistent) {
      return false;
    }
    const d2 = this.nearestPlayerDistanceSq(m.x, m.y, localPlayerFeet);
    const dBlocksSq = d2 / (BLOCK_SIZE * BLOCK_SIZE);
    const simDist = Number(SIMULATION_DISTANCE_CHUNKS);

    // Immediate despawn by distance / simulation edge.
    // Note: fish have a shorter distance (40 blocks) but are not represented in this manager yet.
    if (simDist === 4) {
      if (dBlocksSq > 44 * 44) {
        return true;
      }
    } else if (simDist >= 6) {
      // "Edge of simulation": mob's chunk is not fully surrounded by 8 simulated neighbors.
      // We approximate "simulated last tick" as "currently loaded", which matches our sim model.
      const bx = Math.floor(m.x / BLOCK_SIZE);
      const by = Math.floor(m.y / BLOCK_SIZE);
      const cc = worldToChunk(bx, by);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          if (dx === 0 && dy === 0) continue;
          if (this.world.getChunk(cc.cx + dx, cc.cy + dy) === undefined) {
            return true;
          }
        }
      }
      if (dBlocksSq > 128 * 128) {
        return true;
      }
    } else {
      // Fallback for other simulation distances: keep the 128-block immediate cull.
      if (dBlocksSq > 128 * 128) {
        return true;
      }
    }

    // Random despawn chance.
    // More than 32 blocks away: 1/800 chance per game tick, only if undamaged for 30 seconds.
    if (dBlocksSq > 32 * 32 && m.noDamageSec >= 30) {
      if (rng.nextFloat() < 1 / 800) {
        return true;
      }
    }

    return false;
  }

  tickHost(
    dt: number,
    rng: GeneratorContext,
    worldTimeMs: number,
    localPlayerFeet: { x: number; y: number },
    zombiePlayerTargets: ReadonlyArray<{
      peerId: string | null;
      x: number;
      y: number;
    }>,
    onZombieHitPlayer?: (peerId: string | null, damage: number) => void,
  ): void {
    this.cullMobsInUnloadedChunks();
    this.passiveSpawnTick(dt, rng, worldTimeMs);
    this.hostileSpawnTick(dt, rng, worldTimeMs);

    const playerHalfW = PLAYER_WIDTH * 0.5;
    const chaseTargets: Array<{
      peerId: string | null;
      x: number;
      y: number;
      halfW: number;
      height: number;
    }> =
      zombiePlayerTargets.length > 0
        ? zombiePlayerTargets.map((t) => ({
            peerId: t.peerId,
            x: t.x,
            y: t.y,
            halfW: playerHalfW,
            height: PLAYER_HEIGHT,
          }))
        : [
            {
              peerId: null as string | null,
              x: localPlayerFeet.x,
              y: localPlayerFeet.y,
              halfW: playerHalfW,
              height: PLAYER_HEIGHT,
            },
          ];

    for (const m of this.mobs.values()) {
      m.noDamageSec += dt;
      if (m.deathAnimRemainSec > 0) {
        m.deathAnimRemainSec -= dt;
        if (m.deathAnimRemainSec <= 0) {
          this.removeMob(m.id, true);
        }
        continue;
      }
      if (this.shouldDespawnByDistance(m, dt, rng, localPlayerFeet)) {
        this.removeMob(m.id, true);
        continue;
      }
      if (m.kind === "sheep") {
        tickSheepPhysics(this.world, m, dt, rng, this.solidScratch);
      } else if (m.kind === "pig") {
        tickPigPhysics(this.world, m, dt, rng, this.solidScratch);
      } else {
        const target = this.pickNearestPlayerTarget(m.x, m.y, chaseTargets);
        tickZombiePhysics(this.world, m, dt, rng, this.solidScratch, target);
        // Hard stop: don't let zombie overlap the nearest player target even if physics tick
        // (step-up, large dt, etc.) would place it inside.
        if (target !== null) {
          const zHalfW = ZOMBIE_WIDTH_PX * 0.5;
          const zTop = m.y - ZOMBIE_HEIGHT_PX;
          const zBot = m.y;
          const pTop = target.y - target.height;
          const pBot = target.y;
          const verticalOverlap = zTop < pBot && zBot > pTop;
          if (verticalOverlap) {
            const dx = m.x - target.x;
            const overlapX = target.halfW + zHalfW - Math.abs(dx);
            if (overlapX > 0) {
              const pushDir = dx >= 0 ? 1 : -1;
              m.x += pushDir * (overlapX + 0.001);
              m.vx = 0;
              m.targetVx = 0;
            }
          }
        }
        m.attackCooldownRemainSec = Math.max(0, m.attackCooldownRemainSec - dt);
        m.attackSwingRemainSec = Math.max(0, m.attackSwingRemainSec - dt);
        m.burnRemainSec = Math.max(0, m.burnRemainSec - dt);

        // Daylight burning: after 10% of the daylight segment, if sky light is strong at the zombie's head cell,
        // apply periodic damage and show fire overlay.
        if (!m.inWater && isWorldTimeLateEnoughForSunBurn(worldTimeMs)) {
          const wx = Math.floor(m.x / BLOCK_SIZE);
          const headWy = Math.floor((m.y + 1) / BLOCK_SIZE);
          const sky = this.world.getSkyLight(wx, headWy);
          if (sky >= ZOMBIE_SUN_BURN_MIN_SKY_LIGHT) {
            m.burnRemainSec = ZOMBIE_SUN_BURN_VISUAL_REFRESH_SEC;
            m.burnDamageAccumSec += dt;
            while (m.burnDamageAccumSec >= ZOMBIE_SUN_BURN_DAMAGE_INTERVAL_SEC) {
              m.burnDamageAccumSec -= ZOMBIE_SUN_BURN_DAMAGE_INTERVAL_SEC;
              m.hp -= ZOMBIE_SUN_BURN_DAMAGE_PER_TICK;
              m.hurtRemainSec = 0.18;
              m.noDamageSec = 0;
            }
          } else {
            m.burnDamageAccumSec = 0;
          }
        } else {
          m.burnDamageAccumSec = 0;
        }
        if (
          onZombieHitPlayer !== undefined &&
          m.attackCooldownRemainSec <= 0
        ) {
          let hitPeer: string | null | undefined;
          let bestD = Number.POSITIVE_INFINITY;
          for (const t of chaseTargets) {
            if (
              !zombieFeetInMeleeRangeOfPlayerFeet(
                m.x,
                m.y,
                t.x,
                t.y,
                t.halfW,
                t.height,
              )
            ) {
              continue;
            }
            const d2 = (m.x - t.x) ** 2 + (m.y - t.y) ** 2;
            if (d2 < bestD) {
              bestD = d2;
              hitPeer = t.peerId;
            }
          }
          if (hitPeer !== undefined) {
            onZombieHitPlayer(hitPeer, ZOMBIE_ATTACK_DAMAGE);
            m.attackCooldownRemainSec = ZOMBIE_ATTACK_INTERVAL_SEC;
            m.attackSwingRemainSec = ZOMBIE_ATTACK_SWING_VISUAL_SEC;
          }
        }
      }
      if (m.hp <= 0 && m.kind === "sheep") {
        this.startSheepDeath(m, rng);
      } else if (m.hp <= 0 && m.kind === "pig") {
        this.startPigDeath(m, rng);
      } else if (m.hp <= 0 && m.kind === "zombie") {
        this.startZombieDeath(m, rng);
      }
    }

    this.broadcastCooldown += dt;
  }

  /**
   * Host: consume pending network work (spawn/despawn queues + dirty states). Call once per fixed tick after {@link tickHost}.
   */
  flushHostReplication(): {
    spawns: ReadonlyArray<{
      id: number;
      type: MobType;
      x: number;
      y: number;
      woolColor: number;
    }>;
    states: MobPublicView[];
    despawns: readonly number[];
  } {
    const spawns = this.pendingSpawn.splice(0, this.pendingSpawn.length);
    const despawns = this.pendingDespawn.splice(0, this.pendingDespawn.length);

    const states: MobPublicView[] = [];
    const force = this.broadcastCooldown >= 0.12;
    if (force) {
      this.broadcastCooldown = 0;
    }

    for (const m of this.mobs.values()) {
      const pub = toPublic(m);
      const sig = `${pub.x.toFixed(1)}|${pub.y.toFixed(1)}|${pub.vx.toFixed(1)}|${pub.vy.toFixed(1)}|${pub.hp}|${pub.facingRight ? 1 : 0}|${pub.panic ? 1 : 0}|${pub.hurt ? 1 : 0}|${pub.attacking ? 1 : 0}|${pub.burning ? 1 : 0}|${pub.woolColor}|${pub.deathAnimRemainSec.toFixed(2)}`;
      const prev = this.lastBroadcastSig.get(pub.id);
      if (force || prev !== sig) {
        this.lastBroadcastSig.set(pub.id, sig);
        states.push(pub);
      }
    }
    return { spawns, states, despawns };
  }


  applyNetworkSpawn(
    id: number,
    type: MobType,
    x: number,
    y: number,
    woolColor = 0,
  ): void {
    if (this.mobs.has(id)) {
      return;
    }
    let m: MobRecord;
    if (type === MobType.Sheep) {
      const wc = normalizeSheepWoolColor(woolColor);
      m = {
        kind: "sheep",
        id,
        x,
        y,
        vx: 0,
        vy: 0,
        hp: SHEEP_MAX_HEALTH,
        hurtRemainSec: 0,
        noDamageSec: 0,
        woolColor: wc,
        facingRight: true,
        targetVx: 0,
        panicRemainSec: 0,
        panicFlipTimerSec: 0,
        wanderTimerSec: 1,
        onGround: true,
        inWater: false,
        hitKnockVx: 0,
        damageInvulnRemainSec: 0,
        deathAnimRemainSec: 0,
        persistent: true,
        despawnFarSec: 0,
      };
    } else if (type === MobType.Pig) {
      m = {
        kind: "pig",
        id,
        x,
        y,
        vx: 0,
        vy: 0,
        hp: PIG_MAX_HEALTH,
        hurtRemainSec: 0,
        noDamageSec: 0,
        facingRight: true,
        targetVx: 0,
        panicRemainSec: 0,
        panicFlipTimerSec: 0,
        wanderTimerSec: 1,
        onGround: true,
        inWater: false,
        hitKnockVx: 0,
        damageInvulnRemainSec: 0,
        deathAnimRemainSec: 0,
        persistent: true,
        despawnFarSec: 0,
      };
    } else if (type === MobType.Zombie) {
      m = {
        kind: "zombie",
        id,
        x,
        y,
        vx: 0,
        vy: 0,
        hp: ZOMBIE_MAX_HEALTH,
        hurtRemainSec: 0,
        noDamageSec: 0,
        facingRight: true,
        targetVx: 0,
        wanderTimerSec: 1,
        onGround: true,
        inWater: false,
        hitKnockVx: 0,
        damageInvulnRemainSec: 0,
        deathAnimRemainSec: 0,
        persistent: true,
        despawnFarSec: 0,
        attackCooldownRemainSec: 0,
        attackSwingRemainSec: 0,
        burnRemainSec: 0,
        burnDamageAccumSec: 0,
      };
    } else {
      return;
    }
    this.mobs.set(id, m);
  }

  applyNetworkState(v: MobPublicView): void {
    const prev = this.mobs.get(v.id);
    if (
      v.type !== MobType.Sheep &&
      v.type !== MobType.Pig &&
      v.type !== MobType.Zombie
    ) {
      return;
    }
    const kind: "sheep" | "pig" | "zombie" =
      v.type === MobType.Sheep
        ? "sheep"
        : v.type === MobType.Pig
          ? "pig"
          : "zombie";
    const typeMismatch =
      prev === undefined ||
      (kind === "sheep" && prev.kind !== "sheep") ||
      (kind === "pig" && prev.kind !== "pig") ||
      (kind === "zombie" && prev.kind !== "zombie");
    if (typeMismatch) {
      const created: MobRecord =
        kind === "sheep"
          ? {
              kind: "sheep",
              id: v.id,
              x: v.x,
              y: v.y,
              vx: v.vx,
              vy: v.vy,
              hp: v.hp,
              hurtRemainSec: v.hurt ? 0.18 : 0,
              noDamageSec: 0,
              woolColor: v.woolColor,
              facingRight: v.facingRight,
              targetVx: 0,
              panicRemainSec: v.panic ? 0.1 : 0,
              panicFlipTimerSec: 0,
              wanderTimerSec: 1,
              onGround: true,
              inWater: false,
              hitKnockVx: 0,
              damageInvulnRemainSec: 0,
              deathAnimRemainSec: v.deathAnimRemainSec,
              persistent: false,
              despawnFarSec: 0,
            }
          : kind === "pig"
            ? {
                kind: "pig",
                id: v.id,
                x: v.x,
                y: v.y,
                vx: v.vx,
                vy: v.vy,
                hp: v.hp,
                hurtRemainSec: v.hurt ? 0.18 : 0,
                noDamageSec: 0,
                facingRight: v.facingRight,
                targetVx: 0,
                panicRemainSec: v.panic ? 0.1 : 0,
                panicFlipTimerSec: 0,
                wanderTimerSec: 1,
                onGround: true,
                inWater: false,
                hitKnockVx: 0,
                damageInvulnRemainSec: 0,
                deathAnimRemainSec: v.deathAnimRemainSec,
                persistent: false,
                despawnFarSec: 0,
              }
            : {
                kind: "zombie",
                id: v.id,
                x: v.x,
                y: v.y,
                vx: v.vx,
                vy: v.vy,
                hp: v.hp,
                hurtRemainSec: v.hurt ? 0.18 : 0,
                noDamageSec: 0,
                facingRight: v.facingRight,
                targetVx: 0,
                wanderTimerSec: 1,
                onGround: true,
                inWater: false,
                hitKnockVx: 0,
                damageInvulnRemainSec: 0,
                deathAnimRemainSec: v.deathAnimRemainSec,
                persistent: false,
                despawnFarSec: 0,
                attackCooldownRemainSec: 0,
                attackSwingRemainSec: v.attacking ? ZOMBIE_ATTACK_SWING_VISUAL_SEC : 0,
                burnRemainSec: v.burning ? ZOMBIE_SUN_BURN_VISUAL_REFRESH_SEC : 0,
                burnDamageAccumSec: 0,
              };
      this.mobs.set(v.id, created);
      return;
    }
    const m = prev;
    m.x = v.x;
    m.y = v.y;
    m.vx = v.vx;
    m.vy = v.vy;
    m.hp = v.hp;
    m.facingRight = v.facingRight;
    if (m.kind === "sheep" || m.kind === "pig") {
      m.panicRemainSec = v.panic ? 0.5 : 0;
    }
    m.hitKnockVx = 0;
    m.damageInvulnRemainSec = 0;
    if (m.kind === "zombie") {
      m.attackSwingRemainSec = v.attacking ? ZOMBIE_ATTACK_SWING_VISUAL_SEC : 0;
      m.burnRemainSec = v.burning ? ZOMBIE_SUN_BURN_VISUAL_REFRESH_SEC : 0;
    }
    if (m.kind === "sheep") {
      m.woolColor = v.woolColor;
    }
    m.deathAnimRemainSec = v.deathAnimRemainSec;
    if (v.hurt) {
      m.hurtRemainSec = 0.18;
    }
  }

  applyNetworkDespawn(id: number): void {
    this.removeMob(id, false);
  }

  /** Client: apply {@link MessageType.ENTITY_STATE} payload. */
  applyEntityStateFromWire(p: {
    entityId: number;
    entityType: number;
    x: number;
    y: number;
    vx: number;
    vy: number;
    hp: number;
    flags: number;
    woolColor?: number;
    deathAnim10Ms?: number;
  }): void {
    const facingRight = (p.flags & 1) !== 0;
    const panic = (p.flags & 2) !== 0;
    const walking = (p.flags & 4) !== 0;
    const hurt = (p.flags & 8) !== 0;
    const attacking = (p.flags & 16) !== 0;
    const burning = (p.flags & 32) !== 0;
    const deathAnimRemainSec = ((p.deathAnim10Ms ?? 0) & 0xff) * 0.01;
    this.applyNetworkState({
      id: p.entityId,
      type: p.entityType as MobType,
      x: p.x,
      y: p.y,
      vx: p.vx,
      vy: p.vy,
      hp: p.hp,
      facingRight,
      panic,
      walking,
      hurt,
      attacking,
      burning,
      woolColor: normalizeSheepWoolColor(p.woolColor),
      deathAnimRemainSec,
    });
  }

  damageMobFromHost(
    id: number,
    rng: GeneratorContext,
    attackerFeetX: number,
    damage = SHEEP_MELEE_DAMAGE,
    knockbackHorizontalPx = SHEEP_KNOCKBACK_HAND_PX,
    options?: { sprintKnockback?: boolean },
  ): boolean {
    const m = this.mobs.get(id);
    if (m === undefined) {
      return false;
    }
    if (m.deathAnimRemainSec > 0) {
      return false;
    }
    if (m.damageInvulnRemainSec > 0) {
      return false;
    }
    m.hp -= Math.max(0, Math.floor(damage));
    m.hurtRemainSec = 0.18;
    m.noDamageSec = 0;
    if (m.kind === "sheep") {
      m.damageInvulnRemainSec = SHEEP_DAMAGE_INVULN_SEC;
      applySheepKnockback(m, attackerFeetX, knockbackHorizontalPx, options);
      applySheepPanic(m, attackerFeetX, m.y);
    } else if (m.kind === "pig") {
      m.damageInvulnRemainSec = PIG_DAMAGE_INVULN_SEC;
      applyPigKnockback(m, attackerFeetX, knockbackHorizontalPx, options);
      applyPigPanic(m, attackerFeetX);
    } else {
      m.damageInvulnRemainSec = ZOMBIE_DAMAGE_INVULN_SEC;
      applyZombieKnockback(m, attackerFeetX, knockbackHorizontalPx, options);
    }
    if (m.hp <= 0 && m.kind === "sheep") {
      this.startSheepDeath(m, rng);
    } else if (m.hp <= 0 && m.kind === "pig") {
      this.startPigDeath(m, rng);
    } else if (m.hp <= 0 && m.kind === "zombie") {
      this.startZombieDeath(m, rng);
    }
    return true;
  }

  /**
   * Hit only if the crosshair (`aimX`/`aimY` in display / camera space, same as
   * `InputManager.mouseWorldPos`) lies inside the sheep physics AABB mapped to that space (same
   * mapping as `feetToScreenAABB` in `sheepPhysics.ts`). When several overlap, closest to the aim
   * point wins.
   */
  findMeleeTarget(
    feetX: number,
    feetY: number,
    aimX: number,
    aimY: number,
    reachBlocks: number,
  ): number | null {
    const reachPx = reachBlocks * BLOCK_SIZE;
    const feetDispY = -feetY;
    const rdx = aimX - feetX;
    const rdy = aimY - feetDispY;
    if (
      Math.abs(rdx) > reachPx ||
      Math.abs(rdy) > reachPx ||
      rdx * rdx + rdy * rdy > reachPx * reachPx
    ) {
      return null;
    }

    /** Tiny pad so edge pixels still register (display-space px). */
    const pad = 2;

    let best: { id: number; d2: number } | null = null;
    for (const m of this.mobs.values()) {
      if (m.deathAnimRemainSec > 0) {
        continue;
      }
      const halfW =
        (m.kind === "sheep"
          ? SHEEP_WIDTH_PX
          : m.kind === "pig"
            ? PIG_WIDTH_PX
            : ZOMBIE_WIDTH_PX) * 0.5;
      const h =
        m.kind === "sheep"
          ? SHEEP_HEIGHT_PX
          : m.kind === "pig"
            ? PIG_HEIGHT_PX
            : ZOMBIE_HEIGHT_PX;
      const left = m.x - halfW - pad;
      const right = m.x + halfW + pad;
      const top = -(m.y + h) - pad;
      const bottom = -m.y + pad;
      if (aimX < left || aimX > right || aimY < top || aimY > bottom) {
        continue;
      }
      const cx = m.x;
      const cy = -(m.y + h * 0.5);
      const d2 = (aimX - cx) ** 2 + (aimY - cy) ** 2;
      if (best === null || d2 < best.d2) {
        best = { id: m.id, d2 };
      }
    }
    return best?.id ?? null;
  }

  clear(): void {
    this.mobs.clear();
    this.sheepPerColumn.clear();
    this.pigPerColumn.clear();
    this.zombiePerColumn.clear();
    this.lastBroadcastSig.clear();
    this.pendingSpawn.length = 0;
    this.pendingDespawn.length = 0;
    this.passiveSpawnCycleAccumSec = 0;
  }
}
