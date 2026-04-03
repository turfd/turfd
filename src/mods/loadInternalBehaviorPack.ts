import type { BlockRegistry } from "../world/blocks/BlockRegistry";
import type { ItemRegistry } from "../items/ItemRegistry";
import type { RecipeRegistry } from "../world/RecipeRegistry";
import type { LootResolver } from "../items/LootResolver";
import { parseBlockJson } from "./parseBlockJson";
import { parseItemJson } from "./parseItemJson";
import { parseRecipeJson } from "./parseRecipeJson";
import { parseLootTablesJson, registerLootTablesForBlocks } from "./parseLootTablesJson";
import {
  BehaviorPackManifestSchema,
  type BehaviorPackManifest,
} from "./internalPackManifest";

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to load ${url}: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<unknown>;
}

export async function fetchBehaviorPackManifest(packBaseUrl: string): Promise<BehaviorPackManifest> {
  const raw = await fetchJson(`${packBaseUrl}manifest.json`);
  return BehaviorPackManifestSchema.parse(raw);
}

export async function loadBehaviorPackBlocks(
  registry: BlockRegistry,
  packBaseUrl: string,
  manifest: BehaviorPackManifest,
  progress?: (loaded: number, total: number, file: string) => void,
): Promise<void> {
  const total = manifest.blocks.length;
  let loaded = 0;
  for (const file of manifest.blocks) {
    const raw = await fetchJson(`${packBaseUrl}blocks/${file}`);
    const def = parseBlockJson(raw);
    registry.register(def);
    loaded++;
    progress?.(loaded, total, file);
  }
}

export async function loadBehaviorPackItems(
  registry: BlockRegistry,
  itemRegistry: ItemRegistry,
  packBaseUrl: string,
  manifest: BehaviorPackManifest,
  progress?: (loaded: number, total: number, file: string) => void,
): Promise<void> {
  const total = manifest.items.length;
  let loaded = 0;
  for (const file of manifest.items) {
    const raw = await fetchJson(`${packBaseUrl}items/${file}`);
    const def = parseItemJson(raw);
    let placesBlockId: number | undefined;
    if (def.placesBlockIdentifier !== undefined) {
      const b = registry.getByIdentifier(def.placesBlockIdentifier);
      if (b === undefined) {
        throw new Error(
          `Item ${def.identifier}: unknown places_block "${def.placesBlockIdentifier}"`,
        );
      }
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
    loaded++;
    progress?.(loaded, total, file);
  }
}

export async function loadBehaviorPackRecipes(
  itemRegistry: ItemRegistry,
  recipeRegistry: RecipeRegistry,
  packBaseUrl: string,
  manifest: BehaviorPackManifest,
): Promise<void> {
  for (const rel of manifest.recipes) {
    const raw = await fetchJson(`${packBaseUrl}${rel}`);
    const recipes = parseRecipeJson(raw);
    for (const recipe of recipes) {
      if (
        recipe.output.itemId !== undefined &&
        itemRegistry.getByKey(recipe.output.itemId) === undefined
      ) {
        throw new Error(
          `Recipe '${recipe.id}' references unknown output item '${recipe.output.itemId}'.`,
        );
      }
      for (const ing of recipe.ingredients) {
        if (ing.itemId !== undefined && itemRegistry.getByKey(ing.itemId) === undefined) {
          throw new Error(
            `Recipe '${recipe.id}' references unknown item key '${ing.itemId}'.`,
          );
        }
        if (ing.tag !== undefined && itemRegistry.getByTag(ing.tag).length === 0) {
          throw new Error(
            `Recipe '${recipe.id}' references tag '${ing.tag}' with no matching items.`,
          );
        }
      }
    }
    recipeRegistry.registerAll(recipes);
  }
}

export async function loadBehaviorPackLoot(
  registry: BlockRegistry,
  resolver: LootResolver,
  packBaseUrl: string,
  manifest: BehaviorPackManifest,
): Promise<void> {
  for (const rel of manifest.loot) {
    const raw = await fetchJson(`${packBaseUrl}${rel}`);
    const data = parseLootTablesJson(raw);
    registerLootTablesForBlocks(registry, resolver, data);
  }
}
