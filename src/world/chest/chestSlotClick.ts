/**
 * Cursor interactions for chest storage slots (same semantics as furnace buffer slots).
 */

import type { ItemId, ItemStack } from "../../core/itemDefinition";
import type { ChestStack, ChestTileState } from "./ChestTileState";

function maxFor(id: ItemId, maxStack: (itemId: ItemId) => number): number {
  return maxStack(id);
}

function slotLmb(
  slot: ChestStack,
  cursor: ItemStack | null,
  maxStack: (itemId: ItemId) => number,
): { slot: ChestStack; cursor: ItemStack | null } {
  if (cursor === null) {
    if (slot === null || slot.count <= 0) {
      return { slot, cursor: null };
    }
    return { slot: null, cursor: { itemId: slot.itemId, count: slot.count } };
  }
  if (slot === null || slot.count <= 0) {
    const max = maxFor(cursor.itemId, maxStack);
    const put = Math.min(cursor.count, max);
    const nextCur =
      cursor.count > put ? { itemId: cursor.itemId, count: cursor.count - put } : null;
    return { slot: { itemId: cursor.itemId, count: put }, cursor: nextCur };
  }
  if (slot.itemId === cursor.itemId) {
    const max = maxFor(cursor.itemId, maxStack);
    const space = max - slot.count;
    if (space <= 0) {
      return { slot, cursor };
    }
    const move = Math.min(space, cursor.count);
    const newSlot = { itemId: slot.itemId, count: slot.count + move };
    const newCur =
      cursor.count > move ? { itemId: cursor.itemId, count: cursor.count - move } : null;
    return { slot: newSlot, cursor: newCur };
  }
  return {
    slot: { itemId: cursor.itemId, count: cursor.count },
    cursor: { itemId: slot.itemId, count: slot.count },
  };
}

function slotRmb(
  slot: ChestStack,
  cursor: ItemStack | null,
  maxStack: (itemId: ItemId) => number,
): { slot: ChestStack; cursor: ItemStack | null } {
  if (cursor === null) {
    if (slot === null || slot.count <= 0) {
      return { slot, cursor: null };
    }
    const take = Math.ceil(slot.count / 2);
    const remain = slot.count - take;
    return {
      slot: remain > 0 ? { itemId: slot.itemId, count: remain } : null,
      cursor: { itemId: slot.itemId, count: take },
    };
  }
  if (slot === null || slot.count <= 0) {
    const max = maxFor(cursor.itemId, maxStack);
    if (max <= 0) {
      return { slot, cursor };
    }
    return {
      slot: { itemId: cursor.itemId, count: 1 },
      cursor:
        cursor.count > 1
          ? { itemId: cursor.itemId, count: cursor.count - 1 }
          : null,
    };
  }
  if (slot.itemId === cursor.itemId && slot.count < maxFor(slot.itemId, maxStack)) {
    const ns = { itemId: slot.itemId, count: slot.count + 1 };
    const nc = cursor.count - 1;
    return { slot: ns, cursor: nc <= 0 ? null : { itemId: cursor.itemId, count: nc } };
  }
  return { slot, cursor };
}

export function applyChestSlotMouse(
  state: ChestTileState,
  slotIndex: number,
  button: number,
  cursor: ItemStack | null,
  maxStack: (itemId: ItemId) => number,
): { state: ChestTileState; cursor: ItemStack | null } {
  if (slotIndex < 0 || slotIndex >= state.slots.length) {
    return { state, cursor };
  }
  const slots = state.slots.map((s) => (s === null ? null : { ...s }));
  let s = slots[slotIndex]!;
  const r = button === 2 ? slotRmb(s, cursor, maxStack) : slotLmb(s, cursor, maxStack);
  slots[slotIndex] = r.slot;
  return { state: { slots }, cursor: r.cursor };
}

/** LMB drag: move one item from cursor into chest slot (matches inventory distribute). */
export function placeOneFromCursorIntoChestSlot(
  state: ChestTileState,
  slotIndex: number,
  cursor: ItemStack | null,
  maxStack: (itemId: ItemId) => number,
): { state: ChestTileState; cursor: ItemStack | null } {
  if (slotIndex < 0 || slotIndex >= state.slots.length || cursor === null || cursor.count <= 0) {
    return { state, cursor };
  }
  const slots = state.slots.map((x) => (x === null ? null : { ...x }));
  const max = maxFor(cursor.itemId, maxStack);
  let slot = slots[slotIndex]!;
  if (slot === null || slot.count <= 0) {
    slots[slotIndex] = { itemId: cursor.itemId, count: 1 };
    const nc = cursor.count - 1;
    return {
      state: { slots },
      cursor: nc <= 0 ? null : { itemId: cursor.itemId, count: nc },
    };
  }
  if (slot.itemId === cursor.itemId && slot.count < max) {
    slot = { itemId: slot.itemId, count: slot.count + 1 };
    slots[slotIndex] = slot;
    const nc = cursor.count - 1;
    return {
      state: { slots },
      cursor: nc <= 0 ? null : { itemId: cursor.itemId, count: nc },
    };
  }
  return { state, cursor };
}
