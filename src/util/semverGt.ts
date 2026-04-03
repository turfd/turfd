/** True if semver string `a` is strictly greater than `b` (numeric segments, non-numeric tail ignored). */
export function semverGt(a: string, b: string): boolean {
  const pa = a.split(".").map((x) => parseInt(x, 10));
  const pb = b.split(".").map((x) => parseInt(x, 10));
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const da = Number.isFinite(pa[i]!) ? pa[i]! : 0;
    const db = Number.isFinite(pb[i]!) ? pb[i]! : 0;
    if (da !== db) {
      return da > db;
    }
  }
  return false;
}
