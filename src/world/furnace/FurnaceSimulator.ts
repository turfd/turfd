/**
 * Timed furnace: FIFO queue, 10-slot output buffer. Stepped with fixed dtSec (no fuel).
 */

import type { ItemId } from "../../core/itemDefinition";
import type { ItemRegistry } from "../../items/ItemRegistry";
import type { SmeltingRegistry } from "../SmeltingRegistry";
import {
  FURNACE_OUTPUT_SLOT_COUNT,
  cloneFurnaceQueue,
  type FurnaceQueueEntry,
  type FurnaceStack,
  type FurnaceTileState,
} from "./FurnaceTileState";

const MAX_CATCHUP_SEC = 120;
const EPS = 1e-9;

function addItemsToOutputSlots(
  slots: FurnaceStack[],
  itemId: ItemId,
  count: number,
  maxStack: number,
): { slots: FurnaceStack[]; leftover: number } {
  const out = slots.map((s) => (s === null ? null : { ...s }));
  let remaining = count;
  for (let pass = 0; pass < 2 && remaining > 0; pass++) {
    for (let i = 0; i < FURNACE_OUTPUT_SLOT_COUNT && remaining > 0; i++) {
      const s = out[i]!;
      if (pass === 0) {
        if (
          s !== null &&
          s.itemId === itemId &&
          s.count < maxStack &&
          (s.damage ?? 0) === 0
        ) {
          const room = maxStack - s.count;
          const put = Math.min(room, remaining);
          out[i] = { itemId, count: s.count + put };
          remaining -= put;
        }
      } else if (s === null) {
        const put = Math.min(maxStack, remaining);
        out[i] = { itemId, count: put };
        remaining -= put;
      }
    }
  }
  return { slots: out, leftover: remaining };
}

export function stepFurnaceTile(
  state: FurnaceTileState,
  dtSec: number,
  worldTimeMs: number,
  items: ItemRegistry,
  smelting: SmeltingRegistry,
): FurnaceTileState {
  if (dtSec <= 0) {
    return { ...state, lastProcessedWorldTimeMs: worldTimeMs };
  }

  let outputSlots = state.outputSlots.map((s) => (s === null ? null : { ...s }));
  let fuel = state.fuel === null ? null : { ...state.fuel };
  let fuelRemainingSec = state.fuelRemainingSec;
  let cookProgressSec = state.cookProgressSec;
  let queue = cloneFurnaceQueue(state.queue);

  let remainingSim = Math.min(dtSec, MAX_CATCHUP_SEC);
  let guard = 4096;

  while (remainingSim > 1e-9 && guard-- > 0) {
    if (queue.length === 0) {
      break;
    }

    const headId = queue[0]!.smeltingRecipeId;
    const recipe = smelting.findRecipeByJsonId(headId);
    if (recipe === undefined) {
      break;
    }
    const outDef = items.getByKey(recipe.outputItemKey);
    const outId = outDef?.id;
    const maxOut = outDef?.maxStack ?? 64;
    const cookTime = Math.max(recipe.cookTimeSec, 1e-6);

    const needCook = cookTime - cookProgressSec;
    const step = Math.min(remainingSim, Math.max(needCook, 1e-9));
    cookProgressSec += step;
    remainingSim -= step;

    if (cookProgressSec >= cookTime - EPS) {
      if (outId === undefined) {
        cookProgressSec = 0;
        const q0 = queue[0]!;
        if (q0.batches <= 1) {
          queue = queue.slice(1);
        } else {
          queue = queue.map((e, i) =>
            i === 0 ? { smeltingRecipeId: e.smeltingRecipeId, batches: e.batches - 1 } : e,
          );
        }
        continue;
      }
      const { slots: nextSlots, leftover } = addItemsToOutputSlots(
        outputSlots,
        outId,
        recipe.outputCount,
        maxOut,
      );
      if (leftover > 0) {
        cookProgressSec = Math.max(0, cookTime - EPS);
        break;
      }
      outputSlots = nextSlots;
      cookProgressSec = 0;
      const q0 = queue[0]!;
      if (q0.batches <= 1) {
        queue = queue.slice(1);
      } else {
        queue = queue.map((e, i) =>
          i === 0 ? { smeltingRecipeId: e.smeltingRecipeId, batches: e.batches - 1 } : e,
        );
      }
    }
  }

  return {
    outputSlots,
    fuel,
    fuelRemainingSec,
    cookProgressSec,
    queue,
    lastProcessedWorldTimeMs: worldTimeMs,
  };
}

/** Apply one batch output onto a slot copy (for enqueue validation). */
export function applyOneBatchToSlotsCopy(
  outputSlots: readonly FurnaceStack[],
  recipe: { outputItemKey: string; outputCount: number },
  items: ItemRegistry,
): FurnaceStack[] | null {
  const outDef = items.getByKey(recipe.outputItemKey);
  if (outDef === undefined) {
    return null;
  }
  const { slots, leftover } = addItemsToOutputSlots(
    outputSlots.map((x) => (x === null ? null : { ...x })),
    outDef.id,
    recipe.outputCount,
    outDef.maxStack ?? 64,
  );
  if (leftover > 0) {
    return null;
  }
  return slots;
}

export function mergeQueueEntry(
  queue: readonly FurnaceQueueEntry[],
  smeltingRecipeId: string,
  addBatches: number,
): FurnaceQueueEntry[] {
  const q = cloneFurnaceQueue(queue);
  const last = q[q.length - 1];
  if (last !== undefined && last.smeltingRecipeId === smeltingRecipeId) {
    last.batches += addBatches;
    return q;
  }
  q.push({ smeltingRecipeId, batches: addBatches });
  return q;
}
