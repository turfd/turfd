/** Creative inventory tab; matches `stratum:creative_category` in item/block JSON. */

export const CREATIVE_CATEGORIES = [
  "construction",
  "equipment",
  "food",
  "nature",
  "items",
] as const;

export type CreativeCategory = (typeof CREATIVE_CATEGORIES)[number];
