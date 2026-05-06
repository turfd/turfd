import type { DiscordEntitlementStatus } from "../network/discordEntitlementApi";

export type DonatorTier = "none" | "iron" | "gold" | "stratite";

export const DONATOR_IRON_COLOR_HEX = "#c0c7d1";
export const DONATOR_GOLD_COLOR_HEX = "#f2c14e";
export const DONATOR_STRATITE_COLOR_HEX = "#4ea1ff";
export const DEFAULT_PLAYER_NAME_COLOR_HEX = "#f2f2f7";
/** Empty string = no donor glow outline (non-donors and donors who have not picked a color). */
export const NO_OUTLINE_GLOW_HEX = "";

/** @deprecated Use {@link NO_OUTLINE_GLOW_HEX}; iron is only a preset swatch, not a default outline. */
export const DEFAULT_PLAYER_OUTLINE_COLOR_HEX = NO_OUTLINE_GLOW_HEX;

export function effectiveDonatorTierFromDiscord(
  status: DiscordEntitlementStatus | null | undefined,
): DonatorTier {
  if (status === null || status === undefined) {
    return "none";
  }
  if (!status.linked || !status.isDonator) {
    return "none";
  }
  if (status.tier === "iron" || status.tier === "gold" || status.tier === "stratite") {
    return status.tier;
  }
  return "none";
}

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

/** Nametag color: donor presets/custom by tier; non-donors always get the default white. */
export function sanitizeDonorNameColorForSettings(
  rawColor: string | null | undefined,
  tier: DonatorTier,
): string {
  if (tier === "none") {
    return DEFAULT_PLAYER_NAME_COLOR_HEX;
  }
  return sanitizeColorForTier(rawColor, tier, DEFAULT_PLAYER_NAME_COLOR_HEX);
}

/**
 * Outline glow: only when donor tier allows and the stored value is a valid choice for that tier.
 * Missing/invalid ⇒ no outline (empty string).
 */
export function sanitizeOutlineColorForSettings(
  rawColor: string | null | undefined,
  tier: DonatorTier,
): string {
  if (tier === "none") {
    return NO_OUTLINE_GLOW_HEX;
  }
  const parsed = rawColor === null || rawColor === undefined ? null : normalizeHex(rawColor.trim());
  if (parsed === null) {
    return NO_OUTLINE_GLOW_HEX;
  }
  if (canUseCustomColor(tier)) {
    return parsed;
  }
  const allowed = allowedPresetColorsForTier(tier);
  return allowed.includes(parsed) ? parsed : NO_OUTLINE_GLOW_HEX;
}

export function hexToNumber(colorHex: string): number {
  const hex = normalizeHex(colorHex) ?? DEFAULT_PLAYER_NAME_COLOR_HEX;
  return Number.parseInt(hex.slice(1), 16);
}
