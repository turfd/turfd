/** Scrollable sandbox inventory sidebar beside the player inventory panel. */

import { CREATIVE_CATEGORIES, type CreativeCategory } from "../core/creativeCategory";
import { INVENTORY_ITEM_ICON_DISPLAY_PX } from "../core/constants";
import type { ItemDefinition } from "../core/itemDefinition";
import type { ItemRegistry } from "../items/ItemRegistry";
import type { ItemIconUrlLookup } from "./atlasItemIcon";
import { getItemIconStyleForDefinition } from "./atlasItemIcon";
import "./inventory.css";

const ICON_PX = INVENTORY_ITEM_ICON_DISPLAY_PX;
const CREATIVE_GRID_COLUMNS = 4;

type CreativeTabId = "all" | CreativeCategory;

export interface CreativePanelDeps {
  getItemIconUrlLookup: () => ItemIconUrlLookup | null;
  onPickItem: (itemId: number, count: number, button: number) => void;
}

function tabLabel(id: CreativeTabId): string {
  if (id === "all") {
    return "All";
  }
  return id.charAt(0).toUpperCase() + id.slice(1);
}

export class CreativePanel {
  private readonly root: HTMLDivElement;
  private readonly gridEl: HTMLDivElement;
  private readonly tabsEl: HTMLDivElement;
  private readonly searchInput: HTMLInputElement;
  private readonly deps: CreativePanelDeps;
  private readonly itemDefs: ItemDefinition[];
  private filteredDefs: ItemDefinition[];
  private selectedTab: CreativeTabId = "all";
  private open = false;
  private visible = false;

  constructor(mount: HTMLElement, itemRegistry: ItemRegistry, deps: CreativePanelDeps) {
    this.deps = deps;
    this.itemDefs = [...itemRegistry.all()];
    this.filteredDefs = [...this.itemDefs];

    const root = document.createElement("div");
    root.className = "inv-creative-sidebar";
    root.setAttribute("aria-hidden", "true");
    mount.appendChild(root);
    this.root = root;

    const inner = document.createElement("div");
    inner.className = "inv-creative-sidebar-inner";

    const title = document.createElement("div");
    title.className = "inv-creative-title";
    title.textContent = "Sandbox Mode";

    const searchInput = document.createElement("input");
    searchInput.className = "inv-creative-search";
    searchInput.type = "text";
    searchInput.placeholder = "Search items...";
    searchInput.addEventListener("input", () => {
      this.refilter();
    });
    this.searchInput = searchInput;

    const tabs = document.createElement("div");
    tabs.className = "inv-creative-tabs";
    tabs.setAttribute("role", "tablist");
    this.tabsEl = tabs;

    const allBtn = this.makeTabButton("all", 0);
    tabs.appendChild(allBtn);
    let tabIndex = 1;
    for (const cat of CREATIVE_CATEGORIES) {
      tabs.appendChild(this.makeTabButton(cat, tabIndex));
      tabIndex += 1;
    }

    const scroll = document.createElement("div");
    scroll.className = "inv-creative-scroll";

    const grid = document.createElement("div");
    grid.className = "inv-creative-grid";
    grid.style.gridTemplateColumns = `repeat(${CREATIVE_GRID_COLUMNS}, var(--inv-slot-px, 58px))`;
    scroll.appendChild(grid);
    this.gridEl = grid;

    inner.appendChild(title);
    inner.appendChild(searchInput);
    inner.appendChild(tabs);
    inner.appendChild(scroll);
    root.appendChild(inner);

    this.syncTabButtons();
    this.rebuildGrid();
  }

  private makeTabButton(id: CreativeTabId, tabIndex: number): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "inv-creative-tab";
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", id === this.selectedTab ? "true" : "false");
    btn.dataset.tabId = id;
    btn.id = `inv-creative-tab-${id}`;
    btn.tabIndex = tabIndex === 0 ? 0 : -1;
    btn.textContent = tabLabel(id);
    btn.addEventListener("click", () => {
      this.selectedTab = id;
      this.syncTabButtons();
      this.refilter();
    });
    return btn;
  }

  private syncTabButtons(): void {
    const buttons = this.tabsEl.querySelectorAll<HTMLButtonElement>(".inv-creative-tab");
    for (const btn of buttons) {
      const id = btn.dataset.tabId as CreativeTabId | undefined;
      if (id === undefined) {
        continue;
      }
      const active = id === this.selectedTab;
      btn.classList.toggle("inv-creative-tab--active", active);
      btn.setAttribute("aria-selected", active ? "true" : "false");
    }
  }

  private matchesTab(def: ItemDefinition): boolean {
    if (this.selectedTab === "all") {
      return true;
    }
    return def.creativeCategory === this.selectedTab;
  }

  private matchesSearch(def: ItemDefinition, q: string): boolean {
    if (q.length === 0) {
      return true;
    }
    return (
      def.displayName.toLowerCase().includes(q) || def.key.toLowerCase().includes(q)
    );
  }

  private refilter(): void {
    const q = this.searchInput.value.trim().toLowerCase();
    this.filteredDefs = this.itemDefs.filter((def) => this.matchesTab(def) && this.matchesSearch(def, q));
    this.rebuildGrid();
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.applyVisibility();
  }

  setOpen(open: boolean): void {
    this.open = open;
    this.applyVisibility();
  }

  private applyVisibility(): void {
    const show = this.open && this.visible;
    if (show) {
      this.root.classList.add("inv-creative-sidebar--open");
      this.root.setAttribute("aria-hidden", "false");
      return;
    }
    this.root.classList.remove("inv-creative-sidebar--open");
    this.root.setAttribute("aria-hidden", "true");
  }

  private rebuildGrid(): void {
    this.gridEl.replaceChildren();
    for (const def of this.filteredDefs) {
      const slot = document.createElement("div");
      slot.className = "inv-slot inv-creative-slot";
      slot.dataset.itemId = String(def.id);
      const icon = document.createElement("div");
      icon.className = "inv-slot-icon";
      const count = document.createElement("span");
      count.className = "inv-slot-count";
      slot.appendChild(icon);
      slot.appendChild(count);
      slot.addEventListener("mousedown", (e: MouseEvent) => {
        if (!this.open || !this.visible || (e.button !== 0 && e.button !== 2)) {
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        this.deps.onPickItem(def.id, def.maxStack ?? 64, e.button);
      });
      this.gridEl.appendChild(slot);
    }
  }

  update(): void {
    if (!this.open || !this.visible) {
      return;
    }
    const urlLookup = this.deps.getItemIconUrlLookup();
    const slots = this.gridEl.querySelectorAll(".inv-creative-slot");
    let i = 0;
    for (const def of this.filteredDefs) {
      const slot = slots[i] as HTMLElement | undefined;
      i += 1;
      if (slot === undefined) {
        continue;
      }
      const icon = slot.querySelector(".inv-slot-icon") as HTMLDivElement | null;
      if (icon === null) {
        continue;
      }
      if (urlLookup !== null) {
        icon.style.cssText = getItemIconStyleForDefinition(def, urlLookup, ICON_PX);
      } else {
        icon.style.cssText = "";
      }
      icon.title = def.displayName;
    }
  }

  destroy(): void {
    this.root.remove();
  }
}
