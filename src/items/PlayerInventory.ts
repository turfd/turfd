/** Fixed-size inventory managing ItemStack slots, stack merging, consumption, and cursor stack. */

import { HOTBAR_SIZE, INVENTORY_SIZE } from "../core/constants";
import type { ItemId, ItemStack } from "../core/itemDefinition";
import type { ItemRegistry } from "./ItemRegistry";

export class PlayerInventory {
  private readonly _slots: (ItemStack | null)[];
  private readonly _registry: ItemRegistry;
  private _cursorStack: ItemStack | null = null;

  constructor(registry: ItemRegistry) {
    this._registry = registry;
    this._slots = new Array<ItemStack | null>(INVENTORY_SIZE).fill(null);
  }

  /** Number of slots in this inventory. */
  get size(): number {
    return INVENTORY_SIZE;
  }

  /** Stack held by the mouse cursor (read-only snapshot). */
  getCursorStack(): ItemStack | null {
    if (this._cursorStack === null) {
      return null;
    }
    return { itemId: this._cursorStack.itemId, count: this._cursorStack.count };
  }

  private maxStackFor(itemId: ItemId): number {
    const def = this._registry.getById(itemId);
    return def !== undefined ? def.maxStack : 1;
  }

  private normalizeCursor(): void {
    if (this._cursorStack !== null && this._cursorStack.count <= 0) {
      this._cursorStack = null;
    }
  }

  /**
   * Merge cursor into inventory storage (e.g. when closing UI). Returns overflow not placed.
   */
  returnCursorToSlots(): number {
    if (this._cursorStack === null) {
      return 0;
    }
    const { itemId, count } = this._cursorStack;
    const overflow = this.add(itemId, count);
    if (overflow === 0) {
      this._cursorStack = null;
    } else {
      this._cursorStack = { itemId, count: overflow };
    }
    return overflow;
  }

  /**
   * Add items to the inventory. Fills existing partial stacks first,
   * then uses empty slots.
   * @returns The number of items that could not fit (overflow).
   */
  add(itemId: ItemId, count: number): number {
    if (count <= 0) return 0;

    const maxStack = this.maxStackFor(itemId);
    let remaining = count;

    for (let i = 0; i < INVENTORY_SIZE && remaining > 0; i++) {
      const slot = this._slots[i];
      if (slot !== null && slot !== undefined && slot.itemId === itemId && slot.count < maxStack) {
        const space = maxStack - slot.count;
        const toAdd = Math.min(remaining, space);
        slot.count += toAdd;
        remaining -= toAdd;
      }
    }

    for (let i = 0; i < INVENTORY_SIZE && remaining > 0; i++) {
      if (this._slots[i] === null || this._slots[i] === undefined) {
        const toAdd = Math.min(remaining, maxStack);
        this._slots[i] = { itemId, count: toAdd };
        remaining -= toAdd;
      }
    }

    return remaining;
  }

  /** Returns a copy of the stack at the given slot index, or null. */
  getStack(slot: number): ItemStack | null {
    if (slot < 0 || slot >= INVENTORY_SIZE) return null;
    const s = this._slots[slot];
    if (s === null || s === undefined) return null;
    return { itemId: s.itemId, count: s.count };
  }

  /** Overwrites a slot. If stack count is <= 0 the slot is cleared. */
  setStack(slot: number, stack: ItemStack | null): void {
    if (slot < 0 || slot >= INVENTORY_SIZE) return;
    if (stack === null || stack.count <= 0) {
      this._slots[slot] = null;
    } else {
      this._slots[slot] = { itemId: stack.itemId, count: stack.count };
    }
  }

  /** Swap the contents of two slot indices. */
  swap(slotA: number, slotB: number): void {
    if (
      slotA < 0 || slotA >= INVENTORY_SIZE ||
      slotB < 0 || slotB >= INVENTORY_SIZE
    ) return;
    const tmp: ItemStack | null = this._slots[slotA] ?? null;
    this._slots[slotA] = this._slots[slotB] ?? null;
    this._slots[slotB] = tmp;
  }

  /** Pick up the entire stack from a slot into an empty cursor. */
  pickUpWhole(slot: number): void {
    if (slot < 0 || slot >= INVENTORY_SIZE) return;
    if (this._cursorStack !== null) return;
    const s = this._slots[slot];
    if (s === null || s === undefined) return;
    this._cursorStack = { itemId: s.itemId, count: s.count };
    this._slots[slot] = null;
  }

  /** Pick up half (rounded up) of a stack into an empty cursor. */
  pickUpHalf(slot: number): void {
    if (slot < 0 || slot >= INVENTORY_SIZE) return;
    if (this._cursorStack !== null) return;
    const s = this._slots[slot];
    if (s === null || s === undefined || s.count <= 0) return;
    const take = Math.ceil(s.count / 2);
    const remain = s.count - take;
    this._cursorStack = { itemId: s.itemId, count: take };
    this._slots[slot] = remain > 0 ? { itemId: s.itemId, count: remain } : null;
  }

  /** Place one item from the cursor into a slot (merge or new stack). */
  placeOneIntoSlot(slot: number): void {
    if (slot < 0 || slot >= INVENTORY_SIZE) return;
    const cur = this._cursorStack;
    if (cur === null || cur.count <= 0) return;

    const slotStack = this._slots[slot];
    const max = this.maxStackFor(cur.itemId);

    if (slotStack === null || slotStack === undefined) {
      this._slots[slot] = { itemId: cur.itemId, count: 1 };
      cur.count -= 1;
    } else if (slotStack.itemId === cur.itemId && slotStack.count < max) {
      slotStack.count += 1;
      cur.count -= 1;
    }
    this.normalizeCursor();
  }

  /**
   * LMB drag: move one from cursor into slot if empty or same item type (up to max stack).
   */
  distributeOneFromCursorIntoSlot(slot: number): void {
    this.placeOneIntoSlot(slot);
  }

  /** Merge cursor into slot or place all into empty slot; swap on mismatch. */
  handleLmbClick(slot: number): void {
    if (slot < 0 || slot >= INVENTORY_SIZE) return;
    const cur = this._cursorStack;
    const slotStack = this._slots[slot];

    if (cur === null) {
      this.pickUpWhole(slot);
      return;
    }

    if (slotStack === null || slotStack === undefined) {
      const max = this.maxStackFor(cur.itemId);
      const put = Math.min(cur.count, max);
      this._slots[slot] = { itemId: cur.itemId, count: put };
      cur.count -= put;
      this.normalizeCursor();
      return;
    }

    if (slotStack.itemId === cur.itemId) {
      const max = this.maxStackFor(cur.itemId);
      const space = max - slotStack.count;
      if (space <= 0) return;
      const move = Math.min(space, cur.count);
      slotStack.count += move;
      cur.count -= move;
      this.normalizeCursor();
      return;
    }

    const tmpCursor: ItemStack = { itemId: cur.itemId, count: cur.count };
    this._cursorStack = { itemId: slotStack.itemId, count: slotStack.count };
    this._slots[slot] = tmpCursor;
  }

  /** Right-click: pick half if cursor empty, else place one. */
  handleRmbClick(slot: number): void {
    if (slot < 0 || slot >= INVENTORY_SIZE) return;
    if (this._cursorStack === null) {
      this.pickUpHalf(slot);
    } else {
      this.placeOneIntoSlot(slot);
    }
  }

  handleSlotClick(slotIndex: number, button: number, shift: boolean): void {
    void shift;
    if (button === 0) {
      this.handleLmbClick(slotIndex);
    } else if (button === 2) {
      this.handleRmbClick(slotIndex);
    }
  }

  /**
   * Shift–quick-move (Minecraft-style): move the whole stack from `slot` into the other
   * region (main ↔ hotbar), merging into partial stacks first then filling empty slots
   * left-to-right / top-to-bottom. No-op if the cursor already holds items.
   */
  quickMoveFromSlot(slot: number): void {
    if (slot < 0 || slot >= INVENTORY_SIZE) return;
    if (this._cursorStack !== null) return;
    const src = this._slots[slot];
    if (src === null || src === undefined || src.count <= 0) return;

    const itemId = src.itemId;
    let remaining = src.count;
    const max = this.maxStackFor(itemId);

    const toHotbar = slot >= HOTBAR_SIZE;
    const targetIndices: number[] = toHotbar
      ? Array.from({ length: HOTBAR_SIZE }, (_, i) => i)
      : Array.from({ length: INVENTORY_SIZE - HOTBAR_SIZE }, (_, i) => i + HOTBAR_SIZE);

    for (const i of targetIndices) {
      if (remaining <= 0) break;
      const t = this._slots[i];
      if (t !== null && t !== undefined && t.itemId === itemId && t.count < max) {
        const space = max - t.count;
        const move = Math.min(space, remaining);
        t.count += move;
        remaining -= move;
      }
    }

    for (const i of targetIndices) {
      if (remaining <= 0) break;
      if (this._slots[i] === null || this._slots[i] === undefined) {
        const put = Math.min(max, remaining);
        this._slots[i] = { itemId, count: put };
        remaining -= put;
      }
    }

    if (remaining <= 0) {
      this._slots[slot] = null;
    } else {
      this._slots[slot] = { itemId, count: remaining };
    }
  }

  /**
   * Double-click collect: pull every matching item from other slots into `slot` up to max stack.
   * Cursor must be empty.
   */
  collectSameItemIntoSlot(slot: number): void {
    if (slot < 0 || slot >= INVENTORY_SIZE) return;
    if (this._cursorStack !== null) return;
    const hub = this._slots[slot];
    if (hub === null || hub === undefined || hub.count <= 0) return;

    const itemId = hub.itemId;
    const max = this.maxStackFor(itemId);
    let room = max - hub.count;
    if (room <= 0) return;

    for (let i = 0; i < INVENTORY_SIZE && room > 0; i++) {
      if (i === slot) continue;
      const s = this._slots[i];
      if (s === null || s === undefined || s.itemId !== itemId) continue;
      const take = Math.min(s.count, room);
      hub.count += take;
      s.count -= take;
      room -= take;
      if (s.count <= 0) {
        this._slots[i] = null;
      }
    }
  }

  /**
   * Scroll wheel on a slot: move one item along the column between main storage and hotbar.
   * @param deltaY &lt; 0: one step toward main (up). @param deltaY &gt; 0: one step toward hotbar (down).
   */
  scrollTransferOne(slotIndex: number, deltaY: number): void {
    if (slotIndex < 0 || slotIndex >= INVENTORY_SIZE) return;
    if (deltaY === 0) return;

    const col = slotIndex < HOTBAR_SIZE ? slotIndex : slotIndex % HOTBAR_SIZE;
    /** Bottom (hotbar) to top (main row 0) in this column. */
    const columnBottomToTop: readonly number[] = [
      col,
      27 + col,
      18 + col,
      9 + col,
    ];

    const idx = columnBottomToTop.indexOf(slotIndex);
    if (idx < 0) return;

    const towardMain = deltaY < 0;
    if (towardMain) {
      if (idx >= columnBottomToTop.length - 1) return;
      const from = columnBottomToTop[idx]!;
      const to = columnBottomToTop[idx + 1]!;
      this.transferOneItem(from, to);
    } else {
      if (idx <= 0) return;
      const from = columnBottomToTop[idx]!;
      const to = columnBottomToTop[idx - 1]!;
      this.transferOneItem(from, to);
    }
  }

  private transferOneItem(fromSlot: number, toSlot: number): void {
    const from = this._slots[fromSlot];
    if (from === null || from === undefined || from.count <= 0) return;

    const to = this._slots[toSlot];
    const max = this.maxStackFor(from.itemId);

    if (to === null || to === undefined) {
      this._slots[toSlot] = { itemId: from.itemId, count: 1 };
      from.count -= 1;
      if (from.count <= 0) {
        this._slots[fromSlot] = null;
      }
      return;
    }

    if (to.itemId === from.itemId && to.count < max) {
      to.count += 1;
      from.count -= 1;
      if (from.count <= 0) {
        this._slots[fromSlot] = null;
      }
    }
  }

  /** True if any slot holds at least one item. */
  hasAnyItems(): boolean {
    for (let i = 0; i < INVENTORY_SIZE; i++) {
      const s = this._slots[i];
      if (s !== null && s !== undefined && s.count > 0) {
        return true;
      }
    }
    return false;
  }

  /** Removes one item from `slot` if present. Returns true if an item was consumed. */
  consumeOneFromSlot(slot: number): boolean {
    if (slot < 0 || slot >= INVENTORY_SIZE) {
      return false;
    }
    const s = this._slots[slot];
    if (s === null || s === undefined || s.count <= 0) {
      return false;
    }
    s.count -= 1;
    if (s.count <= 0) {
      this._slots[slot] = null;
    }
    return true;
  }

  /** Returns true if the total count of `itemId` across all slots is >= `amount`. */
  has(itemId: ItemId, amount: number): boolean {
    let total = 0;
    for (let i = 0; i < INVENTORY_SIZE; i++) {
      const s = this._slots[i];
      if (s !== null && s !== undefined && s.itemId === itemId) {
        total += s.count;
        if (total >= amount) return true;
      }
    }
    return total >= amount;
  }

  /**
   * Remove `amount` of `itemId` from the inventory, draining slots in order.
   * @returns true if the items were consumed, false if insufficient quantity.
   */
  consume(itemId: ItemId, amount: number): boolean {
    if (!this.has(itemId, amount)) return false;

    let remaining = amount;
    for (let i = 0; i < INVENTORY_SIZE && remaining > 0; i++) {
      const s = this._slots[i];
      if (s !== null && s !== undefined && s.itemId === itemId) {
        const take = Math.min(remaining, s.count);
        s.count -= take;
        remaining -= take;
        if (s.count <= 0) {
          this._slots[i] = null;
        }
      }
    }

    return true;
  }
}
