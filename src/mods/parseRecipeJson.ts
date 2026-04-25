/**
 * Validates raw recipe pack JSON with Zod (strict keys) and maps to {@link RecipeDefinition}.
 */
import { z } from "zod";
import type { IngredientSlot, RecipeDefinition } from "../core/recipe";

const ingredientSlotSchema = z
  .object({
    itemId: z.string().min(1).optional(),
    tag: z.string().min(1).optional(),
    count: z.number().int().positive(),
  })
  .strict()
  .refine((s) => (s.itemId !== undefined) !== (s.tag !== undefined), {
    message: "Ingredient must have exactly one of itemId or tag",
  });

const outputSlotSchema = z
  .object({
    itemId: z.string().min(1),
    count: z.number().int().positive(),
  })
  .strict();

const recipeEntrySchema = z
  .object({
    id: z.string().min(1),
    category: z.string().min(1),
    station: z.string().nullable(),
    ingredients: z.array(ingredientSlotSchema).min(1),
    output: outputSlotSchema,
  })
  .strict();

const recipesFileSchema = z
  .object({
    format_version: z.literal("1.0.0"),
    recipes: z.array(recipeEntrySchema).min(1),
  })
  .strict();

const singleRecipeFileSchema = z
  .object({
    format_version: z.literal("1.0.0"),
    recipe: recipeEntrySchema,
  })
  .strict();

function toIngredientSlot(s: z.infer<typeof ingredientSlotSchema>): IngredientSlot {
  return { itemId: s.itemId, tag: s.tag, count: s.count };
}

/**
 * Parse and validate recipe JSON. Unknown top-level or recipe keys fail Zod `.strict()`.
 */
export function parseRecipeJson(raw: unknown): readonly RecipeDefinition[] {
  const parsedArray = recipesFileSchema.safeParse(raw);
  if (parsedArray.success) {
    const out: RecipeDefinition[] = [];
    for (const r of parsedArray.data.recipes) {
      out.push({
        id: r.id,
        category: r.category,
        station: r.station,
        ingredients: r.ingredients.map(toIngredientSlot),
        output: { itemId: r.output.itemId, count: r.output.count },
      });
    }
    return out;
  }

  const parsedSingle = singleRecipeFileSchema.safeParse(raw);
  if (parsedSingle.success) {
    const r = parsedSingle.data.recipe;
    return [
      {
        id: r.id,
        category: r.category,
        station: r.station,
        ingredients: r.ingredients.map(toIngredientSlot),
        output: { itemId: r.output.itemId, count: r.output.count },
      },
    ];
  }

  const parsedLooseEntry = recipeEntrySchema.safeParse(raw);
  if (parsedLooseEntry.success) {
    const r = parsedLooseEntry.data;
    return [
      {
        id: r.id,
        category: r.category,
        station: r.station,
        ingredients: r.ingredients.map(toIngredientSlot),
        output: { itemId: r.output.itemId, count: r.output.count },
      },
    ];
  }

  const parsed = recipesFileSchema.parse(raw);
  const out: RecipeDefinition[] = [];
  for (const r of parsed.recipes) {
    out.push({
      id: r.id,
      category: r.category,
      station: r.station,
      ingredients: r.ingredients.map(toIngredientSlot),
      output: { itemId: r.output.itemId, count: r.output.count },
    });
  }
  return out;
}
