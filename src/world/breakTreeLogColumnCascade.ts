import { canHarvestDrops } from "../core/mining";
import {
  WORLD_Y_MAX,
  WORLD_Y_MIN,
  WORLDGEN_NO_COLLIDE,
} from "../core/constants";
import type { BlockRegistry } from "./blocks/BlockRegistry";
import { LEAF_SUPPORT_RADIUS } from "./BlockInteractions";
import type { World } from "./World";

const TREE_LOG_IDENTIFIERS = new Set([
  "stratum:oak_log",
  "stratum:spruce_log",
  "stratum:birch_log",
]);

const TREE_LEAF_IDENTIFIERS = new Set([
  "stratum:oak_leaves",
  "stratum:spruce_leaves",
  "stratum:birch_leaves",
]);

/** Outer scan padding (matches leaf-decay scan around a removed block). */
const TREE_LEAF_INSTANT_SCAN_PAD = LEAF_SUPPORT_RADIUS + 1;

export function isTreeLogBlock(registry: BlockRegistry, blockId: number): boolean {
  try {
    return TREE_LOG_IDENTIFIERS.has(registry.getById(blockId).identifier);
  } catch {
    return false;
  }
}

function isTreeLeafBlock(registry: BlockRegistry, blockId: number): boolean {
  try {
    return TREE_LEAF_IDENTIFIERS.has(registry.getById(blockId).identifier);
  } catch {
    return false;
  }
}

function leafHasNearbyTreeLog(
  world: World,
  registry: BlockRegistry,
  leafWx: number,
  leafWy: number,
): boolean {
  const r = LEAF_SUPPORT_RADIUS;
  for (let dx = -r; dx <= r; dx++) {
    for (let dy = -r; dy <= r; dy++) {
      if (Math.abs(dx) + Math.abs(dy) > r) {
        continue;
      }
      const id = world.getBlock(leafWx + dx, leafWy + dy).id;
      if (isTreeLogBlock(registry, id)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * After wild tree logs are removed in one column, break every leaf in range that no longer
 * has a tree log within Manhattan distance 4 (same rule as delayed leaf decay).
 */
function instantBreakUnsupportedLeavesNearWildTreeColumn(
  world: World,
  registry: BlockRegistry,
  columnWx: number,
  yMin: number,
  yMax: number,
  airId: number,
): void {
  const pad = TREE_LEAF_INSTANT_SCAN_PAD;
  const x0 = columnWx - pad;
  const x1 = columnWx + pad;
  const y0 = Math.max(WORLD_Y_MIN, Math.min(yMin, yMax) - pad);
  const y1 = Math.min(WORLD_Y_MAX, Math.max(yMin, yMax) + pad);
  for (let ix = x0; ix <= x1; ix++) {
    for (let iy = y0; iy <= y1; iy++) {
      const cell = world.getBlock(ix, iy);
      if (cell.id === airId) {
        continue;
      }
      if (!isTreeLeafBlock(registry, cell.id)) {
        continue;
      }
      if (leafHasNearbyTreeLog(world, registry, ix, iy)) {
        continue;
      }
      world.spawnLootForBrokenBlock(cell.id, ix, iy);
      world.setBlock(ix, iy, airId);
    }
  }
}

/**
 * After a **worldgen / sapling-grown** tree log at (wx, wy) is removed, break contiguous
 * **wild** logs in the same column above it (cells still carrying {@link WORLDGEN_NO_COLLIDE}).
 * Player-placed logs have cleared metadata and stop the chain so builds are unaffected.
 */
export function breakTreeLogsAboveColumn(
  world: World,
  registry: BlockRegistry,
  wx: number,
  brokenWy: number,
  airId: number,
  heldItemDef: Parameters<typeof canHarvestDrops>[1],
): void {
  let topBrokenY = brokenWy;
  let y = brokenWy + 1;
  while (y <= WORLD_Y_MAX) {
    const cell = world.getBlock(wx, y);
    if (!isTreeLogBlock(registry, cell.id)) {
      break;
    }
    if ((world.getMetadata(wx, y) & WORLDGEN_NO_COLLIDE) === 0) {
      break;
    }
    const dropsLoot = canHarvestDrops(cell, heldItemDef);
    if (dropsLoot) {
      world.spawnLootForBrokenBlock(cell.id, wx, y);
    }
    world.setBlock(wx, y, airId);
    topBrokenY = y;
    y += 1;
  }
  instantBreakUnsupportedLeavesNearWildTreeColumn(
    world,
    registry,
    wx,
    brokenWy,
    topBrokenY,
    airId,
  );
}
