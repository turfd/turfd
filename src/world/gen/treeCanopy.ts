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
 * Terraria-style spruce cone. `layers` is indexed top→bottom (layer 0 is the narrow
 * tip, the last entry is the wide base), so the `layers[n-1-i]` lookup gives the
 * correct half-width as we iterate from the canopy bottom upward.
 *
 * The base shape is a clean stepped triangle: each layer places the solid core
 * `[−halfW, +halfW]`, with no fattening applied to the tip. On top we emit *sparse*
 * single-cell edge tufts one column past the core, but only on the lower half of
 * the cone (layers whose half-width is at least half of the tree's max). Restricting
 * tufts this way keeps the point at the top visibly pointy while still breaking up
 * the perfectly straight diagonal that naive cones suffer from — the noisy/branchy
 * feel of a real spruce silhouette comes from hashed per-cell irregularities on the
 * lower 2/3 of the canopy, exactly where Terraria's reference art puts them.
 */
export function forEachSpruceBushCell(
  anchorWx: number,
  canopyBottomY: number,
  layers: readonly number[],
  visit: (wx: number, wy: number) => void,
): void {
  const n = layers.length;
  if (n === 0) {
    return;
  }
  const maxHalfW = layers[n - 1]!;

  for (let i = 0; i < n; i++) {
    const wy = canopyBottomY + i;
    const halfW = layers[n - 1 - i]!;

    // Solid core of the cone at this layer (always placed).
    if (halfW === 0) {
      visit(anchorWx, wy);
      continue;
    }
    for (let dx = -halfW; dx <= halfW; dx++) {
      visit(anchorWx + dx, wy);
    }

    // Sparse edge tufts only on the lower/middle band (halfW*2 >= maxHalfW). Each
    // side is rolled independently at ~25% so we get occasional asymmetric bumps
    // instead of a mirrored "fat cone". Two-bit bucket per side of the same hash
    // word keeps the dice independent.
    if (halfW >= 2 && halfW * 2 >= maxHalfW) {
      const roll = treeRngHash(anchorWx, wy, (i * 17) ^ 0x4b1d);
      if ((roll & 3) === 0) {
        visit(anchorWx - (halfW + 1), wy);
      }
      if (((roll >>> 3) & 3) === 0) {
        visit(anchorWx + (halfW + 1), wy);
      }
    }
  }

  // No top-cap widening: the layer array's trailing `0`s already give the tip its
  // single-cell point, which is exactly what Terraria-style spruces want.
}
