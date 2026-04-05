/** Horizontal chest pairing for rendering and storage anchor (incl. 3-in-a-row rule). */

export type ChestVisualRole = "single" | "doubleLeft" | "doubleRight";

/**
 * `isChest` must return true iff the block at (wx, wy) is a chest.
 * Uses memoized recursion so each cell is computed once per call.
 */
export function chestVisualRole(
  wx: number,
  wy: number,
  isChest: (x: number, y: number) => boolean,
  memo: Map<string, ChestVisualRole> = new Map(),
): ChestVisualRole {
  const k = `${wx},${wy}`;
  const hit = memo.get(k);
  if (hit !== undefined) {
    return hit;
  }
  if (!isChest(wx, wy)) {
    memo.set(k, "single");
    return "single";
  }
  const L = isChest(wx - 1, wy);
  const R = isChest(wx + 1, wy);
  let r: ChestVisualRole = "single";
  if (L) {
    const wR = chestVisualRole(wx - 1, wy, isChest, memo);
    if (wR === "doubleLeft") {
      r = "doubleRight";
    }
  }
  if (r === "single" && R) {
    const wR = L ? chestVisualRole(wx - 1, wy, isChest, memo) : "single";
    if (!(L && wR === "doubleRight")) {
      r = "doubleLeft";
    }
  }
  memo.set(k, r);
  return r;
}

/** World cell that owns {@link ChestTileState} (western cell of a double, or a single). */
export function chestStorageAnchor(
  wx: number,
  wy: number,
  isChest: (x: number, y: number) => boolean,
  memo?: Map<string, ChestVisualRole>,
): { ax: number; ay: number } {
  const role = chestVisualRole(wx, wy, isChest, memo);
  if (role === "doubleRight") {
    return { ax: wx - 1, ay: wy };
  }
  return { ax: wx, ay: wy };
}

export function chestIsDoubleAtAnchor(
  ax: number,
  ay: number,
  isChest: (x: number, y: number) => boolean,
  memo?: Map<string, ChestVisualRole>,
): boolean {
  return chestVisualRole(ax, ay, isChest, memo) === "doubleLeft";
}
