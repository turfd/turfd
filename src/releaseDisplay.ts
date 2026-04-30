/**
 * Human-facing title from `package.json` semver, including npm prerelease ids (alpha, beta, rc).
 */

function prereleaseChannelLabel(firstId: string): string {
  const id = firstId.toLowerCase();
  if (id === "alpha") return "Alpha";
  if (id === "beta") return "Beta";
  if (id === "rc") return "RC";
  if (id.length === 0) return "";
  return firstId.charAt(0).toUpperCase() + firstId.slice(1);
}

/**
 * e.g. `0.6.0-alpha.2` → `Stratum · Alpha 0.6.0`
 * `1.0.0` → `Stratum · 1.0.0`
 */
export function formatStratumReleaseTitle(version: string): string {
  const m = version.match(/^(\d+\.\d+\.\d+)(?:-(.+))?$/);
  if (m === null) {
    return `Stratum · ${version}`;
  }
  const core = m[1]!;
  const rest = m[2];
  if (rest === undefined || rest.length === 0) {
    return `Stratum · ${core}`;
  }
  const firstPre = rest.split(".")[0] ?? "";
  const label = prereleaseChannelLabel(firstPre);
  if (label.length === 0) {
    return `Stratum · ${core}`;
  }
  return `Stratum · ${label} ${core}`;
}
