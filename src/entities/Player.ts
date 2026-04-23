/**
 * Local player: world-pixel feet (Y up), screen vy (positive down), break/place, hotbar.
 */
import type { AudioEngine, SfxOptions } from "../audio/AudioEngine";
import {
  getCloseSound,
  getDigSound,
  getJumpSound,
  getOpenSound,
  getPlaceSound,
  getStepSound,
} from "../audio/blockSounds";
import {
  getDamageFallBigSound,
  getDamageFallSmallSound,
  getDamageHitSound,
} from "../audio/damageSounds";
import type { EventBus } from "../core/EventBus";
import type { GameEvent } from "../core/types";
import {
  ARROW_SPEED_MAX_PX,
  ARROW_SPEED_MIN_PX,
  BLOCK_SIZE,
  BOW_DRAW_MOVE_SPEED_MULT,
  BOW_MAX_DRAW_SEC,
  HOTBAR_SIZE,
  ITEM_PLAYER_THROW_PICKUP_DELAY_SEC,
  ITEM_THROW_INHERIT_PLAYER_VEL_X,
  ITEM_THROW_SPAWN_OFFSET_PX,
  ITEM_THROW_SPEED_PX,
  PLAYER_HEIGHT,
  PLAYER_MAX_HEALTH,
  PLAYER_MOVE_ANIM_VEL_THRESHOLD,
  PLAYER_WATER_GRAVITY_MULT,
  PLAYER_WATER_MAX_SINK_SPEED_PX,
  PLAYER_WATER_SPEED_MULT,
  PLAYER_WATER_SWIM_HOLD_MAX_UP_SPEED,
  PLAYER_WATER_SWIM_HOLD_UP_ACCEL,
  PLAYER_LADDER_CLIMB_VY,
  PLAYER_LADDER_MAX_DESCEND_VY,
  PLAYER_WIDTH,
  PLAYER_FALL_SHALLOW_WATER_DAMAGE_MULT,
  PLAYER_FALL_DAMAGE_IGNORES_ARMOR,
  PLAYER_DAMAGE_TINT_DURATION_SEC,
  PLAYER_HAND_SWING_VISUAL_DURATION_SEC,
  PLAYER_SPRINT_SPEED_PX,
  PLAYER_WALK_SPEED_PX,
  REACH_BLOCKS,
  STEP_INTERVAL,
  MINING_DIG_SOUND_INTERVAL_SEC,
  WORLD_Y_MAX,
  WORLD_Y_MIN,
  WORLDGEN_NO_COLLIDE,
  playerFallDamageFromDistance,
} from "../core/constants";
import { getBreakTimeSeconds, canHarvestDrops } from "../core/mining";
import type { InputAction } from "../input/bindings";
import {
  getAimUnitVectorFromFeet,
  getItemThrowUnitVectorFromFeet,
  clampItemThrowVelocity,
} from "../input/aimDirection";
import type { InputManager } from "../input/InputManager";
import type { ItemDefinition } from "../core/itemDefinition";
import type { ItemRegistry } from "../items/ItemRegistry";
import { PlayerInventory } from "../items/PlayerInventory";
import type { BlockDefinition } from "../world/blocks/BlockDefinition";
import type { BlockRegistry } from "../world/blocks/BlockRegistry";
import {
  computePlacedStairShape,
  withStairShape,
} from "../world/blocks/stairMetadata";
import type { World } from "../world/World";
import {
  breakTreeLogsAboveColumn,
  isTreeLogBlock,
} from "../world/breakTreeLogColumnCascade";
import {
  isGrassDirtOrFarmlandSurface,
  isSaplingIdentifier,
  isWheatCropIdentifier,
} from "../world/plant/soil";
import {
  SUB_BED_PAIR,
  SUB_BG,
  SUB_BUCKET_FILL,
  SUB_DOOR_PAIR,
  SUB_HOE,
  SUB_PAINTING,
  SUB_SIMPLE_FG,
  SUB_TALL_GRASS,
  SUB_WHEAT,
} from "../world/terrain/terrainHostPlace";
import {
  PAINTING_VARIANTS,
  encodePaintingMeta,
  decodePaintingMeta,
} from "../world/painting/paintingData";
import { getFeetSupportBlock } from "../world/footstepSurface";
import {
  bedHeadPlusXFromMeta,
  packBedMetadata,
} from "../world/bed/bedMetadata";
import {
  doorLatchedOpenFromMeta,
  packDoorMetadata,
  toggleDoorLatchInMeta,
} from "../world/door/doorMetadata";
import {
  isWaterSourceMetadata,
  withWaterFlowLevel,
} from "../world/water/waterMetadata";
import { getSolidAABBs } from "./physics/Collision";
import { createAABB, overlaps, sweepAABB, type AABB } from "./physics/AABB";

/**
 * Horizontal caps in blocks/s (1 block ≈ 1 m). Ground walk uses {@link PLAYER_WALK_SPEED_PX};
 * sprint uses {@link PLAYER_SPRINT_SPEED_PX}.
 * While sprinting in the air with a move input, use the sprint-jump reference horizontal speed
 * (vanilla-style average over hop cycles ≈ 7.127 m/s).
 */
const SPRINT_JUMP_HORIZONTAL_BLOCKS_PER_SEC = 7.127;

const WALK_SPEED = PLAYER_WALK_SPEED_PX;
const SPRINT_SPEED = PLAYER_SPRINT_SPEED_PX;
/** Sprint + airborne + strafe: higher horizontal cap so repeated sprint-jumps match ~7.127 m/s average. */
const SPRINT_AIR_SPEED = SPRINT_JUMP_HORIZONTAL_BLOCKS_PER_SEC * BLOCK_SIZE;
const GRAVITY = 640;
const TERMINAL_VELOCITY = 600;
const GROUND_ACCEL = 2200;
const AIR_ACCEL = 1200;
const GROUND_DECEL = 2600;
const AIR_DECEL = 900;
const COYOTE_TIME_SEC = 0.08;
const JUMP_BUFFER_SEC = 0.1;
const TARGET_JUMP_HEIGHT_BLOCKS = 2.5;
const TARGET_JUMP_HEIGHT_PX = TARGET_JUMP_HEIGHT_BLOCKS * BLOCK_SIZE;
const JUMP_VELOCITY = -Math.sqrt(2 * GRAVITY * TARGET_JUMP_HEIGHT_PX);

/** Fall damage at or above this plays `damage.fall_big` SFX; below plays `fall_small`. */
const FALL_DAMAGE_SOUND_BIG_THRESHOLD = 4;

/** Minimum fall distance (blocks) before playing landing impact (`jump_*` SFX); avoids spawn click. */
const LANDING_IMPACT_MIN_FALL_BLOCKS = 0.04;

/** Cadence for `water_swim` while moving submerged (seconds). */
const WATER_SWIM_SFX_INTERVAL_SEC = 0.82;

const GROUND_PROBE_HEIGHT = 2;
/** When walking into a stair lip, lift by this much then re-sweep so steps can be walked without jumping. */
const STAIR_STEP_UP_PX = BLOCK_SIZE * 0.5;

const HOTBAR_KEYS: [InputAction, number][] = [
  ["hotbar1", 0],
  ["hotbar2", 1],
  ["hotbar3", 2],
  ["hotbar4", 3],
  ["hotbar5", 4],
  ["hotbar6", 5],
  ["hotbar7", 6],
  ["hotbar8", 7],
  ["hotbar9", 8],
  /** Minecraft-style: 0 selects the last hotbar slot. */
  ["hotbar0", 8],
];

export type BreakTargetLayer = "fg" | "bg";

export type PlayerState = {
  position: { x: number; y: number };
  /** Position at the start of the previous fixed tick (for render interpolation). */
  prevPosition: { x: number; y: number };
  /** Screen-space: vy > 0 = falling. */
  velocity: { x: number; y: number };
  onGround: boolean;
  facingRight: boolean;
  hotbarSlot: number;
  /** Integer HP in `[0, PLAYER_MAX_HEALTH]`. */
  health: number;
  /**
   * Extra HP that absorbs damage first and is removed when
   * {@link temporaryHealthRemainSec} hits 0 (e.g. raw food). With {@link health} must
   * not exceed {@link PLAYER_MAX_HEALTH} combined.
   */
  temporaryHealth: number;
  /**
   * Countdown; when 0, {@link temporaryHealth} is cleared. Eating more may refresh
   * this and add any remaining “room” in the bar.
   */
  temporaryHealthRemainSec: number;
  /** Tab: edit back-wall tiles (place/break) instead of foreground. */
  backgroundEditMode: boolean;
  /**
   * Cell under the crosshair for passive outline (when not actively mining that cell).
   * Shown for air as well as blocks; same layer as {@link backgroundEditMode} implies.
   */
  aimOutlineTarget: { wx: number; wy: number; layer: BreakTargetLayer } | null;
  breakTarget: { wx: number; wy: number; layer: BreakTargetLayer } | null;
  breakProgress: number;
  breakAccum: number;
  /** Footstep SFX cadence accumulator (seconds). */
  stepAccum: number;
  /** Jump leniency: allow a jump shortly after leaving ground. */
  coyoteTimeRemaining: number;
  /** Jump leniency: queue jump input for a short time before landing. */
  jumpBufferRemaining: number;
  /**
   * After place / item use: seconds left to show the same mining-style body + held-item swing as breaking.
   */
  handSwingRemainSec: number;
  /** True when HP has reached 0 until respawn. */
  dead: boolean;
  /**
   * Death presentation progress in `[0, 1]`; `null` when alive. Advanced by the main game loop each tick.
   */
  deathAnimT: number | null;
  /** Seconds of red damage tint remaining (rendered on the local body + held item). */
  damageTintRemainSec: number;
  /** True while the local player is in a bed sleep transition. */
  sleeping: boolean;
  /** Seconds remaining for the sleep pose/input lock. */
  sleepRemainSec: number;
  /**
   * While drawing stratum:bow with RMB (and arrows available), accumulates up to {@link BOW_MAX_DRAW_SEC}.
   * Reset when not drawing; used for held-item pose and shot power.
   */
  bowDrawSec: number;
};

/** Feet world coords (Y up) → same root space as foreground chunk meshes (Pixi Y down). */
export function feetToScreenAABB(pos: { x: number; y: number }): AABB {
  const x = pos.x - PLAYER_WIDTH * 0.5;
  const y = -(pos.y + PLAYER_HEIGHT);
  return createAABB(x, y, PLAYER_WIDTH, PLAYER_HEIGHT);
}

function screenAABBTofeet(m: AABB): { x: number; y: number } {
  return {
    x: m.x + PLAYER_WIDTH * 0.5,
    y: -(m.y + PLAYER_HEIGHT),
  };
}

function groundProbe(mover: AABB): AABB {
  return createAABB(
    mover.x + 0.25,
    mover.y + mover.height,
    mover.width - 0.5,
    GROUND_PROBE_HEIGHT,
  );
}

function isOnGround(mover: AABB, solids: ReadonlyArray<AABB>): boolean {
  const p = groundProbe(mover);
  for (const s of solids) {
    if (overlaps(p, s)) {
      return true;
    }
  }
  return false;
}

export function playerAabbOverlapsWater(
  world: World,
  pos: { x: number; y: number },
): boolean {
  if (!world.getRegistry().isRegistered("stratum:water")) {
    return false;
  }
  const waterId = world.getWaterBlockId();
  const region = feetToScreenAABB(pos);
  const worldYBottom = -(region.y + region.height);
  const worldYTop = -region.y;
  const wx0 = Math.floor(region.x / BLOCK_SIZE);
  const wx1 = Math.floor((region.x + region.width - 1) / BLOCK_SIZE);
  const wy0 = Math.floor(worldYBottom / BLOCK_SIZE);
  const wy1 = Math.floor(worldYTop / BLOCK_SIZE);
  for (let wx = wx0; wx <= wx1; wx++) {
    for (let wy = wy0; wy <= wy1; wy++) {
      if (world.getChunkAt(wx, wy) === undefined) {
        continue;
      }
      if (world.getForegroundBlockId(wx, wy) === waterId) {
        return true;
      }
    }
  }
  return false;
}

export function playerAabbOverlapsLadder(
  world: World,
  pos: { x: number; y: number },
): boolean {
  const reg = world.getRegistry();
  if (!reg.isRegistered("stratum:ladder")) {
    return false;
  }
  const ladderId = reg.getByIdentifier("stratum:ladder").id;
  const region = feetToScreenAABB(pos);
  const worldYBottom = -(region.y + region.height);
  const worldYTop = -region.y;
  const wx0 = Math.floor(region.x / BLOCK_SIZE);
  const wx1 = Math.floor((region.x + region.width - 1) / BLOCK_SIZE);
  const wy0 = Math.floor(worldYBottom / BLOCK_SIZE);
  const wy1 = Math.floor(worldYTop / BLOCK_SIZE);
  for (let wx = wx0; wx <= wx1; wx++) {
    for (let wy = wy0; wy <= wy1; wy++) {
      if (world.getChunkAt(wx, wy) === undefined) {
        continue;
      }
      if (world.getForegroundBlockId(wx, wy) === ladderId) {
        return true;
      }
    }
  }
  return false;
}

function findCollidingSurfaceBelowColumn(
  world: World,
  wx: number,
  startWy: number,
  waterId: number,
): number | null {
  for (let wy = startWy; wy >= WORLD_Y_MIN; wy--) {
    const def = world.getBlock(wx, wy);
    if (def.id === waterId) {
      continue;
    }
    if (def.collides) {
      return wy;
    }
  }
  return null;
}

function countContiguousWaterAboveSolid(
  world: World,
  wx: number,
  solidWy: number,
  waterId: number,
): number {
  let d = 0;
  for (let wy = solidWy + 1; wy <= WORLD_Y_MAX; wy++) {
    if (world.getForegroundBlockId(wx, wy) === waterId) {
      d++;
    } else {
      break;
    }
  }
  return d;
}

function maxWaterDepthAboveFooting(
  world: World,
  pos: { x: number; y: number },
  waterId: number,
): number {
  const region = feetToScreenAABB(pos);
  const wx0 = Math.floor(region.x / BLOCK_SIZE);
  const wx1 = Math.floor((region.x + region.width - 1) / BLOCK_SIZE);
  const feetBy = Math.floor(pos.y / BLOCK_SIZE);
  let maxD = 0;
  for (let wx = wx0; wx <= wx1; wx++) {
    if (world.getChunkAt(wx, feetBy) === undefined) {
      continue;
    }
    const solidWy = findCollidingSurfaceBelowColumn(world, wx, feetBy, waterId);
    if (solidWy === null) {
      continue;
    }
    maxD = Math.max(
      maxD,
      countContiguousWaterAboveSolid(world, wx, solidWy, waterId),
    );
  }
  return maxD;
}

function chebyshev(ax: number, ay: number, bx: number, by: number): number {
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by));
}

function approach(current: number, target: number, maxDelta: number): number {
  if (current < target) {
    return Math.min(current + maxDelta, target);
  }
  return Math.max(current - maxDelta, target);
}

function isGrassOrDirtSurface(below: BlockDefinition): boolean {
  return (
    below.identifier === "stratum:grass" ||
    below.identifier === "stratum:dirt"
  );
}

/** Flowers and short grass may only be placed on grass or dirt. */
function isFlowerOrShortGrass(identifier: string): boolean {
  return (
    identifier === "stratum:dandelion" ||
    identifier === "stratum:poppy" ||
    identifier === "stratum:short_grass"
  );
}

function itemPlacesBlock(item: ItemDefinition | undefined): number {
  if (item === undefined) {
    return 0;
  }
  return item.placesBlockId ?? 0;
}

/** Mouse in layer space → world block column (Y increases upward in world blocks). */
function mouseToBlock(
  mouseX: number,
  mouseY: number,
): { wx: number; wy: number } {
  const wx = Math.floor(mouseX / BLOCK_SIZE);
  const wy = Math.floor(-mouseY / BLOCK_SIZE);
  return { wx, wy };
}

export class Player {
  readonly state: PlayerState = {
    position: { x: 0, y: 0 },
    prevPosition: { x: 0, y: 0 },
    velocity: { x: 0, y: 0 },
    onGround: false,
    facingRight: true,
    hotbarSlot: 0,
    health: PLAYER_MAX_HEALTH,
    temporaryHealth: 0,
    temporaryHealthRemainSec: 0,
    backgroundEditMode: false,
    aimOutlineTarget: null,
    breakTarget: null,
    breakProgress: 0,
    breakAccum: 0,
    stepAccum: 0,
    coyoteTimeRemaining: 0,
    jumpBufferRemaining: 0,
    handSwingRemainSec: 0,
    dead: false,
    deathAnimT: null,
    damageTintRemainSec: 0,
    sleeping: false,
    sleepRemainSec: 0,
    bowDrawSec: 0,
  };

  public readonly inventory: PlayerInventory;

  private readonly solidScratch: AABB[] = [];
  private readonly bus: EventBus;
  private readonly audio: AudioEngine;
  private readonly registry: BlockRegistry;
  private readonly itemRegistry: ItemRegistry;
  private readonly airId: number;
  /** Accumulator for periodic mining hit SFX (not crack-stage). */
  private miningDigSoundAccum = 0;
  private prevHotbarSlot = 0;
  private prevBowRmbDown = false;
  /** Downward feet travel (blocks) while airborne; reset on ground. Landing includes this frame’s drop. */
  private fallDistanceBlocks = 0;
  /** Previous physics tick ended overlapping a ladder (smooths one-frame AABB gaps for fall damage). */
  private _prevLadderOverlap = false;
  /** Throttle system chat hint when mining without correct tool (no drops). */
  private _lastWrongToolNoDropHintMs = 0;
  /** Previous tick: AABB overlapped water (for enter/exit splash). */
  private wasInWater = false;
  /** Accumulator for periodic {@link WATER_SWIM_SFX_INTERVAL_SEC} swim strokes. */
  private waterSwimSfxAccum = 0;
  /** When true, block/place mutations go to the host via bus (`terrain:net-*`). */
  private _mpTerrainClient = false;
  private lastMovedBlockX = Number.NaN;
  private lastMovedBlockY = Number.NaN;
  /** Optional callback to check if any mob overlaps the given AABB (for block placement). */
  private _mobOverlapCheck: ((aabb: AABB) => boolean) | null = null;

  constructor(registry: BlockRegistry, bus: EventBus, audio: AudioEngine, itemRegistry: ItemRegistry) {
    this.bus = bus;
    this.audio = audio;
    this.registry = registry;
    this.itemRegistry = itemRegistry;
    this.inventory = new PlayerInventory(itemRegistry);
    this.airId = registry.getByIdentifier("stratum:air").id;
  }

  /** Sets the callback used to check if any mob overlaps a given AABB during block placement. */
  setMobOverlapCheck(callback: ((aabb: AABB) => boolean) | null): void {
    this._mobOverlapCheck = callback;
  }

  /** True while RMB is held to draw a bow with ammo (world input must be active). */
  isDrawingBow(input: InputManager): boolean {
    const { state } = this;
    if (
      input.isWorldInputBlocked() ||
      state.backgroundEditMode ||
      state.dead ||
      state.sleeping
    ) {
      return false;
    }
    if (!input.mouseButton(2)) {
      return false;
    }
    const hs = state.hotbarSlot % HOTBAR_SIZE;
    const stack = this.inventory.getStack(hs);
    const def =
      stack !== null ? this.itemRegistry.getById(stack.itemId) : undefined;
    if (def?.key !== "stratum:bow") {
      return false;
    }
    return this.inventory.countItemsByKey("stratum:arrow") > 0;
  }

  /** Multiplayer guest: terrain edits are RPC’d to the host. */
  setMultiplayerTerrainClient(v: boolean): void {
    this._mpTerrainClient = v;
  }

  private emitNetPlace(
    subtype: number,
    wx: number,
    wy: number,
    hotbarSlot: number,
    placesBlockId: number,
    aux: number,
  ): void {
    this.bus.emit({
      type: "terrain:net-place",
      subtype,
      wx,
      wy,
      hotbarSlot,
      placesBlockId,
      aux,
    } satisfies GameEvent);
  }

  getAABB(): AABB {
    return feetToScreenAABB(this.state.position);
  }

  /** Block id placed by the item in the selected hotbar slot (0 = none). */
  getSelectedHotbarBlockId(): number {
    const slot = this.state.hotbarSlot % HOTBAR_SIZE;
    const stack = this.inventory.getStack(slot);
    if (stack === null) {
      return 0;
    }
    return itemPlacesBlock(this.itemRegistry.getById(stack.itemId));
  }

  /** Feet position in world pixels (Y increases upward). */
  spawnAt(feetWorldX: number, feetWorldY: number): void {
    this.state.position.x = feetWorldX;
    this.state.position.y = feetWorldY;
    this.state.prevPosition.x = feetWorldX;
    this.state.prevPosition.y = feetWorldY;
    this.state.velocity.x = 0;
    this.state.velocity.y = 0;
    this.state.coyoteTimeRemaining = 0;
    this.state.jumpBufferRemaining = 0;
    this.state.health = PLAYER_MAX_HEALTH;
    this.state.temporaryHealth = 0;
    this.state.temporaryHealthRemainSec = 0;
    this.state.handSwingRemainSec = 0;
    this.state.dead = false;
    this.state.deathAnimT = null;
    this.state.damageTintRemainSec = 0;
    this.state.bowDrawSec = 0;
    this.prevBowRmbDown = false;
    this.fallDistanceBlocks = 0;
    this.wasInWater = false;
    this.waterSwimSfxAccum = 0;
    this.lastMovedBlockX = Number.NaN;
    this.lastMovedBlockY = Number.NaN;
  }

  /** Reduce health; amount is floored. HP does not go below 0. Armor mitigation scales with pooled durability unless `skipArmor`. */
  takeDamage(
    amount: number,
    opts?: { skipHurtSound?: boolean; skipArmor?: boolean },
  ): void {
    if (this.state.dead || amount <= 0) {
      return;
    }
    this.inventory.applyArmorDurabilityFromDamage(amount);
    const mitigation =
      opts?.skipArmor === true
        ? 0
        : this.inventory.getEquippedArmorMitigationFraction();
    const reducedAmount = amount * (1 - mitigation);
    const d = Math.floor(reducedAmount);
    if (d <= 0) {
      // Armor fully blocked the damage
      this.state.damageTintRemainSec = PLAYER_DAMAGE_TINT_DURATION_SEC * 0.5;
      return;
    }
    const { state } = this;
    let dLeft = d;
    if (state.temporaryHealth > 0) {
      const fromTemp = Math.min(state.temporaryHealth, dLeft);
      state.temporaryHealth -= fromTemp;
      dLeft -= fromTemp;
    }
    if (dLeft <= 0) {
      this.state.damageTintRemainSec = PLAYER_DAMAGE_TINT_DURATION_SEC * 0.5;
      return;
    }
    const prevHp = this.state.health;
    this.state.health = Math.max(0, this.state.health - dLeft);
    if (this.state.health < prevHp) {
      this.state.damageTintRemainSec = PLAYER_DAMAGE_TINT_DURATION_SEC;
      const ax = this.state.position.x;
      const ay = this.state.position.y + PLAYER_HEIGHT * 0.52;
      this.bus.emit({
        type: "fx:damage-number",
        worldAnchorX: ax,
        worldAnchorY: ay,
        damage: prevHp - this.state.health,
      } satisfies GameEvent);
    }
    if (!opts?.skipHurtSound && prevHp > 0) {
      this.sfxSelf(getDamageHitSound(), {
        volume: 0.82,
        pitchVariance: 28,
      });
    }
    if (this.state.health <= 0) {
      this.state.temporaryHealth = 0;
      this.state.temporaryHealthRemainSec = 0;
      this.state.dead = true;
      this.state.deathAnimT = 0;
    }
  }

  /** Restore health; amount is floored. HP does not exceed `PLAYER_MAX_HEALTH`. */
  heal(amount: number): void {
    if (amount <= 0) {
      return;
    }
    const h = Math.floor(amount);
    this.state.health = Math.min(PLAYER_MAX_HEALTH, this.state.health + h);
  }

  /**
   * Add HP that absorbs damage before {@link state.health} and is lost when the timer elapses.
   * Combined with {@link state.health} is capped to `PLAYER_MAX_HEALTH`.
   */
  addTemporaryHealth(amount: number, durationSec: number): void {
    const { state } = this;
    if (amount <= 0 || !Number.isFinite(durationSec) || durationSec <= 0) {
      return;
    }
    const h = Math.floor(amount);
    if (h <= 0) {
      return;
    }
    const space = Math.max(0, PLAYER_MAX_HEALTH - state.health - state.temporaryHealth);
    const toAdd = Math.min(h, space);
    if (toAdd > 0) {
      state.temporaryHealth += toAdd;
    }
    if (toAdd > 0 || state.temporaryHealth > 0) {
      state.temporaryHealthRemainSec = Math.max(
        state.temporaryHealthRemainSec,
        durationSec,
      );
    }
  }

  canConsumeEdible(held: {
    eatRestoreHealth?: number;
    eatTemporaryDurationSec?: number;
  }): boolean {
    const eatHp = held.eatRestoreHealth;
    if (eatHp === undefined || eatHp <= 0) {
      return false;
    }
    const { health, temporaryHealth: temp } = this.state;
    if (held.eatTemporaryDurationSec !== undefined) {
      if (temp > 0) {
        return true;
      }
      return health + temp < PLAYER_MAX_HEALTH;
    }
    return health < PLAYER_MAX_HEALTH;
  }

  private tryConsumeEdibleInWorld(hotbarSlot: number): void {
    const stack = this.inventory.getStack(hotbarSlot);
    const def =
      stack !== null ? this.itemRegistry.getById(stack.itemId) : undefined;
    if (def === undefined || !this.canConsumeEdible(def)) {
      return;
    }
    const eatHp = def.eatRestoreHealth;
    if (eatHp === undefined) {
      return;
    }
    if (!this.inventory.consumeOneFromSlot(hotbarSlot)) {
      return;
    }
    if (def.eatTemporaryDurationSec !== undefined) {
      this.addTemporaryHealth(eatHp, def.eatTemporaryDurationSec);
    } else {
      this.heal(eatHp);
    }
    this.startHandSwingVisual();
    this.sfxSelf(getPlaceSound("generic"), {
      pitchVariance: 18,
    });
  }

  /** Same mining-style swing as breaking blocks (body + held item), for place / use feedback. */
  private startHandSwingVisual(): void {
    this.state.handSwingRemainSec = PLAYER_HAND_SWING_VISUAL_DURATION_SEC;
  }

  /**
   * Trigger the mining-style hand/held-item swing visual (used for melee clicks even if nothing is hit).
   */
  swingHand(): void {
    this.startHandSwingVisual();
  }

  beginSleep(durationSec: number): void {
    const d = Number.isFinite(durationSec) ? Math.max(0, durationSec) : 0;
    this.state.sleeping = d > 0;
    this.state.sleepRemainSec = d;
    if (this.state.sleeping) {
      this.state.breakTarget = null;
      this.state.aimOutlineTarget = null;
      this.state.breakAccum = 0;
      this.state.breakProgress = 0;
      this.miningDigSoundAccum = 0;
      this.state.handSwingRemainSec = 0;
      this.state.bowDrawSec = 0;
      this.prevBowRmbDown = false;
    }
  }

  /** Restore position, hotbar, inventory, and armor from persistence. */
  applySavedState(
    feetWorldX: number,
    feetWorldY: number,
    hotbarSlot: number,
    inventory?: import("../items/PlayerInventory").SerializedInventorySlot[],
    health?: number,
    armor?: import("../items/PlayerInventory").SerializedInventorySlot[],
  ): void {
    this.spawnAt(feetWorldX, feetWorldY);
    const slot = ((hotbarSlot % HOTBAR_SIZE) + HOTBAR_SIZE) % HOTBAR_SIZE;
    this.state.hotbarSlot = slot;
    this.prevHotbarSlot = slot;
    if (health !== undefined) {
      this.state.health = Math.max(
        0,
        Math.min(PLAYER_MAX_HEALTH, Math.floor(health)),
      );
    } else {
      this.state.health = PLAYER_MAX_HEALTH;
    }
    this.state.temporaryHealth = 0;
    this.state.temporaryHealthRemainSec = 0;
    if (inventory !== undefined) {
      this.inventory.restore(inventory);
    }
    if (armor !== undefined) {
      this.inventory.restoreArmor(armor);
    }
    this.state.dead = false;
    this.state.deathAnimT = null;
    this.state.damageTintRemainSec = 0;
    this.state.bowDrawSec = 0;
    this.prevBowRmbDown = false;
    this.bus.emit({
      type: "player:hotbarChanged",
      slot,
    } satisfies GameEvent);
  }

  /** Spatial SFX at block center (mining, placement, door). */
  private sfxAtBlock(
    wx: number,
    wy: number,
    name: string,
    opts?: Omit<SfxOptions, "world">,
  ): void {
    const { state } = this;
    const lx = state.position.x;
    const ly = state.position.y;
    this.audio.playSfx(name, {
      ...opts,
      world: {
        listenerX: lx,
        listenerY: ly,
        sourceX: wx * BLOCK_SIZE + BLOCK_SIZE * 0.5,
        sourceY: wy * BLOCK_SIZE + BLOCK_SIZE * 0.5,
      },
    });
  }

  /** Spatial SFX at the player (fall hurt, eat, footstep origin near feet). */
  private sfxSelf(name: string, opts?: Omit<SfxOptions, "world">): void {
    const { state } = this;
    const lx = state.position.x;
    const ly = state.position.y;
    this.audio.playSfx(name, {
      ...opts,
      world: { listenerX: lx, listenerY: ly, sourceX: lx, sourceY: ly },
    });
  }

  update(dt: number, input: InputManager, world: World): void {
    const { state } = this;

    if (state.damageTintRemainSec > 0) {
      state.damageTintRemainSec = Math.max(0, state.damageTintRemainSec - dt);
    }

    if (state.temporaryHealthRemainSec > 0) {
      state.temporaryHealthRemainSec = Math.max(0, state.temporaryHealthRemainSec - dt);
    }
    if (state.temporaryHealthRemainSec <= 0) {
      state.temporaryHealth = 0;
    }

    if (state.sleepRemainSec > 0) {
      state.sleepRemainSec = Math.max(0, state.sleepRemainSec - dt);
      if (state.sleepRemainSec <= 0) {
        state.sleeping = false;
      }
      state.prevPosition.x = state.position.x;
      state.prevPosition.y = state.position.y;
      state.velocity.x = 0;
      state.velocity.y = 0;
      this.fallDistanceBlocks = 0;
      this.wasInWater = false;
      this.waterSwimSfxAccum = 0;
      return;
    }

    if (state.dead) {
      state.prevPosition.x = state.position.x;
      state.prevPosition.y = state.position.y;
      state.velocity.x = 0;
      state.velocity.y = 0;
      this.fallDistanceBlocks = 0;
      this.wasInWater = false;
      this.waterSwimSfxAccum = 0;
      return;
    }

    const feetBx = Math.floor(state.position.x / BLOCK_SIZE);
    const feetBy = Math.floor(state.position.y / BLOCK_SIZE);
    if (
      world.getChunkAt(feetBx, feetBy) === undefined ||
      world.getChunkAt(feetBx, feetBy - 1) === undefined
    ) {
      state.prevPosition.x = state.position.x;
      state.prevPosition.y = state.position.y;
      state.velocity.x = 0;
      state.velocity.y = 0;
      this.fallDistanceBlocks = 0;
      this.wasInWater = false;
      this.waterSwimSfxAccum = 0;
      return;
    }

    const wasOnGround = state.onGround;

    state.prevPosition.x = state.position.x;
    state.prevPosition.y = state.position.y;
    state.coyoteTimeRemaining = Math.max(0, state.coyoteTimeRemaining - dt);
    state.jumpBufferRemaining = Math.max(0, state.jumpBufferRemaining - dt);

    let moveInput = 0;
    if (input.isDown("left")) {
      moveInput -= 1;
    }
    if (input.isDown("right")) {
      moveInput += 1;
    }
    const sprintHeld = input.isDown("sprint");
    const inWater = playerAabbOverlapsWater(world, state.position);
    const waterMult = inWater ? PLAYER_WATER_SPEED_MULT : 1;
    const bowSlow =
      this.isDrawingBow(input) && !inWater ? BOW_DRAW_MOVE_SPEED_MULT : 1;
    const speed =
      (sprintHeld && !state.onGround && moveInput !== 0
        ? SPRINT_AIR_SPEED
        : sprintHeld
          ? SPRINT_SPEED
          : WALK_SPEED) *
      waterMult *
      bowSlow;
    const targetVx = moveInput * speed;
    const accel = state.onGround ? GROUND_ACCEL : AIR_ACCEL;
    const decel = state.onGround ? GROUND_DECEL : AIR_DECEL;
    const maxDelta = (moveInput !== 0 ? accel : decel) * dt;
    state.velocity.x = approach(state.velocity.x, targetVx, maxDelta);

    if (input.isJustPressed("jump")) {
      state.jumpBufferRemaining = JUMP_BUFFER_SEC;
    }

    if (inWater) {
      state.velocity.y += GRAVITY * PLAYER_WATER_GRAVITY_MULT * dt;
      if (input.isDown("jump")) {
        state.velocity.y -= PLAYER_WATER_SWIM_HOLD_UP_ACCEL * dt;
        if (state.velocity.y < PLAYER_WATER_SWIM_HOLD_MAX_UP_SPEED) {
          state.velocity.y = PLAYER_WATER_SWIM_HOLD_MAX_UP_SPEED;
        }
      }
      if (state.velocity.y > PLAYER_WATER_MAX_SINK_SPEED_PX) {
        state.velocity.y = PLAYER_WATER_MAX_SINK_SPEED_PX;
      }
    } else {
      state.velocity.y += GRAVITY * dt;
      if (state.velocity.y > TERMINAL_VELOCITY) {
        state.velocity.y = TERMINAL_VELOCITY;
      }
    }

    const onLadder = !inWater && playerAabbOverlapsLadder(world, state.position);
    if (onLadder) {
      if (!this._prevLadderOverlap && state.velocity.y > PLAYER_LADDER_MAX_DESCEND_VY) {
        state.velocity.y = PLAYER_LADDER_MAX_DESCEND_VY;
      }
      if (input.isDown("jump")) {
        state.velocity.y = PLAYER_LADDER_CLIMB_VY;
      } else if (state.velocity.y > PLAYER_LADDER_MAX_DESCEND_VY) {
        state.velocity.y = PLAYER_LADDER_MAX_DESCEND_VY;
      }
    }

    let mover = feetToScreenAABB(state.position);
    const dx = state.velocity.x * dt;
    const dy = state.velocity.y * dt;

    const pad = 4;
    const stepUpMargin = BLOCK_SIZE;
    const query = createAABB(
      Math.min(mover.x, mover.x + dx) - pad,
      Math.min(mover.y, mover.y + dy) - pad - stepUpMargin,
      Math.abs(dx) + mover.width + pad * 2,
      Math.abs(dy) + mover.height + pad * 2 + stepUpMargin,
    );
    getSolidAABBs(world, query, this.solidScratch);

    const startMover = { ...mover };
    let { hitX, hitY } = sweepAABB(mover, dx, dy, this.solidScratch);

    if (
      hitX &&
      wasOnGround &&
      !inWater &&
      Math.abs(dx) > 1e-4
    ) {
      const stepHeights = [STAIR_STEP_UP_PX, BLOCK_SIZE];
      for (const stepUp of stepHeights) {
        const retry = { ...startMover };
        sweepAABB(retry, 0, -stepUp, this.solidScratch);
        const r2 = sweepAABB(retry, dx, dy, this.solidScratch);
        if (!r2.hitX) {
          mover = retry;
          hitX = r2.hitX;
          hitY = r2.hitY;
          break;
        }
      }
    }

    const feet = screenAABBTofeet(mover);
    state.position.x = feet.x;
    state.position.y = feet.y;
    const inWaterAfterMove = playerAabbOverlapsWater(world, state.position);
    const onLadderAfterMove =
      !inWaterAfterMove && playerAabbOverlapsLadder(world, state.position);

    if (hitY && state.velocity.y > 0) {
      state.velocity.y = 0;
    } else if (hitY && state.velocity.y < 0) {
      state.velocity.y = 0;
    }

    state.onGround = isOnGround(mover, this.solidScratch);
    const onGroundAfterCollision = state.onGround;
    const downBlocksThisTick =
      Math.max(0, state.prevPosition.y - state.position.y) / BLOCK_SIZE;
    /**
     * Do not count vertical movement while submerged as falling — swimming/sinking would otherwise
     * inflate {@link fallDistanceBlocks} and cause bogus fall damage when walking onto shore.
     * Clear for either tick edge so one-frame surface gaps do not accumulate.
     *
     * Same for ladders: the ground check stays false while climbing, so slide distance would
     * otherwise accumulate bogus fall distance and hurt on dismount.
     */
    const ladderOverlap =
      onLadderAfterMove || onLadder || this._prevLadderOverlap;
    if (inWaterAfterMove || inWater) {
      this.fallDistanceBlocks = 0;
    } else if (ladderOverlap) {
      this.fallDistanceBlocks = 0;
    } else if (!onGroundAfterCollision) {
      this.fallDistanceBlocks += downBlocksThisTick;
    } else if (!wasOnGround) {
      this.fallDistanceBlocks += downBlocksThisTick;
      if (
        !inWaterAfterMove &&
        this.fallDistanceBlocks > LANDING_IMPACT_MIN_FALL_BLOCKS
      ) {
        const landSurface = getFeetSupportBlock(
          world,
          state.position.x,
          state.position.y,
        );
        if (landSurface.id !== this.airId && !landSurface.water) {
          const lbx = Math.floor(state.position.x / BLOCK_SIZE);
          const lfy = Math.floor(state.position.y / BLOCK_SIZE);
          const atFeetForLand = world.getBlock(lbx, lfy);
          const lwy = atFeetForLand.isStair === true ? lfy : lfy - 1;
          this.sfxAtBlock(lbx, lwy, getJumpSound(landSurface.material), {
            volume: 0.52,
            pitchVariance: 50,
          });
        }
      }
      let fallDmg = playerFallDamageFromDistance(this.fallDistanceBlocks);
      if (fallDmg > 0 && world.getRegistry().isRegistered("stratum:water")) {
        const wDepth = maxWaterDepthAboveFooting(
          world,
          state.position,
          world.getWaterBlockId(),
        );
        if (wDepth >= 2) {
          fallDmg = 0;
        } else if (wDepth === 1) {
          fallDmg = Math.floor(fallDmg * PLAYER_FALL_SHALLOW_WATER_DAMAGE_MULT);
        }
      }
      if (fallDmg > 0) {
        if (fallDmg >= FALL_DAMAGE_SOUND_BIG_THRESHOLD) {
          this.sfxSelf(getDamageFallBigSound(), {
            volume: 0.88,
            pitchVariance: 22,
          });
        } else {
          this.sfxSelf(getDamageFallSmallSound(), {
            volume: 0.72,
            pitchVariance: 18,
          });
        }
        this.takeDamage(fallDmg, {
          skipHurtSound: true,
          skipArmor: PLAYER_FALL_DAMAGE_IGNORES_ARMOR,
        });
      }
      this.fallDistanceBlocks = 0;
    } else {
      this.fallDistanceBlocks = 0;
    }

    this._prevLadderOverlap = onLadderAfterMove || onLadder;

    if (state.onGround || wasOnGround) {
      state.coyoteTimeRemaining = COYOTE_TIME_SEC;
    }

    const canUseGroundJump = state.onGround || state.coyoteTimeRemaining > 0;
    if (
      state.jumpBufferRemaining > 0 &&
      canUseGroundJump &&
      !inWaterAfterMove &&
      !onLadderAfterMove
    ) {
      const jumpSurface = getFeetSupportBlock(
        world,
        state.position.x,
        state.position.y,
      );
      const jbx = Math.floor(state.position.x / BLOCK_SIZE);
      const jfy = Math.floor(state.position.y / BLOCK_SIZE);
      const atFeetForJump = world.getBlock(jbx, jfy);
      const jwy = atFeetForJump.isStair === true ? jfy : jfy - 1;
      this.sfxAtBlock(jbx, jwy, getJumpSound(jumpSurface.material), {
        pitchVariance: 55,
      });
      state.velocity.y = JUMP_VELOCITY;
      state.onGround = false;
      state.jumpBufferRemaining = 0;
      state.coyoteTimeRemaining = 0;
    } else if (state.onGround && state.velocity.y >= 0 && !inWaterAfterMove) {
      state.velocity.y = 0;
    }

    if (inWaterAfterMove && !this.wasInWater) {
      this.sfxSelf("water_splash", { volume: 0.58, pitchVariance: 38 });
    } else if (!inWaterAfterMove && this.wasInWater) {
      this.sfxSelf("water_splash", { volume: 0.62, pitchVariance: 42 });
    }
    if (inWaterAfterMove) {
      const movingInWater =
        Math.abs(state.velocity.x) > 14 ||
        Math.abs(state.velocity.y) > 22 ||
        (input.isDown("jump") && inWater);
      if (movingInWater) {
        this.waterSwimSfxAccum += dt;
        if (this.waterSwimSfxAccum >= WATER_SWIM_SFX_INTERVAL_SEC) {
          this.waterSwimSfxAccum = 0;
          this.sfxSelf("water_swim", { volume: 0.32, pitchVariance: 60 });
        }
      } else {
        this.waterSwimSfxAccum = 0;
      }
    } else {
      this.waterSwimSfxAccum = 0;
    }
    this.wasInWater = inWaterAfterMove;

    if (moveInput > 0) {
      state.facingRight = true;
    } else if (moveInput < 0) {
      state.facingRight = false;
    } else if (Math.abs(state.velocity.x) >= PLAYER_MOVE_ANIM_VEL_THRESHOLD) {
      state.facingRight = state.velocity.x > 0;
    }

    for (const [action, slot] of HOTBAR_KEYS) {
      if (input.isJustPressed(action)) {
        state.hotbarSlot = slot;
        break;
      }
    }

    if (Math.abs(input.wheelDelta) >= 1 && !input.isWorldInputBlocked()) {
      const step = input.wheelDelta > 0 ? 1 : -1;
      state.hotbarSlot = (state.hotbarSlot + step + HOTBAR_SIZE) % HOTBAR_SIZE;
    }

    const rawBowRmb = input.mouseButton(2);
    const bowAllow =
      !input.isWorldInputBlocked() &&
      !state.backgroundEditMode &&
      !state.dead &&
      !state.sleeping;
    const bowHeldSlot = state.hotbarSlot % HOTBAR_SIZE;
    const bowStack = this.inventory.getStack(bowHeldSlot);
    const bowHeldDef =
      bowStack !== null ? this.itemRegistry.getById(bowStack.itemId) : undefined;
    const bowInHand = bowHeldDef?.key === "stratum:bow";
    const bowArrows = this.inventory.countItemsByKey("stratum:arrow");
    const bowCharging = bowAllow && bowInHand && bowArrows > 0 && rawBowRmb;
    const bowReleased = this.prevBowRmbDown && !rawBowRmb;
    this.prevBowRmbDown = rawBowRmb;

    if (bowCharging) {
      state.bowDrawSec = Math.min(BOW_MAX_DRAW_SEC, state.bowDrawSec + dt);
    } else {
      if (
        bowReleased &&
        bowAllow &&
        bowInHand &&
        state.bowDrawSec > 0 &&
        bowArrows >= 1
      ) {
        const chargeNorm = Math.min(1, state.bowDrawSec / BOW_MAX_DRAW_SEC);
        const easeOut = 1 - (1 - chargeNorm) * (1 - chargeNorm);
        const speed =
          ARROW_SPEED_MIN_PX + (ARROW_SPEED_MAX_PX - ARROW_SPEED_MIN_PX) * easeOut;
        const { dirX, dirY } = getAimUnitVectorFromFeet(
          state.position.x,
          state.position.y,
          input.mouseWorldPos.x,
          input.mouseWorldPos.y,
          state.facingRight,
        );
        if (this.inventory.consumeOneFromAnySlotByKey("stratum:arrow")) {
          this.sfxSelf("bow", {
            volume: 0.52 + easeOut * 0.38,
            pitchVariance: 32,
          });
          if (this._mpTerrainClient) {
            this.bus.emit({
              type: "bow:net-fire-request",
              dirX,
              dirY,
              speedPx: speed,
              chargeNorm: easeOut,
              shooterFeetX: state.position.x,
              shooterFeetY: state.position.y,
            } satisfies GameEvent);
          } else {
            this.bus.emit({
              type: "bow:fire-request",
              dirX,
              dirY,
              speedPx: speed,
              chargeNorm: easeOut,
              shooterFeetX: state.position.x,
            } satisfies GameEvent);
          }
          this.startHandSwingVisual();
        }
      }
      if (!rawBowRmb || !bowInHand || !bowAllow || bowArrows <= 0) {
        state.bowDrawSec = 0;
      }
    }

    if (input.isJustPressed("dropItem")) {
      const dropSlot = state.hotbarSlot % HOTBAR_SIZE;
      const dropStack = this.inventory.getStack(dropSlot);
      if (dropStack !== null && dropStack.count > 0) {
        const dmg = dropStack.damage ?? 0;
        if (dropStack.count <= 1) {
          this.inventory.setStack(dropSlot, null);
        } else {
          this.inventory.setStack(dropSlot, {
            itemId: dropStack.itemId,
            count: dropStack.count - 1,
            ...(dmg > 0 ? { damage: dmg } : {}),
          });
        }
        const { dirX, dirY } = getItemThrowUnitVectorFromFeet(
          state.position.x,
          state.position.y,
          input.mouseWorldPos.x,
          input.mouseWorldPos.y,
          state.facingRight,
        );
        const spd = ITEM_THROW_SPEED_PX;
        let vx =
          dirX * spd + state.velocity.x * ITEM_THROW_INHERIT_PLAYER_VEL_X;
        let vy = dirY * spd;
        ({ vx, vy } = clampItemThrowVelocity(vx, vy));
        const chestY = state.position.y + PLAYER_HEIGHT * 0.5;
        const off = ITEM_THROW_SPAWN_OFFSET_PX;
        const sx = state.position.x + dirX * off;
        const sy = chestY - dirY * off;
        world.spawnItem(
          dropStack.itemId,
          1,
          sx,
          sy,
          vx,
          vy,
          dmg,
          ITEM_PLAYER_THROW_PICKUP_DELAY_SEC,
        );
      }
    }

    if (input.isJustPressed("toggleBackgroundMode") && !input.isWorldInputBlocked()) {
      state.backgroundEditMode = !state.backgroundEditMode;
      state.breakTarget = null;
      state.breakAccum = 0;
      state.breakProgress = 0;
      state.handSwingRemainSec = 0;
      this.miningDigSoundAccum = 0;
    }

    const { wx, wy } = mouseToBlock(
      input.mouseWorldPos.x,
      input.mouseWorldPos.y,
    );
    const pcx = Math.floor(state.position.x / BLOCK_SIZE);
    const pcy = Math.floor(state.position.y / BLOCK_SIZE);
    const inReach =
      chebyshev(pcx, pcy, wx, wy) <= REACH_BLOCKS;

    if (input.isDown("break") && inReach) {
      const layer: BreakTargetLayer = state.backgroundEditMode ? "bg" : "fg";
      const def =
        layer === "bg"
          ? (() => {
              const bid = world.getBackgroundId(wx, wy);
              return bid !== 0 ? this.registry.getById(bid) : null;
            })()
          : world.getBlock(wx, wy);

      const canBreak =
        def !== null && def.id !== this.airId && def.hardness !== 999;

      if (canBreak && def !== null) {
        const heldSlot = state.hotbarSlot % HOTBAR_SIZE;
        const heldStack = this.inventory.getStack(heldSlot);
        const heldItemDef = heldStack !== null ? this.itemRegistry.getById(heldStack.itemId) : undefined;
        const breakTime = getBreakTimeSeconds(def, heldItemDef);

        if (
          state.breakTarget !== null &&
          state.breakTarget.wx === wx &&
          state.breakTarget.wy === wy &&
          state.breakTarget.layer === layer
        ) {
          state.breakAccum += dt;
          state.breakProgress = Math.min(
            1,
            state.breakAccum / breakTime,
          );
          if (state.breakProgress < 1) {
            this.miningDigSoundAccum += dt;
            while (
              this.miningDigSoundAccum >= MINING_DIG_SOUND_INTERVAL_SEC
            ) {
              this.miningDigSoundAccum -= MINING_DIG_SOUND_INTERVAL_SEC;
              this.sfxAtBlock(wx, wy, getDigSound(def.material), {
                volume: 0.5,
                pitchVariance: 35,
              });
            }
          }
          if (state.breakProgress >= 1) {
            if (this._mpTerrainClient) {
              const expectedBlockId =
                layer === "bg"
                  ? world.getBackgroundId(wx, wy)
                  : world.getBlock(wx, wy).id;
              this.bus.emit({
                type: "terrain:net-break-commit",
                wx,
                wy,
                layer,
                expectedBlockId,
                hotbarSlot: heldSlot,
                heldItemId:
                  heldStack !== null && heldStack.count > 0
                    ? heldStack.itemId
                    : 0,
              } satisfies GameEvent);
              state.breakTarget = null;
              state.breakAccum = 0;
              state.breakProgress = 0;
              this.miningDigSoundAccum = 0;
              this.startHandSwingVisual();
            } else {
            const dropsLoot = canHarvestDrops(def, heldItemDef);
            if (
              !dropsLoot &&
              def.requiresToolForDrops &&
              layer === "fg"
            ) {
              const now = performance.now();
              if (now - this._lastWrongToolNoDropHintMs > 3500) {
                this._lastWrongToolNoDropHintMs = now;
                this.bus.emit({
                  type: "ui:chat-line",
                  kind: "system",
                  text: "Wrong tool — no drops from this block.",
                } satisfies GameEvent);
              }
            }
            if (layer === "bg") {
              if (dropsLoot) world.spawnLootForBrokenBlock(def.id, wx, wy);
              world.setBackgroundBlock(wx, wy, 0);
            } else if (def.tallGrass === "bottom" || def.tallGrass === "top") {
              const bottomWy =
                def.tallGrass === "bottom" ? wy : wy - 1;
              const topWy = bottomWy + 1;
              const bottomOk =
                bottomWy >= WORLD_Y_MIN && bottomWy <= WORLD_Y_MAX;
              const topOk = topWy >= WORLD_Y_MIN && topWy <= WORLD_Y_MAX;
              const bottomCell = bottomOk ? world.getBlock(wx, bottomWy) : null;
              const topCell = topOk ? world.getBlock(wx, topWy) : null;
              const fullPlant =
                bottomCell !== null &&
                bottomCell.tallGrass === "bottom" &&
                topCell !== null &&
                topCell.tallGrass === "top";

              if (fullPlant && bottomCell !== null) {
                if (dropsLoot) world.spawnLootForBrokenBlock(bottomCell.id, wx, bottomWy);
                world.setBlock(wx, topWy, 0);
                world.setBlock(wx, bottomWy, 0);
              } else {
                if (dropsLoot) world.spawnLootForBrokenBlock(def.id, wx, wy);
                world.setBlock(wx, wy, 0);
              }
            } else if (def.doorHalf === "bottom" || def.doorHalf === "top") {
              const bottomWy = def.doorHalf === "bottom" ? wy : wy - 1;
              const topWy = bottomWy + 1;
              const bottomOk =
                bottomWy >= WORLD_Y_MIN && bottomWy <= WORLD_Y_MAX;
              const topOk = topWy >= WORLD_Y_MIN && topWy <= WORLD_Y_MAX;
              const bottomCell = bottomOk ? world.getBlock(wx, bottomWy) : null;
              const topCell = topOk ? world.getBlock(wx, topWy) : null;
              const fullDoor =
                bottomCell !== null &&
                bottomCell.doorHalf === "bottom" &&
                topCell !== null &&
                topCell.doorHalf === "top";

              if (fullDoor && bottomCell !== null) {
                if (dropsLoot) world.spawnLootForBrokenBlock(bottomCell.id, wx, bottomWy);
                world.setBlock(wx, topWy, 0);
                world.setBlock(wx, bottomWy, 0);
              } else {
                if (dropsLoot) world.spawnLootForBrokenBlock(def.id, wx, wy);
                world.setBlock(wx, wy, 0);
              }
            } else if (def.bedHalf === "foot" || def.bedHalf === "head") {
              const meta = world.getMetadata(wx, wy);
              const headPlusX = bedHeadPlusXFromMeta(meta);
              const footWx =
                def.bedHalf === "foot" ? wx : headPlusX ? wx - 1 : wx + 1;
              const headWx =
                def.bedHalf === "head" ? wx : headPlusX ? wx + 1 : wx - 1;
              const footCell = world.getBlock(footWx, wy);
              const headCell = world.getBlock(headWx, wy);
              const fullBed =
                footCell.bedHalf === "foot" && headCell.bedHalf === "head";

              if (fullBed) {
                if (dropsLoot) world.spawnLootForBrokenBlock(footCell.id, footWx, wy);
                world.setBlock(headWx, wy, 0);
                world.setBlock(footWx, wy, 0);
              } else {
                if (dropsLoot) world.spawnLootForBrokenBlock(def.id, wx, wy);
                world.setBlock(wx, wy, 0);
              }
            } else if (def.isPainting === true) {
              const pmeta = world.getMetadata(wx, wy);
              const decoded = decodePaintingMeta(pmeta);
              const pv = PAINTING_VARIANTS[decoded.variantIndex]!;
              const anchorX = wx - decoded.offsetX;
              const anchorY = wy - decoded.offsetY;
              if (dropsLoot) world.spawnLootForBrokenBlock(def.id, anchorX, anchorY);
              for (let oy = 0; oy < pv.height; oy++) {
                for (let ox = 0; ox < pv.width; ox++) {
                  world.setBlock(anchorX + ox, anchorY + oy, 0);
                }
              }
            } else {
              const wildTreeLogColumn =
                isTreeLogBlock(this.registry, def.id) &&
                (world.getMetadata(wx, wy) & WORLDGEN_NO_COLLIDE) !== 0;
              if (def.identifier === "stratum:furnace") {
                world.spawnFurnaceItemDropsAt(wx, wy);
              }
              if (def.identifier === "stratum:chest") {
                world.destroyChestForPlayerBreak(wx, wy, dropsLoot);
              } else {
                if (dropsLoot) world.spawnLootForBrokenBlock(def.id, wx, wy);
                world.setBlock(wx, wy, 0);
              }
              if (wildTreeLogColumn) {
                breakTreeLogsAboveColumn(
                  world,
                  this.registry,
                  wx,
                  wy,
                  this.airId,
                  heldItemDef,
                );
              }
            }
            this.inventory.applyToolUseFromMining(heldSlot);
            state.breakTarget = null;
            state.breakAccum = 0;
            state.breakProgress = 0;
            this.miningDigSoundAccum = 0;
            this.startHandSwingVisual();
            }
          }
        } else {
          state.breakTarget = { wx, wy, layer };
          state.breakAccum = 0;
          state.breakProgress = 0;
          this.miningDigSoundAccum = 0;
          this.sfxAtBlock(wx, wy, getDigSound(def.material), {
            volume: 0.5,
            pitchVariance: 35,
          });
        }
      } else {
        state.breakTarget = null;
        state.breakAccum = 0;
        state.breakProgress = 0;
        this.miningDigSoundAccum = 0;
      }
    } else {
      state.breakTarget = null;
      state.breakAccum = 0;
      state.breakProgress = 0;
      this.miningDigSoundAccum = 0;
    }

    if (
      input.isDown("break") &&
      state.breakTarget !== null &&
      state.breakProgress < 1
    ) {
      state.aimOutlineTarget = null;
    } else if (
      !input.isWorldInputBlocked() &&
      !state.dead &&
      !state.sleeping &&
      inReach
    ) {
      const aimLayer: BreakTargetLayer = state.backgroundEditMode ? "bg" : "fg";
      // Always show the cell outline at the crosshair (air, unbreakable, etc.), not only on solid blocks.
      state.aimOutlineTarget = { wx, wy, layer: aimLayer };
    } else {
      state.aimOutlineTarget = null;
    }

    const placeEdgeWithInventoryOpen =
      input.isWorldInputBlocked() &&
      !state.backgroundEditMode &&
      input.isJustPressedPlaceIgnoreWorldBlock();

    if (
      ((input.isJustPressed("place") && !this.isDrawingBow(input)) ||
        placeEdgeWithInventoryOpen) &&
      inReach
    ) {
      const cell = world.getBlock(wx, wy);
      // Water: replace in-cell like air/replaceable, but only if hasForegroundPlacementSupport
      // (solid neighbor or back-wall) — same gate as normal blocks below.
      const canPlaceInCell =
        cell.id === this.airId || cell.replaceable || cell.water;

      if (placeEdgeWithInventoryOpen && !canPlaceInCell) {
        if (cell.identifier === "stratum:chest") {
          this.bus.emit({
            type: "chest:open-request",
            wx,
            wy,
          } satisfies GameEvent);
        } else if (cell.identifier === "stratum:crafting_table") {
          this.bus.emit({
            type: "crafting-table:open-request",
            wx,
            wy,
          } satisfies GameEvent);
        } else if (cell.identifier === "stratum:stonecutter") {
          this.bus.emit({
            type: "stonecutter:open-request",
            wx,
            wy,
          } satisfies GameEvent);
        } else if (cell.identifier === "stratum:furnace") {
          this.bus.emit({
            type: "furnace:open-request",
            wx,
            wy,
          } satisfies GameEvent);
        } else if (cell.doorHalf === "bottom" || cell.doorHalf === "top") {
          const bottomWy = cell.doorHalf === "bottom" ? wy : wy - 1;
          const b = world.getBlock(wx, bottomWy);
          if (b.doorHalf === "bottom" && bottomWy + 1 <= WORLD_Y_MAX) {
            const t = world.getBlock(wx, bottomWy + 1);
            if (t.doorHalf === "top") {
              if (this._mpTerrainClient) {
                this.bus.emit({
                  type: "terrain:net-door-toggle",
                  wx,
                  wy: bottomWy,
                } satisfies GameEvent);
                this.startHandSwingVisual();
              } else {
              const m = world.getMetadata(wx, bottomWy);
              const newM = toggleDoorLatchInMeta(m);
              world.setBlock(wx, bottomWy, b.id, { cellMetadata: newM });
              world.setBlock(wx, bottomWy + 1, t.id, { cellMetadata: newM });
              this.startHandSwingVisual();
              this.sfxAtBlock(
                wx,
                bottomWy,
                doorLatchedOpenFromMeta(newM)
                  ? getOpenSound("door")
                  : getCloseSound("door"),
                { pitchVariance: 25 },
              );
              }
            }
          }
        }
        else if (cell.bedHalf === "foot" || cell.bedHalf === "head") {
          this.bus.emit({
            type: "bed:sleep-request",
            wx,
            wy,
          } satisfies GameEvent);
          this.startHandSwingVisual();
        }
      } else if (!input.isWorldInputBlocked()) {
      let placeHandled = false;
      if (input.isJustPressed("place") && !state.backgroundEditMode) {
        const hotbarSlot = state.hotbarSlot % HOTBAR_SIZE;
        const stack = this.inventory.getStack(hotbarSlot);
        const held =
          stack !== null ? this.itemRegistry.getById(stack.itemId) : undefined;
        const farmlandDryId = this.registry.getByIdentifier(
          "stratum:farmland_dry",
        ).id;
        const farmlandMoistId = this.registry.getByIdentifier(
          "stratum:farmland_moist",
        ).id;

        if (held?.key === "stratum:bucket" && cell.water) {
          if (isWaterSourceMetadata(world.getMetadata(wx, wy))) {
            const wb = this.itemRegistry.getByKey("stratum:water_bucket");
            if (wb !== undefined) {
              if (this._mpTerrainClient) {
                this.emitNetPlace(
                  SUB_BUCKET_FILL,
                  wx,
                  wy,
                  hotbarSlot,
                  0,
                  0,
                );
                placeHandled = true;
                this.startHandSwingVisual();
              } else if (world.setBlock(wx, wy, this.airId)) {
                this.inventory.setStack(hotbarSlot, { itemId: wb.id, count: 1 });
                placeHandled = true;
                this.startHandSwingVisual();
                this.sfxAtBlock(wx, wy, getPlaceSound("generic"), {
                  pitchVariance: 20,
                });
              }
            }
          }
        }

        if (!placeHandled && held?.key === "stratum:wheat_seeds") {
          if (isWheatCropIdentifier(cell.identifier)) {
            // Seeds on an existing crop: ignore (no break, no consume, no swing).
            placeHandled = true;
          } else {
            const below = world.getBlock(wx, wy - 1);
            const onFarmland =
              below.id === farmlandDryId || below.id === farmlandMoistId;
            if (onFarmland) {
              const canPlaceInTarget =
                cell.id === this.airId ||
                (cell.replaceable && cell.id !== this.airId);
              if (canPlaceInTarget) {
                const wheat0 = this.registry.getByIdentifier(
                  "stratum:wheat_stage_0",
                ).id;
                const hasSupport = world.hasForegroundPlacementSupport(wx, wy);
                const blockAabb = createAABB(
                  wx * BLOCK_SIZE,
                  -(wy + 1) * BLOCK_SIZE,
                  BLOCK_SIZE,
                  BLOCK_SIZE,
                );
                const playerAabb = feetToScreenAABB(state.position);
                let overlapsAnyPlayer = overlaps(playerAabb, blockAabb);
                if (!overlapsAnyPlayer) {
                  for (const remote of world.getRemotePlayers().values()) {
                    const feet = remote.getAuthorityFeet();
                    const remoteAabb = feetToScreenAABB({ x: feet.x, y: feet.y });
                    if (overlaps(remoteAabb, blockAabb)) {
                      overlapsAnyPlayer = true;
                      break;
                    }
                  }
                }
                const overlapsAnyMob =
                  this._mobOverlapCheck !== null &&
                  this._mobOverlapCheck(blockAabb);
                if (
                  hasSupport &&
                  !overlapsAnyPlayer &&
                  !overlapsAnyMob &&
                  world.canPlaceForegroundWithCactusRules(wx, wy, wheat0)
                ) {
                  if (this._mpTerrainClient) {
                    this.emitNetPlace(SUB_WHEAT, wx, wy, hotbarSlot, 0, 0);
                    placeHandled = true;
                    this.startHandSwingVisual();
                  } else {
                    if (cell.id !== this.airId) {
                      world.spawnLootForBrokenBlock(cell.id, wx, wy);
                      world.setBlock(wx, wy, this.airId);
                    }
                    if (world.setBlock(wx, wy, wheat0)) {
                      if (this.inventory.consumeOneFromSlot(hotbarSlot)) {
                        placeHandled = true;
                        this.startHandSwingVisual();
                        this.sfxAtBlock(wx, wy, getPlaceSound("grass"), {
                          pitchVariance: 25,
                        });
                      } else {
                        world.setBlock(wx, wy, this.airId);
                      }
                    }
                  }
                }
              }
            }
          }
        }

        if (!placeHandled && held?.toolType === "hoe") {
          if (cell.id !== farmlandDryId && cell.id !== farmlandMoistId) {
            if (
              cell.identifier === "stratum:dirt" ||
              cell.identifier === "stratum:grass"
            ) {
              const above = world.getBlock(wx, wy + 1);
              const clearAbove =
                above.id === this.airId ||
                (above.replaceable && above.id !== this.airId);
              if (clearAbove) {
                if (this._mpTerrainClient) {
                  this.emitNetPlace(SUB_HOE, wx, wy, hotbarSlot, 0, 0);
                  placeHandled = true;
                  this.startHandSwingVisual();
                } else {
                if (above.id !== this.airId) {
                  world.spawnLootForBrokenBlock(above.id, wx, wy + 1);
                  world.setBlock(wx, wy + 1, this.airId);
                }
                if (world.setBlock(wx, wy, farmlandDryId)) {
                  this.inventory.applyToolUseFromMining(hotbarSlot);
                  this.startHandSwingVisual();
                  this.sfxAtBlock(wx, wy, getPlaceSound("dirt"), {
                    pitchVariance: 30,
                  });
                  placeHandled = true;
                }
                }
              }
            }
          }
        }

      }
      if (!placeHandled) {
      if (state.backgroundEditMode) {
        const bgEmpty = world.getBackgroundId(wx, wy) === 0;
        if (bgEmpty) {
          const hotbarSlot = state.hotbarSlot % HOTBAR_SIZE;
          const stack = this.inventory.getStack(hotbarSlot);
          if (stack !== null) {
            const itemDef = this.itemRegistry.getById(stack.itemId);
            const placesBlockId = itemPlacesBlock(itemDef);
            if (placesBlockId !== 0) {
              const placedDef = this.registry.getById(placesBlockId);
              if (
                placedDef.tallGrass === "bottom" ||
                placedDef.bedHalf === "foot" ||
                placedDef.isPainting === true
              ) {
                // multi-cell / painting blocks not supported on back layer
              } else if (this._mpTerrainClient) {
                this.emitNetPlace(
                  SUB_BG,
                  wx,
                  wy,
                  hotbarSlot,
                  placesBlockId,
                  0,
                );
                this.startHandSwingVisual();
              } else if (world.setBackgroundBlock(wx, wy, placesBlockId)) {
                if (!this.inventory.consumeOneFromSlot(hotbarSlot)) {
                  world.setBackgroundBlock(wx, wy, 0);
                } else {
                  this.startHandSwingVisual();
                  this.sfxAtBlock(wx, wy, getPlaceSound(placedDef.material), {
                    pitchVariance: 30,
                  });
                }
              }
            }
          }
        }
      } else {
      if (canPlaceInCell) {
        const hotbarSlot = state.hotbarSlot % HOTBAR_SIZE;
        const stack = this.inventory.getStack(hotbarSlot);
        if (stack !== null) {
          const itemDef = this.itemRegistry.getById(stack.itemId);
          const placesBlockId = itemPlacesBlock(itemDef);
          if (placesBlockId !== 0) {
            const placedDef = this.registry.getById(placesBlockId);
            const below = world.getBlock(wx, wy - 1);

            const plantTallBottom = placedDef.tallGrass === "bottom";
            const plantFlowerLike =
              plantTallBottom || isFlowerOrShortGrass(placedDef.identifier);

            const isSugarCane = placedDef.identifier === "stratum:sugar_cane";
            let sugarCaneValid = true;
            if (isSugarCane) {
              sugarCaneValid = false;
              if (!cell.water) {
                const soilOk =
                  below.identifier === "stratum:sand" ||
                  below.identifier === "stratum:grass" ||
                  below.identifier === "stratum:dirt";
                const belowIsSugarCane = below.identifier === "stratum:sugar_cane";
                if (soilOk || belowIsSugarCane) {
                  let baseY = wy;
                  if (belowIsSugarCane) {
                    baseY = wy - 1;
                    while (baseY - 1 >= WORLD_Y_MIN) {
                      const b = world.getBlock(wx, baseY - 1);
                      if (b.identifier !== "stratum:sugar_cane") {
                        break;
                      }
                      baseY -= 1;
                    }
                  }
                  const soilY = baseY - 1;
                  const soil = world.getBlock(wx, soilY);
                  const soilOk2 =
                    soil.identifier === "stratum:sand" ||
                    soil.identifier === "stratum:grass" ||
                    soil.identifier === "stratum:dirt";
                  const waterAdj =
                    world.getBlock(wx - 1, soilY).water ||
                    world.getBlock(wx + 1, soilY).water ||
                    world.getBlock(wx, soilY - 1).water ||
                    world.getBlock(wx, soilY + 1).water ||
                    world.getBlock(wx - 1, soilY - 1).water ||
                    world.getBlock(wx + 1, soilY - 1).water;
                  if (soilOk2 && waterAdj) {
                    sugarCaneValid = true;
                  }
                }
              }
            }

            if (isSugarCane && !sugarCaneValid) {
              // invalid: sugar cane needs sand/grass/dirt (or stacked cane) and adjacent water at the base
            } else if (plantFlowerLike && !isGrassOrDirtSurface(below)) {
              // invalid: flowers and tall grass need grass or dirt below
            } else if (
              isSaplingIdentifier(placedDef.identifier) &&
              !isGrassDirtOrFarmlandSurface(below)
            ) {
              // invalid: saplings need grass, dirt, or farmland below
            } else if (plantTallBottom) {
              const topCell = world.getBlock(wx, wy + 1);
              if (topCell.solid && !topCell.replaceable) {
                // two-tall plant does not fit (e.g. 1-block-tall gap)
              } else {
                const aabbLower = createAABB(
                  wx * BLOCK_SIZE,
                  -(wy + 1) * BLOCK_SIZE,
                  BLOCK_SIZE,
                  BLOCK_SIZE,
                );
                const aabbUpper = createAABB(
                  wx * BLOCK_SIZE,
                  -(wy + 2) * BLOCK_SIZE,
                  BLOCK_SIZE,
                  BLOCK_SIZE,
                );
                const playerAabb = feetToScreenAABB(state.position);
                let overlapsAnyPlayer =
                  overlaps(playerAabb, aabbLower) ||
                  overlaps(playerAabb, aabbUpper);
                if (!overlapsAnyPlayer) {
                  for (const remote of world.getRemotePlayers().values()) {
                    const feet = remote.getAuthorityFeet();
                    const remoteAabb = feetToScreenAABB({ x: feet.x, y: feet.y });
                    if (
                      overlaps(remoteAabb, aabbLower) ||
                      overlaps(remoteAabb, aabbUpper)
                    ) {
                      overlapsAnyPlayer = true;
                      break;
                    }
                  }
                }
                const overlapsAnyMob =
                  this._mobOverlapCheck !== null &&
                  (this._mobOverlapCheck(aabbLower) || this._mobOverlapCheck(aabbUpper));
                if (
                  !overlapsAnyPlayer &&
                  !overlapsAnyMob &&
                  world.canPlaceForegroundWithCactusRules(wx, wy, placesBlockId)
                ) {
                  const topId = this.registry.getByIdentifier("stratum:tall_grass_top").id;
                  if (!world.canPlaceForegroundWithCactusRules(wx, wy + 1, topId)) {
                    // tall grass top would touch cactus horizontally
                  } else if (this._mpTerrainClient) {
                    this.emitNetPlace(
                      SUB_TALL_GRASS,
                      wx,
                      wy,
                      hotbarSlot,
                      0,
                      0,
                    );
                    const placed = this.registry.getById(placesBlockId);
                    this.startHandSwingVisual();
                    this.sfxAtBlock(wx, wy, getPlaceSound(placed.material), {
                      pitchVariance: 30,
                    });
                  } else if (!world.setBlock(wx, wy, placesBlockId)) {
                    // vertical bounds
                  } else if (!world.setBlock(wx, wy + 1, topId)) {
                    world.setBlock(wx, wy, 0);
                  } else if (!this.inventory.consumeOneFromSlot(hotbarSlot)) {
                    world.setBlock(wx, wy, 0);
                    world.setBlock(wx, wy + 1, 0);
                  } else {
                    const placed = this.registry.getById(placesBlockId);
                    this.startHandSwingVisual();
                    this.sfxAtBlock(wx, wy, getPlaceSound(placed.material), {
                      pitchVariance: 30,
                    });
                  }
                }
              }
            } else if (placedDef.bedHalf === "foot") {
              const surfaceBelow = world.getBlock(wx, wy - 1);
              const cellLeft = wx * BLOCK_SIZE;
              const cellRight = (wx + 1) * BLOCK_SIZE;
              const px = state.position.x;
              const headPlusX =
                Math.abs(px - cellRight) <= Math.abs(px - cellLeft);
              const hx = headPlusX ? wx + 1 : wx - 1;
              const surfaceBelowHead = world.getBlock(hx, wy - 1);
              const surfaceOk =
                surfaceBelow.solid &&
                !surfaceBelow.replaceable &&
                !surfaceBelow.water &&
                surfaceBelowHead.solid &&
                !surfaceBelowHead.replaceable &&
                !surfaceBelowHead.water;
              if (!surfaceOk) {
                //
              } else if (
                !world.hasForegroundPlacementSupport(wx, wy) ||
                !world.hasForegroundPlacementSupport(hx, wy)
              ) {
                //
              } else {
                const headCell = world.getBlock(hx, wy);
                if (headCell.solid && !headCell.replaceable && !headCell.water) {
                  //
                } else {
                  const aabbFoot = createAABB(
                    wx * BLOCK_SIZE,
                    -(wy + 1) * BLOCK_SIZE,
                    BLOCK_SIZE,
                    BLOCK_SIZE,
                  );
                  const aabbHead = createAABB(
                    hx * BLOCK_SIZE,
                    -(wy + 1) * BLOCK_SIZE,
                    BLOCK_SIZE,
                    BLOCK_SIZE,
                  );
                  const playerAabb = feetToScreenAABB(state.position);
                  let overlapsAnyPlayer =
                    overlaps(playerAabb, aabbFoot) ||
                    overlaps(playerAabb, aabbHead);
                  if (!overlapsAnyPlayer) {
                    for (const remote of world.getRemotePlayers().values()) {
                      const feet = remote.getAuthorityFeet();
                      const remoteAabb = feetToScreenAABB({ x: feet.x, y: feet.y });
                      if (
                        overlaps(remoteAabb, aabbFoot) ||
                        overlaps(remoteAabb, aabbHead)
                      ) {
                        overlapsAnyPlayer = true;
                        break;
                      }
                    }
                  }
                  const footId = placesBlockId;
                  const headId = this.registry.getByIdentifier("stratum:bed_head").id;
                  const overlapsAnyMob =
                    this._mobOverlapCheck !== null &&
                    (this._mobOverlapCheck(aabbFoot) || this._mobOverlapCheck(aabbHead));
                  if (
                    !overlapsAnyPlayer &&
                    !overlapsAnyMob &&
                    world.canPlaceForegroundWithCactusRules(wx, wy, footId) &&
                    world.canPlaceForegroundWithCactusRules(hx, wy, headId)
                  ) {
                    if (this._mpTerrainClient) {
                      this.emitNetPlace(
                        SUB_BED_PAIR,
                        wx,
                        wy,
                        hotbarSlot,
                        0,
                        headPlusX ? 1 : 0,
                      );
                      this.startHandSwingVisual();
                      this.sfxAtBlock(wx, wy, getPlaceSound(placedDef.material), {
                        pitchVariance: 30,
                      });
                    } else {
                      const bedMeta = packBedMetadata(0, headPlusX);
                      if (!world.setBlock(wx, wy, footId, {
                        cellMetadata: bedMeta,
                      })) {
                        //
                      } else if (
                        !world.setBlock(hx, wy, headId, {
                          cellMetadata: bedMeta,
                        })
                      ) {
                        world.setBlock(wx, wy, 0);
                      } else if (!this.inventory.consumeOneFromSlot(hotbarSlot)) {
                        world.setBlock(wx, wy, 0);
                        world.setBlock(hx, wy, 0);
                      } else {
                        this.startHandSwingVisual();
                        this.sfxAtBlock(wx, wy, getPlaceSound(placedDef.material), {
                          pitchVariance: 30,
                        });
                      }
                    }
                  }
                }
              }
            } else if (placedDef.isPainting === true) {
              const fitting: number[] = [];
              for (let vi = 0; vi < PAINTING_VARIANTS.length; vi++) {
                const pv = PAINTING_VARIANTS[vi]!;
                let fits = true;
                for (let oy = 0; oy < pv.height && fits; oy++) {
                  for (let ox = 0; ox < pv.width && fits; ox++) {
                    const cx = wx + ox;
                    const cy = wy + oy;
                    const fg = world.getBlock(cx, cy);
                    if (fg.solid && !fg.replaceable && !fg.water) {
                      fits = false;
                    } else if (world.getBackgroundId(cx, cy) === 0) {
                      fits = false;
                    }
                  }
                }
                if (fits) fitting.push(vi);
              }
              if (fitting.length > 0) {
                const chosen = fitting[Math.floor(Math.random() * fitting.length)]!;
                const pv = PAINTING_VARIANTS[chosen]!;
                if (this._mpTerrainClient) {
                  this.emitNetPlace(SUB_PAINTING, wx, wy, hotbarSlot, 0, chosen);
                  this.startHandSwingVisual();
                  this.sfxAtBlock(wx, wy, getPlaceSound(placedDef.material), {
                    pitchVariance: 30,
                  });
                } else {
                  let placed = true;
                  for (let oy = 0; oy < pv.height && placed; oy++) {
                    for (let ox = 0; ox < pv.width && placed; ox++) {
                      const meta = encodePaintingMeta(chosen, ox, oy);
                      if (!world.setBlock(wx + ox, wy + oy, placesBlockId, { cellMetadata: meta })) {
                        placed = false;
                      }
                    }
                  }
                  if (!placed) {
                    for (let oy = 0; oy < pv.height; oy++) {
                      for (let ox = 0; ox < pv.width; ox++) {
                        world.setBlock(wx + ox, wy + oy, 0);
                      }
                    }
                  } else if (!this.inventory.consumeOneFromSlot(hotbarSlot)) {
                    for (let oy = 0; oy < pv.height; oy++) {
                      for (let ox = 0; ox < pv.width; ox++) {
                        world.setBlock(wx + ox, wy + oy, 0);
                      }
                    }
                  } else {
                    this.startHandSwingVisual();
                    this.sfxAtBlock(wx, wy, getPlaceSound(placedDef.material), {
                      pitchVariance: 30,
                    });
                  }
                }
              }
            } else if (placedDef.doorHalf === "bottom") {
              const surfaceBelow = world.getBlock(wx, wy - 1);
              const surfaceOk =
                surfaceBelow.solid &&
                !surfaceBelow.replaceable &&
                !surfaceBelow.water;
              if (!surfaceOk) {
                // door needs a solid block under the lower half
              } else if (!world.hasForegroundPlacementSupport(wx, wy)) {
                //
              } else {
                const topCell = world.getBlock(wx, wy + 1);
                if (topCell.solid && !topCell.replaceable) {
                  //
                } else {
                  const aabbLower = createAABB(
                    wx * BLOCK_SIZE,
                    -(wy + 1) * BLOCK_SIZE,
                    BLOCK_SIZE,
                    BLOCK_SIZE,
                  );
                  const aabbUpper = createAABB(
                    wx * BLOCK_SIZE,
                    -(wy + 2) * BLOCK_SIZE,
                    BLOCK_SIZE,
                    BLOCK_SIZE,
                  );
                  const playerAabb = feetToScreenAABB(state.position);
                  let overlapsAnyPlayer =
                    overlaps(playerAabb, aabbLower) ||
                    overlaps(playerAabb, aabbUpper);
                  if (!overlapsAnyPlayer) {
                    for (const remote of world.getRemotePlayers().values()) {
                      const feet = remote.getAuthorityFeet();
                      const remoteAabb = feetToScreenAABB({ x: feet.x, y: feet.y });
                      if (
                        overlaps(remoteAabb, aabbLower) ||
                        overlaps(remoteAabb, aabbUpper)
                      ) {
                        overlapsAnyPlayer = true;
                        break;
                      }
                    }
                  }
                  const overlapsAnyMob =
                    this._mobOverlapCheck !== null &&
                    (this._mobOverlapCheck(aabbLower) || this._mobOverlapCheck(aabbUpper));
                  if (
                    !overlapsAnyPlayer &&
                    !overlapsAnyMob &&
                    world.canPlaceForegroundWithCactusRules(wx, wy, placesBlockId)
                  ) {
                    const topId = this.registry.getByIdentifier(
                      "stratum:oak_door_top",
                    ).id;
                    if (
                      !world.canPlaceForegroundWithCactusRules(wx, wy + 1, topId)
                    ) {
                      //
                    } else {
                      const cellLeft = wx * BLOCK_SIZE;
                      const cellRight = (wx + 1) * BLOCK_SIZE;
                      const px = state.position.x;
                      const hingeRight =
                        Math.abs(px - cellRight) <= Math.abs(px - cellLeft);
                      if (this._mpTerrainClient) {
                        this.emitNetPlace(
                          SUB_DOOR_PAIR,
                          wx,
                          wy,
                          hotbarSlot,
                          0,
                          hingeRight ? 1 : 0,
                        );
                        this.startHandSwingVisual();
                        this.sfxAtBlock(wx, wy, getPlaceSound(placedDef.material), {
                          pitchVariance: 30,
                        });
                      } else {
                      const doorMeta = packDoorMetadata(0, hingeRight, false);
                      if (!world.setBlock(wx, wy, placesBlockId, {
                        cellMetadata: doorMeta,
                      })) {
                        //
                      } else if (
                        !world.setBlock(wx, wy + 1, topId, {
                          cellMetadata: doorMeta,
                        })
                      ) {
                        world.setBlock(wx, wy, 0);
                      } else if (!this.inventory.consumeOneFromSlot(hotbarSlot)) {
                        world.setBlock(wx, wy, 0);
                        world.setBlock(wx, wy + 1, 0);
                      } else {
                        this.startHandSwingVisual();
                        this.sfxAtBlock(wx, wy, getPlaceSound(placedDef.material), {
                          pitchVariance: 30,
                        });
                      }
                      }
                    }
                  }
                }
              }
            } else {
              const hasSupport = world.hasForegroundPlacementSupport(wx, wy);
              if (hasSupport) {
                const blockAabb = createAABB(
                  wx * BLOCK_SIZE,
                  -(wy + 1) * BLOCK_SIZE,
                  BLOCK_SIZE,
                  BLOCK_SIZE,
                );
                const playerAabb = feetToScreenAABB(state.position);
                let overlapsAnyPlayer = overlaps(playerAabb, blockAabb);
                if (!overlapsAnyPlayer) {
                  for (const remote of world.getRemotePlayers().values()) {
                    const feet = remote.getAuthorityFeet();
                    const remoteAabb = feetToScreenAABB({ x: feet.x, y: feet.y });
                    if (overlaps(remoteAabb, blockAabb)) {
                      overlapsAnyPlayer = true;
                      break;
                    }
                  }
                }
                const overlapsAnyMob =
                  this._mobOverlapCheck !== null &&
                  this._mobOverlapCheck(blockAabb);
                if (
                  !overlapsAnyPlayer &&
                  !overlapsAnyMob &&
                  world.canPlaceForegroundWithCactusRules(wx, wy, placesBlockId)
                ) {
                  const placedDefForSfx = this.registry.getById(placesBlockId);
                  const waterBlockId = world.getWaterBlockId();
                  if (this._mpTerrainClient) {
                    this.emitNetPlace(
                      SUB_SIMPLE_FG,
                      wx,
                      wy,
                      hotbarSlot,
                      placesBlockId,
                      0,
                    );
                    this.startHandSwingVisual();
                    this.sfxAtBlock(wx, wy, getPlaceSound(placedDefForSfx.material), {
                      pitchVariance: 30,
                    });
                  } else {
                  const stairMeta =
                    placedDefForSfx.isStair === true
                      ? withStairShape(
                          0,
                          computePlacedStairShape(wx, state.position.x),
                        )
                      : undefined;
                  const placedCellOk =
                    placesBlockId === waterBlockId &&
                    itemDef?.key === "stratum:water_bucket"
                      ? world.setBlock(wx, wy, waterBlockId, {
                          cellMetadata: withWaterFlowLevel(0, 0),
                        })
                      : stairMeta !== undefined
                        ? world.setBlock(wx, wy, placesBlockId, {
                            cellMetadata: stairMeta,
                          })
                        : world.setBlock(wx, wy, placesBlockId);
                  if (!placedCellOk) {
                    // vertical bounds
                  } else if (!this.inventory.consumeOneFromSlot(hotbarSlot)) {
                    world.setBlock(wx, wy, this.airId);
                  } else {
                    if (itemDef?.key === "stratum:water_bucket") {
                      const bdef = this.itemRegistry.getByKey("stratum:bucket");
                      if (bdef !== undefined) {
                        this.inventory.setStack(hotbarSlot, {
                          itemId: bdef.id,
                          count: 1,
                        });
                      }
                    }
                    this.startHandSwingVisual();
                    this.sfxAtBlock(wx, wy, getPlaceSound(placedDefForSfx.material), {
                      pitchVariance: 30,
                    });
                  }
                  }
                }
              }
            }
          }
        }
      } else if (cell.doorHalf === "bottom" || cell.doorHalf === "top") {
        if (input.isJustPressed("place")) {
          const bottomWy = cell.doorHalf === "bottom" ? wy : wy - 1;
          const b = world.getBlock(wx, bottomWy);
          if (b.doorHalf === "bottom" && bottomWy + 1 <= WORLD_Y_MAX) {
            const t = world.getBlock(wx, bottomWy + 1);
            if (t.doorHalf === "top") {
              if (this._mpTerrainClient) {
                this.bus.emit({
                  type: "terrain:net-door-toggle",
                  wx,
                  wy: bottomWy,
                } satisfies GameEvent);
                this.startHandSwingVisual();
              } else {
              const m = world.getMetadata(wx, bottomWy);
              const newM = toggleDoorLatchInMeta(m);
              world.setBlock(wx, bottomWy, b.id, { cellMetadata: newM });
              world.setBlock(wx, bottomWy + 1, t.id, { cellMetadata: newM });
              this.startHandSwingVisual();
              this.sfxAtBlock(
                wx,
                bottomWy,
                doorLatchedOpenFromMeta(newM)
                  ? getOpenSound("door")
                  : getCloseSound("door"),
                { pitchVariance: 25 },
              );
              }
            }
          }
        }
      } else if (cell.identifier === "stratum:chest") {
        this.bus.emit({
          type: "chest:open-request",
          wx,
          wy,
        } satisfies GameEvent);
      } else if (cell.identifier === "stratum:crafting_table") {
        this.bus.emit({
          type: "crafting-table:open-request",
          wx,
          wy,
        } satisfies GameEvent);
      } else if (cell.identifier === "stratum:stonecutter") {
        this.bus.emit({
          type: "stonecutter:open-request",
          wx,
          wy,
        } satisfies GameEvent);
      } else if (cell.identifier === "stratum:furnace") {
        this.bus.emit({
          type: "furnace:open-request",
          wx,
          wy,
        } satisfies GameEvent);
      } else if (cell.bedHalf === "foot" || cell.bedHalf === "head") {
        this.bus.emit({
          type: "bed:sleep-request",
          wx,
          wy,
        } satisfies GameEvent);
        this.startHandSwingVisual();
      }
      }

      if (
        !placeHandled &&
        input.isJustPressed("place") &&
        !state.backgroundEditMode
      ) {
        const hotbarSlot = state.hotbarSlot % HOTBAR_SIZE;
        const stack = this.inventory.getStack(hotbarSlot);
        const heldEdible =
          stack !== null ? this.itemRegistry.getById(stack.itemId) : undefined;
        if (heldEdible !== undefined && this.canConsumeEdible(heldEdible)) {
          this.tryConsumeEdibleInWorld(hotbarSlot);
        }
      }
      }
      }
    }

    if (
      input.isJustPressed("place") &&
      !input.isWorldInputBlocked() &&
      !state.backgroundEditMode &&
      !inReach
    ) {
      const hotbarSlot = state.hotbarSlot % HOTBAR_SIZE;
      const stack = this.inventory.getStack(hotbarSlot);
      const heldFar =
        stack !== null ? this.itemRegistry.getById(stack.itemId) : undefined;
      if (heldFar !== undefined && this.canConsumeEdible(heldFar)) {
        this.tryConsumeEdibleInWorld(hotbarSlot);
      }
    }

    if (state.hotbarSlot !== this.prevHotbarSlot) {
      this.prevHotbarSlot = state.hotbarSlot;
      state.bowDrawSec = 0;
      this.bus.emit({
        type: "player:hotbarChanged",
        slot: state.hotbarSlot,
      } satisfies GameEvent);
    }

    if (!state.onGround) {
      state.stepAccum = 0;
    } else if (Math.abs(state.velocity.x) > 10) {
      state.stepAccum += dt;
      if (state.stepAccum >= STEP_INTERVAL) {
        state.stepAccum = 0;
        const blockBelow = getFeetSupportBlock(
          world,
          state.position.x,
          state.position.y,
        );
        const sbx = Math.floor(state.position.x / BLOCK_SIZE);
        const sfy = Math.floor(state.position.y / BLOCK_SIZE);
        const atFeetStep = world.getBlock(sbx, sfy);
        const swy = atFeetStep.isStair === true ? sfy : sfy - 1;
        this.sfxAtBlock(sbx, swy, getStepSound(blockBelow.material), {
          volume: 0.4,
          pitchVariance: 80,
        });
        if (!blockBelow.water && blockBelow.id !== this.airId) {
          this.bus.emit({
            type: "entity:ground-kick",
            feetWorldX: state.position.x,
            feetWorldY: state.position.y,
            velocityX: state.velocity.x,
            blockId: blockBelow.id,
          } satisfies GameEvent);
        }
      }
    } else {
      state.stepAccum = 0;
    }

    state.handSwingRemainSec = Math.max(0, state.handSwingRemainSec - dt);

    const blockX = Math.floor(state.position.x / BLOCK_SIZE);
    const blockY = Math.floor(state.position.y / BLOCK_SIZE);
    if (blockX !== this.lastMovedBlockX || blockY !== this.lastMovedBlockY) {
      this.lastMovedBlockX = blockX;
      this.lastMovedBlockY = blockY;
      this.bus.emit({
        type: "player:moved",
        wx: blockX,
        wy: blockY,
        blockX,
        blockY,
      } satisfies GameEvent);
    }
  }
}
