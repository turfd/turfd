/** Authoritative crafting: canCraft / craft transactions against {@link PlayerInventory}. */

import { RECIPE_STATION_CRAFTING_TABLE, RECIPE_STATION_FURNACE } from "../core/constants";
import type { ItemId } from "../core/itemDefinition";
import type { CraftResult, IngredientSlot, RecipeDefinition } from "../core/recipe";
import type { PlayerInventory } from "../items/PlayerInventory";
import type { ItemRegistry } from "../items/ItemRegistry";
import type { RecipeRegistry } from "../world/RecipeRegistry";

export interface CraftingStationContext {
  readonly nearCraftingTable: boolean;
  readonly nearFurnace: boolean;
}

/** Per-slot counts for crafting UI (inventory only; ignores station, cursor, output space). */
export type RecipeIngredientAvailability = {
  readonly need: number;
  readonly have: number;
};

export class CraftingSystem {
  constructor(
    private readonly _items: ItemRegistry,
    private readonly _recipes: RecipeRegistry,
  ) {}

  private resolveItemId(key: string): ItemId | undefined {
    return this._items.getByKey(key)?.id;
  }

  /** Resolve all ItemIds that satisfy an ingredient (single item or tag). */
  private resolveIngredientIds(ing: IngredientSlot): ItemId[] {
    if (ing.itemId !== undefined) {
      const id = this.resolveItemId(ing.itemId);
      return id !== undefined ? [id] : [];
    }
    if (ing.tag !== undefined) {
      return this._items.getByTag(ing.tag).map((d) => d.id);
    }
    return [];
  }

  /** Total count of items matching any of the given ids across the entire inventory. */
  private countInInventory(inventory: PlayerInventory, ids: ItemId[]): number {
    const idSet = new Set(ids);
    let total = 0;
    for (let i = 0; i < inventory.size; i++) {
      const s = inventory.getStack(i);
      if (s !== null && idSet.has(s.itemId)) {
        total += s.count;
      }
    }
    return total;
  }

  /** Consume `needed` total items from the inventory, drawing from any of the matching ids. */
  private consumeFromMatching(inventory: PlayerInventory, ids: ItemId[], needed: number): boolean {
    let remaining = needed;
    for (const id of ids) {
      if (remaining <= 0) break;
      let available = 0;
      for (let i = 0; i < inventory.size; i++) {
        const s = inventory.getStack(i);
        if (s !== null && s.itemId === id) available += s.count;
      }
      const take = Math.min(available, remaining);
      if (take > 0) {
        if (!inventory.consume(id, take)) return false;
        remaining -= take;
      }
    }
    return remaining <= 0;
  }

  private stationSatisfied(recipe: RecipeDefinition, ctx: CraftingStationContext): boolean {
    if (recipe.station === null) {
      return true;
    }
    if (recipe.station === RECIPE_STATION_CRAFTING_TABLE) {
      return ctx.nearCraftingTable;
    }
    if (recipe.station === RECIPE_STATION_FURNACE) {
      return ctx.nearFurnace;
    }
    return false;
  }

  canCraft(
    recipe: RecipeDefinition,
    inventory: PlayerInventory,
    batches: number,
    ctx: CraftingStationContext,
  ): boolean {
    if (!Number.isInteger(batches) || batches <= 0) {
      return false;
    }
    if (!this.stationSatisfied(recipe, ctx)) {
      return false;
    }
    if (inventory.getCursorStack() !== null) {
      return false;
    }

    for (const ing of recipe.ingredients) {
      const ids = this.resolveIngredientIds(ing);
      if (ids.length === 0) return false;
      if (this.countInInventory(inventory, ids) < ing.count * batches) return false;
    }

    const outId = this.resolveItemId(recipe.output.itemId!);
    if (outId === undefined) {
      return false;
    }
    const needOut = recipe.output.count * batches;
    return inventory.simulateAddOverflow(outId, needOut) === 0;
  }

  craft(
    recipe: RecipeDefinition,
    inventory: PlayerInventory,
    batches: number,
    ctx: CraftingStationContext,
  ): CraftResult {
    if (!this.canCraft(recipe, inventory, batches, ctx)) {
      let reason = "Cannot craft.";
      if (recipe.station === RECIPE_STATION_CRAFTING_TABLE && !ctx.nearCraftingTable) {
        reason = "Move closer to a crafting table.";
      } else if (recipe.station === RECIPE_STATION_FURNACE && !ctx.nearFurnace) {
        reason = "Move closer to a furnace.";
      }
      return { ok: false, reason };
    }

    for (const ing of recipe.ingredients) {
      const ids = this.resolveIngredientIds(ing);
      if (ids.length === 0) return { ok: false, reason: "Cannot craft." };
      if (!this.consumeFromMatching(inventory, ids, ing.count * batches)) {
        return { ok: false, reason: "Cannot craft." };
      }
    }

    const outId = this.resolveItemId(recipe.output.itemId!);
    if (outId === undefined) {
      return { ok: false, reason: "Cannot craft." };
    }
    const overflow = inventory.add(outId, recipe.output.count * batches);
    if (overflow > 0) {
      return { ok: false, reason: "Output did not fit." };
    }

    return { ok: true, crafted: batches };
  }

  /**
   * Largest integer b such that {@link canCraft} is true for (recipe, inventory, b).
   */
  maxCraftableBatches(
    recipe: RecipeDefinition,
    inventory: PlayerInventory,
    ctx: CraftingStationContext,
  ): number {
    if (!this.stationSatisfied(recipe, ctx)) {
      return 0;
    }
    let hi = this.maxBatchesLimitedByIngredients(recipe, inventory);
    while (hi > 0 && !this.canCraft(recipe, inventory, hi, ctx)) {
      hi -= 1;
    }
    return hi;
  }

  private maxBatchesLimitedByIngredients(
    recipe: RecipeDefinition,
    inventory: PlayerInventory,
  ): number {
    let minB = Number.POSITIVE_INFINITY;
    for (const ing of recipe.ingredients) {
      const ids = this.resolveIngredientIds(ing);
      if (ids.length === 0) return 0;
      const total = this.countInInventory(inventory, ids);
      minB = Math.min(minB, Math.floor(total / ing.count));
    }
    return minB === Number.POSITIVE_INFINITY ? 0 : minB;
  }

  getRecipeById(id: string): RecipeDefinition | undefined {
    return this._recipes.getById(id);
  }

  /**
   * For each ingredient slot: how many are needed vs how many the player holds
   * (any item matching the slot’s item id or tag).
   */
  recipeIngredientAvailability(
    recipe: RecipeDefinition,
    inventory: PlayerInventory,
  ): RecipeIngredientAvailability[] {
    return recipe.ingredients.map((ing) => {
      const ids = this.resolveIngredientIds(ing);
      const have = ids.length === 0 ? 0 : this.countInInventory(inventory, ids);
      return { need: ing.count, have };
    });
  }

  /** True if the player has at least one item matching any ingredient slot. */
  recipeTouchesInventory(recipe: RecipeDefinition, inventory: PlayerInventory): boolean {
    for (const ing of recipe.ingredients) {
      const ids = this.resolveIngredientIds(ing);
      if (ids.length > 0 && this.countInInventory(inventory, ids) > 0) {
        return true;
      }
    }
    return false;
  }

  /** Station + empty cursor + ingredients only (furnace tab / enqueue). */
  canAffordIngredientsFurnace(
    recipe: RecipeDefinition,
    inventory: PlayerInventory,
    batches: number,
    ctx: CraftingStationContext,
  ): boolean {
    if (recipe.station !== RECIPE_STATION_FURNACE) {
      return false;
    }
    if (!Number.isInteger(batches) || batches <= 0) {
      return false;
    }
    if (!this.stationSatisfied(recipe, ctx)) {
      return false;
    }
    if (inventory.getCursorStack() !== null) {
      return false;
    }
    for (const ing of recipe.ingredients) {
      const ids = this.resolveIngredientIds(ing);
      if (ids.length === 0) {
        return false;
      }
      if (this.countInInventory(inventory, ids) < ing.count * batches) {
        return false;
      }
    }
    return true;
  }

  consumeIngredientsOnly(recipe: RecipeDefinition, inventory: PlayerInventory, batches: number): boolean {
    for (const ing of recipe.ingredients) {
      const ids = this.resolveIngredientIds(ing);
      if (ids.length === 0) {
        return false;
      }
      if (!this.consumeFromMatching(inventory, ids, ing.count * batches)) {
        return false;
      }
    }
    return true;
  }

  maxCraftableIngredientBatchesFurnace(
    recipe: RecipeDefinition,
    inventory: PlayerInventory,
    ctx: CraftingStationContext,
  ): number {
    if (recipe.station !== RECIPE_STATION_FURNACE) {
      return 0;
    }
    if (!this.stationSatisfied(recipe, ctx) || inventory.getCursorStack() !== null) {
      return 0;
    }
    return this.maxBatchesLimitedByIngredients(recipe, inventory);
  }
}
