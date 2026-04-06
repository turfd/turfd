/** DOM inventory overlay (27 main + 9 hotbar), slot interactions, and cursor stack wiring. */

import {
  HOTBAR_SIZE,
  INVENTORY_ANIM_MS,
  INVENTORY_ITEM_ICON_DISPLAY_PX,
  INVENTORY_SIZE,
  PLAYER_HEART_COUNT,
  PLAYER_MAX_HEALTH,
} from "../core/constants";
import type { ItemDefinition, ItemId, ItemStack } from "../core/itemDefinition";
import type { ItemRegistry } from "../items/ItemRegistry";
import type { PlayerInventory } from "../items/PlayerInventory";
import { fetchItemIconUrlMapForRegistry } from "../core/textureManifest";
import type { ItemIconUrlLookup } from "./atlasItemIcon";
import { getItemIconStyleForDefinition } from "./atlasItemIcon";
import "./inventory.css";

export type { ItemIconUrlLookup } from "./atlasItemIcon";

type GetInventory = () => PlayerInventory;

/** Shift–LMB quick-move from an overlay slot (Game wires chest priority + fly animation). */
export type ShiftQuickMoveFromOverlayHandler = (
  slotIndex: number,
  slotElement: HTMLElement,
) => void;

export type InventoryUIOptions = {
  onHotbarSelect?: (slot: number) => void;
  /** When true, tapping bottom hotbar slots (inventory closed) selects that slot. */
  hotbarTouchSelectEnabled?: boolean;
};

/** Below this hold time (ms), LMB on a slot uses normal click (whole stack). */
const PARTIAL_TAP_MS = 200;
/** Total ms from pointer down to full partial pickup amount. */
const PARTIAL_HOLD_FULL_MS = 1000;

const INV_FONT_STYLE_ID = "stratum-inventory-fonts";

function ensureInventoryFonts(): void {
  if (document.getElementById(INV_FONT_STYLE_ID) !== null) {
    return;
  }
  const base = import.meta.env.BASE_URL;
  const style = document.createElement("style");
  style.id = INV_FONT_STYLE_ID;
  style.textContent = `
    @font-face {
      font-family: 'M5x7';
      src: url('${base}assets/fonts/m5x7.ttf') format('truetype');
      font-weight: normal;
      font-style: normal;
    }
  `;
  document.head.appendChild(style);
}

/** Selected-slot name above hotbar: visible duration before fade-out. */
const HOTBAR_NAME_HOLD_MS = 2200;
/** After fade-out class removed, clear text once opacity transition finishes. */
const HOTBAR_NAME_CLEAR_MS = 280;

export class InventoryUI {
  private readonly root: HTMLDivElement;
  private readonly hotbarStackEl: HTMLDivElement;
  private readonly hotbarSlots: HTMLDivElement[] = [];
  private readonly hotbarIcons: HTMLDivElement[] = [];
  private readonly hotbarCounts: HTMLSpanElement[] = [];
  private readonly overlaySlots: HTMLDivElement[] = [];
  private readonly overlayIcons: HTMLDivElement[] = [];
  private readonly overlayCounts: HTMLSpanElement[] = [];
  private readonly itemRegistry: ItemRegistry;
  private readonly getInventory: GetInventory;
  private iconUrlLookup: Map<string, string> | null = null;
  private readonly overlay: HTMLDivElement;
  private readonly chestMount: HTMLDivElement;
  private readonly craftingMount: HTMLDivElement;
  private readonly overlayRowEl: HTMLDivElement;
  private readonly invPanelEl: HTMLDivElement;
  private readonly panelResizeObserver: ResizeObserver;
  private readonly hotbarItemNameEl: HTMLDivElement;
  private readonly heartsRowEl: HTMLDivElement;
  private readonly heartClipEls: HTMLDivElement[] = [];
  private prevHealthForAria = -1;
  private readonly itemTooltipEl: HTMLDivElement;
  private tooltipActiveSlot: number | null = null;
  private inventoryOpen = false;

  private prevHotbarSlotForLabel = -1;
  private prevHotbarSelectionKey = "";
  private hotbarNameHideTimer: ReturnType<typeof setTimeout> | null = null;
  private hotbarNameClearTimer: ReturnType<typeof setTimeout> | null = null;

  private pointerDownSlot: number | null = null;
  private pointerDownSlotEl: HTMLElement | null = null;
  private pointerDownButton: number | null = null;
  private dragOccurred = false;
  private rmbPlacedOnDown = false;

  /** Previous serialized stack per slot; null until first {@link update} (avoids startup bump spam). */
  private prevInventoryKeys: string[] | null = null;

  private readonly onShiftQuickMoveFromOverlay: ShiftQuickMoveFromOverlayHandler | null;
  private readonly onHotbarSelect: ((slot: number) => void) | null;
  private readonly hotbarTouchSelectEnabled: boolean;
  private hotbarTapSlot: number | null = null;
  private hotbarTapPointerId: number | null = null;
  private hotbarTapStartMs = 0;
  private partialHoldStartMs = 0;
  private partialEnterTimer: ReturnType<typeof setTimeout> | null = null;
  private partialBarVisible = false;

  private static slotKey(
    stack: { itemId: ItemId; count: number; damage?: number } | null,
  ): string {
    if (stack === null || stack.count <= 0) {
      return "empty";
    }
    return `${stack.itemId}:${stack.count}:${stack.damage ?? 0}`;
  }

  private clearHotbarNameTimers(): void {
    if (this.hotbarNameHideTimer !== null) {
      clearTimeout(this.hotbarNameHideTimer);
      this.hotbarNameHideTimer = null;
    }
    if (this.hotbarNameClearTimer !== null) {
      clearTimeout(this.hotbarNameClearTimer);
      this.hotbarNameClearTimer = null;
    }
  }

  /** Fade in selected item name above hotbar; fade out after {@link HOTBAR_NAME_HOLD_MS}. */
  private showHotbarItemName(displayName: string): void {
    const el = this.hotbarItemNameEl;
    this.clearHotbarNameTimers();
    el.textContent = displayName;
    el.classList.remove("inv-hotbar-item-name--visible");
    requestAnimationFrame(() => {
      el.classList.add("inv-hotbar-item-name--visible");
    });
    this.hotbarNameHideTimer = setTimeout(() => {
      this.hotbarNameHideTimer = null;
      el.classList.remove("inv-hotbar-item-name--visible");
      this.hotbarNameClearTimer = setTimeout(() => {
        this.hotbarNameClearTimer = null;
        el.textContent = "";
      }, HOTBAR_NAME_CLEAR_MS);
    }, HOTBAR_NAME_HOLD_MS);
  }

  private hideHotbarItemNameImmediate(): void {
    this.clearHotbarNameTimers();
    const el = this.hotbarItemNameEl;
    el.classList.remove("inv-hotbar-item-name--visible");
    el.textContent = "";
  }

  private hideItemTooltip(): void {
    this.tooltipActiveSlot = null;
    this.itemTooltipEl.classList.remove("inv-item-tooltip--visible");
    this.itemTooltipEl.replaceChildren();
  }

  private fillItemTooltip(def: ItemDefinition): void {
    const root = this.itemTooltipEl;
    root.replaceChildren();
    const nameLine = document.createElement("div");
    nameLine.className = "inv-item-tooltip__name";
    nameLine.textContent = def.displayName;
    root.appendChild(nameLine);
    const tip = def.inventoryTooltip;
    if (tip !== undefined && tip.length > 0) {
      const detail = document.createElement("div");
      detail.className = "inv-item-tooltip__detail";
      detail.textContent = tip;
      root.appendChild(detail);
    }
  }

  private positionItemTooltip(clientX: number, clientY: number): void {
    const pad = 12;
    const el = this.itemTooltipEl;
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

  private bindSlotTooltip(slot: HTMLDivElement, slotIndex: number): void {
    slot.addEventListener("mouseenter", (e: MouseEvent) => {
      if (this.iconUrlLookup === null) {
        return;
      }
      const stack = this.getInventory().getStack(slotIndex);
      if (stack === null || stack.count <= 0) {
        return;
      }
      const def = this.itemRegistry.getById(stack.itemId);
      if (def === undefined) {
        return;
      }
      this.tooltipActiveSlot = slotIndex;
      this.fillItemTooltip(def);
      this.itemTooltipEl.classList.add("inv-item-tooltip--visible");
      requestAnimationFrame(() => {
        this.positionItemTooltip(e.clientX, e.clientY);
      });
    });
    slot.addEventListener("mousemove", (e: MouseEvent) => {
      if (this.tooltipActiveSlot !== slotIndex) {
        return;
      }
      if (!this.itemTooltipEl.classList.contains("inv-item-tooltip--visible")) {
        return;
      }
      this.positionItemTooltip(e.clientX, e.clientY);
    });
    slot.addEventListener("mouseleave", () => {
      if (this.tooltipActiveSlot === slotIndex) {
        this.hideItemTooltip();
      }
    });
  }

  private readonly onWindowPointerUp = (e: PointerEvent | MouseEvent): void => {
    const button = e.button;
    const shiftKey = e.shiftKey;
    const pointerId =
      "pointerId" in e && typeof e.pointerId === "number"
        ? e.pointerId
        : -1;

    const hotbarPointerMatch =
      this.hotbarTapPointerId !== null &&
      (pointerId === this.hotbarTapPointerId ||
        (pointerId === -1 && e instanceof MouseEvent));
    if (hotbarPointerMatch) {
      const slot = this.hotbarTapSlot;
      const start = this.hotbarTapStartMs;
      this.hotbarTapPointerId = null;
      this.hotbarTapSlot = null;
      if (
        slot !== null &&
        !this.inventoryOpen &&
        this.onHotbarSelect !== null &&
        button === 0 &&
        performance.now() - start < 500
      ) {
        this.onHotbarSelect(slot);
      }
    }

    if (this.pointerDownSlot === null) {
      return;
    }
    if (this.pointerDownButton !== button) {
      return;
    }
    const slot = this.pointerDownSlot;
    const downEl = this.pointerDownSlotEl;
    this.pointerDownSlotEl = null;
    if (button === 0) {
      if (!this.dragOccurred) {
        if (shiftKey) {
          if (
            this.onShiftQuickMoveFromOverlay !== null &&
            downEl !== null
          ) {
            this.onShiftQuickMoveFromOverlay(slot, downEl);
          } else {
            this.getInventory().quickMoveFromSlot(slot);
          }
        } else {
          const inv = this.getInventory();
          const cur = inv.getCursorStack();
          if (cur !== null) {
            inv.handleLmbClick(slot);
          } else {
            const elapsed = performance.now() - this.partialHoldStartMs;
            const stack = inv.getStack(slot);
            if (stack !== null && stack.count > 0) {
              if (elapsed < PARTIAL_TAP_MS) {
                inv.handleLmbClick(slot);
              } else {
                const fill = Math.min(1, elapsed / PARTIAL_HOLD_FULL_MS);
                const take = Math.max(1, Math.floor(stack.count * fill));
                inv.pickUpCount(slot, take);
              }
            } else {
              inv.handleLmbClick(slot);
            }
          }
        }
      }
    } else if (button === 2) {
      if (!this.dragOccurred && !this.rmbPlacedOnDown) {
        this.getInventory().handleRmbClick(slot);
      }
      this.rmbPlacedOnDown = false;
    }
    this.hidePartialBar();
    this.pointerDownSlot = null;
    this.pointerDownButton = null;
    this.dragOccurred = false;
  };

  private clearPartialPickupTimer(): void {
    if (this.partialEnterTimer !== null) {
      clearTimeout(this.partialEnterTimer);
      this.partialEnterTimer = null;
    }
  }

  private hidePartialBar(): void {
    this.partialBarVisible = false;
    this.clearPartialPickupTimer();
    for (const el of this.root.querySelectorAll(".inv-slot-partial--visible")) {
      el.classList.remove("inv-slot-partial--visible");
    }
    for (const el of this.root.querySelectorAll(".inv-slot-partial__fill")) {
      (el as HTMLElement).style.width = "0%";
    }
  }

  constructor(
    mount: HTMLElement,
    itemRegistry: ItemRegistry,
    getInventory: GetInventory,
    onShiftQuickMoveFromOverlay: ShiftQuickMoveFromOverlayHandler | null = null,
    options?: InventoryUIOptions,
  ) {
    ensureInventoryFonts();
    this.itemRegistry = itemRegistry;
    this.getInventory = getInventory;
    this.onShiftQuickMoveFromOverlay = onShiftQuickMoveFromOverlay;
    this.onHotbarSelect = options?.onHotbarSelect ?? null;
    this.hotbarTouchSelectEnabled = options?.hotbarTouchSelectEnabled ?? false;

    const root = document.createElement("div");
    root.id = "inventory-ui-root";
    mount.appendChild(root);
    this.root = root;

    const tooltip = document.createElement("div");
    tooltip.className = "inv-item-tooltip";
    tooltip.setAttribute("role", "tooltip");
    root.appendChild(tooltip);
    this.itemTooltipEl = tooltip;

    const hotbarStack = document.createElement("div");
    hotbarStack.className = "inv-hotbar-stack";
    hotbarStack.style.pointerEvents = "none";
    hotbarStack.style.transition = "opacity 0.22s ease, visibility 0.22s ease";
    this.hotbarStackEl = hotbarStack;

    const hotbarName = document.createElement("div");
    hotbarName.className = "inv-hotbar-item-name";
    hotbarName.setAttribute("aria-live", "polite");
    hotbarName.setAttribute("aria-atomic", "true");
    this.hotbarItemNameEl = hotbarName;

    const heartsRow = document.createElement("div");
    heartsRow.className = "inv-hearts-row";
    heartsRow.setAttribute("role", "status");
    heartsRow.setAttribute("aria-live", "polite");
    heartsRow.setAttribute("aria-atomic", "true");
    this.heartsRowEl = heartsRow;
    for (let i = 0; i < PLAYER_HEART_COUNT; i++) {
      const slot = document.createElement("div");
      slot.className = "inv-heart-slot";
      const empty = document.createElement("i");
      empty.className = "fa-solid fa-heart inv-heart inv-heart--empty";
      empty.setAttribute("aria-hidden", "true");
      const clip = document.createElement("div");
      clip.className = "inv-heart-clip inv-heart-clip--full";
      const full = document.createElement("i");
      full.className = "fa-solid fa-heart inv-heart inv-heart--full";
      full.setAttribute("aria-hidden", "true");
      clip.appendChild(full);
      slot.appendChild(empty);
      slot.appendChild(clip);
      heartsRow.appendChild(slot);
      this.heartClipEls.push(clip);
    }

    const hotbarWrap = document.createElement("div");
    hotbarWrap.className = "inv-hotbar-wrap";

    const hotbarRow = document.createElement("div");
    hotbarRow.className = "inv-hotbar-slots";
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      const slot = document.createElement("div");
      slot.className = "inv-slot";
      slot.dataset.slot = String(i);
      const icon = document.createElement("div");
      icon.className = "inv-slot-icon";
      const dur = document.createElement("div");
      dur.className = "inv-slot-durability inv-slot-durability--hidden";
      dur.setAttribute("aria-hidden", "true");
      const durFill = document.createElement("div");
      durFill.className = "inv-slot-durability-fill";
      dur.appendChild(durFill);
      const count = document.createElement("span");
      count.className = "inv-slot-count";
      slot.appendChild(icon);
      slot.appendChild(dur);
      slot.appendChild(count);
      hotbarRow.appendChild(slot);
      this.hotbarSlots.push(slot);
      this.hotbarIcons.push(icon);
      this.hotbarCounts.push(count);
      this.bindSlotElement(slot, i);
      this.bindSlotTooltip(slot, i);
    }
    hotbarWrap.appendChild(hotbarRow);
    hotbarStack.appendChild(hotbarName);
    hotbarStack.appendChild(heartsRow);
    hotbarStack.appendChild(hotbarWrap);
    root.appendChild(hotbarStack);

    const overlay = document.createElement("div");
    overlay.className = "inv-overlay";
    overlay.setAttribute("aria-hidden", "true");

    const overlayRow = document.createElement("div");
    overlayRow.className = "inv-overlay-row";

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
      this.bindSlotTooltip(slot, slotIndex);
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
      this.bindSlotTooltip(slot, i);
    }

    panel.appendChild(title);
    panel.appendChild(labelMain);
    panel.appendChild(gridMain);
    panel.appendChild(sep);
    panel.appendChild(labelHot);
    panel.appendChild(gridHot);

    const chestMount = document.createElement("div");
    chestMount.className = "inv-chest-mount inv-chest-mount--collapsed";
    this.chestMount = chestMount;

    const craftingMount = document.createElement("div");
    craftingMount.className = "inv-crafting-mount";
    this.craftingMount = craftingMount;

    overlayRow.appendChild(panel);
    overlayRow.appendChild(chestMount);
    overlayRow.appendChild(craftingMount);
    overlay.appendChild(overlayRow);
    root.appendChild(overlay);
    this.overlay = overlay;
    this.overlayRowEl = overlayRow;
    this.invPanelEl = panel;
    this.panelResizeObserver = new ResizeObserver(() => {
      this.syncInvSidePanelMaxHeight();
    });
    this.panelResizeObserver.observe(panel);
    window.addEventListener("resize", this.onInvWindowResizeForSidePanels, true);

    window.addEventListener("mouseup", this.onWindowPointerUp, true);
    window.addEventListener("pointerup", this.onWindowPointerUp, true);
    window.addEventListener("pointercancel", this.onWindowPointerUp, true);
  }

  private readonly onInvWindowResizeForSidePanels = (): void => {
    this.syncInvSidePanelMaxHeight();
  };

  /** Keeps chest/crafting columns no taller than the inventory card (see inventory.css). */
  private syncInvSidePanelMaxHeight(): void {
    const h = this.invPanelEl.offsetHeight;
    if (h > 0) {
      this.overlayRowEl.style.setProperty("--inv-panel-sync-height", `${h}px`);
    }
  }

  private bindSlotElement(slot: HTMLDivElement, slotIndex: number): void {
    slot.addEventListener("pointerdown", (e: PointerEvent) => {
      if (!this.inventoryOpen) {
        if (
          slotIndex < HOTBAR_SIZE &&
          this.hotbarTouchSelectEnabled &&
          this.onHotbarSelect !== null &&
          e.button === 0
        ) {
          this.hotbarTapSlot = slotIndex;
          this.hotbarTapPointerId = e.pointerId;
          this.hotbarTapStartMs = performance.now();
        }
        return;
      }
      if (e.button !== 0 && e.button !== 2) {
        return;
      }
      e.preventDefault();
      try {
        slot.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      this.clearPartialPickupTimer();
      this.hidePartialBar();
      this.pointerDownSlot = slotIndex;
      this.pointerDownSlotEl = slot;
      this.pointerDownButton = e.button;
      this.dragOccurred = false;
      this.partialHoldStartMs = performance.now();
      const inv = this.getInventory();
      if (e.button === 2) {
        this.rmbPlacedOnDown = false;
        if (inv.getCursorStack() !== null) {
          inv.placeOneIntoSlot(slotIndex);
          this.rmbPlacedOnDown = true;
        }
      } else {
        const stack = inv.getStack(slotIndex);
        if (
          inv.getCursorStack() === null &&
          stack !== null &&
          stack.count > 1
        ) {
          this.partialEnterTimer = setTimeout(() => {
            this.partialEnterTimer = null;
            if (
              this.pointerDownSlot !== slotIndex ||
              this.pointerDownButton !== 0
            ) {
              return;
            }
            const inv2 = this.getInventory();
            const st = inv2.getStack(slotIndex);
            if (
              inv2.getCursorStack() !== null ||
              st === null ||
              st.count <= 1
            ) {
              return;
            }
            this.partialBarVisible = true;
            const wrap = slot.querySelector(".inv-slot-partial");
            if (wrap !== null) {
              wrap.classList.add("inv-slot-partial--visible");
            }
          }, PARTIAL_TAP_MS);
        }
      }
    });

    slot.addEventListener("pointermove", (_e: PointerEvent) => {
      if (!this.inventoryOpen || !this.partialBarVisible) {
        return;
      }
      if (this.pointerDownSlot !== slotIndex) {
        return;
      }
      const fillEl = slot.querySelector<HTMLElement>(".inv-slot-partial__fill");
      if (fillEl === null) {
        return;
      }
      const elapsed = performance.now() - this.partialHoldStartMs;
      const t = Math.min(1, Math.max(0, elapsed / PARTIAL_HOLD_FULL_MS));
      fillEl.style.width = `${t * 100}%`;
    });

    slot.addEventListener("dblclick", (e: MouseEvent) => {
      if (!this.inventoryOpen || e.button !== 0) {
        return;
      }
      e.preventDefault();
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
    const dur = document.createElement("div");
    dur.className = "inv-slot-durability inv-slot-durability--hidden";
    dur.setAttribute("aria-hidden", "true");
    const durFill = document.createElement("div");
    durFill.className = "inv-slot-durability-fill";
    dur.appendChild(durFill);
    const count = document.createElement("span");
    count.className = "inv-slot-count";
    const partial = document.createElement("div");
    partial.className = "inv-slot-partial";
    const partialFill = document.createElement("div");
    partialFill.className = "inv-slot-partial__fill";
    partial.appendChild(partialFill);
    slot.appendChild(icon);
    slot.appendChild(dur);
    slot.appendChild(count);
    slot.appendChild(partial);
    return { slot, icon, count };
  }

  /** Resolved PNG URLs for DOM item icons (block + item manifests). */
  getItemIconUrlLookup(): ItemIconUrlLookup | null {
    return this.iconUrlLookup;
  }

  /**
   * When true, the chest column is removed from layout (inventory + crafting only).
   * When false, the chest mount reserves space for {@link ChestPanel}.
   */
  setChestMountCollapsed(collapsed: boolean): void {
    this.chestMount.classList.toggle("inv-chest-mount--collapsed", collapsed);
    if (this.inventoryOpen) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          this.syncInvSidePanelMaxHeight();
        });
      });
    }
  }

  /** Mount point for {@link ChestPanel} (between inventory and crafting). */
  getChestMount(): HTMLElement {
    return this.chestMount;
  }

  /** Mount point for {@link CraftingPanel} (sibling of the inventory panel). */
  getCraftingMount(): HTMLElement {
    return this.craftingMount;
  }

  /** Slot cell inside the open inventory overlay (not the world hotbar). */
  getOverlaySlotElement(slotIndex: number): HTMLElement | null {
    return this.root.querySelector(
      `.inv-panel .inv-slot[data-slot="${slotIndex}"]`,
    );
  }

  /** Resolve icon URLs from block + item texture manifests (Bedrock-style split). */
  async loadTextureIcons(): Promise<void> {
    const rec = await fetchItemIconUrlMapForRegistry(this.itemRegistry);
    this.iconUrlLookup = new Map(Object.entries(rec));
  }

  setOpen(open: boolean): void {
    this.inventoryOpen = open;
    if (!open) {
      this.hideItemTooltip();
    }
    this.root.style.setProperty("--inv-anim-ms", `${INVENTORY_ANIM_MS}ms`);
    if (open) {
      this.overlay.classList.add("inv-overlay--open");
      this.overlay.setAttribute("aria-hidden", "false");
      this.root.classList.add("inv-root--open");
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          this.syncInvSidePanelMaxHeight();
        });
      });
    } else {
      this.overlay.classList.remove("inv-overlay--open");
      this.overlay.setAttribute("aria-hidden", "true");
      this.root.classList.remove("inv-root--open");
    }
  }

  private syncHearts(health: number): void {
    const h = Math.max(
      0,
      Math.min(PLAYER_MAX_HEALTH, Math.floor(health)),
    );
    if (h !== this.prevHealthForAria) {
      this.prevHealthForAria = h;
      this.heartsRowEl.setAttribute(
        "aria-label",
        `Health: ${h} of ${PLAYER_MAX_HEALTH}`,
      );
    }
    for (let i = 0; i < PLAYER_HEART_COUNT; i++) {
      const clip = this.heartClipEls[i]!;
      const hpThis = h - i * 2;
      let level: "full" | "half" | "empty";
      if (hpThis >= 2) {
        level = "full";
      } else if (hpThis === 1) {
        level = "half";
      } else {
        level = "empty";
      }
      clip.className = `inv-heart-clip inv-heart-clip--${level}`;
    }
  }

  /**
   * Refreshes all slots from the live inventory (no cached stacks).
   */
  update(
    inventory: PlayerInventory,
    selectedHotbarSlot: number,
    health: number,
  ): void {
    const urlLookup = this.iconUrlLookup;
    const displayPx = INVENTORY_ITEM_ICON_DISPLAY_PX;
    const sel = Math.min(selectedHotbarSlot, HOTBAR_SIZE - 1);

    this.syncHearts(health);

    const bumpSlots = new Set<number>();
    if (this.prevInventoryKeys === null) {
      this.prevInventoryKeys = [];
      for (let s = 0; s < INVENTORY_SIZE; s++) {
        this.prevInventoryKeys[s] = InventoryUI.slotKey(inventory.getStack(s));
      }
    } else {
      for (let s = 0; s < INVENTORY_SIZE; s++) {
        const k = InventoryUI.slotKey(inventory.getStack(s));
        if (this.prevInventoryKeys[s] !== k) {
          this.prevInventoryKeys[s] = k;
          bumpSlots.add(s);
        }
      }
    }

    const selStack = inventory.getStack(sel);
    const selKey =
      selStack !== null && selStack.count > 0
        ? `${sel}:${selStack.itemId}`
        : `${sel}:empty`;
    if (
      sel !== this.prevHotbarSlotForLabel ||
      selKey !== this.prevHotbarSelectionKey
    ) {
      this.prevHotbarSlotForLabel = sel;
      this.prevHotbarSelectionKey = selKey;
      if (selStack !== null && selStack.count > 0) {
        const def = this.itemRegistry.getById(selStack.itemId);
        if (def !== undefined) {
          this.showHotbarItemName(def.displayName);
        } else {
          this.hideHotbarItemNameImmediate();
        }
      } else {
        this.hideHotbarItemNameImmediate();
      }
    }

    for (let i = 0; i < HOTBAR_SIZE; i++) {
      this.fillSlot(
        inventory.getStack(i),
        this.hotbarIcons[i]!,
        this.hotbarCounts[i]!,
        this.hotbarSlots[i]!,
        urlLookup,
        displayPx,
        i === sel,
        bumpSlots.has(i),
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
        urlLookup,
        displayPx,
        isOverlayHotbarRow && slotIndex === sel,
        bumpSlots.has(slotIndex),
      );
    }
  }

  private fillSlot(
    stack: ItemStack | null,
    iconEl: HTMLDivElement,
    countEl: HTMLSpanElement,
    slotEl: HTMLDivElement,
    urlLookup: ItemIconUrlLookup | null,
    displayPx: number,
    selected: boolean,
    playBump: boolean,
  ): void {
    if (selected) {
      slotEl.classList.add("inv-slot--selected");
    } else {
      slotEl.classList.remove("inv-slot--selected");
    }

    const durWrap = slotEl.querySelector<HTMLElement>(".inv-slot-durability");
    const durFill = slotEl.querySelector<HTMLElement>(".inv-slot-durability-fill");

    if (stack === null || stack.count <= 0) {
      iconEl.style.cssText = "";
      iconEl.removeAttribute("title");
      slotEl.removeAttribute("title");
      slotEl.removeAttribute("aria-label");
      countEl.textContent = "";
      durWrap?.classList.add("inv-slot-durability--hidden");
      if (durFill) {
        durFill.style.width = "0%";
        durFill.classList.remove("inv-slot-durability-fill--low");
      }
      if (playBump) {
        this.triggerSlotIconBump(iconEl);
      }
      return;
    }

    const def = this.itemRegistry.getById(stack.itemId);
    if (def === undefined || urlLookup === null) {
      iconEl.style.cssText = "";
      iconEl.removeAttribute("title");
      slotEl.removeAttribute("title");
      slotEl.removeAttribute("aria-label");
      countEl.textContent = stack.count > 1 ? String(stack.count) : "";
      durWrap?.classList.add("inv-slot-durability--hidden");
      if (durFill) {
        durFill.style.width = "0%";
        durFill.classList.remove("inv-slot-durability-fill--low");
      }
      if (playBump) {
        this.triggerSlotIconBump(iconEl);
      }
      return;
    }

    const style = getItemIconStyleForDefinition(def, urlLookup, displayPx);
    iconEl.style.cssText = style;
    iconEl.removeAttribute("title");
    slotEl.removeAttribute("title");
    slotEl.setAttribute("aria-label", def.displayName);

    if (stack.count > 1) {
      countEl.textContent = String(stack.count);
      countEl.classList.remove("inv-slot-count--white");
    } else {
      countEl.textContent = "";
      countEl.classList.remove("inv-slot-count--white");
    }

    const maxD = def.maxDurability;
    if (maxD !== undefined && maxD > 0 && durWrap !== null && durFill !== null) {
      durWrap.classList.remove("inv-slot-durability--hidden");
      const dmg = stack.damage ?? 0;
      const rem = Math.max(0, maxD - dmg);
      const pct = (rem / maxD) * 100;
      durFill.style.width = `${pct}%`;
      durFill.classList.toggle("inv-slot-durability-fill--low", pct <= 25);
    } else {
      durWrap?.classList.add("inv-slot-durability--hidden");
      if (durFill) {
        durFill.style.width = "0%";
        durFill.classList.remove("inv-slot-durability-fill--low");
      }
    }

    if (playBump) {
      this.triggerSlotIconBump(iconEl);
    }
  }

  private triggerSlotIconBump(iconEl: HTMLDivElement): void {
    iconEl.classList.remove("inv-slot-icon--bump");
    requestAnimationFrame(() => {
      void iconEl.offsetWidth;
      iconEl.addEventListener(
        "animationend",
        () => {
          iconEl.classList.remove("inv-slot-icon--bump");
        },
        { once: true },
      );
      iconEl.classList.add("inv-slot-icon--bump");
    });
  }

  /** Toggle bottom hotbar strip (e.g. hidden while chat typing is expanded). */
  setHotbarStackVisible(visible: boolean): void {
    this.hotbarStackEl.style.opacity = visible ? "1" : "0";
    this.hotbarStackEl.style.visibility = visible ? "visible" : "hidden";
  }

  destroy(): void {
    this.hideItemTooltip();
    this.clearHotbarNameTimers();
    this.clearPartialPickupTimer();
    window.removeEventListener("mouseup", this.onWindowPointerUp, true);
    window.removeEventListener("pointerup", this.onWindowPointerUp, true);
    window.removeEventListener("pointercancel", this.onWindowPointerUp, true);
    this.root.remove();
  }
}
