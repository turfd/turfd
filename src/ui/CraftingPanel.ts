/** DOM crafting sidebar: category tabs, recipe list, EventBus craft:request / craft:result. */

import type { EventBus } from "../core/EventBus";
import type { GameEvent } from "../core/types";
import type { IngredientSlot, RecipeDefinition } from "../core/recipe";
import type { ItemRegistry } from "../items/ItemRegistry";
import type { PlayerInventory } from "../items/PlayerInventory";
import type { ItemIconUrlLookup } from "./atlasItemIcon";
import { getItemIconStyleForDefinition } from "./atlasItemIcon";
import type { FurnaceStack } from "../world/furnace/FurnaceTileState";
import { FURNACE_OUTPUT_SLOT_COUNT } from "../world/furnace/FurnaceTileState";

/** Snapshot for Furnace tab chrome (nearest furnace in access radius). */
export type FurnaceUiChromeModel = {
  readonly outputSlots: readonly FurnaceStack[];
  readonly fuel: FurnaceStack;
  readonly fuelRemainingSec: number;
  readonly cookProgressSec: number;
  readonly activeSmeltingRecipeId: string | null;
  readonly cookTimeSecForActive: number;
  /** Sum of `batches` per smelting JSON recipe id across the FIFO queue (remaining smelts). */
  readonly queuedBatchesByRecipeId: Readonly<Record<string, number>>;
};

export interface CraftingPanelDeps {
  getItemIconUrlLookup: () => ItemIconUrlLookup | null;
  getRecipes: () => readonly RecipeDefinition[];
  getCategories: () => readonly string[];
  /** When either toggles while open, the recipe list/tabs refresh (station-gated recipes). */
  getNearCraftingTable: () => boolean;
  getNearFurnace: () => boolean;
  getNearStonecutter: () => boolean;
  canCraftOneBatch: (recipe: RecipeDefinition, inventory: PlayerInventory) => boolean;
  maxCraftableBatches: (recipe: RecipeDefinition, inventory: PlayerInventory) => number;
  recipeTouchesInventory: (recipe: RecipeDefinition, inventory: PlayerInventory) => boolean;
  getRecipeIngredientAvailability: (
    recipe: RecipeDefinition,
    inventory: PlayerInventory,
  ) => readonly { readonly need: number; readonly have: number }[];
  getInventory: () => PlayerInventory;
  getFurnaceUiModel: () => FurnaceUiChromeModel | null;
}

const CRAFTING_SHOW_CRAFTABLE_KEY = "stratum_crafting_show_craftable";
const TAG_CYCLE_MS = 850;

const ICON_OUT_PX = 34;
const ICON_ING_PX = 28;
const ICON_FURNACE_SLOT_PX = 40;

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
  private craftPending = false;

  /** Recipes rendered in the current list, keyed by index for event delegation. */
  private renderedRecipes: RecipeDefinition[] = [];
  private readonly titleEl: HTMLDivElement;
  private readonly searchInput: HTMLInputElement;
  private recipeSearchQuery = "";
  /** Serialized station proximity; when it changes, tabs/categories must rebuild. */
  private lastStationProximityKey: string | null = null;
  private readonly furnaceChromeRoot: HTMLDivElement;
  private readonly furnaceFuelIcon: HTMLDivElement;
  private readonly furnaceFuelCount: HTMLSpanElement;
  private readonly furnaceOutputIcons: HTMLDivElement[];
  private readonly furnaceOutputCounts: HTMLSpanElement[];
  private showCraftableFilter = false;
  private tagCycleTick = 0;
  private tagCycleTimer: ReturnType<typeof setInterval> | null = null;
  private readonly tooltipEl: HTMLDivElement;
  private tooltipTargetRow: HTMLElement | null = null;

  constructor(
    mount: HTMLElement,
    bus: EventBus,
    itemRegistry: ItemRegistry,
    deps: CraftingPanelDeps,
  ) {
    this.bus = bus;
    this.itemRegistry = itemRegistry;
    this.deps = deps;

    try {
      this.showCraftableFilter =
        globalThis.localStorage?.getItem(CRAFTING_SHOW_CRAFTABLE_KEY) === "true";
    } catch {
      this.showCraftableFilter = false;
    }

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
    this.titleEl = title;

    const searchRow = document.createElement("div");
    searchRow.className = "inv-craft-search-row";

    const searchWrap = document.createElement("div");
    searchWrap.className = "inv-craft-search-wrap";
    const searchInput = document.createElement("input");
    searchInput.type = "search";
    searchInput.className = "inv-craft-search";
    searchInput.placeholder = "Search recipes…";
    searchInput.autocomplete = "off";
    searchInput.setAttribute("aria-label", "Search recipes");
    this.searchInput = searchInput;
    searchInput.addEventListener("input", () => {
      this.recipeSearchQuery = searchInput.value.trim();
      this.rebuildList();
    });
    searchWrap.appendChild(searchInput);

    const filterBtn = document.createElement("button");
    filterBtn.type = "button";
    filterBtn.className = "inv-craft-filter-toggle";
    filterBtn.textContent = "Craftable";
    filterBtn.title =
      "When on, only recipes where you carry at least one matching ingredient. Full craft: normal; partial: red outline; hover for missing counts.";
    filterBtn.setAttribute("aria-pressed", this.showCraftableFilter ? "true" : "false");
    if (this.showCraftableFilter) {
      filterBtn.classList.add("inv-craft-filter-toggle--on");
    }
    filterBtn.addEventListener("click", () => {
      this.showCraftableFilter = !this.showCraftableFilter;
      filterBtn.setAttribute("aria-pressed", this.showCraftableFilter ? "true" : "false");
      filterBtn.classList.toggle("inv-craft-filter-toggle--on", this.showCraftableFilter);
      try {
        globalThis.localStorage?.setItem(
          CRAFTING_SHOW_CRAFTABLE_KEY,
          this.showCraftableFilter ? "true" : "false",
        );
      } catch {
        /* ignore quota / private mode */
      }
      this.rebuildList();
    });

    searchRow.appendChild(searchWrap);
    searchRow.appendChild(filterBtn);

    const tooltipEl = document.createElement("div");
    tooltipEl.className = "inv-craft-tooltip inv-craft-tooltip--hidden";
    tooltipEl.setAttribute("role", "tooltip");
    document.body.appendChild(tooltipEl);
    this.tooltipEl = tooltipEl;

    const list = document.createElement("div");
    list.className = "inv-craft-list";
    list.setAttribute("role", "listbox");
    this.listEl = list;

    const hint = document.createElement("div");
    hint.className = "inv-craft-hint";
    hint.setAttribute("aria-live", "polite");
    this.hintEl = hint;

    const furnaceChrome = document.createElement("div");
    furnaceChrome.className = "inv-furnace-chrome inv-furnace-chrome--hidden";
    furnaceChrome.setAttribute("aria-label", "Furnace output");

    const fuelRow = document.createElement("div");
    fuelRow.className = "inv-furnace-fuel-row inv-furnace-fuel-row--hidden";

    const fuelLabel = document.createElement("div");
    fuelLabel.className = "inv-furnace-chrome-label";
    fuelLabel.textContent = "Fuel";

    const fuelSlot = document.createElement("div");
    fuelSlot.className = "inv-slot inv-furnace-slot";
    fuelSlot.dataset.furnaceSlot = "fuel";
    fuelSlot.setAttribute("role", "button");
    fuelSlot.tabIndex = 0;
    const fuelIcon = document.createElement("div");
    fuelIcon.className = "inv-slot-icon";
    const fuelCount = document.createElement("span");
    fuelCount.className = "inv-slot-count inv-slot-count--white";
    fuelSlot.appendChild(fuelIcon);
    fuelSlot.appendChild(fuelCount);
    fuelRow.appendChild(fuelLabel);
    fuelRow.appendChild(fuelSlot);

    const outLabel = document.createElement("div");
    outLabel.className = "inv-furnace-chrome-label";
    outLabel.textContent = "Output";

    const outGrid = document.createElement("div");
    outGrid.className = "inv-furnace-output-grid";
    const outIcons: HTMLDivElement[] = [];
    const outCounts: HTMLSpanElement[] = [];
    for (let i = 0; i < FURNACE_OUTPUT_SLOT_COUNT; i++) {
      const slot = document.createElement("div");
      slot.className = "inv-slot inv-furnace-slot";
      slot.dataset.furnaceSlot = "output";
      slot.dataset.slotIndex = String(i);
      slot.setAttribute("role", "button");
      slot.tabIndex = 0;
      const ic = document.createElement("div");
      ic.className = "inv-slot-icon";
      const cnt = document.createElement("span");
      cnt.className = "inv-slot-count inv-slot-count--white";
      slot.appendChild(ic);
      slot.appendChild(cnt);
      outGrid.appendChild(slot);
      outIcons.push(ic);
      outCounts.push(cnt);
    }

    furnaceChrome.appendChild(fuelRow);
    furnaceChrome.appendChild(outLabel);
    furnaceChrome.appendChild(outGrid);
    this.furnaceChromeRoot = furnaceChrome;
    this.furnaceFuelIcon = fuelIcon;
    this.furnaceFuelCount = fuelCount;
    this.furnaceOutputIcons = outIcons;
    this.furnaceOutputCounts = outCounts;

    body.appendChild(title);
    body.appendChild(searchRow);
    body.appendChild(furnaceChrome);
    body.appendChild(list);
    body.appendChild(hint);

    inner.appendChild(body);
    inner.appendChild(tabs);
    root.appendChild(inner);

    this.listEl.addEventListener("click", this.onListClick);
    furnaceChrome.addEventListener("pointerdown", this.onFurnaceChromePointerDown);

    this.unsubResult = this.bus.on("craft:result", (e) => {
      this.craftPending = false;
      if (e.ok) {
        this.flashHint("");
      } else {
        this.flashHint(e.reason);
      }
    });
  }

  private readonly onFurnaceChromePointerDown = (ev: PointerEvent): void => {
    if (!this.open || this.activeCategory !== "Furnace") {
      return;
    }
    const t = ev.target as HTMLElement;
    if (t.closest("[data-furnace-slot]") === null) {
      return;
    }
    ev.preventDefault();
    ev.stopPropagation();
    const fuelCell = t.closest<HTMLElement>('[data-furnace-slot="fuel"]');
    if (fuelCell !== null) {
      this.bus.emit({
        type: "furnace:fuel-slot-click",
        button: ev.button,
      } satisfies GameEvent);
      return;
    }
    const outCell = t.closest<HTMLElement>('[data-furnace-slot="output"]');
    if (outCell !== null && outCell.dataset.slotIndex !== undefined) {
      const idx = Number.parseInt(outCell.dataset.slotIndex, 10);
      if (Number.isFinite(idx)) {
        this.bus.emit({
          type: "furnace:output-slot-click",
          slotIndex: idx,
          button: ev.button,
        } satisfies GameEvent);
      }
    }
  };

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

    if (this.craftPending) {
      return;
    }
    const invNow = this.deps.getInventory();
    if (!this.deps.canCraftOneBatch(recipe, invNow)) {
      this.flashHint(
        recipe.category === "Furnace"
          ? "Cannot smelt — empty the cursor and keep ore or input in storage or hotbar."
          : "Cannot craft — pick up nothing on the cursor, and keep materials in storage or hotbar.",
      );
      return;
    }
    const maxB = this.deps.maxCraftableBatches(recipe, invNow);
    const shift = ev.shiftKey;
    const batches = shift ? maxB : 1;
    if (batches <= 0) {
      return;
    }
    this.craftPending = true;
    this.bus.emit({
      type: "craft:request",
      recipeId: recipe.id,
      batches,
      shiftKey: shift,
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

  /** After opening inventory from a furnace block, jump to the Furnace tab when proximity allows it. */
  selectCategoryIfAvailable(category: string): void {
    if (!this.open) {
      return;
    }
    const cats = this.deps.getCategories();
    if (!cats.includes(category)) {
      return;
    }
    this.activeCategory = category;
    this.rebuildTabs();
    this.rebuildList();
  }

  setOpen(open: boolean): void {
    const wasOpen = this.open;
    this.open = open;
    if (open) {
      this.searchInput.value = "";
      this.recipeSearchQuery = "";
      this.lastStationProximityKey = this.stationProximityKey();
      this.root.classList.add("inv-crafting-sidebar--open");
      this.root.setAttribute("aria-hidden", "false");
      this.ensureActiveCategory();
      this.rebuildTabs();
      this.rebuildList();
      this.startTagCycleTimer();
      if (!wasOpen) {
        this.listEl.scrollTop = 0;
      }
    } else {
      this.craftPending = false;
      this.stopTagCycleTimer();
      this.hideTooltip();
      this.lastStationProximityKey = null;
      this.root.classList.remove("inv-crafting-sidebar--open");
      this.root.setAttribute("aria-hidden", "true");
      if (this.hintTimer !== null) {
        clearTimeout(this.hintTimer);
        this.hintTimer = null;
      }
      this.hintEl.textContent = "";
    }
  }

  /** Remaining smelt batches in the nearest furnace queue for this recipe (0 if none / no UI model). */
  private furnaceQueuedBatchesForRecipe(recipe: RecipeDefinition): number {
    if (recipe.category !== "Furnace" || recipe.smeltingSourceId === undefined) {
      return 0;
    }
    const m = this.deps.getFurnaceUiModel();
    return m?.queuedBatchesByRecipeId[recipe.smeltingSourceId] ?? 0;
  }

  /** ×N on furnace rows = remaining queued smelts for that recipe (×1 when queue empty = one per click). */
  private furnaceSmeltMultText(recipe: RecipeDefinition): string {
    const q = this.furnaceQueuedBatchesForRecipe(recipe);
    return q > 0 ? `×${String(q)}` : "×1";
  }

  private refreshFurnaceSmeltMultLabels(): void {
    if (!this.open || this.activeCategory !== "Furnace") {
      return;
    }
    const rows = this.listEl.children;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] as HTMLElement;
      const recipe = this.renderedRecipes[i];
      if (recipe === undefined) {
        continue;
      }
      const mult = row.querySelector<HTMLElement>(".inv-craft-mult");
      if (mult === null) {
        continue;
      }
      mult.textContent = this.furnaceSmeltMultText(recipe);
    }
  }

  private stationProximityKey(): string {
    return `${this.deps.getNearCraftingTable() ? 1 : 0},${this.deps.getNearFurnace() ? 1 : 0},${this.deps.getNearStonecutter() ? 1 : 0}`;
  }

  update(_inventory: PlayerInventory): void {
    if (!this.open) {
      return;
    }
    const k = this.stationProximityKey();
    if (this.lastStationProximityKey !== k) {
      this.lastStationProximityKey = k;
      this.ensureActiveCategory();
      this.rebuildTabs();
      this.rebuildList();
    } else {
      this.updateAffordability();
      this.updateFurnaceIngredientCounts();
      this.refreshTagCycleIcons();
      this.refreshTooltipIfOpen();
      this.refreshFurnaceChrome();
      this.updateFurnaceRowProgress();
      if (this.activeCategory === "Furnace") {
        this.refreshFurnaceSmeltMultLabels();
      }
    }
  }

  private refreshFurnaceChrome(): void {
    if (!this.open || this.activeCategory !== "Furnace") {
      this.furnaceChromeRoot.classList.add("inv-furnace-chrome--hidden");
      return;
    }
    const m = this.deps.getFurnaceUiModel();
    if (m === null) {
      this.furnaceChromeRoot.classList.add("inv-furnace-chrome--hidden");
      return;
    }
    this.furnaceChromeRoot.classList.remove("inv-furnace-chrome--hidden");
    const urlLookup = this.deps.getItemIconUrlLookup();

    const setSlot = (
      stack: FurnaceStack,
      iconEl: HTMLDivElement,
      countEl: HTMLSpanElement,
    ): void => {
      if (stack === null || stack.count <= 0) {
        iconEl.style.cssText = "";
        iconEl.removeAttribute("title");
        countEl.textContent = "";
        return;
      }
      const def = this.itemRegistry.getById(stack.itemId);
      if (def !== undefined && urlLookup !== null) {
        iconEl.style.cssText = getItemIconStyleForDefinition(
          def,
          urlLookup,
          ICON_FURNACE_SLOT_PX,
        );
        iconEl.title = def.displayName;
      } else {
        iconEl.style.cssText = "";
        iconEl.removeAttribute("title");
      }
      countEl.textContent = stack.count > 1 ? String(stack.count) : "";
    };

    setSlot(m.fuel, this.furnaceFuelIcon, this.furnaceFuelCount);
    for (let i = 0; i < FURNACE_OUTPUT_SLOT_COUNT; i++) {
      setSlot(
        m.outputSlots[i] ?? null,
        this.furnaceOutputIcons[i]!,
        this.furnaceOutputCounts[i]!,
      );
    }
  }

  private updateFurnaceRowProgress(): void {
    if (!this.open || this.activeCategory !== "Furnace") {
      return;
    }
    const m = this.deps.getFurnaceUiModel();
    const rows = this.listEl.children;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] as HTMLElement;
      const fill = row.querySelector<HTMLElement>(".inv-furnace-row-progress-fill");
      if (fill === null) {
        continue;
      }
      const recipe = this.renderedRecipes[i];
      if (
        m === null ||
        recipe?.smeltingSourceId === undefined ||
        recipe.smeltingSourceId !== m.activeSmeltingRecipeId ||
        m.cookTimeSecForActive <= 0
      ) {
        fill.style.width = "0%";
        continue;
      }
      const pct = Math.min(
        100,
        (m.cookProgressSec / m.cookTimeSecForActive) * 100,
      );
      fill.style.width = `${String(pct)}%`;
    }
  }

  /**
   * Refresh row affordance (full / partial red outline / dimmed) without rebuilding the list.
   */
  private updateAffordability(): void {
    const inv = this.deps.getInventory();
    const rows = this.listEl.children;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] as HTMLElement;
      const recipe = this.renderedRecipes[i];
      if (recipe === undefined) continue;
      this.applyRowAffordanceClasses(row, recipe, inv);
      this.updateIngredientCellAffordance(row, recipe, inv);
    }
  }

  /** Dim ingredient icons the player does not have enough of (inventory vs recipe slot). */
  private updateIngredientCellAffordance(
    row: HTMLElement,
    recipe: RecipeDefinition,
    inv: PlayerInventory,
  ): void {
    const avail = this.deps.getRecipeIngredientAvailability(recipe, inv);
    const q = this.furnaceQueuedBatchesForRecipe(recipe);
    const cells = row.querySelectorAll<HTMLElement>(".inv-craft-ing");
    cells.forEach((cell, idx) => {
      const s = avail[idx];
      const unmet =
        recipe.category === "Furnace" && q > 0
          ? false
          : s === undefined || s.have < s.need;
      cell.classList.toggle("inv-craft-ing--unmet", unmet);
    });
  }

  private applyRowAffordanceClasses(
    row: HTMLElement,
    recipe: RecipeDefinition,
    inv: PlayerInventory,
  ): void {
    const touches = this.deps.recipeTouchesInventory(recipe, inv);
    const full = this.deps.canCraftOneBatch(recipe, inv);
    const q = this.furnaceQueuedBatchesForRecipe(recipe);
    row.classList.remove("inv-craft-row--dimmed", "inv-craft-row--partial");
    if (full) {
      return;
    }
    if (recipe.category === "Furnace" && q > 0) {
      return;
    }
    if (touches) {
      row.classList.add("inv-craft-row--partial");
    } else {
      row.classList.add("inv-craft-row--dimmed");
    }
  }

  /** Live-update ore/input counts while smelting (queue ticks down: 10 → 9 → …). */
  private updateFurnaceIngredientCounts(): void {
    if (!this.open || this.activeCategory !== "Furnace") {
      return;
    }
    const rows = this.listEl.children;
    for (let i = 0; i < rows.length; i++) {
      const recipe = this.renderedRecipes[i];
      if (recipe === undefined || recipe.category !== "Furnace") {
        continue;
      }
      const q = this.furnaceQueuedBatchesForRecipe(recipe);
      const row = rows[i] as HTMLElement;
      const countEls = row.querySelectorAll<HTMLElement>(".inv-craft-ing-count");
      for (let j = 0; j < recipe.ingredients.length; j++) {
        const ing = recipe.ingredients[j]!;
        const el = countEls[j];
        if (el === undefined) {
          continue;
        }
        el.textContent = q > 0 ? String(q) : String(ing.count);
      }
    }
  }

  private startTagCycleTimer(): void {
    this.stopTagCycleTimer();
    this.tagCycleTick = 0;
    this.refreshTagCycleIcons();
    this.tagCycleTimer = setInterval(() => {
      this.tagCycleTick += 1;
      this.refreshTagCycleIcons();
    }, TAG_CYCLE_MS);
  }

  private stopTagCycleTimer(): void {
    if (this.tagCycleTimer !== null) {
      clearInterval(this.tagCycleTimer);
      this.tagCycleTimer = null;
    }
  }

  private refreshTagCycleIcons(): void {
    if (!this.open) {
      return;
    }
    const urlLookup = this.deps.getItemIconUrlLookup();
    if (urlLookup === null) {
      return;
    }
    const tick = this.tagCycleTick;
    for (const ic of this.listEl.querySelectorAll<HTMLDivElement>(
      ".inv-craft-ing-icon[data-cycle-tag]",
    )) {
      const tag = ic.dataset.cycleTag;
      if (tag === undefined) {
        continue;
      }
      const defs = [...this.itemRegistry.getByTag(tag)].sort((a, b) =>
        a.key.localeCompare(b.key),
      );
      if (defs.length === 0) {
        continue;
      }
      const def = defs[tick % defs.length]!;
      ic.style.cssText = getItemIconStyleForDefinition(def, urlLookup, ICON_ING_PX);
      ic.title = def.displayName;
    }
  }

  private showRecipeTooltip(row: HTMLElement, recipe: RecipeDefinition): void {
    this.tooltipTargetRow = row;
    this.fillTooltip(recipe);
    this.tooltipEl.classList.remove("inv-craft-tooltip--hidden");
    requestAnimationFrame(() => {
      this.positionTooltip(row);
    });
  }

  private hideRecipeTooltipIfRow(row: HTMLElement): void {
    if (this.tooltipTargetRow === row) {
      this.tooltipEl.classList.add("inv-craft-tooltip--hidden");
      this.tooltipTargetRow = null;
    }
  }

  private hideTooltip(): void {
    this.tooltipEl.classList.add("inv-craft-tooltip--hidden");
    this.tooltipTargetRow = null;
  }

  private refreshTooltipIfOpen(): void {
    if (
      this.tooltipTargetRow === null ||
      this.tooltipEl.classList.contains("inv-craft-tooltip--hidden")
    ) {
      return;
    }
    const idx = this.tooltipTargetRow.dataset.recipeIdx;
    if (idx === undefined) {
      return;
    }
    const recipe = this.renderedRecipes[Number.parseInt(idx, 10)];
    if (recipe === undefined) {
      return;
    }
    this.fillTooltip(recipe);
    requestAnimationFrame(() => {
      if (this.tooltipTargetRow !== null) {
        this.positionTooltip(this.tooltipTargetRow);
      }
    });
  }

  private positionTooltip(row: HTMLElement): void {
    const pad = 8;
    const r = row.getBoundingClientRect();
    const tw = this.tooltipEl.offsetWidth;
    const th = this.tooltipEl.offsetHeight;
    let left = r.left - tw - pad;
    if (left < pad) {
      left = Math.min(window.innerWidth - tw - pad, r.right + pad);
    }
    let top = r.top;
    if (top + th > window.innerHeight - pad) {
      top = Math.max(pad, window.innerHeight - th - pad);
    }
    this.tooltipEl.style.left = `${String(left)}px`;
    this.tooltipEl.style.top = `${String(top)}px`;
  }

  private fillTooltip(recipe: RecipeDefinition): void {
    const inv = this.deps.getInventory();
    const slots = this.deps.getRecipeIngredientAvailability(recipe, inv);
    this.tooltipEl.replaceChildren();
    const heading = document.createElement("div");
    heading.className = "inv-craft-tooltip-heading";
    heading.textContent = "Ingredients";
    this.tooltipEl.appendChild(heading);
    const qTip = this.furnaceQueuedBatchesForRecipe(recipe);
    for (let i = 0; i < recipe.ingredients.length; i++) {
      const ing = recipe.ingredients[i]!;
      const line = document.createElement("div");
      line.className = "inv-craft-tooltip-line";
      const { need, have } = slots[i] ?? { need: 0, have: 0 };
      const label = this.formatIngredientLabel(ing);
      const queuedNote =
        recipe.category === "Furnace" && qTip > 0
          ? ` — ${String(qTip)} batch(es) in furnace`
          : "";
      line.textContent = `${label} ×${String(need)} — have ${String(have)}${queuedNote}`;
      const missing =
        recipe.category === "Furnace" && qTip > 0 ? false : have < need;
      if (missing) {
        line.classList.add("inv-craft-tooltip-line--missing");
      }
      this.tooltipEl.appendChild(line);
    }
  }

  private formatIngredientLabel(ing: IngredientSlot): string {
    if (ing.itemId !== undefined) {
      return this.itemRegistry.getByKey(ing.itemId)?.displayName ?? ing.itemId;
    }
    if (ing.tag !== undefined) {
      const list = [...this.itemRegistry.getByTag(ing.tag)].sort((a, b) =>
        a.key.localeCompare(b.key),
      );
      if (list.length === 0) {
        return ing.tag;
      }
      if (list.length <= 3) {
        return list.map((d) => d.displayName).join(", ");
      }
      const first = list[0]?.displayName ?? "";
      return `${first}, … (${String(list.length)} kinds)`;
    }
    return "?";
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

  private recipeMatchesSearch(recipe: RecipeDefinition, q: string): boolean {
    if (recipe.id.toLowerCase().includes(q)) {
      return true;
    }
    const outKey = recipe.output.itemId;
    if (outKey !== undefined && outKey.toLowerCase().includes(q)) {
      return true;
    }
    const outDef =
      outKey !== undefined ? this.itemRegistry.getByKey(outKey) : undefined;
    if (outDef !== undefined && outDef.displayName.toLowerCase().includes(q)) {
      return true;
    }
    for (const ing of recipe.ingredients) {
      if (ing.itemId !== undefined && ing.itemId.toLowerCase().includes(q)) {
        return true;
      }
      if (ing.tag !== undefined && ing.tag.toLowerCase().includes(q)) {
        return true;
      }
      if (ing.tag !== undefined) {
        for (const d of this.itemRegistry.getByTag(ing.tag)) {
          if (
            d.displayName.toLowerCase().includes(q) ||
            d.key.toLowerCase().includes(q)
          ) {
            return true;
          }
        }
      }
    }
    return false;
  }

  private rebuildList(): void {
    this.hideTooltip();
    this.listEl.replaceChildren();
    this.renderedRecipes = [];
    const urlLookup = this.deps.getItemIconUrlLookup();
    const inv = this.deps.getInventory();
    const cat = this.activeCategory;
    if (cat === null) {
      return;
    }

    this.titleEl.textContent = cat === "Furnace" ? "Furnace" : "Crafting";

    const q = this.recipeSearchQuery.trim().toLowerCase();
    let recipes = this.deps.getRecipes().filter((r) => r.category === cat);
    if (q.length > 0) {
      recipes = recipes.filter((r) => this.recipeMatchesSearch(r, q));
    }
    if (this.showCraftableFilter) {
      recipes = recipes.filter((r) => {
        if (
          r.category === "Furnace" &&
          this.furnaceQueuedBatchesForRecipe(r) > 0
        ) {
          return true;
        }
        return this.deps.recipeTouchesInventory(r, inv);
      });
    }
    for (let ri = 0; ri < recipes.length; ri++) {
      const recipe = recipes[ri]!;
      this.renderedRecipes.push(recipe);

      const row = document.createElement("div");
      row.className = "inv-craft-row";
      row.setAttribute("role", "option");
      row.dataset.recipeIdx = String(ri);

      this.applyRowAffordanceClasses(row, recipe, inv);

      row.addEventListener("pointerenter", () => {
        this.showRecipeTooltip(row, recipe);
      });
      row.addEventListener("pointerleave", () => {
        this.hideRecipeTooltipIfRow(row);
      });

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
      const ingAvail = this.deps.getRecipeIngredientAvailability(recipe, inv);
      const qRow =
        cat === "Furnace" ? this.furnaceQueuedBatchesForRecipe(recipe) : 0;
      for (let ii = 0; ii < recipe.ingredients.length; ii++) {
        const ing = recipe.ingredients[ii]!;
        let ingDef =
          ing.itemId !== undefined ? this.itemRegistry.getByKey(ing.itemId) : undefined;
        let cycleTag: string | undefined;
        if (ing.tag !== undefined) {
          cycleTag = ing.tag;
          const tagDefs = [...this.itemRegistry.getByTag(ing.tag)].sort((a, b) =>
            a.key.localeCompare(b.key),
          );
          ingDef = tagDefs[0];
        }
        const cell = document.createElement("div");
        cell.className = "inv-craft-ing";
        const slotAvail = ingAvail[ii];
        const ingUnmet =
          qRow > 0
            ? false
            : slotAvail === undefined || slotAvail.have < slotAvail.need;
        if (ingUnmet) {
          cell.classList.add("inv-craft-ing--unmet");
        }
        const ingSlot = document.createElement("div");
        ingSlot.className = "inv-craft-ing-slot";
        const ic = document.createElement("div");
        ic.className = "inv-craft-ing-icon";
        if (ingDef !== undefined && urlLookup !== null) {
          ic.style.cssText = getItemIconStyleForDefinition(ingDef, urlLookup, ICON_ING_PX);
          ic.title = ingDef.displayName;
        }
        if (cycleTag !== undefined) {
          ic.dataset.cycleTag = cycleTag;
        }
        ingSlot.appendChild(ic);
        const cnt = document.createElement("span");
        cnt.className = "inv-craft-ing-count";
        cnt.textContent = qRow > 0 ? String(qRow) : String(ing.count);
        cell.appendChild(ingSlot);
        cell.appendChild(cnt);
        ingRow.appendChild(cell);
      }

      const mult = document.createElement("div");
      mult.className = "inv-craft-mult";
      if (cat === "Furnace") {
        mult.textContent = this.furnaceSmeltMultText(recipe);
      } else {
        mult.textContent = `× ${String(recipe.output.count)}`;
      }

      meta.appendChild(nameEl);
      meta.appendChild(ingRow);

      outWrap.appendChild(outSlot);
      outWrap.appendChild(meta);
      outWrap.appendChild(mult);
      row.appendChild(outWrap);

      if (cat === "Furnace") {
        const progWrap = document.createElement("div");
        progWrap.className = "inv-furnace-row-progress-wrap";
        const progFill = document.createElement("div");
        progFill.className = "inv-furnace-row-progress-fill";
        progWrap.appendChild(progFill);
        row.appendChild(progWrap);
      }

      this.listEl.appendChild(row);
    }

    this.refreshTagCycleIcons();
    this.refreshFurnaceChrome();
    this.updateFurnaceRowProgress();
  }

  destroy(): void {
    this.stopTagCycleTimer();
    this.unsubResult();
    this.listEl.removeEventListener("click", this.onListClick);
    this.furnaceChromeRoot.removeEventListener("pointerdown", this.onFurnaceChromePointerDown);
    if (this.hintTimer !== null) {
      clearTimeout(this.hintTimer);
      this.hintTimer = null;
    }
    this.tooltipEl.remove();
    this.root.remove();
  }
}
