/** Scrollable sandbox inventory sidebar beside the player inventory panel. */

import { INVENTORY_ITEM_ICON_DISPLAY_PX } from "../core/constants";
import type { ItemDefinition } from "../core/itemDefinition";
import type { ItemRegistry } from "../items/ItemRegistry";
import type { ItemIconUrlLookup } from "./atlasItemIcon";
import { getItemIconStyleForDefinition } from "./atlasItemIcon";
import "./inventory.css";

const ICON_PX = INVENTORY_ITEM_ICON_DISPLAY_PX;
const CREATIVE_GRID_COLUMNS = 4;

export interface CreativePanelDeps {
  getItemIconUrlLookup: () => ItemIconUrlLookup | null;
  onPickItem: (itemId: number, count: number, button: number) => void;
}

export class CreativePanel {
  private readonly root: HTMLDivElement;
  private readonly gridEl: HTMLDivElement;
  private readonly deps: CreativePanelDeps;
  private readonly itemDefs: ItemDefinition[];
  private filteredDefs: ItemDefinition[];
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
      this.applyFilter(searchInput.value);
    });
    const scroll = document.createElement("div");
    scroll.className = "inv-creative-scroll";

    const grid = document.createElement("div");
    grid.className = "inv-creative-grid";
    grid.style.gridTemplateColumns = `repeat(${CREATIVE_GRID_COLUMNS}, var(--inv-slot-px, 58px))`;
    scroll.appendChild(grid);
    this.gridEl = grid;

    inner.appendChild(title);
    inner.appendChild(searchInput);
    inner.appendChild(scroll);
    root.appendChild(inner);

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

  private applyFilter(raw: string): void {
    const q = raw.trim().toLowerCase();
    if (q.length === 0) {
      this.filteredDefs = [...this.itemDefs];
    } else {
      this.filteredDefs = this.itemDefs.filter((def) => {
        return (
          def.displayName.toLowerCase().includes(q) ||
          def.key.toLowerCase().includes(q)
        );
      });
    }
    this.rebuildGrid();
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
