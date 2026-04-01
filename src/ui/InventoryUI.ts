/** DOM inventory overlay (27 main + 9 hotbar), slot interactions, and cursor stack wiring. */

import { HOTBAR_SIZE } from "../core/constants";
import type { ItemId } from "../core/itemDefinition";
import type { ItemRegistry } from "../items/ItemRegistry";
import type { PlayerInventory } from "../items/PlayerInventory";
import type { AtlasIconLayout, AtlasJson } from "./atlasItemIcon";
import { getItemIconStyle } from "./atlasItemIcon";
import "./inventory.css";

export type { AtlasIconLayout } from "./atlasItemIcon";

type GetInventory = () => PlayerInventory;

export class InventoryUI {
  private readonly root: HTMLDivElement;
  private readonly hotbarSlots: HTMLDivElement[] = [];
  private readonly hotbarIcons: HTMLDivElement[] = [];
  private readonly hotbarCounts: HTMLSpanElement[] = [];
  private readonly overlaySlots: HTMLDivElement[] = [];
  private readonly overlayIcons: HTMLDivElement[] = [];
  private readonly overlayCounts: HTMLSpanElement[] = [];
  private readonly itemRegistry: ItemRegistry;
  private readonly getInventory: GetInventory;
  private layout: AtlasIconLayout | null = null;
  private readonly overlay: HTMLDivElement;
  private inventoryOpen = false;

  private pointerDownSlot: number | null = null;
  private pointerDownButton: number | null = null;
  private dragOccurred = false;
  private rmbPlacedOnDown = false;
  private lmbClickTimer: ReturnType<typeof setTimeout> | null = null;
  private lmbDeferredSlot: number | null = null;

  private flushDeferredLmbClick(): void {
    if (this.lmbClickTimer !== null) {
      clearTimeout(this.lmbClickTimer);
      this.lmbClickTimer = null;
    }
    if (this.lmbDeferredSlot !== null) {
      const s = this.lmbDeferredSlot;
      this.lmbDeferredSlot = null;
      this.getInventory().handleLmbClick(s);
    }
  }

  /** If a delayed LMB click is pending for another slot, run it now (Minecraft-style slot switching). */
  private flushDeferredLmbIfSwitching(newSlot: number): void {
    if (this.lmbDeferredSlot === null) {
      return;
    }
    if (this.lmbDeferredSlot === newSlot) {
      return;
    }
    this.flushDeferredLmbClick();
  }

  private readonly onWindowMouseUp = (e: MouseEvent): void => {
    if (this.pointerDownSlot === null) {
      return;
    }
    if (this.pointerDownButton !== e.button) {
      return;
    }
    const slot = this.pointerDownSlot;
    if (e.button === 0) {
      if (this.lmbClickTimer !== null) {
        clearTimeout(this.lmbClickTimer);
        this.lmbClickTimer = null;
      }
      this.lmbDeferredSlot = null;
      if (!this.dragOccurred) {
        if (e.shiftKey) {
          this.getInventory().quickMoveFromSlot(slot);
        } else {
          this.lmbDeferredSlot = slot;
          this.lmbClickTimer = setTimeout(() => {
            this.lmbClickTimer = null;
            this.lmbDeferredSlot = null;
            this.getInventory().handleLmbClick(slot);
          }, 220);
        }
      }
    } else if (e.button === 2) {
      if (!this.dragOccurred && !this.rmbPlacedOnDown) {
        this.getInventory().handleRmbClick(slot);
      }
      this.rmbPlacedOnDown = false;
    }
    this.pointerDownSlot = null;
    this.pointerDownButton = null;
    this.dragOccurred = false;
  };

  constructor(mount: HTMLElement, itemRegistry: ItemRegistry, getInventory: GetInventory) {
    this.itemRegistry = itemRegistry;
    this.getInventory = getInventory;

    const root = document.createElement("div");
    root.id = "inventory-ui-root";
    mount.appendChild(root);
    this.root = root;

    const hotbarWrap = document.createElement("div");
    hotbarWrap.className = "inv-hotbar-wrap";
    hotbarWrap.style.pointerEvents = "none";
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      const slot = document.createElement("div");
      slot.className = "inv-slot";
      slot.dataset.slot = String(i);
      const icon = document.createElement("div");
      icon.className = "inv-slot-icon";
      const count = document.createElement("span");
      count.className = "inv-slot-count";
      slot.appendChild(icon);
      slot.appendChild(count);
      hotbarWrap.appendChild(slot);
      this.hotbarSlots.push(slot);
      this.hotbarIcons.push(icon);
      this.hotbarCounts.push(count);
      this.bindSlotElement(slot, i);
    }
    root.appendChild(hotbarWrap);

    const overlay = document.createElement("div");
    overlay.className = "inv-overlay";
    overlay.setAttribute("aria-hidden", "true");

    const panel = document.createElement("div");
    panel.className = "inv-panel";

    const title = document.createElement("div");
    title.className = "inv-panel-title";
    title.textContent = "Inventory";

    const labelMain = document.createElement("div");
    labelMain.className = "inv-label-row";
    labelMain.textContent = "Storage";

    const gridMain = document.createElement("div");
    gridMain.className = "inv-grid inv-grid--main";
    for (let i = 0; i < 27; i++) {
      const slotIndex = 9 + i;
      const { slot, icon, count } = this.makeSlotElements(String(slotIndex));
      gridMain.appendChild(slot);
      this.overlaySlots.push(slot);
      this.overlayIcons.push(icon);
      this.overlayCounts.push(count);
      this.bindSlotElement(slot, slotIndex);
    }

    const sep = document.createElement("div");
    sep.className = "inv-separator";

    const labelHot = document.createElement("div");
    labelHot.className = "inv-label-row";
    labelHot.textContent = "Hotbar";

    const gridHot = document.createElement("div");
    gridHot.className = "inv-grid";
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      const { slot, icon, count } = this.makeSlotElements(String(i));
      gridHot.appendChild(slot);
      this.overlaySlots.push(slot);
      this.overlayIcons.push(icon);
      this.overlayCounts.push(count);
      this.bindSlotElement(slot, i);
    }

    panel.appendChild(title);
    panel.appendChild(labelMain);
    panel.appendChild(gridMain);
    panel.appendChild(sep);
    panel.appendChild(labelHot);
    panel.appendChild(gridHot);
    overlay.appendChild(panel);
    root.appendChild(overlay);
    this.overlay = overlay;

    window.addEventListener("mouseup", this.onWindowMouseUp, true);
  }

  private bindSlotElement(slot: HTMLDivElement, slotIndex: number): void {
    slot.addEventListener("mousedown", (e: MouseEvent) => {
      if (!this.inventoryOpen) {
        return;
      }
      if (e.button !== 0 && e.button !== 2) {
        return;
      }
      e.preventDefault();
      if (e.button === 0) {
        this.flushDeferredLmbIfSwitching(slotIndex);
      }
      this.pointerDownSlot = slotIndex;
      this.pointerDownButton = e.button;
      this.dragOccurred = false;
      if (e.button === 2) {
        this.rmbPlacedOnDown = false;
        const inv = this.getInventory();
        if (inv.getCursorStack() !== null) {
          inv.placeOneIntoSlot(slotIndex);
          this.rmbPlacedOnDown = true;
        }
      }
    });

    slot.addEventListener("dblclick", (e: MouseEvent) => {
      if (!this.inventoryOpen || e.button !== 0) {
        return;
      }
      e.preventDefault();
      if (this.lmbClickTimer !== null) {
        clearTimeout(this.lmbClickTimer);
        this.lmbClickTimer = null;
      }
      this.lmbDeferredSlot = null;
      this.getInventory().collectSameItemIntoSlot(slotIndex);
    });

    slot.addEventListener("mouseenter", (e: MouseEvent) => {
      if (!this.inventoryOpen) {
        return;
      }
      if (this.pointerDownSlot !== null && slotIndex !== this.pointerDownSlot) {
        this.dragOccurred = true;
      }
      const inv = this.getInventory();
      if ((e.buttons & 1) !== 0 && inv.getCursorStack() !== null) {
        inv.distributeOneFromCursorIntoSlot(slotIndex);
      }
      if ((e.buttons & 2) !== 0 && inv.getCursorStack() !== null) {
        inv.placeOneIntoSlot(slotIndex);
      }
    });

    slot.addEventListener(
      "wheel",
      (e: WheelEvent) => {
        if (!this.inventoryOpen) {
          return;
        }
        e.preventDefault();
        this.getInventory().scrollTransferOne(slotIndex, e.deltaY);
      },
      { passive: false },
    );

    slot.addEventListener("contextmenu", (e: Event) => {
      if (this.inventoryOpen) {
        e.preventDefault();
      }
    });
  }

  private makeSlotElements(dataSlot: string): {
    slot: HTMLDivElement;
    icon: HTMLDivElement;
    count: HTMLSpanElement;
  } {
    const slot = document.createElement("div");
    slot.className = "inv-slot";
    slot.dataset.slot = dataSlot;
    const icon = document.createElement("div");
    icon.className = "inv-slot-icon";
    const count = document.createElement("span");
    count.className = "inv-slot-count";
    slot.appendChild(icon);
    slot.appendChild(count);
    return { slot, icon, count };
  }

  /** Atlas layout for cursor overlay (same as slot icons). */
  getAtlasLayout(): AtlasIconLayout | null {
    return this.layout;
  }

  /** Load atlas metadata for CSS sprites (call after mount; same URLs as AtlasLoader). */
  async loadAtlasLayout(): Promise<void> {
    const base = import.meta.env.BASE_URL;
    const jsonUrl = `${base}assets/textures/atlas.json`;
    const res = await fetch(jsonUrl);
    if (!res.ok) {
      throw new Error(`InventoryUI: failed to load ${jsonUrl}`);
    }
    const raw: unknown = await res.json();
    const data = raw as AtlasJson;
    const imageUrl = new URL(data.meta.image, new URL(jsonUrl, window.location.href)).href;
    this.layout = {
      atlasImageUrl: imageUrl,
      atlasW: data.meta.size.w,
      atlasH: data.meta.size.h,
      frames: data.frames,
    };
  }

  setOpen(open: boolean): void {
    this.inventoryOpen = open;
    if (open) {
      this.overlay.classList.add("inv-overlay--open");
      this.overlay.setAttribute("aria-hidden", "false");
      this.root.classList.add("inv-root--open");
    } else {
      this.overlay.classList.remove("inv-overlay--open");
      this.overlay.setAttribute("aria-hidden", "true");
      this.root.classList.remove("inv-root--open");
    }
  }

  /**
   * Refreshes all slots from the live inventory (no cached stacks).
   */
  update(inventory: PlayerInventory, selectedHotbarSlot: number): void {
    const layout = this.layout;
    const displayPx = 32;
    const sel = Math.min(selectedHotbarSlot, HOTBAR_SIZE - 1);

    for (let i = 0; i < HOTBAR_SIZE; i++) {
      this.fillSlot(
        inventory.getStack(i),
        this.hotbarIcons[i]!,
        this.hotbarCounts[i]!,
        this.hotbarSlots[i]!,
        layout,
        displayPx,
        i === sel,
      );
    }

    for (let i = 0; i < this.overlayIcons.length; i++) {
      const slotIndex = i < 27 ? 9 + i : i - 27;
      const stack = inventory.getStack(slotIndex);
      const isOverlayHotbarRow = i >= 27;
      this.fillSlot(
        stack,
        this.overlayIcons[i]!,
        this.overlayCounts[i]!,
        this.overlaySlots[i]!,
        layout,
        displayPx,
        isOverlayHotbarRow && slotIndex === sel,
      );
    }
  }

  private fillSlot(
    stack: { itemId: ItemId; count: number } | null,
    iconEl: HTMLDivElement,
    countEl: HTMLSpanElement,
    slotEl: HTMLDivElement,
    layout: AtlasIconLayout | null,
    displayPx: number,
    selected: boolean,
  ): void {
    if (selected) {
      slotEl.classList.add("inv-slot--selected");
    } else {
      slotEl.classList.remove("inv-slot--selected");
    }

    if (stack === null || stack.count <= 0) {
      iconEl.style.cssText = "";
      iconEl.removeAttribute("title");
      countEl.textContent = "";
      return;
    }

    const def = this.itemRegistry.getById(stack.itemId);
    if (def === undefined || layout === null) {
      iconEl.style.cssText = "";
      countEl.textContent = stack.count > 1 ? String(stack.count) : "";
      return;
    }

    const style = getItemIconStyle(def.textureName, layout, displayPx);
    iconEl.style.cssText = style;
    iconEl.title = def.displayName;

    if (stack.count > 1) {
      countEl.textContent = String(stack.count);
      countEl.classList.remove("inv-slot-count--white");
    } else {
      countEl.textContent = "";
      countEl.classList.remove("inv-slot-count--white");
    }
  }

  destroy(): void {
    window.removeEventListener("mouseup", this.onWindowMouseUp, true);
    if (this.lmbClickTimer !== null) {
      clearTimeout(this.lmbClickTimer);
      this.lmbClickTimer = null;
    }
    this.lmbDeferredSlot = null;
    this.root.remove();
  }
}
