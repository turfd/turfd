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

const turfdBlockComponentsSchema = z
  .object({
    "turfd:display_name": z.string(),
    "turfd:texture": z.object({ all: z.string() }).strict(),
    "turfd:solid": z.boolean(),
    "turfd:transparent": z.boolean(),
    "turfd:water": z.boolean(),
    "turfd:hardness": z.number(),
    "turfd:light_emission": z.number().int().min(0).max(15),
    "turfd:light_absorption": z.number().int().min(0).max(15),
    "turfd:loot_table": z.string().optional(),
    "turfd:material": blockMaterialSchema.optional(),
    "turfd:random_flip_x": z.boolean().optional(),
    "turfd:replaceable": z.boolean().optional(),
    "turfd:tall_grass": z.enum(["none", "bottom", "top"]).optional(),
    "turfd:plant_foot_offset_px": z.number().int().min(0).max(15).optional(),
  })
  .strict();

const turfdBlockJsonSchema = z
  .object({
    format_version: z.literal("1.0.0"),
    "turfd:block": z
      .object({
        description: z.object({ identifier: z.string() }).strict(),
        components: turfdBlockComponentsSchema,
      })
      .strict(),
  })
  .strict();

/**
 * Parse and validate block JSON. Unknown top-level or component keys fail Zod `.strict()`.
 */
export function parseBlockJson(raw: unknown): BlockDefinitionBase {
  const parsed = turfdBlockJsonSchema.parse(raw);
  const block = parsed["turfd:block"];
  const c = block.components;
  const loot = c["turfd:loot_table"];
  const material: BlockMaterial = c["turfd:material"] ?? "generic";
  return {
    identifier: block.description.identifier,
    displayName: c["turfd:display_name"],
    textureName: c["turfd:texture"].all,
    randomFlipX: c["turfd:random_flip_x"],
    solid: c["turfd:solid"],
    transparent: c["turfd:transparent"],
    water: c["turfd:water"],
    hardness: c["turfd:hardness"],
    lightEmission: c["turfd:light_emission"],
    lightAbsorption: c["turfd:light_absorption"],
    drops: loot !== undefined ? [loot] : [],
    lootTable: loot,
    material,
    replaceable: c["turfd:replaceable"] ?? false,
    tallGrass: c["turfd:tall_grass"] ?? "none",
    plantFootOffsetPx: c["turfd:plant_foot_offset_px"],
  };
}
