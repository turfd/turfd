/** localStorage keys for pause-menu volume sliders (0–100). */
export const VOL_KEYS = {
  master: "turfd_vol_master",
  music: "turfd_vol_music",
  sfx: "turfd_vol_sfx",
} as const;

export function readVolumeStored(key: string, defaultVal: number): number {
  const s = localStorage.getItem(key);
  if (s === null) {
    return defaultVal;
  }
  const n = parseInt(s, 10);
  if (!Number.isFinite(n)) {
    return defaultVal;
  }
  return Math.min(100, Math.max(0, n));
}
