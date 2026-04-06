import { BLOCK_SIZE, WORLDGEN_NO_COLLIDE } from "../../core/constants";

/** Bits 6–7 of chunk cell metadata; water uses 1–5, bit 0 is {@link WORLDGEN_NO_COLLIDE}. */
export const STAIR_SHAPE_SHIFT = 6;
export const STAIR_SHAPE_MASK = 0xc0;

/**
 * 0 = missing top-left 8×8, 1 = missing top-right, 2 = missing bottom-left (upside-down),
 * 3 = missing bottom-right (upside-down).
 */
export type StairShape = 0 | 1 | 2 | 3;

export function getStairShape(cellMetadata: number): StairShape {
  return ((cellMetadata & STAIR_SHAPE_MASK) >> STAIR_SHAPE_SHIFT) as StairShape;
}

/** Preserves {@link WORLDGEN_NO_COLLIDE}; clears water bits; sets stair shape. */
export function withStairShape(cellMetadata: number, shape: number): number {
  const s = Math.max(0, Math.min(3, Math.floor(shape))) & 3;
  return (cellMetadata & WORLDGEN_NO_COLLIDE) | (s << STAIR_SHAPE_SHIFT);
}

/**
 * Placement shape for stairs: always a normal floor stair (0 or 1), never upside-down (2/3).
 * Ramp “faces away” from the player: block to the player’s right uses shape 0 (+X), to their left uses 1 (−X).
 */
export function computePlacedStairShape(
  placeWx: number,
  playerFeetWorldX: number,
): StairShape {
  const b = BLOCK_SIZE;
  const blockCenterX = placeWx * b + b * 0.5;
  const blockLeftOfPlayer = blockCenterX < playerFeetWorldX;
  return (blockLeftOfPlayer ? 1 : 0) as StairShape;
}

const HALF = BLOCK_SIZE / 2;

/**
 * Two axis-aligned solid regions inside a block cell (Pixi Y down), matching mesh quads.
 */
export function stairSolidRectsInCellPixels(shape: StairShape): readonly [
  readonly [number, number, number, number],
  readonly [number, number, number, number],
] {
  const b = BLOCK_SIZE;
  switch (shape) {
    case 0:
      return [
        [0, HALF, b, b],
        [HALF, 0, b, HALF],
      ];
    case 1:
      return [
        [0, HALF, b, b],
        [0, 0, HALF, HALF],
      ];
    case 2:
      return [
        [0, 0, b, HALF],
        [HALF, HALF, b, b],
      ];
    case 3:
    default:
      return [
        [0, 0, b, HALF],
        [0, HALF, HALF, b],
      ];
  }
}
