/**
 * Smelting recipes and furnace fuel burn times.
 *
 * **Fuel:** {@link getFuelBurnSeconds} drives the furnace fuel slot; `stepFurnaceTile` in
 * `FurnaceSimulator.ts` only advances smelts while fuel time remains.
 * Values come from each item/block `stratum:fuel` and optional behavior-pack `furnace_fuel.json`.
 *
 * **Cook time:** `cookTimeSec` from `smelting.json` (`cook_time_sec`) is the per-batch smelt
 * duration used by the furnace simulator and the Furnace tab progress UI.
 */

import type { ItemId } from "../core/itemDefinition";
import type { ItemRegistry } from "../items/ItemRegistry";

export type SmeltingRecipeDef = {
  readonly id: string;
  readonly inputItemKey?: string;
  readonly inputTag?: string;
  readonly outputItemKey: string;
  readonly outputCount: number;
  /** Seconds per completed smelt batch (furnace sim + UI progress). */
  readonly cookTimeSec: number;
};

/** Optional extra fuel rules from `furnace_fuel.json` (by item id or tag). */
export type FuelEntryDef = {
  readonly itemKey?: string;
  readonly tag?: string;
  readonly burnSeconds: number;
};

export class SmeltingRegistry {
  private readonly _recipes: SmeltingRecipeDef[] = [];
  private readonly _fuelByItemId = new Map<ItemId, number>();

  registerRecipes(recipes: readonly SmeltingRecipeDef[]): void {
    this._recipes.push(...recipes);
  }

  /** All loaded smelting defs (for UI / recipe registration). */
  allRecipes(): readonly SmeltingRecipeDef[] {
    return this._recipes;
  }

  /** Merges `furnace_fuel.json` entries; burn time is max with per-item `stratum:fuel`. */
  registerFuelEntries(
    entries: readonly FuelEntryDef[],
    items: ItemRegistry,
  ): void {
    for (const e of entries) {
      if (e.itemKey !== undefined) {
        const def = items.getByKey(e.itemKey);
        if (def !== undefined) {
          const prev = this._fuelByItemId.get(def.id) ?? 0;
          this._fuelByItemId.set(def.id, Math.max(prev, e.burnSeconds));
        }
      }
      if (e.tag !== undefined) {
        for (const d of items.getByTag(e.tag)) {
          const prev = this._fuelByItemId.get(d.id) ?? 0;
          this._fuelByItemId.set(d.id, Math.max(prev, e.burnSeconds));
        }
      }
    }
  }

  findRecipeByJsonId(id: string): SmeltingRecipeDef | undefined {
    return this._recipes.find((r) => r.id === id);
  }

  /**
   * Burn time for one unit in the fuel slot: max of `furnace_fuel.json` (per item or tag) and
   * the item definition's `stratum:fuel` / block `stratum:fuel`.
   */
  getFuelBurnSeconds(itemId: ItemId, items: ItemRegistry): number {
    const fromTable = this._fuelByItemId.get(itemId) ?? 0;
    const fromDef = items.getById(itemId)?.fuelBurnSeconds ?? 0;
    return Math.max(fromTable, fromDef);
  }
}
