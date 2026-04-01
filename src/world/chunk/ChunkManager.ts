/** In-memory chunk cache with view-distance eviction and optional generator fill. */
import { VIEW_DISTANCE_CHUNKS } from "../../core/constants";
import type { ChunkCoord } from "./ChunkCoord";
import type { Chunk } from "./Chunk";

export type ChunkGenerator = (coord: ChunkCoord) => Chunk;

export class ChunkManager {
  /** Nested maps avoid string key allocation on every lookup. */
  private readonly loaded = new Map<number, Map<number, Chunk>>();

  /** Hot-path lookup without allocating a {@link ChunkCoord}. */
  getChunkXY(cx: number, cy: number): Chunk | undefined {
    return this.loaded.get(cx)?.get(cy);
  }

  getChunk(coord: ChunkCoord): Chunk | undefined {
    return this.getChunkXY(coord.cx, coord.cy);
  }

  getOrCreateChunk(coord: ChunkCoord, generator: ChunkGenerator): Chunk {
    let row = this.loaded.get(coord.cx);
    if (row === undefined) {
      row = new Map();
      this.loaded.set(coord.cx, row);
    }
    let chunk = row.get(coord.cy);
    if (chunk === undefined) {
      chunk = generator(coord);
      row.set(coord.cy, chunk);
    }
    return chunk;
  }

  /** Insert or replace a chunk (e.g. loaded from persistence). */
  putChunk(chunk: Chunk): void {
    const { cx, cy } = chunk.coord;
    let row = this.loaded.get(cx);
    if (row === undefined) {
      row = new Map();
      this.loaded.set(cx, row);
    }
    row.set(cy, chunk);
  }

  unloadChunk(coord: ChunkCoord): void {
    const row = this.loaded.get(coord.cx);
    if (row === undefined) {
      return;
    }
    row.delete(coord.cy);
    if (row.size === 0) {
      this.loaded.delete(coord.cx);
    }
  }

  /** All loaded chunks (for mesh sync, save, iteration). */
  getLoadedChunks(): Iterable<Chunk> {
    const loaded = this.loaded;
    return {
      *[Symbol.iterator]() {
        for (const row of loaded.values()) {
          for (const chunk of row.values()) {
            yield chunk;
          }
        }
      },
    };
  }

  markAllDirty(): void {
    for (const row of this.loaded.values()) {
      for (const chunk of row.values()) {
        chunk.dirty = true;
      }
    }
  }

  /**
   * Drops chunks whose Chebyshev distance from `centre` exceeds {@link VIEW_DISTANCE_CHUNKS}.
   * @returns Evicted chunk coordinates (for cache invalidation, etc.).
   */
  updateLoadedChunks(centre: ChunkCoord): ChunkCoord[] {
    const evicted: ChunkCoord[] = [];
    for (const row of this.loaded.values()) {
      for (const chunk of row.values()) {
        const d = Math.max(
          Math.abs(chunk.coord.cx - centre.cx),
          Math.abs(chunk.coord.cy - centre.cy),
        );
        if (d > VIEW_DISTANCE_CHUNKS) {
          evicted.push({ cx: chunk.coord.cx, cy: chunk.coord.cy });
        }
      }
    }
    for (const { cx, cy } of evicted) {
      const row = this.loaded.get(cx);
      if (row === undefined) {
        continue;
      }
      row.delete(cy);
      if (row.size === 0) {
        this.loaded.delete(cx);
      }
    }
    return evicted;
  }
}
