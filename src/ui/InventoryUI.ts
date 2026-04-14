/** DOM inventory overlay (27 main + 9 hotbar), slot interactions, and cursor stack wiring. */

import {
  ARMOR_SLOT_COUNT,
  ARMOR_UI_SLOT_BASE,
  bowDrawItemTextureName,
  HOTBAR_SIZE,
  INVENTORY_ANIM_MS,
  INVENTORY_ITEM_ICON_DISPLAY_PX,
  INVENTORY_SIZE,
  PLAYER_HEART_COUNT,
  PLAYER_MAX_HEALTH,
} from "../core/constants";
import type { ItemDefinition, ItemId, ItemStack } from "../core/itemDefinition";
import type { ItemRegistry } from "../items/ItemRegistry";
import type { ArmorSlot, PlayerInventory } from "../items/PlayerInventory";
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
  private readonly hotbarDurabilityWraps: HTMLDivElement[] = [];
  private readonly hotbarDurabilityFills: HTMLDivElement[] = [];
  private readonly overlaySlots: HTMLDivElement[] = [];
  private readonly overlayIcons: HTMLDivElement[] = [];
  private readonly overlayCounts: HTMLSpanElement[] = [];
  private readonly overlayDurabilityWraps: HTMLDivElement[] = [];
  private readonly overlayDurabilityFills: HTMLDivElement[] = [];
  /** Armor slots: 0=helmet, 1=chestplate, 2=leggings, 3=boots */
  private readonly armorSlots: HTMLDivElement[] = [];
  private readonly armorIcons: HTMLDivElement[] = [];
  private readonly armorCounts: HTMLSpanElement[] = [];
  private readonly armorDurabilityWraps: HTMLDivElement[] = [];
  private readonly armorDurabilityFills: HTMLDivElement[] = [];
  private readonly armorEmptySlotBackgrounds: string[] = [];
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
  private readonly armorHudRowEl: HTMLDivElement;
  /** HUD armor shields beside hearts (one clip per {@link PLAYER_HEART_COUNT}). */
  private readonly armorHudClipEls: HTMLDivElement[] = [];
  private prevHealthForAria = -1;
  private prevArmorHudPointsTen = -1;
  private readonly itemTooltipEl: HTMLDivElement;
  private tooltipActiveSlot: number | null = null;
  private inventoryOpen = false;
  private overlayDirty = true;

  private prevHotbarSlotForLabel = -1;
  private prevHotbarSelectionKey = "";
  private prevSelectedHotbarSlot = -1;
  private hotbarNameHideTimer: ReturnType<typeof setTimeout> | null = null;
  private hotbarNameClearTimer: ReturnType<typeof setTimeout> | null = null;

  private pointerDownSlot: number | null = null;
  private pointerDownSlotEl: HTMLElement | null = null;
  private pointerDownButton: number | null = null;
  private dragOccurred = false;
  private rmbPlacedOnDown = false;

  /** Previous serialized stack per slot; null until first {@link update} (avoids startup bump spam). */
  private prevInventoryKeys: string[] | null = null;
  /** Last bow icon atlas key for selected hotbar (so pull frames refresh while drawing). */
  private prevBowHotbarVisualKey = "";

  private readonly onShiftQuickMoveFromOverlay: ShiftQuickMoveFromOverlayHandler | null;
  private readonly onDropCursorStackOutside:
    | ((stack: ItemStack) => void)
    | null;

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

  private readonly onWindowMouseUp = (e: MouseEvent): void => {
    if (this.pointerDownSlot === null) {
      return;
    }
    if (this.pointerDownButton !== e.button) {
      return;
    }
    const slot = this.pointerDownSlot;
    const downEl = this.pointerDownSlotEl;
    this.pointerDownSlotEl = null;
    const inv = this.getInventory();
    if (e.button === 0) {
      if (!this.dragOccurred) {
        if (e.shiftKey) {
          if (
            this.onShiftQuickMoveFromOverlay !== null &&
            downEl !== null
          ) {
            this.onShiftQuickMoveFromOverlay(slot, downEl);
          } else if (slot < INVENTORY_SIZE) {
            this.getInventory().quickMoveFromSlot(slot);
          }
        } else if (
          slot >= ARMOR_UI_SLOT_BASE &&
          slot < ARMOR_UI_SLOT_BASE + ARMOR_SLOT_COUNT
        ) {
          this.getInventory().handleArmorSlotLmbClick(
            (slot - ARMOR_UI_SLOT_BASE) as ArmorSlot,
          );
        } else {
          this.getInventory().handleLmbClick(slot);
        }
      } else {
        // Dropping on the dim backdrop hits `.inv-overlay` (still under #inventory-ui-root).
        // Only the panel/chest/crafting row should count as "inside" the UI chrome.
        const cur = inv.getCursorStack();
        const target = e.target as Node | null;
        const droppedOutside =
          cur !== null &&
          (target === null || !this.overlayRowEl.contains(target));
        if (droppedOutside && this.onDropCursorStackOutside !== null) {
          this.onDropCursorStackOutside(cur);
          inv.replaceCursorStack(null);
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

  constructor(
    mount: HTMLElement,
    itemRegistry: ItemRegistry,
    getInventory: GetInventory,
    onShiftQuickMoveFromOverlay: ShiftQuickMoveFromOverlayHandler | null = null,
    onDropCursorStackOutside: ((stack: ItemStack) => void) | null = null,
  ) {
    ensureInventoryFonts();
    this.itemRegistry = itemRegistry;
    this.getInventory = getInventory;
    this.onShiftQuickMoveFromOverlay = onShiftQuickMoveFromOverlay;
    this.onDropCursorStackOutside = onDropCursorStackOutside;

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

    const armorHudRow = document.createElement("div");
    armorHudRow.className = "inv-armor-hud-row";
    armorHudRow.setAttribute("role", "status");
    armorHudRow.setAttribute("aria-live", "polite");
    armorHudRow.setAttribute("aria-atomic", "true");
    this.armorHudRowEl = armorHudRow;
    for (let i = 0; i < PLAYER_HEART_COUNT; i++) {
      const slot = document.createElement("div");
      slot.className = "inv-shield-slot";
      const empty = document.createElement("i");
      empty.className = "fa-solid fa-shield inv-shield inv-shield--empty";
      empty.setAttribute("aria-hidden", "true");
      const clip = document.createElement("div");
      clip.className = "inv-heart-clip inv-heart-clip--empty";
      const full = document.createElement("i");
      full.className = "fa-solid fa-shield inv-shield inv-shield--full";
      full.setAttribute("aria-hidden", "true");
      clip.appendChild(full);
      slot.appendChild(empty);
      slot.appendChild(clip);
      armorHudRow.appendChild(slot);
      this.armorHudClipEls.push(clip);
    }

    const hudStatusRow = document.createElement("div");
    hudStatusRow.className = "inv-hud-status-row";
    hudStatusRow.appendChild(heartsRow);
    hudStatusRow.appendChild(armorHudRow);

    const hotbarChrome = document.createElement("div");
    hotbarChrome.className = "inv-hotbar-chrome";

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
      this.hotbarDurabilityWraps.push(dur);
      this.hotbarDurabilityFills.push(durFill);
      this.bindSlotElement(slot, i);
      this.bindSlotTooltip(slot, i);
    }
    hotbarWrap.appendChild(hotbarRow);
    hotbarChrome.appendChild(hudStatusRow);
    hotbarChrome.appendChild(hotbarWrap);
    hotbarStack.appendChild(hotbarName);
    hotbarStack.appendChild(hotbarChrome);
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

    // Armor slots panel (4 vertical slots on the left)
    const armorPanel = document.createElement("div");
    armorPanel.className = "inv-armor-panel";

    const armorTitle = document.createElement("div");
    armorTitle.className = "inv-panel-title";
    armorTitle.textContent = "Armor";
    armorPanel.appendChild(armorTitle);

    const armorGrid = document.createElement("div");
    armorGrid.className = "inv-grid inv-grid--armor";
    const armorEmptyIcons = [
      "assets/mods/resource_packs/stratum-core/textures/GUI/armor/empty_armor_slot_helmet.png",
      "assets/mods/resource_packs/stratum-core/textures/GUI/armor/empty_armor_slot_chestplate.png",
      "assets/mods/resource_packs/stratum-core/textures/GUI/armor/empty_armor_slot_leggings.png",
      "assets/mods/resource_packs/stratum-core/textures/GUI/armor/empty_armor_slot_boots.png",
    ];
    for (let i = 0; i < 4; i++) {
      const slotIndex = ARMOR_UI_SLOT_BASE + i;
      const emptyIcon = armorEmptyIcons[i]!;
      const { slot, icon, count, dur, durFill } = this.makeSlotElements(
        String(slotIndex),
        emptyIcon,
      );
      armorGrid.appendChild(slot);
      this.armorSlots.push(slot);
      this.armorIcons.push(icon);
      this.armorCounts.push(count);
      this.armorDurabilityWraps.push(dur);
      this.armorDurabilityFills.push(durFill);
      this.armorEmptySlotBackgrounds.push(emptyIcon);
      this.bindArmorSlotElement(slot, i as import("../items/PlayerInventory").ArmorSlot);
      this.bindArmorSlotTooltip(slot, i as import("../items/PlayerInventory").ArmorSlot);
    }
    armorPanel.appendChild(armorGrid);

    const labelMain = document.createElement("div");
    labelMain.className = "inv-label-row";
    labelMain.textContent = "Storage";

    const gridMain = document.createElement("div");
    gridMain.className = "inv-grid inv-grid--main";
    for (let i = 0; i < 27; i++) {
      const slotIndex = 9 + i;
      const { slot, icon, count, dur, durFill } = this.makeSlotElements(
        String(slotIndex),
      );
      gridMain.appendChild(slot);
      this.overlaySlots.push(slot);
      this.overlayIcons.push(icon);
      this.overlayCounts.push(count);
      this.overlayDurabilityWraps.push(dur);
      this.overlayDurabilityFills.push(durFill);
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
      const { slot, icon, count, dur, durFill } = this.makeSlotElements(
        String(i),
      );
      gridHot.appendChild(slot);
      this.overlaySlots.push(slot);
      this.overlayIcons.push(icon);
      this.overlayCounts.push(count);
      this.overlayDurabilityWraps.push(dur);
      this.overlayDurabilityFills.push(durFill);
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

    overlayRow.appendChild(armorPanel);
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

    window.addEventListener("mouseup", this.onWindowMouseUp, true);
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
    slot.addEventListener("mousedown", (e: MouseEvent) => {
      if (!this.inventoryOpen) {
        return;
      }
      if (e.button !== 0 && e.button !== 2) {
        return;
      }
      e.preventDefault();
      this.pointerDownSlot = slotIndex;
      this.pointerDownSlotEl = slot;
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

  private makeSlotElements(dataSlot: string, backgroundImage?: string): {
    slot: HTMLDivElement;
    icon: HTMLDivElement;
    count: HTMLSpanElement;
    dur: HTMLDivElement;
    durFill: HTMLDivElement;
  } {
    const slot = document.createElement("div");
    slot.className = "inv-slot";
    slot.dataset.slot = dataSlot;
    if (backgroundImage) {
      slot.style.backgroundImage = `url(${backgroundImage})`;
      slot.style.backgroundSize = "cover";
      slot.style.backgroundPosition = "center";
    }
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
    return { slot, icon, count, dur, durFill };
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

  /** Armor column slot cell (helmet … boots). */
  getArmorSlotElement(armorSlot: ArmorSlot): HTMLElement | null {
    return this.root.querySelector(
      `.inv-armor-panel .inv-slot[data-slot="${ARMOR_UI_SLOT_BASE + armorSlot}"]`,
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
      this.overlayDirty = true;
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
    if (h === this.prevHealthForAria) {
      return;
    }
    this.prevHealthForAria = h;
    this.heartsRowEl.setAttribute(
      "aria-label",
      `Health: ${h} of ${PLAYER_MAX_HEALTH}`,
    );
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

  private syncArmorHud(inventory: PlayerInventory): void {
    const u = inventory.getEquippedArmorDurabilityPointsTen();
    const hasArmor = u > 0;
    this.armorHudRowEl.classList.toggle("inv-armor-hud-row--hidden", !hasArmor);
    this.armorHudRowEl.setAttribute("aria-hidden", hasArmor ? "false" : "true");
    if (u !== this.prevArmorHudPointsTen) {
      this.prevArmorHudPointsTen = u;
      this.armorHudRowEl.setAttribute(
        "aria-label",
        `Armor durability: ${u} of 10`,
      );
    }
    for (let i = 0; i < PLAYER_HEART_COUNT; i++) {
      const clip = this.armorHudClipEls[i]!;
      const ptsThis = u - i * 2;
      let level: "full" | "half" | "empty";
      if (ptsThis >= 2) {
        level = "full";
      } else if (ptsThis === 1) {
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
    bowDrawSec: number,
  ): void {
    const urlLookup = this.iconUrlLookup;
    const displayPx = INVENTORY_ITEM_ICON_DISPLAY_PX;
    const sel = Math.min(selectedHotbarSlot, HOTBAR_SIZE - 1);

    this.syncHearts(health);
    this.syncArmorHud(inventory);

    const initialSync = this.prevInventoryKeys === null;
    const bumpSlots = new Set<number>();
    if (initialSync) {
      this.prevInventoryKeys = [];
      for (let s = 0; s < INVENTORY_SIZE; s++) {
        this.prevInventoryKeys[s] = InventoryUI.slotKey(inventory.getStack(s));
      }
    } else {
      const prevKeys = this.prevInventoryKeys;
      if (prevKeys === null) {
        return;
      }
      for (let s = 0; s < INVENTORY_SIZE; s++) {
        const k = InventoryUI.slotKey(inventory.getStack(s));
        if (prevKeys[s] !== k) {
          prevKeys[s] = k;
          bumpSlots.add(s);
        }
      }
    }

    const prevSel = this.prevSelectedHotbarSlot;
    const selectionChanged = sel !== prevSel;
    this.prevSelectedHotbarSlot = sel;

    const selStack = inventory.getStack(sel);
    const bowHotbarVisualKey =
      selStack !== null &&
      selStack.count > 0 &&
      this.itemRegistry.getById(selStack.itemId)?.key === "stratum:bow"
        ? bowDrawItemTextureName(bowDrawSec)
        : "";
    const bowHotbarDirty = bowHotbarVisualKey !== this.prevBowHotbarVisualKey;
    this.prevBowHotbarVisualKey = bowHotbarVisualKey;
    if (bowHotbarDirty) {
      this.overlayDirty = true;
    }

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
      if (
        !initialSync &&
        !bumpSlots.has(i) &&
        !(selectionChanged && (i === sel || i === prevSel)) &&
        !(i === sel && bowHotbarDirty)
      ) {
        continue;
      }
      this.fillSlot(
        inventory.getStack(i),
        this.hotbarIcons[i]!,
        this.hotbarCounts[i]!,
        this.hotbarSlots[i]!,
        this.hotbarDurabilityWraps[i]!,
        this.hotbarDurabilityFills[i]!,
        urlLookup,
        displayPx,
        i === sel,
        bumpSlots.has(i),
        { worldSlot: i, hotbarSelected: sel, bowDrawSec },
      );
    }

    if (!this.inventoryOpen) {
      if (selectionChanged || bumpSlots.size > 0) {
        this.overlayDirty = true;
      }
      return;
    }

    const forceOverlaySync = initialSync || this.overlayDirty;
    for (let i = 0; i < this.overlayIcons.length; i++) {
      const slotIndex = i < 27 ? 9 + i : i - 27;
      const stack = inventory.getStack(slotIndex);
      const isOverlayHotbarRow = i >= 27;
      if (
        !forceOverlaySync &&
        !bumpSlots.has(slotIndex) &&
        !(
          isOverlayHotbarRow &&
          selectionChanged &&
          (slotIndex === sel || slotIndex === prevSel)
        ) &&
        !(isOverlayHotbarRow && slotIndex === sel && bowHotbarDirty)
      ) {
        continue;
      }
      this.fillSlot(
        stack,
        this.overlayIcons[i]!,
        this.overlayCounts[i]!,
        this.overlaySlots[i]!,
        this.overlayDurabilityWraps[i]!,
        this.overlayDurabilityFills[i]!,
        urlLookup,
        displayPx,
        isOverlayHotbarRow && slotIndex === sel,
        bumpSlots.has(slotIndex),
        { worldSlot: slotIndex, hotbarSelected: sel, bowDrawSec },
      );
    }
    this.overlayDirty = false;

    // Sync armor slots (helmet, chestplate, leggings, boots)
    for (let i = 0; i < 4; i++) {
      const armorStack = inventory.getArmorStack(i as import("../items/PlayerInventory").ArmorSlot);
      const slotEl = this.armorSlots[i]!;
      if (armorStack === null || armorStack.count <= 0) {
        const bg = this.armorEmptySlotBackgrounds[i]!;
        slotEl.style.backgroundImage = `url(${bg})`;
        slotEl.style.backgroundSize = "cover";
        slotEl.style.backgroundPosition = "center";
      } else {
        slotEl.style.backgroundImage = "none";
      }
      this.fillSlot(
        armorStack,
        this.armorIcons[i]!,
        this.armorCounts[i]!,
        slotEl,
        this.armorDurabilityWraps[i]!,
        this.armorDurabilityFills[i]!,
        urlLookup,
        displayPx,
        false,
        false,
        undefined,
      );
    }
  }

  private fillSlot(
    stack: ItemStack | null,
    iconEl: HTMLDivElement,
    countEl: HTMLSpanElement,
    slotEl: HTMLDivElement,
    durWrap: HTMLDivElement,
    durFill: HTMLDivElement,
    urlLookup: ItemIconUrlLookup | null,
    displayPx: number,
    selected: boolean,
    playBump: boolean,
    hotbarBowContext?: { worldSlot: number; hotbarSelected: number; bowDrawSec: number },
  ): void {
    if (selected) {
      slotEl.classList.add("inv-slot--selected");
    } else {
      slotEl.classList.remove("inv-slot--selected");
    }

    if (stack === null || stack.count <= 0) {
      iconEl.style.cssText = "";
      iconEl.removeAttribute("title");
      slotEl.removeAttribute("title");
      slotEl.removeAttribute("aria-label");
      countEl.textContent = "";
      durWrap.classList.add("inv-slot-durability--hidden");
      durFill.style.width = "0%";
      durFill.classList.remove("inv-slot-durability-fill--low");
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
      durWrap.classList.add("inv-slot-durability--hidden");
      durFill.style.width = "0%";
      durFill.classList.remove("inv-slot-durability-fill--low");
      if (playBump) {
        this.triggerSlotIconBump(iconEl);
      }
      return;
    }

    const iconDef: Pick<ItemDefinition, "textureName" | "stairItemIconClip"> =
      hotbarBowContext !== undefined &&
      def.key === "stratum:bow" &&
      hotbarBowContext.worldSlot === hotbarBowContext.hotbarSelected
        ? {
            textureName: bowDrawItemTextureName(hotbarBowContext.bowDrawSec),
            stairItemIconClip: def.stairItemIconClip,
          }
        : def;
    const style = getItemIconStyleForDefinition(iconDef, urlLookup, displayPx);
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
    if (maxD !== undefined && maxD > 0) {
      durWrap.classList.remove("inv-slot-durability--hidden");
      const dmg = stack.damage ?? 0;
      const rem = Math.max(0, maxD - dmg);
      const pct = (rem / maxD) * 100;
      durFill.style.width = `${pct}%`;
      durFill.classList.toggle("inv-slot-durability-fill--low", pct <= 25);
    } else {
      durWrap.classList.add("inv-slot-durability--hidden");
      durFill.style.width = "0%";
      durFill.classList.remove("inv-slot-durability-fill--low");
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
    this.panelResizeObserver.disconnect();
    window.removeEventListener("resize", this.onInvWindowResizeForSidePanels, true);
    window.removeEventListener("mouseup", this.onWindowMouseUp, true);
    this.root.remove();
  }

  /** Bind click/drag handlers for armor slots (same pointer lifecycle as main slots). */
  private bindArmorSlotElement(
    slot: HTMLDivElement,
    armorSlot: import("../items/PlayerInventory").ArmorSlot,
  ): void {
    const slotIndex = ARMOR_UI_SLOT_BASE + armorSlot;
    slot.addEventListener("mousedown", (e: MouseEvent) => {
      if (!this.inventoryOpen) {
        return;
      }
      if (e.button !== 0 && e.button !== 2) {
        return;
      }
      e.preventDefault();
      this.pointerDownSlot = slotIndex;
      this.pointerDownSlotEl = slot;
      this.pointerDownButton = e.button;
      this.dragOccurred = false;
      if (e.button === 2) {
        this.rmbPlacedOnDown = false;
        const inv = this.getInventory();
        if (inv.getCursorStack() !== null) {
          inv.distributeOneFromCursorIntoArmorSlot(armorSlot);
          this.rmbPlacedOnDown = true;
        }
      }
    });

    slot.addEventListener("mouseenter", (e: MouseEvent) => {
      if (!this.inventoryOpen) {
        return;
      }
      if (
        this.pointerDownSlot !== null &&
        slotIndex !== this.pointerDownSlot
      ) {
        this.dragOccurred = true;
      }
      const inv = this.getInventory();
      if ((e.buttons & 1) !== 0 && inv.getCursorStack() !== null) {
        inv.distributeOneFromCursorIntoArmorSlot(armorSlot);
      }
      if ((e.buttons & 2) !== 0 && inv.getCursorStack() !== null) {
        inv.distributeOneFromCursorIntoArmorSlot(armorSlot);
      }
    });

    slot.addEventListener("contextmenu", (ev: Event) => {
      if (this.inventoryOpen) {
        ev.preventDefault();
      }
    });
  }

  /** Bind tooltip handlers for armor slots. */
  private bindArmorSlotTooltip(
    slot: HTMLDivElement,
    armorSlot: import("../items/PlayerInventory").ArmorSlot,
  ): void {
    slot.addEventListener("mouseenter", (e: MouseEvent) => {
      if (!this.inventoryOpen) return;
      const armorStack = this.getInventory().getArmorStack(armorSlot);
      if (armorStack !== null && this.iconUrlLookup !== null) {
        const def = this.itemRegistry.getById(armorStack.itemId);
        if (def !== undefined) {
          this.fillItemTooltip(def);
          this.itemTooltipEl.classList.add("inv-item-tooltip--visible");
          this.positionItemTooltip(e.clientX, e.clientY);
        }
      }
    });
    slot.addEventListener("mousemove", (e: MouseEvent) => {
      if (!this.inventoryOpen) return;
      this.positionItemTooltip(e.clientX, e.clientY);
    });
    slot.addEventListener("mouseleave", () => {
      this.hideItemTooltip();
    });
  }
}
