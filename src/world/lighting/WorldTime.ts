/** Authoritative world clock (host); smooth day/night lighting (sync in later steps). */
import {
  DAWN_LENGTH_MS,
  DAYLIGHT_LENGTH_MS,
  DAY_LENGTH_MS,
  DUSK_LENGTH_MS,
} from "../../core/constants";

/** Maximum correction per tick when syncing to authoritative time (ms). */
const SYNC_MAX_STEP_MS = 500;

/** If client clock differs from authoritative by more than this, snap instantly (ms). */
const SYNC_SNAP_THRESHOLD_MS = 3000;

const SUN_DIRECT_MAX = 0.8;
const MOON_DIRECT_MAX = 0.25;

/** Night ambient matches previous sinusoidal midnight floor (~0.05). */
const NIGHT_AMBIENT = 0.05;

function wrapMs(ms: number): number {
  return ((ms % DAY_LENGTH_MS) + DAY_LENGTH_MS) % DAY_LENGTH_MS;
}

function clamp01(t: number): number {
  return Math.min(1, Math.max(0, t));
}

function smoothstep01(t: number): number {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerp3(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  t: number,
): [number, number, number] {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

/** Linear blend between two packed 0xRRGGBB colors. */
function lerpColor(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 0xff;
  const ag = (a >> 8) & 0xff;
  const ab = a & 0xff;
  const br = (b >> 16) & 0xff;
  const bg = (b >> 8) & 0xff;
  const bb = b & 0xff;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
}

/** Midpoint of two packed 0xRRGGBB colors. Used to derive the horizon band from top/bottom. */
function midColor(a: number, b: number): number {
  return lerpColor(a, b, 0.5);
}

/** Sample a closed [0,1) cycle; `keys` must be sorted ascending by `u`. */
function sampleOpen1DSorted(
  t: number,
  keys: readonly { readonly u: number; readonly v: number }[],
): number {
  const t0 = clamp01(t);
  if (keys.length === 0) {
    return 0;
  }
  for (let i = 0; i < keys.length; i++) {
    const a = keys[i]!;
    const next = keys[i + 1];
    const b =
      next !== undefined ? next : { u: 1, v: keys[0]!.v };
    if (t0 >= a.u && t0 < b.u) {
      const span = b.u - a.u;
      const localT = span > 1e-8 ? (t0 - a.u) / span : 0;
      const s = smoothstep01(localT);
      return lerp(a.v, b.v, s);
    }
  }
  return keys[0]!.v;
}

/** Vertical sky gradient (packed 0xRRGGBB), top → horizon → bottom of screen. */
export type SkyPalette = {
  top: number;
  horizon: number;
  bottom: number;
};

function sampleOpen3Sorted(
  t: number,
  keys: readonly {
    readonly u: number;
    readonly c: readonly [number, number, number];
  }[],
): [number, number, number] {
  const t0 = clamp01(t);
  if (keys.length === 0) {
    return [1, 1, 1];
  }
  for (let i = 0; i < keys.length; i++) {
    const a = keys[i]!;
    const next = keys[i + 1];
    const b =
      next !== undefined ? next : { u: 1, c: keys[0]!.c };
    if (t0 >= a.u && t0 < b.u) {
      const span = b.u - a.u;
      const localT = span > 1e-8 ? (t0 - a.u) / span : 0;
      const s = smoothstep01(localT);
      return lerp3(a.c, b.c, s);
    }
  }
  const c0 = keys[0]!.c;
  return [c0[0], c0[1], c0[2]];
}

/** Like {@link sampleOpen1DSorted} but interpolates packed 0xRRGGBB per-channel. */
function sampleOpenColorSorted(
  t: number,
  keys: readonly { readonly u: number; readonly v: number }[],
): number {
  const t0 = clamp01(t);
  if (keys.length === 0) {
    return 0;
  }
  for (let i = 0; i < keys.length; i++) {
    const a = keys[i]!;
    const next = keys[i + 1];
    const b =
      next !== undefined ? next : { u: 1, v: keys[0]!.v };
    if (t0 >= a.u && t0 < b.u) {
      const span = b.u - a.u;
      const localT = span > 1e-8 ? (t0 - a.u) / span : 0;
      const s = smoothstep01(localT);
      return lerpColor(a.v, b.v, s);
    }
  }
  return keys[0]!.v;
}

function sampleOpenSkySorted(
  t: number,
  tops: readonly { readonly u: number; readonly v: number }[],
  horizons: readonly { readonly u: number; readonly v: number }[],
  bottoms: readonly { readonly u: number; readonly v: number }[],
): SkyPalette {
  return {
    top: sampleOpenColorSorted(t, tops),
    horizon: sampleOpenColorSorted(t, horizons),
    bottom: sampleOpenColorSorted(t, bottoms),
  };
}

/**
 * Phase palettes — `top` is the zenith (screen top), `bottom` is the ground-facing
 * end of the gradient (screen bottom). `horizon` is the midpoint; the sky paint
 * interpolates linearly between top → horizon → bottom.
 */
const SKY_SUNRISE = {
  top: 0x5878c7,
  bottom: 0x9390c7,
  horizon: midColor(0x5878c7, 0x9390c7),
} as const;

const SKY_NOON = {
  top: 0x5596ff,
  bottom: 0x89c4ff,
  horizon: midColor(0x5596ff, 0x89c4ff),
} as const;

const SKY_SUNSET = {
  top: 0x5b4460,
  bottom: 0xea4463,
  horizon: midColor(0x5b4460, 0xea4463),
} as const;

const SKY_NIGHT = {
  top: 0x060317,
  bottom: 0x100838,
  horizon: midColor(0x060317, 0x100838),
} as const;

const SKY_LIGHT_NIGHT: [number, number, number] = [0.78, 0.82, 1.0];
const SKY_LIGHT_DAY: [number, number, number] = [0.96, 1.0, 1.04];
const SKY_LIGHT_WARM: [number, number, number] = [1.02, 0.96, 0.9];

const TINT_SUNRISE_SUN: [number, number, number] = [1.0, 0.88, 0.52];
const TINT_DAY_START_SUN: [number, number, number] = [1.0, 0.97, 0.88];
const TINT_NOON_SUN: [number, number, number] = [1.0, 1.0, 1.0];
const TINT_DAY_END_SUN: [number, number, number] = [1.0, 0.96, 0.88];
const TINT_SUNSET_SUN: [number, number, number] = [1.0, 0.38, 0.18];
const TINT_NEUTRAL: [number, number, number] = [1.0, 1.0, 1.0];

const TINT_DAWN_AMBIENT: [number, number, number] = [1.0, 0.96, 0.88];

/** Normalised segment boundaries (fraction of full cycle). */
const U_DAWN_END = DAWN_LENGTH_MS / DAY_LENGTH_MS;
const U_DAY_END = (DAWN_LENGTH_MS + DAYLIGHT_LENGTH_MS) / DAY_LENGTH_MS;
const U_DUSK_END =
  (DAWN_LENGTH_MS + DAYLIGHT_LENGTH_MS + DUSK_LENGTH_MS) / DAY_LENGTH_MS;
const U_NOON =
  (DAWN_LENGTH_MS + DAYLIGHT_LENGTH_MS * 0.5) / DAY_LENGTH_MS;
/** Sky holds peak noon from shortly after dawn through late afternoon. */
const U_DAY_SKY_BLUE_START = U_DAWN_END + 0.055;
const U_DAY_SKY_BLUE_END = U_DAY_END - 0.055;

const NIGHT_LEN_MS =
  DAY_LENGTH_MS - DAWN_LENGTH_MS - DAYLIGHT_LENGTH_MS - DUSK_LENGTH_MS;
/** Mid-night within the night segment (~0.825 of cycle). */
const U_MIDNIGHT = U_DUSK_END + (NIGHT_LEN_MS * 0.5) / DAY_LENGTH_MS;
/** Ease from sunset palette into night. */
const U_NIGHT_EARLY = U_DUSK_END + (U_MIDNIGHT - U_DUSK_END) * 0.45;

const U_SUN_TINT_NEUTRAL_BLEND =
  U_DUSK_END + (U_MIDNIGHT - U_DUSK_END) * 0.5;

const SKY_LIGHT_NOON: [number, number, number] = [1.0, 1.0, 1.0];

const AMBIENT_TINT_DUSK: [number, number, number] = [1.0, 0.97, 0.92];

/** Pre-sorted by `u` (ascending) for {@link sampleOpen1DSorted}. */
const LIGHTING_SUN_KEYS = [
  { u: 0, v: 0.06 },
  { u: U_DAWN_END * 0.55, v: 0.22 },
  { u: U_DAWN_END, v: 0.42 },
  { u: U_NOON, v: 1.0 },
  { u: U_DAY_END, v: 0.42 },
  { u: U_DUSK_END, v: 0.04 },
  { u: U_MIDNIGHT, v: 0 },
  { u: 0.94, v: 0 },
] as const;

const LIGHTING_MOON_KEYS = [
  { u: 0, v: 0.88 },
  { u: U_DAWN_END * 0.55, v: 0.55 },
  { u: U_DAWN_END, v: 0.32 },
  { u: U_NOON, v: 0 },
  { u: U_DAY_END, v: 0.32 },
  { u: U_DUSK_END, v: 0.88 },
  { u: U_MIDNIGHT, v: 1.0 },
  { u: 0.94, v: 1.0 },
] as const;

const LIGHTING_AMBIENT_KEYS = [
  { u: 0, v: 0.08 },
  { u: U_DAWN_END * 0.55, v: 0.22 },
  { u: U_DAWN_END, v: 0.38 },
  { u: U_NOON, v: 1.0 },
  { u: U_DAY_END, v: 0.38 },
  { u: U_DUSK_END, v: 0.06 },
  { u: U_MIDNIGHT, v: NIGHT_AMBIENT },
  { u: 0.94, v: NIGHT_AMBIENT },
] as const;

const LIGHTING_SUN_TINT_KEYS = [
  { u: 0, c: TINT_SUNRISE_SUN },
  { u: U_DAWN_END, c: TINT_DAY_START_SUN },
  { u: U_NOON, c: TINT_NOON_SUN },
  { u: U_DAY_END, c: TINT_DAY_END_SUN },
  { u: U_DUSK_END, c: TINT_SUNSET_SUN },
  { u: U_SUN_TINT_NEUTRAL_BLEND, c: TINT_NEUTRAL },
  { u: U_MIDNIGHT, c: TINT_NEUTRAL },
  { u: 0.94, c: TINT_NEUTRAL },
] as const;

const LIGHTING_AMBIENT_TINT_KEYS = [
  { u: 0, c: TINT_DAWN_AMBIENT },
  { u: U_DAWN_END, c: TINT_NEUTRAL },
  { u: U_NOON, c: TINT_NEUTRAL },
  { u: U_DUSK_END, c: AMBIENT_TINT_DUSK },
  { u: U_MIDNIGHT, c: TINT_NEUTRAL },
  { u: 0.94, c: TINT_NEUTRAL },
] as const;

const LIGHTING_SKY_LIGHT_KEYS = [
  { u: 0, c: SKY_LIGHT_WARM },
  { u: U_DAWN_END, c: SKY_LIGHT_DAY },
  { u: U_NOON, c: SKY_LIGHT_NOON },
  { u: U_DAY_END, c: SKY_LIGHT_DAY },
  { u: U_DUSK_END, c: SKY_LIGHT_WARM },
  { u: U_MIDNIGHT, c: SKY_LIGHT_NIGHT },
  { u: 0.94, c: SKY_LIGHT_NIGHT },
] as const;

/**
 * Sky gradient keyframes — one table each for zenith (top), midband (horizon),
 * and ground (bottom). Each phase (sunrise / noon / sunset / night) is anchored
 * at a single `u` and smoothly interpolated between them. `u = 0` is the moment
 * the sun crosses the eastern horizon (start of dawn = sunrise) and the cycle
 * wraps back to that key at `u = 1`.
 */
const LIGHTING_SKY_TOP_KEYS = [
  { u: 0, v: SKY_SUNRISE.top },
  { u: U_DAY_SKY_BLUE_START, v: SKY_NOON.top },
  { u: U_NOON, v: SKY_NOON.top },
  { u: U_DAY_SKY_BLUE_END, v: SKY_NOON.top },
  { u: U_DUSK_END, v: SKY_SUNSET.top },
  { u: U_NIGHT_EARLY, v: SKY_NIGHT.top },
  { u: U_MIDNIGHT, v: SKY_NIGHT.top },
  { u: 0.94, v: SKY_NIGHT.top },
] as const;

const LIGHTING_SKY_HORIZON_KEYS = [
  { u: 0, v: SKY_SUNRISE.horizon },
  { u: U_DAY_SKY_BLUE_START, v: SKY_NOON.horizon },
  { u: U_NOON, v: SKY_NOON.horizon },
  { u: U_DAY_SKY_BLUE_END, v: SKY_NOON.horizon },
  { u: U_DUSK_END, v: SKY_SUNSET.horizon },
  { u: U_NIGHT_EARLY, v: SKY_NIGHT.horizon },
  { u: U_MIDNIGHT, v: SKY_NIGHT.horizon },
  { u: 0.94, v: SKY_NIGHT.horizon },
] as const;

const LIGHTING_SKY_BOTTOM_KEYS = [
  { u: 0, v: SKY_SUNRISE.bottom },
  { u: U_DAY_SKY_BLUE_START, v: SKY_NOON.bottom },
  { u: U_NOON, v: SKY_NOON.bottom },
  { u: U_DAY_SKY_BLUE_END, v: SKY_NOON.bottom },
  { u: U_DUSK_END, v: SKY_SUNSET.bottom },
  { u: U_NIGHT_EARLY, v: SKY_NIGHT.bottom },
  { u: U_MIDNIGHT, v: SKY_NIGHT.bottom },
  { u: 0.94, v: SKY_NIGHT.bottom },
] as const;

export type WorldLightingParams = {
  sunDir: [number, number];
  moonDir: [number, number];
  sunIntensity: number;
  moonIntensity: number;
  ambient: number;
  ambientTint: [number, number, number];
  sunTint: [number, number, number];
  sky: SkyPalette;
  /** Multiplies scene ambient for hemispheric sky bounce (subtle, ~0.75–1.05). */
  skyLightTint: [number, number, number];
};

export class WorldTime {
  private _ms: number;
  /** `NaN` invalidates; otherwise matches `_ms` when `_lightingCache` is valid. */
  private _lightingCacheMs = NaN;
  private readonly _lightingCache: WorldLightingParams = {
    sunDir: [0, 0],
    moonDir: [0, 0],
    sunIntensity: 0,
    moonIntensity: 0,
    ambient: 0,
    ambientTint: [1, 1, 1],
    sunTint: [1, 1, 1],
    sky: { top: 0, horizon: 0, bottom: 0 },
    skyLightTint: [1, 1, 1],
  };

  /**
   * @param initialMs — wrapped into [0, DAY_LENGTH_MS). Default 0 = start of dawn (sunrise).
   */
  constructor(initialMs: number = 0) {
    this._ms = wrapMs(initialMs);
  }

  /** Advance time by dt milliseconds (call from game loop, host only). */
  tick(dt: number): void {
    this._ms = wrapMs(this._ms + dt);
  }

  /**
   * CLIENT ONLY. Smoothly correct local time toward authoritative value.
   */
  sync(authoritativeMs: number): void {
    const auth = wrapMs(authoritativeMs);
    const diff = auth - this._ms;

    const halfDay = DAY_LENGTH_MS / 2;
    const normDiff =
      ((((diff + halfDay) % DAY_LENGTH_MS) + DAY_LENGTH_MS) % DAY_LENGTH_MS) -
      halfDay;

    if (Math.abs(normDiff) > SYNC_SNAP_THRESHOLD_MS) {
      this._ms = auth;
      return;
    }

    const step =
      Math.sign(normDiff) *
      Math.min(Math.abs(normDiff), SYNC_MAX_STEP_MS);
    this._ms = wrapMs(this._ms + step);
  }

  /** Snap time (pause-menu slider, host commands). Wrapped to one day. */
  setMs(ms: number): void {
    this._ms = wrapMs(ms);
  }

  /** Current world time in milliseconds [0, DAY_LENGTH_MS). */
  get ms(): number {
    return this._ms;
  }

  /**
   * Normalised time of day [0, 1).
   * 0 = start of dawn (sunrise); wraps after full cycle.
   */
  get phase(): number {
    return this._ms / DAY_LENGTH_MS;
  }

  /** @deprecated Prefer {@link getLightingParams} for rendering. */
  get ambientLight(): number {
    return this.getLightingParams().ambient;
  }

  getLightingParams(): WorldLightingParams {
    if (this._ms === this._lightingCacheMs) {
      return this._lightingCache;
    }

    const t = this._ms / DAY_LENGTH_MS;
    const sunAngle = t * Math.PI * 2 + Math.PI / 2;
    const out = this._lightingCache;
    out.sunDir[0] = Math.cos(sunAngle - Math.PI / 2);
    out.sunDir[1] = Math.sin(sunAngle - Math.PI / 2);
    /** Opposite angular velocity vs sun; offset so disc starts opposite the sun at t = 0. */
    const moonAngle = -t * Math.PI * 2 + (3 * Math.PI) / 2;
    out.moonDir[0] = Math.cos(moonAngle - Math.PI / 2);
    out.moonDir[1] = Math.sin(moonAngle - Math.PI / 2);

    const sunElevation = sampleOpen1DSorted(t, LIGHTING_SUN_KEYS);
    const moonElevation = sampleOpen1DSorted(t, LIGHTING_MOON_KEYS);
    out.sunIntensity = sunElevation * SUN_DIRECT_MAX;
    out.moonIntensity = moonElevation * MOON_DIRECT_MAX;
    out.ambient = sampleOpen1DSorted(t, LIGHTING_AMBIENT_KEYS);

    const sunTint = sampleOpen3Sorted(t, LIGHTING_SUN_TINT_KEYS);
    out.sunTint[0] = sunTint[0];
    out.sunTint[1] = sunTint[1];
    out.sunTint[2] = sunTint[2];

    const ambientTint = sampleOpen3Sorted(t, LIGHTING_AMBIENT_TINT_KEYS);
    out.ambientTint[0] = ambientTint[0];
    out.ambientTint[1] = ambientTint[1];
    out.ambientTint[2] = ambientTint[2];

    const skyLightTint = sampleOpen3Sorted(t, LIGHTING_SKY_LIGHT_KEYS);
    out.skyLightTint[0] = skyLightTint[0];
    out.skyLightTint[1] = skyLightTint[1];
    out.skyLightTint[2] = skyLightTint[2];

    const sky = sampleOpenSkySorted(
      t,
      LIGHTING_SKY_TOP_KEYS,
      LIGHTING_SKY_HORIZON_KEYS,
      LIGHTING_SKY_BOTTOM_KEYS,
    );
    out.sky.top = sky.top;
    out.sky.horizon = sky.horizon;
    out.sky.bottom = sky.bottom;

    this._lightingCacheMs = this._ms;
    return out;
  }

  /** Serialise for save/sync. */
  toJSON(): number {
    return this._ms;
  }
}
