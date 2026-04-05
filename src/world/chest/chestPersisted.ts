/** Chest tile serialization (IndexedDB + network chunk tail). */

import type { ItemId } from "../../core/itemDefinition";
import { worldToLocalBlock } from "../chunk/ChunkCoord";
import { CHEST_DOUBLE_SLOTS, CHEST_SINGLE_SLOTS } from "../../core/constants";
import type { ChestStack, ChestTileState } from "./ChestTileState";
import { createEmptyChestTile } from "./ChestTileState";

/** Magic `CHST` — chest entries in chunk tail. */
export const CHEST_CHUNK_MAGIC = 0x43_48_53_54;

const LE = true;

export function byteLengthChestPersisted(p: ChestPersistedChunk): number {
  return 3 + p.slotCount * 4;
}

export function writeChestPersistedToView(
  view: DataView,
  buffer: ArrayBuffer,
  offset: number,
  p: ChestPersistedChunk,
): number {
  let o = offset;
  view.setUint8(o++, p.lx & 0xff);
  view.setUint8(o++, p.ly & 0xff);
  view.setUint8(o++, p.slotCount & 0xff);
  for (let i = 0; i < p.slotCount; i++) {
    const s = p.slots[i] ?? null;
    if (s === null || s.count <= 0) {
      view.setUint16(o, 0, LE);
      o += 2;
      view.setUint16(o, 0, LE);
      o += 2;
    } else {
      view.setUint16(o, s.id & 0xffff, LE);
      o += 2;
      view.setUint16(o, Math.min(s.count, 0xffff) & 0xffff, LE);
      o += 2;
    }
  }
  void buffer;
  return o;
}

export function readChestPersistedFromView(
  view: DataView,
  buffer: ArrayBuffer,
  offset: number,
): [ChestPersistedChunk, number] | undefined {
  if (buffer.byteLength < offset + 3) {
    return undefined;
  }
  let o = offset;
  const lx = view.getUint8(o++);
  const ly = view.getUint8(o++);
  const slotCount = view.getUint8(o++);
  if (
    slotCount !== CHEST_SINGLE_SLOTS &&
    slotCount !== CHEST_DOUBLE_SLOTS
  ) {
    return undefined;
  }
  const need = slotCount * 4;
  if (buffer.byteLength < o + need) {
    return undefined;
  }
  const slots: ({ id: number; count: number } | null)[] = [];
  for (let i = 0; i < slotCount; i++) {
    const id = view.getUint16(o, LE);
    o += 2;
    const count = view.getUint16(o, LE);
    o += 2;
    if (id <= 0 || count <= 0) {
      slots.push(null);
    } else {
      slots.push({ id, count });
    }
  }
  return [
    { lx, ly, format: 1, slotCount, slots },
    o,
  ];
}

export type ChestPersistedChunk = {
  lx: number;
  ly: number;
  format: 1;
  slotCount: number;
  slots: ({ id: number; count: number } | null)[];
};

export function chestStackToPersisted(s: ChestStack): { id: number; count: number } | null {
  if (s === null || s.count <= 0) {
    return null;
  }
  return { id: s.itemId as number, count: s.count };
}

export function chestStackFromPersisted(s: { id: number; count: number } | null): ChestStack {
  if (s === null || s.count <= 0) {
    return null;
  }
  return { itemId: s.id as ItemId, count: s.count };
}

export function chestTileToPersisted(wx: number, wy: number, state: ChestTileState): ChestPersistedChunk {
  const { lx, ly } = worldToLocalBlock(wx, wy);
  return {
    lx,
    ly,
    format: 1,
    slotCount: state.slots.length,
    slots: state.slots.map((s) => chestStackToPersisted(s)),
  };
}

export function persistedToChestTile(p: ChestPersistedChunk): ChestTileState {
  const n = p.slotCount === CHEST_DOUBLE_SLOTS ? CHEST_DOUBLE_SLOTS : CHEST_SINGLE_SLOTS;
  const slots = createEmptyChestTile(n).slots;
  for (let i = 0; i < n && i < p.slots.length; i++) {
    slots[i] = chestStackFromPersisted(p.slots[i] ?? null);
  }
  return { slots };
}

export function normalizeChestPersistedChunk(raw: unknown): ChestPersistedChunk | undefined {
  if (raw === null || typeof raw !== "object") {
    return undefined;
  }
  const o = raw as Record<string, unknown>;
  const lx = o.lx;
  const ly = o.ly;
  if (typeof lx !== "number" || typeof ly !== "number") {
    return undefined;
  }
  const slotCount = o.slotCount;
  const sc =
    slotCount === CHEST_DOUBLE_SLOTS || slotCount === CHEST_SINGLE_SLOTS
      ? slotCount
      : CHEST_SINGLE_SLOTS;
  const slotsRaw = o.slots;
  const slots: ({ id: number; count: number } | null)[] = [];
  if (Array.isArray(slotsRaw)) {
    for (let i = 0; i < sc && i < slotsRaw.length; i++) {
      const s = slotsRaw[i];
      if (s !== null && typeof s === "object") {
        const id = (s as { id?: number }).id;
        const count = (s as { count?: number }).count;
        if (typeof id === "number" && typeof count === "number" && id > 0 && count > 0) {
          slots.push({ id, count });
          continue;
        }
      }
      slots.push(null);
    }
  }
  while (slots.length < sc) {
    slots.push(null);
  }
  return { lx, ly, format: 1, slotCount: sc, slots };
}
