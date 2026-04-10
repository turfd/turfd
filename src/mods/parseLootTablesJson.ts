/**
 * Validates `blocks.loot.json` (loot table definitions keyed by namespaced table id).
 */
import { z } from "zod";
import type { BlockRegistry } from "../world/blocks/BlockRegistry";
import type { LootEntry, LootResolver, LootTable } from "../items/LootResolver";
import { MobType } from "../entities/mobs/mobTypes";

const lootEntrySchema = z
  .object({
    itemKey: z.string(),
    countMin: z.number().int(),
    countMax: z.number().int(),
    chance: z.number().min(0).max(1).optional(),
  })
  .strict();

const lootTableSchema = z
  .object({
    entries: z.array(lootEntrySchema),
  })
  .strict();

const lootFileSchema = z
  .object({
    format_version: z.literal("1.0.0"),
    loot_tables: z.record(z.string(), lootTableSchema),
  })
  .strict();

export type LootTablesFile = {
  format_version: "1.0.0";
  loot_tables: Record<string, LootTable>;
};

function normalizeEntry(raw: z.infer<typeof lootEntrySchema>): LootEntry {
  return {
    itemKey: raw.itemKey,
    countMin: raw.countMin,
    countMax: raw.countMax,
    chance: raw.chance ?? 1,
  };
}

export function parseLootTablesJson(raw: unknown): LootTablesFile {
  const parsed = lootFileSchema.parse(raw);
  const loot_tables: Record<string, LootTable> = {};
  for (const [key, table] of Object.entries(parsed.loot_tables)) {
    loot_tables[key] = {
      entries: table.entries.map(normalizeEntry),
    };
  }
  return {
    format_version: "1.0.0",
    loot_tables,
  };
}

/** Registers loot tables for every block that references a table id present in `data`. */
export function registerLootTablesForBlocks(
  registry: BlockRegistry,
  resolver: LootResolver,
  data: LootTablesFile,
): void {
  for (let i = 0; i < registry.size; i++) {
    const block = registry.getById(i);
    const key = block.lootTable;
    if (key === undefined) {
      continue;
    }
    const table = data.loot_tables[key];
    if (table === undefined) {
      continue;
    }
    resolver.registerTable(block.id, table);
  }
}

/**
 * Entity death loot (keys like `stratum:sheep` → wire mob type id).
 * Same JSON shape as block loot tables.
 */
export function registerEntityLootTables(
  resolver: LootResolver,
  data: LootTablesFile,
): void {
  const sheep = data.loot_tables["stratum:sheep"];
  if (sheep !== undefined) {
    resolver.registerEntityTable(MobType.Sheep, sheep);
  }
  const pig = data.loot_tables["stratum:pig"];
  if (pig !== undefined) {
    resolver.registerEntityTable(MobType.Pig, pig);
  }
  const zombie = data.loot_tables["stratum:zombie"];
  if (zombie !== undefined) {
    resolver.registerEntityTable(MobType.Zombie, zombie);
  }
}
