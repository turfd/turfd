/**
 * Aim vector from player chest toward the cursor (same convention as the break/place reach line).
 * `dirY` is in display space (positive toward screen bottom / world down for throw velocity).
 */
import {
  BLOCK_SIZE,
  ITEM_THROW_MAX_INITIAL_SPEED_PX,
  ITEM_THROW_MIN_OUTWARD_VS_FACE,
  PLAYER_HEIGHT,
} from "../core/constants";

export function getAimUnitVectorFromFeet(
  feetX: number,
  feetY: number,
  mouseWorldX: number,
  mouseWorldY: number,
  facingRight: boolean,
): { dirX: number; dirY: number } {
  const centerX = feetX;
  const centerDisplayY = -feetY - PLAYER_HEIGHT * 0.5;
  const dx = mouseWorldX - centerX;
  const dy = mouseWorldY - centerDisplayY;
  const dist = Math.hypot(dx, dy);
  if (dist > 0.001) {
    return { dirX: dx / dist, dirY: dy / dist };
  }
  return { dirX: facingRight ? 1 : -1, dirY: 0 };
}

/**
 * Unit direction for tossed items (Q, inventory cursor toss): cursor aim from
 * {@link getAimUnitVectorFromFeet}, then horizontal bias so velocity has a clear
 * outward component in facing (still normalized for world throw velocity).
 */
export function getItemThrowUnitVectorFromFeet(
  feetX: number,
  feetY: number,
  mouseWorldX: number,
  mouseWorldY: number,
  facingRight: boolean,
): { dirX: number; dirY: number } {
  const faceX = facingRight ? 1 : -1;
  const aim = getAimUnitVectorFromFeet(
    feetX,
    feetY,
    mouseWorldX,
    mouseWorldY,
    facingRight,
  );
  let { dirX, dirY } = aim;
  const outward = dirX * faceX;
  if (outward < ITEM_THROW_MIN_OUTWARD_VS_FACE) {
    dirX = faceX * ITEM_THROW_MIN_OUTWARD_VS_FACE;
    const len = Math.hypot(dirX, dirY);
    if (len > 1e-6) {
      dirX /= len;
      dirY /= len;
    } else {
      return { dirX: faceX, dirY: 0 };
    }
  }
  return { dirX, dirY };
}

/** Scales (vx, vy) so initial toss speed stays within {@link ITEM_THROW_MAX_INITIAL_SPEED_PX}. */
export function clampItemThrowVelocity(vx: number, vy: number): {
  vx: number;
  vy: number;
} {
  const max = ITEM_THROW_MAX_INITIAL_SPEED_PX;
  const h = Math.hypot(vx, vy);
  if (h <= max || h < 1e-8) {
    return { vx, vy };
  }
  const s = max / h;
  return { vx: vx * s, vy: vy * s };
}

/** Reach line + crosshair (display / camera space, same axes as `InputManager.mouseWorldPos`). */
export function getReachLineGeometry(
  feetX: number,
  feetY: number,
  mouseWorldX: number,
  mouseWorldY: number,
  facingRight: boolean,
  reachBlocks: number,
): {
  dirX: number;
  dirY: number;
  lineStartX: number;
  lineStartY: number;
  lineLenPx: number;
  aimX: number;
  aimY: number;
} {
  const centerX = feetX;
  const centerY = -feetY - PLAYER_HEIGHT * 0.5;
  const { dirX, dirY } = getAimUnitVectorFromFeet(
    feetX,
    feetY,
    mouseWorldX,
    mouseWorldY,
    facingRight,
  );
  const dist = Math.hypot(mouseWorldX - centerX, mouseWorldY - centerY);
  const startOffsetPx = BLOCK_SIZE;
  const maxLenPx = reachBlocks * BLOCK_SIZE;
  const lineLenPx = Math.min(Math.max(dist - startOffsetPx, 0), maxLenPx);
  const lineStartX = centerX + dirX * startOffsetPx;
  const lineStartY = centerY + dirY * startOffsetPx;
  const aimX = lineStartX + dirX * lineLenPx;
  const aimY = lineStartY + dirY * lineLenPx;
  return { dirX, dirY, lineStartX, lineStartY, lineLenPx, aimX, aimY };
}

/** White crosshair at the end of the reach line (same as block targeting). */
export function getReachCrosshairDisplayPos(
  feetX: number,
  feetY: number,
  mouseWorldX: number,
  mouseWorldY: number,
  facingRight: boolean,
  reachBlocks: number,
): { x: number; y: number } {
  const g = getReachLineGeometry(
    feetX,
    feetY,
    mouseWorldX,
    mouseWorldY,
    facingRight,
    reachBlocks,
  );
  return { x: g.aimX, y: g.aimY };
}
