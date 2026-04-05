/**
 * Shared deciduous / spruce canopy shapes for worldgen and grown saplings.
 *
 * Naive axis-aligned ellipses on a block grid leave a flat 1-wide top; these
 * predicates fatten the upper crown slightly so trees read rounder and bushier
 * without much larger horizontal footprint.
 */

/** 32-bit mix for stable per-cell decoration. */
function treeRngHash(a: number, b: number, salt: number = 0): number {
  let h = (a * 0x45d9f3b + salt) ^ (b * 0x119de1f3);
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Oak/birch-style leaf blob. dy > 0 is above the canopy center (toward sky).
 */
function isInsideDeciduousBush(
  dx: number,
  dy: number,
  radiusX: number,
  radiusY: number,
): boolean {
  if (radiusX <= 0 || radiusY <= 0) {
    return false;
  }
  const topLift = Math.max(0, dy - (radiusY - 2));
  const effRx = radiusX + topLift * 0.48;
  const nx = dx / effRx;
  const ny = dy / radiusY;
  const d = nx * nx + ny * ny;
  if (d <= 1) {
    return true;
  }
  if (dy >= 0 && d <= 1.2) {
    return true;
  }
  if (d <= 1.07) {
    return true;
  }
  return false;
}

export function forEachDeciduousBushCell(
  canopyCx: number,
  canopyCy: number,
  radiusX: number,
  radiusY: number,
  visit: (wx: number, wy: number) => void,
): void {
  const pad = 1;
  for (let dy = -radiusY - pad; dy <= radiusY + pad; dy++) {
    for (let dx = -radiusX - pad; dx <= radiusX + pad; dx++) {
      if (isInsideDeciduousBush(dx, dy, radiusX, radiusY)) {
        visit(canopyCx + dx, canopyCy + dy);
      }
    }
  }
}

/**
 * Spruce cone with the same layer widths as before, plus sparse side tufts and
 * a slightly wider cap so the silhouette is less triangular/picket-fence.
 */
export function forEachSpruceBushCell(
  anchorWx: number,
  canopyBottomY: number,
  layers: readonly number[],
  visit: (wx: number, wy: number) => void,
): void {
  const n = layers.length;
  for (let i = 0; i < n; i++) {
    const wy = canopyBottomY + i;
    const halfW = layers[n - 1 - i]!;
    if (halfW === 0) {
      visit(anchorWx, wy);
      continue;
    }
    for (let dx = -halfW; dx <= halfW; dx++) {
      visit(anchorWx + dx, wy);
    }
    if (halfW >= 1) {
      const rowRoll = treeRngHash(anchorWx, wy, i ^ 0x4b1d) & 3;
      if (rowRoll !== 0) {
        for (const side of [-1, 1] as const) {
          const wx = anchorWx + side * (halfW + 1);
          if ((treeRngHash(wx, wy, i * 13) & 3) !== 0) {
            visit(wx, wy);
          }
        }
      }
    }
  }

  const topWy = canopyBottomY + n - 1;
  const cap = treeRngHash(anchorWx, topWy, 0x70ee);
  if ((cap & 1) !== 0) {
    visit(anchorWx - 1, topWy);
  }
  if ((cap & 2) !== 0) {
    visit(anchorWx + 1, topWy);
  }
}
