import { z } from "zod";

const STRUCTURE_FORMAT = "stratum-structure-v1";

const blockCellSchema = z
  .object({
    x: z.number().int(),
    y: z.number().int(),
    foreground: z
      .object({
        identifier: z.string().min(1),
        metadata: z.number().int().default(0),
        id: z.number().int().optional(),
      })
      .strict(),
    background: z
      .object({
        identifier: z.string().min(1),
        metadata: z.number().int().default(0),
        id: z.number().int().optional(),
      })
      .strict(),
  })
  .strict();

const legacyStackSchema = z
  .object({
    itemId: z.number().int().positive(),
    count: z.number().int().positive(),
    damage: z.number().int().nonnegative().optional(),
  })
  .strict();

const normalizedStackSchema = z
  .object({
    key: z.string().min(1),
    count: z.number().int().positive(),
    damage: z.number().int().nonnegative().optional(),
  })
  .strict();

const containerEntitySchema = z
  .object({
    type: z.literal("container"),
    x: z.number().int(),
    y: z.number().int(),
    identifier: z.string().min(1),
    lootTable: z.string().min(1).optional(),
    items: z.array(normalizedStackSchema.nullable()).nullable().optional(),
  })
  .strict();

const furnaceEntitySchema = z
  .object({
    type: z.literal("furnace"),
    x: z.number().int(),
    y: z.number().int(),
    state: z.unknown(),
  })
  .strict();

const modernTileEntitiesSchema = z
  .object({
    entities: z.array(z.union([containerEntitySchema, furnaceEntitySchema])).default([]),
  })
  .strip();

const legacyContainerSchema = z
  .object({
    wx: z.number().int().optional(),
    wy: z.number().int().optional(),
    x: z.number().int().optional(),
    y: z.number().int().optional(),
    identifier: z.string().min(1).optional(),
    lootTable: z.string().min(1).optional(),
    state: z
      .object({
        slots: z.array(z.union([legacyStackSchema, normalizedStackSchema, z.null()])).default([]),
      })
      .strict(),
  })
  .strict();

const legacyFurnaceSchema = z
  .object({
    wx: z.number().int().optional(),
    wy: z.number().int().optional(),
    x: z.number().int().optional(),
    y: z.number().int().optional(),
    state: z.unknown(),
  })
  .strict();

const legacyTileEntitiesSchema = z
  .object({
    containers: z.array(legacyContainerSchema).default([]),
    furnaces: z.array(legacyFurnaceSchema).default([]),
  })
  .strip();

const structureSchema = z
  .object({
    format: z.literal(STRUCTURE_FORMAT),
    exportedAt: z.string().optional(),
    world: z.unknown().optional(),
    selection: z
      .object({
        bounds: z
          .object({
            minWx: z.number().int(),
            minWy: z.number().int(),
            maxWx: z.number().int(),
            maxWy: z.number().int(),
          })
          .strip(),
      })
      .strip()
      .optional(),
    blocks: z.array(blockCellSchema),
    tileEntities: z.union([modernTileEntitiesSchema, legacyTileEntitiesSchema]).optional(),
  })
  .strip();

export type StructureContainerEntity = z.infer<typeof containerEntitySchema>;
export type StructureFurnaceEntity = z.infer<typeof furnaceEntitySchema>;
export type StructureEntity = StructureContainerEntity | StructureFurnaceEntity;

export type ParsedStructure = {
  format: typeof STRUCTURE_FORMAT;
  width: number;
  height: number;
  blocks: z.infer<typeof blockCellSchema>[];
  entities: StructureEntity[];
};

function normalizeLegacySlot(
  raw: z.infer<typeof legacyStackSchema> | z.infer<typeof normalizedStackSchema> | null,
): z.infer<typeof normalizedStackSchema> | null {
  if (raw === null) {
    return null;
  }
  if ("key" in raw) {
    return raw;
  }
  // Legacy exports use numeric item ids. Keep compatibility by preserving placeholders:
  // these remain null unless a future migration map is supplied by caller.
  return null;
}

function deriveLocalPos(
  entity: { x?: number; y?: number; wx?: number; wy?: number },
  minWx: number,
  minWy: number,
): { x: number; y: number } | null {
  if (typeof entity.x === "number" && typeof entity.y === "number") {
    return { x: entity.x, y: entity.y };
  }
  if (typeof entity.wx === "number" && typeof entity.wy === "number") {
    return { x: entity.wx - minWx, y: entity.wy - minWy };
  }
  return null;
}

function computeSize(blocks: z.infer<typeof blockCellSchema>[]): { width: number; height: number } {
  if (blocks.length === 0) {
    return { width: 0, height: 0 };
  }
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const b of blocks) {
    minX = Math.min(minX, b.x);
    maxX = Math.max(maxX, b.x);
    minY = Math.min(minY, b.y);
    maxY = Math.max(maxY, b.y);
  }
  return { width: maxX - minX + 1, height: maxY - minY + 1 };
}

export function parseStructureJson(raw: unknown): ParsedStructure {
  const parsed = structureSchema.parse(raw);
  const minWx = parsed.selection?.bounds.minWx ?? 0;
  const minWy = parsed.selection?.bounds.minWy ?? 0;
  const entities: StructureEntity[] = [];
  if (parsed.tileEntities !== undefined && "entities" in parsed.tileEntities) {
    entities.push(...parsed.tileEntities.entities);
  } else if (parsed.tileEntities !== undefined) {
    for (const c of parsed.tileEntities.containers) {
      const pos = deriveLocalPos(c, minWx, minWy);
      if (pos === null) {
        continue;
      }
      entities.push({
        type: "container",
        x: pos.x,
        y: pos.y,
        identifier: c.identifier ?? "stratum:chest",
        lootTable: c.lootTable,
        items: c.state.slots.map((s) => normalizeLegacySlot(s)),
      });
    }
    for (const f of parsed.tileEntities.furnaces) {
      const pos = deriveLocalPos(f, minWx, minWy);
      if (pos === null) {
        continue;
      }
      entities.push({
        type: "furnace",
        x: pos.x,
        y: pos.y,
        state: f.state,
      });
    }
  }
  const size = computeSize(parsed.blocks);
  return {
    format: STRUCTURE_FORMAT,
    width: size.width,
    height: size.height,
    blocks: parsed.blocks,
    entities,
  };
}

export const FeaturePlacementPassSchema = z.enum(["underground", "surface"]);

export const structureFeatureSchema = z
  .object({
    format_version: z.literal("1.0.0"),
    "stratum:feature": z
      .object({
        description: z
          .object({
            identifier: z.string().min(1),
            structure: z.string().min(1).optional(),
            structures: z.array(z.string().min(1)).min(1).optional(),
          })
          .strip(),
        placement: z
          .object({
            pass: FeaturePlacementPassSchema,
            biomes: z.array(z.string()).default(["any"]),
            min_depth: z.number().int().default(0),
            max_depth: z.number().int().default(0),
            frequency: z.number().min(0).max(1),
            anchor: z.enum(["top_left"]).default("top_left"),
            terrain: z
              .object({
                mode: z.enum(["none", "flatten"]).default("none"),
                pad_x: z.number().int().nonnegative().default(0),
                pad_y: z.number().int().nonnegative().default(0),
                max_slope: z.number().int().nonnegative().default(999),
              })
              .strict()
              .optional(),
            clearance: z
              .object({
                height: z.number().int().nonnegative().default(0),
              })
              .strict()
              .optional(),
            suppress_vegetation: z.boolean().default(false),
          })
          .strict(),
      })
      .strip(),
  })
  .strip()
  .superRefine((feature, ctx) => {
    const d = feature["stratum:feature"].description;
    if (d.structure === undefined && d.structures === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Feature description must define 'structure' or 'structures'.",
        path: ["stratum:feature", "description"],
      });
    }
  });

export type ParsedStructureFeature = z.infer<typeof structureFeatureSchema>;

export function parseStructureFeatureJson(raw: unknown): ParsedStructureFeature {
  return structureFeatureSchema.parse(raw);
}
