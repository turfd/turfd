/** Publish and resolve Turf'd room codes via Supabase (authenticated hosts only). */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { IAuthProvider } from "../auth/IAuthProvider";
import type { HostPeerId } from "./hostPeerId";
import { isHostPeerId } from "./hostPeerId";
import type { RoomCode } from "./roomCode";

/** How long a published room mapping stays valid (ms). */
const ROOM_RELAY_TTL_MS = 4 * 60 * 60 * 1000;

export class SupabaseSignalAdapter {
  private readonly client: SupabaseClient;

  private readonly auth: IAuthProvider;

  constructor(client: SupabaseClient, auth: IAuthProvider) {
    this.client = client;
    this.auth = auth;
  }

  /**
   * Registers this host's room for cross-client discovery. No-op if not signed in.
   */
  async publishRoom(roomCode: RoomCode, hostPeerId: HostPeerId): Promise<void> {
    const session = this.auth.getSession();
    if (session === null) {
      return;
    }
    const expiresAt = new Date(Date.now() + ROOM_RELAY_TTL_MS).toISOString();
    const { error } = await this.client.from("turfd_room_sessions").upsert(
      {
        room_code: roomCode,
        host_peer_id: hostPeerId,
        host_user_id: session.userId,
        expires_at: expiresAt,
      },
      { onConflict: "room_code" },
    );
    if (error !== null) {
      console.warn("[SupabaseSignalAdapter] publishRoom:", error.message);
    }
  }

  /** Remove relay entry when the host stops multiplayer. */
  async clearRoom(roomCode: RoomCode): Promise<void> {
    const session = this.auth.getSession();
    if (session === null) {
      return;
    }
    const { error } = await this.client
      .from("turfd_room_sessions")
      .delete()
      .eq("room_code", roomCode)
      .eq("host_user_id", session.userId);
    if (error !== null) {
      console.warn("[SupabaseSignalAdapter] clearRoom:", error.message);
    }
  }

  /**
   * Resolve host PeerJS id for a room code, or null to use deterministic fallback.
   */
  async lookupHostPeerId(roomCode: RoomCode): Promise<HostPeerId | null> {
    const { data, error } = await this.client.rpc("lookup_room_host_peer", {
      p_room_code: roomCode,
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
