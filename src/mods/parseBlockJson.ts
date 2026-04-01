/**
 * Validates raw block JSON with Zod (strict keys) and maps to {@link BlockDefinitionBase}.
 */
import { z } from "zod";
import type { BlockDefinitionBase, BlockMaterial } from "../core/blockDefinition";

const blockMaterialSchema = z.enum([
  "stone",
  "dirt",
  "wood",
  "grass",
  "sand",
  "glass",
  "generic",
]);

const stratumBlockComponentsSchema = z
  .object({
    "stratum:display_name": z.string(),
    "stratum:texture": z.object({ all: z.string() }).strict(),
    "stratum:solid": z.boolean(),
    "stratum:transparent": z.boolean(),
    "stratum:water": z.boolean(),
    "stratum:hardness": z.number(),
    "stratum:light_emission": z.number().int().min(0).max(15),
    "stratum:light_absorption": z.number().int().min(0).max(15),
    "stratum:loot_table": z.string().optional(),
    "stratum:material": blockMaterialSchema.optional(),
    "stratum:random_flip_x": z.boolean().optional(),
    "stratum:replaceable": z.boolean().optional(),
    "stratum:tall_grass": z.enum(["none", "bottom", "top"]).optional(),
    "stratum:plant_foot_offset_px": z.number().int().min(0).max(15).optional(),
  })
  .strict();

const stratumBlockJsonSchema = z
  .object({
    format_version: z.literal("1.0.0"),
    "stratum:block": z
      .object({
        description: z.object({ identifier: z.string() }).strict(),
        components: stratumBlockComponentsSchema,
      })
      .strict(),
  })
  .strict();

/**
 * Parse and validate block JSON. Unknown top-level or component keys fail Zod `.strict()`.
 */
export function parseBlockJson(raw: unknown): BlockDefinitionBase {
  const parsed = stratumBlockJsonSchema.parse(raw);
  const block = parsed["stratum:block"];
  const c = block.components;
  const loot = c["stratum:loot_table"];
  const material: BlockMaterial = c["stratum:material"] ?? "generic";
  return {
    identifier: block.description.identifier,
    displayName: c["stratum:display_name"],
    textureName: c["stratum:texture"].all,
    randomFlipX: c["stratum:random_flip_x"],
    solid: c["stratum:solid"],
    transparent: c["stratum:transparent"],
    water: c["stratum:water"],
    hardness: c["stratum:hardness"],
    lightEmission: c["stratum:light_emission"],
    lightAbsorption: c["stratum:light_absorption"],
    drops: loot !== undefined ? [loot] : [],
    lootTable: loot,
    material,
    replaceable: c["stratum:replaceable"] ?? false,
    tallGrass: c["stratum:tall_grass"] ?? "none",
    plantFootOffsetPx: c["stratum:plant_foot_offset_px"],
  };
}
