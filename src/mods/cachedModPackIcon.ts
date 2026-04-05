/** Locate pack.png bytes inside a cached workshop ZIP file map (root or nested path). */
export function findPackPngBytes(
  files: Record<string, Uint8Array>,
): Uint8Array | undefined {
  for (const name of ["pack.png", "Pack.png"]) {
    const u = files[name];
    if (u !== undefined) {
      return u;
    }
  }
  const key = Object.keys(files).find((k) => /(^|\/)pack\.png$/i.test(k));
  return key !== undefined ? files[key] : undefined;
}
