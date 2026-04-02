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
  PLAYER_WIDTH,
  REACH_BLOCKS,
  STEP_INTERVAL,
  WORLD_Y_MAX,
  WORLD_Y_MIN,
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
import type { World } from "../world/World";
import { getSolidAABBs } from "./physics/Collision";
import { createAABB, overlaps, sweepAABB, type AABB } from "./physics/AABB";

const WALK_SPEED = 120;
const SPRINT_SPEED = 190;
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
    backgroundEditMode: false,
    breakTarget: null,
    breakProgress: 0,
    breakAccum: 0,
    stepAccum: 0,
    coyoteTimeRemaining: 0,
    jumpBufferRemaining: 0,
  };

  public readonly inventory: PlayerInventory;

  private readonly solidScratch: AABB[] = [];
  private readonly bus: EventBus;
  private readonly audio: AudioEngine;
  private readonly registry: BlockRegistry;
  private readonly itemRegistry: ItemRegistry;
  private readonly airId: number;
  private prevHotbarSlot = 0;

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
  }

  /** Restore position, hotbar, and inventory from persistence. */
  applySavedState(
    feetWorldX: number,
    feetWorldY: number,
    hotbarSlot: number,
    inventory?: ({ key: string; count: number } | null)[],
  ): void {
    this.spawnAt(feetWorldX, feetWorldY);
    const slot = ((hotbarSlot % HOTBAR_SIZE) + HOTBAR_SIZE) % HOTBAR_SIZE;
    this.state.hotbarSlot = slot;
    this.prevHotbarSlot = slot;
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
    const speed = input.isDown("sprint") ? SPRINT_SPEED : WALK_SPEED;
    const targetVx = moveInput * speed;
    const accel = state.onGround ? GROUND_ACCEL : AIR_ACCEL;
    const decel = state.onGround ? GROUND_DECEL : AIR_DECEL;
    const maxDelta = (moveInput !== 0 ? accel : decel) * dt;
    state.velocity.x = approach(state.velocity.x, targetVx, maxDelta);

    if (input.isJustPressed("jump")) {
      state.jumpBufferRemaining = JUMP_BUFFER_SEC;
    }

    state.velocity.y += GRAVITY * dt;
    if (state.velocity.y > TERMINAL_VELOCITY) {
      state.velocity.y = TERMINAL_VELOCITY;
    }

    let mover = feetToScreenAABB(state.position);
    const dx = state.velocity.x * dt;
    const dy = state.velocity.y * dt;

    const pad = 4;
    const query = createAABB(
      Math.min(mover.x, mover.x + dx) - pad,
      Math.min(mover.y, mover.y + dy) - pad,
      Math.abs(dx) + mover.width + pad * 2,
      Math.abs(dy) + mover.height + pad * 2,
    );
    getSolidAABBs(world, query, this.solidScratch);

    const { hitY } = sweepAABB(mover, dx, dy, this.solidScratch);

    const feet = screenAABBTofeet(mover);
    state.position.x = feet.x;
    state.position.y = feet.y;

    if (hitY && state.velocity.y > 0) {
      state.velocity.y = 0;
    } else if (hitY && state.velocity.y < 0) {
      state.velocity.y = 0;
    }

    state.onGround = isOnGround(mover, this.solidScratch);
    if (state.onGround || wasOnGround) {
      state.coyoteTimeRemaining = COYOTE_TIME_SEC;
    }

    const canUseGroundJump = state.onGround || state.coyoteTimeRemaining > 0;
    if (state.jumpBufferRemaining > 0 && canUseGroundJump) {
      state.velocity.y = JUMP_VELOCITY;
      state.onGround = false;
      state.jumpBufferRemaining = 0;
      state.coyoteTimeRemaining = 0;
    } else if (state.onGround && state.velocity.y >= 0) {
      state.velocity.y = 0;
    }

    if (moveInput > 0) {
      state.facingRight = true;
    } else if (moveInput < 0) {
      state.facingRight = false;
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
        world.spawnItem(dropStack.itemId, 1, sx, sy, vx, vy);
      }
    }

    if (input.isJustPressed("toggleBackgroundMode") && !input.isWorldInputBlocked()) {
      state.backgroundEditMode = !state.backgroundEditMode;
      state.breakTarget = null;
      state.breakAccum = 0;
      state.breakProgress = 0;
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
              this.bus.emit({
                type: "game:block-changed",
                wx,
                wy,
                blockId: 0,
                layer: "bg",
              } satisfies GameEvent);
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
                this.bus.emit({
                  type: "game:block-changed",
                  wx,
                  wy: topWy,
                  blockId: 0,
                  layer: "fg",
                } satisfies GameEvent);
                this.bus.emit({
                  type: "game:block-changed",
                  wx,
                  wy: bottomWy,
                  blockId: 0,
                  layer: "fg",
                } satisfies GameEvent);
              } else {
                if (dropsLoot) world.spawnLootForBrokenBlock(def.id, wx, wy);
                world.setBlock(wx, wy, 0);
                this.bus.emit({
                  type: "game:block-changed",
                  wx,
                  wy,
                  blockId: 0,
                  layer: "fg",
                } satisfies GameEvent);
              }
            } else {
              if (dropsLoot) world.spawnLootForBrokenBlock(def.id, wx, wy);
              world.setBlock(wx, wy, 0);
              this.bus.emit({
                type: "game:block-changed",
                wx,
                wy,
                blockId: 0,
                layer: "fg",
              } satisfies GameEvent);
            }
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

    if (input.isJustPressed("place") && inReach) {
      const cell = world.getBlock(wx, wy);

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
                  this.audio.playSfx(getPlaceSound(placedDef.material), {
                    pitchVariance: 30,
                  });
                  this.bus.emit({
                    type: "game:block-changed",
                    wx,
                    wy,
                    blockId: placesBlockId,
                    layer: "bg",
                  } satisfies GameEvent);
                }
              }
            }
          }
        }
      } else {
      const canPlaceInCell =
        cell.id === this.airId || cell.replaceable;
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
                    const remoteAabb = feetToScreenAABB({ x: remote.x, y: remote.y });
                    if (
                      overlaps(remoteAabb, aabbLower) ||
                      overlaps(remoteAabb, aabbUpper)
                    ) {
                      overlapsAnyPlayer = true;
                      break;
                    }
                  }
                }
                if (!overlapsAnyPlayer) {
                  const topId = this.registry.getByIdentifier("stratum:tall_grass_top").id;
                  if (!world.setBlock(wx, wy, placesBlockId)) {
                    // vertical bounds
                  } else if (!world.setBlock(wx, wy + 1, topId)) {
                    world.setBlock(wx, wy, 0);
                  } else if (!this.inventory.consumeOneFromSlot(hotbarSlot)) {
                    world.setBlock(wx, wy, 0);
                    world.setBlock(wx, wy + 1, 0);
                  } else {
                    const placed = this.registry.getById(placesBlockId);
                    this.audio.playSfx(getPlaceSound(placed.material), {
                      pitchVariance: 30,
                    });
                    this.bus.emit({
                      type: "game:block-changed",
                      wx,
                      wy,
                      blockId: placesBlockId,
                      layer: "fg",
                    } satisfies GameEvent);
                    this.bus.emit({
                      type: "game:block-changed",
                      wx,
                      wy: wy + 1,
                      blockId: topId,
                      layer: "fg",
                    } satisfies GameEvent);
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
                    const remoteAabb = feetToScreenAABB({ x: remote.x, y: remote.y });
                    if (overlaps(remoteAabb, blockAabb)) {
                      overlapsAnyPlayer = true;
                      break;
                    }
                  }
                }
                if (!overlapsAnyPlayer) {
                  const placed = this.registry.getById(placesBlockId);
                  if (!world.setBlock(wx, wy, placesBlockId)) {
                    // vertical bounds
                  } else if (!this.inventory.consumeOneFromSlot(hotbarSlot)) {
                    world.setBlock(wx, wy, 0);
                  } else {
                    this.audio.playSfx(getPlaceSound(placed.material), {
                      pitchVariance: 30,
                    });
                    this.bus.emit({
                      type: "game:block-changed",
                      wx,
                      wy,
                      blockId: placesBlockId,
                      layer: "fg",
                    } satisfies GameEvent);
                  }
                }
              }
            }
          }
        }
      }
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
      }
    } else {
      state.stepAccum = 0;
    }

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
