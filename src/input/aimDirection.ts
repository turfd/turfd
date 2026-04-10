/**
 * Aim vector from player chest toward the cursor (same convention as the break/place reach line).
 * `dirY` is in display space (positive toward screen bottom / world down for throw velocity).
 */
import { BLOCK_SIZE, PLAYER_HEIGHT } from "../core/constants";

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
