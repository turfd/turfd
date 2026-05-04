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
import { packBedMetadata } from "../bed/bedMetadata";
import { packDoorMetadata } from "../door/doorMetadata";
import {
  isWaterSourceMetadata,
  withWaterFlowLevel,
} from "../water/waterMetadata";
import type { World } from "../World";
import {
  isGrassDirtOrFarmlandSurface,
  isSaplingIdentifier,
  isWheatCropIdentifier,
} from "../plant/soil";
import type { RemotePlayer } from "../entities/RemotePlayer";
import { createAABB, overlaps, type AABB } from "../../entities/physics/AABB";
import {
  PAINTING_VARIANTS,
  encodePaintingMeta,
} from "../painting/paintingData";

/** `TERRAIN_PLACE` wire subtype (byte 1). */
export const SUB_SIMPLE_FG = 0;
export const SUB_TALL_GRASS = 1;
export const SUB_DOOR_PAIR = 2;
export const SUB_WHEAT = 3;
export const SUB_HOE = 4;
export const SUB_BUCKET_FILL = 5;
export const SUB_BG = 6;
export const SUB_BED_PAIR = 7;
export const SUB_PAINTING = 8;

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

function tryPlaceBedPair(
  world: World,
  registry: BlockRegistry,
  airId: number,
  peerFeet: { x: number; y: number },
  remotePlayers: ReadonlyMap<string, RemotePlayer>,
  wx: number,
  wy: number,
  headPlusX: boolean,
): boolean {
  const footId = registry.getByIdentifier("stratum:bed").id;
  const headId = registry.getByIdentifier("stratum:bed_head").id;
  const headWx = headPlusX ? wx + 1 : wx - 1;

  const footCell = world.getBlock(wx, wy);
  const headCell = world.getBlock(headWx, wy);
  const canFoot =
    footCell.id === airId || footCell.replaceable || footCell.water;
  const canHead =
    headCell.id === airId || headCell.replaceable || headCell.water;
  if (!canFoot || !canHead) {
    return false;
  }

  const belowFoot = world.getBlock(wx, wy - 1);
  const belowHead = world.getBlock(headWx, wy - 1);
  const surfaceOk = (b: typeof belowFoot): boolean =>
    b.solid && !b.replaceable && !b.water;
  if (!surfaceOk(belowFoot) || !surfaceOk(belowHead)) {
    return false;
  }
  if (
    !world.hasForegroundPlacementSupport(wx, wy) ||
    !world.hasForegroundPlacementSupport(headWx, wy)
  ) {
    return false;
  }

  const aabbFoot = createAABB(
    wx * BLOCK_SIZE,
    -(wy + 1) * BLOCK_SIZE,
    BLOCK_SIZE,
    BLOCK_SIZE,
  );
  const aabbHead = createAABB(
    headWx * BLOCK_SIZE,
    -(wy + 1) * BLOCK_SIZE,
    BLOCK_SIZE,
    BLOCK_SIZE,
  );
  const playerAabb = feetToScreenAABB(peerFeet);
  let overlapsAnyPlayer =
    overlaps(playerAabb, aabbFoot) || overlaps(playerAabb, aabbHead);
  if (!overlapsAnyPlayer) {
    for (const rp of remotePlayers.values()) {
      const feet = rp.getAuthorityFeet();
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
  if (
    overlapsAnyPlayer ||
    !world.canPlaceForegroundWithCactusRules(wx, wy, footId) ||
    !world.canPlaceForegroundWithCactusRules(headWx, wy, headId)
  ) {
    return false;
  }

  const bedMeta = packBedMetadata(0, headPlusX);
  if (
    !world.setBlock(wx, wy, footId, { cellMetadata: bedMeta })
  ) {
    return false;
  }
  if (!world.setBlock(headWx, wy, headId, { cellMetadata: bedMeta })) {
    world.setBlock(wx, wy, 0);
    return false;
  }
  return true;
}

function doorTopIdentifierFromBottom(bottomIdentifier: string): string {
  return `${bottomIdentifier}_top`;
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
  bottomBlockId: number,
): boolean {
  let placesBlockId = bottomBlockId;
  let bottomDef = registry.getById(placesBlockId);
  if (placesBlockId === 0) {
    // Older clients sent no block id for doors; default to oak.
    placesBlockId = registry.getByIdentifier("stratum:oak_door").id;
    bottomDef = registry.getById(placesBlockId);
  }
  if (bottomDef === undefined || bottomDef.doorHalf !== "bottom") {
    return false;
  }
  const topDef = registry.getByIdentifier(
    doorTopIdentifierFromBottom(bottomDef.identifier),
  );
  if (topDef === undefined || topDef.doorHalf !== "top") {
    return false;
  }
  const topId = topDef.id;
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
  if (
    isSaplingIdentifier(placedDef.identifier) &&
    !isGrassDirtOrFarmlandSurface(below)
  ) {
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

  if (placedDef.bedHalf === "foot") {
    const cellLeft = wx * BLOCK_SIZE;
    const cellRight = (wx + 1) * BLOCK_SIZE;
    const headPlusX =
      Math.abs(playerFeetX - cellRight) <= Math.abs(playerFeetX - cellLeft);
    if (
      tryPlaceBedPair(
        world,
        registry,
        airId,
        peerFeet,
        remotePlayers,
        wx,
        wy,
        headPlusX,
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
        placesBlockId,
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
  if (
    placedDef.identifier === "stratum:barrel" &&
    (
      world.getBlock(wx - 1, wy).identifier === "stratum:barrel" ||
      world.getBlock(wx + 1, wy).identifier === "stratum:barrel"
    )
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
        placesBlockId,
      )
    ) {
      return { ok: true, effects: ACK_CONSUME_ONE };
    }
    return fail();
  }

  if (subtype === SUB_BED_PAIR) {
    const headPlusX = aux !== 0;
    if (
      tryPlaceBedPair(
        world,
        registry,
        airId,
        peerFeet,
        remotePlayers,
        wx,
        wy,
        headPlusX,
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
    if (isWheatCropIdentifier(cell.identifier)) {
      return fail();
    }
    const below = world.getBlock(wx, wy - 1);
    if (below.id !== farmlandDryId && below.id !== farmlandMoistId) {
      return fail();
    }
    const canPlaceInCell =
      cell.id === airId || (cell.replaceable && cell.id !== airId);
    if (!canPlaceInCell) {
      return fail();
    }
    const wheat0 = registry.getByIdentifier("stratum:wheat_stage_0").id;
    if (!world.hasForegroundPlacementSupport(wx, wy)) {
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
      !world.canPlaceForegroundWithCactusRules(wx, wy, wheat0)
    ) {
      return fail();
    }
    if (cell.id !== airId) {
      world.spawnLootForBrokenBlock(cell.id, wx, wy);
      world.setBlock(wx, wy, airId);
    }
    if (!world.setBlock(wx, wy, wheat0)) {
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
    if (
      placedDef.tallGrass === "bottom" ||
      placedDef.bedHalf === "foot" ||
      placedDef.doorHalf !== "none"
    ) {
      return fail();
    }
    if (world.setBackgroundBlock(wx, wy, placesBlockId)) {
      return { ok: true, effects: ACK_CONSUME_ONE };
    }
    return fail();
  }

  if (subtype === SUB_PAINTING) {
    const variantIndex = aux;
    if (variantIndex < 0 || variantIndex >= PAINTING_VARIANTS.length) {
      return fail();
    }
    const pv = PAINTING_VARIANTS[variantIndex]!;
    const paintingBlockId = registry.getByIdentifier("stratum:painting").id;

    for (let oy = 0; oy < pv.height; oy++) {
      for (let ox = 0; ox < pv.width; ox++) {
        const cx = wx + ox;
        const cy = wy + oy;
        const fg = world.getBlock(cx, cy);
        if (fg.solid && !fg.replaceable && !fg.water) {
          return fail();
        }
        if (world.getBackgroundId(cx, cy) === 0) {
          return fail();
        }
      }
    }

    let placed = true;
    for (let oy = 0; oy < pv.height && placed; oy++) {
      for (let ox = 0; ox < pv.width && placed; ox++) {
        const meta = encodePaintingMeta(variantIndex, ox, oy);
        if (!world.setBlock(wx + ox, wy + oy, paintingBlockId, { cellMetadata: meta })) {
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
      return fail();
    }
    return { ok: true, effects: ACK_CONSUME_ONE };
  }

  return fail();
}
