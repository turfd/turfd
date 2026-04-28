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

/** Which outer edge of a stair cell touches the orthogonally adjacent block (world +X = right). */
export type StairOuterFace = "top" | "bottom" | "left" | "right";

function merge1dIntervals(intervals: [number, number][]): [number, number][] {
  if (intervals.length === 0) {
    return [];
  }
  intervals.sort((a, b) => a[0]! - b[0]!);
  const out: [number, number][] = [];
  let cs = intervals[0]![0]!;
  let ce = intervals[0]![1]!;
  for (let k = 1; k < intervals.length; k++) {
    const s = intervals[k]![0]!;
    const e = intervals[k]![1]!;
    if (s <= ce) {
      ce = Math.max(ce, e);
    } else {
      out.push([cs, ce]);
      cs = s;
      ce = e;
    }
  }
  out.push([cs, ce]);
  return out;
}

/**
 * Union of 1D spans along an outer face (parameter t runs 0→{@link BLOCK_SIZE} along that edge:
 * top/bottom → x left→right; left/right → y top→bottom in cell pixel space, Pixi Y down).
 * Used for fg-on-bg contact shadows so stairs do not cast a full-tile strip.
 */
export function stairSolidContactSpansOnFace(
  shape: StairShape,
  face: StairOuterFace,
): readonly [number, number][] {
  const b = BLOCK_SIZE;
  const raw: [number, number][] = [];
  for (const [rx, ry, rw, rh] of stairSolidRectsInCellPixels(shape)) {
    switch (face) {
      case "left":
        if (rx === 0 && rw > 0) {
          raw.push([ry, ry + rh]);
        }
        break;
      case "right":
        if (rx < b && rx + rw >= b) {
          raw.push([ry, ry + rh]);
        }
        break;
      case "top":
        if (ry === 0 && rh > 0) {
          raw.push([rx, rx + rw]);
        }
        break;
      case "bottom":
        if (ry < b && ry + rh >= b) {
          raw.push([rx, rx + rw]);
        }
        break;
      default:
        break;
    }
  }
  const merged = merge1dIntervals(raw);
  return merged
    .map(
      ([s, e]): [number, number] => [
        Math.max(0, Math.min(b, s)),
        Math.max(0, Math.min(b, e)),
      ],
    )
    .filter(([s, e]) => e > s);
}

/**
 * Two axis-aligned solid regions inside a block cell (Pixi Y down), matching mesh quads.
 * Each tuple is `[originX, originY, width, height]` in cell pixels (see {@link getSolidAABBs}).
 */
export function stairSolidRectsInCellPixels(shape: StairShape): readonly [
  readonly [number, number, number, number],
  readonly [number, number, number, number],
] {
  const b = BLOCK_SIZE;
  switch (shape) {
    case 0:
      return [
        [0, HALF, b, HALF],
        [HALF, 0, HALF, HALF],
      ];
    case 1:
      return [
        [0, HALF, b, HALF],
        [0, 0, HALF, HALF],
      ];
    case 2:
      return [
        [0, 0, b, HALF],
        [HALF, HALF, HALF, HALF],
      ];
    case 3:
    default:
      return [
        [0, 0, b, HALF],
        [0, HALF, HALF, HALF],
      ];
  }
}
