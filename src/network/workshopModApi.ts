/**
 * Supabase workshop: list mods, detail, comments, ratings (mirrors roomDirectoryApi patterns).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  asModRecordId,
  type ModComment,
  type ModDetailEntry,
  type ModListEntry,
  normalizeWorkshopRowModType,
} from "../mods/workshopTypes";
import { MOD_PAGE_SIZE } from "../core/constants";
import { parseJsoncText } from "../core/jsonc";

function asObjectArray(raw: unknown): Record<string, unknown>[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((x): x is Record<string, unknown> => x !== null && typeof x === "object");
}

function modListFromRpcJson(data: unknown): ModListEntry[] {
  if (data === null || data === undefined) {
    return [];
  }
  let rows: unknown[] = [];
  if (Array.isArray(data)) {
    rows = data;
  } else if (typeof data === "string") {
    try {
      const parsed = parseJsoncText(data, "list_stratum_mods rpc payload") as unknown;
      rows = Array.isArray(parsed) ? parsed : [];
    } catch {
      rows = [];
    }
  } else if (typeof data === "object") {
    rows = [data];
  }
  return rows
    .filter((x): x is Record<string, unknown> => x !== null && typeof x === "object")
    .map(modListRow);
}

function modListRow(row: Record<string, unknown>): ModListEntry {
  return {
    id: asModRecordId(String(row.id ?? "")),
    name: String(row.name ?? ""),
    description: String(row.description ?? ""),
    modId: String(row.mod_id ?? ""),
    version: String(row.version ?? ""),
    modType: normalizeWorkshopRowModType(String(row.mod_type ?? "")),
    filePath: String(row.file_path ?? ""),
    coverPath: String(row.cover_path ?? ""),
    fileSize: Number(row.file_size ?? 0),
    downloadCount: Number(row.download_count ?? 0),
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : String(row.created_at ?? ""),
    authorName: String(row.author_name ?? ""),
    avgRating: Number(row.avg_rating ?? 0),
    ratingCount: Number(row.rating_count ?? 0),
    commentCount: Number(row.comment_count ?? 0),
  };
}

export async function listStratumMods(
  client: SupabaseClient,
  opts: {
    modType: string;
    sortBy: string;
    search: string;
    limit?: number;
    offset?: number;
  },
): Promise<ModListEntry[]> {
  const { data, error } = await client.rpc("list_stratum_mods", {
    p_mod_type: opts.modType === "all" ? "" : opts.modType,
    p_sort: opts.sortBy,
    p_search: opts.search.trim(),
    p_limit: opts.limit ?? MOD_PAGE_SIZE,
    p_offset: opts.offset ?? 0,
  });
  if (error !== null) {
    console.warn("[workshopModApi] listStratumMods:", error.message);
    return [];
  }
  return modListFromRpcJson(data);
}

export async function getLatestPublishedStratumModByModId(
  client: SupabaseClient,
  modId: string,
): Promise<ModDetailEntry | null> {
  const trimmed = modId.trim();
  if (trimmed.length < 1) {
    return null;
  }
  const { data, error } = await client.rpc(
    "get_latest_published_stratum_mod_by_mod_id",
    {
      p_mod_id: trimmed,
    },
  );
  if (error !== null) {
    console.warn(
      "[workshopModApi] getLatestPublishedStratumModByModId:",
      error.message,
    );
    return null;
  }
  if (data === null || data === undefined) {
    return null;
  }
  let parsed: unknown = data;
  if (typeof data === "string") {
    try {
      parsed = parseJsoncText(data, "latest mod rpc payload") as unknown;
    } catch {
      return null;
    }
  }
  const row =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  if (row === null) {
    return null;
  }
  const r = modListRow({ ...row, comment_count: 0 });
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    modId: r.modId,
    version: r.version,
    modType: r.modType,
    filePath: r.filePath,
    coverPath: r.coverPath,
    fileSize: r.fileSize,
    downloadCount: r.downloadCount,
    createdAt: r.createdAt,
    authorName: r.authorName,
    avgRating: r.avgRating,
    ratingCount: r.ratingCount,
  };
}

export async function getStratumModJson(
  client: SupabaseClient,
  modUuid: string,
): Promise<ModDetailEntry | null> {
  const { data, error } = await client.rpc("get_stratum_mod", {
    p_mod_uuid: modUuid,
  });
  if (error !== null) {
    console.warn("[workshopModApi] getStratumModJson:", error.message);
    return null;
  }
  if (data === null || data === undefined) {
    return null;
  }
  let parsed: unknown = data;
  if (typeof data === "string") {
    try {
      parsed = parseJsoncText(data, "get_stratum_mod rpc payload") as unknown;
    } catch {
      return null;
    }
  }
  const row =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  if (row === null) {
    return null;
  }
  const r = modListRow({ ...row, comment_count: 0 });
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    modId: r.modId,
    version: r.version,
    modType: r.modType,
    filePath: r.filePath,
    coverPath: r.coverPath,
    fileSize: r.fileSize,
    downloadCount: r.downloadCount,
    createdAt: r.createdAt,
    authorName: r.authorName,
    avgRating: r.avgRating,
    ratingCount: r.ratingCount,
  };
}

export async function listStratumModComments(
  client: SupabaseClient,
  modUuid: string,
): Promise<ModComment[]> {
  const { data, error } = await client.rpc("list_stratum_mod_comments", {
    p_mod_uuid: modUuid,
    p_limit: 80,
    p_offset: 0,
  });
  if (error !== null) {
    console.warn("[workshopModApi] listStratumModComments:", error.message);
    return [];
  }
  let rowsRaw: unknown = data;
  if (typeof data === "string") {
    try {
      rowsRaw = parseJsoncText(data, "list_stratum_mod_comments rpc payload") as unknown;
    } catch {
      return [];
    }
  }
  return asObjectArray(rowsRaw).map((row) => ({
    id: String(row.id ?? ""),
    modUuid: asModRecordId(String(row.mod_uuid ?? "")),
    authorId: String(row.author_id ?? ""),
    authorName: String(row.author_username ?? ""),
    body: String(row.body ?? ""),
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : String(row.created_at ?? ""),
  }));
}

export async function postStratumModComment(
  client: SupabaseClient,
  modUuid: string,
  userId: string,
  body: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const trimmed = body.trim();
  if (trimmed.length < 1 || trimmed.length > 500) {
    return { ok: false, error: "Comment must be 1–500 characters." };
  }
  const { error } = await client.from("stratum_mod_comments").insert({
    mod_uuid: modUuid,
    author_id: userId,
    body: trimmed,
  });
  if (error !== null) {
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

export async function setStratumModRating(
  client: SupabaseClient,
  modUuid: string,
  userId: string,
  stars: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
    return { ok: false, error: "Rating must be 1–5." };
  }
  const { error } = await client.from("stratum_mod_ratings").upsert(
    {
      mod_uuid: modUuid,
      user_id: userId,
      stars,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "mod_uuid,user_id" },
  );
  if (error !== null) {
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

export async function getMyModRating(
  client: SupabaseClient,
  modUuid: string,
  userId: string,
): Promise<number | null> {
  const { data, error } = await client
    .from("stratum_mod_ratings")
    .select("stars")
    .eq("mod_uuid", modUuid)
    .eq("user_id", userId)
    .maybeSingle();
  if (error !== null || data === null) {
    return null;
  }
  const s = (data as { stars?: number }).stars;
  return typeof s === "number" ? s : null;
}

export type OwnedModRow = {
  id: string;
  name: string;
  description: string;
  mod_id: string;
  version: string;
  mod_type: string;
  file_path: string;
  cover_path: string;
  file_size: number;
  download_count: number;
  is_published: boolean;
  created_at: string;
};

export function modDetailToListEntry(d: ModDetailEntry): ModListEntry {
  return {
    id: d.id,
    name: d.name,
    description: d.description,
    modId: d.modId,
    version: d.version,
    modType: d.modType,
    filePath: d.filePath,
    coverPath: d.coverPath,
    fileSize: d.fileSize,
    downloadCount: d.downloadCount,
    createdAt: d.createdAt,
    authorName: d.authorName,
    avgRating: d.avgRating,
    ratingCount: d.ratingCount,
    commentCount: 0,
  };
}

export async function listOwnedStratumMods(
  client: SupabaseClient,
): Promise<OwnedModRow[]> {
  const { data, error } = await client
    .from("stratum_mods")
    .select(
      "id, name, description, mod_id, version, mod_type, file_path, cover_path, file_size, download_count, is_published, created_at",
    )
    .order("created_at", { ascending: false });
  if (error !== null) {
    console.warn("[workshopModApi] listOwnedStratumMods:", error.message);
    return [];
  }
  if (!Array.isArray(data)) {
    return [];
  }
  return data as OwnedModRow[];
}

export async function updateStratumModPublished(
  client: SupabaseClient,
  modUuid: string,
  isPublished: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error } = await client
    .from("stratum_mods")
    .update({ is_published: isPublished })
    .eq("id", modUuid);
  if (error !== null) {
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

export async function deleteStratumModRow(
  client: SupabaseClient,
  modUuid: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error } = await client.from("stratum_mods").delete().eq("id", modUuid);
  if (error !== null) {
    return { ok: false, error: error.message };
  }
  return { ok: true };
}
