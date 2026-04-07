/**
 * Chunk + world metadata persistence via IndexedDB (`idb`).
 */
import { openDB, type IDBPDatabase } from "idb";
import { MOD_CACHE_STORE } from "../core/constants";
import type { Chunk } from "../world/chunk/Chunk";
import { chunkKey, type ChunkCoord } from "../world/chunk/ChunkCoord";
import type { FurnacePersistedChunk } from "../world/furnace/furnacePersisted";
import type { ChestPersistedChunk } from "../world/chest/chestPersisted";
import type { WorldModerationPersisted } from "../network/moderation/WorldModerationState";
import type { CachedMod } from "../mods/workshopTypes";
import type { KeybindableAction } from "../input/bindings";

export const DB_NAME = "stratum";
/** Bumped when a new object store is required so existing browsers run `upgrade` again. */
export const DB_VERSION = 5;

const PLAYER_SETTINGS_KEY = "v1";

export type WorkshopModRef = {
  readonly recordId: string;
  readonly modId: string;
  readonly version: string;
};

/** Persisted keyboard bindings (partial overrides merged with defaults on load). */
export type StoredKeyBindingsV1 = Partial<
  Record<KeybindableAction, readonly string[]>
>;

export type PlayerSettingsV1 = {
  readonly key: typeof PLAYER_SETTINGS_KEY;
  /** Global resource (texture) packs, lowest index loads first; later overrides earlier. */
  globalResourcePackRefs: WorkshopModRef[];
  /** Optional keyboard overrides; omitted ⇒ engine defaults. */
  keyBindings?: StoredKeyBindingsV1;
};

export type WorldMetadata = {
  uuid: string;
  name: string;
  /** Optional note shown in the world list and editable in Edit World. */
  description?: string;
  seed: number;
  createdAt: number;
  lastPlayedAt: number;
  playerX: number;
  playerY: number;
  hotbarSlot: number;
  /** Saved player HP; absent in older saves (treated as full health on load). */
  playerHealth?: number;
  modList: string[];
  /** Optional for worlds saved before world time persistence was added. */
  worldTimeMs?: number;
  /** Rain remaining (seconds) when saved; host/solo only; absent in older saves. */
  rainRemainingSec?: number;
  /** JPEG data URL of the last in-game view, captured on save (optional). */
  previewImageDataUrl?: string;
  /** Host-only multiplayer moderation; optional until first save with chat. */
  moderation?: WorldModerationPersisted;
  /** Serialized inventory slots; absent in worlds saved before inventory persistence. */
  playerInventory?: import("../items/PlayerInventory").SerializedInventorySlot[];
  /**
   * Legacy single list; used when `workshopBehaviorMods` / `workshopResourceMods` are absent.
   */
  workshopMods?: readonly WorkshopModRef[];
  /** Ordered behavior packs for this world (blocks, items, recipes, loot). */
  workshopBehaviorMods?: readonly WorkshopModRef[];
  /** Ordered world resource packs (textures before global stack). */
  workshopResourceMods?: readonly WorkshopModRef[];
  /** When true, joining players should download packs first (enforcement TBD). */
  requirePacksBeforeJoin?: boolean;
  /**
   * Index = numeric block id at last save, value = block identifier.
   * Used to remap chunk cells when `stratum:numeric_id` assignments change.
   */
  blockIdPalette?: readonly string[];
  /**
   * Item id layout generation for tile-entity persistence (chest/furnace numeric ids).
   * Absent or less than 1: load may remap legacy standalone ids 50–81 by +6 (stair block id insert).
   */
  itemIdLayoutRevision?: number;
  /** Host-only: last feet position when each multiplayer guest left (`id:…` / `name:…` keys). */
  multiplayerLastPositions?: Record<string, { x: number; y: number }>;
};

export type ChunkRecord = {
  key: string;
  worldUuid: string;
  cx: number;
  cy: number;
  blocks: Uint16Array;
  metadata: Uint8Array;
  /** Present in saves after background-layer support; absent ⇒ all zeros on load. */
  background?: Uint16Array;
  /** Furnace tile entities in this chunk; absent ⇒ none. */
  furnaces?: FurnacePersistedChunk[];
  /** Chest tile entities (anchor cells only); absent ⇒ none. */
  chests?: ChestPersistedChunk[];
};

function chunkStoreKey(worldUuid: string, coord: ChunkCoord): string {
  return `${worldUuid}:${chunkKey(coord)}`;
}

function cloneStoredKeyBindings(
  raw: StoredKeyBindingsV1,
): StoredKeyBindingsV1 {
  const out: Partial<Record<KeybindableAction, string[]>> = {};
  for (const [action, keys] of Object.entries(raw)) {
    if (!Array.isArray(keys) || keys.length === 0) {
      continue;
    }
    const cleaned = keys.filter(
      (k): k is string => typeof k === "string" && k.length > 0,
    );
    if (cleaned.length > 0) {
      (out as Record<string, string[]>)[action] = [...cleaned];
    }
  }
  return out;
}

function cloneStoredKeyBindingsForWrite(
  raw: StoredKeyBindingsV1,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [action, keys] of Object.entries(raw)) {
    if (!Array.isArray(keys)) {
      continue;
    }
    const cleaned = keys.filter(
      (k): k is string => typeof k === "string" && k.length > 0,
    );
    if (cleaned.length > 0) {
      out[action] = [...cleaned];
    }
  }
  return out;
}

function upgradeStratumDb(db: IDBPDatabase): void {
  if (!db.objectStoreNames.contains("worlds")) {
    db.createObjectStore("worlds", { keyPath: "uuid" });
  }
  if (!db.objectStoreNames.contains("chunks")) {
    const chunkStore = db.createObjectStore("chunks", { keyPath: "key" });
    chunkStore.createIndex("worldUuid", "worldUuid", { unique: false });
  }
  if (!db.objectStoreNames.contains(MOD_CACHE_STORE)) {
    db.createObjectStore(MOD_CACHE_STORE);
  }
  if (!db.objectStoreNames.contains("player_settings")) {
    db.createObjectStore("player_settings");
  }
}

export class IndexedDBStore {
  private db: IDBPDatabase | null = null;

  async openDB(): Promise<void> {
    if (
      this.db !== null &&
      this.db.objectStoreNames.contains(MOD_CACHE_STORE) &&
      this.db.objectStoreNames.contains("player_settings")
    ) {
      return;
    }
    if (this.db !== null) {
      this.db.close();
      this.db = null;
    }
    this.db = await openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        upgradeStratumDb(db);
      },
    });
  }

  async saveWorld(meta: WorldMetadata): Promise<void> {
    const db = this.requireDb();
    await db.put("worlds", meta);
  }

  async loadWorld(uuid: string): Promise<WorldMetadata | undefined> {
    const db = this.requireDb();
    return (await db.get("worlds", uuid)) as WorldMetadata | undefined;
  }

  async listWorlds(): Promise<WorldMetadata[]> {
    const db = this.requireDb();
    return db.getAll("worlds");
  }

  async renameWorld(uuid: string, name: string): Promise<void> {
    const db = this.requireDb();
    const existing = (await db.get("worlds", uuid)) as WorldMetadata | undefined;
    if (existing === undefined) {
      return;
    }
    const nextName = name.trim() || "My World";
    await db.put("worlds", {
      ...existing,
      name: nextName,
      lastPlayedAt: Date.now(),
    } satisfies WorldMetadata);
  }

  /**
   * Read–merge–write world row (metadata only). Used for moderation updates without chunk IO.
   */
  async patchWorldMetadata(
    uuid: string,
    patch: (prev: WorldMetadata | undefined) => WorldMetadata,
  ): Promise<void> {
    const db = this.requireDb();
    const prev = (await db.get("worlds", uuid)) as WorldMetadata | undefined;
    const next = patch(prev);
    await db.put("worlds", next);
  }

  async deleteWorld(uuid: string): Promise<void> {
    const db = this.requireDb();
    const tx = db.transaction("chunks", "readwrite");
    const index = tx.store.index("worldUuid");
    for await (const cursor of index.iterate(IDBKeyRange.only(uuid))) {
      await cursor.delete();
    }
    await tx.done;
    await db.delete("worlds", uuid);
  }

  async saveChunk(worldUuid: string, chunk: Chunk): Promise<void> {
    const db = this.requireDb();
    const record = this.toChunkRecord(worldUuid, chunk);
    await db.put("chunks", record);
  }

  async loadChunk(
    worldUuid: string,
    coord: ChunkCoord,
  ): Promise<ChunkRecord | undefined> {
    const db = this.requireDb();
    const key = chunkStoreKey(worldUuid, coord);
    return (await db.get("chunks", key)) as ChunkRecord | undefined;
  }

  async saveChunkBatch(
    worldUuid: string,
    chunks: Chunk[],
    getFurnacesForChunk?: (cx: number, cy: number) => FurnacePersistedChunk[],
    getChestsForChunk?: (cx: number, cy: number) => ChestPersistedChunk[],
  ): Promise<void> {
    if (chunks.length === 0) {
      return;
    }
    const db = this.requireDb();
    const tx = db.transaction("chunks", "readwrite");
    const puts = chunks.map((chunk) => {
      const { cx, cy } = chunk.coord;
      const furnaces = getFurnacesForChunk?.(cx, cy);
      const chests = getChestsForChunk?.(cx, cy);
      const record = this.toChunkRecord(worldUuid, chunk, furnaces, chests);
      return tx.store.put(record);
    });
    await Promise.all([...puts, tx.done]);
  }

  private toChunkRecord(
    worldUuid: string,
    chunk: Chunk,
    furnaces?: FurnacePersistedChunk[],
    chests?: ChestPersistedChunk[],
  ): ChunkRecord {
    const { cx, cy } = chunk.coord;
    const record: ChunkRecord = {
      key: chunkStoreKey(worldUuid, chunk.coord),
      worldUuid,
      cx,
      cy,
      blocks: new Uint16Array(chunk.blocks),
      metadata: new Uint8Array(chunk.metadata),
      background: new Uint16Array(chunk.background),
    };
    if (furnaces !== undefined && furnaces.length > 0) {
      record.furnaces = furnaces.map((f) => ({ ...f }));
    }
    if (chests !== undefined && chests.length > 0) {
      record.chests = chests.map((c) => ({ ...c }));
    }
    return record;
  }

  async getModCache(key: string): Promise<CachedMod | undefined> {
    const db = this.requireDb();
    if (!db.objectStoreNames.contains(MOD_CACHE_STORE)) {
      return undefined;
    }
    return (await db.get(MOD_CACHE_STORE, key)) as CachedMod | undefined;
  }

  async putModCache(key: string, value: CachedMod): Promise<void> {
    const db = this.requireDb();
    if (!db.objectStoreNames.contains(MOD_CACHE_STORE)) {
      throw new Error(
        `IndexedDB object store "${MOD_CACHE_STORE}" is missing; reload the page to run the database upgrade.`,
      );
    }
    await db.put(MOD_CACHE_STORE, value, key);
  }

  async deleteModCache(key: string): Promise<void> {
    const db = this.requireDb();
    if (!db.objectStoreNames.contains(MOD_CACHE_STORE)) {
      return;
    }
    await db.delete(MOD_CACHE_STORE, key);
  }

  /** All keys in the mod-cache store (for repository init). */
  async listModCacheKeys(): Promise<string[]> {
    const db = this.requireDb();
    if (!db.objectStoreNames.contains(MOD_CACHE_STORE)) {
      return [];
    }
    return db.getAllKeys(MOD_CACHE_STORE) as Promise<string[]>;
  }

  async loadPlayerSettings(): Promise<PlayerSettingsV1> {
    const db = this.requireDb();
    if (!db.objectStoreNames.contains("player_settings")) {
      return {
        key: PLAYER_SETTINGS_KEY,
        globalResourcePackRefs: [],
      };
    }
    const row = (await db.get(
      "player_settings",
      PLAYER_SETTINGS_KEY,
    )) as PlayerSettingsV1 | undefined;
    if (row === undefined) {
      return {
        key: PLAYER_SETTINGS_KEY,
        globalResourcePackRefs: [],
      };
    }
    const kb = row.keyBindings;
    return {
      key: PLAYER_SETTINGS_KEY,
      globalResourcePackRefs: [...(row.globalResourcePackRefs ?? [])],
      ...(kb !== undefined && typeof kb === "object" && !Array.isArray(kb)
        ? { keyBindings: cloneStoredKeyBindings(kb) }
        : {}),
    };
  }

  async savePlayerSettings(settings: PlayerSettingsV1): Promise<void> {
    const db = this.requireDb();
    if (!db.objectStoreNames.contains("player_settings")) {
      throw new Error(
        'IndexedDB object store "player_settings" is missing; reload the page.',
      );
    }
    const prev = await this.loadPlayerSettings();
    const globalResourcePackRefs = [...settings.globalResourcePackRefs];
    const keyBindings =
      settings.keyBindings !== undefined ? settings.keyBindings : prev.keyBindings;

    const payload: Record<string, unknown> = {
      key: PLAYER_SETTINGS_KEY,
      globalResourcePackRefs,
    };
    if (keyBindings !== undefined) {
      payload.keyBindings = cloneStoredKeyBindingsForWrite(keyBindings);
    }
    await db.put("player_settings", payload);
  }

  private requireDb(): IDBPDatabase {
    if (!this.db) {
      throw new Error("IndexedDBStore.openDB() must complete first");
    }
    return this.db;
  }
}
