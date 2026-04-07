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

export class ChunkSyncManager {
  constructor(private readonly _adapter: INetworkAdapter) {}

  sendAllChunksTo(peerId: PeerId, iterate: ChunkDataProvider): void {
    const BLOCKS_PER_CHUNK = CHUNK_SIZE * CHUNK_SIZE;
    iterate((chunk) => {
      if (
        chunk.blocks.length !== BLOCKS_PER_CHUNK ||
        chunk.background.length !== BLOCKS_PER_CHUNK
      ) {
        return;
      }
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
    });
  }
}
