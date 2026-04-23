/** localStorage-backed video/graphics preferences with synchronous in-memory cache. */

export type Tonemapper = "none" | "aces" | "agx" | "reinhard";

export type VideoPrefs = {
  tonemapper: Tonemapper;
  bloom: boolean;
};

const PREF_KEY = "stratum_video_prefs";

function normalizeStoredTonemapper(tm: Tonemapper): Tonemapper {
  return tm === "aces" || tm === "agx" ? "reinhard" : tm;
}

const DEFAULTS: VideoPrefs = {
  tonemapper: "reinhard",
  bloom: true,
};

let _cache: VideoPrefs | null = null;

function isTonemapper(v: unknown): v is Tonemapper {
  return (
    v === "none" ||
    v === "aces" ||
    v === "agx" ||
    v === "reinhard"
  );
}

export function getVideoPrefs(): VideoPrefs {
  if (_cache !== null) {
    const merged = { ...DEFAULTS, ..._cache };
    const tm = normalizeStoredTonemapper(merged.tonemapper);
    if (tm !== merged.tonemapper) {
      merged.tonemapper = tm;
      _cache = merged;
      try {
        localStorage.setItem(PREF_KEY, JSON.stringify(_cache));
      } catch {
        // ignore
      }
    }
    return merged;
  }
  try {
    const raw = localStorage.getItem(PREF_KEY);
    if (raw !== null) {
      const parsed = JSON.parse(raw) as Partial<VideoPrefs> & Record<string, unknown>;
      const rawTm = isTonemapper(parsed.tonemapper)
        ? parsed.tonemapper
        : DEFAULTS.tonemapper;
      _cache = {
        tonemapper: normalizeStoredTonemapper(rawTm),
        bloom: typeof parsed.bloom === "boolean" ? parsed.bloom : DEFAULTS.bloom,
      };
      return _cache;
    }
  } catch {
    // ignore parse / storage errors
  }
  _cache = { ...DEFAULTS };
  return _cache;
}

export function setVideoPrefs(prefs: Partial<VideoPrefs>): void {
  const current = getVideoPrefs();
  _cache = { ...current, ...prefs };
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify(_cache));
  } catch {
    // ignore storage errors
  }
}
