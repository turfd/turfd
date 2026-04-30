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
import {
  parseStructureFeatureJson,
  parseStructureJson,
  type ParsedStructure,
  type ParsedStructureFeature,
} from "../world/structure/structureSchema";
import { structureIdFromPath } from "../world/structure/structureIdFromPath";
import { parseFurnaceFuelJson, parseSmeltingRecipesJson } from "./parseSmeltingJson";
import type { SmeltingRegistry } from "../world/SmeltingRegistry";
import {
  BehaviorPackManifestSchema,
  type BehaviorPackManifest,
} from "./internalPackManifest";
import { withBuildCacheBust } from "../core/assetCache";
import { parseJsoncResponse } from "../core/jsonc";

const CORE_PACK_ROOT = "/public/assets/mods/behavior_packs/stratum-core/";
const coreBlockFiles = import.meta.glob(
  "/public/assets/mods/behavior_packs/stratum-core/blocks/**/*.json",
  { eager: false },
);
const coreItemFiles = import.meta.glob(
  "/public/assets/mods/behavior_packs/stratum-core/items/**/*.json",
  { eager: false },
);
const coreRecipeFiles = import.meta.glob(
  "/public/assets/mods/behavior_packs/stratum-core/recipes/**/*.json",
  { eager: false },
);
const coreLootFiles = import.meta.glob(
  "/public/assets/mods/behavior_packs/stratum-core/loot_tables/**/*.json",
  { eager: false },
);
const coreSmeltingFiles = import.meta.glob(
  "/public/assets/mods/behavior_packs/stratum-core/smelting/**/*.json",
  { eager: false },
);
const coreFurnaceFuelFiles = import.meta.glob(
  "/public/assets/mods/behavior_packs/stratum-core/furnace_fuel/**/*.json",
  { eager: false },
);
const coreStructureFiles = import.meta.glob(
  "/public/assets/mods/behavior_packs/stratum-core/structures/**/*.json",
  { eager: false },
);
const coreFeatureFiles = import.meta.glob(
  "/public/assets/mods/behavior_packs/stratum-core/features/**/*.json",
  { eager: false },
);

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(withBuildCacheBust(url), { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Failed to load ${url}: ${res.status} ${res.statusText}`);
  }
  return parseJsoncResponse(res, url);
}

export async function fetchBehaviorPackManifest(packBaseUrl: string): Promise<BehaviorPackManifest> {
  const raw = await fetchJson(`${packBaseUrl}manifest.json`);
  return BehaviorPackManifestSchema.parse(raw);
}

function toSortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function stripCorePrefix(path: string): string {
  return path.slice(CORE_PACK_ROOT.length);
}

function coreDiscoveredManifestPaths(globMap: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const path of Object.keys(globMap)) {
    out.push(stripCorePrefix(path));
  }
  return toSortedUnique(out);
}

function coreDiscoveredLeafFiles(globMap: Record<string, unknown>, dirPrefix: string): string[] {
  const out: string[] = [];
  const prefix = `${CORE_PACK_ROOT}${dirPrefix}/`;
  for (const path of Object.keys(globMap)) {
    out.push(path.slice(prefix.length));
  }
  return toSortedUnique(out);
}

function isCoreBehaviorPack(manifest: BehaviorPackManifest): boolean {
  return manifest.id === "stratum.core.behavior";
}

function pickManifestPaths(
  manifestEntries: readonly string[] | undefined,
  discoveredEntries: readonly string[],
): string[] {
  if (manifestEntries !== undefined && manifestEntries.length > 0) {
    return toSortedUnique(manifestEntries);
  }
  return toSortedUnique(discoveredEntries);
}

export async function loadBehaviorPackBlocks(
  registry: BlockRegistry,
  packBaseUrl: string,
  manifest: BehaviorPackManifest,
  progress?: (loaded: number, total: number, file: string) => void,
): Promise<void> {
  const files = pickManifestPaths(
    manifest.blocks,
    isCoreBehaviorPack(manifest) ? coreDiscoveredLeafFiles(coreBlockFiles, "blocks") : [],
  );
  const total = files.length;
  const parsed = await Promise.all(
    files.map(async (file) => {
      const raw = await fetchJson(`${packBaseUrl}blocks/${file}`);
      return { file, def: parseBlockJson(raw) };
    }),
  );
  parsed.sort((a, b) => a.def.identifier.localeCompare(b.def.identifier));
  let loaded = 0;
  for (const { file, def } of parsed) {
    if (registry.isRegistered(def.identifier)) {
      console.warn(
        `[behavior-pack] overriding block '${def.identifier}' from ${file} (last definition wins)`,
      );
    }
    registry.register(def);
    loaded++;
    progress?.(loaded, total, file);
  }
}

/** Register standalone items from JSON; runtime ids are assigned by {@link ItemRegistry}. */
export function registerParsedItems(
  registry: BlockRegistry,
  itemRegistry: ItemRegistry,
  parsed: readonly ParsedItemDefinition[],
): void {
  const sorted = [...parsed].sort((a, b) => a.identifier.localeCompare(b.identifier));
  const seen = new Map<string, number>();
  for (const def of sorted) {
    const seenCount = seen.get(def.identifier) ?? 0;
    if (seenCount > 0) {
      console.warn(
        `[behavior-pack] duplicate item '${def.identifier}' in load set (occurrence ${seenCount + 1}); last definition wins`,
      );
    }
    seen.set(def.identifier, seenCount + 1);
    if (itemRegistry.getByKey(def.identifier) !== undefined) {
      console.warn(
        `[behavior-pack] overriding item '${def.identifier}' (last definition wins)`,
      );
    }
    let placesBlockId: number | undefined;
    if (def.placesBlockIdentifier !== undefined) {
      placesBlockId = registry.getByIdentifier(def.placesBlockIdentifier).id;
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
      maxDurability: def.maxDurability,
      fuelBurnSeconds: def.fuelBurnSeconds,
      tags: def.tags,
      eatRestoreHealth: def.eatRestoreHealth,
      eatTemporaryDurationSec: def.eatTemporaryDurationSec,
      inventoryTooltip: def.inventoryTooltip,
      creativeCategory: def.creativeCategory,
    });
  }
}

export async function loadBehaviorPackItems(
  registry: BlockRegistry,
  itemRegistry: ItemRegistry,
  packBaseUrl: string,
  manifest: BehaviorPackManifest,
  progress?: (loaded: number, total: number, file: string) => void,
): Promise<void> {
  const files = pickManifestPaths(
    manifest.items,
    isCoreBehaviorPack(manifest) ? coreDiscoveredLeafFiles(coreItemFiles, "items") : [],
  );
  const total = files.length;
  const parsed: ParsedItemDefinition[] = [];
  let loaded = 0;
  for (const file of files) {
    const raw = await fetchJson(`${packBaseUrl}items/${file}`);
    parsed.push(parseItemJson(raw));
    loaded++;
    progress?.(loaded, total, file);
  }
  registerParsedItems(registry, itemRegistry, parsed);
}

export async function loadBehaviorPackRecipes(
  itemRegistry: ItemRegistry,
  recipeRegistry: RecipeRegistry,
  packBaseUrl: string,
  manifest: BehaviorPackManifest,
): Promise<void> {
  const files = pickManifestPaths(
    manifest.recipes,
    isCoreBehaviorPack(manifest) ? coreDiscoveredManifestPaths(coreRecipeFiles) : [],
  );
  for (const rel of files) {
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
  const files = pickManifestPaths(
    manifest.loot,
    isCoreBehaviorPack(manifest) ? coreDiscoveredManifestPaths(coreLootFiles) : [],
  );
  for (const rel of files) {
    const raw = await fetchJson(`${packBaseUrl}${rel}`);
    const data = parseLootTablesJson(raw);
    registerLootTablesForBlocks(registry, resolver, data);
    registerEntityLootTables(resolver, data);
  }
}

export async function loadBehaviorPackStructures(
  packBaseUrl: string,
  manifest: BehaviorPackManifest,
): Promise<Map<string, ParsedStructure>> {
  const out = new Map<string, ParsedStructure>();
  const files = pickManifestPaths(
    manifest.structures,
    isCoreBehaviorPack(manifest) ? coreDiscoveredManifestPaths(coreStructureFiles) : [],
  );
  for (const rel of files) {
    const raw = await fetchJson(`${packBaseUrl}${rel}`);
    const parsed = parseStructureJson(raw);
    const id = structureIdFromPath(rel);
    out.set(id, parsed);
  }
  return out;
}

export async function loadBehaviorPackFeatures(
  packBaseUrl: string,
  manifest: BehaviorPackManifest,
): Promise<ParsedStructureFeature[]> {
  const out: ParsedStructureFeature[] = [];
  const files = pickManifestPaths(
    manifest.features,
    isCoreBehaviorPack(manifest) ? coreDiscoveredManifestPaths(coreFeatureFiles) : [],
  );
  for (const rel of files) {
    const raw = await fetchJson(`${packBaseUrl}${rel}`);
    out.push(parseStructureFeatureJson(raw));
  }
  return out;
}

export async function loadBehaviorPackSmelting(
  itemRegistry: ItemRegistry,
  smelting: SmeltingRegistry,
  packBaseUrl: string,
  manifest: BehaviorPackManifest,
): Promise<void> {
  const smeltingFiles = pickManifestPaths(
    manifest.smelting,
    isCoreBehaviorPack(manifest) ? coreDiscoveredManifestPaths(coreSmeltingFiles) : [],
  );
  for (const rel of smeltingFiles) {
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
  const fuelFiles = pickManifestPaths(
    manifest.furnace_fuel,
    isCoreBehaviorPack(manifest) ? coreDiscoveredManifestPaths(coreFurnaceFuelFiles) : [],
  );
  for (const rel of fuelFiles) {
    const raw = await fetchJson(`${packBaseUrl}${rel}`);
    const entries = parseFurnaceFuelJson(raw);
    smelting.registerFuelEntries(entries, itemRegistry);
  }
}
