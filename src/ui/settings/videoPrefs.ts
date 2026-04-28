/** localStorage-backed video/graphics preferences with synchronous in-memory cache. */

import {
  SIMULATION_DISTANCE_CHUNKS,
  VIEW_DISTANCE_CHUNKS,
} from "../../core/constants";

export type Tonemapper = "none" | "aces" | "agx" | "reinhard";

export type VideoPrefs = {
  tonemapper: Tonemapper;
  /** 1 = full internal albedo RT resolution; lower = fewer RT pixels (GPU fill). */
  renderScale: number;
  /** Chebyshev chunk radius for terrain mesh sync (clamped). */
  viewDistanceChunks: number;
  /** Torch HDR bloom in the lighting composite pass. */
  bloomEnabled: boolean;
};

const PREF_KEY = "stratum_video_prefs";

export const VIDEO_RENDER_SCALE_MIN = 0.5;
export const VIDEO_RENDER_SCALE_MAX = 1;
export const VIDEO_VIEW_DISTANCE_MIN = 4;

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

function clampViewDistanceChunks(n: number): number {
  if (!Number.isFinite(n)) {
    return VIEW_DISTANCE_CHUNKS;
  }
  const floored = Math.floor(n);
  return Math.min(
    SIMULATION_DISTANCE_CHUNKS,
    Math.max(VIDEO_VIEW_DISTANCE_MIN, floored),
  );
}

const DEFAULTS: VideoPrefs = {
  tonemapper: "reinhard",
  renderScale: 1,
  viewDistanceChunks: VIEW_DISTANCE_CHUNKS,
  bloomEnabled: true,
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

function mergeVideoPrefsFromStorage(
  parsed: Partial<VideoPrefs> & Record<string, unknown>,
): VideoPrefs {
  const rawTm = isTonemapper(parsed.tonemapper)
    ? parsed.tonemapper
    : DEFAULTS.tonemapper;
  const rs =
    typeof parsed.renderScale === "number"
      ? clampRenderScale(parsed.renderScale)
      : DEFAULTS.renderScale;
  const vd =
    typeof parsed.viewDistanceChunks === "number"
      ? clampViewDistanceChunks(parsed.viewDistanceChunks)
      : DEFAULTS.viewDistanceChunks;
  const bloom =
    typeof parsed.bloomEnabled === "boolean"
      ? parsed.bloomEnabled
      : DEFAULTS.bloomEnabled;
  return {
    tonemapper: normalizeStoredTonemapper(rawTm),
    renderScale: rs,
    viewDistanceChunks: vd,
    bloomEnabled: bloom,
  };
}

export function getVideoPrefs(): VideoPrefs {
  if (_cache !== null) {
    const merged: VideoPrefs = { ...DEFAULTS, ..._cache };
    const tm = normalizeStoredTonemapper(merged.tonemapper);
    const rs = clampRenderScale(merged.renderScale);
    const vd = clampViewDistanceChunks(merged.viewDistanceChunks);
    const bloom = merged.bloomEnabled;
    if (
      tm !== merged.tonemapper ||
      rs !== merged.renderScale ||
      vd !== merged.viewDistanceChunks ||
      bloom !== merged.bloomEnabled
    ) {
      _cache = { tonemapper: tm, renderScale: rs, viewDistanceChunks: vd, bloomEnabled: bloom };
      try {
        localStorage.setItem(PREF_KEY, JSON.stringify(_cache));
      } catch {
        // ignore
      }
    }
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
  _cache = { ...DEFAULTS };
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
    viewDistanceChunks:
      prefs.viewDistanceChunks !== undefined
        ? clampViewDistanceChunks(prefs.viewDistanceChunks)
        : current.viewDistanceChunks,
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

/** Chunk mesh sync radius (Chebyshev); respects video prefs + clamps. */
export function getEffectiveViewDistanceChunks(): number {
  return clampViewDistanceChunks(getVideoPrefs().viewDistanceChunks);
}
