/** Maps behavior-pack smelting JSON into {@link RecipeDefinition} for the crafting UI Furnace tab. */

import { RECIPE_STATION_FURNACE } from "../core/constants";
import type { RecipeDefinition } from "../core/recipe";
import type { RecipeRegistry } from "./RecipeRegistry";
import type { SmeltingRecipeDef, SmeltingRegistry } from "./SmeltingRegistry";

export function smeltingDefToRecipeDef(r: SmeltingRecipeDef): RecipeDefinition {
  if (r.inputItemKey === undefined && r.inputTag === undefined) {
    throw new Error(`Smelting recipe '${r.id}' needs inputItemKey or inputTag.`);
  }
  const ingredients =
    r.inputItemKey !== undefined
      ? ([{ itemId: r.inputItemKey, count: 1 }] as const)
      : ([{ tag: r.inputTag!, count: 1 }] as const);
  return {
    id: `stratum:smelting:${r.id}`,
    category: "Furnace",
    station: RECIPE_STATION_FURNACE,
    ingredients,
    output: { itemId: r.outputItemKey, count: r.outputCount },
    smeltingSourceId: r.id,
  };
}

export function registerSmeltingRecipesInRegistry(
  smelting: SmeltingRegistry,
  registry: RecipeRegistry,
): void {
  for (const r of smelting.allRecipes()) {
    registry.register(smeltingDefToRecipeDef(r));
  }
}
