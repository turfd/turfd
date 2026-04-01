/** Room code helpers for multiplayer join flow (`ABC123` <-> `turfd-host-ABC123`). */

import type { HostPeerId } from "./hostPeerId";
import { isHostPeerId } from "./hostPeerId";

const PEER_ID_PREFIX = "turfd-host-";
const ROOM_CODE_LENGTH = 6;
const ROOM_CODE_REGEX = /^[A-Z0-9]{6}$/;

declare const __roomCodeBrand: unique symbol;
export type RoomCode = string & { [__roomCodeBrand]: never };

export function isRoomCode(raw: string): raw is RoomCode {
  return ROOM_CODE_REGEX.test(raw);
}

export function normalizeRoomCode(raw: string): RoomCode | null {
  const up = raw.trim().toUpperCase();
  return isRoomCode(up) ? up : null;
}

export function roomCodeToPeerId(code: RoomCode): HostPeerId {
  const peerId = `${PEER_ID_PREFIX}${code}`;
  if (!isHostPeerId(peerId)) {
    throw new Error("Invalid host peer id derived from room code");
  }
  return peerId;
}

export function peerIdToRoomCode(peerId: string): RoomCode | null {
  if (!peerId.startsWith(PEER_ID_PREFIX)) {
    return null;
  }
  const suffix = peerId.slice(PEER_ID_PREFIX.length);
  if (suffix.length !== ROOM_CODE_LENGTH) {
    return null;
  }
  return isRoomCode(suffix) ? suffix : null;
}
