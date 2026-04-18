/** localStorage-backed video/graphics preferences with synchronous in-memory cache. */

export type Tonemapper = "none" | "aces" | "agx" | "reinhard";

export type VideoPrefs = {
  tonemapper: Tonemapper;
  bloom: boolean;
  screenSpaceNormals: boolean;
  /** 0–1 scales N·L contribution when {@link screenSpaceNormals} is on. */
  normalMapStrength: number;
  ssnBevel: number;
  ssnHeightStrength: number;
  ssnSmoothness: number;
  ssnDetailWeight: number;
  ssnInvertX: boolean;
  ssnInvertY: boolean;
  /** When SSN is on, composite shows encoded normal RGB instead of lit scene (debug). */
  debugShowNormalMap: boolean;
  /**
   * Nudge normal-map sampling vs albedo (logical px). Saved per browser.
   * Positive X shifts the normal map right on screen; positive Y shifts it down.
   * Defaults match {@link SSN_COMPOSITE_ALIGNMENT_DEFAULTS} (filter-chain baseline).
   */
  ssnNormalOffsetXPx: number;
  ssnNormalOffsetYPx: number;
  /** Scale normal-map UVs about screen center (1 = identity). */
  ssnNormalUvScale: number;
};

const PREF_KEY = "stratum_video_prefs";

/**
 * Baseline SSN ↔ composite alignment (empirical; Pixi filter chain vs fullscreen composite).
 * Adjust if the screen-space normal pass or composite sampling changes.
 */
export const SSN_COMPOSITE_ALIGNMENT_DEFAULTS = {
  ssnNormalOffsetXPx: -67.6,
  ssnNormalOffsetYPx: -38.2,
  ssnNormalUvScale: 1.068,
} as const;

function normalizeStoredTonemapper(tm: Tonemapper): Tonemapper {
  return tm === "aces" || tm === "agx" ? "reinhard" : tm;
}

/** Matches {@link DEFAULT_SCREEN_SPACE_NORMAL_PARAMS} (keep in sync). */
const DEFAULTS: VideoPrefs = {
  tonemapper: "reinhard",
  bloom: true,
  screenSpaceNormals: true,
  normalMapStrength: 0.35,
  ssnBevel: 4,
  ssnHeightStrength: 2.5,
  ssnSmoothness: 1,
  ssnDetailWeight: 0.2,
  ssnInvertX: false,
  ssnInvertY: false,
  debugShowNormalMap: false,
  ssnNormalOffsetXPx: SSN_COMPOSITE_ALIGNMENT_DEFAULTS.ssnNormalOffsetXPx,
  ssnNormalOffsetYPx: SSN_COMPOSITE_ALIGNMENT_DEFAULTS.ssnNormalOffsetYPx,
  ssnNormalUvScale: SSN_COMPOSITE_ALIGNMENT_DEFAULTS.ssnNormalUvScale,
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

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

function clampSsnOffset(x: number): number {
  if (!Number.isFinite(x)) {
    return 0;
  }
  return Math.min(96, Math.max(-96, x));
}

function clampSsnUvScale(x: number): number {
  if (!Number.isFinite(x)) {
    return 1;
  }
  return Math.min(2, Math.max(0.5, x));
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
      const parsed = JSON.parse(raw) as Partial<VideoPrefs>;
      const rawTm = isTonemapper(parsed.tonemapper)
        ? parsed.tonemapper
        : DEFAULTS.tonemapper;
      _cache = {
        tonemapper: normalizeStoredTonemapper(rawTm),
        bloom: typeof parsed.bloom === "boolean" ? parsed.bloom : DEFAULTS.bloom,
        screenSpaceNormals:
          typeof parsed.screenSpaceNormals === "boolean"
            ? parsed.screenSpaceNormals
            : DEFAULTS.screenSpaceNormals,
        normalMapStrength:
          typeof parsed.normalMapStrength === "number"
            ? clamp01(parsed.normalMapStrength)
            : DEFAULTS.normalMapStrength,
        ssnBevel:
          typeof parsed.ssnBevel === "number"
            ? Math.min(50, Math.max(0, parsed.ssnBevel))
            : DEFAULTS.ssnBevel,
        ssnHeightStrength:
          typeof parsed.ssnHeightStrength === "number"
            ? Math.min(10, Math.max(0.1, parsed.ssnHeightStrength))
            : DEFAULTS.ssnHeightStrength,
        ssnSmoothness:
          typeof parsed.ssnSmoothness === "number"
            ? Math.min(10, Math.max(0, parsed.ssnSmoothness))
            : DEFAULTS.ssnSmoothness,
        ssnDetailWeight:
          typeof parsed.ssnDetailWeight === "number"
            ? Math.min(1, Math.max(0, parsed.ssnDetailWeight))
            : DEFAULTS.ssnDetailWeight,
        ssnInvertX:
          typeof parsed.ssnInvertX === "boolean"
            ? parsed.ssnInvertX
            : DEFAULTS.ssnInvertX,
        ssnInvertY:
          typeof parsed.ssnInvertY === "boolean"
            ? parsed.ssnInvertY
            : DEFAULTS.ssnInvertY,
        debugShowNormalMap:
          typeof parsed.debugShowNormalMap === "boolean"
            ? parsed.debugShowNormalMap
            : DEFAULTS.debugShowNormalMap,
        ssnNormalOffsetXPx: clampSsnOffset(
          typeof parsed.ssnNormalOffsetXPx === "number"
            ? parsed.ssnNormalOffsetXPx
            : DEFAULTS.ssnNormalOffsetXPx,
        ),
        ssnNormalOffsetYPx: clampSsnOffset(
          typeof parsed.ssnNormalOffsetYPx === "number"
            ? parsed.ssnNormalOffsetYPx
            : DEFAULTS.ssnNormalOffsetYPx,
        ),
        ssnNormalUvScale: clampSsnUvScale(
          typeof parsed.ssnNormalUvScale === "number"
            ? parsed.ssnNormalUvScale
            : DEFAULTS.ssnNormalUvScale,
        ),
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
  const next = { ...current, ...prefs };
  if (prefs.ssnNormalOffsetXPx !== undefined) {
    next.ssnNormalOffsetXPx = clampSsnOffset(next.ssnNormalOffsetXPx);
  }
  if (prefs.ssnNormalOffsetYPx !== undefined) {
    next.ssnNormalOffsetYPx = clampSsnOffset(next.ssnNormalOffsetYPx);
  }
  if (prefs.ssnNormalUvScale !== undefined) {
    next.ssnNormalUvScale = clampSsnUvScale(next.ssnNormalUvScale);
  }
  _cache = next;
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify(_cache));
  } catch {
    // ignore storage errors
  }
}
