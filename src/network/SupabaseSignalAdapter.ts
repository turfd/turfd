/** Publish and resolve Stratum room codes via Supabase (authenticated hosts only). */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { IAuthProvider } from "../auth/IAuthProvider";
import type { HostPeerId } from "./hostPeerId";
import { isHostPeerId } from "./hostPeerId";
import type { RoomCode } from "./roomCode";

/** Metadata sent with `upsert_stratum_room_session` (room title ≠ world file name). */
export type RoomPublishMeta = {
  roomTitle: string;
  motd: string;
  /** Save display name shown in the directory. */
  worldName: string;
  isPrivate: boolean;
  /** Required when `isPrivate`; hashed server-side only. */
  passwordPlain?: string;
};

export class SupabaseSignalAdapter {
  private readonly client: SupabaseClient;

  private readonly auth: IAuthProvider;

  constructor(client: SupabaseClient, auth: IAuthProvider) {
    this.client = client;
    this.auth = auth;
  }

  /**
   * Registers this host's room for cross-client discovery. No-op if not signed in.
   * Uses RPC `upsert_stratum_room_session` (password hashing and RLS on the table).
   */
  async publishRoom(
    roomCode: RoomCode,
    hostPeerId: HostPeerId,
    meta?: RoomPublishMeta,
  ): Promise<void> {
    const session = this.auth.getSession();
    if (session === null) {
      return;
    }
    const title = meta?.roomTitle?.trim() || "Room";
    const motd = meta?.motd ?? "";
    const worldName = meta?.worldName?.trim() ?? "";
    const isPrivate = meta?.isPrivate ?? false;
    const passwordPlain = isPrivate ? (meta?.passwordPlain ?? "") : "";
    const { error } = await this.client.rpc("upsert_stratum_room_session", {
      p_room_code: roomCode,
      p_host_peer_id: hostPeerId,
      p_room_title: title,
      p_motd: motd,
      p_world_name: worldName,
      p_is_private: isPrivate,
      p_password_plain: passwordPlain,
    });
    if (error !== null) {
      console.warn("[SupabaseSignalAdapter] publishRoom:", error.message);
    }
  }

  /** Host heartbeat: refresh lease and `updated_at` for directory sorting. */
  async touchRoomSession(roomCode: RoomCode): Promise<void> {
    if (this.auth.getSession() === null) {
      return;
    }
    const { error } = await this.client.rpc("touch_stratum_room_session", {
      p_room_code: roomCode,
    });
    if (error !== null) {
      console.warn("[SupabaseSignalAdapter] touchRoomSession:", error.message);
    }
  }

  /** Remove relay entry when the host stops multiplayer. */
  async clearRoom(roomCode: RoomCode): Promise<void> {
    const session = this.auth.getSession();
    if (session === null) {
      return;
    }
    const { error } = await this.client
      .from("stratum_room_sessions")
      .delete()
      .eq("room_code", roomCode)
      .eq("host_user_id", session.userId);
    if (error !== null) {
      console.warn("[SupabaseSignalAdapter] clearRoom:", error.message);
    }
  }

  /**
   * Resolve host PeerJS id for a room code.
   * Uses `lookup_room_host_peer_for_join` (public rooms + private with password).
   */
  async lookupHostPeerId(
    roomCode: RoomCode,
    joinPassword?: string | null,
  ): Promise<HostPeerId | null> {
    const { data, error } = await this.client.rpc("lookup_room_host_peer_for_join", {
      p_room_code: roomCode,
      p_password: joinPassword ?? "",
    });
    if (error !== null || data === null || typeof data !== "string") {
      return null;
    }
    return isHostPeerId(data) ? data : null;
  }
}

export function createSupabaseSignalRelay(
  auth: IAuthProvider,
): SupabaseSignalAdapter | null {
  const client = auth.getSupabaseClient();
  if (client === null) {
    return null;
  }
  return new SupabaseSignalAdapter(client, auth);
}
