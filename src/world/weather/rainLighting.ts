import type { WorldLightingParams } from "../lighting/WorldTime";

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/**
 * 0 = deep night / low sun, 1 = daytime — drives how strongly we pull sky toward overcast grey.
 */
function rainDayBlend(base: WorldLightingParams): number {
  const amb = smoothstep(0.065, 0.34, base.ambient);
  const sun = clamp01(base.sunIntensity / 0.52);
  return clamp01(0.42 * amb + 0.58 * sun);
}

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

function cloneLighting(src: WorldLightingParams): WorldLightingParams {
  return {
    sunDir: [src.sunDir[0], src.sunDir[1]],
    moonDir: [src.moonDir[0], src.moonDir[1]],
    sunIntensity: src.sunIntensity,
    moonIntensity: src.moonIntensity,
    ambient: src.ambient,
    ambientTint: [
      src.ambientTint[0],
      src.ambientTint[1],
      src.ambientTint[2],
    ],
    sunTint: [src.sunTint[0], src.sunTint[1], src.sunTint[2]],
    sky: {
      top: src.sky.top,
      horizon: src.sky.horizon,
      bottom: src.sky.bottom,
    },
    skyLightTint: [
      src.skyLightTint[0],
      src.skyLightTint[1],
      src.skyLightTint[2],
    ],
  };
}

/** Cool overcast reference colors (packed 0xRRGGBB). */
const RAIN_SKY_TOP = 0x4a5560;
const RAIN_SKY_HORIZON = 0x6a7580;
const RAIN_SKY_BOTTOM = 0x3a4248;

/**
 * @param strength — 0 = no change, 1 = full rain overcast.
 */
export function applyRainLightingTint(
  base: WorldLightingParams,
  strength: number,
): WorldLightingParams {
  if (strength <= 0) {
    return base;
  }
  const t = Math.min(1, Math.max(0, strength));
  const day = rainDayBlend(base);
  /** Sky: strong grey overcast by day; at night stay near world-time sky (only a hint of rain). */
  const skyPull = t * (0.14 + 0.74 * day);
  const out = cloneLighting(base);
  out.sky.top = lerpColor(base.sky.top, RAIN_SKY_TOP, skyPull);
  out.sky.horizon = lerpColor(base.sky.horizon, RAIN_SKY_HORIZON, skyPull);
  out.sky.bottom = lerpColor(base.sky.bottom, RAIN_SKY_BOTTOM, skyPull * 0.95);
  /** Sun/ambient: ease off dampening when the sun is already down so night + rain stays dark. */
  out.sunIntensity *= 1 - t * (0.38 * day);
  out.moonIntensity *= 1 - t * (0.06 + 0.12 * (1 - day));
  out.ambient *= 1 - t * (0.1 + 0.14 * day);
  const slMul = t * (0.04 + 0.1 * day);
  out.skyLightTint[0] *= 1 - slMul;
  out.skyLightTint[1] *= 1 - slMul * 0.55;
  out.skyLightTint[2] *= 1 - slMul * 0.35;
  return out;
}
