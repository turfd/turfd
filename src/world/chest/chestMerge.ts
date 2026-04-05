import { CHEST_SINGLE_SLOTS } from "../../core/constants";
import type { ChestTileState } from "./ChestTileState";
import { createEmptyChestTile } from "./ChestTileState";
import { chestIsDoubleAtAnchor, chestStorageAnchor } from "./chestVisual";

export type ChestMergeContext = {
  readonly chestBlockId: number;
  getBlockId(x: number, y: number): number;
  getTile(ax: number, ay: number): ChestTileState | undefined;
  setTile(ax: number, ay: number, t: ChestTileState): void;
  deleteTile(ax: number, ay: number): void;
};

/**
 * After a chest is placed at (wx, wy), optionally merge with a single western or eastern neighbor.
 * Prefers west merge when both sides qualify (avoids triple).
 */
export function tryMergeChestAfterPlace(wx: number, wy: number, ctx: ChestMergeContext): void {
  const { chestBlockId } = ctx;
  const isChest = (x: number, y: number): boolean => ctx.getBlockId(x, y) === chestBlockId;

  if (!isChest(wx, wy)) {
    return;
  }

  const mergeWest =
    isChest(wx - 1, wy) &&
    chestStorageAnchor(wx - 1, wy, isChest).ax === wx - 1 &&
    !chestIsDoubleAtAnchor(wx - 1, wy, isChest);

  if (mergeWest) {
    const westTile = ctx.getTile(wx - 1, wy);
    if (westTile === undefined || westTile.slots.length !== CHEST_SINGLE_SLOTS) {
      return;
    }
    ctx.deleteTile(wx, wy);
    const combined: ChestTileState = {
      slots: [...westTile.slots, ...createEmptyChestTile(CHEST_SINGLE_SLOTS).slots],
    };
    ctx.setTile(wx - 1, wy, combined);
    return;
  }

  const mergeEast =
    isChest(wx + 1, wy) &&
    chestStorageAnchor(wx + 1, wy, isChest).ax === wx + 1 &&
    !chestIsDoubleAtAnchor(wx + 1, wy, isChest);

  if (mergeEast) {
    const eastTile = ctx.getTile(wx + 1, wy);
    if (eastTile === undefined || eastTile.slots.length !== CHEST_SINGLE_SLOTS) {
      return;
    }
    ctx.deleteTile(wx + 1, wy);
    const combined: ChestTileState = {
      slots: [...createEmptyChestTile(CHEST_SINGLE_SLOTS).slots, ...eastTile.slots],
    };
    ctx.setTile(wx, wy, combined);
  }
}
