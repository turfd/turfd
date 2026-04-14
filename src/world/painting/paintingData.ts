export interface PaintingVariant {
  readonly name: string;
  readonly width: number;
  readonly height: number;
}

/**
 * All painting variants ordered by size (smallest first).
 * The index in this array is the variant id used in metadata encoding.
 */
export const PAINTING_VARIANTS: readonly PaintingVariant[] = [
  // 1x1
  { name: "skewer", width: 1, height: 1 },
  { name: "rune", width: 1, height: 1 },
  { name: "totem", width: 1, height: 1 },
  { name: "hillside", width: 1, height: 1 },
  { name: "fern", width: 1, height: 1 },
  { name: "hut", width: 1, height: 1 },
  // 2x1
  { name: "bathers", width: 2, height: 1 },
  { name: "hikers", width: 2, height: 1 },
  { name: "shore", width: 2, height: 1 },
  { name: "dusk", width: 2, height: 1 },
  // 1x2
  { name: "wanderer", width: 1, height: 2 },
  // 2x2
  { name: "bouquet", width: 2, height: 2 },
  { name: "campfire", width: 2, height: 2 },
  { name: "specter", width: 2, height: 2 },
  { name: "summit", width: 2, height: 2 },
  // 4x2
  { name: "duel", width: 4, height: 2 },
  // 4x3
  { name: "dungeon", width: 4, height: 3 },
  { name: "arcade", width: 4, height: 3 },
  // 4x4
  { name: "moonlight", width: 4, height: 4 },
  { name: "easel", width: 4, height: 4 },
];

export interface DecodedPaintingCell {
  readonly variantIndex: number;
  readonly offsetX: number;
  readonly offsetY: number;
}

/**
 * Starting metadata value for each variant's first cell.
 * Built once at module load.
 */
const PAINTING_CELL_BASE: number[] = [];

/**
 * Lookup from metadata byte to decoded painting cell.
 * Index = metadata value, value = decoded info.
 */
const PAINTING_DECODE: DecodedPaintingCell[] = [];

let nextBase = 0;
for (let vi = 0; vi < PAINTING_VARIANTS.length; vi++) {
  const v = PAINTING_VARIANTS[vi]!;
  PAINTING_CELL_BASE.push(nextBase);
  for (let oy = 0; oy < v.height; oy++) {
    for (let ox = 0; ox < v.width; ox++) {
      PAINTING_DECODE.push({ variantIndex: vi, offsetX: ox, offsetY: oy });
    }
  }
  nextBase += v.width * v.height;
}

export function encodePaintingMeta(
  variantIndex: number,
  offsetX: number,
  offsetY: number,
): number {
  const v = PAINTING_VARIANTS[variantIndex]!;
  return PAINTING_CELL_BASE[variantIndex]! + offsetY * v.width + offsetX;
}

export function decodePaintingMeta(meta: number): DecodedPaintingCell {
  return PAINTING_DECODE[meta]!;
}

export function paintingAtlasKey(variantIndex: number): string {
  return "painting_" + PAINTING_VARIANTS[variantIndex]!.name;
}
