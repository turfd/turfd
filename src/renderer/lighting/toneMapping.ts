/**
 * Extended Reinhard tone mapping (luminance-based), equivalent to:
 * `FancyLighting.Utils.ToneMapping` / `ColorUtils.Luma` in C#.
 *
 * Used for reference / CPU paths; the game applies the same math in GLSL
 * ({@link COMPOSITE_FRAGMENT_GLSL}, {@link TonemapFilter}).
 */
export const REINHARD_WHITE_POINT = 1.25;

/** Rec.709 luma (matches typical `ColorUtils.Luma` for linear RGB). */
export function reinhardLuma(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Extended Reinhard: `color *= (1 + luminance / whitePoint²) / (1 + luminance)`.
 */
export function extendedReinhardToneMapRgb(
  r: number,
  g: number,
  b: number,
): [number, number, number] {
  const luminance = reinhardLuma(r, g, b);
  const invWp2 = 1 / (REINHARD_WHITE_POINT * REINHARD_WHITE_POINT);
  const mult = (1 + luminance * invWp2) / (1 + luminance);
  return [r * mult, g * mult, b * mult];
}
