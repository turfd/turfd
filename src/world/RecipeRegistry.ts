/** Runtime map of recipe id → {@link RecipeDefinition} (populated at startup from JSON). */

import type { RecipeDefinition } from "../core/recipe";

export class RecipeRegistry {
  private readonly byId = new Map<string, RecipeDefinition>();

  register(def: RecipeDefinition): void {
    if (this.byId.has(def.id)) {
      throw new Error(`RecipeRegistry: duplicate recipe id '${def.id}'`);
    }
    this.byId.set(def.id, def);
  }

  registerAll(defs: readonly RecipeDefinition[]): void {
    for (const d of defs) {
      this.register(d);
    }
  }

  getById(id: string): RecipeDefinition | undefined {
    return this.byId.get(id);
  }

  /** All recipes, arbitrary order. */
  all(): readonly RecipeDefinition[] {
    return [...this.byId.values()];
  }

  /** Distinct category labels for UI tabs, sorted lexicographically. */
  categories(): readonly string[] {
    const set = new Set<string>();
    for (const r of this.byId.values()) {
      set.add(r.category);
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }
}
