/**
 * Collidable block AABBs in screen space ({@link BlockDefinitionBase.collides}).
 */
import { BLOCK_SIZE, WORLDGEN_NO_COLLIDE } from "../../core/constants";
import type { World } from "../../world/World";
import { createAABB, type AABB } from "./AABB";

export function getSolidAABBs(
  world: World,
  region: AABB,
  out: AABB[],
): void {
  out.length = 0;

  const worldYBottom = -(region.y + region.height);
  const worldYTop = -region.y;

  const wx0 = Math.floor(region.x / BLOCK_SIZE);
  const wx1 = Math.floor((region.x + region.width - 1) / BLOCK_SIZE);
  const wy0 = Math.floor(worldYBottom / BLOCK_SIZE);
  const wy1 = Math.floor(worldYTop / BLOCK_SIZE);

  for (let wx = wx0; wx <= wx1; wx++) {
    for (let wy = wy0; wy <= wy1; wy++) {
      const def = world.getBlock(wx, wy);
      if (!def.collides) {
        continue;
      }
      if (world.getMetadata(wx, wy) & WORLDGEN_NO_COLLIDE) {
        continue;
      }
      out.push(
        createAABB(
          wx * BLOCK_SIZE,
          -(wy + 1) * BLOCK_SIZE,
          BLOCK_SIZE,
          BLOCK_SIZE,
        ),
      );
    }
  }
}
