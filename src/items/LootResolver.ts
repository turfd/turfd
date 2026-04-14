/** Resolves block-break loot tables into ItemStack drop lists using seeded RNG. */

import type { ILootResolver, LootRng } from "../core/loot";
import type { ItemId, ItemStack } from "../core/itemDefinition";
import type { ItemRegistry } from "./ItemRegistry";

export type LootEntry = {
  itemKey: string;
  countMin: number;
  countMax: number;
  /** Drop chance 0–1. Default 1.0 (always drops). */
  chance: number;
};

/** `each`: every entry rolls its `chance` independently. `one_of`: pick exactly one entry, weighted by `chance` (relative weights). */
export type LootRollMode = "each" | "one_of";

export type LootTable = {
  entries: LootEntry[];
  roll?: LootRollMode;
};

export class LootResolver implements ILootResolver {
  private readonly _tables = new Map<number, LootTable>();
  /** Mob type id (see `MobType`) → loot table. */
  private readonly _entityTables = new Map<number, LootTable>();
  private readonly _items: ItemRegistry;

  constructor(items: ItemRegistry) {
    this._items = items;
  }

  /**
   * Register a loot table for a block ID.
   * Called at startup when loading block JSON.
   */
  registerTable(blockId: number, table: LootTable): void {
    this._tables.set(blockId, table);
  }

  /** Register a loot table for a mob type id (wire `entityType`). */
  registerEntityTable(entityTypeId: number, table: LootTable): void {
    this._entityTables.set(entityTypeId, table);
  }

  /**
   * Resolve drops for a broken block.
   * Uses seeded RNG for chance rolls — never Math.random().
   * Returns an empty array if no loot table is registered.
   */
  resolve(blockId: number, rng: LootRng): ItemStack[] {
    const table = this._tables.get(blockId);
    if (table === undefined) return [];

    if (table.roll === "one_of") {
      return this.resolveOneOfWeighted(table.entries, rng);
    }

    const drops: ItemStack[] = [];

    for (const entry of table.entries) {
      if (rng.nextFloat() > entry.chance) continue;

      const def = this._items.getByKey(entry.itemKey);
      if (def === undefined) continue;

      const range = entry.countMax - entry.countMin;
      const count = entry.countMin + Math.floor(rng.nextFloat() * (range + 1));

      if (count <= 0) continue;
      drops.push({ itemId: def.id, count });
    }

    return drops;
  }

  /** Picks one entry by relative weights (`chance`), then rolls count within min–max. */
  private resolveOneOfWeighted(entries: LootEntry[], rng: LootRng): ItemStack[] {
    const weighted = entries.filter((e) => e.chance > 0);
    if (weighted.length === 0) return [];

    let total = 0;
    for (const e of weighted) total += e.chance;

    let r = rng.nextFloat() * total;
    let chosen = weighted[weighted.length - 1]!;
    for (const e of weighted) {
      r -= e.chance;
      if (r <= 0) {
        chosen = e;
        break;
      }
    }

    const def = this._items.getByKey(chosen.itemKey);
    if (def === undefined) return [];

    const range = chosen.countMax - chosen.countMin;
    const count = chosen.countMin + Math.floor(rng.nextFloat() * (range + 1));
    if (count <= 0) return [];
    return [{ itemId: def.id, count }];
  }

  /** Resolve item id from registry key; used for code-driven drops (e.g. sheep wool color). */
  tryGetItemIdByKey(itemKey: string): ItemId | undefined {
    return this._items.getByKey(itemKey)?.id;
  }

  /** Resolve drops for a killed mob (`entityTypeId` from the mob type enum). */
  resolveEntityLoot(entityTypeId: number, rng: LootRng): ItemStack[] {
    const table = this._entityTables.get(entityTypeId);
    if (table === undefined) return [];
    if (table.roll === "one_of") {
      return this.resolveOneOfWeighted(table.entries, rng);
    }
    const drops: ItemStack[] = [];
    for (const entry of table.entries) {
      if (rng.nextFloat() > entry.chance) continue;
      const def = this._items.getByKey(entry.itemKey);
      if (def === undefined) continue;
      const range = entry.countMax - entry.countMin;
      const count = entry.countMin + Math.floor(rng.nextFloat() * (range + 1));
      if (count <= 0) continue;
      drops.push({ itemId: def.id, count });
    }
    return drops;
  }
}
