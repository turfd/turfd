/**
 * Minecraft dye order (0–15), matching vanilla Java sheep wool / dye ids.
 * Natural spawns only use 6 colors with Java Edition weights.
 */
import type { GeneratorContext } from "../../world/gen/GeneratorContext";

/** DyeColor ordinal: White=0 … Black=15. */
export type SheepWoolColorId = number;

/** Minecraft Java natural sheep spawn weights (sum = 1). */
const W_WHITE = 0.81836;
const W_LIGHT_GRAY = 0.05;
const W_GRAY = 0.05;
const W_BLACK = 0.05;
const W_BROWN = 0.03;

/** Cumulative upper bounds for natural spawn roll (Java weights). */
const TH_WHITE = W_WHITE;
const TH_LIGHT_GRAY = TH_WHITE + W_LIGHT_GRAY;
const TH_GRAY = TH_LIGHT_GRAY + W_GRAY;
const TH_BLACK = TH_GRAY + W_BLACK;
const TH_BROWN = TH_BLACK + W_BROWN;

/** DyeColor ordinals for the six naturally spawning sheep colors. */
export const SheepWoolColor = {
  White: 0,
  Orange: 1,
  Magenta: 2,
  LightBlue: 3,
  Yellow: 4,
  Lime: 5,
  Pink: 6,
  Gray: 7,
  LightGray: 8,
  Cyan: 9,
  Purple: 10,
  Blue: 11,
  Green: 12,
  Brown: 13,
  Red: 14,
  Black: 15,
} as const;

/**
 * Roll natural sheep wool (6 colors, Minecraft Java weights).
 */
export function rollNaturalSheepWoolColor(rng: GeneratorContext): SheepWoolColorId {
  const u = rng.nextFloat();
  if (u < TH_WHITE) {
    return SheepWoolColor.White;
  }
  if (u < TH_LIGHT_GRAY) {
    return SheepWoolColor.LightGray;
  }
  if (u < TH_GRAY) {
    return SheepWoolColor.Gray;
  }
  if (u < TH_BLACK) {
    return SheepWoolColor.Black;
  }
  if (u < TH_BROWN) {
    return SheepWoolColor.Brown;
  }
  return SheepWoolColor.Pink;
}

/**
 * Roll any sheep wool color uniformly across the full dye palette.
 * Used for commands so repeated summons do not overwhelmingly skew white.
 */
export function rollAnySheepWoolColor(rng: GeneratorContext): SheepWoolColorId {
  return Math.floor(rng.nextFloat() * 16) as SheepWoolColorId;
}

function clampWoolColor(id: number): SheepWoolColorId {
  if (!Number.isFinite(id) || id < 0 || id > 15) {
    return SheepWoolColor.White;
  }
  return Math.floor(id) as SheepWoolColorId;
}

export function normalizeSheepWoolColor(id: number | undefined): SheepWoolColorId {
  if (id === undefined) {
    return SheepWoolColor.White;
  }
  return clampWoolColor(id);
}

const SHEEP_WOOL_COLOR_NAME_TO_ID: Readonly<Record<string, SheepWoolColorId>> = {
  white: SheepWoolColor.White,
  orange: SheepWoolColor.Orange,
  magenta: SheepWoolColor.Magenta,
  light_blue: SheepWoolColor.LightBlue,
  lightblue: SheepWoolColor.LightBlue,
  yellow: SheepWoolColor.Yellow,
  lime: SheepWoolColor.Lime,
  pink: SheepWoolColor.Pink,
  gray: SheepWoolColor.Gray,
  grey: SheepWoolColor.Gray,
  light_gray: SheepWoolColor.LightGray,
  lightgray: SheepWoolColor.LightGray,
  light_grey: SheepWoolColor.LightGray,
  lightgrey: SheepWoolColor.LightGray,
  silver: SheepWoolColor.LightGray,
  cyan: SheepWoolColor.Cyan,
  purple: SheepWoolColor.Purple,
  blue: SheepWoolColor.Blue,
  green: SheepWoolColor.Green,
  brown: SheepWoolColor.Brown,
  red: SheepWoolColor.Red,
  black: SheepWoolColor.Black,
};

export function parseSheepWoolColorName(value: string): SheepWoolColorId | null {
  const key = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return SHEEP_WOOL_COLOR_NAME_TO_ID[key] ?? null;
}

/** Item registry keys `stratum:<name>_wool` for each dye color. */
const WOOL_ITEM_SUFFIXES = [
  "white",
  "orange",
  "magenta",
  "light_blue",
  "yellow",
  "lime",
  "pink",
  "gray",
  "light_gray",
  "cyan",
  "purple",
  "blue",
  "green",
  "brown",
  "red",
  "black",
] as const;

/**
 * Item registry key for this dye ordinal. Same string is used as the **placeable wool block**
 * identifier (`stratum:white_wool`, …) and `blocks.loot.json` table id so sheep drops match
 * world wool tiles and inventory wool stacks.
 */
export function getWoolItemKeyForColor(woolColor: number): string {
  const c = clampWoolColor(woolColor);
  return `stratum:${WOOL_ITEM_SUFFIXES[c]}_wool`;
}

/**
 * Pixi multiply-tint RGB (approximate Minecraft wool block colors).
 * Index = dye ordinal 0–15.
 */
export const SHEEP_WOOL_TINT_HEX: readonly number[] = [
  0xe9ecec, 0xf07613, 0xbd44b3, 0x3aafd9, 0xfed83d, 0x80c71f, 0xf38baa, 0x3e4447,
  0xbcbfc2, 0x169c9d, 0x8932b7,
  0x2d62e6, // blue (clearer than MC #3c44aa under multiply)
  0x5e7c16, 0x835432, 0xb02e26, 0x151519,
];

export function getSheepWoolTintHex(woolColor: number): number {
  const c = clampWoolColor(woolColor);
  const hex = SHEEP_WOOL_TINT_HEX[c];
  return hex !== undefined ? hex : 0xe9ecec;
}
