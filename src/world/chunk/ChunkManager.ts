/** In-memory chunk cache with simulation-distance eviction and optional generator fill. */
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

  /**
   * Loaded chunks whose Chebyshev distance from `centre` is at most `distance`.
   * Iterates the axis-aligned square of chunk coordinates only (O(distance²)), not all loaded chunks.
   */
  *getChunksWithinDistance(centre: ChunkCoord, distance: number): Iterable<Chunk> {
    const { cx: ccx, cy: ccy } = centre;
    const loX = ccx - distance;
    const hiX = ccx + distance;
    const loY = ccy - distance;
    const hiY = ccy + distance;
    for (let cx = loX; cx <= hiX; cx++) {
      const row = this.loaded.get(cx);
      if (row === undefined) {
        continue;
      }
      for (let cy = loY; cy <= hiY; cy++) {
        const chunk = row.get(cy);
        if (chunk !== undefined) {
          yield chunk;
        }
      }
    }
  }

  markAllDirty(): void {
    for (const row of this.loaded.values()) {
      for (const chunk of row.values()) {
        chunk.dirty = true;
        chunk.renderDirty = true;
      }
    }
  }

  /**
   * Drops chunks whose Chebyshev distance from `centre` exceeds `maxDistance`, except
   * columns with |cx| <= `spawnStripRadius` (kept once loaded, up to `maxSpawnStripColumns`).
   * After distance eviction, enforces `maxLoadedChunks` hard cap by evicting the farthest
   * chunks regardless of spawn-strip status.
   * @returns Evicted chunk coordinates (for cache invalidation, etc.).
   */
  updateLoadedChunks(
    centre: ChunkCoord,
    maxDistance: number,
    spawnStripRadius: number,
    maxLoadedChunks = Infinity,
    maxSpawnStripColumns = Infinity,
  ): ChunkCoord[] {
    const evicted: ChunkCoord[] = [];

    // Count spawn-strip columns currently loaded.
    let spawnStripColumnCount = 0;
    if (maxSpawnStripColumns < Infinity) {
      const seen = new Set<number>();
      for (const row of this.loaded.values()) {
        for (const chunk of row.values()) {
          if (Math.abs(chunk.coord.cx) <= spawnStripRadius) {
            seen.add(chunk.coord.cx);
          }
        }
      }
      spawnStripColumnCount = seen.size;
    }

    // Pass 1: distance-based eviction with spawn-strip exemption.
    for (const row of this.loaded.values()) {
      for (const chunk of row.values()) {
        const d = Math.max(
          Math.abs(chunk.coord.cx - centre.cx),
          Math.abs(chunk.coord.cy - centre.cy),
        );
        const inSpawnStrip =
          Math.abs(chunk.coord.cx) <= spawnStripRadius &&
          spawnStripColumnCount <= maxSpawnStripColumns;
        if (d > maxDistance && !inSpawnStrip) {
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

    // Pass 2: hard cap enforcement — evict farthest chunks regardless of spawn-strip.
    if (maxLoadedChunks < Infinity) {
      let loadedCount = 0;
      for (const row of this.loaded.values()) {
        loadedCount += row.size;
      }
      if (loadedCount > maxLoadedChunks) {
        const all: { cx: number; cy: number; dist: number }[] = [];
        for (const row of this.loaded.values()) {
          for (const chunk of row.values()) {
            all.push({
              cx: chunk.coord.cx,
              cy: chunk.coord.cy,
              dist: Math.max(
                Math.abs(chunk.coord.cx - centre.cx),
                Math.abs(chunk.coord.cy - centre.cy),
              ),
            });
          }
        }
        all.sort((a, b) => b.dist - a.dist);
        const excess = loadedCount - maxLoadedChunks;
        for (let i = 0; i < excess; i++) {
          const c = all[i]!;
          evicted.push({ cx: c.cx, cy: c.cy });
          const row = this.loaded.get(c.cx);
          if (row !== undefined) {
            row.delete(c.cy);
            if (row.size === 0) {
              this.loaded.delete(c.cx);
            }
          }
        }
      }
    }

    return evicted;
  }
}
