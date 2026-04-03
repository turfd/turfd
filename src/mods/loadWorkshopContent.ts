/** Load workshop ZIP manifests into block/item/recipe registries and the block atlas. */

import { z } from "zod";
import type { BlockRegistry } from "../world/blocks/BlockRegistry";
import type { ItemRegistry } from "../items/ItemRegistry";
import type { RecipeRegistry } from "../world/RecipeRegistry";
import type { AtlasLoader } from "../renderer/AtlasLoader";
import { parseBlockJson } from "./parseBlockJson";
import { parseItemJson } from "./parseItemJson";
import { parseRecipeJson } from "./parseRecipeJson";
import type { IModRepository } from "./IModRepository";
import {
  asModRecordId,
  type CachedMod,
  type WorkshopManifest,
  workshopPackLoadsBlocks,
  workshopPackLoadsTextures,
} from "./workshopTypes";
import { parseLootTablesJson, registerLootTablesForBlocks } from "./parseLootTablesJson";
import type { LootResolver } from "../items/LootResolver";
import type { WorkshopModRef } from "../persistence/IndexedDBStore";

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
  return JSON.parse(text) as unknown;
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
    for (const path of c.manifest.blocks) {
      jobs.push({ modId: c.modId, path });
    }
  }
  let done = 0;
  const total = jobs.length;
  for (const { path, modId } of jobs) {
    const c = cachedMods.find((x) => x.modId === modId);
    if (c === undefined) {
      continue;
    }
    const raw = readUtf8Json(c.files, path);
    const def = parseBlockJson(raw);
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
  for (const c of cachedMods) {
    if (!shouldLoadBlocks(c.manifest)) {
      continue;
    }
    for (const path of c.manifest.items) {
      const raw = readUtf8Json(c.files, path);
      const def = parseItemJson(raw);
      let placesBlockId: number | undefined;
      if (def.placesBlockIdentifier !== undefined) {
        const b = registry.getByIdentifier(def.placesBlockIdentifier);
        placesBlockId = b.id;
      }
      itemRegistry.register({
        key: def.identifier,
        textureName: def.textureKey,
        displayName: def.displayName,
        maxStack: def.maxStack,
        placesBlockId,
        toolType: def.toolType,
        toolTier: def.toolTier,
        toolSpeed: def.toolSpeed,
      });
    }
  }
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
    for (const rel of c.manifest.loot) {
      const raw = readUtf8Json(c.files, rel);
      const data = parseLootTablesJson(raw);
      registerLootTablesForBlocks(registry, lootResolver, data);
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
    for (const path of c.manifest.recipes) {
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
