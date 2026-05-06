/**
 * Skins tab preview: 2D canvas walk cycle — solid black outline, then inner donor color
 * ramping to transparent midway toward the black edge, then the sprite on top.
 * Avoids a second Pixi/WebGL app so switching skins cannot corrupt the menu backdrop batcher.
 */

import { PLAYER_BODY_REQUIRED_FRAME_COUNT } from "../core/constants";

/** Neighbor steps in **source pixels**; full offset 1 matches the black outline thickness. */
const OUTLINE_OFFSETS: readonly [number, number][] = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
  [-1, -1],
  [-1, 1],
  [1, -1],
  [1, 1],
];

/** Custom tint fades from full alpha at the sprite edge to transparent at this fraction of the way toward the black rim (1 = full outline depth). */
const COLOR_GRADIENT_EXTENT = 0.5;

/**
 * Supersample factor for the color fringe only: many subpixels + bilinear downscale removes stepped bands.
 * Black rim stays 1× on the main canvas for a crisp outer line.
 */
const COLOR_FRINGE_SS = 4;

/** Stamps per direction on the supersampled fringe canvas (higher = smoother falloff). */
const COLOR_GRADIENT_STEPS = 64;

const BLACK_OUTLINE = "#000000";

/** Hermite smoothstep for alpha (softer than linear at the tail). */
function smoothstep01(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

function hexToCss(hex: string): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  return m !== null ? `#${m[1]!}` : "#c0c7d1";
}

export type SkinMenuPreviewController = {
  updateOutlineColorHex(hex: string): void;
  destroy(): void;
};

/**
 * Mounts a canvas into `host`. No WebGL — safe alongside {@link MenuBackground} Pixi.
 */
export async function mountSkinMenuPreviewWithOutline(
  host: HTMLElement,
  image: HTMLImageElement,
  outlineHex: string,
): Promise<SkinMenuPreviewController | null> {
  host.replaceChildren();
  host.style.position = "relative";
  host.style.width = "100%";
  host.style.height = "100%";
  host.style.minHeight = "0";
  host.style.flex = "1 1 auto";
  host.style.minWidth = "0";
  host.style.overflow = "hidden";

  if (!image.complete || image.naturalWidth === 0) {
    await new Promise<void>((resolve) => {
      image.addEventListener("load", () => resolve(), { once: true });
      image.addEventListener("error", () => resolve(), { once: true });
    });
  }

  const frameW = Math.floor(image.naturalWidth / PLAYER_BODY_REQUIRED_FRAME_COUNT);
  const frameH = image.naturalHeight;
  if (frameW <= 1 || frameH <= 1) {
    return null;
  }

  const canvas = document.createElement("canvas");
  canvas.style.display = "block";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  /** Smooth scaling so the antialiased color fringe survives CSS stretch; body still drawn with smoothing disabled. */
  canvas.style.imageRendering = "auto";
  const ctx = canvas.getContext("2d", { alpha: true });
  if (ctx === null) {
    return null;
  }

  const tintCanvas = document.createElement("canvas");
  tintCanvas.width = frameW;
  tintCanvas.height = frameH;
  const tctx = tintCanvas.getContext("2d", { alpha: true });
  if (tctx === null) {
    return null;
  }

  /** Source-padding in pixels (matches 1-step outline margin on each side). */
  const fringePadSrc = 2;
  const gradCanvas = document.createElement("canvas");
  const gW = (frameW + fringePadSrc * 2) * COLOR_FRINGE_SS;
  const gH = (frameH + fringePadSrc * 2) * COLOR_FRINGE_SS;
  gradCanvas.width = gW;
  gradCanvas.height = gH;
  const gctx = gradCanvas.getContext("2d", { alpha: true });
  if (gctx === null) {
    return null;
  }

  host.appendChild(canvas);

  let outlineActive = outlineHex.trim() !== "";
  let outlineCss = hexToCss(outlineHex);
  let frameIdx = 0;
  let lastCssW = -1;
  let lastCssH = -1;

  const fitCanvasToHost = (): { cssW: number; cssH: number } => {
    const cssW = Math.max(1, Math.floor(host.clientWidth));
    const cssH = Math.max(1, Math.floor(host.clientHeight));
    if (cssW !== lastCssW || cssH !== lastCssH) {
      lastCssW = cssW;
      lastCssH = cssH;
      const dpr = Math.min(2, typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1);
      canvas.width = Math.max(1, Math.floor(cssW * dpr));
      canvas.height = Math.max(1, Math.floor(cssH * dpr));
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    return { cssW, cssH };
  };

  const paint = (): void => {
    const { cssW, cssH } = fitCanvasToHost();
    ctx.clearRect(0, 0, cssW, cssH);

    const pad = 28;
    const sxFit = Math.min((cssW - pad) / frameW, (cssH - pad) / frameH);
    const s = Math.max(0.5, Math.min(sxFit, 10));
    const ox = cssW * 0.5;
    const oy = cssH - 8;

    const col = frameIdx + 1;
    const srcX = col * frameW;
    const dw = frameW * s;
    const dh = frameH * s;
    const left = ox - dw / 2;
    const top = oy - dh;

    ctx.imageSmoothingEnabled = false;
    tctx.imageSmoothingEnabled = false;

    const stampTintedOn = (
      target: CanvasRenderingContext2D,
      fill: string,
      destX: number,
      destY: number,
      destW: number,
      destH: number,
      alpha: number,
    ): void => {
      tctx.clearRect(0, 0, frameW, frameH);
      tctx.globalCompositeOperation = "source-over";
      tctx.drawImage(image, srcX, 0, frameW, frameH, 0, 0, frameW, frameH);
      tctx.globalCompositeOperation = "source-in";
      tctx.fillStyle = fill;
      tctx.fillRect(0, 0, frameW, frameH);
      tctx.globalCompositeOperation = "source-over";
      target.globalAlpha = alpha;
      target.drawImage(tintCanvas, 0, 0, frameW, frameH, destX, destY, destW, destH);
      target.globalAlpha = 1;
    };

    if (outlineActive) {
      // 1) Solid black rim (full outline depth), crisp.
      for (const [dx, dy] of OUTLINE_OFFSETS) {
        stampTintedOn(ctx, BLACK_OUTLINE, left + dx * s, top + dy * s, dw, dh, 1);
      }

      // 2) Custom color fringe: built supersampled, then smoothed onto main (smooth fade, no stair-steps).
      gctx.clearRect(0, 0, gW, gH);
      gctx.imageSmoothingEnabled = false;
      const ox0 = fringePadSrc * COLOR_FRINGE_SS;
      const oy0 = fringePadSrc * COLOR_FRINGE_SS;
      const dwp = frameW * COLOR_FRINGE_SS;
      const dhp = frameH * COLOR_FRINGE_SS;

      for (const [dx, dy] of OUTLINE_OFFSETS) {
        for (let i = 1; i <= COLOR_GRADIENT_STEPS; i++) {
          const t = (i / COLOR_GRADIENT_STEPS) * COLOR_GRADIENT_EXTENT;
          const u = t / COLOR_GRADIENT_EXTENT;
          const alpha = 1 - smoothstep01(u);
          if (alpha <= 0.002) {
            continue;
          }
          const px = dx * t * COLOR_FRINGE_SS;
          const py = dy * t * COLOR_FRINGE_SS;
          stampTintedOn(gctx, outlineCss, ox0 + px, oy0 + py, dwp, dhp, alpha);
        }
      }

      const fringeDestW = (frameW + fringePadSrc * 2) * s;
      const fringeDestH = (frameH + fringePadSrc * 2) * s;
      const fringeLeft = left - fringePadSrc * s;
      const fringeTop = top - fringePadSrc * s;
      ctx.save();
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(gradCanvas, 0, 0, gW, gH, fringeLeft, fringeTop, fringeDestW, fringeDestH);
      ctx.restore();

      ctx.imageSmoothingEnabled = false;
    }
    ctx.drawImage(image, srcX, 0, frameW, frameH, left, top, dw, dh);
  };

  paint();
  requestAnimationFrame(() => {
    paint();
  });

  const ro = new ResizeObserver(() => {
    paint();
  });
  ro.observe(host);

  const timer = window.setInterval(() => {
    frameIdx = (frameIdx + 1) % 4;
    paint();
  }, 180);

  let cleaned = false;
  return {
    updateOutlineColorHex(hex: string): void {
      if (cleaned) return;
      outlineActive = hex.trim() !== "";
      outlineCss = hexToCss(hex);
      paint();
    },
    destroy(): void {
      cleaned = true;
      window.clearInterval(timer);
      ro.disconnect();
      host.replaceChildren();
    },
  };
}
