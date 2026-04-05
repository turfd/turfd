/**
 * Validates and applies furnace smelt enqueue (ingredients from player → queue on tile).
 */

import { RECIPE_STATION_FURNACE } from "../../core/constants";
import type { RecipeDefinition } from "../../core/recipe";
import type { CraftingSystem, CraftingStationContext } from "../../entities/CraftingSystem";
import type { PlayerInventory } from "../../items/PlayerInventory";
import type { ItemRegistry } from "../../items/ItemRegistry";
import type { SmeltingRegistry } from "../SmeltingRegistry";
import {
  cloneFurnaceQueue,
  type FurnaceQueueEntry,
  type FurnaceTileState,
} from "./FurnaceTileState";
import {
  applyOneBatchToSlotsCopy,
  mergeQueueEntry,
} from "./FurnaceSimulator";

function canFitQueueAfterMerge(
  outputSlots: FurnaceTileState["outputSlots"],
  queue: readonly FurnaceQueueEntry[],
  smeltingRecipeId: string,
  addBatches: number,
  smelting: SmeltingRegistry,
  items: ItemRegistry,
): boolean {
  let slots = outputSlots.map((x) => (x === null ? null : { ...x }));
  const merged = mergeQueueEntry(queue, smeltingRecipeId, addBatches);
  for (const e of merged) {
    const r = smelting.findRecipeByJsonId(e.smeltingRecipeId);
    if (r === undefined) {
      return false;
    }
    for (let b = 0; b < e.batches; b++) {
      const next = applyOneBatchToSlotsCopy(slots, r, items);
      if (next === null) {
        return false;
      }
      slots = next;
    }
  }
  return true;
}

/** `null` = valid; otherwise UI / flash hint message. */
export function validateFurnaceEnqueue(
  tile: FurnaceTileState,
  recipe: RecipeDefinition,
  batches: number,
  inventory: PlayerInventory,
  crafting: CraftingSystem,
  smelting: SmeltingRegistry,
  items: ItemRegistry,
  ctx: CraftingStationContext,
): string | null {
  if (recipe.station !== RECIPE_STATION_FURNACE || recipe.smeltingSourceId === undefined) {
    return "Not a furnace recipe.";
  }
  if (smelting.findRecipeByJsonId(recipe.smeltingSourceId) === undefined) {
    return "Unknown smelting recipe.";
  }
  if (!crafting.canAffordIngredientsFurnace(recipe, inventory, batches, ctx)) {
    return "Cannot smelt — empty the cursor and keep materials in storage or hotbar.";
  }
  if (
    !canFitQueueAfterMerge(
      tile.outputSlots,
      tile.queue,
      recipe.smeltingSourceId,
      batches,
      smelting,
      items,
    )
  ) {
    return "Furnace output is too full for this many smelts.";
  }
  return null;
}

export function tryEnqueueFurnaceSmelt(
  tile: FurnaceTileState,
  recipe: RecipeDefinition,
  batches: number,
  inventory: PlayerInventory,
  crafting: CraftingSystem,
  smelting: SmeltingRegistry,
  items: ItemRegistry,
  ctx: CraftingStationContext,
): { ok: true; nextTile: FurnaceTileState } | { ok: false; reason: string } {
  const v = validateFurnaceEnqueue(
    tile,
    recipe,
    batches,
    inventory,
    crafting,
    smelting,
    items,
    ctx,
  );
  if (v !== null) {
    return { ok: false, reason: v };
  }
  if (recipe.smeltingSourceId === undefined) {
    return { ok: false, reason: "Not a furnace recipe." };
  }
  if (!crafting.consumeIngredientsOnly(recipe, inventory, batches)) {
    return { ok: false, reason: "Could not take materials from inventory." };
  }
  const nextQueue = mergeQueueEntry(tile.queue, recipe.smeltingSourceId, batches);
  const nextTile: FurnaceTileState = {
    outputSlots: tile.outputSlots.map((s) => (s === null ? null : { ...s })),
    fuel: tile.fuel === null ? null : { ...tile.fuel },
    fuelRemainingSec: tile.fuelRemainingSec,
    cookProgressSec: tile.cookProgressSec,
    queue: cloneFurnaceQueue(nextQueue),
    lastProcessedWorldTimeMs: tile.lastProcessedWorldTimeMs,
  };
  return { ok: true, nextTile };
}
