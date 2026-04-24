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
import {
  buildStratumWorldExportV1,
  parseStratumWorldImportV1,
  type StratumWorldExportV1,
} from "./worldExport";

export const DB_NAME = "stratum";
/** Bumped when a new object store is required so existing browsers run `upgrade` again. */
export const DB_VERSION = 7;

export const CUSTOM_SKINS_STORE = "custom_skins";

const PLAYER_SETTINGS_KEY = "v1";
const DEV_PACKS_KEY = "v1";

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
  /** Selected player skin id (e.g. `"explorer_bob"` or `"custom:uuid"`). Absent ⇒ default. */
  selectedSkinId?: string;
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
  /** Serialized armor slots (helmet, chestplate, leggings, boots); absent in older saves. */
  playerArmor?: import("../items/PlayerInventory").SerializedInventorySlot[];
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

  /** Solo/host: player respawn feet position (bed spawn). */
  playerSpawnX?: number;
  playerSpawnY?: number;
  /** Host-only: respawn feet position for each multiplayer guest (`id:…` / `name:…` keys). */
  multiplayerSpawnPoints?: Record<string, { x: number; y: number }>;

  /**
   * Host/solo-only: persisted world entities (best-effort). Absent in older saves.
   * Stored in world-space pixels, using the same feet-at-(x,y) convention as mob/player physics.
   */
  mobs?: Array<{
    id: number;
    type: number;
    x: number;
    y: number;
    woolColor?: number;
    persistent?: boolean;
  }>;
  /**
   * Host/solo-only: dropped item stacks present at save time.
   * Note: not replicated to late-joining clients yet; primarily for solo persistence.
   */
  drops?: Array<{
    itemId: number;
    count: number;
    damage: number;
    x: number;
    y: number;
    vx: number;
    vy: number;
  }>;
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

export type PersistedFeetPosition = { x: number; y: number };

/**
 * Absolute guard for persisted feet coordinates. Values beyond this are treated as corrupt.
 * Chosen to be far beyond any practical world-play range while still filtering runaway values.
 */
const PERSISTED_FEET_MAX_ABS = 10_000_000;

export function sanitizePersistedFeetPosition(
  x: number | undefined,
  y: number | undefined,
): PersistedFeetPosition | null {
  if (
    x === undefined ||
    y === undefined ||
    !Number.isFinite(x) ||
    !Number.isFinite(y)
  ) {
    return null;
  }
  if (Math.abs(x) > PERSISTED_FEET_MAX_ABS || Math.abs(y) > PERSISTED_FEET_MAX_ABS) {
    return null;
  }
  return { x, y };
}

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
  if (!db.objectStoreNames.contains("dev_packs")) {
    db.createObjectStore("dev_packs");
  }
  if (!db.objectStoreNames.contains(CUSTOM_SKINS_STORE)) {
    db.createObjectStore(CUSTOM_SKINS_STORE, { keyPath: "id" });
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

  /** All chunk rows for a world (for backup / export). */
  async listAllChunksForWorld(worldUuid: string): Promise<ChunkRecord[]> {
    const db = this.requireDb();
    return db.getAllFromIndex("chunks", "worldUuid", worldUuid) as Promise<
      ChunkRecord[]
    >;
  }

  /**
   * Build a portable JSON snapshot of the world (metadata + every chunk).
   * Large worlds produce large objects; stringify only when writing a file.
   */
  async exportWorldBundle(worldUuid: string): Promise<StratumWorldExportV1> {
    const meta = await this.loadWorld(worldUuid);
    if (meta === undefined) {
      throw new Error(`World not found: ${worldUuid}`);
    }
    const chunks = await this.listAllChunksForWorld(worldUuid);
    return buildStratumWorldExportV1(meta, chunks);
  }

  /**
   * Import a snapshot from {@link exportWorldBundle}; assigns a new world UUID
   * and writes metadata + chunks. Returns the new UUID.
   */
  async importWorldBundle(parsed: unknown): Promise<string> {
    const db = this.requireDb();
    const newUuid = crypto.randomUUID();
    const { metadata, chunks } = parseStratumWorldImportV1(parsed, newUuid);
    const tx = db.transaction(["worlds", "chunks"], "readwrite");
    const worldPut = tx.objectStore("worlds").put(metadata);
    const chunkStore = tx.objectStore("chunks");
    const chunkPuts = chunks.map((c) => chunkStore.put(c));
    await Promise.all([worldPut, ...chunkPuts, tx.done]);
    return newUuid;
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

  /**
   * Read many chunks in one IndexedDB transaction, preserving input order.
   * This avoids opening a separate transaction per chunk during world streaming.
   */
  async loadChunkBatch(
    worldUuid: string,
    coords: readonly ChunkCoord[],
  ): Promise<(ChunkRecord | undefined)[]> {
    if (coords.length === 0) {
      return [];
    }
    const db = this.requireDb();
    const tx = db.transaction("chunks", "readonly");
    const loads = coords.map((coord) =>
      tx.store.get(chunkStoreKey(worldUuid, coord)),
    ) as Promise<(ChunkRecord | undefined)>[];
    const records = await Promise.all(loads);
    await tx.done;
    return records;
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
      ...(typeof row.selectedSkinId === "string" && row.selectedSkinId.length > 0
        ? { selectedSkinId: row.selectedSkinId }
        : {}),
    };
  }

  async loadDevPackDirectoryHandle(): Promise<FileSystemDirectoryHandle | null> {
    const db = this.requireDb();
    if (!db.objectStoreNames.contains("dev_packs")) {
      return null;
    }
    const handle = (await db.get(
      "dev_packs",
      DEV_PACKS_KEY,
    )) as FileSystemDirectoryHandle | null | undefined;
    return handle ?? null;
  }

  async saveDevPackDirectoryHandle(handle: FileSystemDirectoryHandle | null): Promise<void> {
    const db = this.requireDb();
    if (!db.objectStoreNames.contains("dev_packs")) {
      throw new Error('IndexedDB object store "dev_packs" is missing; reload the page.');
    }
    if (handle === null) {
      await db.delete("dev_packs", DEV_PACKS_KEY);
      return;
    }
    await db.put("dev_packs", handle, DEV_PACKS_KEY);
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
    const skinId = settings.selectedSkinId ?? prev.selectedSkinId;
    if (skinId !== undefined) {
      payload.selectedSkinId = skinId;
    }
    await db.put("player_settings", payload, PLAYER_SETTINGS_KEY);
  }

  // ── Custom Skins ──────────────────────────────────────────────────

  async putCustomSkin(id: string, label: string, blob: Blob): Promise<void> {
    const db = this.requireDb();
    if (!db.objectStoreNames.contains(CUSTOM_SKINS_STORE)) {
      throw new Error(
        `IndexedDB object store "${CUSTOM_SKINS_STORE}" is missing; reload the page.`,
      );
    }
    await db.put(CUSTOM_SKINS_STORE, { id, label, blob, createdAt: Date.now() });
  }

  async listCustomSkins(): Promise<
    Array<{ id: string; label: string; blob: Blob; createdAt: number }>
  > {
    const db = this.requireDb();
    if (!db.objectStoreNames.contains(CUSTOM_SKINS_STORE)) {
      return [];
    }
    return db.getAll(CUSTOM_SKINS_STORE);
  }

  async getCustomSkin(
    id: string,
  ): Promise<{ id: string; label: string; blob: Blob; createdAt: number } | undefined> {
    const db = this.requireDb();
    if (!db.objectStoreNames.contains(CUSTOM_SKINS_STORE)) {
      return undefined;
    }
    return db.get(CUSTOM_SKINS_STORE, id) as Promise<
      { id: string; label: string; blob: Blob; createdAt: number } | undefined
    >;
  }

  async deleteCustomSkin(id: string): Promise<void> {
    const db = this.requireDb();
    if (!db.objectStoreNames.contains(CUSTOM_SKINS_STORE)) {
      return;
    }
    await db.delete(CUSTOM_SKINS_STORE, id);
  }

  private requireDb(): IDBPDatabase {
    if (!this.db) {
      throw new Error("IndexedDBStore.openDB() must complete first");
    }
    return this.db;
  }
}
