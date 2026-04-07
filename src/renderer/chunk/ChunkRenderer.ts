/** Foreground + back-wall meshes per chunk on `layerTilesBack` (background drawn first). */
import { Rectangle, type Mesh } from "pixi.js";
import type { BlockRegistry } from "../../world/blocks/BlockRegistry";
import type { Chunk } from "../../world/chunk/Chunk";
import type { ChunkCoord } from "../../world/chunk/ChunkCoord";
import { BLOCK_SIZE, CHUNK_SIZE } from "../../core/constants";
import { chunkKey, chunkToWorldOrigin } from "../../world/chunk/ChunkCoord";
import type { World } from "../../world/World";
import type { AtlasLoader } from "../AtlasLoader";
import type { RenderPipeline } from "../RenderPipeline";
import {
  applyFurnaceFireToMesh,
  applyWindSwayToMesh,
  buildBackgroundMesh,
  buildFgShadowMesh,
  buildMesh,
  createWorldFgShadowSampler,
  updateBackgroundMesh,
  updateFgShadowMesh,
  updateMesh,
  type TileMeshBuildOptions,
  type TileFurnaceFire,
  type TileWindSway,
} from "./TileDrawBatch";
import { chunkPerfLog, chunkPerfNow } from "../../debug/chunkPerf";

type ChunkMeshes = { bg: Mesh; fgShadow: Mesh; fg: Mesh };

/** Padding around chunk AABB in mesh local space (wind sway, plant offsets). */
const CHUNK_MESH_CULL_PAD = 32;
/** Extra height for {@link BlockDefinition.plantRenderOffsetYPx} and similar. */
const CHUNK_MESH_CULL_TOP_PAD = 24;

export class ChunkRenderer {
  private readonly pipeline: RenderPipeline;
  private readonly registry: BlockRegistry;
  private readonly atlas: AtlasLoader;
  private readonly world: World;
  private readonly fgShadowSampler: ReturnType<typeof createWorldFgShadowSampler>;
  private readonly meshes = new Map<string, ChunkMeshes>();
  private readonly fgWindSways = new WeakMap<Mesh, TileWindSway[]>();
  /** Foreground meshes that have at least one wind sway tile (see {@link updateFoliageWind}). */
  private readonly _windyForegroundMeshes = new Set<Mesh>();
  /** Foreground meshes with lit furnace fire UV animation (see {@link updateFurnaceFire}). */
  private readonly _furnaceFireForegroundMeshes = new Set<Mesh>();
  private readonly fgFurnaceFires = new WeakMap<Mesh, TileFurnaceFire[]>();
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
    this.world = world;
    this.fgShadowSampler = createWorldFgShadowSampler(world);
  }

  private tileMeshOpts(): TileMeshBuildOptions {
    const chestBlockId = this.world.getChestBlockId();
    const furnaceBlockId = this.world.getFurnaceBlockId();
    return {
      chestBlockId,
      furnaceBlockId,
      isFurnaceLit: (wx, wy) => this.world.isFurnaceVisuallyLit(wx, wy),
      sampleBlockId: (wx, wy) => this.world.getForegroundBlockId(wx, wy),
      isDoorEffectivelyOpen: (wx, wy) => this.world.isDoorEffectivelyOpen(wx, wy),
      getDoorRenderHingeRight: (wx, wy) => this.world.getDoorRenderHingeRight(wx, wy),
    };
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
        const fgShadow = buildFgShadowMesh(chunk, this.fgShadowSampler);
        const { mesh: fg, windSways, furnaceFires } = buildMesh(
          chunk,
          this.registry,
          this.atlas,
          this.tileMeshOpts(),
        );
        this.syncWindyFg(fg, windSways);
        this.syncFurnaceFg(fg, furnaceFires);
        this.applyChunkMeshCulling(bg);
        this.applyChunkMeshCulling(fgShadow);
        this.applyChunkMeshCulling(fg);
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
        updateFgShadowMesh(triple.fgShadow, chunk, this.fgShadowSampler);
        const { windSways, furnaceFires } = updateMesh(
          triple.fg,
          chunk,
          this.registry,
          this.atlas,
          this.tileMeshOpts(),
        );
        this.syncWindyFg(triple.fg, windSways);
        this.syncFurnaceFg(triple.fg, furnaceFires);
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
        this._windyForegroundMeshes.delete(fg);
        this._furnaceFireForegroundMeshes.delete(fg);
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

  /** Subtle pixel-snapped sway on foliage foreground tiles (see block `windSwayMaxPx`). */
  updateFoliageWind(timeSec: number): void {
    for (const fg of this._windyForegroundMeshes) {
      applyWindSwayToMesh(fg, this.fgWindSways.get(fg) ?? [], timeSec);
    }
  }

  /** Lit furnace `furnace_on` strip animation (UV ping-pong). */
  updateFurnaceFire(timeSec: number): void {
    for (const fg of this._furnaceFireForegroundMeshes) {
      applyFurnaceFireToMesh(
        fg,
        this.atlas,
        this.fgFurnaceFires.get(fg) ?? [],
        timeSec,
      );
    }
  }

  destroy(): void {
    this._windyForegroundMeshes.clear();
    this._furnaceFireForegroundMeshes.clear();
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

  private syncWindyFg(fg: Mesh, windSways: TileWindSway[]): void {
    this.fgWindSways.set(fg, windSways);
    if (windSways.length > 0) {
      this._windyForegroundMeshes.add(fg);
    } else {
      this._windyForegroundMeshes.delete(fg);
    }
  }

  private syncFurnaceFg(fg: Mesh, furnaceFires: TileFurnaceFire[]): void {
    this.fgFurnaceFires.set(fg, furnaceFires);
    if (furnaceFires.length > 0) {
      this._furnaceFireForegroundMeshes.add(fg);
    } else {
      this._furnaceFireForegroundMeshes.delete(fg);
    }
  }

  /**
   * Chunk geometry lives in local space with y ≤ 0 (see TileDrawBatch). Pixi Culler uses
   * `cullArea` in local space for cheap bounds checks.
   */
  private applyChunkMeshCulling(m: Mesh): void {
    const cw = CHUNK_SIZE * BLOCK_SIZE;
    const p = CHUNK_MESH_CULL_PAD;
    m.cullable = true;
    m.cullArea = new Rectangle(
      -p,
      -(cw + p),
      cw + p * 2,
      cw + p * 2 + CHUNK_MESH_CULL_TOP_PAD,
    );
  }
}
