/**
 * Host-side validation + world mutation for multiplayer client place requests.
 * Mirrors {@link Player} placement (inventory applied on client via TERRAIN_ACK).
 */
import {
  BLOCK_SIZE,
  PLAYER_HEIGHT,
  PLAYER_WIDTH,
} from "../../core/constants";
import type { ItemRegistry } from "../../items/ItemRegistry";
import type { BlockRegistry } from "../blocks/BlockRegistry";
import {
  computePlacedStairShape,
  withStairShape,
} from "../blocks/stairMetadata";
import { packDoorMetadata } from "../door/doorMetadata";
import {
  isWaterSourceMetadata,
  withWaterFlowLevel,
} from "../water/waterMetadata";
import type { World } from "../World";
import type { RemotePlayer } from "../entities/RemotePlayer";
import { createAABB, overlaps, type AABB } from "../../entities/physics/AABB";

/** `TERRAIN_PLACE` wire subtype (byte 1). */
export const SUB_SIMPLE_FG = 0;
export const SUB_TALL_GRASS = 1;
export const SUB_DOOR_PAIR = 2;
export const SUB_WHEAT = 3;
export const SUB_HOE = 4;
export const SUB_BUCKET_FILL = 5;
export const SUB_BG = 6;

/** Bitmask for `TERRAIN_ACK.effects` on the wire. */
export const ACK_TOOL_USE = 1;
export const ACK_CONSUME_ONE = 2;
export const ACK_WATER_BUCKET_SPENT = 4;
export const ACK_BUCKET_FILL_RESULT = 8;

function feetToScreenAABB(pos: { x: number; y: number }): AABB {
  const x = pos.x - PLAYER_WIDTH * 0.5;
  const y = -(pos.y + PLAYER_HEIGHT);
  return createAABB(x, y, PLAYER_WIDTH, PLAYER_HEIGHT);
}

function isGrassOrDirtSurface(below: { identifier: string }): boolean {
  return (
    below.identifier === "stratum:grass" ||
    below.identifier === "stratum:dirt"
  );
}

function isFlowerOrShortGrass(identifier: string): boolean {
  return (
    identifier === "stratum:dandelion" ||
    identifier === "stratum:poppy" ||
    identifier === "stratum:short_grass"
  );
}

function tryPlaceTallGrass(
  world: World,
  registry: BlockRegistry,
  airId: number,
  peerFeet: { x: number; y: number },
  remotePlayers: ReadonlyMap<string, RemotePlayer>,
  wx: number,
  wy: number,
): boolean {
  const placesBlockId = registry.getByIdentifier("stratum:tall_grass_bottom").id;
  const cell = world.getBlock(wx, wy);
  const canPlaceInCell =
    cell.id === airId || cell.replaceable || cell.water;
  if (!canPlaceInCell) {
    return false;
  }
  const below = world.getBlock(wx, wy - 1);
  if (!isGrassOrDirtSurface(below)) {
    return false;
  }
  const topCell = world.getBlock(wx, wy + 1);
  if (topCell.solid && !topCell.replaceable) {
    return false;
  }
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
  const playerAabb = feetToScreenAABB(peerFeet);
  let overlapsAnyPlayer =
    overlaps(playerAabb, aabbLower) || overlaps(playerAabb, aabbUpper);
  if (!overlapsAnyPlayer) {
    for (const rp of remotePlayers.values()) {
      const feet = rp.getAuthorityFeet();
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
    overlapsAnyPlayer ||
    !world.canPlaceForegroundWithCactusRules(wx, wy, placesBlockId)
  ) {
    return false;
  }
  const topId = registry.getByIdentifier("stratum:tall_grass_top").id;
  if (!world.canPlaceForegroundWithCactusRules(wx, wy + 1, topId)) {
    return false;
  }
  if (!world.setBlock(wx, wy, placesBlockId)) {
    return false;
  }
  if (!world.setBlock(wx, wy + 1, topId)) {
    world.setBlock(wx, wy, 0);
    return false;
  }
  return true;
}

function tryPlaceDoorPair(
  world: World,
  registry: BlockRegistry,
  airId: number,
  peerFeet: { x: number; y: number },
  remotePlayers: ReadonlyMap<string, RemotePlayer>,
  wx: number,
  wy: number,
  hingeRight: boolean,
): boolean {
  const placesBlockId = registry.getByIdentifier("stratum:oak_door_bottom").id;
  const cell = world.getBlock(wx, wy);
  const canPlaceInCell =
    cell.id === airId || cell.replaceable || cell.water;
  if (!canPlaceInCell) {
    return false;
  }
  const surfaceBelow = world.getBlock(wx, wy - 1);
  const surfaceOk =
    surfaceBelow.solid &&
    !surfaceBelow.replaceable &&
    !surfaceBelow.water;
  if (!surfaceOk || !world.hasForegroundPlacementSupport(wx, wy)) {
    return false;
  }
  const topCell = world.getBlock(wx, wy + 1);
  if (topCell.solid && !topCell.replaceable) {
    return false;
  }
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
  const playerAabb = feetToScreenAABB(peerFeet);
  let overlapsAnyPlayer =
    overlaps(playerAabb, aabbLower) || overlaps(playerAabb, aabbUpper);
  if (!overlapsAnyPlayer) {
    for (const rp of remotePlayers.values()) {
      const feet = rp.getAuthorityFeet();
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
    overlapsAnyPlayer ||
    !world.canPlaceForegroundWithCactusRules(wx, wy, placesBlockId)
  ) {
    return false;
  }
  const topId = registry.getByIdentifier("stratum:oak_door_top").id;
  if (!world.canPlaceForegroundWithCactusRules(wx, wy + 1, topId)) {
    return false;
  }
  const doorMeta = packDoorMetadata(0, hingeRight, false);
  if (!world.setBlock(wx, wy, placesBlockId, { cellMetadata: doorMeta })) {
    return false;
  }
  if (!world.setBlock(wx, wy + 1, topId, { cellMetadata: doorMeta })) {
    world.setBlock(wx, wy, 0);
    return false;
  }
  return true;
}

function tryPlaceSimpleForeground(
  world: World,
  registry: BlockRegistry,
  airId: number,
  waterBlockId: number,
  _itemRegistry: ItemRegistry,
  peerFeet: { x: number; y: number },
  remotePlayers: ReadonlyMap<string, RemotePlayer>,
  wx: number,
  wy: number,
  placesBlockId: number,
  playerFeetX: number,
): { ok: boolean; effects: number } {
  const fail = (): { ok: boolean; effects: number } => ({ ok: false, effects: 0 });
  const cell = world.getBlock(wx, wy);
  const canPlaceInCell =
    cell.id === airId || cell.replaceable || cell.water;
  if (!canPlaceInCell) {
    return fail();
  }
  if (placesBlockId === 0) {
    return fail();
  }
  const placedDef = registry.getById(placesBlockId);
  const below = world.getBlock(wx, wy - 1);
  const plantTallBottom = placedDef.tallGrass === "bottom";
  const plantFlowerLike =
    plantTallBottom || isFlowerOrShortGrass(placedDef.identifier);

  if (plantFlowerLike && !isGrassOrDirtSurface(below)) {
    return fail();
  }

  if (plantTallBottom) {
    if (
      tryPlaceTallGrass(
        world,
        registry,
        airId,
        peerFeet,
        remotePlayers,
        wx,
        wy,
      )
    ) {
      return { ok: true, effects: ACK_CONSUME_ONE };
    }
    return fail();
  }

  if (placedDef.doorHalf === "bottom") {
    const cellLeft = wx * BLOCK_SIZE;
    const cellRight = (wx + 1) * BLOCK_SIZE;
    const hingeRight =
      Math.abs(playerFeetX - cellRight) <= Math.abs(playerFeetX - cellLeft);
    if (
      tryPlaceDoorPair(
        world,
        registry,
        airId,
        peerFeet,
        remotePlayers,
        wx,
        wy,
        hingeRight,
      )
    ) {
      return { ok: true, effects: ACK_CONSUME_ONE };
    }
    return fail();
  }

  const hasSupport = world.hasForegroundPlacementSupport(wx, wy);
  if (!hasSupport) {
    return fail();
  }
  const blockAabb = createAABB(
    wx * BLOCK_SIZE,
    -(wy + 1) * BLOCK_SIZE,
    BLOCK_SIZE,
    BLOCK_SIZE,
  );
  const playerAabb = feetToScreenAABB(peerFeet);
  let overlapsAnyPlayer = overlaps(playerAabb, blockAabb);
  if (!overlapsAnyPlayer) {
    for (const rp of remotePlayers.values()) {
      const feet = rp.getAuthorityFeet();
      const remoteAabb = feetToScreenAABB({ x: feet.x, y: feet.y });
      if (overlaps(remoteAabb, blockAabb)) {
        overlapsAnyPlayer = true;
        break;
      }
    }
  }
  if (
    overlapsAnyPlayer ||
    !world.canPlaceForegroundWithCactusRules(wx, wy, placesBlockId)
  ) {
    return fail();
  }
  const placedDefForSfx = registry.getById(placesBlockId);
  const stairMeta =
    placedDefForSfx.isStair === true
      ? withStairShape(
          0,
          computePlacedStairShape(wx, playerFeetX),
        )
      : undefined;
  const placedCellOk =
    placesBlockId === waterBlockId
      ? world.setBlock(wx, wy, waterBlockId, {
          cellMetadata: withWaterFlowLevel(0, 0),
        })
      : stairMeta !== undefined
        ? world.setBlock(wx, wy, placesBlockId, {
            cellMetadata: stairMeta,
          })
        : world.setBlock(wx, wy, placesBlockId);
  if (!placedCellOk) {
    return fail();
  }
  let effects = ACK_CONSUME_ONE;
  if (placesBlockId === waterBlockId) {
    effects |= ACK_WATER_BUCKET_SPENT;
  }
  return { ok: true, effects };
}

export function tryHostTerrainPlace(
  world: World,
  registry: BlockRegistry,
  itemRegistry: ItemRegistry,
  airId: number,
  waterBlockId: number,
  peerFeet: { x: number; y: number },
  remotePlayers: ReadonlyMap<string, RemotePlayer>,
  subtype: number,
  wx: number,
  wy: number,
  hotbarSlot: number,
  placesBlockId: number,
  aux: number,
): { ok: boolean; effects: number } {
  void hotbarSlot;
  const fail = (): { ok: boolean; effects: number } => ({ ok: false, effects: 0 });
  const playerFeetX = peerFeet.x;

  if (subtype === SUB_SIMPLE_FG) {
    return tryPlaceSimpleForeground(
      world,
      registry,
      airId,
      waterBlockId,
      itemRegistry,
      peerFeet,
      remotePlayers,
      wx,
      wy,
      placesBlockId,
      playerFeetX,
    );
  }

  if (subtype === SUB_TALL_GRASS) {
    if (
      tryPlaceTallGrass(
        world,
        registry,
        airId,
        peerFeet,
        remotePlayers,
        wx,
        wy,
      )
    ) {
      return { ok: true, effects: ACK_CONSUME_ONE };
    }
    return fail();
  }

  if (subtype === SUB_DOOR_PAIR) {
    const hingeRight = aux !== 0;
    if (
      tryPlaceDoorPair(
        world,
        registry,
        airId,
        peerFeet,
        remotePlayers,
        wx,
        wy,
        hingeRight,
      )
    ) {
      return { ok: true, effects: ACK_CONSUME_ONE };
    }
    return fail();
  }

  if (subtype === SUB_WHEAT) {
    const farmlandDryId = registry.getByIdentifier("stratum:farmland_dry").id;
    const farmlandMoistId = registry.getByIdentifier("stratum:farmland_moist").id;
    const cell = world.getBlock(wx, wy);
    if (cell.id !== farmlandDryId && cell.id !== farmlandMoistId) {
      return fail();
    }
    const above = world.getBlock(wx, wy + 1);
    const clearAbove =
      above.id === airId || (above.replaceable && above.id !== airId);
    if (!clearAbove) {
      return fail();
    }
    if (above.id !== airId) {
      world.spawnLootForBrokenBlock(above.id, wx, wy + 1);
      world.setBlock(wx, wy + 1, airId);
    }
    const wheat0 = registry.getByIdentifier("stratum:wheat_stage_0").id;
    if (!world.setBlock(wx, wy + 1, wheat0)) {
      return fail();
    }
    return { ok: true, effects: ACK_CONSUME_ONE };
  }

  if (subtype === SUB_HOE) {
    const farmlandDryId = registry.getByIdentifier("stratum:farmland_dry").id;
    const cell = world.getBlock(wx, wy);
    if (
      cell.identifier !== "stratum:dirt" &&
      cell.identifier !== "stratum:grass"
    ) {
      return fail();
    }
    const above = world.getBlock(wx, wy + 1);
    const clearAbove =
      above.id === airId || (above.replaceable && above.id !== airId);
    if (!clearAbove) {
      return fail();
    }
    if (above.id !== airId) {
      world.spawnLootForBrokenBlock(above.id, wx, wy + 1);
      world.setBlock(wx, wy + 1, airId);
    }
    if (!world.setBlock(wx, wy, farmlandDryId)) {
      return fail();
    }
    return { ok: true, effects: ACK_TOOL_USE };
  }

  if (subtype === SUB_BUCKET_FILL) {
    const cell = world.getBlock(wx, wy);
    if (!cell.water || !isWaterSourceMetadata(world.getMetadata(wx, wy))) {
      return fail();
    }
    if (!world.setBlock(wx, wy, airId)) {
      return fail();
    }
    return { ok: true, effects: ACK_BUCKET_FILL_RESULT };
  }

  if (subtype === SUB_BG) {
    const bgEmpty = world.getBackgroundId(wx, wy) === 0;
    if (!bgEmpty) {
      return fail();
    }
    if (placesBlockId === 0) {
      return fail();
    }
    const placedDef = registry.getById(placesBlockId);
    if (placedDef.tallGrass === "bottom") {
      return fail();
    }
    if (world.setBackgroundBlock(wx, wy, placesBlockId)) {
      return { ok: true, effects: ACK_CONSUME_ONE };
    }
    return fail();
  }

  return fail();
}
