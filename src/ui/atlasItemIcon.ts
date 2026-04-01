/** Atlas JSON helpers for DOM inventory / cursor item icons. */

/** Raw atlas frame entry from `atlas.json` (TexturePacker-style). */
export type AtlasFrameEntry = {
  readonly frame: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
};

export type AtlasJson = {
  readonly frames: Record<string, AtlasFrameEntry>;
  readonly meta: {
    readonly image: string;
    readonly size: { readonly w: number; readonly h: number };
  };
};

export type AtlasIconLayout = {
  atlasImageUrl: string;
  atlasW: number;
  atlasH: number;
  frames: Record<string, AtlasFrameEntry>;
};

/**
 * Returns inline CSS for a div showing one atlas cell scaled to `displayPx` (square).
 */
export function getItemIconStyle(
  textureName: string,
  layout: AtlasIconLayout,
  displayPx: number,
): string {
  const f = layout.frames[textureName];
  if (f === undefined) {
    return "";
  }
  const w = f.frame.w;
  const scale = displayPx / w;
  const bgW = layout.atlasW * scale;
  const bgH = layout.atlasH * scale;
  const px = -f.frame.x * scale;
  const py = -f.frame.y * scale;
  const url = layout.atlasImageUrl.replace(/'/g, "\\'");
  return [
    `background-image:url('${url}')`,
    `background-size:${bgW}px ${bgH}px`,
    `background-position:${px}px ${py}px`,
    "background-repeat:no-repeat",
    "image-rendering:pixelated",
    "image-rendering:crisp-edges",
  ].join(";");
}
