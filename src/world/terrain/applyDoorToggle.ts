import { toggleDoorLatchInMeta } from "../door/doorMetadata";
import type { World } from "../World";
import { WORLD_Y_MAX } from "../../core/constants";

/**
 * Toggle door latch at clicked cell (wx, wy). Returns true if a pair was toggled.
 */
export function applyCommittedDoorToggle(
  world: World,
  wx: number,
  wy: number,
): boolean {
  const cell = world.getBlock(wx, wy);
  if (cell.doorHalf !== "bottom" && cell.doorHalf !== "top") {
    return false;
  }
  const bottomWy = cell.doorHalf === "bottom" ? wy : wy - 1;
  const b = world.getBlock(wx, bottomWy);
  if (b.doorHalf !== "bottom" || bottomWy + 1 > WORLD_Y_MAX) {
    return false;
  }
  const t = world.getBlock(wx, bottomWy + 1);
  if (t.doorHalf !== "top") {
    return false;
  }
  const m = world.getMetadata(wx, bottomWy);
  const newM = toggleDoorLatchInMeta(m);
  world.setBlock(wx, bottomWy, b.id, { cellMetadata: newM });
  world.setBlock(wx, bottomWy + 1, t.id, { cellMetadata: newM });
  return true;
}
