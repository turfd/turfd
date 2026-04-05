import { BLOCK_SIZE } from "../core/constants";
import type { World } from "./World";

function chebyshev(ax: number, ay: number, bx: number, by: number): number {
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by));
}

/** True if any foreground tile with `blockId` is within `radiusBlocks` (Chebyshev) of feet. */
export function isNearBlockOfId(
  world: World,
  blockId: number,
  playerFeetPx: { x: number; y: number },
  radiusBlocks: number,
): boolean {
  const pcx = Math.floor(playerFeetPx.x / BLOCK_SIZE);
  const pcy = Math.floor(playerFeetPx.y / BLOCK_SIZE);
  for (let dy = -radiusBlocks; dy <= radiusBlocks; dy++) {
    for (let dx = -radiusBlocks; dx <= radiusBlocks; dx++) {
      if (chebyshev(pcx, pcy, pcx + dx, pcy + dy) > radiusBlocks) {
        continue;
      }
      if (world.getBlock(pcx + dx, pcy + dy).id === blockId) {
        return true;
      }
    }
  }
  return false;
}

/** True if any `craftingTableBlockId` foreground tile is within `radiusBlocks` (Chebyshev) of feet. */
export function isNearCraftingTableBlock(
  world: World,
  craftingTableBlockId: number,
  playerFeetPx: { x: number; y: number },
  radiusBlocks: number,
): boolean {
  return isNearBlockOfId(world, craftingTableBlockId, playerFeetPx, radiusBlocks);
}
