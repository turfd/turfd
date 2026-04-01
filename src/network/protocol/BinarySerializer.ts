/** Utility for serializing and deserializing game messages to/from binary buffers (DataView, UTF-8 strings). */

import { CHUNK_SIZE } from "../../core/constants";

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

/** Number of blocks per chunk (CHUNK_SIZE × CHUNK_SIZE). */
const CHUNK_CELLS = CHUNK_SIZE * CHUNK_SIZE;
/** Number of bytes of block payload in a chunk packet (Uint16 × cells). */
const CHUNK_BLOCK_BYTES = CHUNK_CELLS * 2;

/** Wire protocol version carried in handshake; must match across peers. */
export const WIRE_PROTOCOL_VERSION = 2;

export type HandshakeWirePayload = {
  version: number;
  peerId: string;
};

export type WorldSyncWirePayload = {
  seed: number;
  /** Authoritative world clock (ms); absent in legacy 5-byte packets → treated as 0. */
  worldTimeMs: number;
};

export type ChunkDataWirePayload = {
  chunkX: number;
  chunkY: number;
  blocks: Uint16Array;
  /** Present when packet includes back-wall layer (v2). */
  background?: Uint16Array;
};

export type BlockUpdateWirePayload = {
  x: number;
  y: number;
  blockId: number;
  /** 0 = foreground, 1 = background layer. */
  layer: number;
};

export type DecodedWirePayload =
  | { kind: "handshake"; payload: HandshakeWirePayload }
  | { kind: "world-sync"; payload: WorldSyncWirePayload }
  | { kind: "chunk-data"; payload: ChunkDataWirePayload }
  | { kind: "block-update"; payload: BlockUpdateWirePayload };

export class BinarySerializer {
  /** Encodes a handshake payload into an ArrayBuffer (type byte + u32 version + u32 len + UTF-8 peerId). */
  public static serializeHandshake(
    msg: HandshakeWirePayload,
  ): ArrayBuffer {
    const peerIdBytes = textEnc.encode(msg.peerId);
    const buffer = new ArrayBuffer(1 + 4 + 4 + peerIdBytes.length);
    const view = new DataView(buffer);
    view.setUint8(0, HANDSHAKE_TYPE_BYTE);
    view.setUint32(1, msg.version, LE);
    view.setUint32(5, peerIdBytes.length, LE);
    new Uint8Array(buffer, 9).set(peerIdBytes);
    return buffer;
  }

  /** Decodes a handshake buffer into version + peerId. Throws if layout is invalid. */
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
    const peerId = textDec.decode(new Uint8Array(buffer, 9, peerIdLen));
    return { version, peerId };
  }

  /** Serialize authoritative world metadata (seed + clock for lighting sync). */
  public static serializeWorldSync(seed: number, worldTimeMs: number): ArrayBuffer {
    const buffer = new ArrayBuffer(1 + 4 + 8);
    const view = new DataView(buffer);
    view.setUint8(0, WORLD_SYNC_TYPE_BYTE);
    view.setUint32(1, seed >>> 0, LE);
    view.setFloat64(5, worldTimeMs, LE);
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
    return { seed, worldTimeMs };
  }

  /**
   * Serialize a 32×32 chunk: foreground blocks + back-wall layer.
   * Layout: [type][chunkX i32][chunkY i32][blocks u16×N][background u16×N].
   */
  public static serializeChunk(
    chunkX: number,
    chunkY: number,
    blocks: Uint16Array,
    background: Uint16Array,
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
    return buffer;
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
      return { chunkX, chunkY, blocks, background };
    }
    return { chunkX, chunkY, blocks };
  }

  /** Serialize BLOCK_UPDATE: [type][x i32][y i32][blockId u16][layer u8]. */
  public static serializeBlockUpdate(
    x: number,
    y: number,
    blockId: number,
    layer: number,
  ): ArrayBuffer {
    const buffer = new ArrayBuffer(1 + 4 + 4 + 2 + 1);
    const view = new DataView(buffer);
    view.setUint8(0, BLOCK_UPDATE_TYPE_BYTE);
    view.setInt32(1, x, LE);
    view.setInt32(5, y, LE);
    view.setUint16(9, blockId, LE);
    view.setUint8(11, layer & 0xff);
    return buffer;
  }

  /** Deserialize BLOCK_UPDATE (11-byte legacy = layer 0, 12-byte = layer). */
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
    return { x, y, blockId, layer };
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
