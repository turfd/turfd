/**
 * Built-in packs under `assets/mods/behavior_packs/` and `assets/mods/resource_packs/`
 * (Minecraft Bedrock–style layout). Each pack is a folder with `manifest.json` at its root.
 * Core terrain/item atlases load from `resource_packs/stratum-core/textures/` (see textureManifest.ts).
 */
import { z } from "zod";

export const BehaviorPackManifestSchema = z
  .object({
    format_version: z.literal("1.1.0"),
    pack_type: z.literal("behavior_pack"),
    id: z.string().min(1),
    version: z.string().min(1),
    name: z.string().min(1),
    description: z.string().default(""),
    uuid: z.string().uuid().optional(),
    blocks: z.array(z.string()),
    items: z.array(z.string()),
    recipes: z.array(z.string()).default([]),
    loot: z.array(z.string()).default([]),
  })
  .strip();

export const ResourcePackManifestSchema = z
  .object({
    format_version: z.literal("1.1.0"),
    pack_type: z.literal("resource_pack"),
    id: z.string().min(1),
    version: z.string().min(1),
    name: z.string().min(1),
    description: z.string().default(""),
    textures: z.array(z.string()).default([]),
    texture_atlas_patch: z.string().optional(),
    item_textures: z.record(z.string()).default({}),
  })
  .strip();

export type BehaviorPackManifest = z.infer<typeof BehaviorPackManifestSchema>;
export type ResourcePackManifest = z.infer<typeof ResourcePackManifestSchema>;

/** URL suffix; prefix with import.meta.env.BASE_URL. */
export const STRATUM_CORE_BEHAVIOR_PACK_PATH = "assets/mods/behavior_packs/stratum-core/";
export const STRATUM_CORE_RESOURCE_PACK_PATH = "assets/mods/resource_packs/stratum-core/";
