/**
 * Supabase room directory: list, comments, ratings (main menu).
 * Session relay / join lookup lives in {@link SupabaseSignalAdapter}.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { parseJsoncText } from "../core/jsonc";

export type ListedRoom = {
  room_code: string;
  room_title: string;
  motd: string;
  world_name: string;
  is_private: boolean;
  updated_at: string;
  expires_at: string;
  host_username: string;
  avg_rating: number;
  rating_count: number;
  comment_count: number;
};

export type RoomComment = {
  id: string;
  body: string;
  created_at: string;
  author_username: string;
};

/** PostgREST may return jsonb as an array, a JSON string, or one row as an object. */
function roomListRowsFromRpc(data: unknown): Record<string, unknown>[] {
  if (data === null || data === undefined) {
    return [];
  }
  let rows: unknown[] = [];
  if (Array.isArray(data)) {
    rows = data;
  } else if (typeof data === "string") {
    try {
      const parsed = parseJsoncText(data, "list_stratum_rooms rpc payload") as unknown;
      rows = Array.isArray(parsed) ? parsed : [];
    } catch {
      rows = [];
    }
  } else if (typeof data === "object" && "room_code" in (data as object)) {
    rows = [data];
  }
  return rows.filter((x): x is Record<string, unknown> => x !== null && typeof x === "object");
}

function asObjectArray(raw: unknown): Record<string, unknown>[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((x): x is Record<string, unknown> => x !== null && typeof x === "object");
}

export async function listStratumRooms(
  client: SupabaseClient,
  opts: {
    search?: string;
    filter?: "all" | "public" | "private";
    sort?: "active" | "new" | "rating";
    limit?: number;
    offset?: number;
  } = {},
): Promise<ListedRoom[]> {
  const { data, error } = await client.rpc("list_stratum_rooms", {
    p_search: opts.search ?? "",
    p_filter: opts.filter ?? "all",
    p_sort: opts.sort ?? "active",
    p_limit: opts.limit ?? 40,
    p_offset: opts.offset ?? 0,
  });
  if (error !== null) {
    console.warn(
      "[roomDirectoryApi] listStratumRooms:",
      error.message,
      error.code ?? "",
      error.details ?? "",
    );
    return [];
  }
  return roomListRowsFromRpc(data).map((row) => ({
    room_code: String(row.room_code ?? ""),
    room_title: String(row.room_title ?? ""),
    motd: String(row.motd ?? ""),
    world_name: String(row.world_name ?? ""),
    is_private: Boolean(row.is_private),
    updated_at: String(row.updated_at ?? ""),
    expires_at: String(row.expires_at ?? ""),
    host_username: String(row.host_username ?? ""),
    avg_rating: Number(row.avg_rating ?? 0),
    rating_count: Number(row.rating_count ?? 0),
    comment_count: Number(row.comment_count ?? 0),
  }));
}

export async function listStratumRoomComments(
  client: SupabaseClient,
  roomCode: string,
): Promise<RoomComment[]> {
  const { data, error } = await client.rpc("list_stratum_room_comments", {
    p_room_code: roomCode,
    p_limit: 80,
    p_offset: 0,
  });
  if (error !== null) {
    console.warn("[roomDirectoryApi] listStratumRoomComments:", error.message);
    return [];
  }
  return asObjectArray(data).map((row) => ({
    id: String(row.id ?? ""),
    body: String(row.body ?? ""),
    created_at: String(row.created_at ?? ""),
    author_username: String(row.author_username ?? ""),
  }));
}

export async function postStratumRoomComment(
  client: SupabaseClient,
  roomCode: string,
  userId: string,
  body: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const trimmed = body.trim();
  if (trimmed.length < 1 || trimmed.length > 500) {
    return { ok: false, error: "Comment must be 1–500 characters." };
  }
  const { error } = await client.from("stratum_room_comments").insert({
    room_code: roomCode,
    author_id: userId,
    body: trimmed,
  });
  if (error !== null) {
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

export async function setStratumRoomRating(
  client: SupabaseClient,
  roomCode: string,
  userId: string,
  stars: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
    return { ok: false, error: "Rating must be 1–5." };
  }
  const { error } = await client.from("stratum_room_ratings").upsert(
    {
      room_code: roomCode,
      user_id: userId,
      stars,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "room_code,user_id" },
  );
  if (error !== null) {
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

export async function getMyRoomRating(
  client: SupabaseClient,
  roomCode: string,
  userId: string,
): Promise<number | null> {
  const { data, error } = await client
    .from("stratum_room_ratings")
    .select("stars")
    .eq("room_code", roomCode)
    .eq("user_id", userId)
    .maybeSingle();
  if (error !== null || data === null) {
    return null;
  }
  const s = (data as { stars?: number }).stars;
  return typeof s === "number" ? s : null;
}
