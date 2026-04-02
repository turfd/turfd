/** Match a logical texture name to a manifest / atlas key (underscore vs hyphen, case). */

export function resolveTextureMapKey<T>(
  map: ReadonlyMap<string, T> | Map<string, T>,
  textureName: string,
): T | undefined {
  const direct = map.get(textureName);
  if (direct !== undefined) {
    return direct;
  }
  const asHyphen = textureName.replace(/_/g, "-");
  if (asHyphen !== textureName) {
    const h = map.get(asHyphen);
    if (h !== undefined) {
      return h;
    }
  }
  const asUnder = textureName.replace(/-/g, "_");
  if (asUnder !== textureName) {
    const u = map.get(asUnder);
    if (u !== undefined) {
      return u;
    }
  }
  const lower = textureName.toLowerCase();
  for (const k of map.keys()) {
    if (k.toLowerCase() === lower) {
      const e = map.get(k);
      if (e !== undefined) {
        return e;
      }
    }
  }
  return undefined;
}
