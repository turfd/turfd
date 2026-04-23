/**
 * 2D sky gradient + sun for menu / loading backdrops (matches {@link MenuBackground} daytime look).
 */

/**
 * Noon palette — must match {@link SKY_NOON} in WorldTime.ts so the menu backdrop
 * reads as "daytime sky" using the same two hex codes that drive the in-game sky
 * gradient at peak sun.
 */
export const MENU_SKY_TOP = 0x5596ff;
export const MENU_SKY_BOTTOM = 0x89c4ff;
export const MENU_SKY_HORIZON = lerpColor(MENU_SKY_TOP, MENU_SKY_BOTTOM, 0.5);

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

/**
 * Fills the canvas backing store (cw×ch device pixels) with the daytime sky + sun disc.
 * Clean two-stop gradient (top → bottom) through the midpoint, matching the in-game
 * sky paint in {@link RenderPipeline.paintSkyCss}.
 */
export function paintMenuSky(
  ctx: CanvasRenderingContext2D,
  cw: number,
  ch: number,
  dpr: number,
): void {
  const sunIntensity = DAYTIME_LIGHTING.sunIntensity;

  const grd = ctx.createLinearGradient(0, 0, 0, ch);
  grd.addColorStop(0, hexToCss(MENU_SKY_TOP));
  grd.addColorStop(0.5, hexToCss(MENU_SKY_HORIZON));
  grd.addColorStop(1, hexToCss(MENU_SKY_BOTTOM));
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

/**
 * CSS gradient under the menu sky canvas (canvas is transparent until first paint / while WebGL loads).
 * Keep all three stops aligned with {@link paintMenuSky}.
 */
export const MENU_SKY_FALLBACK_GRADIENT =
  `linear-gradient(180deg, ${hexToCss(MENU_SKY_TOP)} 0%, ${hexToCss(MENU_SKY_HORIZON)} 50%, ${hexToCss(MENU_SKY_BOTTOM)} 100%)`;

const MENU_BACKDROP_CLASS = "stratum-menu-backdrop";

/**
 * Paints the menu sky into a canvas sized to `mount` (or viewport fallback).
 * Shared by {@link MenuBackground} and {@link mountEarlyMenuBackdrop}.
 */
export function paintMenuSkyToFit(
  canvas: HTMLCanvasElement,
  mount: HTMLElement,
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const dpr = window.devicePixelRatio || 1;
  const mw = mount.clientWidth || window.innerWidth || 1;
  const mh = mount.clientHeight || window.innerHeight || 1;
  const cw = Math.max(1, Math.round(mw * dpr));
  const ch = Math.max(1, Math.round(mh * dpr));
  canvas.width = cw;
  canvas.height = ch;
  paintMenuSky(ctx, cw, ch, dpr);
}

/**
 * Inserts the same sky stack as {@link MenuBackground} (CSS gradient + 2D canvas)
 * under future siblings, without Pixi. Call synchronously before heavy async bootstrap
 * so the menu backdrop appears while IndexedDB / mods init.
 */
export function mountEarlyMenuBackdrop(mount: HTMLElement): void {
  if (mount.querySelector(`:scope > .${MENU_BACKDROP_CLASS}`)) return;

  const backdropRoot = document.createElement("div");
  backdropRoot.className = MENU_BACKDROP_CLASS;
  backdropRoot.style.cssText =
    "position:absolute;inset:0;z-index:0;pointer-events:none;overflow:hidden;" +
    `background:${MENU_SKY_FALLBACK_GRADIENT};`;

  const skyCanvas = document.createElement("canvas");
  skyCanvas.style.cssText =
    "position:absolute;inset:0;width:100%;height:100%;z-index:0;pointer-events:none;";
  backdropRoot.appendChild(skyCanvas);

  if (mount.firstChild) {
    mount.insertBefore(backdropRoot, mount.firstChild);
  } else {
    mount.appendChild(backdropRoot);
  }

  paintMenuSkyToFit(skyCanvas, mount);
}
