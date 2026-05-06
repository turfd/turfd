export type DonatorTier = "none" | "iron" | "gold" | "stratite";

export const DONATOR_IRON_COLOR_HEX = "#c0c7d1";
export const DONATOR_GOLD_COLOR_HEX = "#f2c14e";
export const DONATOR_STRATITE_COLOR_HEX = "#4ea1ff";
export const DEFAULT_PLAYER_NAME_COLOR_HEX = "#f2f2f7";
export const DEFAULT_PLAYER_OUTLINE_COLOR_HEX = DONATOR_IRON_COLOR_HEX;

export const DONATOR_PRESET_COLORS: readonly string[] = [
  DONATOR_IRON_COLOR_HEX,
  DONATOR_GOLD_COLOR_HEX,
  DONATOR_STRATITE_COLOR_HEX,
];

function normalizeHex(raw: string): string | null {
  const t = raw.trim();
  const match = /^#?([0-9a-fA-F]{6})$/.exec(t);
  if (match === null) {
    return null;
  }
  return `#${match[1]!.toLowerCase()}`;
}

export function cosmeticTierFromRaw(raw: string | null | undefined): DonatorTier {
  if (raw === "iron" || raw === "gold" || raw === "stratite") {
    return raw;
  }
  return "none";
}

export function allowedPresetColorsForTier(tier: DonatorTier): readonly string[] {
  if (tier === "iron") {
    return [DONATOR_IRON_COLOR_HEX];
  }
  if (tier === "gold") {
    return [DONATOR_IRON_COLOR_HEX, DONATOR_GOLD_COLOR_HEX];
  }
  if (tier === "stratite") {
    return DONATOR_PRESET_COLORS;
  }
  return [];
}

export function canUseCustomColor(tier: DonatorTier): boolean {
  return tier === "stratite";
}

export function sanitizeColorForTier(
  rawColor: string | null | undefined,
  tier: DonatorTier,
  fallbackHex: string,
): string {
  const fallback = normalizeHex(fallbackHex) ?? DEFAULT_PLAYER_NAME_COLOR_HEX;
  const parsed = rawColor === null || rawColor === undefined ? null : normalizeHex(rawColor);
  if (parsed === null) {
    return fallback;
  }
  if (canUseCustomColor(tier)) {
    return parsed;
  }
  const allowed = allowedPresetColorsForTier(tier);
  return allowed.includes(parsed) ? parsed : fallback;
}

export function hexToNumber(colorHex: string): number {
  const hex = sanitizeColorForTier(colorHex, "stratite", DEFAULT_PLAYER_NAME_COLOR_HEX);
  return Number.parseInt(hex.slice(1), 16);
}
