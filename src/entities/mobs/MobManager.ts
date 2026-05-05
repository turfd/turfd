/**
 * Host-authoritative mobs with performance-focused lifecycle:
 * - **Hard global cap** ({@link MOB_GLOBAL_CAP})
 * - **Passive spawn cycles** (Minecraft-style: periodic attempts in loaded chunks **near players**,
 *   not tied to chunk generation—terrain is already there; we only roll spawns where chunks are loaded)
 * - **Hostile night spawns** (Terraria-inspired: player-anchored column band, inner safe-zone reject,
 *   local max hostiles + fill-based extra attempts — see `HOSTILE_LOCAL_MAX_SPAWNS` in mobConstants)
 * - **Immediate despawn** when the chunk under the mob unloads (no simulation off loaded terrain)
 * - **Chunk column index** for O(1) spawn density checks near a column
 */
import {
  BLOCK_SIZE,
  ITEM_HALF_EXTENT_PX,
  CHUNK_SIZE,
  PLAYER_HEIGHT,
  PLAYER_MELEE_CRIT_CHANCE,
  PLAYER_WIDTH,
  SIMULATION_DISTANCE_CHUNKS,
  WORLD_Y_MAX,
  WORLD_Y_MIN,
} from "../../core/constants";
import type { EventBus } from "../../core/EventBus";
import type { GameEvent } from "../../core/types";
import type { ItemId, ItemStack } from "../../core/itemDefinition";
import type { LootResolver } from "../../items/LootResolver";
import { worldToChunk } from "../../world/chunk/ChunkCoord";
import type { World } from "../../world/World";
import type { GeneratorContext } from "../../world/gen/GeneratorContext";
import { createAABB, type AABB } from "../physics/AABB";
import {
  DUCK_DAMAGE_INVULN_SEC,
  DUCK_DEATH_ANIM_SEC,
  DUCK_MAX_HEALTH,
  DUCK_MAX_PER_COLUMN,
  DUCK_SPAWN_MIN_COMBINED_LIGHT,
  DUCK_WIDTH_PX,
  HOSTILE_ACTIVE_COUNT_RADIUS_BLOCKS,
  HOSTILE_LEGACY_RANDOM_COLUMN_TRIES,
  HOSTILE_LOCAL_MAX_SPAWNS,
  HOSTILE_MOB_SPAWN_INTERVAL_SEC,
  HOSTILE_PLAYER_ANCHORED_COLUMN_TRIES,
  HOSTILE_SPAWN_ATTEMPTS_PER_CYCLE,
  HOSTILE_SPAWN_ATTEMPTS_PER_CYCLE_CAP,
  HOSTILE_SPAWN_MAX_DIST_BLOCKS_H,
  HOSTILE_SPAWN_MAX_DIST_BLOCKS_V,
  HOSTILE_ZOMBIE_CAVE_PREFERENCE_CHANCE,
  HOSTILE_SPAWN_SAFE_ZONE_BLOCKS_H,
  HOSTILE_SPAWN_SAFE_ZONE_BLOCKS_V,
  hostileSpawnAttemptMultiplierFromFill,
  MOB_GLOBAL_CAP,
  PASSIVE_CHUNK_SPAWN_RADIUS,
  PASSIVE_MOB_SPAWN_INTERVAL_SEC,
  PASSIVE_NATURAL_SPAWN_COLUMN_TRIES,
  PASSIVE_SPAWN_ATTEMPTS_PER_CYCLE,
  PASSIVE_SPAWN_MIN_PLAYER_DISTANCE_BLOCKS,
  PASSIVE_SPAWN_SURFACE_SCAN_DOWN_BLOCKS,
  PASSIVE_SPAWN_SURFACE_SCAN_UP_BLOCKS,
  PIG_DAMAGE_INVULN_SEC,
  PIG_DEATH_ANIM_SEC,
  PIG_MAX_HEALTH,
  PIG_MAX_PER_COLUMN,
  PIG_SPAWN_MIN_COMBINED_LIGHT,
  PIG_WIDTH_PX,
  SHEEP_DAMAGE_INVULN_SEC,
  SHEEP_DEATH_ANIM_SEC,
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
  ZOMBIE_SIGHT_RANGE_BLOCKS,
  SLIME_ATTACK_INTERVAL_SEC,
  SLIME_ATTACK_SWING_VISUAL_SEC,
  SLIME_DAMAGE_INVULN_SEC,
  SLIME_DEATH_ANIM_SEC,
  SLIME_HEIGHT_PX,
  SLIME_MAX_HEALTH,
  SLIME_MAX_PER_COLUMN,
  SLIME_SPAWN_ATTEMPTS_DAY,
  SLIME_SPAWN_ATTEMPTS_NIGHT,
  SLIME_SPAWN_INTERVAL_DAY_SEC,
  SLIME_SPAWN_INTERVAL_NIGHT_SEC,
  ZOMBIE_SPAWN_CAVE_MAX_COMBINED_LIGHT,
  ZOMBIE_SPAWN_SURFACE_MAX_COMBINED_LIGHT,
  ZOMBIE_WIDTH_PX,
  combinedLight,
  feetPxFromSurfaceBlockY,
  mobArrowStrikeAabbWorld,
  mobHitboxSizePx,
  isWorldTimeLateEnoughForSunBurn,
  isWorldTimeNightForPassiveSpawns,
  normalizeSlimeColor,
  slimeContactDamageForColor,
} from "./mobConstants";
import type { MobSpawnViewRect } from "./spawnViewRect";
import { naturalSpawnColumnOverlapsAnyViewRect } from "./spawnViewRect";
import {
  MobType,
  type MobDuckState,
  type MobPigState,
  type MobSheepState,
  type MobSlimeState,
  type MobZombieState,
} from "./mobTypes";
import { applyDuckPanic, tickDuckPhysics } from "./duckPhysics";
import { applyPigPanic, tickPigPhysics } from "./pigPhysics";
import {
  tickZombiePhysics,
  zombieFeetInMeleeRangeOfPlayerFeet,
} from "./zombiePhysics";
import {
  applySlimePanic,
  slimeFeetInMeleeRangeOfPlayerFeet,
  tickSlimePhysics,
} from "./slimePhysics";
import { applySheepPanic, tickSheepPhysics } from "./sheepPhysics";
import {
  applyTerrariaKnockbackToHostMob,
  terrariaArrowBaseKnockbackFromLegacyPx,
  type TerrariaMobStrike,
} from "./terrariaKnockback";
import {
  getWoolItemKeyForColor,
  normalizeSheepWoolColor,
  rollAnySheepWoolColor,
  rollNaturalSheepWoolColor,
} from "./sheepWool";
import {
  ENTITY_STATE_FLAG_SLIME_JUMP_PRIMING,
  ENTITY_STATE_FLAG_SLIME_ON_GROUND,
} from "../../network/protocol/messages";
import type { HostArrowStrikeResult } from "../ArrowProjectile";
import { segmentWorldAabbEnterTClamped01 } from "../physics/segmentWorldAabb";

/** Avoid huge catch-up bursts after a long pause (debugger / tab background). */
const MAX_PASSIVE_SPAWN_CYCLES_PER_TICK = 5;

export type MobRecord =
  | MobSheepState
  | MobPigState
  | MobDuckState
  | MobZombieState
  | MobSlimeState;

export type MobPublicView = Readonly<{
  id: number;
  type: MobType;
  x: number;
  y: number;
  vx: number;
  vy: number;
  hp: number;
  hurt: boolean;
  /** Zombie / slime: brief attack pose (swing or squash). */
  attacking: boolean;
  /** Zombie-only: currently burning in daylight (fire overlay). */
  burning: boolean;
  /** Sheep: dye ordinal 0–15. Slime: color tier 0–3 (wire overload). */
  woolColor: number;
  facingRight: boolean;
  panic: boolean;
  walking: boolean;
  /**
   * Slime: replicated ground contact for visuals / net.
   * Other mobs: always `false` (unused).
   */
  slimeOnGround: boolean;
  /**
   * Slime: wind-up before a hop (`ENTITY_STATE` bit7).
   * Other mobs: always `false`.
   */
  slimeJumpPriming: boolean;
  /** Seconds left in death pose (`0` = not dying). */
  deathAnimRemainSec: number;
}>;

function toPublic(m: MobRecord): MobPublicView {
  const dying = m.deathAnimRemainSec > 0;
  const panic =
    !dying &&
    (m.kind === "sheep" || m.kind === "pig" || m.kind === "duck" || m.kind === "slime") &&
    m.panicRemainSec > 0;
  const walking =
    !dying &&
    (m.kind === "slime"
      ? !m.onGround && !m.inWater && !m.slimeJumpPriming
      : Math.abs(m.vx) > 8 && (m.onGround || m.inWater));
  const type =
    m.kind === "sheep"
      ? MobType.Sheep
      : m.kind === "pig"
        ? MobType.Pig
        : m.kind === "duck"
          ? MobType.Duck
        : m.kind === "slime"
          ? MobType.Slime
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
    attacking:
      (m.kind === "zombie" || m.kind === "slime") && m.attackSwingRemainSec > 0,
    burning: m.kind === "zombie" && m.burnRemainSec > 0,
    woolColor:
      m.kind === "sheep" ? m.woolColor : m.kind === "slime" ? m.slimeColor : 0,
    facingRight: m.facingRight,
    panic,
    walking,
    slimeOnGround: m.kind === "slime" ? m.onGround : false,
    slimeJumpPriming: m.kind === "slime" ? m.slimeJumpPriming : false,
    deathAnimRemainSec: m.deathAnimRemainSec,
  };
}

export class MobManager {
  private readonly world: World;
  private readonly lootResolver: LootResolver;
  /** When set (solo/host), floating damage text is emitted on hits; clients infer from {@link applyNetworkState} HP deltas. */
  private readonly damageFxBus: EventBus | null;
  private readonly mobs = new Map<number, MobRecord>();
  /** Sheep count per world block column `wx` (spawn density). */
  private readonly sheepPerColumn = new Map<number, number>();
  /** Pig count per world block column `wx` (spawn density). */
  private readonly pigPerColumn = new Map<number, number>();
  /** Duck count per world block column `wx` (spawn density). */
  private readonly duckPerColumn = new Map<number, number>();
  /** Zombie count per world block column `wx` (spawn density). */
  private readonly zombiePerColumn = new Map<number, number>();
  /** Slime count per world block column `wx` (spawn density). */
  private readonly slimePerColumn = new Map<number, number>();
  private nextNetId = 1;
  private passiveSpawnCycleAccumSec = 0;
  private hostileSpawnCycleAccumSec = 0;
  private slimeSpawnCycleAccumSec = 0;
  /** Set only during {@link tickHost} natural spawn phases; `undefined` = skip view checks. */
  private spawnViewRectsForNaturalSpawn: ReadonlyArray<MobSpawnViewRect> | undefined =
    undefined;
  // DEV-only: hostile spawn rejection counters so "no spawns" is diagnosable.
  private _devHostileDebug = {
    cycles: 0,
    attempts: 0,
    rejectCapGlobal: 0,
    rejectMaxLocal: 0,
    rejectNoChunks: 0,
    rejectDesert: 0,
    /** Surface column had no valid standing spot (fluid, missing headroom, etc.). */
    rejectSurfaceTerrain: 0,
    /** Surface was too bright at night; no dark cave floor found under that column. */
    rejectSurfaceBright: 0,
    rejectPerColumnCap: 0,
    rejectVisible: 0,
    rejectSafeZone: 0,
    rejectSpawnBand: 0,
    spawned: 0,
    spawnedSurface: 0,
    spawnedCave: 0,
  };
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
  /** Host-only: attacker's feet X captured on lethal hit for death gib impulse direction. */
  private readonly deathKillerFeetX = new Map<number, number>();

  constructor(
    world: World,
    lootResolver: LootResolver,
    damageFxBus: EventBus | null = null,
  ) {
    this.world = world;
    this.lootResolver = lootResolver;
    this.damageFxBus = damageFxBus;
  }

  private emitMobDamageFx(
    kind: MobRecord["kind"],
    feetX: number,
    feetY: number,
    dealt: number,
  ): void {
    if (this.damageFxBus === null || dealt <= 0) {
      return;
    }
    const { h } = mobHitboxSizePx(kind);
    const jitter = (Math.random() - 0.5) * 16;
    this.damageFxBus.emit({
      type: "fx:damage-number",
      worldAnchorX: feetX + jitter,
      worldAnchorY: feetY + h * 0.52,
      damage: dealt,
    } satisfies GameEvent);
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
        p.type !== MobType.Duck &&
        p.type !== MobType.Zombie &&
        p.type !== MobType.Slime
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
        p.type === MobType.Slime
          ? {
              kind: "slime",
              id,
              x: p.x,
              y: p.y,
              vx: 0,
              vy: 0,
              hp: SLIME_MAX_HEALTH,
              hurtRemainSec: 0,
              noDamageSec: 0,
              slimeColor: normalizeSlimeColor(p.woolColor ?? 0),
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
              attackCooldownRemainSec: 0,
              attackSwingRemainSec: 0,
              slimeJumpPriming: false,
              slimeJumpPrimeElapsedSec: 0,
              slimeAirHorizVx: 0,
              slimeJumpDir: 0,
              slimeJumpCooldownRemainSec: 0,
              slimeChaseInvertRemainSec: 0,
              stuckItems: [],
            }
          : p.type === MobType.Sheep
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
            : p.type === MobType.Duck
              ? {
                  kind: "duck",
                  id,
                  x: p.x,
                  y: p.y,
                  vx: 0,
                  vy: 0,
                  hp: DUCK_MAX_HEALTH,
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
      } else if (m.kind === "duck") {
        this.duckPerColumn.set(wx, (this.duckPerColumn.get(wx) ?? 0) + 1);
      } else if (m.kind === "slime") {
        this.slimePerColumn.set(wx, (this.slimePerColumn.get(wx) ?? 0) + 1);
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

  /** O(1) live mob count (used by F3 HUD; avoids iterator allocation). */
  getCount(): number {
    return this.mobs.size;
  }

  getPublicViews(): MobPublicView[] {
    const out: MobPublicView[] = [];
    for (const m of this.mobs.values()) {
      out.push(toPublic(m));
    }
    return out;
  }

  /**
   * Count live mobs in pixel space within a Euclidean radius (no allocations).
   * Used by spawner tick; matches historical `getPublicViews().filter(...).length` distance check.
   */
  countMobsWithinPxRadiusSq(centerXPx: number, centerYPx: number, radiusSqPx: number): number {
    let n = 0;
    for (const m of this.mobs.values()) {
      const dx = m.x - centerXPx;
      const dy = m.y - centerYPx;
      if (dx * dx + dy * dy <= radiusSqPx) {
        n += 1;
      }
    }
    return n;
  }

  getById(id: number): MobRecord | undefined {
    return this.mobs.get(id);
  }

  /** Last attacker feet X used to start this mob's death, if known. */
  getDeathImpulseSourceX(id: number): number | null {
    const x = this.deathKillerFeetX.get(id);
    return typeof x === "number" && Number.isFinite(x) ? x : null;
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
    this.deathKillerFeetX.delete(id);
    this.world.removeArrowsStuckToMob(id);
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
    } else if (m.kind === "duck") {
      const n = this.duckPerColumn.get(wx) ?? 0;
      if (n <= 1) {
        this.duckPerColumn.delete(wx);
      } else {
        this.duckPerColumn.set(wx, n - 1);
      }
    } else if (m.kind === "slime") {
      const n = this.slimePerColumn.get(wx) ?? 0;
      if (n <= 1) {
        this.slimePerColumn.delete(wx);
      } else {
        this.slimePerColumn.set(wx, n - 1);
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

  /** Host/solo admin command: remove every active mob and queue replicated despawns. */
  despawnAll(): number {
    if (this.mobs.size === 0) {
      return 0;
    }
    const ids = [...this.mobs.keys()];
    for (const id of ids) {
      this.removeMob(id, true);
    }
    return ids.length;
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

  private dropDuckLoot(m: MobDuckState, rng: GeneratorContext): void {
    const px = m.x;
    const py = m.y + DUCK_WIDTH_PX * 0.25;
    const bonus = this.lootResolver.resolveEntityLoot(MobType.Duck, rng);
    for (const s of bonus) {
      this.spawnItemStackAt(s, px, py);
    }
  }

  private dropSlimeLoot(m: MobSlimeState, rng: GeneratorContext): void {
    const px = m.x;
    const py = m.y + mobHitboxSizePx("slime").h * 0.25;
    const bonus = this.lootResolver.resolveEntityLoot(MobType.Slime, rng);
    for (const s of bonus) {
      this.spawnItemStackAt(s, px, py);
    }
    for (const stuck of m.stuckItems) {
      this.world.spawnItem(stuck.itemId, stuck.count, px, py, 0, 0, stuck.damage);
    }
    m.stuckItems.length = 0;
  }

  /** Slimes absorb overlapping dropped items; absorbed stacks are dropped when the slime dies. */
  private absorbDroppedItemsForSlime(m: MobSlimeState): void {
    if (m.deathAnimRemainSec > 0 || m.hp <= 0 || m.stuckItems.length >= 24) {
      return;
    }
    const { w, h } = mobHitboxSizePx("slime");
    const left = m.x - w * 0.5;
    const right = m.x + w * 0.5;
    const top = m.y - h;
    const bottom = m.y;
    for (const [id, item] of this.world.getDroppedItems()) {
      const r = ITEM_HALF_EXTENT_PX;
      if (
        item.x + r < left ||
        item.x - r > right ||
        item.y + r < top ||
        item.y - r > bottom
      ) {
        continue;
      }
      m.stuckItems.push({
        itemId: item.itemId,
        count: item.count,
        damage: item.damage,
      });
      this.world.removeDroppedItemById(id);
      if (m.stuckItems.length >= 24) {
        break;
      }
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

  private startDuckDeath(m: MobDuckState, rng: GeneratorContext): void {
    if (m.deathAnimRemainSec > 0) {
      return;
    }
    this.dropDuckLoot(m, rng);
    m.hp = 0;
    m.deathAnimRemainSec = DUCK_DEATH_ANIM_SEC;
    m.vx = 0;
    m.vy = 0;
    m.targetVx = 0;
    m.panicRemainSec = 0;
    m.hitKnockVx = 0;
    m.damageInvulnRemainSec = 0;
  }

  private startSlimeDeath(m: MobSlimeState, rng: GeneratorContext): void {
    if (m.deathAnimRemainSec > 0) {
      return;
    }
    this.dropSlimeLoot(m, rng);
    m.hp = 0;
    m.deathAnimRemainSec = SLIME_DEATH_ANIM_SEC;
    m.vx = 0;
    m.vy = 0;
    m.targetVx = 0;
    m.panicRemainSec = 0;
    m.hitKnockVx = 0;
    m.damageInvulnRemainSec = 0;
    m.attackCooldownRemainSec = 0;
    m.attackSwingRemainSec = 0;
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

  spawnDuckAt(x: number, y: number, rng: GeneratorContext): number | null {
    if (this.mobs.size >= MOB_GLOBAL_CAP) {
      return null;
    }
    const wx = Math.floor(x / BLOCK_SIZE);
    if ((this.duckPerColumn.get(wx) ?? 0) >= DUCK_MAX_PER_COLUMN) {
      return null;
    }
    const id = this.nextNetId++;
    const m: MobDuckState = {
      kind: "duck",
      id,
      x,
      y,
      vx: 0,
      vy: 0,
      hp: DUCK_MAX_HEALTH,
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
    this.duckPerColumn.set(wx, (this.duckPerColumn.get(wx) ?? 0) + 1);
    this.pendingSpawn.push({ id, type: MobType.Duck, x, y, woolColor: 0 });
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

  spawnSummonedDuckAt(x: number, y: number, rng: GeneratorContext): number | null {
    const id = this.spawnDuckAt(x, y, rng);
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

  private rollNaturalSlimeColor(rng: GeneratorContext): number {
    const r = rng.nextFloat();
    if (r < 0.52) {
      return 0;
    }
    if (r < 0.78) {
      return 1;
    }
    if (r < 0.93) {
      return 2;
    }
    return 3;
  }

  spawnSlimeAt(
    x: number,
    y: number,
    rng: GeneratorContext,
    slimeColor?: number,
  ): number | null {
    if (this.mobs.size >= MOB_GLOBAL_CAP) {
      return null;
    }
    const wx = Math.floor(x / BLOCK_SIZE);
    if ((this.slimePerColumn.get(wx) ?? 0) >= SLIME_MAX_PER_COLUMN) {
      return null;
    }
    const id = this.nextNetId++;
    const color =
      slimeColor !== undefined
        ? normalizeSlimeColor(slimeColor)
        : this.rollNaturalSlimeColor(rng);
    const m: MobSlimeState = {
      kind: "slime",
      id,
      x,
      y,
      vx: 0,
      vy: 0,
      hp: SLIME_MAX_HEALTH,
      hurtRemainSec: 0,
      noDamageSec: 0,
      slimeColor: color,
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
      attackCooldownRemainSec: 0,
      attackSwingRemainSec: 0,
      slimeJumpPriming: false,
      slimeJumpPrimeElapsedSec: 0,
      slimeAirHorizVx: 0,
      slimeJumpDir: 0,
      slimeJumpCooldownRemainSec: 0,
      slimeChaseInvertRemainSec: 0,
      stuckItems: [],
    };
    this.mobs.set(id, m);
    this.slimePerColumn.set(wx, (this.slimePerColumn.get(wx) ?? 0) + 1);
    this.pendingSpawn.push({ id, type: MobType.Slime, x, y, woolColor: color });
    return id;
  }

  spawnSummonedSlimeAt(
    x: number,
    y: number,
    rng: GeneratorContext,
    slimeColor?: number,
  ): number | null {
    const id = this.spawnSlimeAt(x, y, rng, slimeColor);
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
    // Union of bounded iterations around each player centre — O(centres · R²) instead
    // of O(loadedChunks · centres). De-duplicate with a Set so nearby players don't
    // double-count overlapping chunks.
    const seen = new Set<number>();
    const out: Array<[number, number]> = [];
    const scratch: [number, number][] = [];
    for (const c of centres) {
      this.world.collectLoadedChunkCoordsWithinDistance(c.cx, c.cy, R, scratch);
      for (let i = 0; i < scratch.length; i++) {
        const cx = scratch[i]![0];
        const cy = scratch[i]![1];
        // Cantor-style pairing folds signed ints into a single Number safely up to ~1M.
        const key = ((cx + 1_048_576) * 2_097_152) + (cy + 1_048_576);
        if (!seen.has(key)) {
          seen.add(key);
          out.push([cx, cy]);
        }
      }
    }
    return out;
  }

  /**
   * Passives: allow spawn if far from any player **or** outside the camera frustum (wide views
   * would otherwise reject every column on flat terrain; tiny loads need the off-camera escape).
   */
  private passiveNaturalSpawnPlacementOk(
    feetX: number,
    feetY: number,
    bodyHeightPx: number,
    playerFeet: ReadonlyArray<{ x: number; y: number }>,
  ): boolean {
    let farFromAll = true;
    if (playerFeet.length > 0) {
      const r = PASSIVE_SPAWN_MIN_PLAYER_DISTANCE_BLOCKS * BLOCK_SIZE;
      const r2 = r * r;
      for (const p of playerFeet) {
        const dx = feetX - p.x;
        const dy = feetY - p.y;
        if (dx * dx + dy * dy < r2) {
          farFromAll = false;
          break;
        }
      }
    }
    if (farFromAll) {
      return true;
    }
    const rects = this.spawnViewRectsForNaturalSpawn;
    const inView =
      rects !== undefined &&
      rects.length > 0 &&
      naturalSpawnColumnOverlapsAnyViewRect(feetX, feetY, bodyHeightPx, rects);
    return !inView;
  }

  /**
   * Find a grass floor in column `wx` by scanning around the noise surface (handles platforms and
   * small surface mismatches vs {@link World.getSurfaceHeight} alone).
   */
  private findPassiveGrassSpawnInColumn(
    wx: number,
    grassId: number,
    reg: ReturnType<World["getRegistry"]>,
    waterId: number,
  ): { feetY: number; grassBlockY: number } | null {
    const refTop = this.world.getSurfaceHeight(wx);
    const yHi = Math.min(
      WORLD_Y_MAX - 3,
      refTop + PASSIVE_SPAWN_SURFACE_SCAN_UP_BLOCKS,
    );
    const yLo = Math.max(WORLD_Y_MIN, refTop - PASSIVE_SPAWN_SURFACE_SCAN_DOWN_BLOCKS);
    const isClear = (id: number): boolean =>
      !reg.isSolid(id) && (waterId === -1 || id !== waterId);

    for (let floorY = yHi; floorY >= yLo; floorY--) {
      const ground = this.world.getBlock(wx, floorY);
      if (ground.id !== grassId) {
        continue;
      }
      const a1 = this.world.getBlock(wx, floorY + 1);
      const a2 = this.world.getBlock(wx, floorY + 2);
      if (!isClear(a1.id) || !isClear(a2.id)) {
        continue;
      }
      return {
        feetY: feetPxFromSurfaceBlockY(floorY),
        grassBlockY: floorY,
      };
    }
    return null;
  }

  /**
   * Host-only: surface spawn attempt(s). Sheep **only** on `stratum:grass` with headroom, plus
   * light and caps. Scans columns around the noise surface for real grass; placement allows
   * spawns far from any player **or** off-camera when still nearby (avoids rejecting every column
   * on flat terrain or tiny loaded areas).
   */
  private tryOnePassiveMobSpawn(
    rng: GeneratorContext,
    playerFeet: ReadonlyArray<{ x: number; y: number }>,
  ): number | null {
    if (this.mobs.size >= MOB_GLOBAL_CAP) {
      return null;
    }
    const coords = this.getSpawnCandidateChunks();
    if (coords.length === 0) {
      return null;
    }
    const reg = this.world.getRegistry();
    const grass = reg.getByIdentifier("stratum:grass");
    const waterId = reg.isRegistered("stratum:water")
      ? reg.getByIdentifier("stratum:water").id
      : -1;
    for (let t = 0; t < PASSIVE_NATURAL_SPAWN_COLUMN_TRIES; t++) {
      const pick = coords[Math.floor(rng.nextFloat() * coords.length)]!;
      const cx = pick[0];
      const wx = cx * CHUNK_SIZE + Math.floor(rng.nextFloat() * CHUNK_SIZE);
      if (this.world.isDesertColumn(wx)) {
        continue;
      }
      const found = this.findPassiveGrassSpawnInColumn(wx, grass.id, reg, waterId);
      if (found === null) {
        continue;
      }
      const { feetY, grassBlockY } = found;
      const spawnLightWy = grassBlockY + 1;
      const sky = this.world.getSkyLight(wx, spawnLightWy);
      const blk = this.world.getBlockLight(wx, spawnLightWy);
      const x = (wx + 0.5) * BLOCK_SIZE;
      if (
        !this.passiveNaturalSpawnPlacementOk(
          x,
          feetY,
          SHEEP_HEIGHT_PX,
          playerFeet,
        )
      ) {
        continue;
      }
      const roll = rng.nextFloat();
      if (roll < 0.34) {
        if (combinedLight(sky, blk) < SHEEP_SPAWN_MIN_COMBINED_LIGHT) {
          continue;
        }
        const id = this.spawnSheepAt(x, feetY, rng);
        if (id !== null) {
          return id;
        }
        continue;
      }
      if (roll < 0.67) {
        if (combinedLight(sky, blk) < PIG_SPAWN_MIN_COMBINED_LIGHT) {
          continue;
        }
        const id = this.spawnPigAt(x, feetY, rng);
        if (id !== null) {
          return id;
        }
        continue;
      }
      if (combinedLight(sky, blk) < DUCK_SPAWN_MIN_COMBINED_LIGHT) {
        continue;
      }
      const id = this.spawnDuckAt(x, feetY, rng);
      if (id !== null) {
        return id;
      }
    }
    return null;
  }

  /**
   * Passive cycle: periodic spawn rolls in loaded chunks near players.
   * Timer does not advance at night — no burst spawns at dawn.
   */
  private passiveSpawnTick(
    dt: number,
    rng: GeneratorContext,
    worldTimeMs: number,
    playerFeet: ReadonlyArray<{ x: number; y: number }>,
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
        void this.tryOnePassiveMobSpawn(rng, playerFeet);
      }
    }
  }

  /**
   * Night-only hostile spawns (dark surface or dark caves under that column). Uses a separate timer
   * from passive spawns so toggling day/night does not dump extra cycles.
   */
  private hostileSpawnTick(
    dt: number,
    rng: GeneratorContext,
    worldTimeMs: number,
    playerFeet: ReadonlyArray<{ x: number; y: number }>,
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
      if (import.meta.env.DEV) {
        this._devHostileDebug.cycles += 1;
      }
      const near = this.countHostilesNearPlayers(playerFeet);
      const mult = hostileSpawnAttemptMultiplierFromFill(
        near,
        HOSTILE_LOCAL_MAX_SPAWNS,
      );
      const attempts = Math.min(
        HOSTILE_SPAWN_ATTEMPTS_PER_CYCLE_CAP,
        Math.max(
          1,
          Math.ceil(HOSTILE_SPAWN_ATTEMPTS_PER_CYCLE * mult),
        ),
      );
      for (let i = 0; i < attempts; i++) {
        void this.tryOneZombieSpawn(rng, playerFeet);
      }
    }
    if (import.meta.env.DEV && cycles > 0) {
      // Log once per tick where at least one hostile cycle ran (not per-attempt).
      console.debug("[MobManager] hostile spawn stats", { ...this._devHostileDebug });
      this._devHostileDebug = {
        cycles: 0,
        attempts: 0,
        rejectCapGlobal: 0,
        rejectMaxLocal: 0,
        rejectNoChunks: 0,
        rejectDesert: 0,
        rejectSurfaceTerrain: 0,
        rejectSurfaceBright: 0,
        rejectPerColumnCap: 0,
        rejectVisible: 0,
        rejectSafeZone: 0,
        rejectSpawnBand: 0,
        spawned: 0,
        spawnedSurface: 0,
        spawnedCave: 0,
      };
    }
  }

  /**
   * True if a zombie can stand on solid `floorBlockY` with headroom; `nightSkyZero` matches surface
   * night rolls (ignore propagated sky), underground uses real sky + block light.
   * @param maxCombinedLight reject when {@link combinedLight} at the mob air cell is **greater** than this.
   */
  private validateZombieSpawnFloor(
    wx: number,
    floorBlockY: number,
    reg: ReturnType<World["getRegistry"]>,
    airId: number,
    waterId: number,
    nightSkyZero: boolean,
    maxCombinedLight: number,
  ): "ok" | "terrain" | "bright" {
    const ground = this.world.getBlock(wx, floorBlockY);
    const above1 = this.world.getBlock(wx, floorBlockY + 1);
    const above2 = this.world.getBlock(wx, floorBlockY + 2);
    const isClear = (id: number): boolean =>
      !reg.isSolid(id) && (waterId === -1 || id !== waterId);
    if (
      !reg.isSolid(ground.id) ||
      ground.id === airId ||
      (waterId !== -1 && ground.id === waterId) ||
      !isClear(above1.id) ||
      !isClear(above2.id)
    ) {
      return "terrain";
    }
    const spawnLightWy = floorBlockY + 1;
    const blk = this.world.getBlockLight(wx, spawnLightWy);
    const sky = nightSkyZero
      ? 0
      : this.world.getSkyLight(wx, spawnLightWy);
    if (combinedLight(sky, blk) > maxCombinedLight) {
      return "bright";
    }
    return "ok";
  }

  /** Zombies + slimes near any player feet — drives Terraria-style local cap + spawn acceleration. */
  private countHostilesNearPlayers(
    playerFeet: ReadonlyArray<{ x: number; y: number }>,
  ): number {
    if (playerFeet.length === 0) {
      return 0;
    }
    const rPx = HOSTILE_ACTIVE_COUNT_RADIUS_BLOCKS * BLOCK_SIZE;
    const r2 = rPx * rPx;
    let n = 0;
    for (const m of this.mobs.values()) {
      if (m.deathAnimRemainSec > 0) {
        continue;
      }
      if (m.kind !== "zombie" && m.kind !== "slime") {
        continue;
      }
      let nearAny = false;
      for (const p of playerFeet) {
        const dx = m.x - p.x;
        const dy = m.y - p.y;
        if (dx * dx + dy * dy <= r2) {
          nearAny = true;
          break;
        }
      }
      if (nearAny) {
        n += 1;
      }
    }
    return n;
  }

  /** True when the spawn floor is **not** inside the inner safe rectangle of **any** player. */
  private hostileSpawnOutsideSafeZoneFromAllPlayers(
    wx: number,
    floorBlockY: number,
    playerFeet: ReadonlyArray<{ x: number; y: number }>,
  ): boolean {
    const h = HOSTILE_SPAWN_SAFE_ZONE_BLOCKS_H;
    const v = HOSTILE_SPAWN_SAFE_ZONE_BLOCKS_V;
    for (const p of playerFeet) {
      const pbx = Math.floor(p.x / BLOCK_SIZE);
      const pby = Math.floor(p.y / BLOCK_SIZE);
      if (Math.abs(wx - pbx) <= h && Math.abs(floorBlockY - pby) <= v) {
        return false;
      }
    }
    return true;
  }

  private hostileWithinSpawnBandFromAnchor(
    wx: number,
    floorBlockY: number,
    anchorBx: number,
    anchorBy: number,
  ): boolean {
    return (
      Math.abs(wx - anchorBx) <= HOSTILE_SPAWN_MAX_DIST_BLOCKS_H &&
      Math.abs(floorBlockY - anchorBy) <= HOSTILE_SPAWN_MAX_DIST_BLOCKS_V
    );
  }

  /**
   * Resolve one world column for a night hostile (zombie / cave night slime): valid floor, safe
   * zone, optional anchor band, then off-camera.
   */
  private trySpawnHostileAtColumn(
    wx: number,
    rng: GeneratorContext,
    reg: ReturnType<World["getRegistry"]>,
    airId: number,
    waterId: number,
    anchor: { bx: number; by: number } | null,
    playerFeet: ReadonlyArray<{ x: number; y: number }>,
  ):
    | {
        ok: true;
        x: number;
        feetY: number;
        floorY: number;
        surfaceY: number;
        fromCaveFallback: boolean;
      }
    | {
        ok: false;
        reason:
          | "desert"
          | "terrain"
          | "bright"
          | "band"
          | "safe"
          | "visible";
      } {
    if (this.world.isDesertColumn(wx)) {
      return { ok: false, reason: "desert" };
    }
    const syProbe = this.world.getSurfaceHeight(wx);
    const ccProbe = worldToChunk(wx, syProbe);
    if (this.world.getChunk(ccProbe.cx, ccProbe.cy) === undefined) {
      return { ok: false, reason: "terrain" };
    }
    let refTop = this.world.getSurfaceHeight(wx);
    let ground = this.world.getBlock(wx, refTop);
    if (!reg.isSolid(ground.id) || ground.id === airId) {
      refTop -= 1;
      ground = this.world.getBlock(wx, refTop);
    }

    /** Walk down the column: plants/trees often block headroom at the noise “surface” row only. */
    let surfaceFloor: number | null = null;
    for (let dy = 0; dy <= 10; dy++) {
      const tryFloor = refTop - dy;
      if (tryFloor < WORLD_Y_MIN) {
        break;
      }
      if (
        this.validateZombieSpawnFloor(
          wx,
          tryFloor,
          reg,
          airId,
          waterId,
          true,
          ZOMBIE_SPAWN_SURFACE_MAX_COMBINED_LIGHT,
        ) === "ok"
      ) {
        surfaceFloor = tryFloor;
        break;
      }
    }

    const surfaceCheck = this.validateZombieSpawnFloor(
      wx,
      refTop,
      reg,
      airId,
      waterId,
      true,
      ZOMBIE_SPAWN_SURFACE_MAX_COMBINED_LIGHT,
    );

    let caveFloor: number | null = null;
    if (surfaceFloor === null) {
      const maxFloor = refTop - 4;
      if (maxFloor >= WORLD_Y_MIN) {
        const span = maxFloor - WORLD_Y_MIN + 1;
        for (let i = 0; i < 28; i++) {
          const tryY = WORLD_Y_MIN + Math.floor(rng.nextFloat() * span);
          if (
            this.validateZombieSpawnFloor(
              wx,
              tryY,
              reg,
              airId,
              waterId,
              false,
              ZOMBIE_SPAWN_CAVE_MAX_COMBINED_LIGHT,
            ) === "ok"
          ) {
            caveFloor = tryY;
            break;
          }
        }
      }
    }

    let floorY: number | null = null;
    let fromCaveFallback = false;
    if (surfaceFloor !== null && caveFloor !== null) {
      const useCave = rng.nextFloat() < HOSTILE_ZOMBIE_CAVE_PREFERENCE_CHANCE;
      floorY = useCave ? caveFloor : surfaceFloor;
      fromCaveFallback = useCave;
    } else if (surfaceFloor !== null) {
      floorY = surfaceFloor;
    } else if (caveFloor !== null) {
      floorY = caveFloor;
      fromCaveFallback = true;
    } else {
      return {
        ok: false,
        reason: surfaceCheck === "terrain" ? "terrain" : "bright",
      };
    }
    if (
      anchor !== null &&
      !this.hostileWithinSpawnBandFromAnchor(
        wx,
        floorY,
        anchor.bx,
        anchor.by,
      )
    ) {
      return { ok: false, reason: "band" };
    }
    if (
      playerFeet.length > 0 &&
      !this.hostileSpawnOutsideSafeZoneFromAllPlayers(wx, floorY, playerFeet)
    ) {
      return { ok: false, reason: "safe" };
    }
    const feetY = feetPxFromSurfaceBlockY(floorY);
    const x = (wx + 0.5) * BLOCK_SIZE;
    if (
      naturalSpawnColumnOverlapsAnyViewRect(
        x,
        feetY,
        ZOMBIE_HEIGHT_PX,
        this.spawnViewRectsForNaturalSpawn,
      )
    ) {
      return { ok: false, reason: "visible" };
    }
    return {
      ok: true,
      x,
      feetY,
      floorY,
      surfaceY: refTop,
      fromCaveFallback,
    };
  }

  private pickHostileSpawnFeet(
    rng: GeneratorContext,
    playerFeet: ReadonlyArray<{ x: number; y: number }>,
  ):
    | {
        ok: true;
        x: number;
        feetY: number;
        floorY: number;
        surfaceY: number;
        fromCaveFallback: boolean;
      }
    | {
        ok: false;
        reason:
          | "globcap"
          | "maxlocal"
          | "nochunks"
          | "desert"
          | "terrain"
          | "bright"
          | "visible"
          | "band"
          | "safe";
      } {
    if (this.mobs.size >= MOB_GLOBAL_CAP) {
      return { ok: false, reason: "globcap" };
    }
    if (
      playerFeet.length > 0 &&
      this.countHostilesNearPlayers(playerFeet) >= HOSTILE_LOCAL_MAX_SPAWNS
    ) {
      return { ok: false, reason: "maxlocal" };
    }
    const coords = this.getSpawnCandidateChunks();
    if (coords.length === 0) {
      return { ok: false, reason: "nochunks" };
    }
    const reg = this.world.getRegistry();
    const airId = reg.getByIdentifier("stratum:air").id;
    const waterId = reg.isRegistered("stratum:water")
      ? reg.getByIdentifier("stratum:water").id
      : -1;

    const span = HOSTILE_SPAWN_MAX_DIST_BLOCKS_H * 2 + 1;
    if (playerFeet.length > 0) {
      for (let t = 0; t < HOSTILE_PLAYER_ANCHORED_COLUMN_TRIES; t++) {
        const anchorFeet =
          playerFeet[Math.floor(rng.nextFloat() * playerFeet.length)]!;
        const anchorBx = Math.floor(anchorFeet.x / BLOCK_SIZE);
        const anchorBy = Math.floor(anchorFeet.y / BLOCK_SIZE);
        const dx =
          Math.floor(rng.nextFloat() * span) - HOSTILE_SPAWN_MAX_DIST_BLOCKS_H;
        const wx = anchorBx + dx;
        const r = this.trySpawnHostileAtColumn(
          wx,
          rng,
          reg,
          airId,
          waterId,
          { bx: anchorBx, by: anchorBy },
          playerFeet,
        );
        if (r.ok) {
          return r;
        }
      }
    }

    for (let t = 0; t < HOSTILE_LEGACY_RANDOM_COLUMN_TRIES; t++) {
      const pick = coords[Math.floor(rng.nextFloat() * coords.length)]!;
      const cx = pick[0];
      const wx = cx * CHUNK_SIZE + Math.floor(rng.nextFloat() * CHUNK_SIZE);
      const r = this.trySpawnHostileAtColumn(
        wx,
        rng,
        reg,
        airId,
        waterId,
        null,
        playerFeet,
      );
      if (r.ok) {
        return r;
      }
    }
    return { ok: false, reason: "terrain" };
  }

  /**
   * One random night zombie spawn: prefers the column’s surface when valid; dark caves below only as
   * a fallback (loaded chunks near players).
   */
  private tryOneZombieSpawn(
    rng: GeneratorContext,
    playerFeet: ReadonlyArray<{ x: number; y: number }>,
  ): number | null {
    if (import.meta.env.DEV) {
      this._devHostileDebug.attempts += 1;
    }
    const p = this.pickHostileSpawnFeet(rng, playerFeet);
    if (!p.ok) {
      if (import.meta.env.DEV) {
        if (p.reason === "globcap") {
          this._devHostileDebug.rejectCapGlobal += 1;
        } else if (p.reason === "maxlocal") {
          this._devHostileDebug.rejectMaxLocal += 1;
        } else if (p.reason === "nochunks") {
          this._devHostileDebug.rejectNoChunks += 1;
        } else if (p.reason === "desert") {
          this._devHostileDebug.rejectDesert += 1;
        } else if (p.reason === "visible") {
          this._devHostileDebug.rejectVisible += 1;
        } else if (p.reason === "band") {
          this._devHostileDebug.rejectSpawnBand += 1;
        } else if (p.reason === "safe") {
          this._devHostileDebug.rejectSafeZone += 1;
        } else if (p.reason === "terrain") {
          this._devHostileDebug.rejectSurfaceTerrain += 1;
        } else {
          this._devHostileDebug.rejectSurfaceBright += 1;
        }
      }
      return null;
    }
    const spawned = this.spawnZombieAt(p.x, p.feetY, rng);
    if (import.meta.env.DEV) {
      if (spawned === null) {
        this._devHostileDebug.rejectPerColumnCap += 1;
      } else {
        this._devHostileDebug.spawned += 1;
        if (p.fromCaveFallback) {
          this._devHostileDebug.spawnedCave += 1;
        } else {
          this._devHostileDebug.spawnedSurface += 1;
        }
      }
    }
    return spawned;
  }

  /** Night slimes: same footing rules as zombies (dark surface / caves). */
  private tryOneSlimeSpawnNight(
    rng: GeneratorContext,
    playerFeet: ReadonlyArray<{ x: number; y: number }>,
  ): number | null {
    const p = this.pickHostileSpawnFeet(rng, playerFeet);
    if (!p.ok) {
      return null;
    }
    return this.spawnSlimeAt(p.x, p.feetY, rng);
  }

  /** Day slimes: grass columns with passive-style light (rarer than night). */
  private tryOneSlimeSpawnDay(
    rng: GeneratorContext,
    playerFeet: ReadonlyArray<{ x: number; y: number }>,
  ): number | null {
    if (this.mobs.size >= MOB_GLOBAL_CAP) {
      return null;
    }
    const coords = this.getSpawnCandidateChunks();
    if (coords.length === 0) {
      return null;
    }
    const reg = this.world.getRegistry();
    const grass = reg.getByIdentifier("stratum:grass");
    const waterId = reg.isRegistered("stratum:water")
      ? reg.getByIdentifier("stratum:water").id
      : -1;
    for (let t = 0; t < PASSIVE_NATURAL_SPAWN_COLUMN_TRIES; t++) {
      const pick = coords[Math.floor(rng.nextFloat() * coords.length)]!;
      const cx = pick[0];
      const wx = cx * CHUNK_SIZE + Math.floor(rng.nextFloat() * CHUNK_SIZE);
      if (this.world.isDesertColumn(wx)) {
        continue;
      }
      const found = this.findPassiveGrassSpawnInColumn(wx, grass.id, reg, waterId);
      if (found === null) {
        continue;
      }
      const { feetY, grassBlockY } = found;
      const spawnLightWy = grassBlockY + 1;
      const sky = this.world.getSkyLight(wx, spawnLightWy);
      const blk = this.world.getBlockLight(wx, spawnLightWy);
      if (combinedLight(sky, blk) < PIG_SPAWN_MIN_COMBINED_LIGHT) {
        continue;
      }
      const x = (wx + 0.5) * BLOCK_SIZE;
      if (
        !this.passiveNaturalSpawnPlacementOk(
          x,
          feetY,
          SLIME_HEIGHT_PX,
          playerFeet,
        )
      ) {
        continue;
      }
      const id = this.spawnSlimeAt(x, feetY, rng);
      if (id !== null) {
        return id;
      }
    }
    return null;
  }

  private slimeSpawnTick(
    dt: number,
    rng: GeneratorContext,
    worldTimeMs: number,
    playerFeet: ReadonlyArray<{ x: number; y: number }>,
  ): void {
    const night = isWorldTimeNightForPassiveSpawns(worldTimeMs);
    const interval = night
      ? SLIME_SPAWN_INTERVAL_NIGHT_SEC
      : SLIME_SPAWN_INTERVAL_DAY_SEC;
    const attempts = night
      ? SLIME_SPAWN_ATTEMPTS_NIGHT
      : SLIME_SPAWN_ATTEMPTS_DAY;
    this.slimeSpawnCycleAccumSec += dt;
    let cycles = 0;
    while (
      cycles < MAX_PASSIVE_SPAWN_CYCLES_PER_TICK &&
      this.slimeSpawnCycleAccumSec >= interval
    ) {
      this.slimeSpawnCycleAccumSec -= interval;
      cycles++;
      for (let i = 0; i < attempts; i++) {
        if (night) {
          void this.tryOneSlimeSpawnNight(rng, playerFeet);
        } else {
          void this.tryOneSlimeSpawnDay(rng, playerFeet);
        }
      }
    }
  }

  private getMobHitboxAABB(m: MobRecord): AABB {
    const { w, h } = mobHitboxSizePx(m.kind);
    return createAABB(m.x - w * 0.5, -(m.y + h), w, h);
  }

  /**
   * Soft separation pass for hostiles (zombies/slimes): no hard body-blocking while pathing,
   * but also no visible "stacking" into the same space near players.
   */
  private resolveHostileInterpenetration(): void {
    const hostiles: Array<MobZombieState | MobSlimeState> = [];
    for (const m of this.mobs.values()) {
      if (m.deathAnimRemainSec > 0 || m.hp <= 0) {
        continue;
      }
      if (m.kind === "zombie" || m.kind === "slime") {
        hostiles.push(m);
      }
    }
    if (hostiles.length < 2) {
      return;
    }

    for (let i = 0; i < hostiles.length - 1; i++) {
      const a = hostiles[i]!;
      const aSize = mobHitboxSizePx(a.kind);
      const aHalfW = aSize.w * 0.5;
      const aTop = a.y - aSize.h;
      const aBot = a.y;
      for (let j = i + 1; j < hostiles.length; j++) {
        const b = hostiles[j]!;
        const bSize = mobHitboxSizePx(b.kind);
        const bHalfW = bSize.w * 0.5;
        const bTop = b.y - bSize.h;
        const bBot = b.y;

        const overlapY = Math.min(aBot, bBot) - Math.max(aTop, bTop);
        if (overlapY <= 0) {
          continue;
        }

        const dx = a.x - b.x;
        const overlapX = aHalfW + bHalfW - Math.abs(dx);
        if (overlapX <= 0) {
          continue;
        }

        // Horizontal-only de-overlap keeps hostiles from body-blocking one another,
        // while still preventing same-space stacking.
        const dir = dx !== 0 ? (dx > 0 ? 1 : -1) : (a.id > b.id ? 1 : -1);
        const sep = overlapX + 0.001;
        const push = sep * 0.5;
        a.x += dir * push;
        b.x -= dir * push;

        a.vx = 0;
        b.vx = 0;
        if (a.kind === "slime") {
          a.slimeAirHorizVx = 0;
        }
        if (b.kind === "slime") {
          b.slimeAirHorizVx = 0;
        }
      }
    }
  }

  /**
   * Returns true if any living mob overlaps the given AABB.
   * Used to prevent block placement inside mobs.
   */
  anyMobOverlapsAABB(aabb: AABB): boolean {
    for (const m of this.mobs.values()) {
      if (m.deathAnimRemainSec > 0) {
        continue;
      }
      const mobAabb = this.getMobHitboxAABB(m);
      if (
        aabb.x < mobAabb.x + mobAabb.width &&
        aabb.x + aabb.width > mobAabb.x &&
        aabb.y < mobAabb.y + mobAabb.height &&
        aabb.y + aabb.height > mobAabb.y
      ) {
        return true;
      }
    }
    return false;
  }

  private pickNearestPlayerTarget(
    x: number,
    y: number,
    targets: ReadonlyArray<{ x: number; y: number; halfW: number; height: number }>,
  ): { x: number; y: number; halfW: number; height: number } | null {
    let best: { x: number; y: number; halfW: number; height: number } | null =
      null;
    let bestD = Number.POSITIVE_INFINITY;
    const maxDistPx = ZOMBIE_SIGHT_RANGE_BLOCKS * BLOCK_SIZE;
    const maxDistSq = maxDistPx * maxDistPx;
    for (const t of targets) {
      const d2 = (x - t.x) ** 2 + (y - t.y) ** 2;
      if (d2 < bestD && d2 <= maxDistSq) {
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
    spawnViewRects?: ReadonlyArray<MobSpawnViewRect>,
  ): void {
    this.spawnViewRectsForNaturalSpawn = spawnViewRects;
    const playerSpawnFeet: ReadonlyArray<{ x: number; y: number }> =
      zombiePlayerTargets.length > 0
        ? zombiePlayerTargets.map((t) => ({ x: t.x, y: t.y }))
        : [{ x: localPlayerFeet.x, y: localPlayerFeet.y }];
    try {
      this.cullMobsInUnloadedChunks();
      this.passiveSpawnTick(dt, rng, worldTimeMs, playerSpawnFeet);
      this.hostileSpawnTick(dt, rng, worldTimeMs, playerSpawnFeet);
      this.slimeSpawnTick(dt, rng, worldTimeMs, playerSpawnFeet);
    } finally {
      this.spawnViewRectsForNaturalSpawn = undefined;
    }

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
        : [];

    const worldTimeSec = worldTimeMs / 1000;

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
        tickSheepPhysics(this.world, m, dt, rng, this.solidScratch, worldTimeSec);
      } else if (m.kind === "pig") {
        tickPigPhysics(this.world, m, dt, rng, this.solidScratch, worldTimeSec);
      } else if (m.kind === "duck") {
        tickDuckPhysics(this.world, m, dt, rng, this.solidScratch, worldTimeSec);
      } else if (m.kind === "slime") {
        const slimeTarget = this.pickNearestPlayerTarget(m.x, m.y, chaseTargets);
        tickSlimePhysics(
          this.world,
          m,
          dt,
          rng,
          this.solidScratch,
          slimeTarget,
          worldTimeSec,
        );
        this.absorbDroppedItemsForSlime(m);
        if (slimeTarget !== null) {
          const { w: slimeW, h: slimeH } = mobHitboxSizePx("slime");
          const sHalfW = slimeW * 0.5;
          const sTop = m.y - slimeH;
          const sBot = m.y;
          const pTop = slimeTarget.y - slimeTarget.height;
          const pBot = slimeTarget.y;
          const verticalOverlap = sTop < pBot && sBot > pTop;
          if (verticalOverlap) {
            const dx = m.x - slimeTarget.x;
            const overlapX = slimeTarget.halfW + sHalfW - Math.abs(dx);
            if (overlapX > 0) {
              const pushDir = dx >= 0 ? 1 : -1;
              m.x += pushDir * (overlapX + 0.001);
              m.vx = 0;
              m.targetVx = 0;
              // Hop arc lives in `slimeAirHorizVx`; clearing only `vx` leaves full charge speed.
              m.slimeAirHorizVx = 0;
              m.slimeJumpPriming = false;
              m.slimeJumpPrimeElapsedSec = 0;
            }
          }
        }
        m.attackCooldownRemainSec = Math.max(0, m.attackCooldownRemainSec - dt);
        m.attackSwingRemainSec = Math.max(0, m.attackSwingRemainSec - dt);
        if (onZombieHitPlayer !== undefined && m.attackCooldownRemainSec <= 0) {
          let hitPeer: string | null | undefined;
          let bestD = Number.POSITIVE_INFINITY;
          for (const t of chaseTargets) {
            if (
              !slimeFeetInMeleeRangeOfPlayerFeet(
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
            onZombieHitPlayer(
              hitPeer,
              slimeContactDamageForColor(m.slimeColor),
            );
            m.attackCooldownRemainSec = SLIME_ATTACK_INTERVAL_SEC;
            m.attackSwingRemainSec = SLIME_ATTACK_SWING_VISUAL_SEC;
          }
        }
      } else {
        const target = this.pickNearestPlayerTarget(m.x, m.y, chaseTargets);
        tickZombiePhysics(
          this.world,
          m,
          dt,
          rng,
          this.solidScratch,
          worldTimeSec,
          target,
        );
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
              const burn = ZOMBIE_SUN_BURN_DAMAGE_PER_TICK;
              m.hp -= burn;
              this.emitMobDamageFx("zombie", m.x, m.y, burn);
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
      } else if (m.hp <= 0 && m.kind === "duck") {
        this.startDuckDeath(m, rng);
      } else if (m.hp <= 0 && m.kind === "zombie") {
        this.startZombieDeath(m, rng);
      } else if (m.hp <= 0 && m.kind === "slime") {
        this.startSlimeDeath(m, rng);
      }
    }

    this.resolveHostileInterpenetration();

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
      const sig = `${pub.x.toFixed(1)}|${pub.y.toFixed(1)}|${pub.vx.toFixed(1)}|${pub.vy.toFixed(1)}|${pub.hp}|${pub.facingRight ? 1 : 0}|${pub.panic ? 1 : 0}|${pub.hurt ? 1 : 0}|${pub.attacking ? 1 : 0}|${pub.burning ? 1 : 0}|${pub.woolColor}|${pub.deathAnimRemainSec.toFixed(2)}|${pub.walking ? 1 : 0}|${pub.slimeOnGround ? 1 : 0}|${pub.slimeJumpPriming ? 1 : 0}`;
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
    } else if (type === MobType.Duck) {
      m = {
        kind: "duck",
        id,
        x,
        y,
        vx: 0,
        vy: 0,
        hp: DUCK_MAX_HEALTH,
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
    } else if (type === MobType.Slime) {
      m = {
        kind: "slime",
        id,
        x,
        y,
        vx: 0,
        vy: 0,
        hp: SLIME_MAX_HEALTH,
        hurtRemainSec: 0,
        noDamageSec: 0,
        slimeColor: normalizeSlimeColor(woolColor),
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
        attackCooldownRemainSec: 0,
        attackSwingRemainSec: 0,
        slimeJumpPriming: false,
        slimeJumpPrimeElapsedSec: 0,
        slimeAirHorizVx: 0,
        slimeJumpDir: 0,
        slimeJumpCooldownRemainSec: 0,
        slimeChaseInvertRemainSec: 0,
        stuckItems: [],
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
      v.type !== MobType.Duck &&
      v.type !== MobType.Zombie &&
      v.type !== MobType.Slime
    ) {
      return;
    }
    const kind: "sheep" | "pig" | "duck" | "zombie" | "slime" =
      v.type === MobType.Sheep
        ? "sheep"
        : v.type === MobType.Pig
          ? "pig"
          : v.type === MobType.Duck
            ? "duck"
          : v.type === MobType.Slime
            ? "slime"
            : "zombie";
    const typeMismatch =
      prev === undefined ||
      (kind === "sheep" && prev.kind !== "sheep") ||
      (kind === "pig" && prev.kind !== "pig") ||
      (kind === "duck" && prev.kind !== "duck") ||
      (kind === "zombie" && prev.kind !== "zombie") ||
      (kind === "slime" && prev.kind !== "slime");
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
            : kind === "duck"
              ? {
                  kind: "duck",
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
            : kind === "slime"
              ? {
                  kind: "slime",
                  id: v.id,
                  x: v.x,
                  y: v.y,
                  vx: v.vx,
                  vy: v.vy,
                  hp: v.hp,
                  hurtRemainSec: v.hurt ? 0.18 : 0,
                  noDamageSec: 0,
                  slimeColor: normalizeSlimeColor(v.woolColor),
                  facingRight: v.facingRight,
                  targetVx: 0,
                  panicRemainSec: v.panic ? 0.1 : 0,
                  panicFlipTimerSec: 0,
                  wanderTimerSec: 1,
                  onGround: v.slimeOnGround,
                  inWater: false,
                  hitKnockVx: 0,
                  damageInvulnRemainSec: 0,
                  deathAnimRemainSec: v.deathAnimRemainSec,
                  persistent: false,
                  despawnFarSec: 0,
                  attackCooldownRemainSec: 0,
                  attackSwingRemainSec: v.attacking
                    ? SLIME_ATTACK_SWING_VISUAL_SEC
                    : 0,
                  slimeJumpPriming: v.slimeJumpPriming,
                  slimeJumpPrimeElapsedSec: 0,
                  slimeAirHorizVx: 0,
                  slimeJumpDir: 0,
                  slimeJumpCooldownRemainSec: 0,
                  slimeChaseInvertRemainSec: 0,
                  stuckItems: [],
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
                  attackSwingRemainSec: v.attacking
                    ? ZOMBIE_ATTACK_SWING_VISUAL_SEC
                    : 0,
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
    if (m.kind === "sheep" || m.kind === "pig" || m.kind === "duck" || m.kind === "slime") {
      m.panicRemainSec = v.panic ? 0.5 : 0;
    }
    m.hitKnockVx = 0;
    m.damageInvulnRemainSec = 0;
    if (m.kind === "zombie") {
      m.attackSwingRemainSec = v.attacking ? ZOMBIE_ATTACK_SWING_VISUAL_SEC : 0;
      m.burnRemainSec = v.burning ? ZOMBIE_SUN_BURN_VISUAL_REFRESH_SEC : 0;
    }
    if (m.kind === "slime") {
      m.attackSwingRemainSec = v.attacking ? SLIME_ATTACK_SWING_VISUAL_SEC : 0;
      m.slimeColor = normalizeSlimeColor(v.woolColor);
      m.onGround = v.slimeOnGround;
      m.slimeJumpPriming = v.slimeJumpPriming;
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
    const et = p.entityType as MobType;
    const slimeOnGround =
      et === MobType.Slime ? (p.flags & ENTITY_STATE_FLAG_SLIME_ON_GROUND) !== 0 : false;
    const slimeJumpPriming =
      et === MobType.Slime ? (p.flags & ENTITY_STATE_FLAG_SLIME_JUMP_PRIMING) !== 0 : false;
    this.applyNetworkState({
      id: p.entityId,
      type: et,
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
      woolColor:
        et === MobType.Sheep
          ? normalizeSheepWoolColor(p.woolColor)
          : et === MobType.Slime
            ? normalizeSlimeColor(p.woolColor ?? 0)
            : 0,
      deathAnimRemainSec,
      slimeOnGround,
      slimeJumpPriming,
    });
  }

  damageMobFromHost(
    id: number,
    rng: GeneratorContext,
    attackerFeetX: number,
    damage = SHEEP_MELEE_DAMAGE,
    strike: TerrariaMobStrike,
    opts?: { emitDamageFx?: boolean },
  ): { ok: boolean; dealt: number } {
    const emitFx = opts?.emitDamageFx !== false;
    const m = this.mobs.get(id);
    if (m === undefined) {
      return { ok: false, dealt: 0 };
    }
    if (m.deathAnimRemainSec > 0) {
      return { ok: false, dealt: 0 };
    }
    if (m.damageInvulnRemainSec > 0) {
      return { ok: false, dealt: 0 };
    }
    const prevHp = m.hp;
    m.hp -= Math.max(0, Math.floor(damage));
    const dealt = prevHp - m.hp;
    if (dealt > 0 && emitFx) {
      this.emitMobDamageFx(m.kind, m.x, m.y, dealt);
    }
    m.hurtRemainSec = 0.18;
    m.noDamageSec = 0;
    const isCrit = rng.nextFloat() < PLAYER_MELEE_CRIT_CHANCE;
    if (m.kind === "sheep") {
      m.damageInvulnRemainSec = SHEEP_DAMAGE_INVULN_SEC;
      applyTerrariaKnockbackToHostMob(m, strike, dealt, isCrit, attackerFeetX);
      applySheepPanic(m, attackerFeetX, m.y);
    } else if (m.kind === "pig") {
      m.damageInvulnRemainSec = PIG_DAMAGE_INVULN_SEC;
      applyTerrariaKnockbackToHostMob(m, strike, dealt, isCrit, attackerFeetX);
      applyPigPanic(m, attackerFeetX);
    } else if (m.kind === "duck") {
      m.damageInvulnRemainSec = DUCK_DAMAGE_INVULN_SEC;
      applyTerrariaKnockbackToHostMob(m, strike, dealt, isCrit, attackerFeetX);
      applyDuckPanic(m, attackerFeetX);
    } else if (m.kind === "slime") {
      m.damageInvulnRemainSec = SLIME_DAMAGE_INVULN_SEC;
      applyTerrariaKnockbackToHostMob(m, strike, dealt, isCrit, attackerFeetX);
      applySlimePanic(m, attackerFeetX);
    } else {
      m.damageInvulnRemainSec = ZOMBIE_DAMAGE_INVULN_SEC;
      applyTerrariaKnockbackToHostMob(m, strike, dealt, isCrit, attackerFeetX);
    }
    if (m.hp <= 0 && m.kind === "sheep") {
      this.deathKillerFeetX.set(m.id, attackerFeetX);
      this.startSheepDeath(m, rng);
    } else if (m.hp <= 0 && m.kind === "pig") {
      this.deathKillerFeetX.set(m.id, attackerFeetX);
      this.startPigDeath(m, rng);
    } else if (m.hp <= 0 && m.kind === "duck") {
      this.deathKillerFeetX.set(m.id, attackerFeetX);
      this.startDuckDeath(m, rng);
    } else if (m.hp <= 0 && m.kind === "zombie") {
      this.deathKillerFeetX.set(m.id, attackerFeetX);
      this.startZombieDeath(m, rng);
    } else if (m.hp <= 0 && m.kind === "slime") {
      this.deathKillerFeetX.set(m.id, attackerFeetX);
      this.startSlimeDeath(m, rng);
    }
    return { ok: true, dealt };
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
      const { w: hitW, h: hitH } = mobHitboxSizePx(m.kind);
      const halfW = hitW * 0.5;
      const h = hitH;
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

  /**
   * First mob the segment `(x0,y0)→(x1,y1)` enters (world feet-up). Uses a tighter AABB for
   * sheep/pig so arrows stick in visible wool, not transparent atlas padding.
   */
  tryArrowStrikeSegment(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    damage: number,
    shooterFeetX: number,
    rng: GeneratorContext,
  ): HostArrowStrikeResult {
    let bestT = Number.POSITIVE_INFINITY;
    let bestId: number | null = null;
    for (const m of this.mobs.values()) {
      if (m.deathAnimRemainSec > 0) {
        continue;
      }
      const box = mobArrowStrikeAabbWorld(m.kind, m.x, m.y);
      const t = segmentWorldAabbEnterTClamped01(
        x0,
        y0,
        x1,
        y1,
        box.left,
        box.right,
        box.bottom,
        box.top,
      );
      if (t === null) {
        continue;
      }
      if (t < bestT) {
        bestT = t;
        bestId = m.id;
      }
    }
    if (bestId === null) {
      return { kind: "miss" };
    }
    const m = this.mobs.get(bestId);
    if (m === undefined) {
      return { kind: "miss" };
    }
    const legacyKbPx = 110 + damage * 14;
    const baseKb = terrariaArrowBaseKnockbackFromLegacyPx(legacyKbPx);
    const knockDir: 1 | -1 = m.x >= shooterFeetX ? 1 : -1;
    const applied = this.damageMobFromHost(bestId, rng, shooterFeetX, damage, {
      style: "projectile",
      baseKnockback: baseKb,
      knockDir,
    });
    if (!applied.ok) {
      return { kind: "miss" };
    }
    const px = x0 + (x1 - x0) * bestT;
    const py = y0 + (y1 - y0) * bestT;
    const dx = px - x0;
    const dyDisp = -(py - y0);
    const motion2 = dx * dx + dyDisp * dyDisp;
    const rotationRad =
      motion2 > 0.25
        ? Math.atan2(dyDisp, dx)
        : Math.atan2(-(y1 - y0), x1 - x0);
    return {
      kind: "stickMob",
      mobId: bestId,
      offsetX: px - m.x,
      offsetY: py - m.y,
      rotationRad,
      mobFacingRight: m.facingRight,
    };
  }

  clear(): void {
    this.world.clearAllArrows();
    this.mobs.clear();
    this.sheepPerColumn.clear();
    this.pigPerColumn.clear();
    this.duckPerColumn.clear();
    this.slimePerColumn.clear();
    this.zombiePerColumn.clear();
    this.lastBroadcastSig.clear();
    this.deathKillerFeetX.clear();
    this.pendingSpawn.length = 0;
    this.pendingDespawn.length = 0;
    this.passiveSpawnCycleAccumSec = 0;
    this.slimeSpawnCycleAccumSec = 0;
  }
}
