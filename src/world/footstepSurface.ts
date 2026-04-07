import { BLOCK_SIZE } from "../core/constants";
import type { BlockDefinition } from "./blocks/BlockDefinition";
import type { World } from "./World";

/**
 * Block whose material should drive footstep / jump SFX when standing on a surface.
 * When the feet sit inside a stair cell (partial collision), the cell below is wrong or air;
 * otherwise the support is the block under the feet cell.
 */
export function getFeetSupportBlock(
  world: World,
  feetWorldX: number,
  feetWorldY: number,
): BlockDefinition {
  const bx = Math.floor(feetWorldX / BLOCK_SIZE);
  const fy = Math.floor(feetWorldY / BLOCK_SIZE);
  const atFeet = world.getBlock(bx, fy);
  if (atFeet.isStair === true) {
    return atFeet;
  }
  return world.getBlock(bx, fy - 1);
}
