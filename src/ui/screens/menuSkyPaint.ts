/**
 * 2D sky gradient + sun for menu / loading backdrops (matches {@link MenuBackground} daytime look).
 */

const SKY_TOP = 0x74b3ff;
const SKY_HORIZON = 0xa8d8ff;
const SKY_BOTTOM = 0x6a8a9a;
const SKY_WHITE = 0xffffff;

const DAYTIME_LIGHTING = {
  sunIntensity: 0.82,
  sunDir: [0.45, 0.89] as [number, number],
} as const;

function lerpColor(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 0xff;
  const ag = (a >> 8) & 0xff;
  const ab = a & 0xff;
  const br = (b >> 16) & 0xff;
  const bg = (b >> 8) & 0xff;
  const bb = b & 0xff;
  return (
    (Math.round(ar + (br - ar) * t) << 16) |
    (Math.round(ag + (bg - ag) * t) << 8) |
    Math.round(ab + (bb - ab) * t)
  );
}

function hexToCss(hex: number): string {
  return `#${(hex & 0xffffff).toString(16).padStart(6, "0")}`;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Fills the canvas backing store (cw×ch device pixels) with the daytime sky + sun disc.
 */
export function paintMenuSky(
  ctx: CanvasRenderingContext2D,
  cw: number,
  ch: number,
  dpr: number,
): void {
  const sunIntensity = DAYTIME_LIGHTING.sunIntensity;
  const haze = smoothstep(0.34, 0.72, sunIntensity);
  const towardWhite = (c: number, amt: number): number => lerpColor(c, SKY_WHITE, amt * haze);

  const midHigh = lerpColor(SKY_TOP, SKY_HORIZON, 0.35);
  const midLow = lerpColor(SKY_HORIZON, SKY_BOTTOM, 0.45);

  const grd = ctx.createLinearGradient(0, 0, 0, ch);
  grd.addColorStop(0.0, hexToCss(SKY_TOP));
  grd.addColorStop(0.14, hexToCss(lerpColor(SKY_TOP, midHigh, 0.55)));
  grd.addColorStop(0.3, hexToCss(midHigh));
  grd.addColorStop(0.44, hexToCss(towardWhite(midHigh, 0.14)));
  grd.addColorStop(0.52, hexToCss(towardWhite(SKY_HORIZON, 0.36)));
  grd.addColorStop(0.58, hexToCss(towardWhite(SKY_HORIZON, 0.58)));
  grd.addColorStop(0.65, hexToCss(towardWhite(SKY_HORIZON, 0.4)));
  grd.addColorStop(0.75, hexToCss(towardWhite(midLow, 0.22)));
  grd.addColorStop(0.88, hexToCss(midLow));
  grd.addColorStop(1.0, hexToCss(SKY_BOTTOM));
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, cw, ch);

  const sunAlpha = Math.min(1, sunIntensity / 0.65);
  if (sunAlpha > 0.04) {
    const [sx, sy] = DAYTIME_LIGHTING.sunDir;
    const spread = cw * 0.38;
    const baseY = ch * 0.16;
    ctx.beginPath();
    ctx.arc(
      cw * 0.5 + sx * spread,
      baseY - sy * ch * 0.2,
      Math.round(16 * dpr),
      0,
      Math.PI * 2,
    );
    ctx.fillStyle = `rgba(255,243,176,${sunAlpha})`;
    ctx.fill();
  }
}
