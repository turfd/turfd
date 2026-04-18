/**
 * Back-wall + foreground chunk meshes on `layerTilesBack`, and a water-only mesh on
 * `layerWaterOverEntities` so fluid draws above entities.
 */
import { Rectangle, type Mesh } from "pixi.js";
import type { BlockRegistry } from "../../world/blocks/BlockRegistry";
import type { Chunk } from "../../world/chunk/Chunk";
import type { ChunkCoord } from "../../world/chunk/ChunkCoord";
import {
  BLOCK_SIZE,
  CHUNK_SIZE,
  CHUNK_SYNC_MAX_PER_FRAME,
} from "../../core/constants";
import { chunkKey, chunkToWorldOrigin } from "../../world/chunk/ChunkCoord";
import type { World } from "../../world/World";
import type { AtlasLoader } from "../AtlasLoader";
import type { RenderPipeline } from "../RenderPipeline";
import {
  applyWaterRipplesToMesh,
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
  type FoliageWindInfluence,
  type TileFurnaceFire,
  type TileWaterSurface,
  type TileWindSway,
  type WaterRippleSample,
} from "./TileDrawBatch";
import { chunkPerfLog, chunkPerfNow } from "../../debug/chunkPerf";

type ChunkMeshes = { bg: Mesh; fgShadow: Mesh; fg: Mesh; fgWater: Mesh };

export type WaterRippleBodySample = {
  id: string;
  feetX: number;
  feetY: number;
  vx: number;
  vy: number;
  inWater: boolean;
};

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
  private readonly fgWaterSurfaces = new WeakMap<Mesh, TileWaterSurface[]>();
  private readonly _wateryForegroundMeshes = new Set<Mesh>();
  private readonly _lastWaterContactByBody = new Map<string, boolean>();
  private readonly _lastTrailSpawnByBody = new Map<string, number>();
  private readonly _waterRippleSamples: WaterRippleSample[] = [];
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
    const waterLayer = this.pipeline.layerWaterOverEntities;
    const seen = this._syncSeen;
    seen.clear();
    let seenCount = 0;
    let updatesThisFrame = 0;

    for (const chunk of loadedChunks) {
      seenCount += 1;
      const key = chunkKey(chunk.coord);
      seen.add(key);
      let triple = this.meshes.get(key);
      if (triple === undefined) {
        const bg = buildBackgroundMesh(chunk, this.registry, this.atlas);
        const fgShadow = buildFgShadowMesh(chunk, this.fgShadowSampler);
        const {
          mesh: fg,
          waterMesh: fgWater,
          windSways,
          furnaceFires,
          waterSurfaces,
        } = buildMesh(chunk, this.registry, this.atlas, this.tileMeshOpts());
        this.syncWindyFg(fg, windSways);
        this.syncFurnaceFg(fg, furnaceFires);
        this.syncWateryFg(fgWater, waterSurfaces);
        this.applyChunkMeshCulling(bg);
        this.applyChunkMeshCulling(fgShadow);
        this.applyChunkMeshCulling(fg);
        this.applyChunkMeshCulling(fgWater);
        this.positionChunkRoot(bg, chunk.coord);
        this.positionChunkRoot(fgShadow, chunk.coord);
        this.positionChunkRoot(fg, chunk.coord);
        this.positionChunkRoot(fgWater, chunk.coord);
        layer.addChild(bg);
        layer.addChild(fgShadow);
        layer.addChild(fg);
        waterLayer.addChild(fgWater);
        this.meshes.set(key, { bg, fgShadow, fg, fgWater });
        chunk.dirty = false;
        chunk.renderDirty = false;
        added += 1;
      } else if (chunk.renderDirty) {
        if (updatesThisFrame >= CHUNK_SYNC_MAX_PER_FRAME) {
          continue;
        }
        updatesThisFrame += 1;
        updateBackgroundMesh(triple.bg, chunk, this.registry, this.atlas);
        updateFgShadowMesh(triple.fgShadow, chunk, this.fgShadowSampler);
        const { windSways, furnaceFires, waterSurfaces } = updateMesh(
          triple.fg,
          triple.fgWater,
          chunk,
          this.registry,
          this.atlas,
          this.tileMeshOpts(),
        );
        this.syncWindyFg(triple.fg, windSways);
        this.syncFurnaceFg(triple.fg, furnaceFires);
        this.syncWateryFg(triple.fgWater, waterSurfaces);
        this.positionChunkRoot(triple.bg, chunk.coord);
        this.positionChunkRoot(triple.fgShadow, chunk.coord);
        this.positionChunkRoot(triple.fg, chunk.coord);
        this.positionChunkRoot(triple.fgWater, chunk.coord);
        chunk.dirty = false;
        chunk.renderDirty = false;
        updated += 1;
      }
    }

    let removed = 0;
    if (added > 0 || seenCount !== this.meshes.size) {
      for (const key of this.meshes.keys()) {
        if (!seen.has(key)) {
          const { bg, fgShadow, fg, fgWater } = this.meshes.get(key)!;
          this._windyForegroundMeshes.delete(fg);
          this._furnaceFireForegroundMeshes.delete(fg);
          this._wateryForegroundMeshes.delete(fgWater);
          layer.removeChild(bg);
          layer.removeChild(fgShadow);
          layer.removeChild(fg);
          waterLayer.removeChild(fgWater);
          bg.destroy();
          fgShadow.destroy();
          fg.destroy();
          fgWater.destroy();
          this.meshes.delete(key);
          removed += 1;
        }
      }
    }

    if (import.meta.env.DEV && (added > 0 || updated > 0 || removed > 0)) {
      chunkPerfLog("syncChunks", chunkPerfNow() - t0, {
        added,
        updated,
        removed,
        seenCount,
      });
    }
  }

  /** Subtle pixel-snapped sway on foliage foreground tiles (see block `windSwayMaxPx`). */
  updateFoliageWind(
    timeSec: number,
    influences?: readonly FoliageWindInfluence[],
  ): void {
    for (const fg of this._windyForegroundMeshes) {
      applyWindSwayToMesh(
        fg,
        this.fgWindSways.get(fg) ?? [],
        timeSec,
        influences,
      );
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

  updateWaterRipples(
    timeSec: number,
    bodies: readonly WaterRippleBodySample[] | undefined,
  ): void {
    if (bodies !== undefined && bodies.length > 0) {
      const seen = new Set<string>();
      for (const b of bodies) {
        seen.add(b.id);
        const wasInWater = this._lastWaterContactByBody.get(b.id) ?? false;
        if (b.inWater && !wasInWater) {
          this._waterRippleSamples.push({
            x: b.feetX,
            y: b.feetY,
            amplitude: 0.6 + Math.min(0.8, Math.abs(b.vy) / 380),
            bornTimeSec: timeSec,
          });
        } else if (b.inWater) {
          const speed = Math.hypot(b.vx, b.vy);
          if (speed >= 68) {
            const last = this._lastTrailSpawnByBody.get(b.id) ?? Number.NEGATIVE_INFINITY;
            if (timeSec - last >= 0.18) {
              this._waterRippleSamples.push({
                x: b.feetX,
                y: b.feetY,
                amplitude: 0.22 + Math.min(0.3, speed / 650),
                bornTimeSec: timeSec,
              });
              this._lastTrailSpawnByBody.set(b.id, timeSec);
            }
          }
        }
        this._lastWaterContactByBody.set(b.id, b.inWater);
      }
      for (const id of this._lastWaterContactByBody.keys()) {
        if (!seen.has(id)) {
          this._lastWaterContactByBody.delete(id);
          this._lastTrailSpawnByBody.delete(id);
        }
      }
    }
    for (let i = this._waterRippleSamples.length - 1; i >= 0; i--) {
      if (timeSec - this._waterRippleSamples[i]!.bornTimeSec > 1.35) {
        this._waterRippleSamples.splice(i, 1);
      }
    }
    for (const fg of this._wateryForegroundMeshes) {
      applyWaterRipplesToMesh(
        fg,
        this.fgWaterSurfaces.get(fg) ?? [],
        timeSec,
        this._waterRippleSamples,
      );
    }
  }

  destroy(): void {
    this._windyForegroundMeshes.clear();
    this._furnaceFireForegroundMeshes.clear();
    this._wateryForegroundMeshes.clear();
    this._lastWaterContactByBody.clear();
    this._lastTrailSpawnByBody.clear();
    this._waterRippleSamples.length = 0;
    const layer = this.pipeline.layerTilesBack;
    const waterLayer = this.pipeline.layerWaterOverEntities;
    for (const { bg, fgShadow, fg, fgWater } of this.meshes.values()) {
      layer.removeChild(bg);
      layer.removeChild(fgShadow);
      layer.removeChild(fg);
      waterLayer.removeChild(fgWater);
      bg.destroy();
      fgShadow.destroy();
      fg.destroy();
      fgWater.destroy();
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

  private syncWateryFg(fg: Mesh, waterSurfaces: TileWaterSurface[]): void {
    this.fgWaterSurfaces.set(fg, waterSurfaces);
    if (waterSurfaces.length > 0) {
      this._wateryForegroundMeshes.add(fg);
    } else {
      this._wateryForegroundMeshes.delete(fg);
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
