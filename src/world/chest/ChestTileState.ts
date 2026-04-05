import type { ItemId } from "../../core/itemDefinition";
import { CHEST_DOUBLE_SLOTS, CHEST_SINGLE_SLOTS } from "../../core/constants";

export type ChestStack = { itemId: ItemId; count: number } | null;

export type ChestTileState = {
  readonly slots: ChestStack[];
};

export function chestCellKey(wx: number, wy: number): string {
  return `${wx},${wy}`;
}

export function createEmptyChestTile(slotCount: number): ChestTileState {
  return { slots: Array.from({ length: slotCount }, () => null) };
}

export function chestTilesEqual(a: ChestTileState, b: ChestTileState): boolean {
  if (a.slots.length !== b.slots.length) {
    return false;
  }
  for (let i = 0; i < a.slots.length; i++) {
    const x = a.slots[i] ?? null;
    const y = b.slots[i] ?? null;
    if (x === null && y === null) {
      continue;
    }
    if (x === null || y === null || x.itemId !== y.itemId || x.count !== y.count) {
      return false;
    }
  }
  return true;
}

export function expectedChestSlotCount(isDouble: boolean): number {
  return isDouble ? CHEST_DOUBLE_SLOTS : CHEST_SINGLE_SLOTS;
}
