/** Binary network protocol: message IDs, typed payloads, and DataView encode/decode (no JSON on the wire). */

import {
  BinarySerializer,
  type WorldSyncWirePayload,
  type ChunkDataWirePayload,
  type BlockUpdateWirePayload,
} from "./BinarySerializer";
import type { WorkshopModRef } from "../../persistence/IndexedDBStore";
import type { WorldGameMode, WorldGenType } from "../../core/types";
import type { FurnacePersistedChunk } from "../../world/furnace/furnacePersisted";
import type { ChestPersistedChunk } from "../../world/chest/chestPersisted";
import type { SpawnerPersistedChunk } from "../../world/spawner/spawnerPersisted";
import type { SignPersistedChunk } from "../../world/sign/signPersisted";

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
  /** Client → host: request to take items from a chest slot (host will snapshot + give items). */
  CHEST_TAKE_REQUEST = 0x13,
  /** Client → host: request to click a furnace fuel/output slot (host will snapshot + give items). */
  FURNACE_SLOT_REQUEST = 0x14,
  /** Client → host: request to place cursor stack into a chest slot (host will snapshot). */
  CHEST_PUT_REQUEST = 0x15,
  /** Client → host: shift-quick-move a stack from player inventory into chest (host will snapshot). */
  CHEST_QUICKMOVE_TO_CHEST = 0x16,
  /** Host → clients: rain remaining (real-time seconds); 0 = clear. */
  WEATHER_SYNC = 0x17,
  /** Host → clients: lightning flash + thunder cue. */
  WEATHER_LIGHTNING = 0x18,
  /** Client → host: request authoritative chunk (host replies with CHUNK_DATA). */
  CHUNK_REQUEST = 0x19,
  /** Client → host: commit a finished block break (host validates + applies). */
  TERRAIN_BREAK_COMMIT = 0x1a,
  /** Client → host: toggle door latch at clicked cell. */
  TERRAIN_DOOR_TOGGLE = 0x1b,
  /** Client → host: place block / use item on world (see subtype in payload). */
  TERRAIN_PLACE = 0x1c,
  /** Host → requesting client: inventory / tool follow-up after terrain RPC. */
  TERRAIN_ACK = 0x1d,
  /** Host → clients: replicated dropped item spawn. */
  DROP_SPAWN = 0x1e,
  /** Host → clients: remove replicated drop (picked up or merged). */
  DROP_DESPAWN = 0x1f,
  /** Client → host: request pickup of replicated drop by net id. */
  DROP_PICKUP_REQUEST = 0x20,
  /** Client → host: cursor stack thrown into the world (host spawns replicated drop). */
  THROW_CURSOR_STACK = 0x21,
  /** Host → clients: authoritative mob pose + vitals (see flags). */
  ENTITY_STATE = 0x22,
  /** Client → host: melee hit request on replicated mob. */
  ENTITY_HIT_REQUEST = 0x23,
  /** Host → one client: apply environmental / mob damage to that peer’s local player. */
  PLAYER_DAMAGE_APPLIED = 0x24,
  /** Client → host: request sleep/time skip at a bed cell. */
  SLEEP_REQUEST = 0x25,
  /** Host → clients: play sleep transition (fade + pose). */
  SLEEP_TRANSITION = 0x26,
  /** Host → clients: batched block updates (2+ mutations in one tick). */
  BLOCK_UPDATE_BATCH = 0x27,
  /** Peer → host or host → peers: custom skin PNG data for a player. */
  PLAYER_SKIN_DATA = 0x28,
  /** Host → one client: your melee hit landed (damage FX + health bar for attacker only). */
  MOB_HIT_FEEDBACK = 0x29,
  /** Client → host: bow release (host spawns arrow + consumes ammo authoritatively). */
  BOW_FIRE_REQUEST = 0x2a,
  /** Host → clients: replicated arrow projectile spawn. */
  ARROW_SPAWN = 0x2b,
  /** Client → host: melee hit request on a player peer id. */
  PLAYER_HIT_REQUEST = 0x2c,
  /** Host → one client: authoritative teleport to feet world coordinates. */
  PLAYER_TELEPORT = 0x2d,
}

/** Back-compat alias used across the codebase. */
export { MessageType as MsgType };

export interface HandshakeMessage {
  type: MessageType.HANDSHAKE;
  version: number;
  peerId: string;
  displayName: string;
  accountId: string;
  /** Selected skin id; empty string = default skin. */
  skinId: string;
  /** Persisted local anonymous UUID when unsigned; empty when signed in. */
  localGuestUuid: string;
  /** Optional replicated player nametag color (`#rrggbb`). */
  nameColorHex?: string;
  /** Optional replicated player outline glow color (`#rrggbb`). */
  outlineColorHex?: string;
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
  /** Spawner tiles in chunk; omitted when absent on wire. */
  spawners?: SpawnerPersistedChunk[];
  /** Sign tiles in chunk; omitted when absent on wire. */
  signs?: SignPersistedChunk[];
  /** Per-cell flags (e.g. tree no-collision); v10+ wire tail; omitted → client zeros metadata. */
  metadata?: Uint8Array;
};

export type WorldSyncMsg = {
  type: MessageType.WORLD_SYNC;
  seed: number;
  worldTimeMs: number;
  gameMode: WorldGameMode;
  /** Authoritative world generation preset; absent on legacy peers ⇒ `"normal"`. */
  worldGenType: WorldGenType;
  cheatsEnabled: boolean;
};

export type WorldTimeMsg = {
  type: MessageType.WORLD_TIME;
  worldTimeMs: number;
};

export type WeatherSyncMsg = {
  type: MessageType.WEATHER_SYNC;
  rainRemainingSec: number;
};

export type WeatherLightningMsg = {
  type: MessageType.WEATHER_LIGHTNING;
};

export type ChunkRequestMsg = {
  type: MessageType.CHUNK_REQUEST;
  cx: number;
  cy: number;
};

export type TerrainBreakCommitMsg = {
  type: MessageType.TERRAIN_BREAK_COMMIT;
  wx: number;
  wy: number;
  /** 0 = foreground, 1 = background. */
  layer: 0 | 1;
  expectedBlockId?: number;
  expectedBlockKey?: string;
  hotbarSlot: number;
  heldItemId?: number;
  heldItemKey?: string;
};

export type TerrainDoorToggleMsg = {
  type: MessageType.TERRAIN_DOOR_TOGGLE;
  wx: number;
  wy: number;
};

export type TerrainPlaceMsg = {
  type: MessageType.TERRAIN_PLACE;
  subtype: number;
  wx: number;
  wy: number;
  hotbarSlot: number;
  placesBlockId?: number;
  placesBlockKey?: string;
  aux: number;
};

export type TerrainAckMsg = {
  type: MessageType.TERRAIN_ACK;
  ok: boolean;
  /** Client hotbar slot for tool-use / consume. */
  hotbarSlot: number;
  /** Bitmask: see terrainHostPlace ACK_* constants. */
  effects: number;
};

export type DropSpawnMsg = {
  type: MessageType.DROP_SPAWN;
  netId: number;
  itemId: number;
  count: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  damage: number;
  /** Milliseconds of pickup delay remaining (player throws); 0 for block/mob drops. */
  pickupDelayMs?: number;
};

export type DropDespawnMsg = {
  type: MessageType.DROP_DESPAWN;
  netId: number;
};

export type DropPickupRequestMsg = {
  type: MessageType.DROP_PICKUP_REQUEST;
  netId: number;
};

export type ThrowCursorStackMsg = {
  type: MessageType.THROW_CURSOR_STACK;
  itemId: number;
  count: number;
  damage: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
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

export type ChestTakeRequestMsg = {
  type: MessageType.CHEST_TAKE_REQUEST;
  /** Chest anchor world coordinates. */
  wx: number;
  wy: number;
  slotIndex: number;
  /** 0 = take stack, 2 = take one. */
  button: number;
};

export type FurnaceSlotRequestMsg = {
  type: MessageType.FURNACE_SLOT_REQUEST;
  wx: number;
  wy: number;
  /** 0 = fuel slot, 1 = output slot. */
  kind: 0 | 1;
  /** Output slot index (0..2). For fuel slot, must be 0. */
  slotIndex: number;
  /** 0 = take stack, 2 = take one. */
  button: number;
};

export type ChestPutRequestMsg = {
  type: MessageType.CHEST_PUT_REQUEST;
  /** Chest anchor world coordinates. */
  wx: number;
  wy: number;
  slotIndex: number;
  /** 0 = LMB, 2 = RMB (same semantics as applyChestSlotMouse). */
  button: number;
  cursorItemId: number;
  cursorCount: number;
  cursorDamage: number;
};

export type ChestQuickMoveToChestMsg = {
  type: MessageType.CHEST_QUICKMOVE_TO_CHEST;
  wx: number;
  wy: number;
  itemId: number;
  count: number;
  damage: number;
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

export type BlockUpdateBatchEntry = {
  x: number;
  y: number;
  blockId: number;
  layer: number;
  cellMetadata: number;
};

export type BlockUpdateBatchMsg = {
  type: MessageType.BLOCK_UPDATE_BATCH;
  entries: BlockUpdateBatchEntry[];
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
  /** Armor slots: helmet, chestplate, leggings, boots (`0` = empty). Wire v2+; absent on legacy decode → zeros. */
  armorHelmetId?: number;
  armorChestId?: number;
  armorLeggingsId?: number;
  armorBootsId?: number;
  /** Bow draw 0–255 → scaled by client using `BOW_MAX_DRAW_SEC`. */
  bowDrawQuantized?: number;
  /** Reach crosshair in display space (same axes as `InputManager.mouseWorldPos`). */
  aimDisplayX?: number;
  aimDisplayY?: number;
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
  armorHelmetId?: number;
  armorChestId?: number;
  armorLeggingsId?: number;
  armorBootsId?: number;
  bowDrawQuantized?: number;
  aimDisplayX?: number;
  aimDisplayY?: number;
};

export type EntitySpawnMsg = {
  type: MessageType.ENTITY_SPAWN;
  entityId: number;
  entityType: number;
  x: number;
  y: number;
  /** Dye ordinal 0–15; absent on legacy packets (treated as white). */
  woolColor?: number;
  /** Optional spawner-origin visual marker coordinates (block space). */
  spawnerFxWx?: number;
  spawnerFxWy?: number;
};

export type EntityDespawnMsg = {
  type: MessageType.ENTITY_DESPAWN;
  entityId: number;
};

/** Wire: flags bit0 = facingRight, bit1 = panic, bit2 = walking, bit3 = hurtTint, bit4 = attackSwing, bit5 = burning, bit6 = slime onGround, bit7 = slime jump priming (Slime entity type only). */
export const ENTITY_STATE_FLAG_SLIME_ON_GROUND = 1 << 6;
export const ENTITY_STATE_FLAG_SLIME_JUMP_PRIMING = 1 << 7;

export type EntityStateMsg = {
  type: MessageType.ENTITY_STATE;
  entityId: number;
  entityType: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  hp: number;
  flags: number;
  /** Sheep wool dye ordinal; absent on legacy packets. */
  woolColor?: number;
  /** Death pose time remaining in 10ms units (`0` = not dying). Absent if wire buffer has no byte at index 42. */
  deathAnim10Ms?: number;
};

export type EntityHitRequestMsg = {
  type: MessageType.ENTITY_HIT_REQUEST;
  entityId: number;
  /**
   * Optional: held item id at attack time (0 when empty). Added later; older clients may omit.
   */
  heldItemId?: number;
  /**
   * Optional: reserved wire flags (legacy bit 0 = sprint; ignored by Terraria knockback).
   */
  attackFlags?: number;
  /**
   * Optional: legacy wire v4 (byte 8); melee knockback uses attacker feet X vs mob (host), not this.
   */
  facingRight?: boolean;
};

export type PlayerHitRequestMsg = {
  type: MessageType.PLAYER_HIT_REQUEST;
  /** Target player peer id to damage (host validates reach/visibility). */
  targetPeerId: string;
  /** Optional: held item id at attack time (0 when empty). */
  heldItemId?: number;
};

/** Host → client: authoritative damage to the receiving player (e.g. zombie melee). */
export type PlayerDamageAppliedMsg = {
  type: MessageType.PLAYER_DAMAGE_APPLIED;
  damage: number;
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

export type SleepRequestMsg = {
  type: MessageType.SLEEP_REQUEST;
  wx: number;
  wy: number;
};

export type SleepTransitionMsg = {
  type: MessageType.SLEEP_TRANSITION;
  /** 0 = to night, 1 = to morning. */
  kind: 0 | 1;
  /** Total transition duration in milliseconds (clients use for fade timings). */
  durationMs: number;
};

export type PlayerTeleportMsg = {
  type: MessageType.PLAYER_TELEPORT;
  x: number;
  y: number;
};

export type PlayerSkinDataMsg = {
  type: MessageType.PLAYER_SKIN_DATA;
  /** Peer id of the player whose skin data is being sent (for relay). */
  subjectPeerId: string;
  /** Raw PNG bytes of the custom skin sprite sheet. */
  skinPngBytes: Uint8Array;
};

export type MobHitFeedbackMsg = {
  type: MessageType.MOB_HIT_FEEDBACK;
  entityId: number;
  damage: number;
  worldAnchorX: number;
  worldAnchorY: number;
};

export type BowFireRequestMsg = {
  type: MessageType.BOW_FIRE_REQUEST;
  dirX: number;
  dirY: number;
  speedPx: number;
  chargeNorm: number;
  shooterFeetX: number;
  shooterFeetY: number;
};

export type ArrowSpawnMsg = {
  type: MessageType.ARROW_SPAWN;
  netArrowId: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  damage: number;
  shooterFeetX: number;
};

/** Max custom skin PNG size on the wire (256 KB). */
export const PLAYER_SKIN_DATA_MAX_BYTES = 256 * 1024;

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
  | EntityStateMsg
  | EntityHitRequestMsg
  | PlayerHitRequestMsg
  | PlayerDamageAppliedMsg
  | ChatMsg
  | SystemMessageMsg
  | PingMsg
  | GiveItemStackMsg
  | AssignedSpawnMsg
  | SleepRequestMsg
  | SleepTransitionMsg
  | PlayerTeleportMsg
  | ChestTakeRequestMsg
  | FurnaceSlotRequestMsg
  | ChestPutRequestMsg
  | ChestQuickMoveToChestMsg
  | WorldSyncMsg
  | WorldTimeMsg
  | WeatherSyncMsg
  | WeatherLightningMsg
  | ChunkRequestMsg
  | TerrainBreakCommitMsg
  | TerrainDoorToggleMsg
  | TerrainPlaceMsg
  | TerrainAckMsg
  | DropSpawnMsg
  | DropDespawnMsg
  | DropPickupRequestMsg
  | ThrowCursorStackMsg
  | SessionEndedMsg
  | PackStackMsg
  | FurnaceSnapshotMsg
  | ChestSnapshotMsg
  | BlockBreakProgressMsg
  | BlockUpdateBatchMsg
  | PlayerSkinDataMsg
  | MobHitFeedbackMsg
  | BowFireRequestMsg
  | ArrowSpawnMsg;

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
export const PLAYER_STATE_WIRE_BYTE_LENGTH = 57;

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
  armorHelmetId: number,
  armorChestId: number,
  armorLeggingsId: number,
  armorBootsId: number,
  bowDrawQuantized: number,
  aimDisplayX: number,
  aimDisplayY: number,
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
  view.setUint16(40, armorHelmetId & 0xffff, LE);
  view.setUint16(42, armorChestId & 0xffff, LE);
  view.setUint16(44, armorLeggingsId & 0xffff, LE);
  view.setUint16(46, armorBootsId & 0xffff, LE);
  view.setUint8(48, bowDrawQuantized & 0xff);
  view.setFloat32(49, aimDisplayX, LE);
  view.setFloat32(53, aimDisplayY, LE);
}

export function encode(msg: NetworkMessage): ArrayBuffer {
  switch (msg.type) {
    case MessageType.HANDSHAKE:
      return BinarySerializer.serializeHandshake({
        version: msg.version,
        peerId: msg.peerId,
        displayName: msg.displayName,
        accountId: msg.accountId,
        skinId: msg.skinId,
        localGuestUuid: msg.localGuestUuid,
        nameColorHex: msg.nameColorHex ?? "",
        outlineColorHex: msg.outlineColorHex ?? "",
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
        msg.spawners,
        msg.metadata,
        msg.signs,
      );
    }

    case MessageType.FURNACE_SNAPSHOT:
      return BinarySerializer.serializeFurnaceSnapshot(msg.wx, msg.wy, msg.data);

    case MessageType.CHEST_SNAPSHOT:
      return BinarySerializer.serializeChestSnapshot(msg.wx, msg.wy, msg.data);

    case MessageType.CHEST_TAKE_REQUEST: {
      const buf = new ArrayBuffer(11);
      const v = new DataView(buf);
      v.setUint8(0, MessageType.CHEST_TAKE_REQUEST);
      v.setInt32(1, msg.wx, LE);
      v.setInt32(5, msg.wy, LE);
      v.setUint8(9, msg.slotIndex & 0xff);
      v.setUint8(10, msg.button & 0xff);
      return buf;
    }

    case MessageType.FURNACE_SLOT_REQUEST: {
      const buf = new ArrayBuffer(12);
      const v = new DataView(buf);
      v.setUint8(0, MessageType.FURNACE_SLOT_REQUEST);
      v.setInt32(1, msg.wx, LE);
      v.setInt32(5, msg.wy, LE);
      v.setUint8(9, msg.kind & 0xff);
      v.setUint8(10, msg.slotIndex & 0xff);
      v.setUint8(11, msg.button & 0xff);
      return buf;
    }

    case MessageType.CHEST_PUT_REQUEST: {
      const buf = new ArrayBuffer(1 + 4 + 4 + 1 + 1 + 2 + 2 + 2);
      const v = new DataView(buf);
      v.setUint8(0, MessageType.CHEST_PUT_REQUEST);
      v.setInt32(1, msg.wx, LE);
      v.setInt32(5, msg.wy, LE);
      v.setUint8(9, msg.slotIndex & 0xff);
      v.setUint8(10, msg.button & 0xff);
      v.setUint16(11, msg.cursorItemId & 0xffff, LE);
      v.setUint16(13, msg.cursorCount & 0xffff, LE);
      v.setUint16(15, msg.cursorDamage & 0xffff, LE);
      return buf;
    }

    case MessageType.CHEST_QUICKMOVE_TO_CHEST: {
      const buf = new ArrayBuffer(1 + 4 + 4 + 2 + 2 + 2);
      const v = new DataView(buf);
      v.setUint8(0, MessageType.CHEST_QUICKMOVE_TO_CHEST);
      v.setInt32(1, msg.wx, LE);
      v.setInt32(5, msg.wy, LE);
      v.setUint16(9, msg.itemId & 0xffff, LE);
      v.setUint16(11, msg.count & 0xffff, LE);
      v.setUint16(13, msg.damage & 0xffff, LE);
      return buf;
    }

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
        msg.armorHelmetId ?? 0,
        msg.armorChestId ?? 0,
        msg.armorLeggingsId ?? 0,
        msg.armorBootsId ?? 0,
        msg.bowDrawQuantized ?? 0,
        msg.aimDisplayX ?? 0,
        msg.aimDisplayY ?? 0,
      );
      return buf;
    }

    case MessageType.ENTITY_SPAWN: {
      const wc = msg.woolColor !== undefined ? msg.woolColor & 0xff : 0;
      const hasSpawnerFx = msg.spawnerFxWx !== undefined && msg.spawnerFxWy !== undefined;
      const buf = new ArrayBuffer(hasSpawnerFx ? 32 : 24);
      const v = new DataView(buf);
      v.setUint8(0, MessageType.ENTITY_SPAWN);
      v.setUint32(1, msg.entityId, LE);
      v.setUint16(5, msg.entityType, LE);
      v.setFloat64(7, msg.x, LE);
      v.setFloat64(15, msg.y, LE);
      v.setUint8(23, wc);
      if (hasSpawnerFx) {
        v.setInt32(24, msg.spawnerFxWx as number, LE);
        v.setInt32(28, msg.spawnerFxWy as number, LE);
      }
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

    case MessageType.SLEEP_REQUEST: {
      const buf = new ArrayBuffer(9);
      const v = new DataView(buf);
      v.setUint8(0, MessageType.SLEEP_REQUEST);
      v.setInt32(1, msg.wx, LE);
      v.setInt32(5, msg.wy, LE);
      return buf;
    }

    case MessageType.SLEEP_TRANSITION: {
      const buf = new ArrayBuffer(6);
      const v = new DataView(buf);
      v.setUint8(0, MessageType.SLEEP_TRANSITION);
      v.setUint8(1, msg.kind & 0xff);
      v.setUint32(2, msg.durationMs >>> 0, LE);
      return buf;
    }

    case MessageType.PLAYER_TELEPORT: {
      const buf = new ArrayBuffer(17);
      const v = new DataView(buf);
      v.setUint8(0, MessageType.PLAYER_TELEPORT);
      v.setFloat64(1, msg.x, LE);
      v.setFloat64(9, msg.y, LE);
      return buf;
    }

    case MessageType.WORLD_SYNC: {
      return BinarySerializer.serializeWorldSync(
        msg.seed,
        msg.worldTimeMs,
        msg.gameMode,
        msg.worldGenType,
        msg.cheatsEnabled,
      );
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

    case MessageType.WEATHER_SYNC: {
      const buf = new ArrayBuffer(9);
      const view = new DataView(buf);
      view.setUint8(0, MessageType.WEATHER_SYNC);
      view.setFloat64(1, msg.rainRemainingSec, LE);
      return buf;
    }

    case MessageType.WEATHER_LIGHTNING: {
      const buf = new ArrayBuffer(1);
      new DataView(buf).setUint8(0, MessageType.WEATHER_LIGHTNING);
      return buf;
    }

    case MessageType.CHUNK_REQUEST: {
      const buf = new ArrayBuffer(9);
      const v = new DataView(buf);
      v.setUint8(0, MessageType.CHUNK_REQUEST);
      v.setInt32(1, msg.cx, LE);
      v.setInt32(5, msg.cy, LE);
      return buf;
    }

    case MessageType.TERRAIN_BREAK_COMMIT: {
      const expectedB = textEnc.encode(msg.expectedBlockKey ?? "");
      const heldB = textEnc.encode(msg.heldItemKey ?? "");
      const buf = new ArrayBuffer(16 + 2 + expectedB.length + 2 + heldB.length);
      const v = new DataView(buf);
      v.setUint8(0, MessageType.TERRAIN_BREAK_COMMIT);
      v.setInt32(1, msg.wx, LE);
      v.setInt32(5, msg.wy, LE);
      v.setUint8(9, msg.layer & 1);
      v.setUint16(10, (msg.expectedBlockId ?? 0) & 0xffff, LE);
      v.setUint8(12, msg.hotbarSlot & 0xff);
      v.setUint16(13, (msg.heldItemId ?? 0) & 0xffff, LE);
      v.setUint16(15, expectedB.length, LE);
      let o = 17;
      new Uint8Array(buf, o, expectedB.length).set(expectedB);
      o += expectedB.length;
      v.setUint16(o, heldB.length, LE);
      o += 2;
      new Uint8Array(buf, o, heldB.length).set(heldB);
      return buf;
    }

    case MessageType.TERRAIN_DOOR_TOGGLE: {
      const buf = new ArrayBuffer(9);
      const v = new DataView(buf);
      v.setUint8(0, MessageType.TERRAIN_DOOR_TOGGLE);
      v.setInt32(1, msg.wx, LE);
      v.setInt32(5, msg.wy, LE);
      return buf;
    }

    case MessageType.TERRAIN_PLACE: {
      const keyB = textEnc.encode(msg.placesBlockKey ?? "");
      const buf = new ArrayBuffer(16 + 2 + keyB.length);
      const v = new DataView(buf);
      v.setUint8(0, MessageType.TERRAIN_PLACE);
      v.setUint8(1, msg.subtype & 0xff);
      v.setInt32(2, msg.wx, LE);
      v.setInt32(6, msg.wy, LE);
      v.setUint8(10, msg.hotbarSlot & 0xff);
      v.setUint16(11, (msg.placesBlockId ?? 0) & 0xffff, LE);
      v.setUint16(13, msg.aux & 0xffff, LE);
      v.setUint16(15, keyB.length, LE);
      new Uint8Array(buf, 17, keyB.length).set(keyB);
      return buf;
    }

    case MessageType.TERRAIN_ACK: {
      const buf = new ArrayBuffer(4);
      const v = new DataView(buf);
      v.setUint8(0, MessageType.TERRAIN_ACK);
      v.setUint8(1, msg.ok ? 1 : 0);
      v.setUint8(2, msg.hotbarSlot & 0xff);
      v.setUint8(3, msg.effects & 0xff);
      return buf;
    }

    case MessageType.DROP_SPAWN: {
      const buf = new ArrayBuffer(41);
      const v = new DataView(buf);
      v.setUint8(0, MessageType.DROP_SPAWN);
      v.setUint32(1, msg.netId >>> 0, LE);
      v.setUint32(5, msg.itemId >>> 0, LE);
      v.setUint32(9, msg.count >>> 0, LE);
      v.setFloat64(13, msg.x, LE);
      v.setFloat64(21, msg.y, LE);
      v.setFloat32(29, msg.vx, LE);
      v.setFloat32(33, msg.vy, LE);
      v.setUint16(37, msg.damage & 0xffff, LE);
      const pdm = Math.min(65535, Math.max(0, msg.pickupDelayMs ?? 0));
      v.setUint16(39, pdm & 0xffff, LE);
      return buf;
    }

    case MessageType.DROP_DESPAWN: {
      const buf = new ArrayBuffer(5);
      const v = new DataView(buf);
      v.setUint8(0, MessageType.DROP_DESPAWN);
      v.setUint32(1, msg.netId >>> 0, LE);
      return buf;
    }

    case MessageType.DROP_PICKUP_REQUEST: {
      const buf = new ArrayBuffer(5);
      const v = new DataView(buf);
      v.setUint8(0, MessageType.DROP_PICKUP_REQUEST);
      v.setUint32(1, msg.netId >>> 0, LE);
      return buf;
    }

    case MessageType.THROW_CURSOR_STACK: {
      const buf = new ArrayBuffer(41);
      const v = new DataView(buf);
      v.setUint8(0, MessageType.THROW_CURSOR_STACK);
      v.setUint32(1, msg.itemId >>> 0, LE);
      v.setUint32(5, msg.count >>> 0, LE);
      v.setUint32(9, msg.damage >>> 0, LE);
      v.setFloat64(13, msg.x, LE);
      v.setFloat64(21, msg.y, LE);
      v.setFloat64(29, msg.vx, LE);
      v.setFloat64(37, msg.vy, LE);
      return buf;
    }

    case MessageType.ENTITY_STATE: {
      const buf = new ArrayBuffer(43);
      const v = new DataView(buf);
      v.setUint8(0, MessageType.ENTITY_STATE);
      v.setUint32(1, msg.entityId >>> 0, LE);
      v.setUint16(5, msg.entityType & 0xffff, LE);
      v.setFloat64(7, msg.x, LE);
      v.setFloat64(15, msg.y, LE);
      v.setFloat64(23, msg.vx, LE);
      v.setFloat64(31, msg.vy, LE);
      v.setUint8(39, msg.hp & 0xff);
      v.setUint8(40, msg.flags & 0xff);
      v.setUint8(41, (msg.woolColor !== undefined ? msg.woolColor : 0) & 0xff);
      v.setUint8(42, (msg.deathAnim10Ms !== undefined ? msg.deathAnim10Ms : 0) & 0xff);
      return buf;
    }

    case MessageType.ENTITY_HIT_REQUEST: {
      // v2: heldItemId (uint16). v3: + attackFlags (uint8). v4: + facingRight (uint8) for melee KB.
      const held = msg.heldItemId ?? 0;
      const flags = msg.attackFlags ?? 0;
      const buf = new ArrayBuffer(9);
      const v = new DataView(buf);
      v.setUint8(0, MessageType.ENTITY_HIT_REQUEST);
      v.setUint32(1, msg.entityId >>> 0, LE);
      v.setUint16(5, held & 0xffff, LE);
      v.setUint8(7, flags & 0xff);
      v.setUint8(8, msg.facingRight === true ? 1 : 0);
      return buf;
    }

    case MessageType.PLAYER_HIT_REQUEST: {
      const target = textEnc.encode(msg.targetPeerId);
      if (target.byteLength > CHAT_PEER_ID_MAX) {
        throw new Error("PLAYER_HIT_REQUEST: targetPeerId too long");
      }
      const buf = new ArrayBuffer(1 + 2 + target.byteLength + 2);
      const v = new DataView(buf);
      v.setUint8(0, MessageType.PLAYER_HIT_REQUEST);
      v.setUint16(1, target.byteLength, LE);
      new Uint8Array(buf, 3, target.byteLength).set(target);
      v.setUint16(3 + target.byteLength, (msg.heldItemId ?? 0) & 0xffff, LE);
      return buf;
    }

    case MessageType.PLAYER_DAMAGE_APPLIED: {
      const buf = new ArrayBuffer(3);
      const v = new DataView(buf);
      v.setUint8(0, MessageType.PLAYER_DAMAGE_APPLIED);
      v.setUint16(1, msg.damage & 0xffff, LE);
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
      const buf = new ArrayBuffer(1 + 2 + sid.byteLength + 54);
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
        o++,
        msg.miningVisual ? PLAYER_STATE_FLAG_MINING_VISUAL : 0,
      );
      view.setUint16(o, (msg.armorHelmetId ?? 0) & 0xffff, LE);
      o += 2;
      view.setUint16(o, (msg.armorChestId ?? 0) & 0xffff, LE);
      o += 2;
      view.setUint16(o, (msg.armorLeggingsId ?? 0) & 0xffff, LE);
      o += 2;
      view.setUint16(o, (msg.armorBootsId ?? 0) & 0xffff, LE);
      o += 2;
      view.setUint8(o++, (msg.bowDrawQuantized ?? 0) & 0xff);
      view.setFloat32(o, msg.aimDisplayX ?? 0, LE);
      o += 4;
      view.setFloat32(o, msg.aimDisplayY ?? 0, LE);
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

    case MessageType.BLOCK_UPDATE_BATCH: {
      const count = msg.entries.length;
      const ENTRY_BYTES = 4 + 4 + 2 + 1 + 1;
      const buf = new ArrayBuffer(1 + 2 + count * ENTRY_BYTES);
      const view = new DataView(buf);
      view.setUint8(0, MessageType.BLOCK_UPDATE_BATCH);
      view.setUint16(1, count, LE);
      let off = 3;
      for (let i = 0; i < count; i++) {
        const e = msg.entries[i]!;
        view.setInt32(off, e.x, LE); off += 4;
        view.setInt32(off, e.y, LE); off += 4;
        view.setUint16(off, e.blockId, LE); off += 2;
        view.setUint8(off++, e.layer);
        view.setUint8(off++, e.cellMetadata);
      }
      return buf;
    }

    case MessageType.PLAYER_SKIN_DATA: {
      const peerBytes = textEnc.encode(msg.subjectPeerId);
      const buf = new ArrayBuffer(1 + 2 + peerBytes.length + 4 + msg.skinPngBytes.length);
      const view = new DataView(buf);
      let off = 0;
      view.setUint8(off, MessageType.PLAYER_SKIN_DATA); off += 1;
      view.setUint16(off, peerBytes.length, LE); off += 2;
      new Uint8Array(buf, off, peerBytes.length).set(peerBytes); off += peerBytes.length;
      view.setUint32(off, msg.skinPngBytes.length, LE); off += 4;
      new Uint8Array(buf, off, msg.skinPngBytes.length).set(msg.skinPngBytes);
      return buf;
    }

    case MessageType.MOB_HIT_FEEDBACK: {
      const buf = new ArrayBuffer(1 + 4 + 2 + 8 + 8);
      const view = new DataView(buf);
      view.setUint8(0, MessageType.MOB_HIT_FEEDBACK);
      view.setUint32(1, msg.entityId >>> 0, LE);
      view.setUint16(5, msg.damage & 0xffff, LE);
      view.setFloat64(7, msg.worldAnchorX, LE);
      view.setFloat64(15, msg.worldAnchorY, LE);
      return buf;
    }

    case MessageType.BOW_FIRE_REQUEST: {
      const buf = new ArrayBuffer(1 + 8 * 5);
      const view = new DataView(buf);
      view.setUint8(0, MessageType.BOW_FIRE_REQUEST);
      view.setFloat64(1, msg.dirX, LE);
      view.setFloat64(9, msg.dirY, LE);
      view.setFloat64(17, msg.speedPx, LE);
      view.setFloat64(25, msg.chargeNorm, LE);
      view.setFloat64(33, msg.shooterFeetX, LE);
      view.setFloat64(41, msg.shooterFeetY, LE);
      return buf;
    }

    case MessageType.ARROW_SPAWN: {
      const buf = new ArrayBuffer(1 + 4 + 8 * 6);
      const view = new DataView(buf);
      view.setUint8(0, MessageType.ARROW_SPAWN);
      view.setUint32(1, msg.netArrowId >>> 0, LE);
      view.setFloat64(5, msg.x, LE);
      view.setFloat64(13, msg.y, LE);
      view.setFloat64(21, msg.vx, LE);
      view.setFloat64(29, msg.vy, LE);
      view.setFloat64(37, msg.damage, LE);
      view.setFloat64(45, msg.shooterFeetX, LE);
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
        skinId: p.skinId,
        localGuestUuid: p.localGuestUuid,
        nameColorHex: p.nameColorHex,
        outlineColorHex: p.outlineColorHex,
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
      if (payload.spawners !== undefined) {
        out.spawners = payload.spawners;
      }
      if (payload.signs !== undefined) {
        out.signs = payload.signs;
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

    case MessageType.CHEST_TAKE_REQUEST: {
      if (v.byteLength < 11) {
        throw new Error("CHEST_TAKE_REQUEST: buffer too short");
      }
      return {
        type: MessageType.CHEST_TAKE_REQUEST,
        wx: v.getInt32(1, LE),
        wy: v.getInt32(5, LE),
        slotIndex: v.getUint8(9),
        button: v.getUint8(10),
      };
    }

    case MessageType.FURNACE_SLOT_REQUEST: {
      if (v.byteLength < 12) {
        throw new Error("FURNACE_SLOT_REQUEST: buffer too short");
      }
      const kind = v.getUint8(9);
      return {
        type: MessageType.FURNACE_SLOT_REQUEST,
        wx: v.getInt32(1, LE),
        wy: v.getInt32(5, LE),
        kind: (kind === 0 ? 0 : 1) as 0 | 1,
        slotIndex: v.getUint8(10),
        button: v.getUint8(11),
      };
    }

    case MessageType.CHEST_PUT_REQUEST: {
      if (v.byteLength < 17) {
        throw new Error("CHEST_PUT_REQUEST: buffer too short");
      }
      return {
        type: MessageType.CHEST_PUT_REQUEST,
        wx: v.getInt32(1, LE),
        wy: v.getInt32(5, LE),
        slotIndex: v.getUint8(9),
        button: v.getUint8(10),
        cursorItemId: v.getUint16(11, LE),
        cursorCount: v.getUint16(13, LE),
        cursorDamage: v.getUint16(15, LE),
      };
    }

    case MessageType.CHEST_QUICKMOVE_TO_CHEST: {
      if (v.byteLength < 15) {
        throw new Error("CHEST_QUICKMOVE_TO_CHEST: buffer too short");
      }
      return {
        type: MessageType.CHEST_QUICKMOVE_TO_CHEST,
        wx: v.getInt32(1, LE),
        wy: v.getInt32(5, LE),
        itemId: v.getUint16(9, LE),
        count: v.getUint16(11, LE),
        damage: v.getUint16(13, LE),
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
      let armorHelmetId = 0;
      let armorChestId = 0;
      let armorLeggingsId = 0;
      let armorBootsId = 0;
      let bowDrawQuantized = 0;
      let aimDisplayX = 0;
      let aimDisplayY = 0;
      if (v.byteLength >= 40) {
        hotbarSlot = v.getUint8(36);
        heldItemId = v.getUint16(37, LE);
        miningVisual =
          (v.getUint8(39) & PLAYER_STATE_FLAG_MINING_VISUAL) !== 0;
      }
      if (v.byteLength >= 57) {
        armorHelmetId = v.getUint16(40, LE);
        armorChestId = v.getUint16(42, LE);
        armorLeggingsId = v.getUint16(44, LE);
        armorBootsId = v.getUint16(46, LE);
        bowDrawQuantized = v.getUint8(48);
        aimDisplayX = v.getFloat32(49, LE);
        aimDisplayY = v.getFloat32(53, LE);
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
        armorHelmetId,
        armorChestId,
        armorLeggingsId,
        armorBootsId,
        bowDrawQuantized,
        aimDisplayX,
        aimDisplayY,
      };
    }

    case MessageType.ENTITY_SPAWN: {
      const woolColor = v.byteLength >= 24 ? v.getUint8(23) : 0;
      return {
        type: MessageType.ENTITY_SPAWN,
        entityId: v.getUint32(1, LE),
        entityType: v.getUint16(5, LE),
        x: v.getFloat64(7, LE),
        y: v.getFloat64(15, LE),
        woolColor,
        ...(v.byteLength >= 32
          ? { spawnerFxWx: v.getInt32(24, LE), spawnerFxWy: v.getInt32(28, LE) }
          : {}),
      };
    }

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

    case MessageType.SLEEP_REQUEST: {
      if (v.byteLength < 9) {
        throw new Error("SLEEP_REQUEST: buffer too short");
      }
      return {
        type: MessageType.SLEEP_REQUEST,
        wx: v.getInt32(1, LE),
        wy: v.getInt32(5, LE),
      };
    }

    case MessageType.SLEEP_TRANSITION: {
      if (v.byteLength < 6) {
        throw new Error("SLEEP_TRANSITION: buffer too short");
      }
      const kindByte = v.getUint8(1);
      return {
        type: MessageType.SLEEP_TRANSITION,
        kind: (kindByte === 1 ? 1 : 0) as 0 | 1,
        durationMs: v.getUint32(2, LE),
      };
    }

    case MessageType.PLAYER_TELEPORT: {
      if (v.byteLength < 17) {
        throw new Error("PLAYER_TELEPORT: buffer too short");
      }
      return {
        type: MessageType.PLAYER_TELEPORT,
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
        gameMode: payload.gameMode,
        worldGenType: payload.worldGenType,
        cheatsEnabled: payload.cheatsEnabled,
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

    case MessageType.WEATHER_SYNC: {
      if (v.byteLength < 9) {
        throw new Error("WEATHER_SYNC: buffer too short");
      }
      return {
        type: MessageType.WEATHER_SYNC,
        rainRemainingSec: v.getFloat64(1, LE),
      };
    }

    case MessageType.WEATHER_LIGHTNING: {
      return { type: MessageType.WEATHER_LIGHTNING };
    }

    case MessageType.CHUNK_REQUEST: {
      if (v.byteLength < 9) {
        throw new Error("CHUNK_REQUEST: buffer too short");
      }
      return {
        type: MessageType.CHUNK_REQUEST,
        cx: v.getInt32(1, LE),
        cy: v.getInt32(5, LE),
      };
    }

    case MessageType.TERRAIN_BREAK_COMMIT: {
      if (v.byteLength < 16) {
        throw new Error("TERRAIN_BREAK_COMMIT: buffer too short");
      }
      let expectedBlockKey: string | undefined;
      let heldItemKey: string | undefined;
      if (v.byteLength >= 18) {
        const expectedLen = v.getUint16(15, LE);
        let o = 17;
        if (o + expectedLen <= v.byteLength) {
          expectedBlockKey = textDec.decode(new Uint8Array(buf, o, expectedLen));
          o += expectedLen;
          if (o + 2 <= v.byteLength) {
            const heldLen = v.getUint16(o, LE);
            o += 2;
            if (o + heldLen <= v.byteLength) {
              heldItemKey = textDec.decode(new Uint8Array(buf, o, heldLen));
            }
          }
        }
      }
      return {
        type: MessageType.TERRAIN_BREAK_COMMIT,
        wx: v.getInt32(1, LE),
        wy: v.getInt32(5, LE),
        layer: v.getUint8(9) === 1 ? 1 : 0,
        expectedBlockId: v.getUint16(10, LE),
        ...(expectedBlockKey !== undefined ? { expectedBlockKey } : {}),
        hotbarSlot: v.getUint8(12),
        heldItemId: v.getUint16(13, LE),
        ...(heldItemKey !== undefined ? { heldItemKey } : {}),
      };
    }

    case MessageType.TERRAIN_DOOR_TOGGLE: {
      if (v.byteLength < 9) {
        throw new Error("TERRAIN_DOOR_TOGGLE: buffer too short");
      }
      return {
        type: MessageType.TERRAIN_DOOR_TOGGLE,
        wx: v.getInt32(1, LE),
        wy: v.getInt32(5, LE),
      };
    }

    case MessageType.TERRAIN_PLACE: {
      if (v.byteLength < 16) {
        throw new Error("TERRAIN_PLACE: buffer too short");
      }
      let placesBlockKey: string | undefined;
      if (v.byteLength >= 18) {
        const keyLen = v.getUint16(15, LE);
        if (17 + keyLen <= v.byteLength) {
          placesBlockKey = textDec.decode(new Uint8Array(buf, 17, keyLen));
        }
      }
      return {
        type: MessageType.TERRAIN_PLACE,
        subtype: v.getUint8(1),
        wx: v.getInt32(2, LE),
        wy: v.getInt32(6, LE),
        hotbarSlot: v.getUint8(10),
        placesBlockId: v.getUint16(11, LE),
        ...(placesBlockKey !== undefined ? { placesBlockKey } : {}),
        aux: v.getUint16(13, LE),
      };
    }

    case MessageType.TERRAIN_ACK: {
      if (v.byteLength < 4) {
        throw new Error("TERRAIN_ACK: buffer too short");
      }
      return {
        type: MessageType.TERRAIN_ACK,
        ok: v.getUint8(1) !== 0,
        hotbarSlot: v.getUint8(2),
        effects: v.getUint8(3),
      };
    }

    case MessageType.DROP_SPAWN: {
      if (v.byteLength < 39) {
        throw new Error("DROP_SPAWN: buffer too short");
      }
      return {
        type: MessageType.DROP_SPAWN,
        netId: v.getUint32(1, LE),
        itemId: v.getUint32(5, LE),
        count: v.getUint32(9, LE),
        x: v.getFloat64(13, LE),
        y: v.getFloat64(21, LE),
        vx: v.getFloat32(29, LE),
        vy: v.getFloat32(33, LE),
        damage: v.getUint16(37, LE),
        pickupDelayMs: v.byteLength >= 41 ? v.getUint16(39, LE) : 0,
      };
    }

    case MessageType.DROP_DESPAWN: {
      if (v.byteLength < 5) {
        throw new Error("DROP_DESPAWN: buffer too short");
      }
      return {
        type: MessageType.DROP_DESPAWN,
        netId: v.getUint32(1, LE),
      };
    }

    case MessageType.DROP_PICKUP_REQUEST: {
      if (v.byteLength < 5) {
        throw new Error("DROP_PICKUP_REQUEST: buffer too short");
      }
      return {
        type: MessageType.DROP_PICKUP_REQUEST,
        netId: v.getUint32(1, LE),
      };
    }

    case MessageType.THROW_CURSOR_STACK: {
      if (v.byteLength < 41) {
        throw new Error("THROW_CURSOR_STACK: buffer too short");
      }
      return {
        type: MessageType.THROW_CURSOR_STACK,
        itemId: v.getUint32(1, LE),
        count: v.getUint32(5, LE),
        damage: v.getUint32(9, LE),
        x: v.getFloat64(13, LE),
        y: v.getFloat64(21, LE),
        vx: v.getFloat64(29, LE),
        vy: v.getFloat64(37, LE),
      };
    }

    case MessageType.ENTITY_STATE: {
      if (v.byteLength < 41) {
        throw new Error("ENTITY_STATE: buffer too short");
      }
      const woolColor = v.byteLength >= 43 ? v.getUint8(41) : 0;
      const deathAnim10Ms = v.byteLength >= 43 ? v.getUint8(42) : 0;
      return {
        type: MessageType.ENTITY_STATE,
        entityId: v.getUint32(1, LE),
        entityType: v.getUint16(5, LE),
        x: v.getFloat64(7, LE),
        y: v.getFloat64(15, LE),
        vx: v.getFloat64(23, LE),
        vy: v.getFloat64(31, LE),
        hp: v.getUint8(39),
        flags: v.getUint8(40),
        woolColor,
        ...(deathAnim10Ms !== 0 ? { deathAnim10Ms } : {}),
      };
    }

    case MessageType.ENTITY_HIT_REQUEST: {
      if (v.byteLength < 5) {
        throw new Error("ENTITY_HIT_REQUEST: buffer too short");
      }
      const heldItemId = v.byteLength >= 7 ? v.getUint16(5, LE) : 0;
      const attackFlags = v.byteLength >= 8 ? v.getUint8(7) : 0;
      return {
        type: MessageType.ENTITY_HIT_REQUEST,
        entityId: v.getUint32(1, LE),
        ...(heldItemId !== 0 ? { heldItemId } : {}),
        ...(attackFlags !== 0 ? { attackFlags } : {}),
        ...(v.byteLength >= 9 ? { facingRight: v.getUint8(8) !== 0 } : {}),
      };
    }

    case MessageType.PLAYER_HIT_REQUEST: {
      if (v.byteLength < 5) {
        throw new Error("PLAYER_HIT_REQUEST: buffer too short");
      }
      const targetLen = v.getUint16(1, LE);
      if (targetLen > CHAT_PEER_ID_MAX || v.byteLength < 3 + targetLen + 2) {
        throw new Error("PLAYER_HIT_REQUEST: invalid target length");
      }
      const targetPeerId = textDec.decode(new Uint8Array(buf, 3, targetLen));
      const heldItemId = v.getUint16(3 + targetLen, LE);
      return {
        type: MessageType.PLAYER_HIT_REQUEST,
        targetPeerId,
        ...(heldItemId !== 0 ? { heldItemId } : {}),
      };
    }

    case MessageType.PLAYER_DAMAGE_APPLIED: {
      if (v.byteLength < 3) {
        throw new Error("PLAYER_DAMAGE_APPLIED: buffer too short");
      }
      return {
        type: MessageType.PLAYER_DAMAGE_APPLIED,
        damage: v.getUint16(1, LE),
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
      let armorHelmetId = 0;
      let armorChestId = 0;
      let armorLeggingsId = 0;
      let armorBootsId = 0;
      let bowDrawQuantized = 0;
      let aimDisplayX = 0;
      let aimDisplayY = 0;
      if (v.byteLength >= o + 4) {
        hotbarSlot = v.getUint8(o);
        o += 1;
        heldItemId = v.getUint16(o, LE);
        o += 2;
        miningVisual =
          (v.getUint8(o) & PLAYER_STATE_FLAG_MINING_VISUAL) !== 0;
        o += 1;
      }
      if (v.byteLength >= o + 17) {
        armorHelmetId = v.getUint16(o, LE);
        o += 2;
        armorChestId = v.getUint16(o, LE);
        o += 2;
        armorLeggingsId = v.getUint16(o, LE);
        o += 2;
        armorBootsId = v.getUint16(o, LE);
        o += 2;
        bowDrawQuantized = v.getUint8(o);
        o += 1;
        aimDisplayX = v.getFloat32(o, LE);
        o += 4;
        aimDisplayY = v.getFloat32(o, LE);
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
        armorHelmetId,
        armorChestId,
        armorLeggingsId,
        armorBootsId,
        bowDrawQuantized,
        aimDisplayX,
        aimDisplayY,
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

    case MessageType.BLOCK_UPDATE_BATCH: {
      if (v.byteLength < 3) {
        throw new Error("BLOCK_UPDATE_BATCH: buffer too short");
      }
      const count = v.getUint16(1, LE);
      const ENTRY_BYTES = 4 + 4 + 2 + 1 + 1;
      if (v.byteLength < 3 + count * ENTRY_BYTES) {
        throw new Error("BLOCK_UPDATE_BATCH: truncated");
      }
      const entries: BlockUpdateBatchEntry[] = [];
      let off = 3;
      for (let i = 0; i < count; i++) {
        const x = v.getInt32(off, LE); off += 4;
        const y = v.getInt32(off, LE); off += 4;
        const blockId = v.getUint16(off, LE); off += 2;
        const layer = v.getUint8(off++);
        const cellMetadata = v.getUint8(off++);
        entries.push({ x, y, blockId, layer, cellMetadata });
      }
      return {
        type: MessageType.BLOCK_UPDATE_BATCH,
        entries,
      };
    }

    case MessageType.PLAYER_SKIN_DATA: {
      if (v.byteLength < 7) {
        throw new Error("PLAYER_SKIN_DATA: buffer too short");
      }
      let off = 1;
      const peerLen = v.getUint16(off, LE); off += 2;
      if (off + peerLen + 4 > v.byteLength) {
        throw new Error("PLAYER_SKIN_DATA: truncated peer id");
      }
      const subjectPeerId = textDec.decode(new Uint8Array(buf, off, peerLen)); off += peerLen;
      const pngLen = v.getUint32(off, LE); off += 4;
      if (off + pngLen > v.byteLength) {
        throw new Error("PLAYER_SKIN_DATA: truncated PNG data");
      }
      const skinPngBytes = new Uint8Array(buf, off, pngLen);
      return {
        type: MessageType.PLAYER_SKIN_DATA,
        subjectPeerId,
        skinPngBytes,
      };
    }

    case MessageType.MOB_HIT_FEEDBACK: {
      if (v.byteLength < 23) {
        throw new Error("MOB_HIT_FEEDBACK: buffer too short");
      }
      return {
        type: MessageType.MOB_HIT_FEEDBACK,
        entityId: v.getUint32(1, LE),
        damage: v.getUint16(5, LE),
        worldAnchorX: v.getFloat64(7, LE),
        worldAnchorY: v.getFloat64(15, LE),
      };
    }

    case MessageType.BOW_FIRE_REQUEST: {
      if (v.byteLength < 49) {
        throw new Error("BOW_FIRE_REQUEST: buffer too short");
      }
      return {
        type: MessageType.BOW_FIRE_REQUEST,
        dirX: v.getFloat64(1, LE),
        dirY: v.getFloat64(9, LE),
        speedPx: v.getFloat64(17, LE),
        chargeNorm: v.getFloat64(25, LE),
        shooterFeetX: v.getFloat64(33, LE),
        shooterFeetY: v.getFloat64(41, LE),
      };
    }

    case MessageType.ARROW_SPAWN: {
      if (v.byteLength < 53) {
        throw new Error("ARROW_SPAWN: buffer too short");
      }
      return {
        type: MessageType.ARROW_SPAWN,
        netArrowId: v.getUint32(1, LE),
        x: v.getFloat64(5, LE),
        y: v.getFloat64(13, LE),
        vx: v.getFloat64(21, LE),
        vy: v.getFloat64(29, LE),
        damage: v.getFloat64(37, LE),
        shooterFeetX: v.getFloat64(45, LE),
      };
    }

    default:
      throw new Error(
        `Unknown message type byte: 0x${typeByte.toString(16).padStart(2, "0")}`,
      );
  }
}
