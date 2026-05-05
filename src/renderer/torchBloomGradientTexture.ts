import { Texture } from "pixi.js";

let cached: Texture | null = null;

/**
 * Shared soft radial gradient (warm center → transparent edge) for additive torch glow
 * drawn in world space on {@link RenderPipeline.layerTilesBack} (placed torches) and on the
 * held-item sprite (player torch), replacing fullscreen composite torch bloom so depth sorts
 * with the scene.
 */
export function getTorchBloomGradientTexture(): Texture {
  if (cached !== null) {
    return cached;
  }
  const size = 64;
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const g = c.getContext("2d");
  if (g === null) {
    cached = Texture.WHITE;
    return cached;
  }
  const cx = size * 0.5;
  const cy = size * 0.5;
  const grd = g.createRadialGradient(cx, cy, 0, cx, cy, cx * 0.98);
  grd.addColorStop(0, "rgba(255, 248, 220, 0.72)");
  grd.addColorStop(0.28, "rgba(255, 210, 150, 0.35)");
  grd.addColorStop(0.55, "rgba(255, 180, 110, 0.12)");
  grd.addColorStop(1, "rgba(255, 160, 90, 0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  const tex = Texture.from(c);
  tex.source.scaleMode = "linear";
  cached = tex;
  return tex;
}
