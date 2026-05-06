/** Utility for serializing and deserializing game messages to/from binary buffers (DataView, UTF-8 strings). */

import { CHUNK_SIZE } from "../../core/constants";
import {
  FURNACE_CHUNK_MAGIC,
  FURNACE_CHUNK_MAGIC_V2,
  FURNACE_CHUNK_MAGIC_V3,
  FURNACE_CHUNK_MAGIC_V4,
  FURNACE_SNAPSHOT_V3_SENTINEL,
  FURNACE_SNAPSHOT_V4_SENTINEL,
  byteLengthFurnacePersistedV4,
  readFurnacePersistedV2FromView,
  readFurnacePersistedV3FromView,
  readFurnacePersistedV4FromView,
  readLegacyFurnaceEntry,
  writeFurnacePersistedV4ToView,
  type FurnacePersistedChunk,
} from "../../world/furnace/furnacePersisted";
import {
  CHEST_CHUNK_MAGIC,
  CHEST_CHUNK_MAGIC_V2,
  CHEST_SNAPSHOT_V2_SENTINEL,
  byteLengthChestPersistedV2,
  readChestPersistedV1FromView,
  readChestPersistedV2FromView,
  writeChestPersistedV2ToView,
  type ChestPersistedChunk,
} from "../../world/chest/chestPersisted";
import type { SpawnerPersistedChunk } from "../../world/spawner/spawnerPersisted";
import type { SignPersistedChunk } from "../../world/sign/signPersisted";

const LE = true;

const textEnc = new TextEncoder();
const textDec = new TextDecoder();

/** Must match `MessageType.HANDSHAKE` in `messages.ts` (no import — avoids circular dependency). */
const HANDSHAKE_TYPE_BYTE = 0;
/** Must match `MessageType.CHUNK_DATA` in `messages.ts`. */
const CHUNK_DATA_TYPE_BYTE = 1;
/** Must match `MessageType.BLOCK_UPDATE` in `messages.ts`. */
const BLOCK_UPDATE_TYPE_BYTE = 2;
/** Must match `MessageType.WORLD_SYNC` in `messages.ts`. */
const WORLD_SYNC_TYPE_BYTE = 8;
/** Must match `MessageType.FURNACE_SNAPSHOT` in `messages.ts`. */
const FURNACE_SNAPSHOT_TYPE_BYTE = 0x0e;
/** Must match `MessageType.CHEST_SNAPSHOT` in `messages.ts`. */
const CHEST_SNAPSHOT_TYPE_BYTE = 0x0f;
const WORLD_MODE_SURVIVAL_BYTE = 0;
const WORLD_MODE_CREATIVE_BYTE = 1;
const WORLD_GEN_TYPE_NORMAL_BYTE = 0;
const WORLD_GEN_TYPE_FLAT_BYTE = 1;

/** Number of blocks per chunk (CHUNK_SIZE × CHUNK_SIZE). */
const CHUNK_CELLS = CHUNK_SIZE * CHUNK_SIZE;
/** Number of bytes of block payload in a chunk packet (Uint16 × cells). */
const CHUNK_BLOCK_BYTES = CHUNK_CELLS * 2;

/** Trailing per-cell metadata (`Uint8` × cells) after furnace/chest tails; v10+. */
const CHUNK_METADATA_MAGIC = 0x54_41_44_4d; // 'TADM' LE — per-cell flags (e.g. WORLDGEN_NO_COLLIDE)
const CHUNK_SPAWNER_MAGIC = 0x57_50_53_53; // 'SSPW' LE
const CHUNK_SIGN_MAGIC = 0x4e_47_53_53; // 'SSGN' LE

/** Wire protocol version carried in handshake (this build). */
export const WIRE_PROTOCOL_VERSION = 22;
/**
 * Oldest wire version this build still speaks. Bump when the binary layout breaks;
 * keep in sync with {@link WIRE_PROTOCOL_VERSION} when you drop old clients.
 * Handshake v17+ added `localGuestUuid`; v16 peers remain compatible.
 */
export const MIN_WIRE_PROTOCOL_VERSION = 16;

export function isWireVersionCompatible(peerVersion: number): boolean {
  return (
    peerVersion >= MIN_WIRE_PROTOCOL_VERSION &&
    peerVersion <= WIRE_PROTOCOL_VERSION
  );
}

/** Max UTF-8 bytes for handshake display name (profile + guest labels). */
export const HANDSHAKE_DISPLAY_NAME_MAX_BYTES = 128;

/** Max UTF-8 bytes for Supabase user id (UUID) on the wire. */
export const HANDSHAKE_ACCOUNT_ID_MAX_BYTES = 64;

/** Max UTF-8 bytes for skin id on the wire (e.g. `"explorer_bob"` or `"custom:uuid"`). */
export const HANDSHAKE_SKIN_ID_MAX_BYTES = 128;

/** Max UTF-8 bytes for persisted local anonymous id (standard UUID string). */
export const HANDSHAKE_LOCAL_GUEST_UUID_MAX_BYTES = 36;
/** Max UTF-8 bytes for cosmetic hex color strings like `#4ea1ff`. */
export const HANDSHAKE_COLOR_HEX_MAX_BYTES = 16;

export type HandshakeWirePayload = {
  version: number;
  peerId: string;
  /** Empty string if legacy peer omitted tail. */
  displayName: string;
  /** Empty string = guest / no Supabase session. */
  accountId: string;
  /** Selected skin id; empty string = default skin. */
  skinId: string;
  /**
   * Persisted local anonymous UUID when `accountId` is empty; empty when signed in
   * or legacy peer (v16 and older).
   */
  localGuestUuid: string;
  /** Optional replicated player nametag color (`#rrggbb`). */
  nameColorHex?: string;
  /** Optional replicated player outline glow color (`#rrggbb`). */
  outlineColorHex?: string;
};

export type WorldSyncWirePayload = {
  seed: number;
  /** Authoritative world clock (ms); absent in legacy 5-byte packets → treated as 0. */
  worldTimeMs: number;
  /** Authoritative world mode; absent in legacy packets → `survival`. */
  gameMode: "survival" | "sandbox";
  /** Authoritative world cheat toggle; absent in legacy packets → `false`. */
  cheatsEnabled: boolean;
  /** Authoritative world generation preset; absent in legacy packets → `"normal"`. */
  worldGenType: "normal" | "flat";
};

export type ChunkDataWirePayload = {
  chunkX: number;
  chunkY: number;
  blocks: Uint16Array;
  /** Present when packet includes back-wall layer (v2). */
  background?: Uint16Array;
  /** Present when packet includes furnace tile tail (v3). */
  furnaces?: FurnacePersistedChunk[];
  /** Present when packet includes chest tile tail (v7). */
  chests?: ChestPersistedChunk[];
  /** Present when packet includes spawner tile tail. */
  spawners?: SpawnerPersistedChunk[];
  /** Present when packet includes sign tile tail. */
  signs?: SignPersistedChunk[];
  /** Present when packet includes per-cell metadata tail (v10); tree no-collision bits, etc. */
  metadata?: Uint8Array;
};

export type BlockUpdateWirePayload = {
  x: number;
  y: number;
  blockId: number;
  /** 0 = foreground, 1 = background layer. */
  layer: number;
  /** u16 on wire when packet length ≥ 14 (protocol v9+). */
  previousBlockId?: number;
  /** u8 at offset 14 when packet length ≥ 15 (protocol v11+); per-cell flags (e.g. tree no-collision). */
  cellMetadata?: number;
};

export type DecodedWirePayload =
  | { kind: "handshake"; payload: HandshakeWirePayload }
  | { kind: "world-sync"; payload: WorldSyncWirePayload }
  | { kind: "chunk-data"; payload: ChunkDataWirePayload }
  | { kind: "block-update"; payload: BlockUpdateWirePayload };

export class BinarySerializer {
  /**
   * Encodes handshake: [type][u32 ver][u32 peerLen][peer][u16 dnLen][displayName][u16 accLen][accountId][u16 skinLen][skinId][u16 localLen][localGuestUuid].
   */
  public static serializeHandshake(
    msg: HandshakeWirePayload,
  ): ArrayBuffer {
    const peerIdBytes = textEnc.encode(msg.peerId);
    let dnBytes = textEnc.encode(msg.displayName);
    if (dnBytes.length > HANDSHAKE_DISPLAY_NAME_MAX_BYTES) {
      dnBytes = dnBytes.slice(0, HANDSHAKE_DISPLAY_NAME_MAX_BYTES);
    }
    let accBytes = textEnc.encode(msg.accountId);
    if (accBytes.length > HANDSHAKE_ACCOUNT_ID_MAX_BYTES) {
      accBytes = accBytes.slice(0, HANDSHAKE_ACCOUNT_ID_MAX_BYTES);
    }
    let skinBytes = textEnc.encode(msg.skinId);
    if (skinBytes.length > HANDSHAKE_SKIN_ID_MAX_BYTES) {
      skinBytes = skinBytes.slice(0, HANDSHAKE_SKIN_ID_MAX_BYTES);
    }
    let localBytes = textEnc.encode(msg.localGuestUuid ?? "");
    if (localBytes.length > HANDSHAKE_LOCAL_GUEST_UUID_MAX_BYTES) {
      localBytes = localBytes.slice(0, HANDSHAKE_LOCAL_GUEST_UUID_MAX_BYTES);
    }
    let nameColorBytes = textEnc.encode(msg.nameColorHex ?? "");
    if (nameColorBytes.length > HANDSHAKE_COLOR_HEX_MAX_BYTES) {
      nameColorBytes = nameColorBytes.slice(0, HANDSHAKE_COLOR_HEX_MAX_BYTES);
    }
    let outlineColorBytes = textEnc.encode(msg.outlineColorHex ?? "");
    if (outlineColorBytes.length > HANDSHAKE_COLOR_HEX_MAX_BYTES) {
      outlineColorBytes = outlineColorBytes.slice(0, HANDSHAKE_COLOR_HEX_MAX_BYTES);
    }
    const total =
      1 +
      4 +
      4 +
      peerIdBytes.length +
      2 +
      dnBytes.length +
      2 +
      accBytes.length +
      2 +
      skinBytes.length +
      2 +
      localBytes.length +
      2 +
      nameColorBytes.length +
      2 +
      outlineColorBytes.length;
    const buffer = new ArrayBuffer(total);
    const view = new DataView(buffer);
    let o = 0;
    view.setUint8(o, HANDSHAKE_TYPE_BYTE);
    o += 1;
    view.setUint32(o, msg.version, LE);
    o += 4;
    view.setUint32(o, peerIdBytes.length, LE);
    o += 4;
    new Uint8Array(buffer, o, peerIdBytes.length).set(peerIdBytes);
    o += peerIdBytes.length;
    view.setUint16(o, dnBytes.length, LE);
    o += 2;
    new Uint8Array(buffer, o, dnBytes.length).set(dnBytes);
    o += dnBytes.length;
    view.setUint16(o, accBytes.length, LE);
    o += 2;
    new Uint8Array(buffer, o, accBytes.length).set(accBytes);
    o += accBytes.length;
    view.setUint16(o, skinBytes.length, LE);
    o += 2;
    new Uint8Array(buffer, o, skinBytes.length).set(skinBytes);
    o += skinBytes.length;
    view.setUint16(o, localBytes.length, LE);
    o += 2;
    new Uint8Array(buffer, o, localBytes.length).set(localBytes);
    o += localBytes.length;
    view.setUint16(o, nameColorBytes.length, LE);
    o += 2;
    new Uint8Array(buffer, o, nameColorBytes.length).set(nameColorBytes);
    o += nameColorBytes.length;
    view.setUint16(o, outlineColorBytes.length, LE);
    o += 2;
    new Uint8Array(buffer, o, outlineColorBytes.length).set(outlineColorBytes);
    return buffer;
  }

  /** Decodes handshake; legacy buffers (peerId only) yield empty displayName, accountId, and skinId. */
  public static deserializeHandshake(buffer: ArrayBuffer): HandshakeWirePayload {
    const view = new DataView(buffer);
    const type = view.getUint8(0);
    if (type !== HANDSHAKE_TYPE_BYTE) {
      throw new Error(
        `Expected handshake type byte ${HANDSHAKE_TYPE_BYTE}, got ${type}`,
      );
    }
    const version = view.getUint32(1, LE);
    const peerIdLen = view.getUint32(5, LE);
    if (buffer.byteLength < 9 + peerIdLen) {
      throw new Error("Handshake buffer truncated");
    }
    let o = 9 + peerIdLen;
    const peerId = textDec.decode(new Uint8Array(buffer, 9, peerIdLen));
    if (o + 2 > buffer.byteLength) {
      return {
        version,
        peerId,
        displayName: "",
        accountId: "",
        skinId: "",
        localGuestUuid: "",
        nameColorHex: "",
        outlineColorHex: "",
      };
    }
    const dnLen = view.getUint16(o, LE);
    o += 2;
    if (o + dnLen > buffer.byteLength) {
      return {
        version,
        peerId,
        displayName: "",
        accountId: "",
        skinId: "",
        localGuestUuid: "",
        nameColorHex: "",
        outlineColorHex: "",
      };
    }
    const displayName =
      dnLen > 0 ? textDec.decode(new Uint8Array(buffer, o, dnLen)) : "";
    o += dnLen;
    if (o + 2 > buffer.byteLength) {
      return {
        version,
        peerId,
        displayName: displayName || "Player",
        accountId: "",
        skinId: "",
        localGuestUuid: "",
        nameColorHex: "",
        outlineColorHex: "",
      };
    }
    const accLen = view.getUint16(o, LE);
    o += 2;
    if (o + accLen > buffer.byteLength) {
      return {
        version,
        peerId,
        displayName: displayName || "Player",
        accountId: "",
        skinId: "",
        localGuestUuid: "",
        nameColorHex: "",
        outlineColorHex: "",
      };
    }
    const accountId =
      accLen > 0 ? textDec.decode(new Uint8Array(buffer, o, accLen)) : "";
    o += accLen;
    if (o + 2 > buffer.byteLength) {
      return {
        version,
        peerId,
        displayName: displayName.trim() !== "" ? displayName : "Player",
        accountId,
        skinId: "",
        localGuestUuid: "",
        nameColorHex: "",
        outlineColorHex: "",
      };
    }
    const skinLen = view.getUint16(o, LE);
    o += 2;
    let skinId = "";
    if (skinLen > 0) {
      if (o + skinLen > buffer.byteLength) {
        return {
          version,
          peerId,
          displayName: displayName.trim() !== "" ? displayName : "Player",
          accountId,
          skinId: "",
          localGuestUuid: "",
          nameColorHex: "",
          outlineColorHex: "",
        };
      }
      skinId = textDec.decode(new Uint8Array(buffer, o, skinLen));
      o += skinLen;
    }
    let localGuestUuid = "";
    let nameColorHex = "";
    let outlineColorHex = "";
    if (o + 2 <= buffer.byteLength) {
      const localLen = view.getUint16(o, LE);
      o += 2;
      if (localLen > 0 && o + localLen <= buffer.byteLength) {
        localGuestUuid = textDec.decode(new Uint8Array(buffer, o, localLen));
        o += localLen;
      }
      if (o + 2 <= buffer.byteLength) {
        const nameColorLen = view.getUint16(o, LE);
        o += 2;
        if (nameColorLen > 0 && o + nameColorLen <= buffer.byteLength) {
          nameColorHex = textDec.decode(new Uint8Array(buffer, o, nameColorLen));
          o += nameColorLen;
        }
      }
      if (o + 2 <= buffer.byteLength) {
        const outlineColorLen = view.getUint16(o, LE);
        o += 2;
        if (outlineColorLen > 0 && o + outlineColorLen <= buffer.byteLength) {
          outlineColorHex = textDec.decode(
            new Uint8Array(buffer, o, outlineColorLen),
          );
        }
      }
    }
    return {
      version,
      peerId,
      displayName: displayName.trim() !== "" ? displayName : "Player",
      accountId,
      skinId,
      localGuestUuid,
      nameColorHex,
      outlineColorHex,
    };
  }

  /** Serialize authoritative world metadata (seed + clock + game mode + gen type). */
  public static serializeWorldSync(
    seed: number,
    worldTimeMs: number,
    gameMode: "survival" | "sandbox",
    worldGenType: "normal" | "flat",
    cheatsEnabled: boolean,
  ): ArrayBuffer {
    const buffer = new ArrayBuffer(1 + 4 + 8 + 1 + 1 + 1);
    const view = new DataView(buffer);
    view.setUint8(0, WORLD_SYNC_TYPE_BYTE);
    view.setUint32(1, seed >>> 0, LE);
    view.setFloat64(5, worldTimeMs, LE);
    view.setUint8(
      13,
      gameMode === "sandbox" ? WORLD_MODE_CREATIVE_BYTE : WORLD_MODE_SURVIVAL_BYTE,
    );
    view.setUint8(14, cheatsEnabled ? 1 : 0);
    view.setUint8(
      15,
      worldGenType === "flat" ? WORLD_GEN_TYPE_FLAT_BYTE : WORLD_GEN_TYPE_NORMAL_BYTE,
    );
    return buffer;
  }

  /** Deserialize a WORLD_SYNC buffer into its seed payload. */
  public static deserializeWorldSync(buffer: ArrayBuffer): WorldSyncWirePayload {
    const view = new DataView(buffer);
    const type = view.getUint8(0);
    if (type !== WORLD_SYNC_TYPE_BYTE) {
      throw new Error(
        `Expected world sync type byte ${WORLD_SYNC_TYPE_BYTE}, got ${type}`,
      );
    }
    if (buffer.byteLength < 5) {
      throw new Error("World sync buffer truncated");
    }
    const seed = view.getUint32(1, LE);
    let worldTimeMs = 0;
    if (buffer.byteLength >= 13) {
      worldTimeMs = view.getFloat64(5, LE);
    }
    let gameMode: "survival" | "sandbox" = "survival";
    let cheatsEnabled = false;
    let worldGenType: "normal" | "flat" = "normal";
    if (buffer.byteLength >= 14) {
      gameMode =
        view.getUint8(13) === WORLD_MODE_CREATIVE_BYTE ? "sandbox" : "survival";
      if (buffer.byteLength >= 15) {
        cheatsEnabled = view.getUint8(14) !== 0;
      }
      if (buffer.byteLength >= 16) {
        worldGenType =
          view.getUint8(15) === WORLD_GEN_TYPE_FLAT_BYTE ? "flat" : "normal";
      }
    }
    return { seed, worldTimeMs, gameMode, cheatsEnabled, worldGenType };
  }

  private static readonly FURNACE_LEGACY_ENTRY_BYTES = 38;

  private static appendFurnaceChunkTail(
    base: ArrayBuffer,
    furnaces: readonly FurnacePersistedChunk[],
  ): ArrayBuffer {
    let tailBody = 0;
    for (const f of furnaces) {
      tailBody += byteLengthFurnacePersistedV4(f);
    }
    const tailHeader = 4 + 2;
    const out = new ArrayBuffer(base.byteLength + tailHeader + tailBody);
    new Uint8Array(out).set(new Uint8Array(base), 0);
    const view = new DataView(out);
    let o = base.byteLength;
    view.setUint32(o, FURNACE_CHUNK_MAGIC_V4 >>> 0, LE);
    o += 4;
    view.setUint16(o, furnaces.length & 0xffff, LE);
    o += 2;
    for (const f of furnaces) {
      o = writeFurnacePersistedV4ToView(view, out, o, f);
    }
    return out;
  }

  private static tryReadFurnaceChunkTail(
    view: DataView,
    offset: number,
    byteLength: number,
  ): { entries: FurnacePersistedChunk[]; endExclusive: number } | undefined {
    if (byteLength < offset + 6) {
      return undefined;
    }
    const magic = view.getUint32(offset, LE);
    if (magic === FURNACE_CHUNK_MAGIC_V4) {
      const count = view.getUint16(offset + 4, LE);
      if (count > 1024) {
        return undefined;
      }
      let o = offset + 6;
      const out: FurnacePersistedChunk[] = [];
      for (let i = 0; i < count; i++) {
        const parsed = readFurnacePersistedV4FromView(view, view.buffer, o);
        if (parsed === undefined) {
          return undefined;
        }
        out.push(parsed[0]);
        o = parsed[1];
        if (o > byteLength) {
          return undefined;
        }
      }
      return { entries: out, endExclusive: o };
    }
    if (magic === FURNACE_CHUNK_MAGIC_V3) {
      const count = view.getUint16(offset + 4, LE);
      if (count > 1024) {
        return undefined;
      }
      let o = offset + 6;
      const out: FurnacePersistedChunk[] = [];
      for (let i = 0; i < count; i++) {
        const parsed = readFurnacePersistedV3FromView(view, view.buffer, o);
        if (parsed === undefined) {
          return undefined;
        }
        out.push(parsed[0]);
        o = parsed[1];
        if (o > byteLength) {
          return undefined;
        }
      }
      return { entries: out, endExclusive: o };
    }
    if (magic === FURNACE_CHUNK_MAGIC_V2) {
      const count = view.getUint16(offset + 4, LE);
      if (count > 1024) {
        return undefined;
      }
      let o = offset + 6;
      const out: FurnacePersistedChunk[] = [];
      for (let i = 0; i < count; i++) {
        const parsed = readFurnacePersistedV2FromView(view, view.buffer, o);
        if (parsed === undefined) {
          return undefined;
        }
        out.push(parsed[0]);
        o = parsed[1];
        if (o > byteLength) {
          return undefined;
        }
      }
      return { entries: out, endExclusive: o };
    }
    if (magic !== FURNACE_CHUNK_MAGIC) {
      return undefined;
    }
    const count = view.getUint16(offset + 4, LE);
    let o = offset + 6;
    const need = count * this.FURNACE_LEGACY_ENTRY_BYTES;
    if (byteLength < o + need || count > 1024) {
      return undefined;
    }
    const out: FurnacePersistedChunk[] = [];
    for (let i = 0; i < count; i++) {
      const lx = view.getUint8(o++);
      const ly = view.getUint8(o++);
      const [chunk, nextO] = readLegacyFurnaceEntry(view, o, lx, ly);
      out.push(chunk);
      o = nextO;
    }
    return { entries: out, endExclusive: o };
  }

  private static appendChestChunkTail(
    base: ArrayBuffer,
    chests: readonly ChestPersistedChunk[],
  ): ArrayBuffer {
    let tailBody = 0;
    for (const c of chests) {
      tailBody += byteLengthChestPersistedV2(c);
    }
    const tailHeader = 4 + 2;
    const out = new ArrayBuffer(base.byteLength + tailHeader + tailBody);
    new Uint8Array(out).set(new Uint8Array(base), 0);
    const view = new DataView(out);
    let o = base.byteLength;
    view.setUint32(o, CHEST_CHUNK_MAGIC_V2 >>> 0, LE);
    o += 4;
    view.setUint16(o, chests.length & 0xffff, LE);
    o += 2;
    for (const c of chests) {
      o = writeChestPersistedV2ToView(view, out, o, c);
    }
    return out;
  }

  private static tryReadChestChunkTail(
    view: DataView,
    offset: number,
    byteLength: number,
  ): { entries: ChestPersistedChunk[]; endExclusive: number } | undefined {
    if (byteLength < offset + 6) {
      return undefined;
    }
    const chestMagic = view.getUint32(offset, LE);
    if (chestMagic === CHEST_CHUNK_MAGIC_V2) {
      const count = view.getUint16(offset + 4, LE);
      if (count > 1024) {
        return undefined;
      }
      let o = offset + 6;
      const out: ChestPersistedChunk[] = [];
      for (let i = 0; i < count; i++) {
        const parsed = readChestPersistedV2FromView(view, view.buffer, o);
        if (parsed === undefined) {
          return undefined;
        }
        out.push(parsed[0]);
        o = parsed[1];
        if (o > byteLength) {
          return undefined;
        }
      }
      return { entries: out, endExclusive: o };
    }
    if (chestMagic !== CHEST_CHUNK_MAGIC) {
      return undefined;
    }
    const count = view.getUint16(offset + 4, LE);
    if (count > 1024) {
      return undefined;
    }
    let o = offset + 6;
    const out: ChestPersistedChunk[] = [];
    for (let i = 0; i < count; i++) {
      const parsed = readChestPersistedV1FromView(view, view.buffer, o);
      if (parsed === undefined) {
        return undefined;
      }
      out.push(parsed[0]);
      o = parsed[1];
      if (o > byteLength) {
        return undefined;
      }
    }
    return { entries: out, endExclusive: o };
  }

  /**
   * Serialize a 32×32 chunk: foreground blocks + back-wall layer + optional furnace tail (v3).
   * Layout: [type][chunkX i32][chunkY i32][blocks u16×N][background u16×N][optional FURN tail].
   */
  public static serializeChunk(
    chunkX: number,
    chunkY: number,
    blocks: Uint16Array,
    background: Uint16Array,
    furnaces?: readonly FurnacePersistedChunk[],
    chests?: readonly ChestPersistedChunk[],
    spawners?: readonly SpawnerPersistedChunk[],
    metadata?: Uint8Array,
    signs?: readonly SignPersistedChunk[],
  ): ArrayBuffer {
    if (blocks.length !== CHUNK_CELLS) {
      throw new Error(
        `Chunk blocks length ${blocks.length} does not match expected ${CHUNK_CELLS}`,
      );
    }
    if (background.length !== CHUNK_CELLS) {
      throw new Error(
        `Chunk background length ${background.length} does not match expected ${CHUNK_CELLS}`,
      );
    }
    const buffer = new ArrayBuffer(1 + 4 + 4 + CHUNK_BLOCK_BYTES * 2);
    const view = new DataView(buffer);
    view.setUint8(0, CHUNK_DATA_TYPE_BYTE);
    view.setInt32(1, chunkX, LE);
    view.setInt32(5, chunkY, LE);
    const fgOff = 9;
    const bgOff = 9 + CHUNK_BLOCK_BYTES;
    for (let i = 0; i < CHUNK_CELLS; i++) {
      view.setUint16(fgOff + i * 2, blocks[i]!, LE);
      view.setUint16(bgOff + i * 2, background[i]!, LE);
    }
    let outBuf = buffer;
    if (furnaces !== undefined && furnaces.length > 0) {
      outBuf = this.appendFurnaceChunkTail(outBuf, furnaces);
    }
    if (chests !== undefined && chests.length > 0) {
      outBuf = this.appendChestChunkTail(outBuf, chests);
    }
    if (spawners !== undefined && spawners.length > 0) {
      outBuf = this.appendSpawnerChunkTail(outBuf, spawners);
    }
    if (signs !== undefined && signs.length > 0) {
      outBuf = this.appendSignChunkTail(outBuf, signs);
    }
    if (metadata !== undefined) {
      if (metadata.length !== CHUNK_CELLS) {
        throw new Error(
          `Chunk metadata length ${metadata.length} does not match ${CHUNK_CELLS}`,
        );
      }
      outBuf = this.appendChunkMetadataTail(outBuf, metadata);
    }
    return outBuf;
  }

  private static appendChunkMetadataTail(
    base: ArrayBuffer,
    metadata: Uint8Array,
  ): ArrayBuffer {
    const out = new ArrayBuffer(base.byteLength + 4 + CHUNK_CELLS);
    new Uint8Array(out).set(new Uint8Array(base), 0);
    const view = new DataView(out);
    let o = base.byteLength;
    view.setUint32(o, CHUNK_METADATA_MAGIC >>> 0, LE);
    o += 4;
    new Uint8Array(out).set(metadata, o);
    return out;
  }

  private static tryReadChunkMetadataTail(
    view: DataView,
    offset: number,
    byteLength: number,
  ): { bytes: Uint8Array; endExclusive: number } | undefined {
    if (byteLength < offset + 4 + CHUNK_CELLS) {
      return undefined;
    }
    if (view.getUint32(offset, LE) !== CHUNK_METADATA_MAGIC) {
      return undefined;
    }
    const start = offset + 4;
    const bytes = new Uint8Array(view.buffer, start, CHUNK_CELLS).slice();
    return { bytes, endExclusive: start + CHUNK_CELLS };
  }

  private static appendSpawnerChunkTail(
    base: ArrayBuffer,
    spawners: readonly SpawnerPersistedChunk[],
  ): ArrayBuffer {
    const payload = textEnc.encode(JSON.stringify(spawners));
    const out = new ArrayBuffer(base.byteLength + 4 + 4 + payload.byteLength);
    new Uint8Array(out).set(new Uint8Array(base), 0);
    const view = new DataView(out);
    let o = base.byteLength;
    view.setUint32(o, CHUNK_SPAWNER_MAGIC >>> 0, LE);
    o += 4;
    view.setUint32(o, payload.byteLength >>> 0, LE);
    o += 4;
    new Uint8Array(out, o, payload.byteLength).set(payload);
    return out;
  }

  private static tryReadSpawnerChunkTail(
    view: DataView,
    offset: number,
    byteLength: number,
  ): { entries: SpawnerPersistedChunk[]; endExclusive: number } | undefined {
    if (byteLength < offset + 8) {
      return undefined;
    }
    if (view.getUint32(offset, LE) !== CHUNK_SPAWNER_MAGIC) {
      return undefined;
    }
    const len = view.getUint32(offset + 4, LE);
    const start = offset + 8;
    const end = start + len;
    if (end > byteLength) {
      return undefined;
    }
    const parsed = JSON.parse(textDec.decode(new Uint8Array(view.buffer, start, len)));
    if (!Array.isArray(parsed)) {
      return undefined;
    }
    const entries = parsed.filter(
      (v): v is SpawnerPersistedChunk => v !== null && typeof v === "object",
    );
    return { entries, endExclusive: end };
  }

  private static appendSignChunkTail(
    base: ArrayBuffer,
    signs: readonly SignPersistedChunk[],
  ): ArrayBuffer {
    const payload = textEnc.encode(JSON.stringify(signs));
    const out = new ArrayBuffer(base.byteLength + 4 + 4 + payload.byteLength);
    new Uint8Array(out).set(new Uint8Array(base), 0);
    const view = new DataView(out);
    let o = base.byteLength;
    view.setUint32(o, CHUNK_SIGN_MAGIC >>> 0, LE);
    o += 4;
    view.setUint32(o, payload.byteLength >>> 0, LE);
    o += 4;
    new Uint8Array(out, o, payload.byteLength).set(payload);
    return out;
  }

  private static tryReadSignChunkTail(
    view: DataView,
    offset: number,
    byteLength: number,
  ): { entries: SignPersistedChunk[]; endExclusive: number } | undefined {
    if (byteLength < offset + 8) {
      return undefined;
    }
    if (view.getUint32(offset, LE) !== CHUNK_SIGN_MAGIC) {
      return undefined;
    }
    const len = view.getUint32(offset + 4, LE);
    const start = offset + 8;
    const end = start + len;
    if (end > byteLength) {
      return undefined;
    }
    const parsed = JSON.parse(textDec.decode(new Uint8Array(view.buffer, start, len)));
    if (!Array.isArray(parsed)) {
      return undefined;
    }
    const entries = parsed.filter(
      (v): v is SignPersistedChunk => v !== null && typeof v === "object",
    );
    return { entries, endExclusive: end };
  }

  /** Single furnace cell at world coords (incremental sync). */
  public static serializeFurnaceSnapshot(
    wx: number,
    wy: number,
    data: FurnacePersistedChunk,
  ): ArrayBuffer {
    const payloadBytes = 1 + byteLengthFurnacePersistedV4(data);
    const buf = new ArrayBuffer(1 + 4 + 4 + payloadBytes);
    const view = new DataView(buf);
    view.setUint8(0, FURNACE_SNAPSHOT_TYPE_BYTE);
    view.setInt32(1, wx, LE);
    view.setInt32(5, wy, LE);
    view.setUint8(9, FURNACE_SNAPSHOT_V4_SENTINEL);
    writeFurnacePersistedV4ToView(view, buf, 10, data);
    return buf;
  }

  public static deserializeFurnaceSnapshot(buffer: ArrayBuffer): {
    wx: number;
    wy: number;
    data: FurnacePersistedChunk;
  } {
    const view = new DataView(buffer);
    if (view.getUint8(0) !== FURNACE_SNAPSHOT_TYPE_BYTE) {
      throw new Error("Expected FURNACE_SNAPSHOT type byte");
    }
    const minLegacy = 1 + 4 + 4 + this.FURNACE_LEGACY_ENTRY_BYTES;
    if (buffer.byteLength < minLegacy) {
      throw new Error("Furnace snapshot truncated");
    }
    const wx = view.getInt32(1, LE);
    const wy = view.getInt32(5, LE);
    if (buffer.byteLength > 9 && view.getUint8(9) === FURNACE_SNAPSHOT_V4_SENTINEL) {
      const parsed = readFurnacePersistedV4FromView(view, buffer, 10);
      if (parsed !== undefined && parsed[1] === buffer.byteLength) {
        return { wx, wy, data: parsed[0] };
      }
    }
    if (buffer.byteLength > 9 && view.getUint8(9) === FURNACE_SNAPSHOT_V3_SENTINEL) {
      const parsed = readFurnacePersistedV3FromView(view, buffer, 10);
      if (parsed !== undefined && parsed[1] === buffer.byteLength) {
        return { wx, wy, data: parsed[0] };
      }
    }
    const minV2 = 1 + 4 + 4 + 72;
    if (buffer.byteLength >= minV2) {
      const parsed = readFurnacePersistedV2FromView(view, buffer, 9);
      if (parsed !== undefined && parsed[1] === buffer.byteLength) {
        return { wx, wy, data: parsed[0] };
      }
    }
    let o = 9;
    const lx = view.getUint8(o++);
    const ly = view.getUint8(o++);
    const [data] = readLegacyFurnaceEntry(view, o, lx, ly);
    return { wx, wy, data };
  }

  public static serializeChestSnapshot(
    wx: number,
    wy: number,
    data: ChestPersistedChunk,
  ): ArrayBuffer {
    const payloadBytes = 1 + byteLengthChestPersistedV2(data);
    const buf = new ArrayBuffer(1 + 4 + 4 + payloadBytes);
    const view = new DataView(buf);
    view.setUint8(0, CHEST_SNAPSHOT_TYPE_BYTE);
    view.setInt32(1, wx, LE);
    view.setInt32(5, wy, LE);
    view.setUint8(9, CHEST_SNAPSHOT_V2_SENTINEL);
    writeChestPersistedV2ToView(view, buf, 10, data);
    return buf;
  }

  public static deserializeChestSnapshot(buffer: ArrayBuffer): {
    wx: number;
    wy: number;
    data: ChestPersistedChunk;
  } {
    const view = new DataView(buffer);
    if (view.getUint8(0) !== CHEST_SNAPSHOT_TYPE_BYTE) {
      throw new Error("Expected CHEST_SNAPSHOT type byte");
    }
    if (buffer.byteLength < 1 + 4 + 4 + 3) {
      throw new Error("Chest snapshot truncated");
    }
    const wx = view.getInt32(1, LE);
    const wy = view.getInt32(5, LE);
    if (buffer.byteLength > 9 && view.getUint8(9) === CHEST_SNAPSHOT_V2_SENTINEL) {
      const parsed = readChestPersistedV2FromView(view, buffer, 10);
      if (parsed === undefined || parsed[1] !== buffer.byteLength) {
        throw new Error("Chest snapshot parse failed");
      }
      return { wx, wy, data: parsed[0] };
    }
    const parsed = readChestPersistedV1FromView(view, buffer, 9);
    if (parsed === undefined) {
      throw new Error("Chest snapshot parse failed");
    }
    return { wx, wy, data: parsed[0] };
  }

  /** Deserialize CHUNK_DATA (v2 with background, or v1 blocks-only). */
  public static deserializeChunk(buffer: ArrayBuffer): ChunkDataWirePayload {
    const view = new DataView(buffer);
    const type = view.getUint8(0);
    if (type !== CHUNK_DATA_TYPE_BYTE) {
      throw new Error(
        `Expected chunk data type byte ${CHUNK_DATA_TYPE_BYTE}, got ${type}`,
      );
    }
    const legacyLen = 1 + 4 + 4 + CHUNK_BLOCK_BYTES;
    const fullLen = legacyLen + CHUNK_BLOCK_BYTES;
    if (buffer.byteLength < legacyLen) {
      throw new Error("Chunk data buffer truncated");
    }
    const chunkX = view.getInt32(1, LE);
    const chunkY = view.getInt32(5, LE);
    const blocks = new Uint16Array(CHUNK_CELLS);
    for (let i = 0; i < CHUNK_CELLS; i++) {
      blocks[i] = view.getUint16(9 + i * 2, LE);
    }
    if (buffer.byteLength >= fullLen) {
      const background = new Uint16Array(CHUNK_CELLS);
      const bgBase = 9 + CHUNK_BLOCK_BYTES;
      for (let i = 0; i < CHUNK_CELLS; i++) {
        background[i] = view.getUint16(bgBase + i * 2, LE);
      }
      const fur = this.tryReadFurnaceChunkTail(view, fullLen, buffer.byteLength);
      let off = fullLen;
      let furnaces: FurnacePersistedChunk[] | undefined;
      if (fur !== undefined) {
        furnaces = fur.entries;
        off = fur.endExclusive;
      }
      const ch = this.tryReadChestChunkTail(view, off, buffer.byteLength);
      let chests: ChestPersistedChunk[] | undefined;
      if (ch !== undefined) {
        chests = ch.entries;
        off = ch.endExclusive;
      }
      const sp = this.tryReadSpawnerChunkTail(view, off, buffer.byteLength);
      let spawners: SpawnerPersistedChunk[] | undefined;
      if (sp !== undefined) {
        spawners = sp.entries;
        off = sp.endExclusive;
      }
      const sg = this.tryReadSignChunkTail(view, off, buffer.byteLength);
      let signs: SignPersistedChunk[] | undefined;
      if (sg !== undefined) {
        signs = sg.entries;
        off = sg.endExclusive;
      }
      const meta = this.tryReadChunkMetadataTail(view, off, buffer.byteLength);
      let metadata: Uint8Array | undefined;
      if (meta !== undefined) {
        metadata = meta.bytes;
      }
      if (
        furnaces !== undefined ||
        chests !== undefined ||
        spawners !== undefined ||
        signs !== undefined ||
        metadata !== undefined
      ) {
        return {
          chunkX,
          chunkY,
          blocks,
          background,
          furnaces,
          chests,
          spawners,
          signs,
          metadata,
        };
      }
      return { chunkX, chunkY, blocks, background };
    }
    return { chunkX, chunkY, blocks };
  }

  /**
   * Serialize BLOCK_UPDATE:
   * [type][x i32][y i32][blockId u16][layer u8][previousBlockId u16][cellMetadata u8] (15 bytes, v11+).
   */
  public static serializeBlockUpdate(
    x: number,
    y: number,
    blockId: number,
    layer: number,
    previousBlockId?: number,
    cellMetadata: number = 0,
  ): ArrayBuffer {
    const buffer = new ArrayBuffer(15);
    const view = new DataView(buffer);
    view.setUint8(0, BLOCK_UPDATE_TYPE_BYTE);
    view.setInt32(1, x, LE);
    view.setInt32(5, y, LE);
    view.setUint16(9, blockId, LE);
    view.setUint8(11, layer & 0xff);
    view.setUint16(12, previousBlockId ?? 0, LE);
    view.setUint8(14, cellMetadata & 0xff);
    return buffer;
  }

  /** Deserialize BLOCK_UPDATE (11-byte legacy … 15-byte = v11 cell metadata tail). */
  public static deserializeBlockUpdate(
    buffer: ArrayBuffer,
  ): BlockUpdateWirePayload {
    const view = new DataView(buffer);
    const type = view.getUint8(0);
    if (type !== BLOCK_UPDATE_TYPE_BYTE) {
      throw new Error(
        `Expected block update type byte ${BLOCK_UPDATE_TYPE_BYTE}, got ${type}`,
      );
    }
    if (buffer.byteLength < 11) {
      throw new Error("Block update buffer truncated");
    }
    const x = view.getInt32(1, LE);
    const y = view.getInt32(5, LE);
    const blockId = view.getUint16(9, LE);
    const layer = buffer.byteLength >= 12 ? view.getUint8(11) : 0;
    const previousBlockId =
      buffer.byteLength >= 14 ? view.getUint16(12, LE) : undefined;
    const cellMetadata =
      buffer.byteLength >= 15 ? view.getUint8(14) : undefined;
    return { x, y, blockId, layer, previousBlockId, cellMetadata };
  }

  /**
   * Decode a buffer whose first byte is a known message type.
   * Returns a discriminated union for handshake, world metadata, or raw chunk data.
   */
  public static deserialize(buffer: ArrayBuffer): DecodedWirePayload {
    const view = new DataView(buffer);
    const type = view.getUint8(0);
    if (type === HANDSHAKE_TYPE_BYTE) {
      return {
        kind: "handshake",
        payload: this.deserializeHandshake(buffer),
      };
    }
    if (type === WORLD_SYNC_TYPE_BYTE) {
      return {
        kind: "world-sync",
        payload: this.deserializeWorldSync(buffer),
      };
    }
    if (type === CHUNK_DATA_TYPE_BYTE) {
      return {
        kind: "chunk-data",
        payload: this.deserializeChunk(buffer),
      };
    }
    if (type === BLOCK_UPDATE_TYPE_BYTE) {
      return {
        kind: "block-update",
        payload: this.deserializeBlockUpdate(buffer),
      };
    }
    throw new Error(
      `Unknown binary payload type byte: 0x${type.toString(16).padStart(2, "0")}`,
    );
  }
}
