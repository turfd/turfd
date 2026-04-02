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
  readonly toolType?: "axe" | "pickaxe" | "shovel";
  readonly toolTier?: number;
  readonly toolSpeed?: number;
};

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
    "stratum:tool_type": z.enum(["axe", "pickaxe", "shovel"]).optional(),
    "stratum:tool_tier": z.number().int().min(0).optional(),
    "stratum:tool_speed": z.number().positive().optional(),
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
  };
}
