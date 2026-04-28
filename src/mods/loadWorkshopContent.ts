/** Load workshop ZIP manifests into block/item/recipe registries and the block atlas. */

import { z } from "zod";
import type { BlockRegistry } from "../world/blocks/BlockRegistry";
import type { ItemRegistry } from "../items/ItemRegistry";
import type { RecipeRegistry } from "../world/RecipeRegistry";
import type { AtlasLoader } from "../renderer/AtlasLoader";
import { parseBlockJson } from "./parseBlockJson";
import { parseItemJson } from "./parseItemJson";
import { registerParsedItems } from "./loadInternalBehaviorPack";
import { parseRecipeJson } from "./parseRecipeJson";
import type { IModRepository } from "./IModRepository";
import {
  asModRecordId,
  type CachedMod,
  type WorkshopManifest,
  workshopPackLoadsBlocks,
  workshopPackLoadsTextures,
} from "./workshopTypes";
import {
  parseLootTablesJson,
  registerEntityLootTables,
  registerLootTablesForBlocks,
} from "./parseLootTablesJson";
import {
  parseStructureFeatureJson,
  parseStructureJson,
  type ParsedStructure,
  type ParsedStructureFeature,
} from "../world/structure/structureSchema";
import { structureIdFromPath } from "../world/structure/structureIdFromPath";
import type { LootResolver } from "../items/LootResolver";
import type { WorkshopModRef } from "../persistence/IndexedDBStore";
import { parseJsoncText } from "../core/jsonc";

const WorkshopAtlasPatchSchema = z
  .object({
    texture: z.string().min(1),
    frames: z.record(
      z.object({
        x: z.number(),
        y: z.number(),
        w: z.number(),
        h: z.number(),
      }),
    ),
  })
  .strict();

function shouldLoadBlocks(m: WorkshopManifest): boolean {
  return workshopPackLoadsBlocks(m.mod_type);
}

function shouldLoadTextures(m: WorkshopManifest): boolean {
  return workshopPackLoadsTextures(m.mod_type);
}

function atlasKeyFromTexturePath(p: string): string {
  const base = p.split("/").pop() ?? p;
  return base.replace(/\.(png|jpg|jpeg)$/i, "");
}

function readUtf8Json(files: Record<string, Uint8Array>, rel: string): unknown {
  const u = files[rel];
  if (u === undefined) {
    throw new Error(`Missing file in mod ZIP: ${rel}`);
  }
  const text = new TextDecoder().decode(u);
  return parseJsoncText(text, rel);
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function discoverZipJsonPaths(files: Record<string, Uint8Array>, prefix: string): string[] {
  const exactPrefix = `${prefix}/`;
  const out: string[] = [];
  for (const p of Object.keys(files)) {
    if (!p.startsWith(exactPrefix) || !p.endsWith(".json")) {
      continue;
    }
    out.push(p);
  }
  return sortedUnique(out);
}

function selectManifestOrDiscoveredPaths(
  manifestEntries: readonly string[],
  discovered: readonly string[],
): string[] {
  if (manifestEntries.length > 0) {
    return sortedUnique(manifestEntries);
  }
  return sortedUnique(discovered);
}

export async function collectWorkshopCachedMods(
  refs: readonly WorkshopModRef[],
  repo: IModRepository,
): Promise<CachedMod[]> {
  const out: CachedMod[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    const k = `${ref.recordId}:${ref.modId}:${ref.version}`;
    if (seen.has(k)) {
      continue;
    }
    seen.add(k);
    out.push(
      await repo.ensureInstalled(ref.modId, ref.version, asModRecordId(ref.recordId)),
    );
  }
  return out;
}

export async function loadWorkshopBlocksIntoRegistry(
  registry: BlockRegistry,
  cachedMods: readonly CachedMod[],
  progress?: (loaded: number, total: number, file: string) => void,
): Promise<void> {
  const jobs: { modId: string; path: string }[] = [];
  for (const c of cachedMods) {
    if (!shouldLoadBlocks(c.manifest)) {
      continue;
    }
    const blockPaths = selectManifestOrDiscoveredPaths(
      c.manifest.blocks,
      discoverZipJsonPaths(c.files, "blocks"),
    );
    for (const path of blockPaths) {
      jobs.push({ modId: c.modId, path });
    }
  }
  const parsed: { path: string; def: ReturnType<typeof parseBlockJson> }[] = [];
  for (const { path, modId } of jobs) {
    const c = cachedMods.find((x) => x.modId === modId);
    if (c === undefined) {
      continue;
    }
    const raw = readUtf8Json(c.files, path);
    parsed.push({ path, def: parseBlockJson(raw) });
  }
  parsed.sort((a, b) => a.def.identifier.localeCompare(b.def.identifier));
  let done = 0;
  const total = parsed.length;
  for (const { path, def } of parsed) {
    if (registry.isRegistered(def.identifier)) {
      console.warn(
        `[workshop] overriding block '${def.identifier}' from ${path} (last definition wins)`,
      );
    }
    registry.register(def);
    done++;
    progress?.(done, total, path);
  }
}

export function loadWorkshopItemsIntoRegistry(
  registry: BlockRegistry,
  itemRegistry: ItemRegistry,
  cachedMods: readonly CachedMod[],
): void {
  const parsed: ReturnType<typeof parseItemJson>[] = [];
  for (const c of cachedMods) {
    if (!shouldLoadBlocks(c.manifest)) {
      continue;
    }
    const itemPaths = selectManifestOrDiscoveredPaths(
      c.manifest.items,
      discoverZipJsonPaths(c.files, "items"),
    );
    for (const path of itemPaths) {
      const raw = readUtf8Json(c.files, path);
      parsed.push(parseItemJson(raw));
    }
  }
  registerParsedItems(registry, itemRegistry, parsed);
}

export function loadWorkshopLootIntoResolver(
  registry: BlockRegistry,
  lootResolver: LootResolver,
  cachedMods: readonly CachedMod[],
): void {
  for (const c of cachedMods) {
    if (!shouldLoadBlocks(c.manifest)) {
      continue;
    }
    const lootPaths = selectManifestOrDiscoveredPaths(
      c.manifest.loot,
      discoverZipJsonPaths(c.files, "loot_tables"),
    );
    for (const rel of lootPaths) {
      const raw = readUtf8Json(c.files, rel);
      const data = parseLootTablesJson(raw);
      registerLootTablesForBlocks(registry, lootResolver, data);
      registerEntityLootTables(lootResolver, data);
    }
  }
}

export function loadWorkshopRecipesIntoRegistry(
  itemRegistry: ItemRegistry,
  recipeRegistry: RecipeRegistry,
  cachedMods: readonly CachedMod[],
): void {
  for (const c of cachedMods) {
    if (!shouldLoadBlocks(c.manifest)) {
      continue;
    }
    const recipePaths = selectManifestOrDiscoveredPaths(
      c.manifest.recipes,
      discoverZipJsonPaths(c.files, "recipes"),
    );
    for (const path of recipePaths) {
      const raw = readUtf8Json(c.files, path);
      const recipes = parseRecipeJson(raw);
      for (const recipe of recipes) {
        if (
          recipe.output.itemId !== undefined &&
          itemRegistry.getByKey(recipe.output.itemId) === undefined
        ) {
          throw new Error(
            `Workshop recipe '${recipe.id}' references unknown output item '${recipe.output.itemId}'.`,
          );
        }
        for (const ing of recipe.ingredients) {
          if (ing.itemId !== undefined && itemRegistry.getByKey(ing.itemId) === undefined) {
            throw new Error(
              `Workshop recipe '${recipe.id}' references unknown item '${ing.itemId}'.`,
            );
          }
          if (ing.tag !== undefined && itemRegistry.getByTag(ing.tag).length === 0) {
            throw new Error(
              `Workshop recipe '${recipe.id}' references empty tag '${ing.tag}'.`,
            );
          }
        }
      }
      recipeRegistry.registerAll(recipes);
    }
  }
}

export function loadWorkshopStructures(
  cachedMods: readonly CachedMod[],
): Map<string, ParsedStructure> {
  const out = new Map<string, ParsedStructure>();
  for (const c of cachedMods) {
    if (!shouldLoadBlocks(c.manifest)) {
      continue;
    }
    const structurePaths = selectManifestOrDiscoveredPaths(
      c.manifest.structures,
      discoverZipJsonPaths(c.files, "structures"),
    );
    for (const rel of structurePaths) {
      const raw = readUtf8Json(c.files, rel);
      const parsed = parseStructureJson(raw);
      const id = structureIdFromPath(rel);
      out.set(id, parsed);
    }
  }
  return out;
}

export function loadWorkshopFeatures(
  cachedMods: readonly CachedMod[],
): ParsedStructureFeature[] {
  const out: ParsedStructureFeature[] = [];
  for (const c of cachedMods) {
    if (!shouldLoadBlocks(c.manifest)) {
      continue;
    }
    const featurePaths = selectManifestOrDiscoveredPaths(
      c.manifest.features,
      discoverZipJsonPaths(c.files, "features"),
    );
    for (const rel of featurePaths) {
      const raw = readUtf8Json(c.files, rel);
      out.push(parseStructureFeatureJson(raw));
    }
  }
  return out;
}

export async function applyWorkshopTexturesToBlockAtlas(
  blockAtlas: AtlasLoader,
  cachedMods: readonly CachedMod[],
): Promise<void> {
  for (const c of cachedMods) {
    if (!shouldLoadTextures(c.manifest)) {
      continue;
    }
    const { files, manifest } = c;
    if (manifest.texture_atlas_patch !== undefined && manifest.texture_atlas_patch.length > 0) {
      const patchRaw = readUtf8Json(files, manifest.texture_atlas_patch);
      const patch = WorkshopAtlasPatchSchema.parse(patchRaw);
      const texBytes = files[patch.texture];
      if (texBytes === undefined) {
        throw new Error(`Atlas patch texture not found in ZIP: ${patch.texture}`);
      }
      const rects = Object.entries(patch.frames).map(([name, fr]) => ({
        name,
        sx: Math.floor(fr.x),
        sy: Math.floor(fr.y),
        sw: Math.floor(fr.w),
        sh: Math.floor(fr.h),
      }));
      await blockAtlas.appendWorkshopSpritesheet(texBytes, rects);
    }
    for (const rel of manifest.textures) {
      const key = atlasKeyFromTexturePath(rel);
      const bytes = files[rel];
      if (bytes === undefined) {
        continue;
      }
      const blob = new Blob([bytes], { type: "image/png" });
      const bmp = await createImageBitmap(blob);
      try {
        await blockAtlas.appendWorkshopSpritesheet(bytes, [
          {
            name: key,
            sx: 0,
            sy: 0,
            sw: bmp.width,
            sh: bmp.height,
          },
        ]);
      } finally {
        bmp.close();
      }
    }
  }
}

export type { WorkshopModRef };
