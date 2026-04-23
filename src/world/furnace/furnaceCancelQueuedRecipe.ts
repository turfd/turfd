import { cloneFurnaceQueue, type FurnaceTileState } from "./FurnaceTileState";

/**
 * Remove all queue entries matching `smeltingRecipeId` and reset cook progress when the
 * active head entry is removed or replaced.
 */
export function removeFurnaceQueueEntriesForRecipe(
  tile: FurnaceTileState,
  smeltingRecipeId: string,
): FurnaceTileState | null {
  const prevHead = tile.queue[0];
  const removed = tile.queue.filter((e) => e.smeltingRecipeId === smeltingRecipeId);
  if (removed.length === 0) {
    return null;
  }
  const newQueue = tile.queue.filter((e) => e.smeltingRecipeId !== smeltingRecipeId);
  const newHead = newQueue[0];
  const headChanged =
    prevHead === undefined
      ? newHead !== undefined
      : newHead === undefined ||
        newHead.smeltingRecipeId !== prevHead.smeltingRecipeId ||
        newHead.batches !== prevHead.batches;
  return {
    outputSlots: tile.outputSlots.map((s) => (s === null ? null : { ...s })),
    fuel: tile.fuel === null ? null : { ...tile.fuel },
    fuelRemainingSec: tile.fuelRemainingSec,
    cookProgressSec: headChanged ? 0 : tile.cookProgressSec,
    queue: cloneFurnaceQueue(newQueue),
    lastProcessedWorldTimeMs: tile.lastProcessedWorldTimeMs,
  };
}
