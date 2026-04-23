/**
 * Spawn item entities for queued furnace inputs (refund cancelled queue or furnace break).
 */
import { BLOCK_SIZE } from "../../core/constants";
import type { ItemId } from "../../core/itemDefinition";
import type { ItemRegistry } from "../../items/ItemRegistry";
import type { SmeltingRegistry } from "../SmeltingRegistry";
import type { World } from "../World";
import type { FurnaceQueueEntry } from "./FurnaceTileState";

export function spawnQueuedSmeltInputDrops(
  world: World,
  wx: number,
  wy: number,
  queue: readonly FurnaceQueueEntry[],
  smelting: SmeltingRegistry,
  items: ItemRegistry,
): void {
  const px = (wx + 0.5) * BLOCK_SIZE;
  const py = (wy + 0.5) * BLOCK_SIZE;
  for (const e of queue) {
    const r = smelting.findRecipeByJsonId(e.smeltingRecipeId);
    if (r === undefined) {
      continue;
    }
    let itemId: ItemId | undefined;
    if (r.inputItemKey !== undefined) {
      itemId = items.getByKey(r.inputItemKey)?.id;
    } else if (r.inputTag !== undefined) {
      const defs = [...items.getByTag(r.inputTag)].sort((a, b) =>
        a.key.localeCompare(b.key),
      );
      itemId = defs[0]?.id;
    }
    if (itemId === undefined || e.batches <= 0) {
      continue;
    }
    world.spawnItem(itemId, e.batches, px, py, 0, 0, 0);
  }
}
