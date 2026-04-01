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

  constructor(client: SupabaseClient) {
    this.client = client;
  }

  /**
   * Registers this host's room for cross-client discovery.
   * Uses Supabase Auth JWT (not only {@link IAuthProvider#getSession}) so the RPC runs as the signed-in user.
   * @returns false if the room was not written to the directory (check console for details).
   */
  async publishRoom(
    roomCode: RoomCode,
    hostPeerId: HostPeerId,
    meta?: RoomPublishMeta,
  ): Promise<boolean> {
    const {
      data: { session: sbSession },
      error: sessionErr,
    } = await this.client.auth.getSession();
    if (sessionErr !== null) {
      console.warn("[SupabaseSignalAdapter] publishRoom: auth getSession", sessionErr.message);
      return false;
    }
    if (sbSession === null) {
      console.warn(
        "[SupabaseSignalAdapter] publishRoom: no Supabase session — sign in on Profile before hosting for the online list.",
      );
      return false;
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
      console.warn(
        "[SupabaseSignalAdapter] publishRoom RPC failed:",
        error.message,
        error.code ?? "",
        error.details ?? "",
        error.hint ?? "",
      );
      return false;
    }
    return true;
  }

  /** Host heartbeat: refresh lease and `updated_at` for directory sorting. */
  async touchRoomSession(roomCode: RoomCode): Promise<void> {
    const {
      data: { session },
    } = await this.client.auth.getSession();
    if (session === null) {
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
    const {
      data: { session },
    } = await this.client.auth.getSession();
    if (session === null) {
      return;
    }
    const { error } = await this.client
      .from("stratum_room_sessions")
      .delete()
      .eq("room_code", roomCode)
      .eq("host_user_id", session.user.id);
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
  return new SupabaseSignalAdapter(client);
}
