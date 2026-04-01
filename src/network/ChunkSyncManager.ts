/** Host-driven chunk replication over `INetworkAdapter` and client-side chunk events via `EventBus`. */

// PERF: No ack / pending-set — joining clients always receive a full snapshot; resend-on-reconnect
// could duplicate work if extended without tracking acknowledged chunk keys.

import { CHUNK_SIZE } from "../core/constants";
import type { EventBus } from "../core/EventBus";
import type { INetworkAdapter, PeerId } from "./INetworkAdapter";
import { MsgType, type NetworkMessage } from "./protocol/messages";

type ChunkSnapshot = {
  chunkX: number;
  chunkY: number;
  blocks: Uint16Array;
  background: Uint16Array;
};

type ChunkIterator = (fn: (chunk: ChunkSnapshot) => void) => void;

type ChunkDataProvider = ChunkIterator;

export class ChunkSyncManager {
  constructor(
    private readonly _adapter: INetworkAdapter,
    private readonly _bus: EventBus,
  ) {}

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
      };
      this._adapter.send(peerId, msg);
    });
  }

  handleInbound(msg: NetworkMessage): void {
    if (msg.type !== MsgType.CHUNK_DATA) {
      return;
    }

    // Copy the blocks array — the receiver owns this memory.
    const blocks = msg.blocks.slice();

    this._bus.emit({
      type: "network:chunk-received",
      chunkX: msg.cx,
      chunkY: msg.cy,
      blocks,
      background: msg.background?.slice(),
    });
  }
}
