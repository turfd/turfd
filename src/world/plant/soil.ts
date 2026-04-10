/**
 * Soil checks for plants that must sit on natural ground (saplings, flowers, etc.).
 */

/** Grass, dirt, or tilled soil — same as valid sapling / crop ground. */
export function isGrassDirtOrFarmlandSurface(below: {
  identifier: string;
}): boolean {
  return (
    below.identifier === "stratum:grass" ||
    below.identifier === "stratum:dirt" ||
    below.identifier === "stratum:farmland_dry" ||
    below.identifier === "stratum:farmland_moist"
  );
}

export function isSaplingIdentifier(identifier: string): boolean {
  return (
    identifier === "stratum:oak_sapling" ||
    identifier === "stratum:spruce_sapling" ||
    identifier === "stratum:birch_sapling"
  );
}
