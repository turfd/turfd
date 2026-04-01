/** Foreground + back-wall meshes per chunk on `layerTilesBack` (background drawn first). */
import { Graphics, type Mesh } from "pixi.js";
import type { BlockRegistry } from "../../world/blocks/BlockRegistry";
import type { Chunk } from "../../world/chunk/Chunk";
import type { ChunkCoord } from "../../world/chunk/ChunkCoord";
import { BLOCK_SIZE } from "../../core/constants";
import { chunkKey, chunkToWorldOrigin } from "../../world/chunk/ChunkCoord";
import type { World } from "../../world/World";
import type { AtlasLoader } from "../AtlasLoader";
import type { RenderPipeline } from "../RenderPipeline";
import {
  buildBackgroundMesh,
  buildMesh,
  createWorldFgShadowSampler,
  redrawForegroundCastShadowOnBackground,
  updateBackgroundMesh,
  updateMesh,
} from "./TileDrawBatch";
import { chunkPerfLog, chunkPerfNow } from "../../debug/chunkPerf";

type ChunkMeshes = { bg: Mesh; fgShadow: Graphics; fg: Mesh };

export class ChunkRenderer {
  private readonly pipeline: RenderPipeline;
  private readonly registry: BlockRegistry;
  private readonly atlas: AtlasLoader;
  private readonly fgShadowSampler: ReturnType<typeof createWorldFgShadowSampler>;
  private readonly meshes = new Map<string, ChunkMeshes>();
  /** Reused in {@link syncChunks} to avoid per-frame `Set` allocation. */
  private readonly _syncSeen = new Set<string>();

  constructor(
    pipeline: RenderPipeline,
    registry: BlockRegistry,
    atlas: AtlasLoader,
    world: World,
  ) {
    this.pipeline = pipeline;
    this.registry = registry;
    this.atlas = atlas;
    this.fgShadowSampler = createWorldFgShadowSampler(world);
  }

  syncChunks(loadedChunks: Iterable<Chunk>): void {
    const t0 = import.meta.env.DEV ? chunkPerfNow() : 0;
    let added = 0;
    let updated = 0;
    const layer = this.pipeline.layerTilesBack;
    const seen = this._syncSeen;
    seen.clear();

    for (const chunk of loadedChunks) {
      const key = chunkKey(chunk.coord);
      seen.add(key);
      let triple = this.meshes.get(key);
      if (triple === undefined) {
        const bg = buildBackgroundMesh(chunk, this.registry, this.atlas);
        const fgShadow = new Graphics({ roundPixels: true });
        const fg = buildMesh(chunk, this.registry, this.atlas);
        redrawForegroundCastShadowOnBackground(
          fgShadow,
          chunk,
          this.fgShadowSampler,
        );
        this.positionChunkRoot(bg, chunk.coord);
        this.positionChunkRoot(fgShadow, chunk.coord);
        this.positionChunkRoot(fg, chunk.coord);
        layer.addChild(bg);
        layer.addChild(fgShadow);
        layer.addChild(fg);
        this.meshes.set(key, { bg, fgShadow, fg });
        chunk.dirty = false;
        added += 1;
      } else if (chunk.dirty) {
        updateBackgroundMesh(triple.bg, chunk, this.registry, this.atlas);
        redrawForegroundCastShadowOnBackground(
          triple.fgShadow,
          chunk,
          this.fgShadowSampler,
        );
        updateMesh(triple.fg, chunk, this.registry, this.atlas);
        this.positionChunkRoot(triple.bg, chunk.coord);
        this.positionChunkRoot(triple.fgShadow, chunk.coord);
        this.positionChunkRoot(triple.fg, chunk.coord);
        chunk.dirty = false;
        updated += 1;
      }
    }

    let removed = 0;
    for (const key of this.meshes.keys()) {
      if (!seen.has(key)) {
        const { bg, fgShadow, fg } = this.meshes.get(key)!;
        layer.removeChild(bg);
        layer.removeChild(fgShadow);
        layer.removeChild(fg);
        bg.destroy();
        fgShadow.destroy();
        fg.destroy();
        this.meshes.delete(key);
        removed += 1;
      }
    }

    if (import.meta.env.DEV && (added > 0 || updated > 0 || removed > 0)) {
      chunkPerfLog("syncChunks", chunkPerfNow() - t0, { added, updated, removed });
    }
  }

  destroy(): void {
    const layer = this.pipeline.layerTilesBack;
    for (const { bg, fgShadow, fg } of this.meshes.values()) {
      layer.removeChild(bg);
      layer.removeChild(fgShadow);
      layer.removeChild(fg);
      bg.destroy();
      fgShadow.destroy();
      fg.destroy();
    }
    this.meshes.clear();
  }

  private positionChunkRoot(
    node: { position: { set: (x: number, y: number) => void } },
    coord: ChunkCoord,
  ): void {
    const origin = chunkToWorldOrigin(coord);
    node.position.set(origin.wx * BLOCK_SIZE, -origin.wy * BLOCK_SIZE);
  }
}
