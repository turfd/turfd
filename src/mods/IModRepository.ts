/** Workshop mod directory, cache, and install/publish contract. */

import type { EventBus } from "../core/EventBus";
import type { IndexedDBStore } from "../persistence/IndexedDBStore";
import type {
  CachedMod,
  ModComment,
  ModDetailEntry,
  ModListEntry,
  ModRecordId,
  ModSortBy,
  ModTypeFilter,
} from "./workshopTypes";

export interface IModRepository {
  init(): Promise<void>;

  list(opts: {
    offset: number;
    modType: ModTypeFilter;
    sortBy: ModSortBy;
    query?: string;
  }): Promise<{ records: readonly ModListEntry[]; hasMore: boolean }>;

  getDetail(
    recordId: ModRecordId,
  ): Promise<{ record: ModDetailEntry; comments: readonly ModComment[] }>;

  postComment(
    recordId: ModRecordId,
    body: string,
    userId: string,
  ): Promise<readonly ModComment[]>;

  postRating(recordId: ModRecordId, stars: number, userId: string): Promise<void>;

  install(entry: ModListEntry): Promise<void>;

  uninstall(modId: string): Promise<void>;

  isInstalled(modId: string): boolean;

  getInstalled(): readonly CachedMod[];

  getCached(modId: string, version: string): CachedMod | undefined;

  ensureInstalled(
    modId: string,
    version: string,
    recordId: ModRecordId,
  ): Promise<CachedMod>;

  publish(
    zipBytes: Uint8Array,
    coverBytes: Uint8Array,
    displayName: string,
    ownerUserId: string,
  ): Promise<ModListEntry>;

  listOwned(): Promise<readonly ModListEntry[]>;

  setPublished(recordId: ModRecordId, isPublished: boolean): Promise<void>;

  deleteMod(recordId: ModRecordId): Promise<void>;

  readonly client: import("@supabase/supabase-js").SupabaseClient | null;
  readonly store: IndexedDBStore;
  readonly bus: EventBus;
}
