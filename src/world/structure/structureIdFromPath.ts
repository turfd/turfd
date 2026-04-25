export function structureIdFromPath(path: string): string {
  const base = path.split("/").pop() ?? path;
  const withoutJson = base.replace(/\.json$/i, "");
  const stem = withoutJson.replace(/\.structure$/i, "");
  return stem.includes(":") ? stem : `stratum:${stem}`;
}
