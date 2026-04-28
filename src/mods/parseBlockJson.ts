/**
 * Validates raw block JSON with Zod (strict keys) and maps to {@link BlockDefinitionBase}.
 */
import { z } from "zod";
import type { BlockDefinitionBase, BlockMaterial } from "../core/blockDefinition";

/** Block JSON after parse; runtime numeric ids are assigned by {@link BlockRegistry}. */
export type ParsedBlockDefinition = BlockDefinitionBase;

const blockMaterialSchema = z.enum([
  "stone",
  "dirt",
  "wood",
  "grass",
  "sand",
  "gravel",
  "glass",
  "door",
  "chest",
  "furnace",
  "generic",
]);

const stratumBlockComponentsSchema = z
  .object({
    "stratum:display_name": z.string(),
    "stratum:texture": z.object({ all: z.string() }).strict(),
    "stratum:solid": z.boolean(),
    /** When set, overrides physics collision; defaults to `stratum:solid`. */
    "stratum:collision": z.boolean().optional(),
    "stratum:transparent": z.boolean(),
    "stratum:water": z.boolean(),
    "stratum:hardness": z.number(),
    "stratum:harvest_tool": z.enum(["axe", "pickaxe", "shovel"]).optional(),
    "stratum:requires_tool_for_drops": z.boolean().optional(),
    "stratum:min_tool_tier": z.number().int().min(0).optional(),
    "stratum:light_emission": z.number().int().min(0).max(15),
    "stratum:light_absorption": z.number().int().min(0).max(15),
    "stratum:loot_table": z.string().optional(),
    "stratum:material": blockMaterialSchema.optional(),
    "stratum:random_flip_x": z.boolean().optional(),
    /** Enables per-chunk leaf decoration mesh (stacked overlay + edge puffs). */
    "stratum:decoration_leaves": z.boolean().optional(),
    "stratum:replaceable": z.boolean().optional(),
    "stratum:tall_grass": z.enum(["none", "bottom", "top"]).optional(),
    "stratum:door_half": z.enum(["bottom", "top"]).optional(),
    "stratum:bed_half": z.enum(["foot", "head"]).optional(),
    "stratum:plant_foot_offset_px": z.number().int().min(0).max(15).optional(),
    /** Whole-pixel vertical shift for plant quads after foot crop (see {@link BlockDefinitionBase.plantRenderOffsetYPx}). */
    "stratum:plant_render_offset_y_px": z.number().int().min(-8).max(8).optional(),
    /** Whole-pixel horizontal sway for plants (see {@link BlockDefinitionBase.windSwayMaxPx}). */
    "stratum:wind_sway_max_px": z.number().int().min(1).max(3).optional(),
    "stratum:tags": z.array(z.string()).optional(),
    /** Furnace: burn time per block item (`burn_seconds` per consumed unit). */
    "stratum:fuel": z.object({ burn_seconds: z.number().positive() }).strict().optional(),
    "stratum:stair": z.boolean().optional(),
    /**
     * When true, skips auto-creating a block-item for this block.
     * A standalone item JSON can provide the corresponding item definition.
     */
    "stratum:no_block_item": z.boolean().optional(),
    /** Multi-cell painting block placed on background walls. */
    "stratum:is_painting": z.boolean().optional(),
    /** Spawner defaults for newly placed tile entities. */
    "stratum:spawner_defaults": z
      .object({
        delay: z.number().int().min(0),
        max_count: z.number().int().min(0),
        player_range: z.number().int().min(0),
        spawn_range: z.number().int().min(0),
        spawn_potentials: z.array(z.string().min(1)).min(1),
      })
      .strict()
      .optional(),
    /**
     * When false, skips contact-shadow bands on background tiles next to this foreground cell.
     * Omitted: solid + non-`transparent` blocks cast; solid transparent (e.g. glass) do not.
     */
    "stratum:casts_fg_contact_shadow": z.boolean().optional(),
    /** When true, back-wall tile at same cell still renders behind this block (partial-tile / mod art). */
    "stratum:reveals_background_wall": z.boolean().optional(),
    /** Legacy field; ignored (runtime ids are host/session-local). */
    "stratum:numeric_id": z.number().int().min(0).max(65535).optional(),
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
export function parseBlockJson(raw: unknown): ParsedBlockDefinition {
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
    decorationLeaves: c["stratum:decoration_leaves"],
    solid: c["stratum:solid"],
    collides: c["stratum:collision"] ?? c["stratum:solid"],
    transparent: c["stratum:transparent"],
    water: c["stratum:water"],
    hardness: c["stratum:hardness"],
    harvestToolType: c["stratum:harvest_tool"],
    requiresToolForDrops: c["stratum:requires_tool_for_drops"] ?? false,
    minToolTier: c["stratum:min_tool_tier"] ?? 0,
    lightEmission: c["stratum:light_emission"],
    lightAbsorption: c["stratum:light_absorption"],
    drops: loot !== undefined ? [loot] : [],
    lootTable: loot,
    material,
    replaceable: c["stratum:replaceable"] ?? false,
    tallGrass: c["stratum:tall_grass"] ?? "none",
    doorHalf: c["stratum:door_half"] ?? "none",
    bedHalf: c["stratum:bed_half"] ?? "none",
    plantFootOffsetPx: c["stratum:plant_foot_offset_px"],
    plantRenderOffsetYPx: c["stratum:plant_render_offset_y_px"],
    windSwayMaxPx: c["stratum:wind_sway_max_px"],
    tags: c["stratum:tags"],
    fuelBurnSeconds: c["stratum:fuel"]?.burn_seconds,
    ...(c["stratum:stair"] === true ? { isStair: true as const } : {}),
    ...(c["stratum:no_block_item"] === true ? { noBlockItem: true as const } : {}),
    ...(c["stratum:is_painting"] === true ? { isPainting: true as const } : {}),
    ...(c["stratum:spawner_defaults"] !== undefined
      ? {
          spawnerDefaults: {
            delay: c["stratum:spawner_defaults"].delay,
            maxCount: c["stratum:spawner_defaults"].max_count,
            playerRange: c["stratum:spawner_defaults"].player_range,
            spawnRange: c["stratum:spawner_defaults"].spawn_range,
            spawnPotentials: c["stratum:spawner_defaults"].spawn_potentials,
          },
        }
      : {}),
    ...(c["stratum:casts_fg_contact_shadow"] !== undefined
      ? { castsFgContactShadow: c["stratum:casts_fg_contact_shadow"] }
      : {}),
    ...(c["stratum:reveals_background_wall"] === true
      ? { revealsBackgroundWall: true as const }
      : {}),
  };
}
