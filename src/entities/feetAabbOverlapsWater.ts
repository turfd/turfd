import { BLOCK_SIZE } from "../core/constants";
import type { World } from "../world/World";
import { createAABB } from "./physics/AABB";

/**
 * True when a feet-anchored world AABB overlaps any water foreground cell.
 * Matches player/mob physics water detection (screen-space AABB, then cell scan).
 */
export function feetAabbOverlapsWater(
  world: World,
  feetX: number,
  feetY: number,
  widthPx: number,
  heightPx: number,
): boolean {
  if (!world.getRegistry().isRegistered("stratum:water")) {
    return false;
  }
  const waterId = world.getWaterBlockId();
  const region = createAABB(
    feetX - widthPx * 0.5,
    -(feetY + heightPx),
    widthPx,
    heightPx,
  );
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
