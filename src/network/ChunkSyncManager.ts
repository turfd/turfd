/** Host-driven chunk replication over `INetworkAdapter` (outbound snapshot to joining peers). */

// PERF: No ack / pending-set — joining clients always receive a full snapshot; resend-on-reconnect
// could duplicate work if extended without tracking acknowledged chunk keys.

import { CHUNK_SIZE } from "../core/constants";
import type { FurnacePersistedChunk } from "../world/furnace/furnacePersisted";
import type { ChestPersistedChunk } from "../world/chest/chestPersisted";
import type { INetworkAdapter, PeerId } from "./INetworkAdapter";
import { MsgType, type NetworkMessage } from "./protocol/messages";

type ChunkSnapshot = {
  chunkX: number;
  chunkY: number;
  blocks: Uint16Array;
  background: Uint16Array;
  furnaces?: FurnacePersistedChunk[];
  chests?: ChestPersistedChunk[];
  metadata?: Uint8Array;
};

type ChunkIterator = (fn: (chunk: ChunkSnapshot) => void) => void;

type ChunkDataProvider = ChunkIterator;

const SYNC_BATCH_SIZE = 10;

export class ChunkSyncManager {
  private readonly _pendingTimeouts = new Map<string, number[]>();

  constructor(private readonly _adapter: INetworkAdapter) {}

  sendAllChunksTo(
    peerId: PeerId,
    iterate: ChunkDataProvider,
    playerSpawnCx: number,
    playerSpawnCy: number,
  ): void {
    const BLOCKS_PER_CHUNK = CHUNK_SIZE * CHUNK_SIZE;
    const collected: ChunkSnapshot[] = [];
    iterate((chunk) => {
      if (
        chunk.blocks.length !== BLOCKS_PER_CHUNK ||
        chunk.background.length !== BLOCKS_PER_CHUNK
      ) {
        return;
      }
      collected.push(chunk);
    });

    collected.sort((a, b) => {
      const da = Math.max(
        Math.abs(a.chunkX - playerSpawnCx),
        Math.abs(a.chunkY - playerSpawnCy),
      );
      const db = Math.max(
        Math.abs(b.chunkX - playerSpawnCx),
        Math.abs(b.chunkY - playerSpawnCy),
      );
      return da - db;
    });

    const totalChunks = collected.length;
    const totalBatches = Math.ceil(totalChunks / SYNC_BATCH_SIZE);
    if (import.meta.env.DEV) {
      console.debug(
        `[ChunkSync] streaming ${totalChunks} chunks in ${totalBatches} batches to ${peerId}`,
      );
    }

    const sendBatch = (startIdx: number): void => {
      const end = Math.min(startIdx + SYNC_BATCH_SIZE, collected.length);
      for (let i = startIdx; i < end; i++) {
        const chunk = collected[i]!;
        const msg: NetworkMessage = {
          type: MsgType.CHUNK_DATA,
          cx: chunk.chunkX,
          cy: chunk.chunkY,
          blocks: chunk.blocks,
          background: chunk.background,
          furnaces: chunk.furnaces,
          chests: chunk.chests,
          metadata: chunk.metadata?.slice(),
        };
        this._adapter.send(peerId, msg);
      }
    };

    // Send first batch synchronously so the client gets something immediately.
    sendBatch(0);

    // Schedule remaining batches with setTimeout(0) to yield between them.
    const timeouts: number[] = [];
    for (let batchStart = SYNC_BATCH_SIZE; batchStart < collected.length; batchStart += SYNC_BATCH_SIZE) {
      const start = batchStart;
      const id = window.setTimeout(() => sendBatch(start), 0);
      timeouts.push(id);
    }
    if (timeouts.length > 0) {
      this._pendingTimeouts.set(peerId, timeouts);
    }
  }

  cancelPendingSync(peerId: string): void {
    const timeouts = this._pendingTimeouts.get(peerId);
    if (timeouts !== undefined) {
      for (const id of timeouts) {
        clearTimeout(id);
      }
      this._pendingTimeouts.delete(peerId);
    }
  }
}
