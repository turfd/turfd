/** DOM crafting sidebar: category tabs, recipe list, EventBus craft:request / craft:result. */

import type { EventBus } from "../core/EventBus";
import type { GameEvent } from "../core/types";
import type { RecipeDefinition } from "../core/recipe";
import type { ItemRegistry } from "../items/ItemRegistry";
import type { PlayerInventory } from "../items/PlayerInventory";
import type { ItemIconUrlLookup } from "./atlasItemIcon";
import { getItemIconStyleForDefinition } from "./atlasItemIcon";

export interface CraftingPanelDeps {
  getItemIconUrlLookup: () => ItemIconUrlLookup | null;
  getRecipes: () => readonly RecipeDefinition[];
  getCategories: () => readonly string[];
  /** When this toggles while open, the recipe list/tabs refresh (station-gated recipes). */
  getNearCraftingTable: () => boolean;
  canCraftOneBatch: (recipe: RecipeDefinition, inventory: PlayerInventory) => boolean;
  maxCraftableBatches: (recipe: RecipeDefinition, inventory: PlayerInventory) => number;
  getInventory: () => PlayerInventory;
}

const ICON_OUT_PX = 40;
const ICON_ING_PX = 32;

export class CraftingPanel {
  private readonly root: HTMLDivElement;
  private readonly tabsEl: HTMLDivElement;
  private readonly listEl: HTMLDivElement;
  private readonly hintEl: HTMLDivElement;
  private readonly bus: EventBus;
  private readonly itemRegistry: ItemRegistry;
  private readonly deps: CraftingPanelDeps;
  private activeCategory: string | null = null;
  private open = false;
  private hintTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly unsubResult: () => void;

  /** Recipes rendered in the current list, keyed by index for event delegation. */
  private renderedRecipes: RecipeDefinition[] = [];
  private lastNearCraftingTable: boolean | null = null;

  constructor(
    mount: HTMLElement,
    bus: EventBus,
    itemRegistry: ItemRegistry,
    deps: CraftingPanelDeps,
  ) {
    this.bus = bus;
    this.itemRegistry = itemRegistry;
    this.deps = deps;

    const root = document.createElement("div");
    root.className = "inv-crafting-sidebar";
    root.setAttribute("aria-hidden", "true");
    mount.appendChild(root);
    this.root = root;

    const inner = document.createElement("div");
    inner.className = "inv-crafting-sidebar-inner";

    const tabs = document.createElement("div");
    tabs.className = "inv-craft-tabs";
    tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", "Recipe categories");
    this.tabsEl = tabs;

    const body = document.createElement("div");
    body.className = "inv-craft-body";

    const title = document.createElement("div");
    title.className = "inv-craft-title";
    title.textContent = "Crafting";

    const list = document.createElement("div");
    list.className = "inv-craft-list";
    list.setAttribute("role", "listbox");
    this.listEl = list;

    const hint = document.createElement("div");
    hint.className = "inv-craft-hint";
    hint.setAttribute("aria-live", "polite");
    this.hintEl = hint;

    body.appendChild(title);
    body.appendChild(list);
    body.appendChild(hint);

    inner.appendChild(body);
    inner.appendChild(tabs);
    root.appendChild(inner);

    this.listEl.addEventListener("click", this.onListClick);

    this.unsubResult = this.bus.on("craft:result", (e) => {
      if (e.ok) {
        this.flashHint("");
      } else {
        this.flashHint(e.reason);
      }
    });
  }

  private readonly onListClick = (ev: MouseEvent): void => {
    if (!this.open) {
      return;
    }
    const row = (ev.target as HTMLElement).closest<HTMLElement>(".inv-craft-row");
    if (row === null) {
      return;
    }
    const idx = row.dataset.recipeIdx;
    if (idx === undefined) {
      return;
    }
    const recipe = this.renderedRecipes[Number(idx)];
    if (recipe === undefined) {
      return;
    }

    const invNow = this.deps.getInventory();
    if (!this.deps.canCraftOneBatch(recipe, invNow)) {
      this.flashHint(
        "Cannot craft — pick up nothing on the cursor, and keep materials in storage or hotbar.",
      );
      return;
    }
    const maxB = this.deps.maxCraftableBatches(recipe, invNow);
    const batches = ev.shiftKey ? maxB : 1;
    if (batches <= 0) {
      return;
    }
    this.bus.emit({
      type: "craft:request",
      recipeId: recipe.id,
      batches,
    } satisfies GameEvent);
  };

  private flashHint(text: string): void {
    if (this.hintTimer !== null) {
      clearTimeout(this.hintTimer);
      this.hintTimer = null;
    }
    this.hintEl.textContent = text;
    if (text !== "") {
      this.hintTimer = setTimeout(() => {
        this.hintTimer = null;
        this.hintEl.textContent = "";
      }, 2800);
    }
  }

  setOpen(open: boolean): void {
    this.open = open;
    if (open) {
      this.lastNearCraftingTable = this.deps.getNearCraftingTable();
      this.root.classList.add("inv-crafting-sidebar--open");
      this.root.setAttribute("aria-hidden", "false");
      this.ensureActiveCategory();
      this.rebuildTabs();
      this.rebuildList();
    } else {
      this.lastNearCraftingTable = null;
      this.root.classList.remove("inv-crafting-sidebar--open");
      this.root.setAttribute("aria-hidden", "true");
      if (this.hintTimer !== null) {
        clearTimeout(this.hintTimer);
        this.hintTimer = null;
      }
      this.hintEl.textContent = "";
    }
  }

  update(_inventory: PlayerInventory): void {
    if (!this.open) {
      return;
    }
    const near = this.deps.getNearCraftingTable();
    if (this.lastNearCraftingTable !== near) {
      this.lastNearCraftingTable = near;
      this.ensureActiveCategory();
      this.rebuildTabs();
      this.rebuildList();
    } else {
      this.updateAffordability();
    }
  }

  /**
   * Refresh only the dimmed/affordable state of existing rows
   * without destroying and recreating DOM elements.
   */
  private updateAffordability(): void {
    const inv = this.deps.getInventory();
    const rows = this.listEl.children;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] as HTMLElement;
      const recipe = this.renderedRecipes[i];
      if (recipe === undefined) continue;
      const affordable = this.deps.canCraftOneBatch(recipe, inv);
      if (affordable) {
        row.classList.remove("inv-craft-row--dimmed");
      } else {
        row.classList.add("inv-craft-row--dimmed");
      }
    }
  }

  private ensureActiveCategory(): void {
    const cats = this.deps.getCategories();
    if (cats.length === 0) {
      this.activeCategory = null;
      return;
    }
    if (this.activeCategory !== null && cats.includes(this.activeCategory)) {
      return;
    }
    const first = cats[0];
    this.activeCategory = first ?? null;
  }

  private rebuildTabs(): void {
    this.tabsEl.replaceChildren();
    const cats = this.deps.getCategories();
    this.ensureActiveCategory();

    for (const cat of cats) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "inv-craft-tab";
      btn.setAttribute("role", "tab");
      btn.setAttribute("aria-selected", cat === this.activeCategory ? "true" : "false");
      btn.dataset.category = cat;
      btn.textContent = cat;
      if (cat === this.activeCategory) {
        btn.classList.add("inv-craft-tab--active");
      }
      btn.addEventListener("click", () => {
        this.activeCategory = cat;
        this.rebuildTabs();
        this.rebuildList();
      });
      this.tabsEl.appendChild(btn);
    }
  }

  private rebuildList(): void {
    this.listEl.replaceChildren();
    this.renderedRecipes = [];
    const urlLookup = this.deps.getItemIconUrlLookup();
    const inv = this.deps.getInventory();
    const cat = this.activeCategory;
    if (cat === null) {
      return;
    }

    const recipes = this.deps.getRecipes().filter((r) => r.category === cat);
    for (let ri = 0; ri < recipes.length; ri++) {
      const recipe = recipes[ri]!;
      this.renderedRecipes.push(recipe);

      const row = document.createElement("div");
      row.className = "inv-craft-row";
      row.setAttribute("role", "option");
      row.dataset.recipeIdx = String(ri);

      const affordable = this.deps.canCraftOneBatch(recipe, inv);
      if (!affordable) {
        row.classList.add("inv-craft-row--dimmed");
      }

      const outDef = recipe.output.itemId !== undefined ? this.itemRegistry.getByKey(recipe.output.itemId) : undefined;
      const outWrap = document.createElement("div");
      outWrap.className = "inv-craft-out";

      const outSlot = document.createElement("div");
      outSlot.className = "inv-craft-out-slot";
      const outIcon = document.createElement("div");
      outIcon.className = "inv-craft-out-icon";
      if (outDef !== undefined && urlLookup !== null) {
        outIcon.style.cssText = getItemIconStyleForDefinition(outDef, urlLookup, ICON_OUT_PX);
      }
      outSlot.appendChild(outIcon);

      const meta = document.createElement("div");
      meta.className = "inv-craft-meta";

      const nameEl = document.createElement("div");
      nameEl.className = "inv-craft-name";
      nameEl.textContent =
        outDef !== undefined ? outDef.displayName : (recipe.output.itemId ?? "???");

      const ingRow = document.createElement("div");
      ingRow.className = "inv-craft-ingredients";
      for (const ing of recipe.ingredients) {
        const ingDef = ing.itemId !== undefined
          ? this.itemRegistry.getByKey(ing.itemId)
          : ing.tag !== undefined
            ? this.itemRegistry.getByTag(ing.tag)[0]
            : undefined;
        const cell = document.createElement("div");
        cell.className = "inv-craft-ing";
        const ingSlot = document.createElement("div");
        ingSlot.className = "inv-craft-ing-slot";
        const ic = document.createElement("div");
        ic.className = "inv-craft-ing-icon";
        if (ingDef !== undefined && urlLookup !== null) {
          ic.style.cssText = getItemIconStyleForDefinition(ingDef, urlLookup, ICON_ING_PX);
        }
        ingSlot.appendChild(ic);
        const cnt = document.createElement("span");
        cnt.className = "inv-craft-ing-count";
        cnt.textContent = String(ing.count);
        cell.appendChild(ingSlot);
        cell.appendChild(cnt);
        ingRow.appendChild(cell);
      }

      const mult = document.createElement("div");
      mult.className = "inv-craft-mult";
      mult.textContent = `× ${String(recipe.output.count)}`;

      meta.appendChild(nameEl);
      meta.appendChild(ingRow);

      outWrap.appendChild(outSlot);
      outWrap.appendChild(meta);
      outWrap.appendChild(mult);
      row.appendChild(outWrap);

      this.listEl.appendChild(row);
    }
  }

  destroy(): void {
    this.unsubResult();
    this.listEl.removeEventListener("click", this.onListClick);
    if (this.hintTimer !== null) {
      clearTimeout(this.hintTimer);
      this.hintTimer = null;
    }
    this.root.remove();
  }
}
