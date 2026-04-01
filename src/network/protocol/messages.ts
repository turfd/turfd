/** Binary network protocol: message IDs, typed payloads, and DataView encode/decode (no JSON on the wire). */

import {
  BinarySerializer,
  type WorldSyncWirePayload,
  type ChunkDataWirePayload,
  type BlockUpdateWirePayload,
} from "./BinarySerializer";

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
}

/** Back-compat alias used across the codebase. */
export { MessageType as MsgType };

export interface HandshakeMessage {
  type: MessageType.HANDSHAKE;
  version: number;
  peerId: string;
}

export type ChunkDataMsg = {
  type: MessageType.CHUNK_DATA;
  cx: number;
  cy: number;
  blocks: Uint16Array;
  /** Back-wall layer; omitted on legacy decode → treat as zeros. */
  background?: Uint16Array;
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
  playerId: number;
  text: string;
};

export type PingMsg = {
  type: MessageType.PING;
  timestamp: number;
};

export type NetworkMessage =
  | HandshakeMessage
  | ChunkDataMsg
  | BlockUpdateMsg
  | PlayerStateMsg
  | EntitySpawnMsg
  | EntityDespawnMsg
  | ChatMsg
  | PingMsg
  | WorldSyncMsg
  | WorldTimeMsg
  | SessionEndedMsg;

const LE = true;
const textEnc = new TextEncoder();
const textDec = new TextDecoder();

/** Wire size of a `PLAYER_STATE` packet (type byte + payload). */
export const PLAYER_STATE_WIRE_BYTE_LENGTH = 36;

/** Writes `PLAYER_STATE` layout into `view` (byte length {@link PLAYER_STATE_WIRE_BYTE_LENGTH}). */
export function writePlayerStateWire(
  view: DataView,
  playerId: number,
  x: number,
  y: number,
  vx: number,
  vy: number,
  facingRight: boolean,
): void {
  view.setUint8(0, MessageType.PLAYER_STATE);
  view.setUint16(1, playerId, LE);
  view.setFloat64(3, x, LE);
  view.setFloat64(11, y, LE);
  view.setFloat64(19, vx, LE);
  view.setFloat64(27, vy, LE);
  view.setUint8(35, facingRight ? 1 : 0);
}

export function encode(msg: NetworkMessage): ArrayBuffer {
  switch (msg.type) {
    case MessageType.HANDSHAKE:
      return BinarySerializer.serializeHandshake({
        version: msg.version,
        peerId: msg.peerId,
      });

    case MessageType.CHUNK_DATA: {
      const bg =
        msg.background ??
        new Uint16Array(msg.blocks.length);
      return BinarySerializer.serializeChunk(msg.cx, msg.cy, msg.blocks, bg);
    }

    case MessageType.BLOCK_UPDATE: {
      return BinarySerializer.serializeBlockUpdate(
        msg.x,
        msg.y,
        msg.blockId,
        msg.layer ?? 0,
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
      const encoded = textEnc.encode(msg.text);
      const buf = new ArrayBuffer(5 + encoded.byteLength);
      const v = new DataView(buf);
      v.setUint8(0, MessageType.CHAT);
      v.setUint16(1, msg.playerId, LE);
      v.setUint16(3, encoded.byteLength, LE);
      new Uint8Array(buf).set(encoded, 5);
      return buf;
    }

    case MessageType.PING: {
      const buf = new ArrayBuffer(9);
      const v = new DataView(buf);
      v.setUint8(0, MessageType.PING);
      v.setFloat64(1, msg.timestamp, LE);
      return buf;
    }

    case MessageType.WORLD_SYNC: {
      return BinarySerializer.serializeWorldSync(msg.seed, msg.worldTimeMs);
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
      return out;
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
      };
    }

    case MessageType.PLAYER_STATE:
      return {
        type: MessageType.PLAYER_STATE,
        playerId: v.getUint16(1, LE),
        x: v.getFloat64(3, LE),
        y: v.getFloat64(11, LE),
        vx: v.getFloat64(19, LE),
        vy: v.getFloat64(27, LE),
        facingRight: v.getUint8(35) !== 0,
      };

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
      const textLen = v.getUint16(3, LE);
      return {
        type: MessageType.CHAT,
        playerId: v.getUint16(1, LE),
        text: textDec.decode(new Uint8Array(buf, 5, textLen)),
      };
    }

    case MessageType.PING:
      return {
        type: MessageType.PING,
        timestamp: v.getFloat64(1, LE),
      };

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

    default:
      throw new Error(
        `Unknown message type byte: 0x${typeByte.toString(16).padStart(2, "0")}`,
      );
  }
}
