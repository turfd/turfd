/** Scrollable chest storage beside inventory (paired with {@link InventoryUI}). */

import { INVENTORY_ITEM_ICON_DISPLAY_PX } from "../core/constants";
import type { ItemDefinition } from "../core/itemDefinition";
import type { ItemRegistry } from "../items/ItemRegistry";
import type { ChestStack } from "../world/chest/ChestTileState";
import type { ItemIconUrlLookup } from "./atlasItemIcon";
import { getItemIconStyleForDefinition } from "./atlasItemIcon";
import "./inventory.css";

const ICON_PX = INVENTORY_ITEM_ICON_DISPLAY_PX;

/** Narrow grid so the chest panel stays vertical and scrolls (inventory main grid uses 9). */
const CHEST_GRID_COLUMNS = 4;

export interface ChestPanelDeps {
  getItemIconUrlLookup: () => ItemIconUrlLookup | null;
  /** 0 when no chest is open. */
  getChestSlotCount: () => number;
  getChestStack: (slotIndex: number) => ChestStack | null;
  /**
   * @returns true when RMB+non-empty cursor consumed (place one); suppresses RMB handling on mouseup.
   */
  onChestSlotMouseDown: (slotIndex: number, button: number, shift: boolean) => boolean;
  onChestSlotMouseUp: (
    slotIndex: number,
    button: number,
    shift: boolean,
    dragOccurred: boolean,
    slotElement: HTMLElement,
  ) => void;
  onChestSlotMouseEnter: (slotIndex: number, buttons: number) => void;
}

export class ChestPanel {
  private readonly root: HTMLDivElement;
  private readonly scrollEl: HTMLDivElement;
  private readonly gridEl: HTMLDivElement;
  private readonly itemRegistry: ItemRegistry;
  private readonly deps: ChestPanelDeps;
  private readonly iconEls: HTMLDivElement[] = [];
  private readonly countEls: HTMLSpanElement[] = [];
  private readonly tooltipEl: HTMLDivElement;
  private tooltipActiveSlot: number | null = null;
  private open = false;
  private visible = false;
  private pointerDownSlot: number | null = null;
  private pointerDownSlotEl: HTMLElement | null = null;
  private pointerDownButton: number | null = null;
  private dragOccurred = false;
  private rmbPlacedOnDown = false;
  private lastBuiltSlotCount = 0;

  private readonly onWindowMouseUp = (e: MouseEvent): void => {
    if (this.pointerDownSlot === null) {
      return;
    }
    if (this.pointerDownButton !== e.button) {
      return;
    }
    const slot = this.pointerDownSlot;
    let slotEl = this.pointerDownSlotEl;
    this.pointerDownSlotEl = null;
    if (slotEl === null) {
      slotEl = this.gridEl.querySelector(
        `.inv-chest-slot[data-chest-slot="${String(slot)}"]`,
      ) as HTMLElement | null;
    }
    if (e.button === 0) {
      if (!this.dragOccurred && slotEl !== null) {
        this.deps.onChestSlotMouseUp(slot, 0, e.shiftKey, false, slotEl);
      }
    } else if (e.button === 2) {
      if (!this.dragOccurred && !this.rmbPlacedOnDown && slotEl !== null) {
        this.deps.onChestSlotMouseUp(slot, 2, e.shiftKey, false, slotEl);
      }
      this.rmbPlacedOnDown = false;
    }
    this.pointerDownSlot = null;
    this.pointerDownButton = null;
    this.dragOccurred = false;
  };

  constructor(mount: HTMLElement, itemRegistry: ItemRegistry, deps: ChestPanelDeps) {
    this.itemRegistry = itemRegistry;
    this.deps = deps;

    const root = document.createElement("div");
    root.className = "inv-chest-sidebar";
    root.setAttribute("aria-hidden", "true");
    mount.appendChild(root);
    this.root = root;

    const inner = document.createElement("div");
    inner.className = "inv-chest-sidebar-inner";

    const title = document.createElement("div");
    title.className = "inv-chest-title";
    title.textContent = "Chest";

    const scroll = document.createElement("div");
    scroll.className = "inv-chest-scroll";
    this.scrollEl = scroll;
    const grid = document.createElement("div");
    grid.className = "inv-chest-grid";
    scroll.appendChild(grid);
    this.gridEl = grid;

    const tooltip = document.createElement("div");
    tooltip.className = "inv-chest-tooltip";
    tooltip.setAttribute("role", "tooltip");
    document.body.appendChild(tooltip);
    this.tooltipEl = tooltip;

    inner.appendChild(title);
    inner.appendChild(scroll);
    root.appendChild(inner);

    window.addEventListener("mouseup", this.onWindowMouseUp, true);
  }

  private hideTooltip(): void {
    this.tooltipActiveSlot = null;
    this.tooltipEl.classList.remove("inv-item-tooltip--visible");
    this.tooltipEl.replaceChildren();
  }

  private showSlotTooltip(slotIndex: number, def: ItemDefinition, clientX: number, clientY: number): void {
    this.tooltipActiveSlot = slotIndex;
    this.tooltipEl.replaceChildren();
    const nameLine = document.createElement("div");
    nameLine.className = "inv-item-tooltip__name";
    nameLine.textContent = def.displayName;
    this.tooltipEl.appendChild(nameLine);
    const tip = def.inventoryTooltip;
    if (tip !== undefined && tip.length > 0) {
      const detail = document.createElement("div");
      detail.className = "inv-item-tooltip__detail";
      detail.textContent = tip;
      this.tooltipEl.appendChild(detail);
    }
    this.tooltipEl.classList.add("inv-item-tooltip--visible");
    requestAnimationFrame(() => {
      this.positionTooltip(clientX, clientY);
    });
  }

  private positionTooltip(clientX: number, clientY: number): void {
    const pad = 12;
    const el = this.tooltipEl;
    const tw = el.offsetWidth;
    const th = el.offsetHeight;
    let x = clientX + pad;
    let y = clientY + pad;
    if (x + tw > window.innerWidth - 8) {
      x = clientX - tw - pad;
    }
    if (y + th > window.innerHeight - 8) {
      y = clientY - th - pad;
    }
    x = Math.max(8, x);
    y = Math.max(8, y);
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  }

  destroy(): void {
    this.hideTooltip();
    window.removeEventListener("mouseup", this.onWindowMouseUp, true);
    this.root.remove();
  }

  setChestVisible(visible: boolean): void {
    const wasVisible = this.visible;
    this.visible = visible;
    if (visible && !wasVisible) {
      this.scrollEl.scrollTop = 0;
    }
    this.applyVisibility();
  }

  setOpen(open: boolean): void {
    this.open = open;
    if (!open) {
      this.pointerDownSlot = null;
      this.pointerDownButton = null;
    }
    this.applyVisibility();
  }

  private applyVisibility(): void {
    const show = this.open && this.visible;
    if (show) {
      this.root.classList.add("inv-chest-sidebar--open");
      this.root.setAttribute("aria-hidden", "false");
    } else {
      this.root.classList.remove("inv-chest-sidebar--open");
      this.root.setAttribute("aria-hidden", "true");
    }
  }

  private bindSlot(slot: HTMLDivElement, slotIndex: number): void {
    slot.addEventListener("mousedown", (e: MouseEvent) => {
      if (!this.open || !this.visible) {
        return;
      }
      if (e.button !== 0 && e.button !== 2) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      this.pointerDownSlot = slotIndex;
      this.pointerDownSlotEl = slot;
      this.pointerDownButton = e.button;
      this.dragOccurred = false;
      this.rmbPlacedOnDown = false;
      if (e.button === 2) {
        const consumed = this.deps.onChestSlotMouseDown(slotIndex, 2, e.shiftKey);
        if (consumed) {
          this.rmbPlacedOnDown = true;
        }
      }
    });

    slot.addEventListener("mouseenter", (e: MouseEvent) => {
      if (!this.open || !this.visible) {
        return;
      }
      if (this.pointerDownSlot !== null && slotIndex !== this.pointerDownSlot) {
        this.dragOccurred = true;
      }
      if (this.pointerDownSlot !== null) {
        this.deps.onChestSlotMouseEnter(slotIndex, e.buttons);
      }
    });

    slot.addEventListener("contextmenu", (e: Event) => {
      if (this.open && this.visible) {
        e.preventDefault();
      }
    });
  }

  private rebuildGrid(slotCount: number): void {
    this.gridEl.replaceChildren();
    this.iconEls.length = 0;
    this.countEls.length = 0;
    const cols = CHEST_GRID_COLUMNS;
    this.gridEl.style.gridTemplateColumns = `repeat(${cols}, var(--inv-slot-px, 58px))`;

    for (let i = 0; i < slotCount; i++) {
      const slot = document.createElement("div");
      slot.className = "inv-slot inv-chest-slot";
      slot.dataset.chestSlot = String(i);
      const icon = document.createElement("div");
      icon.className = "inv-slot-icon";
      const count = document.createElement("span");
      count.className = "inv-slot-count";
      slot.appendChild(icon);
      slot.appendChild(count);
      this.gridEl.appendChild(slot);
      this.iconEls.push(icon);
      this.countEls.push(count);
      this.bindSlot(slot, i);
      this.bindSlotTooltip(slot, i);
    }
    this.lastBuiltSlotCount = slotCount;
  }

  private bindSlotTooltip(slot: HTMLDivElement, slotIndex: number): void {
    slot.addEventListener("mouseenter", (e: MouseEvent) => {
      if (!this.open || !this.visible) {
        return;
      }
      const stack = this.deps.getChestStack(slotIndex);
      if (stack === null || stack.count <= 0) {
        return;
      }
      const def = this.itemRegistry.getById(stack.itemId);
      if (def === undefined) {
        return;
      }
      this.showSlotTooltip(slotIndex, def, e.clientX, e.clientY);
    });
    slot.addEventListener("mousemove", (e: MouseEvent) => {
      if (this.tooltipActiveSlot !== slotIndex) {
        return;
      }
      this.positionTooltip(e.clientX, e.clientY);
    });
    slot.addEventListener("mouseleave", () => {
      if (this.tooltipActiveSlot === slotIndex) {
        this.hideTooltip();
      }
    });
  }

  /** Scroll the chest storage column so the given slot is in view (e.g. after shift–quick-move). */
  scrollChestSlotIntoView(slotIndex: number): void {
    if (!this.open || !this.visible) {
      return;
    }
    const slot = this.gridEl.querySelector(
      `.inv-chest-slot[data-chest-slot="${String(slotIndex)}"]`,
    ) as HTMLElement | null;
    if (slot === null) {
      return;
    }
    slot.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  update(): void {
    if (!this.open || !this.visible) {
      return;
    }
    const n = this.deps.getChestSlotCount();
    if (n <= 0) {
      return;
    }
    if (n !== this.lastBuiltSlotCount) {
      this.rebuildGrid(n);
    }
    const urlLookup = this.deps.getItemIconUrlLookup();
    for (let i = 0; i < n; i++) {
      const stack = this.deps.getChestStack(i);
      const icon = this.iconEls[i]!;
      const count = this.countEls[i]!;
      if (stack === null || stack.count <= 0) {
        icon.style.cssText = "";
        icon.removeAttribute("title");
        count.textContent = "";
        continue;
      }
      const def = this.itemRegistry.getById(stack.itemId);
      if (def !== undefined && urlLookup !== null) {
        icon.style.cssText = getItemIconStyleForDefinition(def, urlLookup, ICON_PX);
        icon.title = def.displayName;
      } else {
        icon.style.cssText = "";
        icon.removeAttribute("title");
      }
      count.textContent = stack.count > 1 ? String(stack.count) : "";
    }
  }
}
