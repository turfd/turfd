import { Matrix } from "pixi.js";

const _mat = new Matrix();

/**
 * World position of a mob-stuck arrow after the mob's death tip-over: rotate the stuck offset
 * (stored as world delta from feet) in display space by `tiltRad`, same convention as mob sprite roots.
 */
export function mobStuckArrowWorldFromFeet(
  feetX: number,
  feetY: number,
  ox: number,
  oyWorld: number,
  tiltRad: number,
): { x: number; y: number } {
  if (tiltRad === 0) {
    return { x: feetX + ox, y: feetY + oyWorld };
  }
  const vx = ox;
  const vy = -oyWorld;
  _mat.identity();
  _mat.rotate(tiltRad);
  const p = _mat.apply({ x: vx, y: vy });
  return { x: feetX + p.x, y: feetY - p.y };
}
