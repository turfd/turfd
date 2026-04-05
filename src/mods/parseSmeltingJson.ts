import { z } from "zod";
import type { FuelEntryDef, SmeltingRecipeDef } from "../world/SmeltingRegistry";

const ingredientSlotSchema = z
  .object({
    itemId: z.string().min(1).optional(),
    tag: z.string().min(1).optional(),
  })
  .refine((o) => (o.itemId !== undefined) !== (o.tag !== undefined), {
    message: "Exactly one of itemId or tag",
  });

const recipeSchema = z.object({
  id: z.string().min(1),
  input: ingredientSlotSchema,
  output: z.object({
    itemId: z.string().min(1),
    count: z.number().int().min(1),
  }),
  cook_time_sec: z.number().positive(),
});

const fuelEntrySchema = z
  .object({
    itemId: z.string().min(1).optional(),
    tag: z.string().min(1).optional(),
    burn_seconds: z.number().positive(),
  })
  .refine((o) => (o.itemId !== undefined) !== (o.tag !== undefined), {
    message: "Exactly one of itemId or tag",
  });

const smeltingFileSchema = z
  .object({
    format_version: z.literal("1.0.0"),
    recipes: z.array(recipeSchema),
  })
  .strict();

const fuelFileSchema = z
  .object({
    format_version: z.literal("1.0.0"),
    entries: z.array(fuelEntrySchema),
  })
  .strict();

export function parseSmeltingRecipesJson(raw: unknown): SmeltingRecipeDef[] {
  const p = smeltingFileSchema.parse(raw);
  return p.recipes.map((r) => ({
    id: r.id,
    inputItemKey: r.input.itemId,
    inputTag: r.input.tag,
    outputItemKey: r.output.itemId,
    outputCount: r.output.count,
    cookTimeSec: r.cook_time_sec,
  }));
}

export function parseFurnaceFuelJson(raw: unknown): FuelEntryDef[] {
  const p = fuelFileSchema.parse(raw);
  return p.entries.map((e) => ({
    itemKey: e.itemId,
    tag: e.tag,
    burnSeconds: e.burn_seconds,
  }));
}
