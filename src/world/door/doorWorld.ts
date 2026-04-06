import { BLOCK_SIZE, PLAYER_MOVE_ANIM_VEL_THRESHOLD } from "../../core/constants";
import { createAABB, overlaps, type AABB } from "../../entities/physics/AABB";
import type { BlockDefinition } from "../blocks/BlockDefinition";

/** Screen-space collider + horizontal velocity for door proximity / swing rendering. */
export type DoorPlayerSample = {
  aabb: AABB;
  /** World X velocity (px/s, right positive). */
  vx: number;
};

/** Horizontal padding so the door opens before the player fully overlaps the closed collider. */
export const DOOR_PROXIMITY_EXPAND_PX = 8;

/** Closed door panel width in texture / world pixels. */
export const DOOR_PANEL_WIDTH_PX = 3;

export function doorAnchorBottomWy(
  def: BlockDefinition,
  wy: number,
): number | null {
  if (def.doorHalf === "bottom") {
    return wy;
  }
  if (def.doorHalf === "top") {
    return wy - 1;
  }
  return null;
}

export function doorProximityAABB(
  wx: number,
  bottomWy: number,
  expandPx: number,
): AABB {
  const w = BLOCK_SIZE + 2 * expandPx;
  const h = 2 * BLOCK_SIZE;
  const x = wx * BLOCK_SIZE - expandPx;
  const y = -(bottomWy + 2) * BLOCK_SIZE;
  return createAABB(x, y, w, h);
}

export function anyPlayerOverlapsDoorProximity(
  samples: readonly DoorPlayerSample[],
  wx: number,
  bottomWy: number,
): boolean {
  const d = doorProximityAABB(wx, bottomWy, DOOR_PROXIMITY_EXPAND_PX);
  for (const s of samples) {
    if (overlaps(s.aabb, d)) {
      return true;
    }
  }
  return false;
}

/**
 * Overlapping player with strongest horizontal speed (for swing direction when several overlap).
 */
export function doorProximityOverlapBest(
  samples: readonly DoorPlayerSample[],
  wx: number,
  bottomWy: number,
): DoorPlayerSample | null {
  const d = doorProximityAABB(wx, bottomWy, DOOR_PROXIMITY_EXPAND_PX);
  let best: DoorPlayerSample | null = null;
  let bestAbs = -1;
  for (const s of samples) {
    if (!overlaps(s.aabb, d)) {
      continue;
    }
    const ax = Math.abs(s.vx);
    if (best === null || ax > bestAbs) {
      best = s;
      bestAbs = ax;
    }
  }
  return best;
}

/**
 * When the door is open from proximity, panel sits on the side opposite travel: walking right → hinge left.
 * If speed is near zero, use feet vs door column center.
 */
export function doorRenderHingeRightFromProximity(
  sample: DoorPlayerSample,
  doorWx: number,
): boolean {
  const doorCenterX = (doorWx + 0.5) * BLOCK_SIZE;
  const feetX = sample.aabb.x + sample.aabb.width * 0.5;
  if (Math.abs(sample.vx) > PLAYER_MOVE_ANIM_VEL_THRESHOLD) {
    return sample.vx < 0;
  }
  return feetX >= doorCenterX;
}
