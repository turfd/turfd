import type { ItemId } from "../core/itemDefinition";
import type { BlockRegistry } from "../world/blocks/BlockRegistry";
import type { ItemRegistry } from "../items/ItemRegistry";
import type { RecipeRegistry } from "../world/RecipeRegistry";
import type { LootResolver } from "../items/LootResolver";
import { parseBlockJson } from "./parseBlockJson";
import { parseItemJson, type ParsedItemDefinition } from "./parseItemJson";
import { parseRecipeJson } from "./parseRecipeJson";
import {
  parseLootTablesJson,
  registerEntityLootTables,
  registerLootTablesForBlocks,
} from "./parseLootTablesJson";
import { parseFurnaceFuelJson, parseSmeltingRecipesJson } from "./parseSmeltingJson";
import type { SmeltingRegistry } from "../world/SmeltingRegistry";
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
  const parsed = await Promise.all(
    manifest.blocks.map(async (file) => {
      const raw = await fetchJson(`${packBaseUrl}blocks/${file}`);
      return { file, def: parseBlockJson(raw) };
    }),
  );
  parsed.sort((a, b) => a.def.numericId - b.def.numericId);
  let loaded = 0;
  for (const { file, def } of parsed) {
    registry.registerInOrder(def);
    loaded++;
    progress?.(loaded, total, file);
  }
}

/**
 * Register standalone items from JSON with explicit `stratum:numeric_id`, contiguous after existing ids
 * (e.g. block-items using the same ids as their blocks).
 */
export function registerParsedItemsInOrder(
  registry: BlockRegistry,
  itemRegistry: ItemRegistry,
  parsed: readonly ParsedItemDefinition[],
): void {
  const sorted = [...parsed].sort((a, b) => a.numericId - b.numericId);
  let expected = itemRegistry.maxRegisteredNumericId() + 1;
  for (const def of sorted) {
    if (def.numericId !== expected) {
      throw new Error(
        `Item '${def.identifier}': stratum:numeric_id is ${def.numericId}, expected ${expected} (must extend contiguously after block-items).`,
      );
    }
    let placesBlockId: number | undefined;
    if (def.placesBlockIdentifier !== undefined) {
      placesBlockId = registry.getByIdentifier(def.placesBlockIdentifier).id;
    }
    itemRegistry.register({
      key: def.identifier,
      id: def.numericId as ItemId,
      textureName: def.textureKey,
      displayName: def.displayName,
      maxStack: def.maxStack,
      placesBlockId,
      toolType: def.toolType,
      toolTier: def.toolTier,
      toolSpeed: def.toolSpeed,
      maxDurability: def.maxDurability,
      fuelBurnSeconds: def.fuelBurnSeconds,
      tags: def.tags,
      eatRestoreHealth: def.eatRestoreHealth,
      inventoryTooltip: def.inventoryTooltip,
    });
    expected += 1;
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
  const parsed: ParsedItemDefinition[] = [];
  let loaded = 0;
  for (const file of manifest.items) {
    const raw = await fetchJson(`${packBaseUrl}items/${file}`);
    parsed.push(parseItemJson(raw));
    loaded++;
    progress?.(loaded, total, file);
  }
  registerParsedItemsInOrder(registry, itemRegistry, parsed);
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
    registerEntityLootTables(resolver, data);
  }
}

export async function loadBehaviorPackSmelting(
  itemRegistry: ItemRegistry,
  smelting: SmeltingRegistry,
  packBaseUrl: string,
  manifest: BehaviorPackManifest,
): Promise<void> {
  for (const rel of manifest.smelting) {
    const raw = await fetchJson(`${packBaseUrl}${rel}`);
    const recipes = parseSmeltingRecipesJson(raw);
    for (const r of recipes) {
      if (itemRegistry.getByKey(r.outputItemKey) === undefined) {
        throw new Error(
          `Smelting '${r.id}' references unknown output '${r.outputItemKey}'.`,
        );
      }
      if (r.inputItemKey !== undefined && itemRegistry.getByKey(r.inputItemKey) === undefined) {
        throw new Error(
          `Smelting '${r.id}' references unknown input '${r.inputItemKey}'.`,
        );
      }
      if (
        r.inputTag !== undefined &&
        itemRegistry.getByTag(r.inputTag).length === 0
      ) {
        throw new Error(
          `Smelting '${r.id}' references tag '${r.inputTag}' with no items.`,
        );
      }
    }
    smelting.registerRecipes(recipes);
  }
  for (const rel of manifest.furnace_fuel) {
    const raw = await fetchJson(`${packBaseUrl}${rel}`);
    const entries = parseFurnaceFuelJson(raw);
    smelting.registerFuelEntries(entries, itemRegistry);
  }
}
