/** Facade: chunks, block registry, and procedural world generation. */
import { yieldToNextFrame } from "../core/asyncYield";
import {
  BLOCK_SIZE,
  CHUNK_SIZE,
  SKY_LIGHT_MAX,
  STREAM_CHUNK_HYSTERESIS_BLOCKS,
  VIEW_DISTANCE_CHUNKS,
  WORLD_Y_MAX,
  WORLD_Y_MIN,
} from "../core/constants";
import { chunkPerfLog, chunkPerfNow } from "../debug/chunkPerf";
import type { EventBus } from "../core/EventBus";
import type { ItemId } from "../core/itemDefinition";
import type { ILootResolver } from "../core/loot";
import type { ChunkRecord, IndexedDBStore } from "../persistence/IndexedDBStore";
import type { BlockRegistry } from "./blocks/BlockRegistry";
import type { BlockDefinition } from "./blocks/BlockDefinition";
import { ChunkManager, type ChunkGenerator } from "./chunk/ChunkManager";
import {
  createChunk,
  getBackground,
  getBlock,
  setBackground,
  setBlock,
  type Chunk,
} from "./chunk/Chunk";
import { computeBlockLight, computeSkyLight } from "./lighting/LightPropagation";
import {
  worldToChunk,
  worldToLocalBlock,
  type ChunkCoord,
} from "./chunk/ChunkCoord";
import { GeneratorContext } from "./gen/GeneratorContext";
import { WorldGenerator } from "./gen/WorldGenerator";
import { createAABB, type AABB } from "../entities/physics/AABB";
import { RemotePlayer } from "./entities/RemotePlayer";
import { DroppedItem } from "../entities/DroppedItem";
import type { ScreenAABB } from "../core/worldCollision";
import type { GameEvent } from "../core/types";

function isGrassOrDirtSupport(def: BlockDefinition): boolean {
  return (
    def.identifier === "stratum:grass" ||
    def.identifier === "stratum:dirt"
  );
}

/** Keeps streaming centre stable until the player moves `hystBlocks` into the target chunk. */
function applyChunkHysteresisAxis(
  streamChunk: number,
  targetChunk: number,
  blockCoord: number,
  hystBlocks: number,
): number {
  if (targetChunk === streamChunk) {
    return streamChunk;
  }
  if (targetChunk > streamChunk) {
    const threshold = targetChunk * CHUNK_SIZE + hystBlocks;
    return blockCoord >= threshold ? targetChunk : streamChunk;
  }
  const maxInTarget = (targetChunk + 1) * CHUNK_SIZE - 1;
  const threshold = maxInTarget - hystBlocks;
  return blockCoord <= threshold ? targetChunk : streamChunk;
}

export type WorldLoadProgress = {
  loaded: number;
  total: number;
  source: "db" | "generated";
  cx: number;
  cy: number;
};

export type WorldLoadProgressCallback = (progress: WorldLoadProgress) => void;

export class World {
  private readonly registry: BlockRegistry;
  private readonly chunks: ChunkManager;
  private readonly worldGen: WorldGenerator;
  private readonly airId: number;
  private readonly seed: number;
  private readonly store: IndexedDBStore;
  private readonly worldUuid: string;
  private readonly remotePlayers = new Map<string, RemotePlayer>();
  private readonly bus?: EventBus;
  private readonly _droppedItems = new Map<string, DroppedItem>();
  private _dropSeq = 0;
  private readonly _lootResolver: ILootResolver;
  private readonly _lootRng: GeneratorContext;
  private _lootForkSeq = 0;
  private readonly _dropSolidScratch: AABB[] = [];
  /** Cached `getSkyExposureTop` per world column `wx` (invalidated on block / chunk changes). */
  private readonly _skyTopByWx = new Map<number, number>();
  /** Hysteresis centre for {@link streamChunksAroundPlayer}; seeded in {@link init}. */
  private streamCentreCx: number | null = null;
  private streamCentreCy: number | null = null;

  constructor(
    registry: BlockRegistry,
    seed: number,
    store: IndexedDBStore,
    worldUuid: string,
    lootResolver: ILootResolver,
    bus?: EventBus,
  ) {
    this.registry = registry;
    this.chunks = new ChunkManager();
    this.worldGen = new WorldGenerator(seed, registry);
    this.airId = registry.getByIdentifier("stratum:air").id;
    this.seed = seed;
    this.store = store;
    this.worldUuid = worldUuid;
    this._lootResolver = lootResolver;
    this._lootRng = new GeneratorContext(seed);
    this.bus = bus;
  }

  /** Seeded RNG fork for each block-break loot roll (deterministic order for a given seed). */
  private takeLootRng(): GeneratorContext {
    return this._lootRng.fork(this._lootForkSeq++);
  }

  /**
   * Spawns dropped items for a block broken at world block coordinates (center pop).
   */
  spawnLootForBrokenBlock(blockId: number, wx: number, wy: number): void {
    const rng = this.takeLootRng();
    const stacks = this._lootResolver.resolve(blockId, rng);
    const px = (wx + 0.5) * BLOCK_SIZE;
    const py = (wy + 0.5) * BLOCK_SIZE;
    for (const stack of stacks) {
      this.spawnItem(stack.itemId, stack.count, px, py);
    }
  }

  getSeed(): number {
    return this.seed;
  }

  getWorldUuid(): string {
    return this.worldUuid;
  }

  getRegistry(): BlockRegistry {
    return this.registry;
  }

  /** Numeric id of `stratum:air` (hot paths: occlusion, etc.). */
  getAirBlockId(): number {
    return this.airId;
  }

  /** Terrain surface world-Y at column `wx` (deterministic noise). */
  getSurfaceHeight(wx: number): number {
    return this.worldGen.getSurfaceHeight(wx);
  }

  getBlock(wx: number, wy: number): BlockDefinition {
    const coord = worldToChunk(wx, wy);
    const chunk = this.chunks.getChunk(coord);
    if (chunk === undefined) {
      return this.registry.getById(this.airId);
    }
    const { lx, ly } = worldToLocalBlock(wx, wy);
    const id = getBlock(chunk, lx, ly);
    return this.registry.getById(id);
  }

  getBackgroundId(wx: number, wy: number): number {
    const coord = worldToChunk(wx, wy);
    const chunk = this.chunks.getChunk(coord);
    if (chunk === undefined) {
      return 0;
    }
    const { lx, ly } = worldToLocalBlock(wx, wy);
    return getBackground(chunk, lx, ly);
  }

  getBackgroundBlock(wx: number, wy: number): BlockDefinition {
    const id = this.getBackgroundId(wx, wy);
    if (id === 0) {
      return this.registry.getById(this.airId);
    }
    return this.registry.getById(id);
  }

  /**
   * Sets the back-wall tile. Does not affect collision or light propagation.
   * Use block id 0 to clear.
   */
  setBackgroundBlock(wx: number, wy: number, id: number): boolean {
    if (wy < WORLD_Y_MIN || wy > WORLD_Y_MAX) {
      return false;
    }
    const coord = worldToChunk(wx, wy);
    const gen = this.makeChunkGenerator();
    const chunk = this.chunks.getOrCreateChunk(coord, gen);
    const { lx, ly } = worldToLocalBlock(wx, wy);
    setBackground(chunk, lx, ly, id);
    return true;
  }

  /** True if orthogonal neighbor has solid foreground or non-empty background (for fg placement support). */
  hasForegroundPlacementSupport(wx: number, wy: number): boolean {
    const dirs: [number, number][] = [
      [0, -1],
      [0, 1],
      [-1, 0],
      [1, 0],
    ];
    for (const [dx, dy] of dirs) {
      const nx = wx + dx;
      const ny = wy + dy;
      const fg = this.getBlock(nx, ny);
      if (fg.solid && !fg.replaceable) {
        return true;
      }
      if (fg.id === this.airId && this.getBackgroundId(nx, ny) !== 0) {
        return true;
      }
    }
    return false;
  }

  /** True if the block cell at world block coordinates is solid. */
  isSolid(worldBlockX: number, worldBlockY: number): boolean {
    return this.getBlock(worldBlockX, worldBlockY).solid;
  }

  /** Screen-space (Pixi Y down) solid block AABBs overlapping `region` — same contract as {@link getSolidAABBs}. */
  querySolidAABBs(region: ScreenAABB, out: ScreenAABB[]): void {
    out.length = 0;
    const worldYBottom = -(region.y + region.height);
    const worldYTop = -region.y;
    const wx0 = Math.floor(region.x / BLOCK_SIZE);
    const wx1 = Math.floor((region.x + region.width - 1) / BLOCK_SIZE);
    const wy0 = Math.floor(worldYBottom / BLOCK_SIZE);
    const wy1 = Math.floor(worldYTop / BLOCK_SIZE);
    for (let wx = wx0; wx <= wx1; wx++) {
      for (let wy = wy0; wy <= wy1; wy++) {
        const def = this.getBlock(wx, wy);
        if (!def.solid) {
          continue;
        }
        out.push(
          createAABB(
            wx * BLOCK_SIZE,
            -(wy + 1) * BLOCK_SIZE,
            BLOCK_SIZE,
            BLOCK_SIZE,
          ),
        );
      }
    }
  }

  /**
   * After placing a block, move any dropped item whose center is inside that cell to a nearby air cell.
   */
  nudgeDroppedItemsFromBlock(placedWx: number, placedWy: number): void {
    const attempts: [number, number][] = [
      [placedWx, placedWy + 1],
      [placedWx + 1, placedWy],
      [placedWx - 1, placedWy],
      [placedWx, placedWy - 1],
      [placedWx + 1, placedWy + 1],
      [placedWx - 1, placedWy + 1],
      [placedWx + 1, placedWy - 1],
      [placedWx - 1, placedWy - 1],
    ];
    for (let i = attempts.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const a = attempts[i]!;
      attempts[i] = attempts[j]!;
      attempts[j] = a;
    }

    for (const item of this._droppedItems.values()) {
      const wx = Math.floor(item.x / BLOCK_SIZE);
      const wy = Math.floor(item.y / BLOCK_SIZE);
      if (wx !== placedWx || wy !== placedWy) {
        continue;
      }
      let placed = false;
      for (const [tx, ty] of attempts) {
        if (ty < WORLD_Y_MIN || ty > WORLD_Y_MAX) {
          continue;
        }
        if (!this.isSolid(tx, ty)) {
          item.x = (tx + 0.5) * BLOCK_SIZE;
          item.y = (ty + 0.5) * BLOCK_SIZE;
          item.vx = 0;
          item.vy = 0;
          placed = true;
          break;
        }
      }
      if (!placed && placedWy + 1 <= WORLD_Y_MAX && !this.isSolid(placedWx, placedWy + 1)) {
        item.x = (placedWx + 0.5) * BLOCK_SIZE;
        item.y = (placedWy + 1.5) * BLOCK_SIZE;
        item.vx = 0;
        item.vy = 0;
      }
    }
  }

  /**
   * Spawns a dropped item stack at world pixel coordinates (Y up).
   * Optional `vx`/`vy`: horizontal (px/s, +right) and downward (px/s, +down) throw velocity.
   */
  spawnItem(
    itemId: ItemId,
    count: number,
    x: number,
    y: number,
    vx = 0,
    vy = 0,
  ): void {
    const id = `drop-${++this._dropSeq}`;
    const drop = new DroppedItem(id, itemId, count, x, y, vx, vy);
    this._droppedItems.set(id, drop);
  }

  /**
   * @internal Fixed-step update for dropped items; adds to inventory when collected,
   * leaving overflow on the ground when full.
   */
  updateDroppedItems(
    dt: number,
    playerPos: { x: number; y: number },
    inventory: { add(itemId: ItemId, count: number): number },
  ): void {
    for (const [id, item] of [...this._droppedItems.entries()]) {
      const collected = item.update(dt, this, playerPos, this._dropSolidScratch);
      if (!collected) {
        continue;
      }
      const overflow = inventory.add(item.itemId, item.count);
      if (overflow > 0) {
        item.count = overflow;
      } else {
        this._droppedItems.delete(id);
      }
    }
  }

  /** @internal Used by EntityManager for rendering. */
  getDroppedItems(): ReadonlyMap<string, DroppedItem> {
    return this._droppedItems;
  }

  /**
   * Sets a block in world space. Ignores writes outside vertical bounds.
   * Phase 2: broadcast `BLOCK_UPDATE` from host here.
   */
  setBlock(wx: number, wy: number, id: number): boolean {
    if (wy < WORLD_Y_MIN || wy > WORLD_Y_MAX) {
      return false;
    }
    const coord = worldToChunk(wx, wy);
    const gen = this.makeChunkGenerator();
    const chunk = this.chunks.getOrCreateChunk(coord, gen);
    const { lx, ly } = worldToLocalBlock(wx, wy);
    setBlock(chunk, lx, ly, id);
    this.invalidateSkyTopColumn(wx);
    if (this.registry.getById(id).solid) {
      this.nudgeDroppedItemsFromBlock(wx, wy);
    }

    const { cx, cy } = worldToChunk(wx, wy);
    this.recomputeChunkLight(cx, cy);
    const localX = ((wx % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    const localY = ((wy % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    if (localX === 0) {
      this.recomputeChunkLight(cx - 1, cy);
    }
    if (localX === CHUNK_SIZE - 1) {
      this.recomputeChunkLight(cx + 1, cy);
    }
    if (localY === 0) {
      this.recomputeChunkLight(cx, cy - 1);
    }
    if (localY === CHUNK_SIZE - 1) {
      this.recomputeChunkLight(cx, cy + 1);
    }

    this.breakPlantsIfSupportLost(wx, wy);

    return true;
  }

  /**
   * Flowers/short grass/tall grass need grass or dirt below; tall grass top needs
   * the bottom half below. Remove and drop loot when the block under a plant no longer qualifies.
   */
  private breakPlantsIfSupportLost(wx: number, wy: number): void {
    const support = this.getBlock(wx, wy);
    const above = this.getBlock(wx, wy + 1);
    if (above.id === this.airId) {
      return;
    }

    if (above.tallGrass === "top") {
      if (support.tallGrass !== "bottom") {
        this.spawnLootForBrokenBlock(above.id, wx, wy + 1);
        this.setBlockWithoutPlantCascade(wx, wy + 1, 0);
        this.bus?.emit({
          type: "game:block-changed",
          wx,
          wy: wy + 1,
          blockId: 0,
          layer: "fg",
        } satisfies GameEvent);
      }
      return;
    }

    const isFoliage =
      above.replaceable &&
      !above.solid &&
      !above.water &&
      (above.tallGrass === "bottom" ||
        above.identifier === "stratum:dandelion" ||
        above.identifier === "stratum:poppy" ||
        above.identifier === "stratum:short_grass");

    if (!isFoliage) {
      return;
    }

    if (isGrassOrDirtSupport(support)) {
      return;
    }

    if (above.tallGrass === "bottom") {
      if (wy + 2 <= WORLD_Y_MAX) {
        const top = this.getBlock(wx, wy + 2);
        if (top.tallGrass === "top") {
          this.setBlockWithoutPlantCascade(wx, wy + 2, 0);
          this.bus?.emit({
            type: "game:block-changed",
            wx,
            wy: wy + 2,
            blockId: 0,
            layer: "fg",
          } satisfies GameEvent);
        }
      }
      this.spawnLootForBrokenBlock(above.id, wx, wy + 1);
      this.setBlockWithoutPlantCascade(wx, wy + 1, 0);
      this.bus?.emit({
        type: "game:block-changed",
        wx,
        wy: wy + 1,
        blockId: 0,
        layer: "fg",
      } satisfies GameEvent);
      return;
    }

    this.spawnLootForBrokenBlock(above.id, wx, wy + 1);
    this.setBlockWithoutPlantCascade(wx, wy + 1, 0);
    this.bus?.emit({
      type: "game:block-changed",
      wx,
      wy: wy + 1,
      blockId: 0,
      layer: "fg",
    } satisfies GameEvent);
  }

  /** Internal setBlock without re-running plant-cascade (avoids recursion when clearing plants). */
  private setBlockWithoutPlantCascade(wx: number, wy: number, id: number): boolean {
    if (wy < WORLD_Y_MIN || wy > WORLD_Y_MAX) {
      return false;
    }
    const coord = worldToChunk(wx, wy);
    const gen = this.makeChunkGenerator();
    const chunk = this.chunks.getOrCreateChunk(coord, gen);
    const { lx, ly } = worldToLocalBlock(wx, wy);
    setBlock(chunk, lx, ly, id);
    this.invalidateSkyTopColumn(wx);
    if (this.registry.getById(id).solid) {
      this.nudgeDroppedItemsFromBlock(wx, wy);
    }
    const { cx, cy } = worldToChunk(wx, wy);
    this.recomputeChunkLight(cx, cy);
    const localX = ((wx % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    const localY = ((wy % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    if (localX === 0) {
      this.recomputeChunkLight(cx - 1, cy);
    }
    if (localX === CHUNK_SIZE - 1) {
      this.recomputeChunkLight(cx + 1, cy);
    }
    if (localY === 0) {
      this.recomputeChunkLight(cx, cy - 1);
    }
    if (localY === CHUNK_SIZE - 1) {
      this.recomputeChunkLight(cx, cy + 1);
    }
    return true;
  }

  private invalidateSkyTopColumn(wx: number): void {
    this._skyTopByWx.delete(wx);
  }

  private invalidateSkyTopStripForChunk(cx: number): void {
    const base = cx * CHUNK_SIZE;
    for (let i = 0; i < CHUNK_SIZE; i++) {
      this._skyTopByWx.delete(base + i);
    }
  }

  getChunkAt(wx: number, wy: number): Chunk | undefined {
    return this.chunks.getChunk(worldToChunk(wx, wy));
  }

  /** Chunk at chunk grid coordinates, or undefined if not loaded. */
  getChunk(chunkX: number, chunkY: number): Chunk | undefined {
    return this.chunks.getChunkXY(chunkX, chunkY);
  }

  /** Iterable of all loaded chunk grid coordinates [cx, cy]. */
  *loadedChunkCoords(): Generator<[number, number], void, undefined> {
    for (const chunk of this.chunks.getLoadedChunks()) {
      yield [chunk.coord.cx, chunk.coord.cy];
    }
  }

  async init(progressCallback?: WorldLoadProgressCallback): Promise<void> {
    await this.store.openDB();
    await this.loadChunksAroundCentre(0, 0, progressCallback);
    this.streamCentreCx = 0;
    this.streamCentreCy = 0;
  }

  /**
   * Streaming entry point for the live game loop: applies hysteresis so tiny movement
   * across a chunk boundary does not reload rings.
   */
  async streamChunksAroundPlayer(bx: number, by: number): Promise<void> {
    const targ = worldToChunk(bx, by);
    const h = STREAM_CHUNK_HYSTERESIS_BLOCKS;
    if (this.streamCentreCx === null || this.streamCentreCy === null) {
      this.streamCentreCx = targ.cx;
      this.streamCentreCy = targ.cy;
    } else {
      this.streamCentreCx = applyChunkHysteresisAxis(
        this.streamCentreCx,
        targ.cx,
        bx,
        h,
      );
      this.streamCentreCy = applyChunkHysteresisAxis(
        this.streamCentreCy,
        targ.cy,
        by,
        h,
      );
    }
    await this.loadChunksAroundCentre(this.streamCentreCx, this.streamCentreCy);
  }

  /**
   * Loads or generates chunks in the view ring from world **block** coords (no hysteresis).
   * Used when callers need an exact centre (e.g. tests); gameplay should use
   * {@link streamChunksAroundPlayer}.
   */
  async loadChunksAround(
    wx: number,
    wy: number,
    progressCallback?: WorldLoadProgressCallback,
  ): Promise<void> {
    const c = worldToChunk(wx, wy);
    await this.loadChunksAroundCentre(c.cx, c.cy, progressCallback);
  }

  /**
   * Loads or generates chunks in the view ring. Prefer DB, then procedural gen.
   * Multiplayer clients still generate locally for newly entered rings until on-demand
   * authoritative chunk fetch exists (join sync only covers chunks the host had loaded).
   */
  async loadChunksAroundCentre(
    centreCx: number,
    centreCy: number,
    progressCallback?: WorldLoadProgressCallback,
  ): Promise<void> {
    const t0 = import.meta.env.DEV ? chunkPerfNow() : 0;
    const centre: ChunkCoord = { cx: centreCx, cy: centreCy };
    const evicted = this.chunks.updateLoadedChunks(centre);
    for (const { cx } of evicted) {
      this.invalidateSkyTopStripForChunk(cx);
    }

    const gen = this.makeChunkGenerator();
    const r = VIEW_DISTANCE_CHUNKS;
    const pending: ChunkCoord[] = [];
    for (let cx = centre.cx - r; cx <= centre.cx + r; cx++) {
      for (let cy = centre.cy - r; cy <= centre.cy + r; cy++) {
        const coord: ChunkCoord = { cx, cy };
        if (this.chunks.getChunk(coord) !== undefined) {
          continue;
        }
        pending.push(coord);
      }
    }
    const total = pending.length;
    let loaded = 0;
    const tLoad = import.meta.env.DEV ? chunkPerfNow() : 0;
    for (const coord of pending) {
      const record = await this.store.loadChunk(this.worldUuid, coord);
      if (record !== undefined) {
        const chunk = this.chunkFromRecord(record);
        this.chunks.putChunk(chunk);
        this.invalidateSkyTopStripForChunk(coord.cx);
        loaded++;
        progressCallback?.({
          loaded,
          total,
          source: "db",
          cx: coord.cx,
          cy: coord.cy,
        });
      } else {
        this.chunks.putChunk(gen(coord));
        this.invalidateSkyTopStripForChunk(coord.cx);
        loaded++;
        progressCallback?.({
          loaded,
          total,
          source: "generated",
          cx: coord.cx,
          cy: coord.cy,
        });
      }
      if (loaded < total) {
        await yieldToNextFrame();
      }
    }
    if (import.meta.env.DEV && pending.length > 0) {
      chunkPerfLog("loadChunksAroundCentre:chunkIO", chunkPerfNow() - tLoad, {
        pending: pending.length,
      });
    }

    /**
     * Lighting depends on neighboring chunks. Run a settle pass only after this batch is fully
     * loaded/generated so caves in brand new worlds don't start with stale lighting.
     */
    const affected = new Set<string>();
    for (const { cx, cy } of pending) {
      affected.add(`${cx},${cy}`);
      affected.add(`${cx - 1},${cy}`);
      affected.add(`${cx + 1},${cy}`);
      affected.add(`${cx},${cy - 1}`);
      affected.add(`${cx},${cy + 1}`);
    }
    const tLight = import.meta.env.DEV ? chunkPerfNow() : 0;
    let lightI = 0;
    for (const key of affected) {
      const [cxStr, cyStr] = key.split(",");
      const cx = Number.parseInt(cxStr ?? "0", 10);
      const cy = Number.parseInt(cyStr ?? "0", 10);
      if (!Number.isFinite(cx) || !Number.isFinite(cy)) {
        continue;
      }
      this.recomputeChunkLight(cx, cy);
      lightI += 1;
      if (affected.size > 8 && lightI % 8 === 0) {
        await yieldToNextFrame();
      }
    }
    if (import.meta.env.DEV && affected.size > 0) {
      chunkPerfLog("loadChunksAroundCentre:lighting", chunkPerfNow() - tLight, {
        affected: affected.size,
      });
    }
    if (import.meta.env.DEV) {
      chunkPerfLog("loadChunksAroundCentre:total", chunkPerfNow() - t0, {
        pending: pending.length,
        evicted: evicted.length,
      });
    }
  }

  private chunkFromRecord(record: ChunkRecord): Chunk {
    const coord: ChunkCoord = { cx: record.cx, cy: record.cy };
    const chunk = createChunk(coord);
    chunk.blocks.set(record.blocks);
    chunk.metadata.set(record.metadata);
    const expected = CHUNK_SIZE * CHUNK_SIZE;
    if (
      record.background !== undefined &&
      record.background.length === expected
    ) {
      chunk.background.set(record.background);
    }
    chunk.skyLight.fill(0);
    chunk.blockLight.fill(0);
    chunk.dirty = true;
    return chunk;
  }

  isLoaded(coord: ChunkCoord): boolean {
    return this.chunks.getChunk(coord) !== undefined;
  }

  getSkyLight(wx: number, wy: number): number {
    const chunk = this.getChunkAt(wx, wy);
    if (chunk === undefined) {
      return SKY_LIGHT_MAX;
    }
    const localX = ((wx % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    const localY = ((wy % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    return chunk.skyLight[localY * CHUNK_SIZE + localX] ?? SKY_LIGHT_MAX;
  }

  getBlockLight(wx: number, wy: number): number {
    const chunk = this.getChunkAt(wx, wy);
    if (chunk === undefined) {
      return 0;
    }
    const localX = ((wx % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    const localY = ((wy % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    return chunk.blockLight[localY * CHUNK_SIZE + localX] ?? 0;
  }

  recomputeChunkLight(chunkX: number, chunkY: number): void {
    const chunk = this.chunks.getChunk({ cx: chunkX, cy: chunkY });
    if (chunk === undefined) {
      return;
    }

    const reader = this._makeReader();
    computeSkyLight(chunkX, chunkY, chunk.skyLight, reader);
    computeBlockLight(chunkX, chunkY, chunk.blockLight, reader);

    this.bus?.emit({
      type: "world:light-updated",
      chunkX,
      chunkY,
    });
  }

  /**
   * Apply host-authoritative block data for one chunk (multiplayer). Clears per-cell metadata;
   * lighting is settled with neighbors so adjacent replicated chunks stay consistent.
   */
  applyAuthoritativeChunk(
    cx: number,
    cy: number,
    blocks: Uint16Array,
    background?: Uint16Array,
  ): void {
    this.applyAuthoritativeChunkBatch([{ cx, cy, blocks, background }]);
  }

  /**
   * Apply multiple replicated chunks, then one lighting pass over the affected neighborhood.
   */
  applyAuthoritativeChunkBatch(
    entries: ReadonlyArray<{
      cx: number;
      cy: number;
      blocks: Uint16Array;
      background?: Uint16Array;
    }>,
  ): void {
    const expected = CHUNK_SIZE * CHUNK_SIZE;
    const applied: ChunkCoord[] = [];
    for (const { cx, cy, blocks, background } of entries) {
      if (blocks.length !== expected) {
        continue;
      }
      this.invalidateSkyTopStripForChunk(cx);
      const coord: ChunkCoord = { cx, cy };
      let chunk = this.chunks.getChunk(coord);
      if (chunk === undefined) {
        chunk = createChunk(coord);
        this.chunks.putChunk(chunk);
      }
      chunk.blocks.set(blocks);
      if (background !== undefined && background.length === expected) {
        chunk.background.set(background);
      } else {
        chunk.background.fill(0);
      }
      chunk.metadata.fill(0);
      chunk.skyLight.fill(0);
      chunk.blockLight.fill(0);
      chunk.dirty = true;
      applied.push(coord);
    }
    const affected = new Set<string>();
    for (const { cx, cy } of applied) {
      affected.add(`${cx},${cy}`);
      affected.add(`${cx - 1},${cy}`);
      affected.add(`${cx + 1},${cy}`);
      affected.add(`${cx},${cy - 1}`);
      affected.add(`${cx},${cy + 1}`);
    }
    for (const key of affected) {
      const [cxStr, cyStr] = key.split(",");
      const acx = Number.parseInt(cxStr ?? "0", 10);
      const acy = Number.parseInt(cyStr ?? "0", 10);
      if (!Number.isFinite(acx) || !Number.isFinite(acy)) {
        continue;
      }
      this.recomputeChunkLight(acx, acy);
    }
  }

  private _makeReader(): {
    getBlock(wx: number, wy: number): number;
    isSolid(wx: number, wy: number): boolean;
    getLightAbsorption(wx: number, wy: number): number;
    getLightEmission(wx: number, wy: number): number;
    getSkyExposureTop(wx: number): number;
  } {
    return {
      getBlock: (wx, wy) => this.getBlockId(wx, wy),
      isSolid: (wx, wy) => this.getBlock(wx, wy).solid,
      getLightAbsorption: (wx, wy) => {
        const id = this.getBlockId(wx, wy);
        return this.registry.getById(id).lightAbsorption;
      },
      getLightEmission: (wx, wy) => {
        const id = this.getBlockId(wx, wy);
        return this.registry.getById(id).lightEmission;
      },
      getSkyExposureTop: (wx) => this._getSkyExposureTop(wx),
    };
  }

  private _getSkyExposureTop(wx: number): number {
    const hit = this._skyTopByWx.get(wx);
    if (hit !== undefined) {
      return hit;
    }
    let top = WORLD_Y_MIN;
    for (let wy = WORLD_Y_MAX; wy >= WORLD_Y_MIN; wy--) {
      if (this.getBlock(wx, wy).solid) {
        top = wy;
        break;
      }
    }
    this._skyTopByWx.set(wx, top);
    return top;
  }

  private getBlockId(wx: number, wy: number): number {
    const cx = Math.floor(wx / CHUNK_SIZE);
    const cy = Math.floor(wy / CHUNK_SIZE);
    const chunk = this.chunks.getChunkXY(cx, cy);
    if (chunk === undefined) {
      return this.airId;
    }
    const lx = ((wx % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    const ly = ((wy % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    return getBlock(chunk, lx, ly);
  }

  /** @internal Used by Game; prefer high-level API elsewhere. */
  getChunkManager(): ChunkManager {
    return this.chunks;
  }

  /** @internal Used by Game/EntityManager to animate remote peers. */
  updateRemotePlayers(dt: number): void {
    for (const player of this.remotePlayers.values()) {
      player.update(dt);
    }
  }

  /** @internal Used by Game to sync networked peer state. */
  updateRemotePlayer(
    peerId: string,
    x: number,
    y: number,
    vx: number,
    vy: number,
    facingRight: boolean,
  ): void {
    const existing = this.remotePlayers.get(peerId);
    if (existing === undefined) {
      const created = new RemotePlayer(x, y, facingRight, vx, vy);
      this.remotePlayers.set(peerId, created);
    } else {
      existing.setTarget(x, y, vx, vy, facingRight);
    }
  }

  /** @internal Used by Game on net:peer-left. */
  removeRemotePlayer(peerId: string): void {
    this.remotePlayers.delete(peerId);
  }

  /** Remove every networked peer (e.g. host disabled multiplayer). */
  clearRemotePlayers(): void {
    this.remotePlayers.clear();
  }

  /** @internal Used by EntityManager for rendering. */
  getRemotePlayers(): ReadonlyMap<string, RemotePlayer> {
    return this.remotePlayers;
  }

  private makeChunkGenerator(): ChunkGenerator {
    return this.worldGen.generateChunk.bind(this.worldGen);
  }
}
