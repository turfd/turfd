/** Chest tile serialization (IndexedDB + network chunk tail). */

import {
  clampDamageForDefinition,
  isStackBroken,
  type ItemId,
  type ItemStack,
} from "../../core/itemDefinition";
import type { ItemRegistry } from "../../items/ItemRegistry";
import { CHEST_DOUBLE_SLOTS, CHEST_SINGLE_SLOTS } from "../../core/constants";
import { worldToLocalBlock } from "../chunk/ChunkCoord";
import type { ChestStack, ChestTileState } from "./ChestTileState";
import { createEmptyChestTile } from "./ChestTileState";

/** Magic `CHST` — chest entries (numeric item ids). */
export const CHEST_CHUNK_MAGIC = 0x43_48_53_54;
/** Magic `CHS2` — chest entries with UTF-8 item keys. */
export const CHEST_CHUNK_MAGIC_V2 = 0x32_53_48_43;

/**
 * First payload byte of CHEST_SNAPSHOT for v2 key slots (invalid as lx alone: chunk-local x is 0…31).
 */
export const CHEST_SNAPSHOT_V2_SENTINEL = 0xff;

const LE = true;
const textEnc = new TextEncoder();
const textDec = new TextDecoder();
const MAX_ITEM_KEY_UTF8 = 120;

/** Legacy slot (numeric id). New saves use {@link ChestPersistedSlotKey}. */
export type ChestPersistedSlotId = { id: number; count: number };
/** Stable slot shape (matches player inventory persistence). */
export type ChestPersistedSlotKey = { key: string; count: number; damage?: number };

export type ChestPersistedSlot = ChestPersistedSlotKey | ChestPersistedSlotId | null;

export type ChestPersistedChunk = {
  lx: number;
  ly: number;
  /**
   * 1 = legacy id slots (JSON or binary CHST); 2 = string keys (stable when item ids reshuffle).
   */
  format: 1 | 2;
  slotCount: number;
  slots: ChestPersistedSlot[];
};

export function byteLengthChestPersistedV1(p: ChestPersistedChunk): number {
  return 3 + p.slotCount * 4;
}

export function byteLengthChestPersistedV2(p: ChestPersistedChunk): number {
  let n = 3;
  for (let i = 0; i < p.slotCount; i++) {
    const s = p.slots[i] ?? null;
    if (s === null || !isKeySlot(s) || s.count <= 0) {
      n += 2;
      continue;
    }
    const kb = textEnc.encode(s.key.slice(0, MAX_ITEM_KEY_UTF8));
    const len = Math.min(kb.length, MAX_ITEM_KEY_UTF8);
    n += 2 + len + 2 + 2;
  }
  return n;
}

export function isKeySlot(s: ChestPersistedSlot): s is ChestPersistedSlotKey {
  return s !== null && typeof (s as ChestPersistedSlotKey).key === "string";
}

export function writeChestPersistedV1ToView(
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
    } else if (isKeySlot(s)) {
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

export function writeChestPersistedV2ToView(
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
    if (s === null || s.count <= 0 || !isKeySlot(s)) {
      view.setUint16(o, 0, LE);
      o += 2;
      continue;
    }
    const kb = textEnc.encode(s.key.slice(0, MAX_ITEM_KEY_UTF8));
    const len = Math.min(kb.length, MAX_ITEM_KEY_UTF8);
    view.setUint16(o, len, LE);
    o += 2;
    new Uint8Array(buffer, o, len).set(kb.subarray(0, len));
    o += len;
    view.setUint16(o, Math.min(s.count, 0xffff) & 0xffff, LE);
    o += 2;
    const dmg =
      typeof s.damage === "number" && s.damage > 0
        ? Math.min(0xffff, Math.floor(s.damage))
        : 0;
    view.setUint16(o, dmg, LE);
    o += 2;
  }
  return o;
}

/** @deprecated Use {@link writeChestPersistedV2ToView} for new wire/DB binary; v1 is legacy. */
export function writeChestPersistedToView(
  view: DataView,
  buffer: ArrayBuffer,
  offset: number,
  p: ChestPersistedChunk,
): number {
  return writeChestPersistedV1ToView(view, buffer, offset, p);
}

export function readChestPersistedV1FromView(
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
  if (slotCount !== CHEST_SINGLE_SLOTS && slotCount !== CHEST_DOUBLE_SLOTS) {
    return undefined;
  }
  const need = slotCount * 4;
  if (buffer.byteLength < o + need) {
    return undefined;
  }
  const slots: ChestPersistedSlot[] = [];
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
  return [{ lx, ly, format: 1, slotCount, slots }, o];
}

export function readChestPersistedV2FromView(
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
  if (slotCount !== CHEST_SINGLE_SLOTS && slotCount !== CHEST_DOUBLE_SLOTS) {
    return undefined;
  }
  const slots: ChestPersistedSlot[] = [];
  for (let i = 0; i < slotCount; i++) {
    if (o + 2 > buffer.byteLength) {
      return undefined;
    }
    const keyLen = view.getUint16(o, LE);
    o += 2;
    if (keyLen === 0) {
      slots.push(null);
      continue;
    }
    if (keyLen > MAX_ITEM_KEY_UTF8 || o + keyLen + 4 > buffer.byteLength) {
      return undefined;
    }
    const key =
      keyLen > 0 ? textDec.decode(new Uint8Array(buffer, o, keyLen)) : "";
    o += keyLen;
    const count = view.getUint16(o, LE);
    o += 2;
    const damage = view.getUint16(o, LE);
    o += 2;
    if (key.length === 0 || count <= 0) {
      slots.push(null);
    } else if (damage > 0) {
      slots.push({ key, count, damage });
    } else {
      slots.push({ key, count });
    }
  }
  return [{ lx, ly, format: 2, slotCount, slots }, o];
}

/** @deprecated Prefer {@link readChestPersistedV1FromView} / {@link readChestPersistedV2FromView}. */
export function readChestPersistedFromView(
  view: DataView,
  buffer: ArrayBuffer,
  offset: number,
): [ChestPersistedChunk, number] | undefined {
  return readChestPersistedV1FromView(view, buffer, offset);
}

export function chestStackToPersisted(
  s: ChestStack,
  items: ItemRegistry,
): ChestPersistedSlot {
  if (s === null || s.count <= 0) {
    return null;
  }
  const def = items.getById(s.itemId);
  if (def === undefined) {
    return null;
  }
  const d = clampDamageForDefinition(def, s.damage);
  if (def.maxDurability !== undefined && d > 0) {
    return { key: def.key, count: s.count, damage: d };
  }
  return { key: def.key, count: s.count };
}

export function chestStackFromPersisted(
  s: ChestPersistedSlot,
  items: ItemRegistry,
): ChestStack {
  if (s === null || s.count <= 0) {
    return null;
  }
  if (isKeySlot(s)) {
    const def = items.getByKey(s.key);
    if (def === undefined) {
      return null;
    }
    const d = clampDamageForDefinition(def, s.damage);
    if (isStackBroken(def, d)) {
      return null;
    }
    const stack: ItemStack = { itemId: def.id, count: s.count };
    if (def.maxDurability !== undefined && d > 0) {
      stack.damage = d;
    }
    return stack;
  }
  const def = items.getById(s.id as ItemId);
  if (def === undefined) {
    return null;
  }
  return { itemId: def.id, count: s.count };
}

export function chestTileToPersisted(
  wx: number,
  wy: number,
  state: ChestTileState,
  items: ItemRegistry,
): ChestPersistedChunk {
  const { lx, ly } = worldToLocalBlock(wx, wy);
  return {
    lx,
    ly,
    format: 2,
    slotCount: state.slots.length,
    slots: state.slots.map((s) => chestStackToPersisted(s, items)),
  };
}

export function persistedToChestTile(
  p: ChestPersistedChunk,
  items: ItemRegistry,
): ChestTileState {
  const n = p.slotCount === CHEST_DOUBLE_SLOTS ? CHEST_DOUBLE_SLOTS : CHEST_SINGLE_SLOTS;
  const slots = createEmptyChestTile(n).slots;
  for (let i = 0; i < n && i < p.slots.length; i++) {
    slots[i] = chestStackFromPersisted(p.slots[i] ?? null, items);
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
  const slotCountRaw = o.slotCount;
  const sc =
    slotCountRaw === CHEST_DOUBLE_SLOTS || slotCountRaw === CHEST_SINGLE_SLOTS
      ? slotCountRaw
      : CHEST_SINGLE_SLOTS;
  const slotsRaw = o.slots;
  const slots: ChestPersistedSlot[] = [];
  let sawKey = false;
  if (Array.isArray(slotsRaw)) {
    for (let i = 0; i < sc && i < slotsRaw.length; i++) {
      const s = slotsRaw[i];
      if (s === null || s === undefined) {
        slots.push(null);
        continue;
      }
      if (typeof s !== "object") {
        slots.push(null);
        continue;
      }
      const rec = s as Record<string, unknown>;
      const key = rec.key;
      if (typeof key === "string" && key.length > 0) {
        sawKey = true;
        const count = rec.count;
        if (typeof count !== "number" || count <= 0) {
          slots.push(null);
          continue;
        }
        const damage = rec.damage;
        if (typeof damage === "number" && damage > 0 && Number.isFinite(damage)) {
          slots.push({ key, count, damage: Math.floor(damage) });
        } else {
          slots.push({ key, count });
        }
        continue;
      }
      const id = rec.id;
      const count = rec.count;
      if (typeof id === "number" && typeof count === "number" && id > 0 && count > 0) {
        slots.push({ id, count });
        continue;
      }
      slots.push(null);
    }
  }
  while (slots.length < sc) {
    slots.push(null);
  }
  const format: 1 | 2 = sawKey ? 2 : 1;
  return { lx, ly, format, slotCount: sc, slots };
}
