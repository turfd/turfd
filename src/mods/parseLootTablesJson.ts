/**
 * Validates `blocks.loot.json` (loot table definitions keyed by namespaced table id).
 */
import { z } from "zod";
import type { LootEntry, LootTable } from "../items/LootResolver";

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
