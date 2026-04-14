/** Fixed-size inventory managing ItemStack slots, stack merging, consumption, and cursor stack. */

import {
  ARMOR_SLOT_COUNT,
  ARMOR_UI_SLOT_BASE,
  HOTBAR_SIZE,
  INVENTORY_SIZE,
  PLAYER_ARMOR_BETA_MITIGATION_CAP,
  PLAYER_ARMOR_BETA_MITIGATION_PER_PIECE,
  PLAYER_ARMOR_DURABILITY_LOSS_DIVISOR,
} from "../core/constants";
import type { ItemDefinition, ItemId, ItemStack } from "../core/itemDefinition";
import {
  clampDamageForDefinition,
  isStackBroken,
} from "../core/itemDefinition";
import type { ItemRegistry } from "./ItemRegistry";

export type SerializedInventorySlot =
  | { key: string; count: number; damage?: number }
  | null;

/** Armor slot indices: 0=helmet, 1=chestplate, 2=leggings, 3=boots */
export type ArmorSlot = 0 | 1 | 2 | 3;

/** Map item tags to the armor slot the piece equips in, or null if not typed armor. */
export function armorSlotFromItemTags(
  tags: readonly string[] | undefined,
): ArmorSlot | null {
  if (tags === undefined) {
    return null;
  }
  if (tags.includes("stratum:armor_helmet")) {
    return 0;
  }
  if (tags.includes("stratum:armor_chestplate")) {
    return 1;
  }
  if (tags.includes("stratum:armor_leggings")) {
    return 2;
  }
  if (tags.includes("stratum:armor_boots")) {
    return 3;
  }
  return null;
}

export class PlayerInventory {
  private readonly _slots: (ItemStack | null)[];
  private readonly _armorSlots: (ItemStack | null)[];
  private readonly _registry: ItemRegistry;
  private _cursorStack: ItemStack | null = null;

  constructor(registry: ItemRegistry) {
    this._registry = registry;
    this._slots = new Array<ItemStack | null>(INVENTORY_SIZE).fill(null);
    this._armorSlots = new Array<ItemStack | null>(ARMOR_SLOT_COUNT).fill(null);
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
    if (this._cursorStack.count <= 0) {
      this.normalizeCursor();
      return null;
    }
    return this.copyStack(this._cursorStack);
  }

  private copyStack(s: ItemStack): ItemStack {
    const out: ItemStack = { itemId: s.itemId, count: s.count };
    if (s.damage !== undefined && s.damage > 0) {
      out.damage = s.damage;
    }
    return out;
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

  private damageMatchesForMerge(
    def: ItemDefinition | undefined,
    a: number | undefined,
    b: number | undefined,
  ): boolean {
    if (def?.maxDurability === undefined) {
      return true;
    }
    const da = clampDamageForDefinition(def, a);
    const db = clampDamageForDefinition(def, b);
    return da === db;
  }

  private slotWithNormalizedDamage(stack: ItemStack): ItemStack {
    const def = this._registry.getById(stack.itemId);
    const d = clampDamageForDefinition(def, stack.damage);
    if (def?.maxDurability === undefined) {
      return { itemId: stack.itemId, count: stack.count };
    }
    if (d <= 0) {
      return { itemId: stack.itemId, count: stack.count };
    }
    return { itemId: stack.itemId, count: stack.count, damage: d };
  }

  /**
   * Merge cursor into inventory storage (e.g. when closing UI). Returns overflow not placed.
   */
  returnCursorToSlots(): number {
    if (this._cursorStack === null) {
      return 0;
    }
    const rest = this.addItemStack(this.copyStack(this._cursorStack));
    if (rest === null) {
      this._cursorStack = null;
      return 0;
    }
    this._cursorStack = rest;
    return rest.count;
  }

  /**
   * Add items to the inventory. Fills existing partial stacks first,
   * then uses empty slots. New stacks use damage 0 (full durability).
   * @returns The number of items that could not fit (overflow).
   */
  add(itemId: ItemId, count: number): number {
    if (count <= 0) return 0;
    const rest = this.addItemStack({ itemId, count });
    return rest === null ? 0 : rest.count;
  }

  /**
   * Add a stack with optional per-item damage. Returns overflow stack, or null if all merged.
   */
  addItemStack(stack: ItemStack): ItemStack | null {
    return this.addItemStackWithFirstSlot(stack).rest;
  }

  /**
   * Same as {@link addItemStack}, plus the first inventory slot index that received items
   * (merge or new stack), for shift–move animations.
   */
  addItemStackWithFirstSlot(stack: ItemStack): {
    rest: ItemStack | null;
    firstSlot: number | null;
  } {
    if (stack.count <= 0) {
      return { rest: null, firstSlot: null };
    }
    const def = this._registry.getById(stack.itemId);
    if (def === undefined) {
      return { rest: stack, firstSlot: null };
    }
    const normalized = this.slotWithNormalizedDamage(stack);
    if (isStackBroken(def, normalized.damage)) {
      return { rest: null, firstSlot: null };
    }
    const maxStack = def.maxStack;
    let remaining = normalized.count;
    const itemId = normalized.itemId;
    const dmg = normalized.damage;
    let firstSlot: number | null = null;

    for (let i = 0; i < INVENTORY_SIZE && remaining > 0; i++) {
      const slot = this._slots[i];
      if (slot === null || slot === undefined || slot.itemId !== itemId) {
        continue;
      }
      if (!this.damageMatchesForMerge(def, slot.damage, dmg)) {
        continue;
      }
      if (slot.count >= maxStack) {
        continue;
      }
      const space = maxStack - slot.count;
      const toAdd = Math.min(remaining, space);
      if (toAdd <= 0) {
        continue;
      }
      if (firstSlot === null) {
        firstSlot = i;
      }
      slot.count += toAdd;
      remaining -= toAdd;
    }

    for (let i = 0; i < INVENTORY_SIZE && remaining > 0; i++) {
      if (this._slots[i] !== null && this._slots[i] !== undefined) {
        continue;
      }
      const toAdd = Math.min(remaining, maxStack);
      if (firstSlot === null) {
        firstSlot = i;
      }
      const s: ItemStack = { itemId, count: toAdd };
      if (def.maxDurability !== undefined && dmg !== undefined && dmg > 0) {
        s.damage = dmg;
      }
      this._slots[i] = s;
      remaining -= toAdd;
    }

    if (remaining <= 0) {
      return { rest: null, firstSlot };
    }
    const out: ItemStack = { itemId, count: remaining };
    if (def.maxDurability !== undefined && dmg !== undefined && dmg > 0) {
      out.damage = dmg;
    }
    return { rest: out, firstSlot };
  }

  /**
   * Same merge / empty-slot order as {@link add}, without mutating this inventory.
   * @returns Count that would not fit (overflow).
   */
  simulateAddOverflow(itemId: ItemId, count: number): number {
    if (count <= 0) return 0;
    const slots: (ItemStack | null)[] = [];
    for (let i = 0; i < INVENTORY_SIZE; i++) {
      const s = this._slots[i];
      if (s === null || s === undefined) {
        slots.push(null);
      } else {
        slots.push(this.copyStack(s));
      }
    }
    const inv = new PlayerInventory(this._registry);
    for (let i = 0; i < INVENTORY_SIZE; i++) {
      inv._slots[i] = slots[i] ?? null;
    }
    const rest = inv.addItemStack({ itemId, count });
    return rest === null ? 0 : rest.count;
  }

  /** Returns a copy of the stack at the given slot index, or null. */
  getStack(slot: number): ItemStack | null {
    if (slot < 0 || slot >= INVENTORY_SIZE) return null;
    const s = this._slots[slot];
    if (s === null || s === undefined) return null;
    return this.copyStack(s);
  }

  /** Overwrites a slot. If stack count is <= 0 the slot is cleared. */
  setStack(slot: number, stack: ItemStack | null): void {
    if (slot < 0 || slot >= INVENTORY_SIZE) return;
    if (stack === null || stack.count <= 0) {
      this._slots[slot] = null;
      return;
    }
    const def = this._registry.getById(stack.itemId);
    if (def !== undefined && isStackBroken(def, stack.damage)) {
      this._slots[slot] = null;
      return;
    }
    this._slots[slot] = this.slotWithNormalizedDamage(stack);
  }

  /** Returns a copy of the armor stack at the given slot (0=helmet, 1=chestplate, 2=leggings, 3=boots), or null. */
  getArmorStack(slot: ArmorSlot): ItemStack | null {
    if (slot < 0 || slot >= ARMOR_SLOT_COUNT) return null;
    const s = this._armorSlots[slot];
    if (s === null || s === undefined) return null;
    return this.copyStack(s);
  }

  /** Overwrites an armor slot. If stack count is <= 0 the slot is cleared. */
  setArmorStack(slot: ArmorSlot, stack: ItemStack | null): void {
    if (slot < 0 || slot >= ARMOR_SLOT_COUNT) return;
    if (stack === null || stack.count <= 0) {
      this._armorSlots[slot] = null;
      return;
    }
    const def = this._registry.getById(stack.itemId);
    if (def !== undefined && isStackBroken(def, stack.damage)) {
      this._armorSlots[slot] = null;
      return;
    }
    this._armorSlots[slot] = this.slotWithNormalizedDamage(stack);
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
    this._cursorStack = this.copyStack(s);
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
    this._cursorStack = this.slotWithNormalizedDamage({
      itemId: s.itemId,
      count: take,
      damage: s.damage,
    });
    this._slots[slot] =
      remain > 0
        ? this.slotWithNormalizedDamage({
            itemId: s.itemId,
            count: remain,
            damage: s.damage,
          })
        : null;
  }

  /** Place one item from the cursor into a slot (merge or new stack). */
  placeOneIntoSlot(slot: number): void {
    if (slot < 0 || slot >= INVENTORY_SIZE) return;
    const cur = this._cursorStack;
    if (cur === null || cur.count <= 0) return;

    const slotStack = this._slots[slot];
    const max = this.maxStackFor(cur.itemId);
    const def = this._registry.getById(cur.itemId);

    if (slotStack === null || slotStack === undefined) {
      const one = this.slotWithNormalizedDamage({
        itemId: cur.itemId,
        count: 1,
        damage: cur.damage,
      });
      this._slots[slot] = one;
      cur.count -= 1;
    } else if (
      slotStack.itemId === cur.itemId &&
      slotStack.count < max &&
      this.damageMatchesForMerge(def, slotStack.damage, cur.damage)
    ) {
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
      this._slots[slot] = this.slotWithNormalizedDamage({
        itemId: cur.itemId,
        count: put,
        damage: cur.damage,
      });
      cur.count -= put;
      this.normalizeCursor();
      return;
    }

    const def = this._registry.getById(cur.itemId);
    if (
      slotStack.itemId === cur.itemId &&
      this.damageMatchesForMerge(def, slotStack.damage, cur.damage)
    ) {
      const max = this.maxStackFor(cur.itemId);
      const space = max - slotStack.count;
      if (space <= 0) return;
      const move = Math.min(space, cur.count);
      slotStack.count += move;
      cur.count -= move;
      this.normalizeCursor();
      return;
    }

    const tmpCursor: ItemStack = this.slotWithNormalizedDamage({
      itemId: cur.itemId,
      count: cur.count,
      damage: cur.damage,
    });
    this._cursorStack = this.slotWithNormalizedDamage({
      itemId: slotStack.itemId,
      count: slotStack.count,
      damage: slotStack.damage,
    });
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
   * While dragging with LMB, place one armor piece from the cursor into an empty / mergeable
   * armor slot (mirrors {@link placeOneIntoSlot} for main inventory).
   */
  distributeOneFromCursorIntoArmorSlot(armorSlot: ArmorSlot): void {
    const cur = this._cursorStack;
    if (cur === null || cur.count <= 0) {
      return;
    }
    const def = this._registry.getById(cur.itemId);
    if (def === undefined || def.tags === undefined) {
      return;
    }
    const expectedTags = [
      "stratum:armor_helmet",
      "stratum:armor_chestplate",
      "stratum:armor_leggings",
      "stratum:armor_boots",
    ] as const;
    const expectedTag = expectedTags[armorSlot];
    if (
      expectedTag === undefined ||
      (!def.tags.includes(expectedTag) && !def.tags.includes("stratum:armor"))
    ) {
      return;
    }
    const equipped = this._armorSlots[armorSlot] ?? null;
    const max = this.maxStackFor(cur.itemId);
    if (equipped === null || equipped.count <= 0) {
      this._armorSlots[armorSlot] = this.slotWithNormalizedDamage({
        itemId: cur.itemId,
        count: 1,
        damage: cur.damage,
      });
      cur.count -= 1;
      this.normalizeCursor();
      return;
    }
    if (
      equipped.itemId === cur.itemId &&
      equipped.count < max &&
      this.damageMatchesForMerge(def, equipped.damage, cur.damage)
    ) {
      equipped.count += 1;
      cur.count -= 1;
      this.normalizeCursor();
    }
  }

  /** LMB click on an armor slot (pick up / swap with cursor), matching inventory slot rules. */
  handleArmorSlotLmbClick(armorSlot: ArmorSlot): void {
    const cur = this._cursorStack;
    const armorStack = this._armorSlots[armorSlot] ?? null;
    if (cur === null) {
      if (armorStack === null || armorStack.count <= 0) {
        return;
      }
      this._cursorStack = this.copyStack(armorStack);
      this._armorSlots[armorSlot] = null;
      return;
    }
    const def = this._registry.getById(cur.itemId);
    if (def === undefined || def.tags === undefined) {
      return;
    }
    const slotTags = [
      "stratum:armor_helmet",
      "stratum:armor_chestplate",
      "stratum:armor_leggings",
      "stratum:armor_boots",
    ] as const;
    const expectedTag = slotTags[armorSlot];
    if (
      expectedTag === undefined ||
      (!def.tags.includes(expectedTag) && !def.tags.includes("stratum:armor"))
    ) {
      return;
    }
    const existing: ItemStack | null = armorStack;
    this._armorSlots[armorSlot] = this.slotWithNormalizedDamage(cur);
    this._cursorStack =
      existing !== null && existing.count > 0
        ? this.slotWithNormalizedDamage(existing)
        : null;
  }

  /**
   * Shift–quick-move from an armor slot into main/hotbar storage (merge then empty slots).
   * @returns First inventory slot that received items, or null if nothing moved.
   */
  quickMoveFromArmorSlot(armorSlot: ArmorSlot): number | null {
    if (this._cursorStack !== null) {
      return null;
    }
    const src = this._armorSlots[armorSlot] ?? null;
    if (src === null || src.count <= 0) {
      return null;
    }
    const { rest, firstSlot } = this.addItemStackWithFirstSlot(this.copyStack(src));
    if (firstSlot === null) {
      return null;
    }
    if (rest === null) {
      this._armorSlots[armorSlot] = null;
    } else {
      this._armorSlots[armorSlot] = this.slotWithNormalizedDamage(rest);
    }
    return firstSlot;
  }

  /**
   * Shift–quick-move (Minecraft-style): move the whole stack from `slot` into the other
   * region (main ↔ hotbar), merging into partial stacks first then filling empty slots
   * left-to-right / top-to-bottom. No-op if the cursor already holds items.
   * @returns First target slot that received items, or null if nothing moved.
   * Armor pieces prefer their armor slot first; returns {@link ARMOR_UI_SLOT_BASE}+slot when equipping.
   */
  quickMoveFromSlot(slot: number): number | null {
    if (slot < 0 || slot >= INVENTORY_SIZE) return null;
    if (this._cursorStack !== null) return null;
    const src = this._slots[slot];
    if (src === null || src === undefined || src.count <= 0) return null;

    const itemId = src.itemId;
    const def = this._registry.getById(itemId);
    const armorTarget = armorSlotFromItemTags(def?.tags);
    if (armorTarget !== null) {
      const equipped = this._armorSlots[armorTarget] ?? null;
      if (equipped === null || equipped.count <= 0) {
        this.setArmorStack(armorTarget, this.copyStack(src));
        this._slots[slot] = null;
        return ARMOR_UI_SLOT_BASE + armorTarget;
      }
    }
    let remaining = src.count;
    const max = this.maxStackFor(itemId);
    const dmg = src.damage;

    const toHotbar = slot >= HOTBAR_SIZE;
    const targetIndices: number[] = toHotbar
      ? Array.from({ length: HOTBAR_SIZE }, (_, i) => i)
      : Array.from({ length: INVENTORY_SIZE - HOTBAR_SIZE }, (_, i) => i + HOTBAR_SIZE);

    let firstDest: number | null = null;

    for (const i of targetIndices) {
      if (remaining <= 0) break;
      const t = this._slots[i];
      if (
        t !== null &&
        t !== undefined &&
        t.itemId === itemId &&
        t.count < max &&
        this.damageMatchesForMerge(def, t.damage, dmg)
      ) {
        const space = max - t.count;
        const move = Math.min(space, remaining);
        if (move > 0 && firstDest === null) {
          firstDest = i;
        }
        t.count += move;
        remaining -= move;
      }
    }

    for (const i of targetIndices) {
      if (remaining <= 0) break;
      if (this._slots[i] === null || this._slots[i] === undefined) {
        const put = Math.min(max, remaining);
        if (firstDest === null) {
          firstDest = i;
        }
        this._slots[i] = this.slotWithNormalizedDamage({
          itemId,
          count: put,
          damage: dmg,
        });
        remaining -= put;
      }
    }

    if (firstDest === null) {
      return null;
    }

    if (remaining <= 0) {
      this._slots[slot] = null;
    } else {
      this._slots[slot] = this.slotWithNormalizedDamage({
        itemId,
        count: remaining,
        damage: dmg,
      });
    }
    return firstDest;
  }

  /** @internal External UI (e.g. drag-drop) may set the cursor stack after a merge. */
  replaceCursorStack(stack: ItemStack | null): void {
    if (stack === null || stack.count <= 0) {
      this._cursorStack = null;
    } else {
      this._cursorStack = this.slotWithNormalizedDamage(stack);
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
    const def = this._registry.getById(itemId);
    let room = max - hub.count;
    if (room <= 0) return;

    for (let i = 0; i < INVENTORY_SIZE && room > 0; i++) {
      if (i === slot) continue;
      const s = this._slots[i];
      if (
        s === null ||
        s === undefined ||
        s.itemId !== itemId ||
        !this.damageMatchesForMerge(def, s.damage, hub.damage)
      ) {
        continue;
      }
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
    const def = this._registry.getById(from.itemId);
    const one = this.slotWithNormalizedDamage({
      itemId: from.itemId,
      count: 1,
      damage: from.damage,
    });

    if (to === null || to === undefined) {
      this._slots[toSlot] = one;
      from.count -= 1;
      if (from.count <= 0) {
        this._slots[fromSlot] = null;
      }
      return;
    }

    if (
      to.itemId === from.itemId &&
      to.count < max &&
      this.damageMatchesForMerge(def, to.damage, from.damage)
    ) {
      to.count += 1;
      from.count -= 1;
      if (from.count <= 0) {
        this._slots[fromSlot] = null;
      }
    }
  }

  /**
   * After mining, tilling, or similar: if the held hotbar stack is damageable, add one use.
   * Clears the slot when the tool breaks.
   */
  applyToolUseFromMining(hotbarSlot: number): void {
    if (hotbarSlot < 0 || hotbarSlot >= HOTBAR_SIZE) return;
    const s = this._slots[hotbarSlot];
    if (s === null || s === undefined || s.count <= 0) return;
    const def = this._registry.getById(s.itemId);
    if (def?.maxDurability === undefined) return;
    const cur = clampDamageForDefinition(def, s.damage);
    const next = cur + 1;
    if (next >= def.maxDurability) {
      this._slots[hotbarSlot] = null;
      return;
    }
    s.damage = next;
  }

  /**
   * Snapshot every slot using stable string keys.
   * Null slots are preserved so slot positions round-trip exactly.
   */
  serialize(): SerializedInventorySlot[] {
    const out: SerializedInventorySlot[] = [];
    for (let i = 0; i < INVENTORY_SIZE; i++) {
      const s = this._slots[i];
      if (s === null || s === undefined || s.count <= 0) {
        out.push(null);
      } else {
        const def = this._registry.getById(s.itemId);
        if (def === undefined) {
          out.push(null);
        } else {
          const d = clampDamageForDefinition(def, s.damage);
          if (def.maxDurability !== undefined && d > 0) {
            out.push({ key: def.key, count: s.count, damage: d });
          } else {
            out.push({ key: def.key, count: s.count });
          }
        }
      }
    }
    return out;
  }

  /**
   * Restore slots from data produced by {@link serialize}.
   * Unknown keys (e.g. removed mods) are silently skipped.
   */
  restore(data: readonly SerializedInventorySlot[]): void {
    for (let i = 0; i < INVENTORY_SIZE; i++) {
      const entry = i < data.length ? data[i] : null;
      if (entry === null || entry === undefined) {
        this._slots[i] = null;
        continue;
      }
      const def = this._registry.getByKey(entry.key);
      if (def === undefined) {
        this._slots[i] = null;
        continue;
      }
      const d = clampDamageForDefinition(def, entry.damage);
      if (isStackBroken(def, d)) {
        this._slots[i] = null;
        continue;
      }
      const stack: ItemStack = { itemId: def.id, count: entry.count };
      if (def.maxDurability !== undefined && d > 0) {
        stack.damage = d;
      }
      this._slots[i] = stack;
    }
  }

  /**
   * Serialize armor slots (helmet, chestplate, leggings, boots).
   * Returns array of 4 slots in that order.
   */
  serializeArmor(): SerializedInventorySlot[] {
    const out: SerializedInventorySlot[] = [];
    for (let i = 0; i < ARMOR_SLOT_COUNT; i++) {
      const s = this._armorSlots[i];
      if (s === null || s === undefined || s.count <= 0) {
        out.push(null);
      } else {
        const def = this._registry.getById(s.itemId);
        if (def === undefined) {
          out.push(null);
        } else {
          const d = clampDamageForDefinition(def, s.damage);
          if (def.maxDurability !== undefined && d > 0) {
            out.push({ key: def.key, count: s.count, damage: d });
          } else {
            out.push({ key: def.key, count: s.count });
          }
        }
      }
    }
    return out;
  }

  /**
   * Restore armor slots from data produced by {@link serializeArmor}.
   * Unknown keys are silently skipped.
   */
  restoreArmor(data: readonly SerializedInventorySlot[]): void {
    for (let i = 0; i < ARMOR_SLOT_COUNT; i++) {
      const entry = i < data.length ? data[i] : null;
      if (entry === null || entry === undefined) {
        this._armorSlots[i] = null;
        continue;
      }
      const def = this._registry.getByKey(entry.key);
      if (def === undefined) {
        this._armorSlots[i] = null;
        continue;
      }
      const d = clampDamageForDefinition(def, entry.damage);
      if (isStackBroken(def, d)) {
        this._armorSlots[i] = null;
        continue;
      }
      const stack: ItemStack = { itemId: def.id, count: entry.count };
      if (def.maxDurability !== undefined && d > 0) {
        stack.damage = d;
      }
      this._armorSlots[i] = stack;
    }
  }

  /** Calculate total armor value from equipped armor. Returns value 0-4 (one point per armor piece). */
  getTotalArmorValue(): number {
    let armorValue = 0;
    for (let i = 0; i < ARMOR_SLOT_COUNT; i++) {
      const s = this._armorSlots[i];
      if (s !== null && s !== undefined && s.count > 0) {
        const def = this._registry.getById(s.itemId);
        if (def !== undefined && def.tags?.some((t) => t.startsWith("stratum:armor_"))) {
          armorValue += 1;
        }
      }
    }
    return armorValue;
  }

  /**
   * Beta-style armor mitigation (0–1): at full pooled durability, up to
   * `min(cap, perPiece × pieceCount)` (capped like classic 20 armor ÷ 25); scales by
   * `(M − D) / (M + 1)` when any equipped piece has `maxDurability` (`M` / `D` pooled).
   * Same max per tier when pristine (Beta 1.7.x); better tiers last longer via durability.
   */
  getEquippedArmorMitigationFraction(): number {
    const pieceCount = this.getTotalArmorValue();
    if (pieceCount <= 0) {
      return 0;
    }
    const base = Math.min(
      PLAYER_ARMOR_BETA_MITIGATION_CAP,
      PLAYER_ARMOR_BETA_MITIGATION_PER_PIECE * pieceCount,
    );
    let maxTotal = 0;
    let damageTotal = 0;
    for (let i = 0; i < ARMOR_SLOT_COUNT; i++) {
      const s = this._armorSlots[i];
      if (s === null || s === undefined || s.count <= 0) {
        continue;
      }
      const def = this._registry.getById(s.itemId);
      if (
        def === undefined ||
        !def.tags?.some((t) => t.startsWith("stratum:armor_"))
      ) {
        continue;
      }
      const max = def.maxDurability;
      if (max === undefined) {
        continue;
      }
      maxTotal += max;
      damageTotal += clampDamageForDefinition(def, s.damage);
    }
    if (maxTotal <= 0) {
      return Math.max(0, Math.min(1, base));
    }
    const durabilityFactor = (maxTotal - damageTotal) / (maxTotal + 1);
    if (!Number.isFinite(durabilityFactor)) {
      return 0;
    }
    const frac = base * durabilityFactor;
    return Math.max(0, Math.min(1, frac));
  }

  /**
   * Pooled equipped armor remaining on a 0–10 integer scale (same resolution as the health HUD:
   * five icons × two half-steps each).
   */
  getEquippedArmorDurabilityPointsTen(): number {
    let maxTotal = 0;
    let damageTotal = 0;
    for (let i = 0; i < ARMOR_SLOT_COUNT; i++) {
      const s = this._armorSlots[i];
      if (s === null || s === undefined || s.count <= 0) {
        continue;
      }
      const def = this._registry.getById(s.itemId);
      if (
        def === undefined ||
        !def.tags?.some((t) => t.startsWith("stratum:armor_"))
      ) {
        continue;
      }
      const max = def.maxDurability;
      if (max === undefined) {
        continue;
      }
      maxTotal += max;
      damageTotal += clampDamageForDefinition(def, s.damage);
    }
    if (maxTotal <= 0) {
      return 0;
    }
    const remaining = maxTotal - damageTotal;
    const raw = (10 * remaining) / maxTotal;
    if (!Number.isFinite(raw)) {
      return 0;
    }
    return Math.max(0, Math.min(10, Math.floor(raw + 1e-9)));
  }

  /**
   * Wear armor from a damage event: `max(1, floor(rawDamage / divisor))` durability points
   * removed in round-robin across equipped `stratum:armor_*` pieces with `maxDurability`.
   */
  applyArmorDurabilityFromDamage(rawDamage: number): void {
    if (rawDamage <= 0 || !Number.isFinite(rawDamage)) {
      return;
    }
    const div = PLAYER_ARMOR_DURABILITY_LOSS_DIVISOR;
    const totalLoss = Math.max(1, Math.floor(rawDamage / div));
    const targets: ArmorSlot[] = [];
    for (let i = 0; i < ARMOR_SLOT_COUNT; i++) {
      const s = this._armorSlots[i];
      if (s === null || s === undefined || s.count <= 0) {
        continue;
      }
      const def = this._registry.getById(s.itemId);
      if (
        def === undefined ||
        !def.tags?.some((t) => t.startsWith("stratum:armor_")) ||
        def.maxDurability === undefined
      ) {
        continue;
      }
      targets.push(i as ArmorSlot);
    }
    if (targets.length === 0) {
      return;
    }
    for (let k = 0; k < totalLoss; k++) {
      const active: ArmorSlot[] = [];
      for (const slot of targets) {
        const s = this._armorSlots[slot];
        if (s === null || s === undefined || s.count <= 0) {
          continue;
        }
        const def = this._registry.getById(s.itemId);
        if (
          def === undefined ||
          def.maxDurability === undefined ||
          !def.tags?.some((t) => t.startsWith("stratum:armor_"))
        ) {
          continue;
        }
        active.push(slot);
      }
      if (active.length === 0) {
        return;
      }
      const slot = active[k % active.length]!;
      const s = this._armorSlots[slot]!;
      const def = this._registry.getById(s.itemId);
      const maxDurability = def?.maxDurability;
      if (def === undefined || maxDurability === undefined) {
        continue;
      }
      const cur = clampDamageForDefinition(def, s.damage);
      const next = cur + 1;
      if (next >= maxDurability) {
        this._armorSlots[slot] = null;
      } else {
        s.damage = next;
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

  /** Count stacks of an item key in the main inventory grid (excludes armor slots). */
  countItemsByKey(key: string): number {
    const def = this._registry.getByKey(key);
    if (def === undefined) {
      return 0;
    }
    let total = 0;
    for (let i = 0; i < INVENTORY_SIZE; i++) {
      const s = this._slots[i];
      if (s !== null && s !== undefined && s.itemId === def.id && s.count > 0) {
        total += s.count;
      }
    }
    return total;
  }

  /** Removes one item of `key` from the first slot that contains it. */
  consumeOneFromAnySlotByKey(key: string): boolean {
    const def = this._registry.getByKey(key);
    if (def === undefined) {
      return false;
    }
    for (let i = 0; i < INVENTORY_SIZE; i++) {
      const s = this._slots[i];
      if (s !== null && s !== undefined && s.itemId === def.id && s.count > 0) {
        return this.consumeOneFromSlot(i);
      }
    }
    return false;
  }
}
