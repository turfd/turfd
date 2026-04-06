/**
 * Local player: world-pixel feet (Y up), screen vy (positive down), break/place, hotbar.
 */
import type { AudioEngine } from "../audio/AudioEngine";
import { getBreakSound, getPlaceSound, getStepSound } from "../audio/blockSounds";
import type { EventBus } from "../core/EventBus";
import type { GameEvent } from "../core/types";
import {
  BLOCK_SIZE,
  HOTBAR_SIZE,
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
  PLAYER_WIDTH,
  PLAYER_FALL_SHALLOW_WATER_DAMAGE_MULT,
  PLAYER_HAND_SWING_VISUAL_DURATION_SEC,
  REACH_BLOCKS,
  STEP_INTERVAL,
  WORLD_Y_MAX,
  WORLD_Y_MIN,
  playerFallDamageFromDistance,
} from "../core/constants";
import { getBreakTimeSeconds, canHarvestDrops } from "../core/mining";
import type { InputAction } from "../input/bindings";
import { getAimUnitVectorFromFeet } from "../input/aimDirection";
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
 * Horizontal caps in blocks/s (1 block ≈ 1 m). Sprint is ~30% over walk (5.612 / 4.317 ≈ 1.3).
 * While sprinting in the air with a move input, use the sprint-jump reference horizontal speed
 * (vanilla-style average over hop cycles ≈ 7.127 m/s).
 */
const WALK_SPEED_BLOCKS_PER_SEC = 4.317;
const SPRINT_SPEED_BLOCKS_PER_SEC = 5.612;
const SPRINT_JUMP_HORIZONTAL_BLOCKS_PER_SEC = 7.127;

const WALK_SPEED = WALK_SPEED_BLOCKS_PER_SEC * BLOCK_SIZE;
const SPRINT_SPEED = SPRINT_SPEED_BLOCKS_PER_SEC * BLOCK_SIZE;
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
  /** Tab: edit back-wall tiles (place/break) instead of foreground. */
  backgroundEditMode: boolean;
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
};

function feetToScreenAABB(pos: { x: number; y: number }): AABB {
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

function playerAabbOverlapsWater(world: World, pos: { x: number; y: number }): boolean {
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
    backgroundEditMode: false,
    breakTarget: null,
    breakProgress: 0,
    breakAccum: 0,
    stepAccum: 0,
    coyoteTimeRemaining: 0,
    jumpBufferRemaining: 0,
    handSwingRemainSec: 0,
  };

  public readonly inventory: PlayerInventory;

  private readonly solidScratch: AABB[] = [];
  private readonly bus: EventBus;
  private readonly audio: AudioEngine;
  private readonly registry: BlockRegistry;
  private readonly itemRegistry: ItemRegistry;
  private readonly airId: number;
  private prevHotbarSlot = 0;
  /** Downward feet travel (blocks) while airborne; reset on ground. Landing includes this frame’s drop. */
  private fallDistanceBlocks = 0;

  constructor(registry: BlockRegistry, bus: EventBus, audio: AudioEngine, itemRegistry: ItemRegistry) {
    this.bus = bus;
    this.audio = audio;
    this.registry = registry;
    this.itemRegistry = itemRegistry;
    this.inventory = new PlayerInventory(itemRegistry);
    this.airId = registry.getByIdentifier("stratum:air").id;
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
    this.state.handSwingRemainSec = 0;
    this.fallDistanceBlocks = 0;
  }

  /** Reduce health; amount is floored. HP does not go below 0. */
  takeDamage(amount: number): void {
    if (amount <= 0) {
      return;
    }
    const d = Math.floor(amount);
    this.state.health = Math.max(0, this.state.health - d);
  }

  /** Restore health; amount is floored. HP does not exceed `PLAYER_MAX_HEALTH`. */
  heal(amount: number): void {
    if (amount <= 0) {
      return;
    }
    const h = Math.floor(amount);
    this.state.health = Math.min(PLAYER_MAX_HEALTH, this.state.health + h);
  }

  /** Same mining-style swing as breaking blocks (body + held item), for place / use feedback. */
  private startHandSwingVisual(): void {
    this.state.handSwingRemainSec = PLAYER_HAND_SWING_VISUAL_DURATION_SEC;
  }

  /** Restore position, hotbar, and inventory from persistence. */
  applySavedState(
    feetWorldX: number,
    feetWorldY: number,
    hotbarSlot: number,
    inventory?: import("../items/PlayerInventory").SerializedInventorySlot[],
    health?: number,
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
    if (inventory !== undefined) {
      this.inventory.restore(inventory);
    }
    this.bus.emit({
      type: "player:hotbarChanged",
      slot,
    } satisfies GameEvent);
  }

  update(dt: number, input: InputManager, world: World): void {
    const { state } = this;

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
    const speed =
      (sprintHeld && !state.onGround && moveInput !== 0
        ? SPRINT_AIR_SPEED
        : sprintHeld
          ? SPRINT_SPEED
          : WALK_SPEED) * waterMult;
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

    if (hitY && state.velocity.y > 0) {
      state.velocity.y = 0;
    } else if (hitY && state.velocity.y < 0) {
      state.velocity.y = 0;
    }

    state.onGround = isOnGround(mover, this.solidScratch);
    const onGroundAfterCollision = state.onGround;
    const downBlocksThisTick =
      Math.max(0, state.prevPosition.y - state.position.y) / BLOCK_SIZE;
    if (!onGroundAfterCollision) {
      this.fallDistanceBlocks += downBlocksThisTick;
    } else if (!wasOnGround) {
      this.fallDistanceBlocks += downBlocksThisTick;
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
        this.takeDamage(fallDmg);
      }
      this.fallDistanceBlocks = 0;
    } else {
      this.fallDistanceBlocks = 0;
    }

    if (state.onGround || wasOnGround) {
      state.coyoteTimeRemaining = COYOTE_TIME_SEC;
    }

    const canUseGroundJump = state.onGround || state.coyoteTimeRemaining > 0;
    if (
      state.jumpBufferRemaining > 0 &&
      canUseGroundJump &&
      !inWaterAfterMove
    ) {
      state.velocity.y = JUMP_VELOCITY;
      state.onGround = false;
      state.jumpBufferRemaining = 0;
      state.coyoteTimeRemaining = 0;
    } else if (state.onGround && state.velocity.y >= 0 && !inWaterAfterMove) {
      state.velocity.y = 0;
    }

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

    if (input.isJustPressed("dropItem") && !input.isWorldInputBlocked()) {
      const dropSlot = state.hotbarSlot % HOTBAR_SIZE;
      const dropStack = this.inventory.getStack(dropSlot);
      if (dropStack !== null && this.inventory.consumeOneFromSlot(dropSlot)) {
        const { dirX, dirY } = getAimUnitVectorFromFeet(
          state.position.x,
          state.position.y,
          input.mouseWorldPos.x,
          input.mouseWorldPos.y,
          state.facingRight,
        );
        const spd = ITEM_THROW_SPEED_PX;
        const vx = dirX * spd;
        const vy = dirY * spd;
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
          dropStack.damage ?? 0,
        );
      }
    }

    if (input.isJustPressed("toggleBackgroundMode") && !input.isWorldInputBlocked()) {
      state.backgroundEditMode = !state.backgroundEditMode;
      state.breakTarget = null;
      state.breakAccum = 0;
      state.breakProgress = 0;
      state.handSwingRemainSec = 0;
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
          if (state.breakProgress >= 1) {
            const mat = def.material;
            const dropsLoot = canHarvestDrops(def, heldItemDef);
            this.audio.playSfx(getBreakSound(mat), { pitchVariance: 50 });
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
            } else {
              if (def.identifier === "stratum:furnace") {
                world.spawnFurnaceItemDropsAt(wx, wy);
              }
              if (def.identifier === "stratum:chest") {
                world.destroyChestForPlayerBreak(wx, wy, dropsLoot);
              } else {
                if (dropsLoot) world.spawnLootForBrokenBlock(def.id, wx, wy);
                world.setBlock(wx, wy, 0);
              }
            }
            this.inventory.applyToolUseFromMining(heldSlot);
            state.breakTarget = null;
            state.breakAccum = 0;
            state.breakProgress = 0;
          }
        } else {
          state.breakTarget = { wx, wy, layer };
          state.breakAccum = 0;
          state.breakProgress = 0;
        }
      } else {
        state.breakTarget = null;
        state.breakAccum = 0;
        state.breakProgress = 0;
      }
    } else {
      state.breakTarget = null;
      state.breakAccum = 0;
      state.breakProgress = 0;
    }

    const placeEdgeWithInventoryOpen =
      input.isWorldInputBlocked() &&
      !state.backgroundEditMode &&
      input.isJustPressedPlaceIgnoreWorldBlock();

    if (
      (input.isJustPressed("place") || placeEdgeWithInventoryOpen) &&
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
              const m = world.getMetadata(wx, bottomWy);
              const newM = toggleDoorLatchInMeta(m);
              world.setBlock(wx, bottomWy, b.id, { cellMetadata: newM });
              world.setBlock(wx, bottomWy + 1, t.id, { cellMetadata: newM });
              this.startHandSwingVisual();
              this.audio.playSfx(getPlaceSound("wood"), { pitchVariance: 25 });
            }
          }
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
            if (wb !== undefined && world.setBlock(wx, wy, this.airId)) {
              this.inventory.setStack(hotbarSlot, { itemId: wb.id, count: 1 });
              placeHandled = true;
              this.startHandSwingVisual();
              this.audio.playSfx(getPlaceSound("generic"), {
                pitchVariance: 20,
              });
            }
          }
        }

        if (
          !placeHandled &&
          held?.key === "stratum:wheat_seeds" &&
          (cell.id === farmlandDryId || cell.id === farmlandMoistId)
        ) {
          const above = world.getBlock(wx, wy + 1);
          const clearAbove =
            above.id === this.airId ||
            (above.replaceable && above.id !== this.airId);
          if (clearAbove) {
            if (above.id !== this.airId) {
              world.spawnLootForBrokenBlock(above.id, wx, wy + 1);
              world.setBlock(wx, wy + 1, this.airId);
            }
            const wheat0 = this.registry.getByIdentifier(
              "stratum:wheat_stage_0",
            ).id;
            if (world.setBlock(wx, wy + 1, wheat0)) {
              if (this.inventory.consumeOneFromSlot(hotbarSlot)) {
                placeHandled = true;
                this.startHandSwingVisual();
                this.audio.playSfx(getPlaceSound("grass"), {
                  pitchVariance: 25,
                });
              } else {
                world.setBlock(wx, wy + 1, this.airId);
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
                if (above.id !== this.airId) {
                  world.spawnLootForBrokenBlock(above.id, wx, wy + 1);
                  world.setBlock(wx, wy + 1, this.airId);
                }
                if (world.setBlock(wx, wy, farmlandDryId)) {
                  this.inventory.applyToolUseFromMining(hotbarSlot);
                  this.startHandSwingVisual();
                  this.audio.playSfx(getPlaceSound("dirt"), {
                    pitchVariance: 30,
                  });
                  placeHandled = true;
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
              if (placedDef.tallGrass === "bottom") {
                // two-tall plants not supported on back layer
              } else if (world.setBackgroundBlock(wx, wy, placesBlockId)) {
                if (!this.inventory.consumeOneFromSlot(hotbarSlot)) {
                  world.setBackgroundBlock(wx, wy, 0);
                } else {
                  this.startHandSwingVisual();
                  this.audio.playSfx(getPlaceSound(placedDef.material), {
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

            if (plantFlowerLike && !isGrassOrDirtSurface(below)) {
              // invalid: flowers and tall grass need grass or dirt below
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
                if (
                  !overlapsAnyPlayer &&
                  world.canPlaceForegroundWithCactusRules(wx, wy, placesBlockId)
                ) {
                  const topId = this.registry.getByIdentifier("stratum:tall_grass_top").id;
                  if (!world.canPlaceForegroundWithCactusRules(wx, wy + 1, topId)) {
                    // tall grass top would touch cactus horizontally
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
                    this.audio.playSfx(getPlaceSound(placed.material), {
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
                  if (
                    !overlapsAnyPlayer &&
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
                        this.audio.playSfx(getPlaceSound(placedDef.material), {
                          pitchVariance: 30,
                        });
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
                if (
                  !overlapsAnyPlayer &&
                  world.canPlaceForegroundWithCactusRules(wx, wy, placesBlockId)
                ) {
                  const placedDefForSfx = this.registry.getById(placesBlockId);
                  const waterBlockId = world.getWaterBlockId();
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
                    this.audio.playSfx(
                      getPlaceSound(placedDefForSfx.material),
                      {
                        pitchVariance: 30,
                      },
                    );
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
              const m = world.getMetadata(wx, bottomWy);
              const newM = toggleDoorLatchInMeta(m);
              world.setBlock(wx, bottomWy, b.id, { cellMetadata: newM });
              world.setBlock(wx, bottomWy + 1, t.id, { cellMetadata: newM });
              this.startHandSwingVisual();
              this.audio.playSfx(getPlaceSound("wood"), { pitchVariance: 25 });
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
      } else if (cell.identifier === "stratum:furnace") {
        this.bus.emit({
          type: "furnace:open-request",
          wx,
          wy,
        } satisfies GameEvent);
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
        const eatHp = heldEdible?.eatRestoreHealth;
        if (
          eatHp !== undefined &&
          eatHp > 0 &&
          state.health < PLAYER_MAX_HEALTH &&
          this.inventory.consumeOneFromSlot(hotbarSlot)
        ) {
          this.heal(eatHp);
          this.startHandSwingVisual();
          this.audio.playSfx(getPlaceSound("generic"), {
            pitchVariance: 18,
          });
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
      const eatHpFar = heldFar?.eatRestoreHealth;
      if (
        eatHpFar !== undefined &&
        eatHpFar > 0 &&
        state.health < PLAYER_MAX_HEALTH &&
        this.inventory.consumeOneFromSlot(hotbarSlot)
      ) {
        this.heal(eatHpFar);
        this.startHandSwingVisual();
        this.audio.playSfx(getPlaceSound("generic"), {
          pitchVariance: 18,
        });
      }
    }

    if (state.hotbarSlot !== this.prevHotbarSlot) {
      this.prevHotbarSlot = state.hotbarSlot;
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
        const bx = Math.floor(state.position.x / BLOCK_SIZE);
        const by = Math.floor(state.position.y / BLOCK_SIZE) - 1;
        const blockBelow = world.getBlock(bx, by);
        this.audio.playSfx(getStepSound(blockBelow.material), {
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
    this.bus.emit({
      type: "player:moved",
      wx: blockX,
      wy: blockY,
      blockX,
      blockY,
    } satisfies GameEvent);
  }
}
