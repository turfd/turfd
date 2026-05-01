/**
 * Deterministic 2D integer hash + uniform `[0, 1)` mapping shared by
 * world-gen subsystems (tree placement, structure feature placement, etc.).
 *
 * Identical implementation across consumers is required for chunk determinism
 * — both {@link TreePlacer} and {@link StructurePlacer} must agree byte-for-byte
 * with each other and with any worker-side replica of {@link WorldGenerator}.
 */

/** Mixes two ints into a uniformly-distributed 32-bit unsigned hash. */
export function hash2(a: number, b: number): number {
  let h = (a * 0x45d9f3b) ^ (b * 0x119de1f3);
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Uniform `[0, 1)` from a 32-bit unsigned hash. */
export function random01(h: number): number {
  return h / 0xffff_ffff;
}
