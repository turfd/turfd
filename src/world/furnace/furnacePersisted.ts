/** Furnace tile serialization (IndexedDB + network chunk tail). */

import { CHUNK_SIZE } from "../../core/constants";
import {
  clampDamageForDefinition,
  isStackBroken,
  type ItemId,
  type ItemStack,
} from "../../core/itemDefinition";
import type { ItemRegistry } from "../../items/ItemRegistry";
import { worldToLocalBlock } from "../chunk/ChunkCoord";
import {
  FURNACE_OUTPUT_SLOT_COUNT,
  type FurnaceQueueEntry,
  type FurnaceStack,
  type FurnaceTileState,
} from "./FurnaceTileState";

const MAX_ITEM_KEY_UTF8 = 120;

/** Legacy slot (numeric item id). */
export type FurnacePersistedSlotId = { id: number; count: number; damage?: number };
/** Stable slot shape (matches player inventory persistence). */
export type FurnacePersistedSlotKey = { key: string; count: number; damage?: number };

/** Slot in save/wire JSON (id until migrated, then key). */
export type FurnacePersistedSlot = FurnacePersistedSlotKey | FurnacePersistedSlotId | null;

export function isKeySlot(s: FurnacePersistedSlot): s is FurnacePersistedSlotKey {
  return s !== null && typeof (s as FurnacePersistedSlotKey).key === "string";
}

export type FurnacePersistedChunk = {
  lx: number;
  ly: number;
  /** 2 = legacy JSON/binary without per-slot damage; 3 = damage-capable. */
  format: 2 | 3;
  outputSlots: FurnacePersistedSlot[];
  fuel: FurnacePersistedSlot;
  fuelRemainingSec: number;
  cookProgressSec: number;
  queue: { smeltingRecipeId: string; batches: number }[];
  lastProcessedWorldTimeMs: number;
};

/** v1 wire/DB shape (single input/fuel/output). */
type LegacyFurnacePersistedChunk = {
  lx: number;
  ly: number;
  input: { id: number; count: number } | null;
  fuel: { id: number; count: number } | null;
  output: { id: number; count: number } | null;
  cookProgressSec: number;
  fuelRemainingSec: number;
  lastProcessedWorldTimeMs: number;
  format?: undefined;
};

/** Magic `FURN` — legacy chunk tail. */
export const FURNACE_CHUNK_MAGIC = 0x46_55_52_4e;
/** Magic `FUR2` — v2 variable-length furnace entries (4-byte slots). */
export const FURNACE_CHUNK_MAGIC_V2 = 0x32_52_55_46;
/** Magic `FUR3` — v3 entries (6-byte slots with damage). */
export const FURNACE_CHUNK_MAGIC_V3 = 0x33_52_55_46;
/** Magic `FUR4` — v4 entries (UTF-8 item keys per slot). */
export const FURNACE_CHUNK_MAGIC_V4 = 0x34_52_55_46;

/**
 * First payload byte of FURNACE_SNAPSHOT when using v3 slot encoding (not a valid chunk-local lx on its own).
 * Followed by the same bytes as a v3 chunk-tail furnace entry (lx, ly, slots, …).
 */
export const FURNACE_SNAPSHOT_V3_SENTINEL = 0xff;
/** v4 snapshot: UTF-8 key slots (same layout as v4 chunk-tail furnace entry). */
export const FURNACE_SNAPSHOT_V4_SENTINEL = 0xfc;

const MAX_QUEUE_ENTRIES = 32;
const MAX_RECIPE_ID_UTF8 = 120;

const textEnc = new TextEncoder();
const textDec = new TextDecoder();

export function furnaceStackFromPersisted(
  s: FurnacePersistedSlot,
  items: ItemRegistry,
): FurnaceStack {
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
  const d = s.damage;
  const id = s.id as ItemId;
  if (typeof d === "number" && d > 0 && Number.isFinite(d)) {
    return { itemId: id, count: s.count, damage: Math.floor(d) };
  }
  return { itemId: id, count: s.count };
}

export function furnaceStackToPersisted(s: FurnaceStack, items: ItemRegistry): FurnacePersistedSlot {
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

function emptyOutputSlotsPersisted(): FurnacePersistedSlot[] {
  return Array.from({ length: FURNACE_OUTPUT_SLOT_COUNT }, () => null);
}

export function migrateLegacyFurnacePersisted(legacy: LegacyFurnacePersistedChunk): FurnacePersistedChunk {
  const outputSlots = emptyOutputSlotsPersisted();
  let si = 0;
  const pushStack = (s: { id: number; count: number } | null): void => {
    if (s === null || s.count <= 0 || si >= FURNACE_OUTPUT_SLOT_COUNT) {
      return;
    }
    outputSlots[si++] = { id: s.id, count: s.count };
  };
  pushStack(legacy.output);
  pushStack(legacy.input);
  return {
    lx: legacy.lx,
    ly: legacy.ly,
    format: 3,
    outputSlots,
    fuel: legacy.fuel,
    fuelRemainingSec: legacy.fuelRemainingSec,
    cookProgressSec: 0,
    queue: [],
    lastProcessedWorldTimeMs: legacy.lastProcessedWorldTimeMs,
  };
}

function coerceSlot(v: unknown): FurnacePersistedSlot {
  if (v === null || typeof v !== "object") {
    return null;
  }
  const rec = v as Record<string, unknown>;
  const key = rec.key;
  if (typeof key === "string" && key.length > 0) {
    const count = rec.count;
    if (typeof count !== "number" || count <= 0) {
      return null;
    }
    const damage = rec.damage;
    if (typeof damage === "number" && damage > 0 && Number.isFinite(damage)) {
      return { key, count, damage: Math.floor(damage) };
    }
    return { key, count };
  }
  const id = rec.id;
  const count = rec.count;
  if (typeof id !== "number" || typeof count !== "number" || id <= 0 || count <= 0) {
    return null;
  }
  const damage = rec.damage;
  if (typeof damage === "number" && damage > 0 && Number.isFinite(damage)) {
    return { id, count, damage: Math.floor(damage) };
  }
  return { id, count };
}

function coerceLegacyFurnaceIdSlot(
  v: unknown,
): { id: number; count: number } | null {
  const s = coerceSlot(v);
  if (s === null || s.count <= 0) {
    return null;
  }
  if (isKeySlot(s)) {
    return null;
  }
  return { id: s.id, count: s.count };
}

/** Normalize DB/wire JSON (v1, v2, or v3) to a chunk. */
export function normalizeFurnacePersistedChunk(raw: unknown): FurnacePersistedChunk | undefined {
  if (raw === null || typeof raw !== "object") {
    return undefined;
  }
  const o = raw as Record<string, unknown>;
  const lx = o.lx;
  const ly = o.ly;
  if (typeof lx !== "number" || typeof ly !== "number") {
    return undefined;
  }
  const fmt = o.format;
  if ((fmt === 2 || fmt === 3) && Array.isArray(o.outputSlots)) {
    const slots = o.outputSlots as unknown[];
    const outputSlots = emptyOutputSlotsPersisted();
    for (let i = 0; i < FURNACE_OUTPUT_SLOT_COUNT && i < slots.length; i++) {
      const s = slots[i];
      if (s !== null && typeof s === "object") {
        outputSlots[i] = coerceSlot(s);
      }
    }
    const qRaw = o.queue;
    const queue: { smeltingRecipeId: string; batches: number }[] = [];
    if (Array.isArray(qRaw)) {
      for (const e of qRaw) {
        if (e !== null && typeof e === "object") {
          const id = (e as { smeltingRecipeId?: string }).smeltingRecipeId;
          const b = (e as { batches?: number }).batches;
          if (typeof id === "string" && typeof b === "number" && b > 0) {
            queue.push({
              smeltingRecipeId: id,
              batches: Math.min(Math.max(1, Math.floor(b)), 0xffff),
            });
          }
        }
      }
    }
    return {
      lx,
      ly,
      format: 3,
      outputSlots,
      fuel: coerceSlot(o.fuel),
      fuelRemainingSec: num(o.fuelRemainingSec),
      cookProgressSec: num(o.cookProgressSec),
      queue,
      lastProcessedWorldTimeMs: num(o.lastProcessedWorldTimeMs),
    };
  }
  if ("input" in o && "output" in o) {
    return migrateLegacyFurnacePersisted({
      lx,
      ly,
      input: coerceLegacyFurnaceIdSlot(o.input),
      fuel: coerceLegacyFurnaceIdSlot(o.fuel),
      output: coerceLegacyFurnaceIdSlot(o.output),
      cookProgressSec: num(o.cookProgressSec),
      fuelRemainingSec: num(o.fuelRemainingSec),
      lastProcessedWorldTimeMs: num(o.lastProcessedWorldTimeMs),
    });
  }
  return undefined;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export function furnaceTileToPersisted(
  wx: number,
  wy: number,
  state: FurnaceTileState,
  items: ItemRegistry,
): FurnacePersistedChunk {
  const { lx, ly } = worldToLocalBlock(wx, wy);
  const outputSlots = state.outputSlots.map((s) => furnaceStackToPersisted(s, items));
  while (outputSlots.length < FURNACE_OUTPUT_SLOT_COUNT) {
    outputSlots.push(null);
  }
  return {
    lx,
    ly,
    format: 3,
    outputSlots: outputSlots.slice(0, FURNACE_OUTPUT_SLOT_COUNT),
    fuel: furnaceStackToPersisted(state.fuel, items),
    fuelRemainingSec: state.fuelRemainingSec,
    cookProgressSec: state.cookProgressSec,
    queue: state.queue.map((e) => ({
      smeltingRecipeId: e.smeltingRecipeId,
      batches: e.batches,
    })),
    lastProcessedWorldTimeMs: state.lastProcessedWorldTimeMs,
  };
}

export function persistedToFurnaceTile(
  p: FurnacePersistedChunk,
  items: ItemRegistry,
): FurnaceTileState {
  const outputSlots: FurnaceStack[] = [];
  for (let i = 0; i < FURNACE_OUTPUT_SLOT_COUNT; i++) {
    const s = p.outputSlots[i];
    outputSlots.push(furnaceStackFromPersisted(s ?? null, items));
  }
  const queue: FurnaceQueueEntry[] = p.queue.map((e) => ({
    smeltingRecipeId: e.smeltingRecipeId,
    batches: e.batches,
  }));
  return {
    outputSlots,
    fuel: furnaceStackFromPersisted(p.fuel, items),
    fuelRemainingSec: p.fuelRemainingSec,
    cookProgressSec: p.cookProgressSec,
    queue,
    lastProcessedWorldTimeMs: p.lastProcessedWorldTimeMs,
  };
}

export function worldXYFromChunkLocal(
  cx: number,
  cy: number,
  lx: number,
  ly: number,
): { wx: number; wy: number } {
  return {
    wx: cx * CHUNK_SIZE + lx,
    wy: cy * CHUNK_SIZE + ly,
  };
}

export function parseCellKey(key: string): { wx: number; wy: number } | undefined {
  const i = key.indexOf(",");
  if (i <= 0) {
    return undefined;
  }
  const wx = Number.parseInt(key.slice(0, i), 10);
  const wy = Number.parseInt(key.slice(i + 1), 10);
  if (!Number.isFinite(wx) || !Number.isFinite(wy)) {
    return undefined;
  }
  return { wx, wy };
}

export function isCellInChunk(wx: number, wy: number, cx: number, cy: number): boolean {
  return Math.floor(wx / CHUNK_SIZE) === cx && Math.floor(wy / CHUNK_SIZE) === cy;
}

function queueWireBytes(chunk: FurnacePersistedChunk): number {
  let n = 2;
  for (const e of chunk.queue) {
    const idBytes = textEnc.encode(e.smeltingRecipeId.slice(0, MAX_RECIPE_ID_UTF8));
    const len = Math.min(idBytes.length, MAX_RECIPE_ID_UTF8);
    n += 2 + len + 2;
  }
  return n;
}

/** Binary v2 (4-byte slots). */
export function byteLengthFurnacePersistedV2(chunk: FurnacePersistedChunk): number {
  return 2 + 4 + FURNACE_OUTPUT_SLOT_COUNT * 4 + 8 + 8 + 8 + queueWireBytes(chunk);
}

/** Binary v3 (6-byte slots: id, count, damage). */
export function byteLengthFurnacePersistedV3(chunk: FurnacePersistedChunk): number {
  return 2 + 6 + FURNACE_OUTPUT_SLOT_COUNT * 6 + 8 + 8 + 8 + queueWireBytes(chunk);
}

function resolvedKeySlotForWire(slot: FurnacePersistedSlot): FurnacePersistedSlotKey | null {
  if (slot === null || slot.count <= 0) {
    return null;
  }
  if (!isKeySlot(slot)) {
    return null;
  }
  const d = slot.damage;
  if (typeof d === "number" && d > 0 && Number.isFinite(d)) {
    return { key: slot.key, count: slot.count, damage: Math.floor(d) };
  }
  return { key: slot.key, count: slot.count };
}

function byteLengthFurnaceSlotV4(slot: FurnacePersistedSlot): number {
  const k = resolvedKeySlotForWire(slot);
  if (k === null) {
    return 2;
  }
  const kb = textEnc.encode(k.key.slice(0, MAX_ITEM_KEY_UTF8));
  const len = Math.min(kb.length, MAX_ITEM_KEY_UTF8);
  return 2 + len + 2 + 2;
}

/** Binary v4 (UTF-8 item keys per slot). */
export function byteLengthFurnacePersistedV4(chunk: FurnacePersistedChunk): number {
  let n = 2;
  n += byteLengthFurnaceSlotV4(chunk.fuel);
  for (let i = 0; i < FURNACE_OUTPUT_SLOT_COUNT; i++) {
    n += byteLengthFurnaceSlotV4(chunk.outputSlots[i] ?? null);
  }
  return n + 8 + 8 + 8 + queueWireBytes(chunk);
}

function writeSlotV4(
  view: DataView,
  buffer: ArrayBuffer,
  slot: FurnacePersistedSlot,
  o: number,
): number {
  const k = resolvedKeySlotForWire(slot);
  if (k === null) {
    view.setUint16(o, 0, true);
    return o + 2;
  }
  const kb = textEnc.encode(k.key.slice(0, MAX_ITEM_KEY_UTF8));
  const len = Math.min(kb.length, MAX_ITEM_KEY_UTF8);
  view.setUint16(o, len, true);
  o += 2;
  new Uint8Array(buffer, o, len).set(kb.subarray(0, len));
  o += len;
  view.setUint16(o, k.count & 0xffff, true);
  o += 2;
  const dmg =
    typeof k.damage === "number" && k.damage > 0
      ? Math.min(0xffff, Math.floor(k.damage))
      : 0;
  view.setUint16(o, dmg, true);
  return o + 2;
}

export function writeFurnacePersistedV4ToView(
  view: DataView,
  buffer: ArrayBuffer,
  start: number,
  chunk: FurnacePersistedChunk,
): number {
  let o = start;
  view.setUint8(o++, chunk.lx & 0xff);
  view.setUint8(o++, chunk.ly & 0xff);
  o = writeSlotV4(view, buffer, chunk.fuel, o);
  for (let i = 0; i < FURNACE_OUTPUT_SLOT_COUNT; i++) {
    o = writeSlotV4(view, buffer, chunk.outputSlots[i] ?? null, o);
  }
  view.setFloat64(o, chunk.fuelRemainingSec, true);
  o += 8;
  view.setFloat64(o, chunk.cookProgressSec, true);
  o += 8;
  view.setFloat64(o, chunk.lastProcessedWorldTimeMs, true);
  o += 8;
  const q = chunk.queue.slice(0, MAX_QUEUE_ENTRIES);
  view.setUint16(o, q.length, true);
  o += 2;
  for (const e of q) {
    const idBytes = textEnc.encode(e.smeltingRecipeId.slice(0, MAX_RECIPE_ID_UTF8));
    const len = Math.min(idBytes.length, MAX_RECIPE_ID_UTF8);
    view.setUint16(o, len, true);
    o += 2;
    new Uint8Array(buffer, o, len).set(idBytes.subarray(0, len));
    o += len;
    view.setUint16(o, e.batches & 0xffff, true);
    o += 2;
  }
  return o;
}

function readSlotV4(
  view: DataView,
  buffer: ArrayBuffer,
  o: number,
  byteLength: number,
): [FurnacePersistedSlot, number] | undefined {
  if (o + 2 > byteLength) {
    return undefined;
  }
  const keyLen = view.getUint16(o, true);
  o += 2;
  if (keyLen === 0) {
    return [null, o];
  }
  if (keyLen > MAX_ITEM_KEY_UTF8 || o + keyLen + 4 > byteLength) {
    return undefined;
  }
  const key = textDec.decode(new Uint8Array(buffer, o, keyLen));
  o += keyLen;
  const count = view.getUint16(o, true);
  o += 2;
  const damage = view.getUint16(o, true);
  o += 2;
  if (key.length === 0 || count <= 0) {
    return [null, o];
  }
  if (damage > 0) {
    return [{ key, count, damage }, o];
  }
  return [{ key, count }, o];
}

export function readFurnacePersistedV4FromView(
  view: DataView,
  buffer: ArrayBuffer,
  start: number,
): [FurnacePersistedChunk, number] | undefined {
  if (start + 2 > buffer.byteLength) {
    return undefined;
  }
  const lx = view.getUint8(start);
  const ly = view.getUint8(start + 1);
  let o = start + 2;
  const bl = buffer.byteLength;
  const outputSlots = emptyOutputSlotsPersisted();
  const fuelParsed = readSlotV4(view, buffer, o, bl);
  if (fuelParsed === undefined) {
    return undefined;
  }
  let fuel: FurnacePersistedSlot;
  [fuel, o] = fuelParsed;
  for (let i = 0; i < FURNACE_OUTPUT_SLOT_COUNT; i++) {
    const parsed = readSlotV4(view, buffer, o, bl);
    if (parsed === undefined) {
      return undefined;
    }
    outputSlots[i] = parsed[0];
    o = parsed[1];
  }
  if (o + 8 + 8 + 8 + 2 > buffer.byteLength) {
    return undefined;
  }
  const fuelRemainingSec = view.getFloat64(o, true);
  o += 8;
  const cookProgressSec = view.getFloat64(o, true);
  o += 8;
  const lastProcessedWorldTimeMs = view.getFloat64(o, true);
  o += 8;
  const qParsed = readQueueFromView(view, buffer, o, buffer.byteLength);
  if (qParsed === undefined) {
    return undefined;
  }
  const [queue, endO] = qParsed;
  return [
    {
      lx,
      ly,
      format: 3,
      outputSlots,
      fuel,
      fuelRemainingSec,
      cookProgressSec,
      queue,
      lastProcessedWorldTimeMs,
    },
    endO,
  ];
}

function writeSlotV2(
  view: DataView,
  slot: FurnacePersistedSlot,
  o: number,
): number {
  const idSlot = !isKeySlot(slot) && slot !== null ? slot : null;
  if (
    idSlot === null ||
    idSlot.count <= 0 ||
    idSlot.id <= 0
  ) {
    view.setUint16(o, 0, true);
    view.setUint16(o + 2, 0, true);
  } else {
    view.setUint16(o, idSlot.id & 0xffff, true);
    view.setUint16(o + 2, idSlot.count & 0xffff, true);
  }
  return o + 4;
}

function writeSlotV3(
  view: DataView,
  slot: FurnacePersistedSlot,
  o: number,
): number {
  const idSlot = !isKeySlot(slot) && slot !== null ? slot : null;
  if (
    idSlot === null ||
    idSlot.count <= 0 ||
    idSlot.id <= 0
  ) {
    view.setUint16(o, 0, true);
    view.setUint16(o + 2, 0, true);
    view.setUint16(o + 4, 0, true);
  } else {
    view.setUint16(o, idSlot.id & 0xffff, true);
    view.setUint16(o + 2, idSlot.count & 0xffff, true);
    const dmg =
      typeof idSlot.damage === "number" && idSlot.damage > 0
        ? Math.min(0xffff, Math.floor(idSlot.damage))
        : 0;
    view.setUint16(o + 4, dmg, true);
  }
  return o + 6;
}

export function writeFurnacePersistedV2ToView(
  view: DataView,
  buffer: ArrayBuffer,
  start: number,
  chunk: FurnacePersistedChunk,
): number {
  let o = start;
  view.setUint8(o++, chunk.lx & 0xff);
  view.setUint8(o++, chunk.ly & 0xff);
  o = writeSlotV2(view, chunk.fuel, o);
  for (let i = 0; i < FURNACE_OUTPUT_SLOT_COUNT; i++) {
    o = writeSlotV2(view, chunk.outputSlots[i] ?? null, o);
  }
  view.setFloat64(o, chunk.fuelRemainingSec, true);
  o += 8;
  view.setFloat64(o, chunk.cookProgressSec, true);
  o += 8;
  view.setFloat64(o, chunk.lastProcessedWorldTimeMs, true);
  o += 8;
  const q = chunk.queue.slice(0, MAX_QUEUE_ENTRIES);
  view.setUint16(o, q.length, true);
  o += 2;
  for (const e of q) {
    const idBytes = textEnc.encode(e.smeltingRecipeId.slice(0, MAX_RECIPE_ID_UTF8));
    const len = Math.min(idBytes.length, MAX_RECIPE_ID_UTF8);
    view.setUint16(o, len, true);
    o += 2;
    new Uint8Array(buffer, o, len).set(idBytes.subarray(0, len));
    o += len;
    view.setUint16(o, e.batches & 0xffff, true);
    o += 2;
  }
  return o;
}

export function writeFurnacePersistedV3ToView(
  view: DataView,
  buffer: ArrayBuffer,
  start: number,
  chunk: FurnacePersistedChunk,
): number {
  let o = start;
  view.setUint8(o++, chunk.lx & 0xff);
  view.setUint8(o++, chunk.ly & 0xff);
  o = writeSlotV3(view, chunk.fuel, o);
  for (let i = 0; i < FURNACE_OUTPUT_SLOT_COUNT; i++) {
    o = writeSlotV3(view, chunk.outputSlots[i] ?? null, o);
  }
  view.setFloat64(o, chunk.fuelRemainingSec, true);
  o += 8;
  view.setFloat64(o, chunk.cookProgressSec, true);
  o += 8;
  view.setFloat64(o, chunk.lastProcessedWorldTimeMs, true);
  o += 8;
  const q = chunk.queue.slice(0, MAX_QUEUE_ENTRIES);
  view.setUint16(o, q.length, true);
  o += 2;
  for (const e of q) {
    const idBytes = textEnc.encode(e.smeltingRecipeId.slice(0, MAX_RECIPE_ID_UTF8));
    const len = Math.min(idBytes.length, MAX_RECIPE_ID_UTF8);
    view.setUint16(o, len, true);
    o += 2;
    new Uint8Array(buffer, o, len).set(idBytes.subarray(0, len));
    o += len;
    view.setUint16(o, e.batches & 0xffff, true);
    o += 2;
  }
  return o;
}

function readSlotV2(view: DataView, o: number): [FurnacePersistedSlot, number] {
  const id = view.getUint16(o, true);
  const count = view.getUint16(o + 2, true);
  if (id === 0 || count === 0) {
    return [null, o + 4];
  }
  return [{ id, count }, o + 4];
}

function readSlotV3(view: DataView, o: number): [FurnacePersistedSlot, number] {
  const id = view.getUint16(o, true);
  const count = view.getUint16(o + 2, true);
  const damage = view.getUint16(o + 4, true);
  if (id === 0 || count === 0) {
    return [null, o + 6];
  }
  if (damage > 0) {
    return [{ id, count, damage }, o + 6];
  }
  return [{ id, count }, o + 6];
}

function readQueueFromView(
  view: DataView,
  buffer: ArrayBuffer,
  o: number,
  byteLength: number,
): [{ smeltingRecipeId: string; batches: number }[], number] | undefined {
  if (o + 2 > byteLength) {
    return undefined;
  }
  const qLen = view.getUint16(o, true);
  o += 2;
  if (qLen > MAX_QUEUE_ENTRIES) {
    return undefined;
  }
  const queue: { smeltingRecipeId: string; batches: number }[] = [];
  for (let i = 0; i < qLen; i++) {
    if (o + 2 > byteLength) {
      return undefined;
    }
    const idLen = view.getUint16(o, true);
    o += 2;
    if (idLen > MAX_RECIPE_ID_UTF8 || o + idLen + 2 > byteLength) {
      return undefined;
    }
    const smeltingRecipeId =
      idLen > 0 ? textDec.decode(new Uint8Array(buffer, o, idLen)) : "";
    o += idLen;
    const batches = view.getUint16(o, true);
    o += 2;
    if (smeltingRecipeId !== "" && batches > 0) {
      queue.push({ smeltingRecipeId, batches });
    }
  }
  return [queue, o];
}

export function readFurnacePersistedV2FromView(
  view: DataView,
  buffer: ArrayBuffer,
  start: number,
): [FurnacePersistedChunk, number] | undefined {
  if (start + 2 > buffer.byteLength) {
    return undefined;
  }
  const lx = view.getUint8(start);
  const ly = view.getUint8(start + 1);
  let o = start + 2;
  const outputSlots = emptyOutputSlotsPersisted();
  let fuel: FurnacePersistedSlot;
  [fuel, o] = readSlotV2(view, o);
  for (let i = 0; i < FURNACE_OUTPUT_SLOT_COUNT; i++) {
    const [s, no] = readSlotV2(view, o);
    outputSlots[i] = s;
    o = no;
  }
  if (o + 8 + 8 + 8 + 2 > buffer.byteLength) {
    return undefined;
  }
  const fuelRemainingSec = view.getFloat64(o, true);
  o += 8;
  const cookProgressSec = view.getFloat64(o, true);
  o += 8;
  const lastProcessedWorldTimeMs = view.getFloat64(o, true);
  o += 8;
  const qParsed = readQueueFromView(view, buffer, o, buffer.byteLength);
  if (qParsed === undefined) {
    return undefined;
  }
  const [queue, endO] = qParsed;
  return [
    {
      lx,
      ly,
      format: 3,
      outputSlots,
      fuel,
      fuelRemainingSec,
      cookProgressSec,
      queue,
      lastProcessedWorldTimeMs,
    },
    endO,
  ];
}

export function readFurnacePersistedV3FromView(
  view: DataView,
  buffer: ArrayBuffer,
  start: number,
): [FurnacePersistedChunk, number] | undefined {
  if (start + 2 > buffer.byteLength) {
    return undefined;
  }
  const lx = view.getUint8(start);
  const ly = view.getUint8(start + 1);
  let o = start + 2;
  const outputSlots = emptyOutputSlotsPersisted();
  let fuel: FurnacePersistedSlot;
  [fuel, o] = readSlotV3(view, o);
  for (let i = 0; i < FURNACE_OUTPUT_SLOT_COUNT; i++) {
    const [s, no] = readSlotV3(view, o);
    outputSlots[i] = s;
    o = no;
  }
  if (o + 8 + 8 + 8 + 2 > buffer.byteLength) {
    return undefined;
  }
  const fuelRemainingSec = view.getFloat64(o, true);
  o += 8;
  const cookProgressSec = view.getFloat64(o, true);
  o += 8;
  const lastProcessedWorldTimeMs = view.getFloat64(o, true);
  o += 8;
  const qParsed = readQueueFromView(view, buffer, o, buffer.byteLength);
  if (qParsed === undefined) {
    return undefined;
  }
  const [queue, endO] = qParsed;
  return [
    {
      lx,
      ly,
      format: 3,
      outputSlots,
      fuel,
      fuelRemainingSec,
      cookProgressSec,
      queue,
      lastProcessedWorldTimeMs,
    },
    endO,
  ];
}

/** Bytes after lx,ly in legacy wire format (3 slots + 3×f64). */
export const FURNACE_LEGACY_ENTRY_BODY_BYTES = 36;

/** Read legacy payload starting at first slot byte (after lx, ly). */
export function readLegacyFurnaceEntry(
  view: DataView,
  o: number,
  lx: number,
  ly: number,
): [FurnacePersistedChunk, number] {
  const input = readSlotV2(view, o);
  o = input[1];
  const fuel = readSlotV2(view, o);
  o = fuel[1];
  const output = readSlotV2(view, o);
  o = output[1];
  const cookProgressSec = view.getFloat64(o, true);
  o += 8;
  const fuelRemainingSec = view.getFloat64(o, true);
  o += 8;
  const lastProcessedWorldTimeMs = view.getFloat64(o, true);
  o += 8;
  const migrated = migrateLegacyFurnacePersisted({
    lx,
    ly,
    input: input[0] as { id: number; count: number } | null,
    fuel: fuel[0] as { id: number; count: number } | null,
    output: output[0] as { id: number; count: number } | null,
    cookProgressSec,
    fuelRemainingSec,
    lastProcessedWorldTimeMs,
  });
  return [migrated, o];
}
