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

/** `each`: every entry rolls its `chance` independently. `one_of`: pick weighted unique entries. */
export type LootRollMode = "each" | "one_of";

export type LootTable = {
  entries: LootEntry[];
  roll?: LootRollMode;
  /** For `one_of`: min unique entries to pick (default 1). */
  picksMin?: number;
  /** For `one_of`: max unique entries to pick (default picksMin). */
  picksMax?: number;
};

export class LootResolver implements ILootResolver {
  private readonly _tables = new Map<number, LootTable>();
  private readonly _tablesById = new Map<string, LootTable>();
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

  registerNamedTable(tableId: string, table: LootTable): void {
    this._tablesById.set(tableId, table);
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

  /** Picks weighted unique entries, then rolls each count within min–max. */
  private resolveOneOfWeighted(entries: LootEntry[], rng: LootRng): ItemStack[] {
    return this.resolveOneOfWeightedMulti(entries, rng, 1, 1);
  }

  private resolveOneOfWeightedMulti(
    entries: LootEntry[],
    rng: LootRng,
    picksMin: number,
    picksMax: number,
  ): ItemStack[] {
    const pool = entries.filter((e) => e.chance > 0);
    if (pool.length === 0) return [];
    const minPicks = Math.max(1, Math.min(pool.length, Math.floor(picksMin)));
    const maxPicks = Math.max(minPicks, Math.min(pool.length, Math.floor(picksMax)));
    const pickCount =
      minPicks + Math.floor(rng.nextFloat() * (maxPicks - minPicks + 1));
    const chosen: LootEntry[] = [];
    for (let p = 0; p < pickCount && pool.length > 0; p++) {
      let total = 0;
      for (let i = 0; i < pool.length; i++) total += pool[i]!.chance;
      let r = rng.nextFloat() * total;
      let pickIdx = pool.length - 1;
      for (let i = 0; i < pool.length; i++) {
        r -= pool[i]!.chance;
        if (r <= 0) {
          pickIdx = i;
          break;
        }
      }
      const [picked] = pool.splice(pickIdx, 1);
      if (picked !== undefined) {
        chosen.push(picked);
      }
    }
    const drops: ItemStack[] = [];
    for (let i = 0; i < chosen.length; i++) {
      const pick = chosen[i]!;
      const def = this._items.getByKey(pick.itemKey);
      if (def === undefined) continue;
      const range = pick.countMax - pick.countMin;
      const count = pick.countMin + Math.floor(rng.nextFloat() * (range + 1));
      if (count <= 0) continue;
      drops.push({ itemId: def.id, count });
    }
    return drops;
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
      return this.resolveOneOfWeightedMulti(
        table.entries,
        rng,
        table.picksMin ?? 1,
        table.picksMax ?? (table.picksMin ?? 1),
      );
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

  resolveNamedTable(tableId: string, rng: LootRng): ItemStack[] {
    const table = this._tablesById.get(tableId);
    if (table === undefined) {
      return [];
    }
    if (table.roll === "one_of") {
      return this.resolveOneOfWeightedMulti(
        table.entries,
        rng,
        table.picksMin ?? 1,
        table.picksMax ?? (table.picksMin ?? 1),
      );
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
