/**
 * Chunk + world metadata persistence via IndexedDB (`idb`).
 */
import { openDB, type IDBPDatabase } from "idb";
import type { Chunk } from "../world/chunk/Chunk";
import { chunkKey, type ChunkCoord } from "../world/chunk/ChunkCoord";

export const DB_NAME = "turfd";
export const DB_VERSION = 1;

export type WorldMetadata = {
  uuid: string;
  name: string;
  seed: number;
  createdAt: number;
  lastPlayedAt: number;
  playerX: number;
  playerY: number;
  hotbarSlot: number;
  modList: string[];
  /** Optional for worlds saved before world time persistence was added. */
  worldTimeMs?: number;
  /** JPEG data URL of the last in-game view, captured on save (optional). */
  previewImageDataUrl?: string;
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
};

function chunkStoreKey(worldUuid: string, coord: ChunkCoord): string {
  return `${worldUuid}:${chunkKey(coord)}`;
}

export class IndexedDBStore {
  private db: IDBPDatabase | null = null;

  async openDB(): Promise<void> {
    if (this.db) {
      return;
    }
    this.db = await openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains("worlds")) {
          db.createObjectStore("worlds", { keyPath: "uuid" });
        }
        if (!db.objectStoreNames.contains("chunks")) {
          const chunkStore = db.createObjectStore("chunks", { keyPath: "key" });
          chunkStore.createIndex("worldUuid", "worldUuid", { unique: false });
        }
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

  async saveChunkBatch(worldUuid: string, chunks: Chunk[]): Promise<void> {
    if (chunks.length === 0) {
      return;
    }
    const db = this.requireDb();
    const tx = db.transaction("chunks", "readwrite");
    const puts = chunks.map((chunk) => {
      const record = this.toChunkRecord(worldUuid, chunk);
      return tx.store.put(record);
    });
    await Promise.all([...puts, tx.done]);
  }

  private toChunkRecord(worldUuid: string, chunk: Chunk): ChunkRecord {
    const { cx, cy } = chunk.coord;
    return {
      key: chunkStoreKey(worldUuid, chunk.coord),
      worldUuid,
      cx,
      cy,
      blocks: new Uint16Array(chunk.blocks),
      metadata: new Uint8Array(chunk.metadata),
      background: new Uint16Array(chunk.background),
    };
  }

  private requireDb(): IDBPDatabase {
    if (!this.db) {
      throw new Error("IndexedDBStore.openDB() must complete first");
    }
    return this.db;
  }
}
