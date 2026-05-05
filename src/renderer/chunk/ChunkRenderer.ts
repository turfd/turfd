/**
 * Back-wall + foreground chunk meshes on `layerTilesBack`, and a water-only mesh on
 * `layerWaterOverEntities` so fluid draws above entities.
 */
import { Rectangle, type Container, type Mesh } from "pixi.js";
import type { BlockRegistry } from "../../world/blocks/BlockRegistry";
import type { Chunk } from "../../world/chunk/Chunk";
import { getBlock } from "../../world/chunk/Chunk";
import type { ChunkCoord } from "../../world/chunk/ChunkCoord";
import {
  BLOCK_SIZE,
  CHUNK_SIZE,
  CHUNK_SYNC_BUDGET_MS,
  CHUNK_SYNC_DEFER_DIRTY_THRESHOLD,
  CHUNK_SYNC_MAX_PER_FRAME,
  CHUNK_SYNC_MAX_PER_FRAME_UNDER_LOAD,
  CHUNK_SYNC_NEW_MESH_BUDGET_MS,
  CHUNK_SYNC_NEW_MESH_MAX_PER_FRAME,
  VIEW_DISTANCE_CHUNKS,
} from "../../core/constants";
import { chunkKey, chunkToWorldOrigin, localIndex } from "../../world/chunk/ChunkCoord";
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
  buildTorchBloomUnderlayMesh,
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
import {
  buildLeafDecorationMesh,
  updateLeafDecorationMesh,
} from "./LeafDecorationBatch";
import { chunkPerfLog, chunkPerfNow } from "../../debug/chunkPerf";
import { withPerfSpan } from "../../debug/perfSpans";
import { getTorchBloomGradientTexture } from "../torchBloomGradientTexture";
import { getVideoPrefs } from "../../ui/settings/videoPrefs";

type ChunkMeshes = {
  bg: Mesh;
  fgShadow: Mesh;
  /** Additive underglow for placed torches; between {@link fgShadow} and {@link fg}. */
  fgTorchBloom: Mesh | null;
  /** Sorted local cell indices of torches; skip mesh rebuild when unchanged (dirty fg only). */
  fgTorchBloomLayoutKey: string;
  fg: Mesh;
  /** Bushy leaf decoration (stacked overlays + edge puffs); rendered after {@link fg}. */
  leafDeco: Mesh;
  fgWater: Mesh;
};

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
  /** `-1` when `stratum:torch` is not registered (e.g. stripped client). */
  private readonly _torchBlockId: number;
  private readonly meshes = new Map<string, ChunkMeshes>();
  private readonly fgWindSways = new WeakMap<Mesh, TileWindSway[]>();
  /** Foreground meshes that have at least one wind sway tile (see {@link updateFoliageWind}). */
  private readonly _windyForegroundMeshes = new Set<Mesh>();
  /** Chunk grid for each windy fg mesh — used to halve wind update rate far from the camera. */
  private readonly _windyFgChunkCoord = new WeakMap<Mesh, ChunkCoord>();
  private _foliageWindFrame = 0;
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
  private readonly _dirtyChunkQueue: Array<{
    chunk: Chunk;
    meshes: ChunkMeshes;
    distSq: number;
  }> = [];
  private readonly _dirtyChunkNearest = new Array<{
    chunk: Chunk;
    meshes: ChunkMeshes;
    distSq: number;
  }>();
  /**
   * Pending new-chunk mesh builds for the current `syncChunks` call. Drained
   * nearest-first under {@link CHUNK_SYNC_NEW_MESH_BUDGET_MS} /
   * {@link CHUNK_SYNC_NEW_MESH_MAX_PER_FRAME}; anything past the cap is
   * rediscovered on the next `syncChunks` call (its mesh entry is still
   * missing).
   */
  private readonly _newChunkQueue: Array<{
    chunk: Chunk;
    distSq: number;
  }> = [];

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
    this._torchBlockId = registry.isRegistered("stratum:torch")
      ? registry.getByIdentifier("stratum:torch").id
      : -1;
  }

  /** Stable key for {@link rebuildChunkTorchBloom} — only torch cells matter. */
  private torchBloomLayoutKey(chunk: Chunk): string {
    const tid = this._torchBlockId;
    if (tid < 0) {
      return "";
    }
    const ids: number[] = [];
    for (let ly = 0; ly < CHUNK_SIZE; ly++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        if (getBlock(chunk, lx, ly) === tid) {
          ids.push(localIndex(lx, ly));
        }
      }
    }
    ids.sort((a, b) => a - b);
    return ids.join(",");
  }

  private rebuildChunkTorchBloom(layer: Container, chunk: Chunk, meshes: ChunkMeshes): void {
    const layoutKey = this.torchBloomLayoutKey(chunk);
    if (
      meshes.fgTorchBloom !== null &&
      layoutKey === meshes.fgTorchBloomLayoutKey
    ) {
      meshes.fgTorchBloom.visible = getVideoPrefs().bloomEnabled;
      return;
    }

    const prev = meshes.fgTorchBloom;
    if (prev !== null) {
      layer.removeChild(prev);
      meshes.fgTorchBloom = null;
      // Match meshGeometryReuse / chunk unload: defer so WebGPU submit cannot reference freed buffers.
      queueMicrotask(() => {
        prev.destroy();
      });
    }
    meshes.fgTorchBloomLayoutKey = layoutKey;

    if (this._torchBlockId < 0) {
      return;
    }
    const mesh = buildTorchBloomUnderlayMesh(
      chunk,
      this._torchBlockId,
      getTorchBloomGradientTexture(),
    );
    if (mesh === null) {
      return;
    }
    this.applyChunkMeshCulling(mesh);
    this.positionChunkRoot(mesh, chunk.coord);
    mesh.visible = getVideoPrefs().bloomEnabled;
    const idx = layer.getChildIndex(meshes.fgShadow) + 1;
    layer.addChildAt(mesh, idx);
    meshes.fgTorchBloom = mesh;
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
    let dirtyQueued = 0;
    const meshOpts = this.tileMeshOpts();
    const sampleBlockId = meshOpts.sampleBlockId;
    const dirtyQueue = this._dirtyChunkQueue;
    dirtyQueue.length = 0;
    const nearestDirty = this._dirtyChunkNearest;
    nearestDirty.length = 0;
    const newQueue = this._newChunkQueue;
    newQueue.length = 0;
    const cam = this.pipeline.getCamera().getPosition();
    const cameraChunkX = Math.floor(cam.x / (CHUNK_SIZE * BLOCK_SIZE));
    const cameraChunkY = Math.floor((-cam.y) / (CHUNK_SIZE * BLOCK_SIZE));

    for (const chunk of loadedChunks) {
      seenCount += 1;
      const key = chunkKey(chunk.coord);
      seen.add(key);
      const triple = this.meshes.get(key);
      if (triple === undefined) {
        const dx = chunk.coord.cx - cameraChunkX;
        const dy = chunk.coord.cy - cameraChunkY;
        newQueue.push({ chunk, distSq: dx * dx + dy * dy });
      } else if (chunk.renderDirty) {
        const dx = chunk.coord.cx - cameraChunkX;
        const dy = chunk.coord.cy - cameraChunkY;
        dirtyQueue.push({
          chunk,
          meshes: triple,
          distSq: dx * dx + dy * dy,
        });
        dirtyQueued += 1;
      }
    }
    // Keep only the nearest dirty chunks each frame. `CHUNK_SYNC_MAX_PER_FRAME` is small,
    // so this bounded insertion is cheaper than sorting the full queue every render.
    const maxDirtyThisFrame =
      dirtyQueued > CHUNK_SYNC_DEFER_DIRTY_THRESHOLD
        ? CHUNK_SYNC_MAX_PER_FRAME_UNDER_LOAD
        : CHUNK_SYNC_MAX_PER_FRAME;

    for (const item of dirtyQueue) {
      if (nearestDirty.length === 0) {
        nearestDirty.push(item);
        continue;
      }
      let insertAt = nearestDirty.length;
      while (insertAt > 0 && nearestDirty[insertAt - 1]!.distSq > item.distSq) {
        insertAt -= 1;
      }
      if (nearestDirty.length < maxDirtyThisFrame) {
        nearestDirty.splice(insertAt, 0, item);
      } else if (insertAt < maxDirtyThisFrame) {
        nearestDirty.splice(insertAt, 0, item);
        nearestDirty.pop();
      }
    }

    // Soft wall-clock budget across all rebuilds this frame. Always rebuild
    // at least one (so the queue can't starve on a slow chunk), then bail to
    // the next frame once we've eaten the budget — anything not rebuilt
    // keeps its `renderDirty` flag and rolls forward, while the user keeps
    // seeing the previous mesh in the meantime.
    const tBudgetStart = performance.now();
    for (const item of nearestDirty) {
      if (
        updatesThisFrame > 0 &&
        performance.now() - tBudgetStart >= CHUNK_SYNC_BUDGET_MS
      ) {
        break;
      }
      updatesThisFrame += 1;
      withPerfSpan("ChunkRenderer.updateDirtyChunk", () => {
        updateBackgroundMesh(item.meshes.bg, item.chunk, this.registry, this.atlas);
        updateFgShadowMesh(item.meshes.fgShadow, item.chunk, this.fgShadowSampler, this.registry);
        const { windSways, furnaceFires, waterSurfaces } = updateMesh(
          item.meshes.fg,
          item.meshes.fgWater,
          item.chunk,
          this.registry,
          this.atlas,
          meshOpts,
        );
        updateLeafDecorationMesh(
          item.meshes.leafDeco,
          item.chunk,
          this.registry,
          this.atlas,
          { sampleBlockId },
        );
        this.syncWindyFg(item.meshes.fg, windSways, item.chunk.coord);
        this.syncFurnaceFg(item.meshes.fg, furnaceFires);
        this.syncWateryFg(item.meshes.fgWater, waterSurfaces);
        this.rebuildChunkTorchBloom(layer, item.chunk, item.meshes);
        this.positionChunkRoot(item.meshes.bg, item.chunk.coord);
        this.positionChunkRoot(item.meshes.fgShadow, item.chunk.coord);
        if (item.meshes.fgTorchBloom !== null) {
          this.positionChunkRoot(item.meshes.fgTorchBloom, item.chunk.coord);
        }
        this.positionChunkRoot(item.meshes.fg, item.chunk.coord);
        this.positionChunkRoot(item.meshes.leafDeco, item.chunk.coord);
        this.positionChunkRoot(item.meshes.fgWater, item.chunk.coord);
      });
      item.chunk.dirty = false;
      item.chunk.renderDirty = false;
      updated += 1;
    }

    // New-chunk mesh creation pass — nearest-first, soft-budgeted. Always
    // build at least one new mesh per frame (queue can't starve), then bail
    // when both the count cap and combined budget are exhausted. Skipped
    // chunks are picked up next frame because their `meshes` entry is still
    // missing.
    let newMeshDeferred = 0;
    if (newQueue.length > 0) {
      newQueue.sort((a, b) => a.distSq - b.distSq);
      const tNewBudgetStart = performance.now();
      const dirtyElapsedMs = tNewBudgetStart - tBudgetStart;
      const remainingDirtyBudgetMs = Math.max(
        0,
        CHUNK_SYNC_BUDGET_MS - dirtyElapsedMs,
      );
      const newBudgetMs = remainingDirtyBudgetMs + CHUNK_SYNC_NEW_MESH_BUDGET_MS;
      let builtThisFrame = 0;
      for (let i = 0; i < newQueue.length; i++) {
        const { chunk } = newQueue[i]!;
        if (
          builtThisFrame > 0 &&
          (builtThisFrame >= CHUNK_SYNC_NEW_MESH_MAX_PER_FRAME ||
            performance.now() - tNewBudgetStart >= newBudgetMs)
        ) {
          newMeshDeferred = newQueue.length - i;
          break;
        }
        const key = chunkKey(chunk.coord);
        const bg = buildBackgroundMesh(chunk, this.registry, this.atlas);
        const fgShadow = buildFgShadowMesh(chunk, this.fgShadowSampler, this.registry);
        const {
          mesh: fg,
          waterMesh: fgWater,
          windSways,
          furnaceFires,
          waterSurfaces,
        } = buildMesh(chunk, this.registry, this.atlas, meshOpts);
        const leafDeco = buildLeafDecorationMesh(
          chunk,
          this.registry,
          this.atlas,
          { sampleBlockId },
        );
        this.syncWindyFg(fg, windSways, chunk.coord);
        this.syncFurnaceFg(fg, furnaceFires);
        this.syncWateryFg(fgWater, waterSurfaces);
        this.applyChunkMeshCulling(bg);
        this.applyChunkMeshCulling(fgShadow);
        this.applyChunkMeshCulling(fg);
        this.applyChunkMeshCulling(leafDeco);
        this.applyChunkMeshCulling(fgWater);
        this.positionChunkRoot(bg, chunk.coord);
        this.positionChunkRoot(fgShadow, chunk.coord);
        this.positionChunkRoot(fg, chunk.coord);
        this.positionChunkRoot(leafDeco, chunk.coord);
        this.positionChunkRoot(fgWater, chunk.coord);
        layer.addChild(bg);
        layer.addChild(fgShadow);
        layer.addChild(fg);
        layer.addChild(leafDeco);
        waterLayer.addChild(fgWater);
        const chunkMeshes: ChunkMeshes = {
          bg,
          fgShadow,
          fgTorchBloom: null,
          fgTorchBloomLayoutKey: "",
          fg,
          leafDeco,
          fgWater,
        };
        this.rebuildChunkTorchBloom(layer, chunk, chunkMeshes);
        this.meshes.set(key, chunkMeshes);
        chunk.dirty = false;
        chunk.renderDirty = false;
        added += 1;
        builtThisFrame += 1;
      }
    }

    let removed = 0;
    const chunkMeshesPendingDestroy: ChunkMeshes[] = [];
    if (added > 0 || seenCount !== this.meshes.size) {
      for (const key of this.meshes.keys()) {
        if (!seen.has(key)) {
          const entry = this.meshes.get(key)!;
          const { bg, fgShadow, fgTorchBloom, fg, leafDeco, fgWater } = entry;
          this._windyForegroundMeshes.delete(fg);
          this._windyFgChunkCoord.delete(fg);
          this._furnaceFireForegroundMeshes.delete(fg);
          this._wateryForegroundMeshes.delete(fgWater);
          layer.removeChild(bg);
          layer.removeChild(fgShadow);
          if (fgTorchBloom !== null) {
            layer.removeChild(fgTorchBloom);
          }
          layer.removeChild(fg);
          layer.removeChild(leafDeco);
          waterLayer.removeChild(fgWater);
          chunkMeshesPendingDestroy.push(entry);
          this.meshes.delete(key);
          removed += 1;
        }
      }
    }
    if (chunkMeshesPendingDestroy.length > 0) {
      const batch = chunkMeshesPendingDestroy;
      queueMicrotask(() => {
        for (const { bg, fgShadow, fgTorchBloom, fg, leafDeco, fgWater } of batch) {
          bg.destroy();
          fgShadow.destroy();
          fgTorchBloom?.destroy();
          fg.destroy();
          leafDeco.destroy();
          fgWater.destroy();
        }
      });
    }

    const bloomOn = getVideoPrefs().bloomEnabled;
    for (const m of this.meshes.values()) {
      if (m.fgTorchBloom !== null) {
        m.fgTorchBloom.visible = bloomOn;
      }
    }

    if (
      import.meta.env.DEV &&
      (added > 0 || updated > 0 || removed > 0 || newMeshDeferred > 0)
    ) {
      chunkPerfLog("syncChunks", chunkPerfNow() - t0, {
        added,
        updated,
        removed,
        seenCount,
        dirtyQueued,
        deferredDirty: Math.max(0, dirtyQueued - updatesThisFrame),
        newMeshDeferred,
      });
    }
  }

  /**
   * Subtle pixel-snapped sway on foliage foreground tiles (see block `windSwayMaxPx`).
   *
   * Off-screen meshes are skipped via Pixi's culler result (`mesh.visible`),
   * which is set by `Culler.shared.cull()` in {@link RenderPipeline.render}.
   * The cull state lags by one frame (cull runs after this method on the next
   * pipeline.render), but a one-frame stale wind/furnace/ripple offset on a
   * chunk that just came on-screen is imperceptible.
   */
  updateFoliageWind(
    timeSec: number,
    influences?: readonly FoliageWindInfluence[],
  ): void {
    this._foliageWindFrame += 1;
    const pos = this.pipeline.getCamera().getPosition();
    const chunkWorldSize = CHUNK_SIZE * BLOCK_SIZE;
    const viewCX = Math.floor(pos.x / chunkWorldSize);
    const viewCY = Math.floor(-pos.y / chunkWorldSize);
    const farCheb = VIEW_DISTANCE_CHUNKS + 2;

    for (const fg of this._windyForegroundMeshes) {
      if (!fg.visible) continue;
      const coord = this._windyFgChunkCoord.get(fg);
      if (coord !== undefined) {
        const cheb = Math.max(
          Math.abs(coord.cx - viewCX),
          Math.abs(coord.cy - viewCY),
        );
        if (cheb >= farCheb && (this._foliageWindFrame & 1) === 0) {
          continue;
        }
      }
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
      if (!fg.visible) continue;
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
      if (!fg.visible) continue;
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
    for (const { bg, fgShadow, fgTorchBloom, fg, leafDeco, fgWater } of this.meshes.values()) {
      layer.removeChild(bg);
      layer.removeChild(fgShadow);
      if (fgTorchBloom !== null) {
        layer.removeChild(fgTorchBloom);
      }
      layer.removeChild(fg);
      layer.removeChild(leafDeco);
      waterLayer.removeChild(fgWater);
      bg.destroy();
      fgShadow.destroy();
      fgTorchBloom?.destroy();
      fg.destroy();
      leafDeco.destroy();
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

  private syncWindyFg(fg: Mesh, windSways: TileWindSway[], coord: ChunkCoord): void {
    this.fgWindSways.set(fg, windSways);
    if (windSways.length > 0) {
      this._windyForegroundMeshes.add(fg);
      this._windyFgChunkCoord.set(fg, coord);
    } else {
      this._windyForegroundMeshes.delete(fg);
      this._windyFgChunkCoord.delete(fg);
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
