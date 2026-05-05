export function structureIdFromPath(path: string): string {
  const base = path.split("/").pop() ?? path;
  const withoutJson = base.replace(/\.json$/i, "");
  const stem = withoutJson.replace(/\.structure$/i, "");
  return stem.includes(":") ? stem : `stratum:${stem}`;
}

/**
 * Normalizes `/structure place …` user input to the same id form as {@link structureIdFromPath}.
 * Examples: `dungeon` → `stratum:dungeon`, `dungeon.structure.json` → `stratum:dungeon`,
 * `stratum:dungeon` unchanged.
 */
export function normalizeStructurePlaceIdentifier(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return trimmed;
  }
  if (trimmed.includes(":")) {
    return trimmed;
  }
  const base = trimmed.includes("/") ? (trimmed.split("/").pop() ?? trimmed) : trimmed;
  const withoutJson = base.replace(/\.json$/i, "");
  const stem = withoutJson.replace(/\.structure$/i, "");
  return stem.includes(":") ? stem : `stratum:${stem}`;
}
