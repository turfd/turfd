import type { ItemStack } from "../../core/itemDefinition";
import { CHEST_DOUBLE_SLOTS, CHEST_SINGLE_SLOTS } from "../../core/constants";

export type ChestStack = ItemStack | null;

export type ChestTileState = {
  readonly slots: ChestStack[];
  /** Optional deferred loot-table id for one-time roll when opened. */
  readonly lootTableId?: string;
  /** True after loot has been rolled once from {@link lootTableId}. */
  readonly lootRolled?: boolean;
};

export function chestCellKey(wx: number, wy: number): string {
  return `${wx},${wy}`;
}

export function createEmptyChestTile(slotCount: number): ChestTileState {
  return { slots: Array.from({ length: slotCount }, () => null) };
}

export function chestTilesEqual(a: ChestTileState, b: ChestTileState): boolean {
  if ((a.lootTableId ?? "") !== (b.lootTableId ?? "")) {
    return false;
  }
  if ((a.lootRolled ?? false) !== (b.lootRolled ?? false)) {
    return false;
  }
  if (a.slots.length !== b.slots.length) {
    return false;
  }
  for (let i = 0; i < a.slots.length; i++) {
    const x = a.slots[i] ?? null;
    const y = b.slots[i] ?? null;
    if (x === null && y === null) {
      continue;
    }
    if (x === null || y === null) {
      return false;
    }
    const dx = x.damage ?? 0;
    const dy = y.damage ?? 0;
    if (x.itemId !== y.itemId || x.count !== y.count || dx !== dy) {
      return false;
    }
  }
  return true;
}

export function expectedChestSlotCount(isDouble: boolean): number {
  return isDouble ? CHEST_DOUBLE_SLOTS : CHEST_SINGLE_SLOTS;
}
