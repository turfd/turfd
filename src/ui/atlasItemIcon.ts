/** DOM inventory / cursor icons: URLs from `block_texture_manifest.json` + `item_texture_manifest.json`. */

import type { ItemDefinition } from "../core/itemDefinition";
import { resolveTextureMapKey } from "../core/textureKeyResolve";

/** Resolved absolute URLs keyed by manifest texture name. */
export type ItemIconUrlLookup = ReadonlyMap<string, string>;

/**
 * Inline CSS for a square icon div (slot sets width/height via `--inv-slot-icon-px`).
 */
export function getItemIconStyleFromUrl(
  imageUrl: string,
  _displayPx: number,
): string {
  const url = imageUrl.replace(/'/g, "\\'");
  return [
    `background-image:url('${url}')`,
    "background-size:contain",
    "background-position:center",
    "background-repeat:no-repeat",
    "image-rendering:pixelated",
    "image-rendering:crisp-edges",
  ].join(";");
}

/** Matches {@link TileDrawBatch} stair shape 0: bottom slab + top-right corner; top-left removed. */
const STAIR_ITEM_ICON_CLIP =
  "polygon(0% 100%, 100% 100%, 100% 0%, 50% 0%, 50% 50%, 0% 50%)";

export function getItemIconStyleForDefinition(
  def: Pick<ItemDefinition, "textureName" | "stairItemIconClip">,
  urlLookup: ItemIconUrlLookup | null,
  displayPx: number,
): string {
  if (urlLookup === null) {
    return "";
  }
  const resolved = resolveTextureMapKey(urlLookup, def.textureName);
  if (resolved === undefined) {
    return "";
  }
  let style = getItemIconStyleFromUrl(resolved, displayPx);
  if (def.stairItemIconClip === true) {
    style += `;clip-path:${STAIR_ITEM_ICON_CLIP};-webkit-clip-path:${STAIR_ITEM_ICON_CLIP}`;
  }
  return style;
}
