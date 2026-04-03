/** Supabase workshop directory + IndexedDB mod cache; emits install progress on the event bus. */

import { unzipSync } from "fflate";
import type { SupabaseClient } from "@supabase/supabase-js";
import { MOD_MAX_COVER_SIZE, MOD_MAX_ZIP_SIZE, MOD_PAGE_SIZE } from "../core/constants";
import type { EventBus } from "../core/EventBus";
import type { GameEvent } from "../core/types";
import {
  deleteStratumModRow,
  getStratumModJson,
  listOwnedStratumMods,
  listStratumModComments,
  listStratumMods,
  postStratumModComment,
  setStratumModRating,
  updateStratumModPublished,
  type OwnedModRow,
} from "../network/workshopModApi";
import type { IndexedDBStore } from "../persistence/IndexedDBStore";
import { WorkshopUnavailableError } from "./WorkshopUnavailableError";
import type { IModRepository } from "./IModRepository";
import {
  asModRecordId,
  assertPublishableWorkshopManifest,
  normalizeWorkshopRowModType,
  WorkshopManifestSchema,
  type CachedMod,
  type ModDetailEntry,
  type ModListEntry,
  type ModRecordId,
  type ModSortBy,
  type ModTypeFilter,
  type WorkshopManifest,
} from "./workshopTypes";

// PERF: Safari does not honour navigator.storage.persist(); cached mods may be evicted without warning on iOS. ensureInstalled() is the recovery path.
// TODO: workshop v2 — mod version updates, dependencies, conflict UX beyond registry duplicate IDs, persistent storage prompt, report/moderation, curated lists.

export function workshopModCacheKey(modId: string, version: string): string {
  return `mod:${modId}:v:${version}`;
}

function clarifyStorageError(message: string): string {
  if (/bucket not found/i.test(message)) {
    return `${message} Create the Storage bucket \"mods\" (run the storage block at the end of supabase/schema.sql in the SQL Editor, or Storage → New bucket → id mods, public).`;
  }
  return message;
}

function normalizeZipEntries(raw: Record<string, Uint8Array>): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(raw)) {
    const nk = k.replace(/\\/g, "/").replace(/^\//, "");
    out[nk] = v;
  }
  return out;
}

function manifestJsonPaths(files: Record<string, Uint8Array>): string[] {
  const out: string[] = [];
  for (const k of Object.keys(files)) {
    const base = k.replace(/\\/g, "/").split("/").pop() ?? "";
    if (base.toLowerCase() === "manifest.json") {
      out.push(k);
    }
  }
  return out;
}

/**
 * Same manifest discovery as workshop install/publish: root `manifest.json` first,
 * otherwise exactly one `manifest.json` anywhere in the ZIP (case-insensitive name).
 */
export function readWorkshopManifestFromZipFiles(
  files: Record<string, Uint8Array>,
): WorkshopManifest {
  return readManifestFromFiles(files);
}

function readManifestFromFiles(files: Record<string, Uint8Array>): WorkshopManifest {
  const candidates = ["manifest.json", "Manifest.json"];
  for (const c of candidates) {
    const u = files[c];
    if (u !== undefined) {
      const text = new TextDecoder().decode(u);
      const json: unknown = JSON.parse(text);
      return WorkshopManifestSchema.parse(json);
    }
  }
  const nested = manifestJsonPaths(files);
  if (nested.length === 0) {
    throw new Error("ZIP must contain manifest.json at the root.");
  }
  if (nested.length > 1) {
    const preview = nested.slice(0, 5).join(", ");
    const more = nested.length > 5 ? ", …" : "";
    throw new Error(
      `ZIP contains multiple manifest.json files (${preview}${more}). Use one workshop pack per ZIP, with manifest.json at the root (not a parent folder that includes several packs).`,
    );
  }
  const key = nested[0]!;
  const text = new TextDecoder().decode(files[key]!);
  const json: unknown = JSON.parse(text);
  return WorkshopManifestSchema.parse(json);
}

function readPackPng(files: Record<string, Uint8Array>): Uint8Array | undefined {
  for (const name of ["pack.png", "Pack.png"]) {
    const u = files[name];
    if (u !== undefined) {
      return u;
    }
  }
  const key = Object.keys(files).find((k) => /(^|\/)pack\.png$/i.test(k));
  return key !== undefined ? files[key] : undefined;
}

export class ModRepository implements IModRepository {
  readonly client: SupabaseClient | null;

  readonly store: IndexedDBStore;

  readonly bus: EventBus;

  private readonly cacheByKey = new Map<string, CachedMod>();

  constructor(client: SupabaseClient | null, store: IndexedDBStore, bus: EventBus) {
    this.client = client;
    this.store = store;
    this.bus = bus;
  }

  async init(): Promise<void> {
    const keys = await this.store.listModCacheKeys();
    for (const key of keys) {
      const row = await this.store.getModCache(key);
      if (row !== undefined) {
        this.cacheByKey.set(key, row);
      }
    }
  }

  async list(opts: {
    offset: number;
    modType: ModTypeFilter;
    sortBy: ModSortBy;
    query?: string;
  }): Promise<{ records: readonly ModListEntry[]; hasMore: boolean }> {
    if (this.client === null) {
      return { records: [], hasMore: false };
    }
    const limit = MOD_PAGE_SIZE;
    const records = await listStratumMods(this.client, {
      modType: opts.modType,
      sortBy: opts.sortBy,
      search: opts.query ?? "",
      limit: limit + 1,
      offset: opts.offset,
    });
    const hasMore = records.length > limit;
    const slice = hasMore ? records.slice(0, limit) : records;
    return { records: slice, hasMore };
  }

  async getDetail(
    recordId: ModRecordId,
  ): Promise<{ record: ModDetailEntry; comments: import("./workshopTypes").ModComment[] }> {
    if (this.client === null) {
      throw new WorkshopUnavailableError();
    }
    const record = await getStratumModJson(this.client, recordId);
    if (record === null) {
      throw new Error("Mod not found or not published.");
    }
    const comments = await listStratumModComments(this.client, recordId);
    return { record, comments };
  }

  async postComment(
    recordId: ModRecordId,
    body: string,
    userId: string,
  ): Promise<readonly import("./workshopTypes").ModComment[]> {
    if (this.client === null) {
      throw new WorkshopUnavailableError();
    }
    const r = await postStratumModComment(this.client, recordId, userId, body);
    if (!r.ok) {
      throw new Error(r.error);
    }
    return listStratumModComments(this.client, recordId);
  }

  async postRating(recordId: ModRecordId, stars: number, userId: string): Promise<void> {
    if (this.client === null) {
      throw new WorkshopUnavailableError();
    }
    const r = await setStratumModRating(this.client, recordId, userId, stars);
    if (!r.ok) {
      throw new Error(r.error);
    }
  }

  async install(entry: ModListEntry): Promise<void> {
    await this.fetchAndCache(entry, { countDownload: true });
  }

  private async fetchAndCache(
    entry: ModListEntry,
    opts: { countDownload: boolean },
  ): Promise<CachedMod> {
    this.bus.emit({
      type: "mod:install-started",
      modId: entry.modId,
    } satisfies GameEvent);
    try {
      if (this.client === null) {
        throw new WorkshopUnavailableError();
      }
      this.bus.emit({
        type: "mod:install-progress",
        modId: entry.modId,
        percent: 10,
      } satisfies GameEvent);

      const { data: pub } = this.client.storage.from("mods").getPublicUrl(entry.filePath);
      const res = await fetch(pub.publicUrl);
      if (!res.ok) {
        throw new Error(res.statusText || `Download failed (${res.status})`);
      }
      const buf = await res.arrayBuffer();
      const bytes = new Uint8Array(buf);
      if (bytes.length > MOD_MAX_ZIP_SIZE) {
        throw new Error("Downloaded mod exceeds maximum size.");
      }

      this.bus.emit({
        type: "mod:install-progress",
        modId: entry.modId,
        percent: 25,
      } satisfies GameEvent);

      let rawFiles: Record<string, Uint8Array>;
      try {
        rawFiles = unzipSync(bytes) as Record<string, Uint8Array>;
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Invalid ZIP archive.";
        throw new Error(msg);
      }
      const files = normalizeZipEntries(rawFiles);

      this.bus.emit({
        type: "mod:install-progress",
        modId: entry.modId,
        percent: 50,
      } satisfies GameEvent);

      const manifest = readManifestFromFiles(files);
      if (manifest.id !== entry.modId || manifest.version !== entry.version) {
        throw new Error("Downloaded package manifest does not match workshop listing.");
      }

      this.bus.emit({
        type: "mod:install-progress",
        modId: entry.modId,
        percent: 75,
      } satisfies GameEvent);

      const cached: CachedMod = {
        recordId: entry.id,
        modId: manifest.id,
        version: manifest.version,
        fetchedAt: Date.now(),
        files,
        manifest,
      };
      const key = workshopModCacheKey(manifest.id, manifest.version);
      await this.store.putModCache(key, cached);
      this.cacheByKey.set(key, cached);

      if (opts.countDownload) {
        void this.client.rpc("increment_mod_download_count", {
          p_mod_uuid: entry.id,
        });
      }

      this.bus.emit({
        type: "mod:install-progress",
        modId: entry.modId,
        percent: 100,
      } satisfies GameEvent);
      this.bus.emit({
        type: "mod:install-complete",
        modId: entry.modId,
      } satisfies GameEvent);
      return cached;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.bus.emit({
        type: "mod:install-error",
        modId: entry.modId,
        message,
      } satisfies GameEvent);
      throw e;
    }
  }

  async uninstall(modId: string): Promise<void> {
    const toDelete: string[] = [];
    for (const [key, c] of this.cacheByKey) {
      if (c.modId === modId) {
        toDelete.push(key);
      }
    }
    for (const key of toDelete) {
      await this.store.deleteModCache(key);
      this.cacheByKey.delete(key);
    }
    this.bus.emit({ type: "mod:uninstalled", modId } satisfies GameEvent);
  }

  isInstalled(modId: string): boolean {
    for (const c of this.cacheByKey.values()) {
      if (c.modId === modId) {
        return true;
      }
    }
    return false;
  }

  getInstalled(): readonly CachedMod[] {
    return [...this.cacheByKey.values()];
  }

  getCached(modId: string, version: string): CachedMod | undefined {
    return this.cacheByKey.get(workshopModCacheKey(modId, version));
  }

  async ensureInstalled(
    modId: string,
    version: string,
    recordId: ModRecordId,
  ): Promise<CachedMod> {
    const existing = this.getCached(modId, version);
    if (existing !== undefined) {
      return existing;
    }
    if (this.client === null) {
      throw new WorkshopUnavailableError(
        "Cannot download workshop mod: Supabase is not configured.",
      );
    }
    const detail = await getStratumModJson(this.client, recordId);
    if (detail === null) {
      throw new Error(`Workshop mod not available: ${recordId}`);
    }
    const entry: ModListEntry = {
      id: detail.id,
      name: detail.name,
      description: detail.description,
      modId: detail.modId,
      version: detail.version,
      modType: detail.modType,
      filePath: detail.filePath,
      coverPath: detail.coverPath,
      fileSize: detail.fileSize,
      downloadCount: detail.downloadCount,
      createdAt: detail.createdAt,
      authorName: detail.authorName,
      avgRating: detail.avgRating,
      ratingCount: detail.ratingCount,
      commentCount: 0,
    };
    if (entry.modId !== modId || entry.version !== version) {
      throw new Error("World references a mod id/version that does not match the workshop record.");
    }
    return this.fetchAndCache(entry, { countDownload: false });
  }

  async publish(
    zipBytes: Uint8Array,
    coverBytes: Uint8Array,
    displayName: string,
    ownerUserId: string,
  ): Promise<ModListEntry> {
    if (this.client === null) {
      throw new WorkshopUnavailableError();
    }
    if (zipBytes.length > MOD_MAX_ZIP_SIZE) {
      throw new Error(`ZIP must be at most ${MOD_MAX_ZIP_SIZE} bytes.`);
    }
    if (coverBytes.length > MOD_MAX_COVER_SIZE) {
      throw new Error(`Cover image must be at most ${MOD_MAX_COVER_SIZE} bytes.`);
    }

    let rawFiles: Record<string, Uint8Array>;
    try {
      rawFiles = unzipSync(zipBytes) as Record<string, Uint8Array>;
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Invalid ZIP.";
      throw new Error(msg);
    }
    const files = normalizeZipEntries(rawFiles);
    const manifest = readManifestFromFiles(files);
    const packFromZip = readPackPng(files);
    const cover = packFromZip ?? coverBytes;
    if (cover.length === 0) {
      throw new Error("pack.png is required (in the ZIP or as a separate upload).");
    }

    const name = displayName.trim() || manifest.name;
    if (name.length < 1 || name.length > 64) {
      throw new Error("Display name must be 1–64 characters.");
    }
    assertPublishableWorkshopManifest(manifest);

    const id = crypto.randomUUID();
    const zipPath = `zips/${id}.zip`;
    const coverPath = `covers/${id}.png`;

    const { error: upZip } = await this.client.storage
      .from("mods")
      .upload(zipPath, zipBytes, {
        contentType: "application/zip",
        upsert: false,
      });
    if (upZip !== null) {
      throw new Error(clarifyStorageError(upZip.message));
    }

    const coverMime =
      cover.length >= 2 && cover[0] === 0xff && cover[1] === 0xd8
        ? "image/jpeg"
        : "image/png";
    const { error: upCover } = await this.client.storage
      .from("mods")
      .upload(coverPath, cover, {
        contentType: coverMime,
        upsert: false,
      });
    if (upCover !== null) {
      void this.client.storage.from("mods").remove([zipPath]);
      throw new Error(clarifyStorageError(upCover.message));
    }

    const { data: inserted, error: insErr } = await this.client
      .from("stratum_mods")
      .insert({
        owner_id: ownerUserId,
        name,
        description: manifest.description,
        mod_id: manifest.id,
        version: manifest.version,
        mod_type: manifest.mod_type,
        file_path: zipPath,
        cover_path: coverPath,
        file_size: zipBytes.length,
        is_published: true,
      })
      .select(
        "id, name, description, mod_id, version, mod_type, file_path, cover_path, file_size, download_count, created_at",
      )
      .single();

    if (insErr !== null || inserted === null) {
      void this.client.storage.from("mods").remove([zipPath, coverPath]);
      throw new Error(insErr?.message ?? "Insert failed.");
    }

    const row = inserted as Record<string, unknown>;
    const prof = await this.client.from("profiles").select("username").eq("id", ownerUserId).maybeSingle();
    const authorName =
      prof.data !== null && typeof prof.data === "object" && "username" in prof.data
        ? String((prof.data as { username?: string }).username ?? "")
        : "";

    return {
      id: asModRecordId(String(row.id)),
      name: String(row.name),
      description: String(row.description ?? ""),
      modId: String(row.mod_id),
      version: String(row.version),
      modType: normalizeWorkshopRowModType(String(row.mod_type ?? "")),
      filePath: String(row.file_path),
      coverPath: String(row.cover_path),
      fileSize: Number(row.file_size ?? 0),
      downloadCount: Number(row.download_count ?? 0),
      createdAt:
        row.created_at instanceof Date
          ? row.created_at.toISOString()
          : String(row.created_at ?? ""),
      authorName,
      avgRating: 0,
      ratingCount: 0,
      commentCount: 0,
    };
  }

  async listOwned(): Promise<readonly ModListEntry[]> {
    if (this.client === null) {
      return [];
    }
    const rows = await listOwnedStratumMods(this.client);
    return rows.map(ownedRowToListEntry);
  }

  async setPublished(recordId: ModRecordId, isPublished: boolean): Promise<void> {
    if (this.client === null) {
      throw new WorkshopUnavailableError();
    }
    const r = await updateStratumModPublished(this.client, recordId, isPublished);
    if (!r.ok) {
      throw new Error(r.error);
    }
  }

  async deleteMod(recordId: ModRecordId): Promise<void> {
    if (this.client === null) {
      throw new WorkshopUnavailableError();
    }
    const { data: row, error: selErr } = await this.client
      .from("stratum_mods")
      .select("file_path, cover_path")
      .eq("id", recordId)
      .maybeSingle();
    if (selErr !== null) {
      throw new Error(selErr.message);
    }
    if (row !== null && typeof row === "object") {
      const fp = (row as { file_path?: string }).file_path;
      const cp = (row as { cover_path?: string }).cover_path;
      const paths = [fp, cp].filter((p): p is string => typeof p === "string" && p.length > 0);
      if (paths.length > 0) {
        await this.client.storage.from("mods").remove(paths);
      }
    }
    const del = await deleteStratumModRow(this.client, recordId);
    if (!del.ok) {
      throw new Error(del.error);
    }
  }
}

function ownedRowToListEntry(row: OwnedModRow): ModListEntry {
  return {
    id: asModRecordId(row.id),
    name: row.name,
    description: row.description,
    modId: row.mod_id,
    version: row.version,
    modType: normalizeWorkshopRowModType(String(row.mod_type ?? "")),
    filePath: row.file_path,
    coverPath: row.cover_path,
    fileSize: row.file_size,
    downloadCount: row.download_count,
    createdAt: row.created_at,
    authorName: "",
    avgRating: 0,
    ratingCount: 0,
    commentCount: 0,
    isPublished: row.is_published,
  };
}
