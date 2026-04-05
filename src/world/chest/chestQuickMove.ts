/**
 * Shift–quick-move from player inventory into chest slots (merge partials, then empty slots).
 */

import type { ItemId, ItemStack } from "../../core/itemDefinition";
import type { ChestStack, ChestTileState } from "./ChestTileState";

export function quickMoveStackIntoChest(
  state: ChestTileState,
  stack: ItemStack,
  maxStack: (itemId: ItemId) => number,
): {
  state: ChestTileState;
  remainder: ItemStack | null;
  firstChestIndex: number | null;
} {
  const slots: ChestStack[] = state.slots.map((s) =>
    s === null ? null : { itemId: s.itemId, count: s.count },
  );
  let remaining = stack.count;
  const itemId = stack.itemId;
  let firstChestIndex: number | null = null;
  const max = maxStack(itemId);

  for (let i = 0; i < slots.length && remaining > 0; i++) {
    const s = slots[i];
    if (s === undefined || s === null || s.itemId !== itemId) {
      continue;
    }
    if (s.count >= max) {
      continue;
    }
    const space = max - s.count;
    const move = Math.min(space, remaining);
    if (move <= 0) {
      continue;
    }
    if (firstChestIndex === null) {
      firstChestIndex = i;
    }
    s.count += move;
    remaining -= move;
  }

  for (let i = 0; i < slots.length && remaining > 0; i++) {
    const cell = slots[i];
    if (cell !== undefined && cell !== null) {
      continue;
    }
    const put = Math.min(max, remaining);
    if (firstChestIndex === null) {
      firstChestIndex = i;
    }
    slots[i] = { itemId, count: put };
    remaining -= put;
  }

  const remainder: ItemStack | null =
    remaining <= 0
      ? null
      : (() => {
          const out: ItemStack = { itemId: stack.itemId, count: remaining };
          if (stack.damage !== undefined && stack.damage > 0) {
            out.damage = stack.damage;
          }
          return out;
        })();

  return {
    state: { slots },
    remainder,
    firstChestIndex,
  };
}
