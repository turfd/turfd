/**
 * Aim vector from player chest toward the cursor (same convention as the break/place reach line).
 * `dirY` is in display space (positive toward screen bottom / world down for throw velocity).
 */
import { PLAYER_HEIGHT } from "../core/constants";

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
