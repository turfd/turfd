/** localStorage-backed video/graphics preferences with synchronous in-memory cache. */

import { VIEW_DISTANCE_CHUNKS } from "../../core/constants";

export type Tonemapper = "none" | "aces" | "agx" | "reinhard";

export type VideoPrefs = {
  tonemapper: Tonemapper;
  /** 1 = full internal albedo RT resolution; lower = fewer RT pixels (GPU fill). */
  renderScale: number;
  /** Torch HDR bloom in the lighting composite pass. */
  bloomEnabled: boolean;
};

const PREF_KEY = "stratum_video_prefs";

export const VIDEO_RENDER_SCALE_MIN = 0.5;
export const VIDEO_RENDER_SCALE_MAX = 1;

function normalizeStoredTonemapper(tm: Tonemapper): Tonemapper {
  return tm === "aces" || tm === "agx" ? "reinhard" : tm;
}

function clampRenderScale(n: number): number {
  if (!Number.isFinite(n)) {
    return 1;
  }
  return Math.min(
    VIDEO_RENDER_SCALE_MAX,
    Math.max(VIDEO_RENDER_SCALE_MIN, n),
  );
}

/** Default internal RT scale on retina: slightly below 1 cuts GPU fill with little visible loss. */
function deviceDefaultRenderScale(): number {
  if (typeof window === "undefined") {
    return 1;
  }
  const dpr = window.devicePixelRatio >= 1 ? window.devicePixelRatio : 1;
  return dpr >= 2 ? clampRenderScale(0.85) : 1;
}

function defaultVideoPrefs(): VideoPrefs {
  return {
    tonemapper: "reinhard",
    renderScale: deviceDefaultRenderScale(),
    bloomEnabled: true,
  };
}

let _cache: VideoPrefs | null = null;

function isTonemapper(v: unknown): v is Tonemapper {
  return (
    v === "none" ||
    v === "aces" ||
    v === "agx" ||
    v === "reinhard"
  );
}

function mergeVideoPrefsFromStorage(
  parsed: Partial<VideoPrefs> & Record<string, unknown>,
): VideoPrefs {
  const defs = defaultVideoPrefs();
  const rawTm = isTonemapper(parsed.tonemapper)
    ? parsed.tonemapper
    : defs.tonemapper;
  const rs =
    typeof parsed.renderScale === "number"
      ? clampRenderScale(parsed.renderScale)
      : 1;
  const bloom =
    typeof parsed.bloomEnabled === "boolean"
      ? parsed.bloomEnabled
      : defs.bloomEnabled;
  return {
    tonemapper: normalizeStoredTonemapper(rawTm),
    renderScale: rs,
    bloomEnabled: bloom,
  };
}

export function getVideoPrefs(): VideoPrefs {
  if (_cache !== null) {
    return _cache;
  }
  try {
    const raw = localStorage.getItem(PREF_KEY);
    if (raw !== null) {
      const parsed = JSON.parse(raw) as Partial<VideoPrefs> & Record<string, unknown>;
      _cache = mergeVideoPrefsFromStorage(parsed);
      return _cache;
    }
  } catch {
    // ignore parse / storage errors
  }
  _cache = defaultVideoPrefs();
  return _cache;
}

export function setVideoPrefs(prefs: Partial<VideoPrefs>): void {
  const current = getVideoPrefs();
  const next: VideoPrefs = {
    ...current,
    ...prefs,
    tonemapper:
      prefs.tonemapper !== undefined && isTonemapper(prefs.tonemapper)
        ? normalizeStoredTonemapper(prefs.tonemapper)
        : current.tonemapper,
    renderScale:
      prefs.renderScale !== undefined
        ? clampRenderScale(prefs.renderScale)
        : current.renderScale,
    bloomEnabled:
      prefs.bloomEnabled !== undefined ? prefs.bloomEnabled : current.bloomEnabled,
  };
  _cache = next;
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify(_cache));
  } catch {
    // ignore storage errors
  }
}

/** Chebyshev chunk radius for terrain mesh sync (fixed; see {@link VIEW_DISTANCE_CHUNKS}). */
export function getEffectiveViewDistanceChunks(): number {
  return VIEW_DISTANCE_CHUNKS;
}
