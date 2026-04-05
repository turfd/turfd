/** Per-cell furnace: fuel, 10-slot output buffer, FIFO smelt queue (timed). */

import type { ItemStack } from "../../core/itemDefinition";

export const FURNACE_OUTPUT_SLOT_COUNT = 10;

export type FurnaceStack = ItemStack | null;

export type FurnaceQueueEntry = {
  readonly smeltingRecipeId: string;
  batches: number;
};

export type FurnaceTileState = {
  /** Output buffer; player pulls from here. */
  outputSlots: FurnaceStack[];
  fuel: FurnaceStack;
  fuelRemainingSec: number;
  /** Progress for the current batch at queue head (0 … recipe cookTimeSec). */
  cookProgressSec: number;
  readonly queue: FurnaceQueueEntry[];
  lastProcessedWorldTimeMs: number;
};

export function createEmptyFurnaceTileState(worldTimeMs: number): FurnaceTileState {
  return {
    outputSlots: Array.from({ length: FURNACE_OUTPUT_SLOT_COUNT }, () => null),
    fuel: null,
    fuelRemainingSec: 0,
    cookProgressSec: 0,
    queue: [],
    lastProcessedWorldTimeMs: worldTimeMs,
  };
}

export function furnaceCellKey(wx: number, wy: number): string {
  return `${wx},${wy}`;
}

function stacksEqual(a: FurnaceStack, b: FurnaceStack): boolean {
  if (a === null && b === null) {
    return true;
  }
  if (a === null || b === null) {
    return false;
  }
  const da = a.damage ?? 0;
  const db = b.damage ?? 0;
  return a.itemId === b.itemId && a.count === b.count && da === db;
}

function queueEqual(
  a: readonly FurnaceQueueEntry[],
  b: readonly FurnaceQueueEntry[],
): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.smeltingRecipeId !== y.smeltingRecipeId || x.batches !== y.batches) {
      return false;
    }
  }
  return true;
}

export function furnaceTilesEqual(a: FurnaceTileState, b: FurnaceTileState): boolean {
  for (let i = 0; i < FURNACE_OUTPUT_SLOT_COUNT; i++) {
    if (!stacksEqual(a.outputSlots[i]!, b.outputSlots[i]!)) {
      return false;
    }
  }
  return (
    stacksEqual(a.fuel, b.fuel) &&
    a.fuelRemainingSec === b.fuelRemainingSec &&
    a.cookProgressSec === b.cookProgressSec &&
    queueEqual(a.queue, b.queue) &&
    a.lastProcessedWorldTimeMs === b.lastProcessedWorldTimeMs
  );
}

/** Clone queue for immutable updates. */
export function cloneFurnaceQueue(q: readonly FurnaceQueueEntry[]): FurnaceQueueEntry[] {
  return q.map((e) => ({ smeltingRecipeId: e.smeltingRecipeId, batches: e.batches }));
}
