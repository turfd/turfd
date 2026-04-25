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
    roll: z.enum(["each", "one_of"]).optional(),
    picksMin: z.number().int().positive().optional(),
    picksMax: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.picksMin !== undefined && value.roll !== "one_of") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "picksMin is only valid when roll is 'one_of'.",
        path: ["picksMin"],
      });
    }
    if (value.picksMax !== undefined && value.roll !== "one_of") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "picksMax is only valid when roll is 'one_of'.",
        path: ["picksMax"],
      });
    }
    if (
      value.picksMin !== undefined &&
      value.picksMax !== undefined &&
      value.picksMax < value.picksMin
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "picksMax must be >= picksMin.",
        path: ["picksMax"],
      });
    }
  });

const lootFileSchema = z
  .object({
    format_version: z.literal("1.0.0"),
    loot_tables: z.record(z.string(), lootTableSchema),
  })
  .strict();

const singleLootTableFileSchema = z
  .object({
    format_version: z.literal("1.0.0"),
    table_id: z.string(),
    table: lootTableSchema,
  })
  .strict();

const inlineSingleLootTableFileSchema = z
  .object({
    format_version: z.literal("1.0.0"),
    identifier: z.string(),
    entries: z.array(lootEntrySchema),
    roll: z.enum(["each", "one_of"]).optional(),
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
  const parsedMany = lootFileSchema.safeParse(raw);
  if (parsedMany.success) {
    const loot_tables: Record<string, LootTable> = {};
    for (const [key, table] of Object.entries(parsedMany.data.loot_tables)) {
      const t: LootTable = {
        entries: table.entries.map(normalizeEntry),
      };
      if (table.roll !== undefined) {
        t.roll = table.roll;
      }
      if (table.picksMin !== undefined) {
        t.picksMin = table.picksMin;
      }
      if (table.picksMax !== undefined) {
        t.picksMax = table.picksMax;
      }
      loot_tables[key] = t;
    }
    return {
      format_version: "1.0.0",
      loot_tables,
    };
  }

  const parsedSingle = singleLootTableFileSchema.safeParse(raw);
  if (parsedSingle.success) {
    const t: LootTable = {
      entries: parsedSingle.data.table.entries.map(normalizeEntry),
    };
    if (parsedSingle.data.table.roll !== undefined) {
      t.roll = parsedSingle.data.table.roll;
    }
    if (parsedSingle.data.table.picksMin !== undefined) {
      t.picksMin = parsedSingle.data.table.picksMin;
    }
    if (parsedSingle.data.table.picksMax !== undefined) {
      t.picksMax = parsedSingle.data.table.picksMax;
    }
    return {
      format_version: "1.0.0",
      loot_tables: {
        [parsedSingle.data.table_id]: t,
      },
    };
  }

  const parsedInlineSingle = inlineSingleLootTableFileSchema.safeParse(raw);
  if (parsedInlineSingle.success) {
    const t: LootTable = {
      entries: parsedInlineSingle.data.entries.map(normalizeEntry),
    };
    if (parsedInlineSingle.data.roll !== undefined) {
      t.roll = parsedInlineSingle.data.roll;
    }
    return {
      format_version: "1.0.0",
      loot_tables: {
        [parsedInlineSingle.data.identifier]: t,
      },
    };
  }

  const parsed = lootFileSchema.parse(raw);
  const loot_tables: Record<string, LootTable> = {};
  for (const [key, table] of Object.entries(parsed.loot_tables)) {
    const t: LootTable = {
      entries: table.entries.map(normalizeEntry),
    };
    if (table.roll !== undefined) {
      t.roll = table.roll;
    }
    if (table.picksMin !== undefined) {
      t.picksMin = table.picksMin;
    }
    if (table.picksMax !== undefined) {
      t.picksMax = table.picksMax;
    }
    loot_tables[key] = t;
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
  for (const [tableId, table] of Object.entries(data.loot_tables)) {
    resolver.registerNamedTable(tableId, table);
  }
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
  const duck = data.loot_tables["stratum:duck"];
  if (duck !== undefined) {
    resolver.registerEntityTable(MobType.Duck, duck);
  }
  const zombie = data.loot_tables["stratum:zombie"];
  if (zombie !== undefined) {
    resolver.registerEntityTable(MobType.Zombie, zombie);
  }
  const slime = data.loot_tables["stratum:slime"];
  if (slime !== undefined) {
    resolver.registerEntityTable(MobType.Slime, slime);
  }
}
