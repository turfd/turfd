/** Bedrock-style split: block terrain textures vs item textures (separate JSON manifests). */

import type { ItemRegistry } from "../items/ItemRegistry";

export const BLOCK_TEXTURE_MANIFEST_PATH =
  "assets/textures/block_texture_manifest.json";
export const ITEM_TEXTURE_MANIFEST_PATH =
  "assets/textures/item_texture_manifest.json";

export type TextureManifestJson = {
  readonly textures: Record<string, string>;
  /**
   * Texture **names** (keys in `textures`) that may have optional `name_alt_1.png`, `name_alt_2.png`, …
   * next to the base file. Omitted or empty → no alt probing (most tiles have no variants).
   */
  readonly probe_texture_alts?: readonly string[];
};

export async function fetchTextureManifestJson(
  manifestRelativePath: string,
): Promise<TextureManifestJson> {
  const base = import.meta.env.BASE_URL;
  const trimmed = manifestRelativePath.replace(/^\/+/, "");
  const jsonUrl = `${base}${trimmed}`;
  const res = await fetch(jsonUrl);
  if (!res.ok) {
    throw new Error(`Texture manifest failed to load: ${jsonUrl} (${res.status})`);
  }
  const manifest = (await res.json()) as TextureManifestJson;
  if (manifest.textures === null || typeof manifest.textures !== "object") {
    throw new Error(`Invalid manifest: ${jsonUrl}`);
  }
  return manifest;
}

/**
 * One packed rect per distinct {@link ItemDefinition.textureName}, resolving path from
 * item manifest first, then block manifest (block items reuse terrain PNGs).
 */
export function resolveItemTextureRecord(
  itemRegistry: ItemRegistry,
  blockTextures: Record<string, string>,
  itemTextures: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const def of itemRegistry.all()) {
    const k = def.textureName;
    const p = itemTextures[k] ?? blockTextures[k];
    if (typeof p !== "string" || p.length === 0) {
      throw new Error(
        `No texture path for item '${def.key}' (textureName "${k}"). ` +
          `Add it to item_texture_manifest.json or block_texture_manifest.json.`,
      );
    }
    out[k] = p;
  }
  return out;
}

/** Absolute URLs for inventory/cursor icons (item manifest overrides block for the same key). */
export async function fetchItemIconUrlMapForRegistry(
  itemRegistry: ItemRegistry,
): Promise<Readonly<Record<string, string>>> {
  const [blockDoc, itemDoc] = await Promise.all([
    fetchTextureManifestJson(BLOCK_TEXTURE_MANIFEST_PATH),
    fetchTextureManifestJson(ITEM_TEXTURE_MANIFEST_PATH),
  ]);
  const block = blockDoc.textures;
  const item = itemDoc.textures;
  const baseForResolve = new URL(import.meta.env.BASE_URL, window.location.href);
  const out: Record<string, string> = {};
  for (const def of itemRegistry.all()) {
    const k = def.textureName;
    const rel = item[k] ?? block[k];
    if (typeof rel !== "string" || rel.length === 0) {
      throw new Error(
        `No texture path for item '${def.key}' (textureName "${k}") for UI icons.`,
      );
    }
    out[k] = new URL(rel.replace(/^\/+/, ""), baseForResolve).href;
  }
  return out;
}
