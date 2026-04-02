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

export function getItemIconStyleForDefinition(
  def: Pick<ItemDefinition, "textureName">,
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
  return getItemIconStyleFromUrl(resolved, displayPx);
}
