/**
 * Host-authoritative block break (mirrors {@link Player} mining completion).
 * Used when a multiplayer client commits a break; the host validates cell + reach first.
 */
import type { ItemRegistry } from "../../items/ItemRegistry";
import type { BlockRegistry } from "../blocks/BlockRegistry";
import { canHarvestDrops } from "../../core/mining";
import type { World } from "../World";
import { WORLD_Y_MAX, WORLD_Y_MIN } from "../../core/constants";
import { bedHeadPlusXFromMeta } from "../bed/bedMetadata";

export type BreakTargetLayer = "fg" | "bg";

/**
 * Apply a completed break at (wx, wy). Returns whether any block was changed.
 */
export function applyCommittedBreakOnWorld(
  world: World,
  registry: BlockRegistry,
  _itemRegistry: ItemRegistry,
  wx: number,
  wy: number,
  layer: BreakTargetLayer,
  airId: number,
  heldItemDef: ReturnType<ItemRegistry["getById"]> | undefined,
): boolean {
  if (layer === "bg") {
    const bid = world.getBackgroundId(wx, wy);
    if (bid === 0) {
      return false;
    }
    const def = registry.getById(bid);
    if (def.hardness === 999) {
      return false;
    }
    const dropsLoot = canHarvestDrops(def, heldItemDef);
    if (dropsLoot) {
      world.spawnLootForBrokenBlock(def.id, wx, wy);
    }
    world.setBackgroundBlock(wx, wy, 0);
    return true;
  }

  const cell = world.getBlock(wx, wy);
  const def = cell;
  if (def.id === airId || def.hardness === 999) {
    return false;
  }

  const dropsLoot = canHarvestDrops(def, heldItemDef);

  if (def.tallGrass === "bottom" || def.tallGrass === "top") {
    const bottomWy = def.tallGrass === "bottom" ? wy : wy - 1;
    const topWy = bottomWy + 1;
    const bottomOk = bottomWy >= WORLD_Y_MIN && bottomWy <= WORLD_Y_MAX;
    const topOk = topWy >= WORLD_Y_MIN && topWy <= WORLD_Y_MAX;
    const bottomCell = bottomOk ? world.getBlock(wx, bottomWy) : null;
    const topCell = topOk ? world.getBlock(wx, topWy) : null;
    const fullPlant =
      bottomCell !== null &&
      bottomCell.tallGrass === "bottom" &&
      topCell !== null &&
      topCell.tallGrass === "top";

    if (fullPlant && bottomCell !== null) {
      if (dropsLoot) {
        world.spawnLootForBrokenBlock(bottomCell.id, wx, bottomWy);
      }
      world.setBlock(wx, topWy, 0);
      world.setBlock(wx, bottomWy, 0);
    } else {
      if (dropsLoot) {
        world.spawnLootForBrokenBlock(def.id, wx, wy);
      }
      world.setBlock(wx, wy, 0);
    }
    return true;
  }

  if (def.doorHalf === "bottom" || def.doorHalf === "top") {
    const bottomWy = def.doorHalf === "bottom" ? wy : wy - 1;
    const topWy = bottomWy + 1;
    const bottomOk = bottomWy >= WORLD_Y_MIN && bottomWy <= WORLD_Y_MAX;
    const topOk = topWy >= WORLD_Y_MIN && topWy <= WORLD_Y_MAX;
    const bottomCell = bottomOk ? world.getBlock(wx, bottomWy) : null;
    const topCell = topOk ? world.getBlock(wx, topWy) : null;
    const fullDoor =
      bottomCell !== null &&
      bottomCell.doorHalf === "bottom" &&
      topCell !== null &&
      topCell.doorHalf === "top";

    if (fullDoor && bottomCell !== null) {
      if (dropsLoot) {
        world.spawnLootForBrokenBlock(bottomCell.id, wx, bottomWy);
      }
      world.setBlock(wx, topWy, 0);
      world.setBlock(wx, bottomWy, 0);
    } else {
      if (dropsLoot) {
        world.spawnLootForBrokenBlock(def.id, wx, wy);
      }
      world.setBlock(wx, wy, 0);
    }
    return true;
  }

  if (def.bedHalf === "foot" || def.bedHalf === "head") {
    const meta = world.getMetadata(wx, wy);
    const headPlusX = bedHeadPlusXFromMeta(meta);
    const footWx = def.bedHalf === "foot" ? wx : headPlusX ? wx - 1 : wx + 1;
    const headWx = def.bedHalf === "head" ? wx : headPlusX ? wx + 1 : wx - 1;
    const footCell = world.getBlock(footWx, wy);
    const headCell = world.getBlock(headWx, wy);
    const fullBed =
      footCell.bedHalf === "foot" && headCell.bedHalf === "head";

    if (fullBed) {
      if (dropsLoot) {
        world.spawnLootForBrokenBlock(footCell.id, footWx, wy);
      }
      world.setBlock(headWx, wy, 0);
      world.setBlock(footWx, wy, 0);
    } else {
      if (dropsLoot) {
        world.spawnLootForBrokenBlock(def.id, wx, wy);
      }
      world.setBlock(wx, wy, 0);
    }
    return true;
  }

  if (def.identifier === "stratum:furnace") {
    world.spawnFurnaceItemDropsAt(wx, wy);
  }
  if (def.identifier === "stratum:chest") {
    world.destroyChestForPlayerBreak(wx, wy, dropsLoot);
  } else {
    if (dropsLoot) {
      world.spawnLootForBrokenBlock(def.id, wx, wy);
    }
    world.setBlock(wx, wy, 0);
  }
  return true;
}
