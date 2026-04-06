/** Binary network protocol: message IDs, typed payloads, and DataView encode/decode (no JSON on the wire). */

import {
  BinarySerializer,
  type WorldSyncWirePayload,
  type ChunkDataWirePayload,
  type BlockUpdateWirePayload,
} from "./BinarySerializer";
import type { WorkshopModRef } from "../../persistence/IndexedDBStore";
import type { FurnacePersistedChunk } from "../../world/furnace/furnacePersisted";
import type { ChestPersistedChunk } from "../../world/chest/chestPersisted";

/** Message type IDs for the binary network protocol (first byte of every packet). */
export enum MessageType {
  HANDSHAKE = 0,
  CHUNK_DATA = 1,
  BLOCK_UPDATE = 2,
  PLAYER_STATE = 3,
  CHAT = 4,
  PING = 5,
  ENTITY_SPAWN = 6,
  ENTITY_DESPAWN = 7,
  WORLD_SYNC = 8,
  WORLD_TIME = 0x09,
  /** Host ended the session; client should show `reason` and return to menu. */
  SESSION_ENDED = 0x0a,
  /** Host-only line; gray/system styling on clients. */
  SYSTEM_MESSAGE = 0x0b,
  /**
   * Host → clients: another peer’s pose (star topology). Subject is the moving player’s PeerJS id.
   */
  PLAYER_STATE_RELAY = 0x0c,
  /** Host → client: ordered behavior + world resource pack refs (join / protocol v4). */
  PACK_STACK = 0x0d,
  /** Host or peer: authoritative furnace tile at world cell. */
  FURNACE_SNAPSHOT = 0x0e,
  /** Host or peer: authoritative chest tile at anchor world cell. */
  CHEST_SNAPSHOT = 0x0f,
  /**
   * Mining crack overlay: variant byte 0 = implicit subject (client→host); 1 = explicit
   * `subjectPeerId` (host→all). `crackStageEncoded` 0 = clear, 1–10 = destroy stage 0–9.
   */
  BLOCK_BREAK_PROGRESS = 0x10,
  /** Host → one client: grant items into that client’s inventory (OP /give). */
  GIVE_ITEM_STACK = 0x11,
  /** Host → one client: authoritative feet spawn (rejoin / saved logout position). */
  ASSIGNED_SPAWN = 0x12,
}

/** Back-compat alias used across the codebase. */
export { MessageType as MsgType };

export interface HandshakeMessage {
  type: MessageType.HANDSHAKE;
  version: number;
  peerId: string;
  displayName: string;
  accountId: string;
}

export type ChunkDataMsg = {
  type: MessageType.CHUNK_DATA;
  cx: number;
  cy: number;
  blocks: Uint16Array;
  /** Back-wall layer; omitted on legacy decode → treat as zeros. */
  background?: Uint16Array;
  /** Furnace tiles in chunk; omitted when absent on wire. */
  furnaces?: FurnacePersistedChunk[];
  /** Chest anchors in chunk; omitted when absent on wire. */
  chests?: ChestPersistedChunk[];
  /** Per-cell flags (e.g. tree no-collision); v10+ wire tail; omitted → client zeros metadata. */
  metadata?: Uint8Array;
};

export type WorldSyncMsg = {
  type: MessageType.WORLD_SYNC;
  seed: number;
  worldTimeMs: number;
};

export type WorldTimeMsg = {
  type: MessageType.WORLD_TIME;
  worldTimeMs: number;
};

export type PackStackMsg = {
  type: MessageType.PACK_STACK;
  behaviorRefs: WorkshopModRef[];
  resourceRefs: WorkshopModRef[];
  requirePacksBeforeJoin: boolean;
};

export type FurnaceSnapshotMsg = {
  type: MessageType.FURNACE_SNAPSHOT;
  wx: number;
  wy: number;
  data: FurnacePersistedChunk;
};

export type ChestSnapshotMsg = {
  type: MessageType.CHEST_SNAPSHOT;
  wx: number;
  wy: number;
  data: ChestPersistedChunk;
};

/** Client → host: subject is the connection’s peer id. */
export type BlockBreakProgressImplicitMsg = {
  type: MessageType.BLOCK_BREAK_PROGRESS;
  mode: "implicit";
  wx: number;
  wy: number;
  /** 0 = foreground, 1 = background. */
  layer: 0 | 1;
  /** 0 = not mining; 1–10 = destroy stage index + 1. */
  crackStageEncoded: number;
};

/** Host → clients: which peer is mining. */
export type BlockBreakProgressRelayMsg = {
  type: MessageType.BLOCK_BREAK_PROGRESS;
  mode: "relay";
  subjectPeerId: string;
  wx: number;
  wy: number;
  layer: 0 | 1;
  crackStageEncoded: number;
};

export type BlockBreakProgressMsg =
  | BlockBreakProgressImplicitMsg
  | BlockBreakProgressRelayMsg;

export type SessionEndedMsg = {
  type: MessageType.SESSION_ENDED;
  reason: string;
};

export type BlockUpdateMsg = {
  type: MessageType.BLOCK_UPDATE;
  x: number;
  y: number;
  blockId: number;
  /** 0 = foreground, 1 = background. */
  layer?: number;
  /** v9+ 14-byte wire; omitted when decoding legacy packets. */
  previousBlockId?: number;
  /** v11+ 15-byte wire; foreground per-cell flags (e.g. tree no-collision). */
  cellMetadata?: number;
};

/** Player state on the wire; includes numeric player id and facing for physics sync. */
export type PlayerStateMsg = {
  type: MessageType.PLAYER_STATE;
  playerId: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  facingRight: boolean;
  /** Selected hotbar index [0, HOTBAR_SIZE). */
  hotbarSlot: number;
  /** Item id in that slot, or `0` when empty. */
  heldItemId: number;
  /** True while mining a block or during hand-use swing (matches local body + held break pose). */
  miningVisual: boolean;
};

/** Host-forwarded client pose so joiners and other clients attribute it to `subjectPeerId`. */
export type PlayerStateRelayMsg = {
  type: MessageType.PLAYER_STATE_RELAY;
  subjectPeerId: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  facingRight: boolean;
  hotbarSlot: number;
  heldItemId: number;
  miningVisual: boolean;
};

export type EntitySpawnMsg = {
  type: MessageType.ENTITY_SPAWN;
  entityId: number;
  entityType: number;
  x: number;
  y: number;
};

export type EntityDespawnMsg = {
  type: MessageType.ENTITY_DESPAWN;
  entityId: number;
};

export type ChatMsg = {
  type: MessageType.CHAT;
  fromPeerId: string;
  text: string;
};

export type SystemMessageMsg = {
  type: MessageType.SYSTEM_MESSAGE;
  text: string;
};

export type PingMsg = {
  type: MessageType.PING;
  timestamp: number;
};

export type GiveItemStackMsg = {
  type: MessageType.GIVE_ITEM_STACK;
  itemId: number;
  count: number;
};

export type AssignedSpawnMsg = {
  type: MessageType.ASSIGNED_SPAWN;
  x: number;
  y: number;
};

/** Wire: type byte + two float64 (17 bytes). */
export const ASSIGNED_SPAWN_WIRE_BYTE_LENGTH = 17;

export type NetworkMessage =
  | HandshakeMessage
  | ChunkDataMsg
  | BlockUpdateMsg
  | PlayerStateMsg
  | PlayerStateRelayMsg
  | EntitySpawnMsg
  | EntityDespawnMsg
  | ChatMsg
  | SystemMessageMsg
  | PingMsg
  | GiveItemStackMsg
  | AssignedSpawnMsg
  | WorldSyncMsg
  | WorldTimeMsg
  | SessionEndedMsg
  | PackStackMsg
  | FurnaceSnapshotMsg
  | ChestSnapshotMsg
  | BlockBreakProgressMsg;

const LE = true;

const BLOCK_BREAK_MODE_IMPLICIT = 0;
const BLOCK_BREAK_MODE_RELAY = 1;
const BLOCK_BREAK_IMPLICIT_WIRE_BYTES = 12;
const textEnc = new TextEncoder();
const textDec = new TextDecoder();

/** Max UTF-8 bytes for CHAT sender peer id and message body. */
const CHAT_PEER_ID_MAX = 512;
const CHAT_TEXT_MAX = 1024;

const PACK_STACK_MAX_REFS_PER_LIST = 48;
const PACK_STACK_STR_MAX = 256;

function encodePackStackRefs(refs: readonly WorkshopModRef[]): Uint8Array[] {
  const parts: Uint8Array[] = [];
  for (const r of refs) {
    let rid = textEnc.encode(r.recordId);
    let mid = textEnc.encode(r.modId);
    let ver = textEnc.encode(r.version);
    if (rid.length > PACK_STACK_STR_MAX) {
      rid = rid.slice(0, PACK_STACK_STR_MAX);
    }
    if (mid.length > PACK_STACK_STR_MAX) {
      mid = mid.slice(0, PACK_STACK_STR_MAX);
    }
    if (ver.length > PACK_STACK_STR_MAX) {
      ver = ver.slice(0, PACK_STACK_STR_MAX);
    }
    const h = new ArrayBuffer(2 + 2 + 2);
    const hv = new DataView(h);
    hv.setUint16(0, rid.length, LE);
    hv.setUint16(2, mid.length, LE);
    hv.setUint16(4, ver.length, LE);
    parts.push(new Uint8Array(h));
    parts.push(rid);
    parts.push(mid);
    parts.push(ver);
  }
  return parts;
}

function packStackRefsWireSize(refs: readonly WorkshopModRef[]): number {
  let n = 0;
  for (const r of refs) {
    const rl = Math.min(textEnc.encode(r.recordId).length, PACK_STACK_STR_MAX);
    const ml = Math.min(textEnc.encode(r.modId).length, PACK_STACK_STR_MAX);
    const vl = Math.min(textEnc.encode(r.version).length, PACK_STACK_STR_MAX);
    n += 6 + rl + ml + vl;
  }
  return n;
}

function decodePackStackRefs(
  view: DataView,
  buf: ArrayBuffer,
  start: number,
  count: number,
): { refs: WorkshopModRef[]; nextOffset: number } {
  const refs: WorkshopModRef[] = [];
  let o = start;
  for (let i = 0; i < count; i++) {
    if (o + 6 > buf.byteLength) {
      throw new Error("PACK_STACK: truncated ref header");
    }
    const rl = view.getUint16(o, LE);
    const ml = view.getUint16(o + 2, LE);
    const vl = view.getUint16(o + 4, LE);
    o += 6;
    if (rl > PACK_STACK_STR_MAX || ml > PACK_STACK_STR_MAX || vl > PACK_STACK_STR_MAX) {
      throw new Error("PACK_STACK: string too long");
    }
    if (o + rl + ml + vl > buf.byteLength) {
      throw new Error("PACK_STACK: truncated strings");
    }
    const recordId = textDec.decode(new Uint8Array(buf, o, rl));
    o += rl;
    const modId = textDec.decode(new Uint8Array(buf, o, ml));
    o += ml;
    const version = textDec.decode(new Uint8Array(buf, o, vl));
    o += vl;
    refs.push({ recordId, modId, version });
  }
  return { refs, nextOffset: o };
}

/** Wire size of a `PLAYER_STATE` packet (type byte + payload). */
export const PLAYER_STATE_WIRE_BYTE_LENGTH = 40;

/** `poseFlags` in {@link writePlayerStateWire} — bit 0 = mining / hand-swing visual. */
export const PLAYER_STATE_FLAG_MINING_VISUAL = 1;

/** Writes `PLAYER_STATE` layout into `view` (byte length {@link PLAYER_STATE_WIRE_BYTE_LENGTH}). */
export function writePlayerStateWire(
  view: DataView,
  playerId: number,
  x: number,
  y: number,
  vx: number,
  vy: number,
  facingRight: boolean,
  hotbarSlot: number,
  heldItemId: number,
  miningVisual: boolean,
): void {
  view.setUint8(0, MessageType.PLAYER_STATE);
  view.setUint16(1, playerId, LE);
  view.setFloat64(3, x, LE);
  view.setFloat64(11, y, LE);
  view.setFloat64(19, vx, LE);
  view.setFloat64(27, vy, LE);
  view.setUint8(35, facingRight ? 1 : 0);
  view.setUint8(36, hotbarSlot & 0xff);
  view.setUint16(37, heldItemId & 0xffff, LE);
  view.setUint8(
    39,
    miningVisual ? PLAYER_STATE_FLAG_MINING_VISUAL : 0,
  );
}

export function encode(msg: NetworkMessage): ArrayBuffer {
  switch (msg.type) {
    case MessageType.HANDSHAKE:
      return BinarySerializer.serializeHandshake({
        version: msg.version,
        peerId: msg.peerId,
        displayName: msg.displayName,
        accountId: msg.accountId,
      });

    case MessageType.CHUNK_DATA: {
      const bg =
        msg.background ??
        new Uint16Array(msg.blocks.length);
      return BinarySerializer.serializeChunk(
        msg.cx,
        msg.cy,
        msg.blocks,
        bg,
        msg.furnaces,
        msg.chests,
        msg.metadata,
      );
    }

    case MessageType.FURNACE_SNAPSHOT:
      return BinarySerializer.serializeFurnaceSnapshot(msg.wx, msg.wy, msg.data);

    case MessageType.CHEST_SNAPSHOT:
      return BinarySerializer.serializeChestSnapshot(msg.wx, msg.wy, msg.data);

    case MessageType.BLOCK_UPDATE: {
      return BinarySerializer.serializeBlockUpdate(
        msg.x,
        msg.y,
        msg.blockId,
        msg.layer ?? 0,
        msg.previousBlockId,
        msg.cellMetadata ?? 0,
      );
    }

    case MessageType.PLAYER_STATE: {
      const buf = new ArrayBuffer(PLAYER_STATE_WIRE_BYTE_LENGTH);
      writePlayerStateWire(
        new DataView(buf),
        msg.playerId,
        msg.x,
        msg.y,
        msg.vx,
        msg.vy,
        msg.facingRight,
        msg.hotbarSlot,
        msg.heldItemId,
        msg.miningVisual,
      );
      return buf;
    }

    case MessageType.ENTITY_SPAWN: {
      const buf = new ArrayBuffer(23);
      const v = new DataView(buf);
      v.setUint8(0, MessageType.ENTITY_SPAWN);
      v.setUint32(1, msg.entityId, LE);
      v.setUint16(5, msg.entityType, LE);
      v.setFloat64(7, msg.x, LE);
      v.setFloat64(15, msg.y, LE);
      return buf;
    }

    case MessageType.ENTITY_DESPAWN: {
      const buf = new ArrayBuffer(5);
      const v = new DataView(buf);
      v.setUint8(0, MessageType.ENTITY_DESPAWN);
      v.setUint32(1, msg.entityId, LE);
      return buf;
    }

    case MessageType.CHAT: {
      let peerB = textEnc.encode(msg.fromPeerId);
      if (peerB.length > CHAT_PEER_ID_MAX) {
        peerB = peerB.slice(0, CHAT_PEER_ID_MAX);
      }
      let textB = textEnc.encode(msg.text);
      if (textB.length > CHAT_TEXT_MAX) {
        textB = textB.slice(0, CHAT_TEXT_MAX);
      }
      const buf = new ArrayBuffer(1 + 2 + peerB.length + 2 + textB.length);
      const v = new DataView(buf);
      v.setUint8(0, MessageType.CHAT);
      v.setUint16(1, peerB.length, LE);
      new Uint8Array(buf, 3, peerB.length).set(peerB);
      v.setUint16(3 + peerB.length, textB.length, LE);
      new Uint8Array(buf, 5 + peerB.length, textB.length).set(textB);
      return buf;
    }

    case MessageType.SYSTEM_MESSAGE: {
      let enc = textEnc.encode(msg.text);
      if (enc.byteLength > 65_000) {
        throw new Error("SYSTEM_MESSAGE: text too long");
      }
      const buf = new ArrayBuffer(3 + enc.byteLength);
      const v = new DataView(buf);
      v.setUint8(0, MessageType.SYSTEM_MESSAGE);
      v.setUint16(1, enc.byteLength, LE);
      new Uint8Array(buf, 3).set(enc);
      return buf;
    }

    case MessageType.PING: {
      const buf = new ArrayBuffer(9);
      const v = new DataView(buf);
      v.setUint8(0, MessageType.PING);
      v.setFloat64(1, msg.timestamp, LE);
      return buf;
    }

    case MessageType.GIVE_ITEM_STACK: {
      const buf = new ArrayBuffer(9);
      const v = new DataView(buf);
      v.setUint8(0, MessageType.GIVE_ITEM_STACK);
      v.setUint32(1, msg.itemId >>> 0, LE);
      v.setUint32(5, msg.count >>> 0, LE);
      return buf;
    }

    case MessageType.ASSIGNED_SPAWN: {
      const buf = new ArrayBuffer(ASSIGNED_SPAWN_WIRE_BYTE_LENGTH);
      const v = new DataView(buf);
      v.setUint8(0, MessageType.ASSIGNED_SPAWN);
      v.setFloat64(1, msg.x, LE);
      v.setFloat64(9, msg.y, LE);
      return buf;
    }

    case MessageType.WORLD_SYNC: {
      return BinarySerializer.serializeWorldSync(msg.seed, msg.worldTimeMs);
    }

    case MessageType.PACK_STACK: {
      const bh = Math.min(
        msg.behaviorRefs.length,
        PACK_STACK_MAX_REFS_PER_LIST,
      );
      const rh = Math.min(
        msg.resourceRefs.length,
        PACK_STACK_MAX_REFS_PER_LIST,
      );
      const brefs = msg.behaviorRefs.slice(0, bh);
      const rrefs = msg.resourceRefs.slice(0, rh);
      const flags = msg.requirePacksBeforeJoin ? 1 : 0;
      const body =
        1 +
        1 +
        2 +
        2 +
        packStackRefsWireSize(brefs) +
        packStackRefsWireSize(rrefs);
      const buf = new ArrayBuffer(body);
      const view = new DataView(buf);
      let o = 0;
      view.setUint8(o++, MessageType.PACK_STACK);
      view.setUint8(o++, flags);
      view.setUint16(o, bh, LE);
      o += 2;
      view.setUint16(o, rh, LE);
      o += 2;
      const u8 = new Uint8Array(buf);
      for (const part of encodePackStackRefs(brefs)) {
        u8.set(part, o);
        o += part.length;
      }
      for (const part of encodePackStackRefs(rrefs)) {
        u8.set(part, o);
        o += part.length;
      }
      return buf;
    }

    case MessageType.WORLD_TIME: {
      const buf = new ArrayBuffer(9);
      const view = new DataView(buf);
      view.setUint8(0, MessageType.WORLD_TIME);
      view.setFloat64(1, msg.worldTimeMs, LE);
      return buf;
    }

    case MessageType.SESSION_ENDED: {
      const encoded = textEnc.encode(msg.reason);
      if (encoded.byteLength > 65_000) {
        throw new Error("SESSION_ENDED: reason too long");
      }
      const buf = new ArrayBuffer(3 + encoded.byteLength);
      const view = new DataView(buf);
      view.setUint8(0, MessageType.SESSION_ENDED);
      view.setUint16(1, encoded.byteLength, LE);
      new Uint8Array(buf).set(encoded, 3);
      return buf;
    }

    case MessageType.PLAYER_STATE_RELAY: {
      const sid = textEnc.encode(msg.subjectPeerId);
      if (sid.byteLength > CHAT_PEER_ID_MAX) {
        throw new Error("PLAYER_STATE_RELAY: subjectPeerId too long");
      }
      const buf = new ArrayBuffer(1 + 2 + sid.byteLength + 32 + 1 + 4);
      const view = new DataView(buf);
      let o = 0;
      view.setUint8(o++, MessageType.PLAYER_STATE_RELAY);
      view.setUint16(o, sid.byteLength, LE);
      o += 2;
      new Uint8Array(buf, o, sid.byteLength).set(sid);
      o += sid.byteLength;
      view.setFloat64(o, msg.x, LE);
      o += 8;
      view.setFloat64(o, msg.y, LE);
      o += 8;
      view.setFloat64(o, msg.vx, LE);
      o += 8;
      view.setFloat64(o, msg.vy, LE);
      o += 8;
      view.setUint8(o++, msg.facingRight ? 1 : 0);
      view.setUint8(o++, msg.hotbarSlot & 0xff);
      view.setUint16(o, msg.heldItemId & 0xffff, LE);
      o += 2;
      view.setUint8(
        o,
        msg.miningVisual ? PLAYER_STATE_FLAG_MINING_VISUAL : 0,
      );
      return buf;
    }

    case MessageType.BLOCK_BREAK_PROGRESS: {
      if (msg.mode === "implicit") {
        const buf = new ArrayBuffer(BLOCK_BREAK_IMPLICIT_WIRE_BYTES);
        const view = new DataView(buf);
        view.setUint8(0, MessageType.BLOCK_BREAK_PROGRESS);
        view.setUint8(1, BLOCK_BREAK_MODE_IMPLICIT);
        view.setInt32(2, msg.wx, LE);
        view.setInt32(6, msg.wy, LE);
        view.setUint8(10, msg.layer);
        view.setUint8(11, msg.crackStageEncoded);
        return buf;
      }
      const sid = textEnc.encode(msg.subjectPeerId);
      if (sid.byteLength > CHAT_PEER_ID_MAX) {
        throw new Error("BLOCK_BREAK_PROGRESS: subjectPeerId too long");
      }
      const buf = new ArrayBuffer(2 + 2 + sid.byteLength + 4 + 4 + 1 + 1);
      const view = new DataView(buf);
      let o = 0;
      view.setUint8(o++, MessageType.BLOCK_BREAK_PROGRESS);
      view.setUint8(o++, BLOCK_BREAK_MODE_RELAY);
      view.setUint16(o, sid.byteLength, LE);
      o += 2;
      new Uint8Array(buf, o, sid.byteLength).set(sid);
      o += sid.byteLength;
      view.setInt32(o, msg.wx, LE);
      o += 4;
      view.setInt32(o, msg.wy, LE);
      o += 4;
      view.setUint8(o++, msg.layer);
      view.setUint8(o, msg.crackStageEncoded);
      return buf;
    }
  }
}

export function decode(buf: ArrayBuffer): NetworkMessage {
  const v = new DataView(buf);
  const typeByte = v.getUint8(0);

  switch (typeByte) {
    case MessageType.HANDSHAKE: {
      const p = BinarySerializer.deserializeHandshake(buf);
      return {
        type: MessageType.HANDSHAKE,
        version: p.version,
        peerId: p.peerId,
        displayName: p.displayName,
        accountId: p.accountId,
      };
    }

    case MessageType.CHUNK_DATA: {
      const payload: ChunkDataWirePayload = BinarySerializer.deserializeChunk(buf);
      const out: ChunkDataMsg = {
        type: MessageType.CHUNK_DATA,
        cx: payload.chunkX,
        cy: payload.chunkY,
        blocks: payload.blocks,
      };
      if (payload.background !== undefined) {
        out.background = payload.background;
      }
      if (payload.furnaces !== undefined) {
        out.furnaces = payload.furnaces;
      }
      if (payload.chests !== undefined) {
        out.chests = payload.chests;
      }
      if (payload.metadata !== undefined) {
        out.metadata = payload.metadata;
      }
      return out;
    }

    case MessageType.FURNACE_SNAPSHOT: {
      const p = BinarySerializer.deserializeFurnaceSnapshot(buf);
      return {
        type: MessageType.FURNACE_SNAPSHOT,
        wx: p.wx,
        wy: p.wy,
        data: p.data,
      };
    }

    case MessageType.CHEST_SNAPSHOT: {
      const p = BinarySerializer.deserializeChestSnapshot(buf);
      return {
        type: MessageType.CHEST_SNAPSHOT,
        wx: p.wx,
        wy: p.wy,
        data: p.data,
      };
    }

    case MessageType.BLOCK_UPDATE: {
      const payload: BlockUpdateWirePayload =
        BinarySerializer.deserializeBlockUpdate(buf);
      return {
        type: MessageType.BLOCK_UPDATE,
        x: payload.x,
        y: payload.y,
        blockId: payload.blockId,
        layer: payload.layer,
        previousBlockId: payload.previousBlockId,
        cellMetadata: payload.cellMetadata,
      };
    }

    case MessageType.PLAYER_STATE: {
      let hotbarSlot = 0;
      let heldItemId = 0;
      let miningVisual = false;
      if (v.byteLength >= 40) {
        hotbarSlot = v.getUint8(36);
        heldItemId = v.getUint16(37, LE);
        miningVisual =
          (v.getUint8(39) & PLAYER_STATE_FLAG_MINING_VISUAL) !== 0;
      }
      return {
        type: MessageType.PLAYER_STATE,
        playerId: v.getUint16(1, LE),
        x: v.getFloat64(3, LE),
        y: v.getFloat64(11, LE),
        vx: v.getFloat64(19, LE),
        vy: v.getFloat64(27, LE),
        facingRight: v.getUint8(35) !== 0,
        hotbarSlot,
        heldItemId,
        miningVisual,
      };
    }

    case MessageType.ENTITY_SPAWN:
      return {
        type: MessageType.ENTITY_SPAWN,
        entityId: v.getUint32(1, LE),
        entityType: v.getUint16(5, LE),
        x: v.getFloat64(7, LE),
        y: v.getFloat64(15, LE),
      };

    case MessageType.ENTITY_DESPAWN:
      return {
        type: MessageType.ENTITY_DESPAWN,
        entityId: v.getUint32(1, LE),
      };

    case MessageType.CHAT: {
      if (v.byteLength < 5) {
        throw new Error("CHAT: buffer too short");
      }
      const peerLen = v.getUint16(1, LE);
      if (peerLen > CHAT_PEER_ID_MAX || v.byteLength < 3 + peerLen + 2) {
        throw new Error("CHAT: invalid peer length");
      }
      const fromPeerId = textDec.decode(new Uint8Array(buf, 3, peerLen));
      const textLen = v.getUint16(3 + peerLen, LE);
      if (textLen > CHAT_TEXT_MAX || v.byteLength < 5 + peerLen + textLen) {
        throw new Error("CHAT: invalid text length");
      }
      const text = textDec.decode(
        new Uint8Array(buf, 5 + peerLen, textLen),
      );
      return {
        type: MessageType.CHAT,
        fromPeerId,
        text,
      };
    }

    case MessageType.SYSTEM_MESSAGE: {
      if (v.byteLength < 3) {
        throw new Error("SYSTEM_MESSAGE: buffer too short");
      }
      const slen = v.getUint16(1, LE);
      if (v.byteLength < 3 + slen) {
        throw new Error("SYSTEM_MESSAGE: truncated");
      }
      return {
        type: MessageType.SYSTEM_MESSAGE,
        text: textDec.decode(new Uint8Array(buf, 3, slen)),
      };
    }

    case MessageType.PING:
      return {
        type: MessageType.PING,
        timestamp: v.getFloat64(1, LE),
      };

    case MessageType.GIVE_ITEM_STACK: {
      if (v.byteLength < 9) {
        throw new Error("GIVE_ITEM_STACK: buffer too short");
      }
      return {
        type: MessageType.GIVE_ITEM_STACK,
        itemId: v.getUint32(1, LE),
        count: v.getUint32(5, LE),
      };
    }

    case MessageType.ASSIGNED_SPAWN: {
      if (v.byteLength < ASSIGNED_SPAWN_WIRE_BYTE_LENGTH) {
        throw new Error("ASSIGNED_SPAWN: buffer too short");
      }
      return {
        type: MessageType.ASSIGNED_SPAWN,
        x: v.getFloat64(1, LE),
        y: v.getFloat64(9, LE),
      };
    }

    case MessageType.WORLD_SYNC: {
      const payload: WorldSyncWirePayload = BinarySerializer.deserializeWorldSync(
        buf,
      );
      return {
        type: MessageType.WORLD_SYNC,
        seed: payload.seed,
        worldTimeMs: payload.worldTimeMs,
      };
    }

    case MessageType.PACK_STACK: {
      if (v.byteLength < 6) {
        throw new Error("PACK_STACK: buffer too short");
      }
      const flags = v.getUint8(1);
      const bc = v.getUint16(2, LE);
      const rc = v.getUint16(4, LE);
      if (bc > PACK_STACK_MAX_REFS_PER_LIST || rc > PACK_STACK_MAX_REFS_PER_LIST) {
        throw new Error("PACK_STACK: ref count too large");
      }
      const { refs: behaviorRefs, nextOffset: o1 } = decodePackStackRefs(
        v,
        buf,
        6,
        bc,
      );
      const { refs: resourceRefs } = decodePackStackRefs(v, buf, o1, rc);
      return {
        type: MessageType.PACK_STACK,
        behaviorRefs,
        resourceRefs,
        requirePacksBeforeJoin: (flags & 1) !== 0,
      };
    }

    case MessageType.WORLD_TIME: {
      if (v.byteLength < 9) {
        throw new Error("WORLD_TIME: buffer too short");
      }
      return {
        type: MessageType.WORLD_TIME,
        worldTimeMs: v.getFloat64(1, LE),
      };
    }

    case MessageType.SESSION_ENDED: {
      if (v.byteLength < 3) {
        throw new Error("SESSION_ENDED: buffer too short");
      }
      const reasonLen = v.getUint16(1, LE);
      if (v.byteLength < 3 + reasonLen) {
        throw new Error("SESSION_ENDED: truncated reason");
      }
      return {
        type: MessageType.SESSION_ENDED,
        reason: textDec.decode(new Uint8Array(buf, 3, reasonLen)),
      };
    }

    case MessageType.PLAYER_STATE_RELAY: {
      if (v.byteLength < 3) {
        throw new Error("PLAYER_STATE_RELAY: buffer too short");
      }
      const slen = v.getUint16(1, LE);
      if (slen > CHAT_PEER_ID_MAX || v.byteLength < 3 + slen + 32 + 1) {
        throw new Error("PLAYER_STATE_RELAY: invalid layout");
      }
      const subjectPeerId = textDec.decode(new Uint8Array(buf, 3, slen));
      let o = 3 + slen;
      const x = v.getFloat64(o, LE);
      o += 8;
      const y = v.getFloat64(o, LE);
      o += 8;
      const vx = v.getFloat64(o, LE);
      o += 8;
      const vy = v.getFloat64(o, LE);
      o += 8;
      const facingRight = v.getUint8(o) !== 0;
      o += 1;
      let hotbarSlot = 0;
      let heldItemId = 0;
      let miningVisual = false;
      if (v.byteLength >= o + 4) {
        hotbarSlot = v.getUint8(o);
        o += 1;
        heldItemId = v.getUint16(o, LE);
        o += 2;
        miningVisual =
          (v.getUint8(o) & PLAYER_STATE_FLAG_MINING_VISUAL) !== 0;
      }
      return {
        type: MessageType.PLAYER_STATE_RELAY,
        subjectPeerId,
        x,
        y,
        vx,
        vy,
        facingRight,
        hotbarSlot,
        heldItemId,
        miningVisual,
      };
    }

    case MessageType.BLOCK_BREAK_PROGRESS: {
      if (v.byteLength < 2) {
        throw new Error("BLOCK_BREAK_PROGRESS: buffer too short");
      }
      const breakMode = v.getUint8(1);
      if (breakMode === BLOCK_BREAK_MODE_IMPLICIT) {
        if (v.byteLength < BLOCK_BREAK_IMPLICIT_WIRE_BYTES) {
          throw new Error("BLOCK_BREAK_PROGRESS: implicit truncated");
        }
        return {
          type: MessageType.BLOCK_BREAK_PROGRESS,
          mode: "implicit",
          wx: v.getInt32(2, LE),
          wy: v.getInt32(6, LE),
          layer: v.getUint8(10) === 1 ? 1 : 0,
          crackStageEncoded: v.getUint8(11),
        };
      }
      if (breakMode !== BLOCK_BREAK_MODE_RELAY) {
        throw new Error("BLOCK_BREAK_PROGRESS: unknown mode");
      }
      if (v.byteLength < 4) {
        throw new Error("BLOCK_BREAK_PROGRESS: relay truncated");
      }
      const rlen = v.getUint16(2, LE);
      if (rlen > CHAT_PEER_ID_MAX || v.byteLength < 4 + rlen + 4 + 4 + 1 + 1) {
        throw new Error("BLOCK_BREAK_PROGRESS: relay invalid layout");
      }
      const subjectPeerId = textDec.decode(new Uint8Array(buf, 4, rlen));
      let bo = 4 + rlen;
      const wx = v.getInt32(bo, LE);
      bo += 4;
      const wy = v.getInt32(bo, LE);
      bo += 4;
      const layer = v.getUint8(bo++) === 1 ? 1 : 0;
      const crackStageEncoded = v.getUint8(bo);
      return {
        type: MessageType.BLOCK_BREAK_PROGRESS,
        mode: "relay",
        subjectPeerId,
        wx,
        wy,
        layer,
        crackStageEncoded,
      };
    }

    default:
      throw new Error(
        `Unknown message type byte: 0x${typeByte.toString(16).padStart(2, "0")}`,
      );
  }
}
