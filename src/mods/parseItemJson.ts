/**
 * Validates item mod JSON (strict keys) for non-block items.
 */
import { z } from "zod";
import { MAX_STACK_DEFAULT } from "../core/itemDefinition";

export type ItemModDefinition = {
  readonly identifier: string;
  readonly displayName: string;
  readonly textureKey: string;
  readonly maxStack: number;
  readonly placesBlockIdentifier?: string;
  readonly toolType?: "axe" | "pickaxe" | "shovel" | "hoe";
  readonly toolTier?: number;
  readonly toolSpeed?: number;
  readonly maxDurability?: number;
  readonly fuelBurnSeconds?: number;
  readonly tags?: readonly string[];
  /** HP restored when eaten (right-click in world). */
  readonly eatRestoreHealth?: number;
  /**
   * When set, `eatRestoreHealth` is **temporary** HP (expires after this many seconds).
   */
  readonly eatTemporaryDurationSec?: number;
  readonly inventoryTooltip?: string;
};

/** Alias for parsed workshop / core item JSON. */
export type ParsedItemDefinition = ItemModDefinition;

const stratumItemComponentsSchema = z
  .object({
    "stratum:display_name": z.string(),
    "stratum:max_stack": z.number().int().min(1).optional(),
    /**
     * Lookup key in `item_texture_manifest.json` or `block_texture_manifest.json`
     * (item manifest first). Defaults to the short id after `:`.
     */
    "stratum:texture_key": z.string().min(1).optional(),
    /** Block identifier this item places, e.g. `stratum:tall_grass_bottom`. */
    "stratum:places_block": z.string().min(1).optional(),
    "stratum:tool_type": z.enum(["axe", "pickaxe", "shovel", "hoe"]).optional(),
    "stratum:tool_tier": z.number().int().min(0).optional(),
    "stratum:tool_speed": z.number().positive().optional(),
    "stratum:max_durability": z.number().int().min(1).optional(),
    "stratum:fuel": z.object({ burn_seconds: z.number().positive() }).strict().optional(),
    "stratum:tags": z.array(z.string()).optional(),
    /** Legacy field; ignored (runtime ids are assigned by registry). */
    "stratum:numeric_id": z.number().int().min(1).max(65535).optional(),
    "stratum:eat_restore_health": z.number().int().min(1).optional(),
    "stratum:eat_temporary_duration_sec": z.number().positive().optional(),
    "stratum:inventory_tooltip": z.string().min(1).optional(),
  })
  .strict();

const stratumItemJsonSchema = z
  .object({
    format_version: z.literal("1.0.0"),
    "stratum:item": z
      .object({
        description: z.object({ identifier: z.string().min(1) }).strict(),
        components: stratumItemComponentsSchema,
      })
      .strict(),
  })
  .strict();

export function parseItemJson(raw: unknown): ItemModDefinition {
  const parsed = stratumItemJsonSchema.parse(raw);
  const item = parsed["stratum:item"];
  const c = item.components;
  const id = item.description.identifier;
  const tail = id.includes(":") ? (id.split(":").pop() ?? id) : id;
  const textureKey = c["stratum:texture_key"] ?? tail;
  return {
    identifier: id,
    displayName: c["stratum:display_name"],
    textureKey,
    maxStack: c["stratum:max_stack"] ?? MAX_STACK_DEFAULT,
    placesBlockIdentifier: c["stratum:places_block"],
    toolType: c["stratum:tool_type"],
    toolTier: c["stratum:tool_tier"],
    toolSpeed: c["stratum:tool_speed"],
    maxDurability: c["stratum:max_durability"],
    fuelBurnSeconds: c["stratum:fuel"]?.burn_seconds,
    tags: c["stratum:tags"],
    eatRestoreHealth: c["stratum:eat_restore_health"],
    eatTemporaryDurationSec: c["stratum:eat_temporary_duration_sec"],
    inventoryTooltip: c["stratum:inventory_tooltip"],
  };
}
