/** Recipe ingredient/output slots and crafting transaction results (data layer). */

export interface IngredientSlot {
  /** Specific item key. Mutually exclusive with `tag`. */
  readonly itemId?: string;
  /** Tag-based matching (any item with this tag satisfies the ingredient). Mutually exclusive with `itemId`. */
  readonly tag?: string;
  readonly count: number;
}

export interface RecipeDefinition {
  readonly id: string;
  readonly category: string;
  /** `null` = hand crafting anywhere; `stratum:crafting_table` = near that placed block (see constants). */
  readonly station: string | null;
  readonly ingredients: readonly IngredientSlot[];
  readonly output: IngredientSlot;
}

export type CraftResult =
  | { readonly ok: true; readonly crafted: number }
  | { readonly ok: false; readonly reason: string };
