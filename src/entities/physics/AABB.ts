/** Screen-space axis-aligned box (Pixi Y down). Pure math — no Pixi imports. */
export type AABB = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export function createAABB(x: number, y: number, width: number, height: number): AABB {
  return { x, y, width, height };
}

export function overlaps(a: AABB, b: AABB): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

/**
 * Axis sweep: X then Y. Resolves overlaps by pushing the mover along each axis.
 * Mutates `mover` in place; pass a copy if you need the original.
 */
export function sweepAABB(
  mover: AABB,
  dx: number,
  dy: number,
  solids: ReadonlyArray<AABB>,
): { resolvedDx: number; resolvedDy: number; hitX: boolean; hitY: boolean } {
  const startX = mover.x;
  const startY = mover.y;
  let hitX = false;
  let hitY = false;

  mover.x += dx;
  for (let pass = 0; pass < 12; pass++) {
    let any = false;
    for (const s of solids) {
      if (overlaps(mover, s)) {
        hitX = true;
        if (dx > 0) {
          mover.x = s.x - mover.width;
        } else if (dx < 0) {
          mover.x = s.x + s.width;
        } else {
          const penL = mover.x + mover.width - s.x;
          const penR = s.x + s.width - mover.x;
          if (penL < penR) {
            mover.x -= penL;
          } else {
            mover.x += penR;
          }
        }
        any = true;
      }
    }
    if (!any) {
      break;
    }
  }

  mover.y += dy;
  for (let pass = 0; pass < 12; pass++) {
    let any = false;
    for (const s of solids) {
      if (overlaps(mover, s)) {
        hitY = true;
        if (dy > 0) {
          mover.y = s.y - mover.height;
        } else if (dy < 0) {
          mover.y = s.y + s.height;
        } else {
          const penT = mover.y + mover.height - s.y;
          const penB = s.y + s.height - mover.y;
          if (penT < penB) {
            mover.y -= penT;
          } else {
            mover.y += penB;
          }
        }
        any = true;
      }
    }
    if (!any) {
      break;
    }
  }

  return {
    resolvedDx: mover.x - startX,
    resolvedDy: mover.y - startY,
    hitX,
    hitY,
  };
}
