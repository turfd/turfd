/**
 * Cursor interactions for furnace fuel slot and output buffer slots (single-slot rules).
 */

import type { ItemId, ItemStack } from "../../core/itemDefinition";
import type { FurnaceStack, FurnaceTileState } from "./FurnaceTileState";
import { FURNACE_OUTPUT_SLOT_COUNT } from "./FurnaceTileState";

function maxFor(id: ItemId, maxStack: (itemId: ItemId) => number): number {
  return maxStack(id);
}

function dmgKey(d: number | undefined): number {
  return d ?? 0;
}

function stackFromSlot(slot: FurnaceStack): ItemStack {
  if (slot === null || slot.count <= 0) {
    return { itemId: 0 as ItemId, count: 0 };
  }
  const out: ItemStack = { itemId: slot.itemId, count: slot.count };
  if (slot.damage !== undefined && slot.damage > 0) {
    out.damage = slot.damage;
  }
  return out;
}

function slotLmb(
  slot: FurnaceStack,
  cursor: ItemStack | null,
  maxStack: (itemId: ItemId) => number,
): { slot: FurnaceStack; cursor: ItemStack | null } {
  if (cursor === null) {
    if (slot === null || slot.count <= 0) {
      return { slot, cursor: null };
    }
    return { slot: null, cursor: stackFromSlot(slot) };
  }
  if (slot === null || slot.count <= 0) {
    const max = maxFor(cursor.itemId, maxStack);
    const put = Math.min(cursor.count, max);
    const placed: ItemStack = { itemId: cursor.itemId, count: put };
    if (cursor.damage !== undefined && cursor.damage > 0) {
      placed.damage = cursor.damage;
    }
    const nextCur =
      cursor.count > put
        ? {
            itemId: cursor.itemId,
            count: cursor.count - put,
            ...(cursor.damage !== undefined && cursor.damage > 0
              ? { damage: cursor.damage }
              : {}),
          }
        : null;
    return { slot: placed, cursor: nextCur };
  }
  if (
    slot.itemId === cursor.itemId &&
    dmgKey(slot.damage) === dmgKey(cursor.damage)
  ) {
    const max = maxFor(cursor.itemId, maxStack);
    const space = max - slot.count;
    if (space <= 0) {
      return { slot, cursor };
    }
    const move = Math.min(space, cursor.count);
    const newSlot: ItemStack = {
      itemId: slot.itemId,
      count: slot.count + move,
      ...(slot.damage !== undefined && slot.damage > 0 ? { damage: slot.damage } : {}),
    };
    const newCur =
      cursor.count > move
        ? {
            itemId: cursor.itemId,
            count: cursor.count - move,
            ...(cursor.damage !== undefined && cursor.damage > 0
              ? { damage: cursor.damage }
              : {}),
          }
        : null;
    return { slot: newSlot, cursor: newCur };
  }
  return {
    slot: {
      itemId: cursor.itemId,
      count: cursor.count,
      ...(cursor.damage !== undefined && cursor.damage > 0 ? { damage: cursor.damage } : {}),
    },
    cursor: stackFromSlot(slot),
  };
}

function slotRmb(
  slot: FurnaceStack,
  cursor: ItemStack | null,
  maxStack: (itemId: ItemId) => number,
): { slot: FurnaceStack; cursor: ItemStack | null } {
  if (cursor === null) {
    if (slot === null || slot.count <= 0) {
      return { slot, cursor: null };
    }
    const take = Math.ceil(slot.count / 2);
    const remain = slot.count - take;
    const cur: ItemStack = {
      itemId: slot.itemId,
      count: take,
      ...(slot.damage !== undefined && slot.damage > 0 ? { damage: slot.damage } : {}),
    };
    return {
      slot:
        remain > 0
          ? {
              itemId: slot.itemId,
              count: remain,
              ...(slot.damage !== undefined && slot.damage > 0 ? { damage: slot.damage } : {}),
            }
          : null,
      cursor: cur,
    };
  }
  if (slot === null || slot.count <= 0) {
    const max = maxFor(cursor.itemId, maxStack);
    if (max <= 0) {
      return { slot, cursor };
    }
    const one: ItemStack = {
      itemId: cursor.itemId,
      count: 1,
      ...(cursor.damage !== undefined && cursor.damage > 0 ? { damage: cursor.damage } : {}),
    };
    return {
      slot: one,
      cursor:
        cursor.count > 1
          ? {
              itemId: cursor.itemId,
              count: cursor.count - 1,
              ...(cursor.damage !== undefined && cursor.damage > 0
                ? { damage: cursor.damage }
                : {}),
            }
          : null,
    };
  }
  if (
    slot.itemId === cursor.itemId &&
    slot.count < maxFor(slot.itemId, maxStack) &&
    dmgKey(slot.damage) === dmgKey(cursor.damage)
  ) {
    const ns: ItemStack = {
      itemId: slot.itemId,
      count: slot.count + 1,
      ...(slot.damage !== undefined && slot.damage > 0 ? { damage: slot.damage } : {}),
    };
    const nc = cursor.count - 1;
    return {
      slot: ns,
      cursor:
        nc <= 0
          ? null
          : {
              itemId: cursor.itemId,
              count: nc,
              ...(cursor.damage !== undefined && cursor.damage > 0
                ? { damage: cursor.damage }
                : {}),
            },
    };
  }
  return { slot, cursor };
}

export function applyFurnaceFuelSlotMouse(
  tile: FurnaceTileState,
  button: number,
  cursor: ItemStack | null,
  maxStack: (itemId: ItemId) => number,
): { tile: FurnaceTileState; cursor: ItemStack | null } {
  let fuel = tile.fuel;
  const r =
    button === 2
      ? slotRmb(fuel, cursor, maxStack)
      : slotLmb(fuel, cursor, maxStack);
  fuel = r.slot;
  return {
    tile: {
      ...tile,
      fuel,
    },
    cursor: r.cursor,
  };
}

export function applyFurnaceOutputSlotMouse(
  tile: FurnaceTileState,
  slotIndex: number,
  button: number,
  cursor: ItemStack | null,
  maxStack: (itemId: ItemId) => number,
): { tile: FurnaceTileState; cursor: ItemStack | null } {
  if (slotIndex < 0 || slotIndex >= FURNACE_OUTPUT_SLOT_COUNT) {
    return { tile, cursor };
  }
  const outputSlots = tile.outputSlots.map((s) => (s === null ? null : { ...s }));
  let s = outputSlots[slotIndex]!;
  const r =
    button === 2 ? slotRmb(s, cursor, maxStack) : slotLmb(s, cursor, maxStack);
  outputSlots[slotIndex] = r.slot;
  return {
    tile: {
      ...tile,
      outputSlots,
    },
    cursor: r.cursor,
  };
}
