/**
 * Segment vs axis-aligned box in **world** space (Y increases upward).
 */

/**
 * Segment from `(x0,y0)` to `(x1,y1)` with `t ∈ [0,1]` on `P(t) = lerp`.
 * Box: `x ∈ [left, right]`, `y ∈ [bottom, top]` (bottom ≤ top).
 *
 * @returns Smallest `t` in `[0, 1]` where the segment meets the closed box (inclusive).
 *   `0` if the segment starts inside the box. `null` if there is no intersection in `[0,1]`.
 */
export function segmentWorldAabbEnterTClamped01(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  left: number,
  right: number,
  bottom: number,
  top: number,
): number | null {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const EPS = 1e-9;
  let t0 = 0;
  let t1 = 1;

  if (Math.abs(dx) < EPS) {
    if (x0 < left - EPS || x0 > right + EPS) {
      return null;
    }
  } else {
    const inv = 1 / dx;
    let lo = (left - x0) * inv;
    let hi = (right - x0) * inv;
    if (lo > hi) {
      const s = lo;
      lo = hi;
      hi = s;
    }
    if (lo > t0) {
      t0 = lo;
    }
    if (hi < t1) {
      t1 = hi;
    }
    if (t0 > t1 + 1e-9) {
      return null;
    }
  }

  if (Math.abs(dy) < EPS) {
    if (y0 < bottom - EPS || y0 > top + EPS) {
      return null;
    }
  } else {
    const inv = 1 / dy;
    let lo = (bottom - y0) * inv;
    let hi = (top - y0) * inv;
    if (lo > hi) {
      const s = lo;
      lo = hi;
      hi = s;
    }
    if (lo > t0) {
      t0 = lo;
    }
    if (hi < t1) {
      t1 = hi;
    }
    if (t0 > t1 + 1e-9) {
      return null;
    }
  }

  if (t0 > 1 + 1e-6 || t1 < -1e-6) {
    return null;
  }
  return Math.max(0, t0);
}
