/** Facade: chunks, block registry, and procedural world generation. */
import { yieldToNextFrame } from "../core/asyncYield";
import { unixRandom01 } from "../core/unixRandom";
import {
  ARROW_STUCK_COLLECT_SNAP_PX,
  BLOCK_SIZE,
  PLAYER_HEIGHT,
  CHEST_DOUBLE_SLOTS,
  CHEST_SINGLE_SLOTS,
  CHUNK_SIZE,
  PLAYER_REMOTE_AIR_VY_THRESHOLD,
  SIMULATION_DISTANCE_CHUNKS,
  SKY_LIGHT_MAX,
  VIEW_DISTANCE_CHUNKS,
  SPAWN_CHUNK_RADIUS,
  LOADED_CHUNK_HARD_CAP,
  MAX_SPAWN_STRIP_COLUMNS,
  STEP_INTERVAL,
  STREAM_CHUNK_HYSTERESIS_BLOCKS,
  WATER_FLOW_EVERY_N_TICKS,
  WORLDGEN_NO_COLLIDE,
  WORLD_Y_MAX,
  WORLD_Y_MIN,
  LIGHT_RECOMPUTE_BUDGET_PER_TICK,
} from "../core/constants";
import { chunkPerfLog, chunkPerfNow } from "../debug/chunkPerf";
import type { EventBus } from "../core/EventBus";
import type { ItemId, ItemStack } from "../core/itemDefinition";
import type { ILootResolver } from "../core/loot";
import {
  ITEM_ID_LAYOUT_REVISION_CURRENT,
  ITEM_ID_LAYOUT_REVISION_GRANITE,
  ITEM_ID_LAYOUT_REVISION_STAIRS,
  migrateChestPersistedChunk,
  migrateChestPersistedChunkFromRevision1,
  migrateChestPersistedChunkFromRevision2,
  migrateFurnacePersistedChunk,
  migrateFurnacePersistedChunkFromRevision1,
  migrateFurnacePersistedChunkFromRevision2,
} from "../items/itemIdLayoutMigration";
import type { ItemRegistry } from "../items/ItemRegistry";
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
  chunkToWorldOrigin,
  localIndex,
  worldToChunk,
  worldToLocalBlock,
  type ChunkCoord,
} from "./chunk/ChunkCoord";
import {
  anyPlayerOverlapsDoorProximity,
  doorAnchorBottomWy,
  doorProximityOverlapBest,
  doorRenderHingeRightFromProximity,
  type DoorPlayerSample,
} from "./door/doorWorld";
import {
  doorHingeRightFromMeta,
  doorLatchedOpenFromMeta,
} from "./door/doorMetadata";
import { bedHeadPlusXFromMeta } from "./bed/bedMetadata";
import {
  PAINTING_VARIANTS,
  decodePaintingMeta,
} from "./painting/paintingData";
import { GeneratorContext } from "./gen/GeneratorContext";
import { WorldGenerator } from "./gen/WorldGenerator";
import { resimulateWaterFromSources, tickWaterFlow } from "./water/WaterSimulation";
import { createAABB, type AABB } from "../entities/physics/AABB";
import { RemotePlayer } from "./entities/RemotePlayer";
import {
  ArrowProjectile,
  type HostArrowStrikeResult,
} from "../entities/ArrowProjectile";

export type { HostArrowStrikeResult } from "../entities/ArrowProjectile";
import { DroppedItem } from "../entities/DroppedItem";
import {
  createEmptyFurnaceTileState,
  furnaceCellKey,
  furnaceTilesEqual,
} from "./furnace/FurnaceTileState";
import { stepFurnaceTile } from "./furnace/FurnaceSimulator";
import type { FurnaceTileState } from "./furnace/FurnaceTileState";
import {
  furnaceTileToPersisted,
  normalizeFurnacePersistedChunk,
  persistedToFurnaceTile,
  worldXYFromChunkLocal,
  type FurnacePersistedChunk,
} from "./furnace/furnacePersisted";
import {
  chestCellKey,
  createEmptyChestTile,
  type ChestTileState,
} from "./chest/ChestTileState";
import { tryMergeChestAfterPlace } from "./chest/chestMerge";
import { chestIsDoubleAtAnchor, chestStorageAnchor } from "./chest/chestVisual";
import {
  chestTileToPersisted,
  normalizeChestPersistedChunk,
  persistedToChestTile,
  type ChestPersistedChunk,
} from "./chest/chestPersisted";
import type { SmeltingRegistry } from "./SmeltingRegistry";
import type { ScreenAABB } from "../core/worldCollision";
import type { GameEvent } from "../core/types";

function isGrassOrDirtSupport(def: BlockDefinition): boolean {
  return (
    def.identifier === "stratum:grass" ||
    def.identifier === "stratum:dirt"
  );
}

/** Block that may sit directly under a cactus column (sand base or stacked cactus). */
function isValidCactusSupportBelow(def: BlockDefinition, cactusBlockId: number): boolean {
  return def.id === cactusBlockId || def.identifier === "stratum:sand";
}

function isValidSugarCaneSupportBelow(
  supportBelow: BlockDefinition,
  sugarCaneBlockId: number,
): boolean {
  return (
    supportBelow.id === sugarCaneBlockId ||
    supportBelow.identifier === "stratum:sand" ||
    supportBelow.identifier === "stratum:grass" ||
    supportBelow.identifier === "stratum:dirt"
  );
}

function sugarCaneBaseHasAdjacentWater(world: World, wx: number, wy: number): boolean {
  return (
    world.getBlock(wx - 1, wy).water ||
    world.getBlock(wx + 1, wy).water ||
    world.getBlock(wx, wy - 1).water ||
    world.getBlock(wx, wy + 1).water ||
    // Shore columns often hold water one block below our soil; count as adjacent for growth rules.
    world.getBlock(wx - 1, wy - 1).water ||
    world.getBlock(wx + 1, wy - 1).water
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

/** Pack signed chunk coords into one number for Set deduping (assumes each axis in [-32768, 32767]). */
const CHUNK_COORD_PACK_BIAS = 32768;
/** Max new chunks to load/generate per streaming pass to avoid long frame stalls. */
const CHUNK_LOAD_PASS_BUDGET = 96;
/** Max ms spent recomputing lighting per animation frame during chunk streaming settle. */
const CHUNK_LOAD_LIGHT_MS_PER_FRAME = 5;
function packChunkCoordKey(cx: number, cy: number): number {
  return ((cx + CHUNK_COORD_PACK_BIAS) << 16) | (cy + CHUNK_COORD_PACK_BIAS);
}

function unpackChunkCoordKey(key: number): ChunkCoord {
  return {
    cx: (key >>> 16) - CHUNK_COORD_PACK_BIAS,
    cy: (key & 0xffff) - CHUNK_COORD_PACK_BIAS,
  };
}

const LIGHT_RECOMPUTE_SKY = 1 << 0;
const LIGHT_RECOMPUTE_BLOCK = 1 << 1;
const LIGHT_RECOMPUTE_BOTH = LIGHT_RECOMPUTE_SKY | LIGHT_RECOMPUTE_BLOCK;

export class World {
  private readonly registry: BlockRegistry;
  private readonly chunks: ChunkManager;
  private readonly worldGen: WorldGenerator;
  /** Stable reference for {@link ChunkManager.getOrCreateChunk} (avoids per-call `.bind`). */
  private readonly _chunkGen: ChunkGenerator;
  private readonly airId: number;
  private readonly cactusBlockId: number;
  private readonly sugarCaneBlockId: number;
  private readonly seed: number;
  private readonly store: IndexedDBStore;
  private readonly worldUuid: string;
  private readonly remotePlayers = new Map<string, RemotePlayer>();
  /** Footstep cadence for `entity:ground-kick` (remote peers). */
  private readonly remoteGroundKickAccum = new Map<string, number>();
  private readonly bus?: EventBus;
  private readonly _droppedItems = new Map<string, DroppedItem>();
  private readonly _arrows = new Map<string, ArrowProjectile>();
  private _dropSeq = 0;
  private _arrowSeq = 0;
  private _nextNetDropId = 1;
  private _nextNetArrowId = 1;
  /** When set (multiplayer host), spawned drops use net ids and invoke this hook. */
  private _netDropReplicate:
    | ((p: {
        netId: number;
        itemId: number;
        count: number;
        x: number;
        y: number;
        vx: number;
        vy: number;
        damage: number;
      }) => void)
    | null = null;
  /** When set (multiplayer host), spawned arrows use net ids `a{id}` and invoke this hook. */
  private _netArrowReplicate:
    | ((p: {
        netArrowId: number;
        x: number;
        y: number;
        vx: number;
        vy: number;
        damage: number;
        shooterFeetX: number;
      }) => void)
    | null = null;
  /** Multiplayer client: pending pickup requests (avoid duplicate RPC). */
  private readonly _dropPickupPending = new Set<number>();
  /**
   * When set (multiplayer client), chunks missing from IndexedDB are fetched via this promise
   * (host CHUNK_DATA) instead of local procedural generation.
   */
  private _authoritativeChunkFetch: ((cx: number, cy: number) => Promise<void>) | null =
    null;
  private readonly _lootResolver: ILootResolver;
  private readonly _lootRng: GeneratorContext;
  private _lootForkSeq = 0;
  private _mobForkSeq = 0;
  private readonly _dropSolidScratch: AABB[] = [];
  /** Cached `getSkyExposureTop` per world column `wx` (invalidated on block / chunk changes). */
  private readonly _skyTopByWx = new Map<number, number>();
  private readonly _lightAbsorptionById = new Map<number, number>();
  private readonly _lightEmissionById = new Map<number, number>();
  /** Hot path for lighting / sky column scans (avoids `registry.getById` per cell). */
  private readonly _solidById = new Map<number, boolean>();
  /** Hysteresis centre for {@link streamChunksAroundPlayer}; seeded in {@link init}. */
  private streamCentreCx: number | null = null;
  private streamCentreCy: number | null = null;

  private _furnaceBlockId: number | null = null;
  private readonly _furnaceTiles = new Map<string, FurnaceTileState>();

  private _chestBlockId: number | null = null;
  private readonly _chestTiles = new Map<string, ChestTileState>();

  /** Required to (de)serialize chest/furnace tiles with stable item keys; set before {@link init}. */
  private _itemRegistry: ItemRegistry | null = null;

  private _waterSimTick = 0;
  private _waterBlockId: number | null = null;
  /** When true, next {@link tickWaterSystems} rebuilds flowing water from remaining sources. */
  private _pendingWaterTopologyResim = false;
  /** Loaded chunks whose water may still spread on future ticks. */
  private readonly _activeWaterChunkKeys = new Set<number>();

  /** When set, chunk loads remap stored numeric ids through identifiers (`WorldMetadata.blockIdPalette`). */
  private readonly _blockLoadPalette: readonly string[] | undefined;
  /**
   * When true, chest/furnace tiles loaded from {@link IndexedDBStore.loadChunk} may remap persisted
   * standalone item ids (see {@link ITEM_ID_LAYOUT_REVISION_CURRENT}). Network chunk apply skips this.
   */
  private readonly _needsItemIdLayoutMigration: boolean;
  private readonly _itemIdLayoutMigrationKind: "legacy" | "rev1Minus2" | "rev2Plus6" | "none";

  /**
   * When &gt; 0, {@link setBlock} / {@link setBlockWithoutPlantCascade} use a fast path for
   * air/water-only writes: no per-cell events, deferred lighting until {@link popBulkForegroundWrites}.
   */
  private _bulkFgDepth = 0;
  private readonly _bulkFgChunkKeys = new Set<number>();
  private readonly _bulkFgSkyWx = new Set<number>();

  /** World keys `${wx},${bottomWy}` for door bottom cells (see {@link doorAnchorBottomWy}). */
  private readonly _doorBottomKeys = new Set<string>();
  /** Screen-space player samples for door proximity (set before and after local physics each tick). */
  private readonly _doorPlayerSamples: DoorPlayerSample[] = [];
  /** Last door render signature per bottom key — drives chunk mesh dirty when open state or swing hinge changes. */
  private readonly _doorRenderSig = new Map<string, string>();
  /** Previous effective-open + latch for {@link refreshDoorProximityMeshDirty} proximity SFX (no double-play with click). */
  private readonly _doorProximitySfxState = new Map<
    string,
    { effective: boolean; latched: boolean }
  >();

  /**
   * Chunk coords queued for light recomputation during the current tick.
   * Flushed once per tick via {@link flushPendingLightRecomputes}.
   */
  private readonly _pendingLightChunks = new Map<number, number>();

  /**
   * Block-changed events queued during the current tick.
   * Flushed once per tick via {@link flushPendingBlockChangedEvents}.
   */
  private readonly _pendingBlockChangedEvents: GameEvent[] = [];

  constructor(
    registry: BlockRegistry,
    seed: number,
    store: IndexedDBStore,
    worldUuid: string,
    lootResolver: ILootResolver,
    bus?: EventBus,
    persistedBlockIdPalette?: readonly string[],
    itemIdLayoutRevision?: number,
  ) {
    this.registry = registry;
    this.chunks = new ChunkManager();
    this.worldGen = new WorldGenerator(seed, registry);
    this.airId = registry.getByIdentifier("stratum:air").id;
    this.cactusBlockId = registry.getByIdentifier("stratum:cactus").id;
    this.sugarCaneBlockId = registry.getByIdentifier("stratum:sugar_cane").id;
    this.seed = seed;
    this.store = store;
    this.worldUuid = worldUuid;
    this._lootResolver = lootResolver;
    this._lootRng = new GeneratorContext(seed);
    this.bus = bus;
    this._chunkGen = (coord) => this.worldGen.generateChunk(coord);
    this._blockLoadPalette =
      persistedBlockIdPalette !== undefined && persistedBlockIdPalette.length > 0
        ? [...persistedBlockIdPalette]
        : undefined;
    const rev = itemIdLayoutRevision ?? 0;
    if (rev >= ITEM_ID_LAYOUT_REVISION_CURRENT) {
      this._itemIdLayoutMigrationKind = "none";
      this._needsItemIdLayoutMigration = false;
    } else if (rev >= ITEM_ID_LAYOUT_REVISION_GRANITE) {
      this._itemIdLayoutMigrationKind = "rev2Plus6";
      this._needsItemIdLayoutMigration = true;
    } else if (rev >= ITEM_ID_LAYOUT_REVISION_STAIRS) {
      this._itemIdLayoutMigrationKind = "rev1Minus2";
      this._needsItemIdLayoutMigration = true;
    } else {
      this._itemIdLayoutMigrationKind = "legacy";
      this._needsItemIdLayoutMigration = true;
    }
  }

  /** Call once after items are registered (before chunk IO that reads chest/furnace tails). */
  setItemRegistry(registry: ItemRegistry): void {
    this._itemRegistry = registry;
  }

  /** Multiplayer client: load missing chunks from host instead of {@link WorldGenerator}. */
  setAuthoritativeChunkFetcher(
    fetch: ((cx: number, cy: number) => Promise<void>) | null,
  ): void {
    this._authoritativeChunkFetch = fetch;
  }

  /** Multiplayer host: replicate every {@link spawnItem} to clients. */
  setNetDropReplicationHook(
    hook:
      | ((p: {
          netId: number;
          itemId: number;
          count: number;
          x: number;
          y: number;
          vx: number;
          vy: number;
          damage: number;
        }) => void)
      | null,
  ): void {
    this._netDropReplicate = hook;
  }

  /** Multiplayer host: replicate every {@link spawnArrow} to clients. */
  setNetArrowReplicationHook(
    hook:
      | ((p: {
          netArrowId: number;
          x: number;
          y: number;
          vx: number;
          vy: number;
          damage: number;
          shooterFeetX: number;
        }) => void)
      | null,
  ): void {
    this._netArrowReplicate = hook;
  }

  /** Apply a host-authored drop on clients (`DROP_SPAWN`). */
  applyAuthoritativeDropSpawn(p: {
    netId: number;
    itemId: number;
    count: number;
    x: number;
    y: number;
    vx: number;
    vy: number;
    damage: number;
  }): void {
    const id = `n${p.netId}`;
    if (this._droppedItems.has(id)) {
      return;
    }
    const drop = new DroppedItem(
      id,
      p.itemId as ItemId,
      p.count,
      p.x,
      p.y,
      p.vx,
      p.vy,
      p.damage,
    );
    this._droppedItems.set(id, drop);
  }

  /** Remove replicated drop everywhere (`DROP_DESPAWN`). */
  removeAuthoritativeDropByNetId(netId: number): void {
    this._dropPickupPending.delete(netId);
    this._droppedItems.delete(`n${netId}`);
  }

  /** Apply a host-authored arrow on clients (`ARROW_SPAWN`). */
  applyAuthoritativeArrowSpawn(p: {
    netArrowId: number;
    x: number;
    y: number;
    vx: number;
    vy: number;
    damage: number;
    shooterFeetX: number;
  }): void {
    const id = `a${p.netArrowId}`;
    if (this._arrows.has(id)) {
      return;
    }
    const dmg = Math.max(0, Math.floor(p.damage));
    this._arrows.set(
      id,
      new ArrowProjectile(id, p.x, p.y, p.vx, p.vy, dmg, p.shooterFeetX),
    );
  }

  private requireItemRegistry(): ItemRegistry {
    if (this._itemRegistry === null) {
      throw new Error("World.setItemRegistry must be called before chest/furnace persistence");
    }
    return this._itemRegistry;
  }

  /** Seeded RNG fork for each block-break loot roll (deterministic order for a given seed). */
  private takeLootRng(): GeneratorContext {
    return this._lootRng.fork(this._lootForkSeq++);
  }

  /** Seeded RNG fork for mob AI / spawn / death loot (host-only). */
  forkMobRng(): GeneratorContext {
    return this._lootRng.fork(this._mobForkSeq++);
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

  /** Desert biome at world block column `wx` (matches terrain generator). */
  isDesertColumn(wx: number): boolean {
    return this.worldGen.isDesertColumn(wx);
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
    const oldBg = this.getBackgroundId(wx, wy);
    const coord = worldToChunk(wx, wy);
    const chunk = this.chunks.getOrCreateChunk(coord, this._chunkGen);
    const { lx, ly } = worldToLocalBlock(wx, wy);
    setBackground(chunk, lx, ly, id);
    this.emitBackgroundBlockChanged(wx, wy, oldBg, id);

    if (id === 0 && oldBg !== 0) {
      const fg = this.getBlock(wx, wy);
      if (fg.isPainting === true) {
        this.breakPaintingAt(wx, wy);
      }
    }

    return true;
  }

  private breakPaintingAt(wx: number, wy: number): void {
    const pmeta = this.getMetadata(wx, wy);
    const decoded = decodePaintingMeta(pmeta);
    const pv = PAINTING_VARIANTS[decoded.variantIndex]!;
    const anchorX = wx - decoded.offsetX;
    const anchorY = wy - decoded.offsetY;
    this.spawnLootForBrokenBlock(this.getBlock(wx, wy).id, anchorX, anchorY);
    for (let oy = 0; oy < pv.height; oy++) {
      for (let ox = 0; ox < pv.width; ox++) {
        this.setBlock(anchorX + ox, anchorY + oy, 0);
      }
    }
  }

  getMetadata(wx: number, wy: number): number {
    const coord = worldToChunk(wx, wy);
    const chunk = this.chunks.getChunk(coord);
    if (chunk === undefined) return 0;
    const { lx, ly } = worldToLocalBlock(wx, wy);
    return chunk.metadata[localIndex(lx, ly)]!;
  }

  setMetadata(wx: number, wy: number, value: number): void {
    const coord = worldToChunk(wx, wy);
    const chunk = this.chunks.getChunk(coord);
    if (chunk === undefined) return;
    const { lx, ly } = worldToLocalBlock(wx, wy);
    chunk.metadata[localIndex(lx, ly)] = value;
    chunk.dirty = true;
  }

  /**
   * Player / remote samples for door proximity opening. Call each tick before and after
   * local movement (see {@link refreshDoorProximityMeshDirty} after physics).
   */
  setDoorPlayerCollidersForProximity(samples: readonly DoorPlayerSample[]): void {
    this._doorPlayerSamples.length = 0;
    for (const s of samples) {
      this._doorPlayerSamples.push(s);
    }
  }

  /** True if this cell is part of a door and the door should not collide / shows open. */
  isDoorEffectivelyOpen(wx: number, wy: number): boolean {
    const def = this.getBlock(wx, wy);
    const bottomWy = doorAnchorBottomWy(def, wy);
    if (bottomWy === null) {
      return false;
    }
    const bottomDef = this.getBlock(wx, bottomWy);
    if (bottomDef.doorHalf !== "bottom") {
      return false;
    }
    const meta = this.getMetadata(wx, bottomWy);
    if (doorLatchedOpenFromMeta(meta)) {
      return true;
    }
    return anyPlayerOverlapsDoorProximity(
      this._doorPlayerSamples,
      wx,
      bottomWy,
    );
  }

  /**
   * Hinge side for rendering the thin door strip (proximity-open uses walk direction vs feet).
   */
  getDoorRenderHingeRight(wx: number, wy: number): boolean {
    const def = this.getBlock(wx, wy);
    const bottomWy = doorAnchorBottomWy(def, wy);
    if (bottomWy === null) {
      return false;
    }
    const bottomDef = this.getBlock(wx, bottomWy);
    if (bottomDef.doorHalf !== "bottom") {
      return false;
    }
    const meta = this.getMetadata(wx, bottomWy);
    const metaHinge = doorHingeRightFromMeta(meta);
    if (!anyPlayerOverlapsDoorProximity(this._doorPlayerSamples, wx, bottomWy)) {
      return metaHinge;
    }
    const sample = doorProximityOverlapBest(
      this._doorPlayerSamples,
      wx,
      bottomWy,
    );
    if (sample === null) {
      return metaHinge;
    }
    return doorRenderHingeRightFromProximity(sample, wx);
  }

  /**
   * Marks foreground chunks dirty when door effective-open or swing hinge changes, so meshes rebuild.
   */
  refreshDoorProximityMeshDirty(): void {
    for (const key of this._doorBottomKeys) {
      const comma = key.indexOf(",");
      const wx = Number(key.slice(0, comma));
      const bottomWy = Number(key.slice(comma + 1));
      const meta = this.getMetadata(wx, bottomWy);
      const latched = doorLatchedOpenFromMeta(meta);
      const effective = this.isDoorEffectivelyOpen(wx, bottomWy);
      const hingeR = this.getDoorRenderHingeRight(wx, bottomWy);
      const sig = `${effective ? 1 : 0}:${hingeR ? 1 : 0}`;
      const prevSig = this._doorProximitySfxState.get(key);
      if (prevSig !== undefined) {
        const { effective: prevEff, latched: prevLatch } = prevSig;
        if (effective && !prevEff && !latched) {
          this.bus?.emit({
            type: "door:proximity-swing",
            wx,
            bottomWy,
            opening: true,
          } satisfies GameEvent);
        } else if (!effective && prevEff && !prevLatch && !latched) {
          this.bus?.emit({
            type: "door:proximity-swing",
            wx,
            bottomWy,
            opening: false,
          } satisfies GameEvent);
        }
      }
      this._doorProximitySfxState.set(key, { effective, latched });
      const prev = this._doorRenderSig.get(key);
      if (prev !== sig) {
        this._doorRenderSig.set(key, sig);
        this.markForegroundChunkDirtyAtWorldCell(wx, bottomWy);
        this.markForegroundChunkDirtyAtWorldCell(wx, bottomWy + 1);
      }
    }
  }

  private markForegroundChunkDirtyAtWorldCell(wx: number, wy: number): void {
    const ch = this.getChunkAt(wx, wy);
    if (ch !== undefined) {
      ch.dirty = true;
    }
  }

  private updateDoorBottomIndexOnFgChange(
    wx: number,
    wy: number,
    oldId: number,
    newId: number,
  ): void {
    if (oldId !== 0) {
      const od = this.registry.getById(oldId);
      if (od.doorHalf === "bottom") {
        const k = `${wx},${wy}`;
        this._doorBottomKeys.delete(k);
        this._doorProximitySfxState.delete(k);
      } else if (od.doorHalf === "top" && wy > WORLD_Y_MIN) {
        const k = `${wx},${wy - 1}`;
        this._doorBottomKeys.delete(k);
        this._doorProximitySfxState.delete(k);
      }
    }
    if (newId !== 0) {
      const nd = this.registry.getById(newId);
      if (nd.doorHalf === "bottom") {
        this._doorBottomKeys.add(`${wx},${wy}`);
      } else if (nd.doorHalf === "top") {
        this._doorBottomKeys.add(`${wx},${wy - 1}`);
      }
    }
  }

  private clearDoorBottomKeysInChunk(cx: number, cy: number): void {
    const x0 = cx * CHUNK_SIZE;
    const x1 = x0 + CHUNK_SIZE - 1;
    const y0 = cy * CHUNK_SIZE;
    const y1 = y0 + CHUNK_SIZE - 1;
    const del: string[] = [];
    for (const k of this._doorBottomKeys) {
      const comma = k.indexOf(",");
      const wx = Number(k.slice(0, comma));
      const wyb = Number(k.slice(comma + 1));
      if (wx >= x0 && wx <= x1 && wyb >= y0 && wyb <= y1) {
        del.push(k);
      }
    }
    for (const k of del) {
      this._doorBottomKeys.delete(k);
      this._doorProximitySfxState.delete(k);
    }
  }

  private indexDoorBottomsFromChunk(chunk: Chunk): void {
    const { wx: ox, wy: oy } = chunkToWorldOrigin(chunk.coord);
    for (let ly = 0; ly < CHUNK_SIZE; ly++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const id = chunk.blocks[localIndex(lx, ly)]!;
        const def = this.registry.getById(id);
        if (def.doorHalf === "bottom") {
          this._doorBottomKeys.add(`${ox + lx},${oy + ly}`);
        }
      }
    }
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

  /** Solid, non-replaceable block beside (wx, wy) on ±X — cactus may not be placed here. */
  private horizontalNeighborBlocksCactusPlacement(wx: number, wy: number): boolean {
    for (const dx of [-1, 1] as const) {
      const b = this.getBlock(wx + dx, wy);
      if (b.id === this.airId) {
        continue;
      }
      if (b.solid && !b.replaceable) {
        return true;
      }
    }
    return false;
  }

  /**
   * Cactus needs empty horizontal sides (no solid non-replaceable neighbors);
   * other blocks cannot be placed directly adjacent to cactus on ±X.
   */
  canPlaceForegroundWithCactusRules(wx: number, wy: number, blockId: number): boolean {
    const placed = this.registry.getById(blockId);
    if (placed.identifier === "stratum:cactus") {
      if (this.horizontalNeighborBlocksCactusPlacement(wx, wy)) {
        return false;
      }
    }
    const cid = this.cactusBlockId;
    if (this.getBlock(wx - 1, wy).id === cid || this.getBlock(wx + 1, wy).id === cid) {
      return false;
    }
    return true;
  }

  /** True if the block cell at world block coordinates is solid. */
  isSolid(worldBlockX: number, worldBlockY: number): boolean {
    return this.getBlock(worldBlockX, worldBlockY).solid;
  }

  /**
   * Minecraft-style outdoor rain: ray from above the player's head to the top of the world.
   * Solid non-transparent blocks (not glass/leaves) block rain sound.
   */
  canHearOpenSkyRain(worldBlockX: number, feetPixelY: number): boolean {
    const headTopPx = feetPixelY + PLAYER_HEIGHT;
    const headWy = Math.floor((Math.max(0, headTopPx) - 1) / BLOCK_SIZE);
    for (let wy = headWy + 1; wy <= WORLD_Y_MAX; wy++) {
      const b = this.getBlock(worldBlockX, wy);
      if (b.solid && !b.transparent) {
        return false;
      }
    }
    return true;
  }

  /** Screen-space (Pixi Y down) collidable block AABBs overlapping `region` — same contract as {@link getSolidAABBs}. */
  querySolidAABBs(region: ScreenAABB, out: ScreenAABB[]): void {
    out.length = 0;
    const worldYBottom = -(region.y + region.height);
    const worldYTop = -region.y;
    const wx0 = Math.floor(region.x / BLOCK_SIZE);
    const wx1 = Math.floor((region.x + region.width - 1) / BLOCK_SIZE);
    const wy0 = Math.floor(worldYBottom / BLOCK_SIZE);
    const wy1 = Math.floor(worldYTop / BLOCK_SIZE);
    const reg = this.registry;
    for (let wx = wx0; wx <= wx1; wx++) {
      for (let wy = wy0; wy <= wy1; wy++) {
        const chunk = this.getChunkAt(wx, wy);
        if (chunk === undefined) {
          continue;
        }
        const { lx, ly } = worldToLocalBlock(wx, wy);
        const id = getBlock(chunk, lx, ly);
        if (!reg.collides(id)) {
          continue;
        }
        if ((chunk.metadata[localIndex(lx, ly)]! & WORLDGEN_NO_COLLIDE) !== 0) {
          continue;
        }
        const def = reg.getById(id);
        if (
          (def.doorHalf === "bottom" || def.doorHalf === "top") &&
          this.isDoorEffectivelyOpen(wx, wy)
        ) {
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
      const j = Math.floor(unixRandom01() * (i + 1));
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
    damage = 0,
  ): void {
    let id: string;
    if (this._netDropReplicate !== null) {
      const netId = this._nextNetDropId++;
      id = `n${netId}`;
      this._netDropReplicate({
        netId,
        itemId,
        count,
        x,
        y,
        vx,
        vy,
        damage,
      });
    } else {
      id = `drop-${++this._dropSeq}`;
    }
    const drop = new DroppedItem(id, itemId, count, x, y, vx, vy, damage);
    this._droppedItems.set(id, drop);
  }

  /**
   * @internal Fixed-step update for dropped items; adds to inventory when collected,
   * leaving overflow on the ground when full.
   */
  updateDroppedItems(
    dt: number,
    playerPos: { x: number; y: number },
    inventory: { addItemStack(stack: ItemStack): ItemStack | null },
    onItemPickedUp?: () => void,
    /** When set, replicated drops (`n*`) request host pickup instead of local inventory. */
    networkPickupRequest?: (netId: number) => void,
    /**
     * Multiplayer host: after fully collecting a replicated drop (`n*`), broadcast despawn to clients.
     */
    hostReplicatedPickupDespawn?: (netId: number) => void,
  ): void {
    for (const [id, item] of [...this._droppedItems.entries()]) {
      const collected = item.update(dt, this, playerPos, this._dropSolidScratch);
      if (!collected) {
        continue;
      }
      if (
        networkPickupRequest !== undefined &&
        id.startsWith("n") &&
        id.length > 1
      ) {
        const netId = Number.parseInt(id.slice(1), 10);
        if (Number.isFinite(netId) && !this._dropPickupPending.has(netId)) {
          this._dropPickupPending.add(netId);
          networkPickupRequest(netId);
        }
        continue;
      }
      const stack: ItemStack = {
        itemId: item.itemId,
        count: item.count,
        ...(item.damage > 0 ? { damage: item.damage } : {}),
      };
      const beforeCount = stack.count;
      const overflow = inventory.addItemStack(stack);
      const absorbed =
        overflow === null || overflow.count < beforeCount;
      if (absorbed) {
        onItemPickedUp?.();
      }
      if (overflow !== null) {
        item.count = overflow.count;
        item.damage = overflow.damage ?? 0;
      } else {
        if (
          hostReplicatedPickupDespawn !== undefined &&
          id.startsWith("n") &&
          id.length > 1
        ) {
          const netId = Number.parseInt(id.slice(1), 10);
          if (Number.isFinite(netId)) {
            hostReplicatedPickupDespawn(netId);
          }
        }
        this._droppedItems.delete(id);
      }
    }
  }

  /** @internal Used by EntityManager for rendering. */
  getDroppedItems(): ReadonlyMap<string, DroppedItem> {
    return this._droppedItems;
  }

  /**
   * Spawns an arrow projectile at world pixel coordinates (feet-space, Y up).
   * `vx`/`vy` use the same convention as dropped items (+vy = world down).
   */
  spawnArrow(
    x: number,
    y: number,
    vx: number,
    vy: number,
    damage: number,
    shooterFeetX: number,
  ): void {
    const dmg = Math.max(0, Math.floor(damage));
    let id: string;
    if (this._netArrowReplicate !== null) {
      const netArrowId = this._nextNetArrowId++;
      id = `a${netArrowId}`;
      this._netArrowReplicate({
        netArrowId,
        x,
        y,
        vx,
        vy,
        damage: dmg,
        shooterFeetX,
      });
    } else {
      id = `arrow-${++this._arrowSeq}`;
    }
    this._arrows.set(id, new ArrowProjectile(id, x, y, vx, vy, dmg, shooterFeetX));
  }

  /**
   * Integrates arrows, resolves mob strikes via `tryStrike` when provided.
   * Flying arrows stick in blocks or embed in mobs; mob-stuck arrows follow `mobFeetLookup`.
   */
  updateArrows(
    dt: number,
    tryStrike:
      | ((
          prevX: number,
          prevY: number,
          nextX: number,
          nextY: number,
          damage: number,
          shooterFeetX: number,
        ) => HostArrowStrikeResult)
      | null,
    mobFeetLookup?: (
      mobId: number,
    ) =>
      | { x: number; y: number; tiltRad: number; facingRight: boolean }
      | undefined,
    /** Called when a flying arrow embeds in terrain (`bowhit` SFX). */
    onArrowStuckBlock?: (worldX: number, worldY: number) => void,
    /** Host/solo: mob embed after damage (e.g. refresh local-only HP bar). */
    onArrowStickMob?: (mobId: number) => void,
  ): void {
    if (mobFeetLookup !== undefined) {
      for (const [id, arrow] of [...this._arrows.entries()]) {
        if (!arrow.isStuckInMob()) {
          continue;
        }
        const feet = mobFeetLookup(arrow.stuckMobId);
        if (feet === undefined) {
          this._arrows.delete(id);
        } else {
          arrow.syncStuckMobPosition(
            feet.x,
            feet.y,
            feet.tiltRad,
            feet.facingRight,
          );
        }
      }
    }

    for (const [id, arrow] of [...this._arrows.entries()]) {
      if (!arrow.isFlying()) {
        continue;
      }
      const ox = arrow.x;
      const oy = arrow.y;
      const life = arrow.tick(dt, this, this._dropSolidScratch);
      if (life === "dead") {
        this._arrows.delete(id);
        continue;
      }
      if (life === "stuck_block") {
        onArrowStuckBlock?.(arrow.x, arrow.y);
        continue;
      }
      if (tryStrike !== null) {
        const r = tryStrike(ox, oy, arrow.x, arrow.y, arrow.damage, arrow.shooterFeetX);
        if (r.kind === "stickMob") {
          arrow.stickToMob(
            r.mobId,
            r.offsetX,
            r.offsetY,
            r.rotationRad,
            r.mobFacingRight,
          );
          onArrowStickMob?.(r.mobId);
          if (mobFeetLookup !== undefined) {
            const feetNow = mobFeetLookup(r.mobId);
            if (feetNow !== undefined) {
              arrow.syncStuckMobPosition(
                feetNow.x,
                feetNow.y,
                feetNow.tiltRad,
                feetNow.facingRight,
              );
            }
          }
        }
      }
    }
  }

  /** Remove every arrow embedded in this mob (called when the mob is removed from the world). */
  removeArrowsStuckToMob(mobId: number): void {
    for (const [id, arrow] of [...this._arrows.entries()]) {
      if (arrow.isStuckInMob() && arrow.stuckMobId === mobId) {
        this._arrows.delete(id);
      }
    }
  }

  /**
   * Picks up **block-stuck** arrows near the player into inventory (not mob-stuck; those are not
   * retrievable).
   */
  collectGroundStuckArrows(
    playerPos: { x: number; y: number },
    inventory: { addItemStack(stack: ItemStack): ItemStack | null },
    arrowItemId: ItemId,
    onPickedUp?: () => void,
  ): void {
    const snap2 = ARROW_STUCK_COLLECT_SNAP_PX * ARROW_STUCK_COLLECT_SNAP_PX;
    for (const [id, arrow] of [...this._arrows.entries()]) {
      if (!arrow.isStuckInBlock()) {
        continue;
      }
      const dx = arrow.x - playerPos.x;
      const dy = arrow.y - playerPos.y;
      if (dx * dx + dy * dy > snap2) {
        continue;
      }
      const stack: ItemStack = { itemId: arrowItemId, count: 1 };
      const overflow = inventory.addItemStack(stack);
      if (overflow === null) {
        onPickedUp?.();
        this._arrows.delete(id);
      }
    }
  }

  /** @internal Used by EntityManager for rendering. */
  getArrows(): ReadonlyMap<string, ArrowProjectile> {
    return this._arrows;
  }

  /** Clears every arrow (e.g. when resetting mobs / world session). */
  clearAllArrows(): void {
    this._arrows.clear();
  }

  /**
   * Begin batching air/water foreground writes (fluid sim). Pair with {@link popBulkForegroundWrites}.
   * Defers lighting and per-cell `game:block-changed` until the matching pop.
   */
  pushBulkForegroundWrites(): void {
    this._bulkFgDepth += 1;
  }

  popBulkForegroundWrites(): void {
    this._bulkFgDepth -= 1;
    if (this._bulkFgDepth < 0) {
      this._bulkFgDepth = 0;
    }
    if (this._bulkFgDepth === 0) {
      this.flushBulkForegroundWrites();
    }
  }

  private flushBulkForegroundWrites(): void {
    for (const wx of this._bulkFgSkyWx) {
      this.invalidateSkyTopColumn(wx);
    }
    this._bulkFgSkyWx.clear();
    const affected = new Set<number>();
    for (const key of this._bulkFgChunkKeys) {
      affected.add(key);
      const { cx, cy } = unpackChunkCoordKey(key);
      affected.add(packChunkCoordKey(cx - 1, cy));
      affected.add(packChunkCoordKey(cx + 1, cy));
      affected.add(packChunkCoordKey(cx, cy - 1));
      affected.add(packChunkCoordKey(cx, cy + 1));
    }
    this._bulkFgChunkKeys.clear();
    const chunkCoords: { cx: number; cy: number }[] = [];
    for (const key of affected) {
      const { cx, cy } = unpackChunkCoordKey(key);
      this._queueLightRecompute(cx, cy, LIGHT_RECOMPUTE_BOTH);
      chunkCoords.push({ cx, cy });
    }
    if (chunkCoords.length > 0) {
      this.bus?.emit({
        type: "game:chunks-fg-bulk-updated",
        chunkCoords,
      } satisfies GameEvent);
    }
  }

  /**
   * Fast in-chunk write for fluid sim: air/water only, existing chunk, no chest/furnace.
   */
  private tryBulkForegroundWrite(
    wx: number,
    wy: number,
    newId: number,
    newMeta: number,
    oldId: number,
  ): boolean {
    if (this._bulkFgDepth <= 0) {
      return false;
    }
    let waterId: number;
    try {
      waterId = this.getWaterBlockId();
    } catch {
      return false;
    }
    if (newId !== this.airId && newId !== waterId) {
      return false;
    }
    if (oldId !== this.airId && !this.registry.getById(oldId).water) {
      return false;
    }
    if (
      this._chestBlockId !== null &&
      (oldId === this._chestBlockId || newId === this._chestBlockId)
    ) {
      return false;
    }
    const fid = this._furnaceBlockId;
    if (fid !== null && (oldId === fid || newId === fid)) {
      return false;
    }
    const coord = worldToChunk(wx, wy);
    const chunk = this.chunks.getChunk(coord);
    if (chunk === undefined) {
      return false;
    }
    const { lx, ly } = worldToLocalBlock(wx, wy);
    const idx = localIndex(lx, ly);
    setBlock(chunk, lx, ly, newId);
    chunk.metadata[idx] = newMeta;
    chunk.dirty = true;
    this._bulkFgChunkKeys.add(packChunkCoordKey(coord.cx, coord.cy));
    this._bulkFgSkyWx.add(wx);
    return true;
  }

  /**
   * Sets a block in world space. Ignores writes outside vertical bounds.
   * Phase 2: broadcast `BLOCK_UPDATE` from host here.
   * @param opts.cellMetadata Per-cell flags for this block (e.g. {@link WORLDGEN_NO_COLLIDE}); defaults to 0.
   */
  setBlock(
    wx: number,
    wy: number,
    id: number,
    opts?: { cellMetadata?: number },
  ): boolean {
    if (wy < WORLD_Y_MIN || wy > WORLD_Y_MAX) {
      return false;
    }
    const oldId = this.getBlockId(wx, wy);
    if (
      this._bulkFgDepth > 0 &&
      this.tryBulkForegroundWrite(wx, wy, id, opts?.cellMetadata ?? 0, oldId)
    ) {
      return true;
    }
    if (
      this._chestBlockId !== null &&
      oldId === this._chestBlockId &&
      id !== this._chestBlockId
    ) {
      this.breakChestBeforeBlockChange(wx, wy);
    }
    const coord = worldToChunk(wx, wy);
    const chunk = this.chunks.getOrCreateChunk(coord, this._chunkGen);
    const { lx, ly } = worldToLocalBlock(wx, wy);
    const oldMeta = chunk.metadata[localIndex(lx, ly)]!;
    setBlock(chunk, lx, ly, id);
    const newMeta = opts?.cellMetadata ?? 0;
    chunk.metadata[localIndex(lx, ly)] = newMeta;
    this.syncFurnaceTileAfterBlockChange(wx, wy, id);
    if (this._chestBlockId !== null) {
      if (id === this._chestBlockId) {
        tryMergeChestAfterPlace(wx, wy, this.chestMergeContext());
        this.ensureChestTileAt(wx, wy);
      } else {
        this._chestTiles.delete(chestCellKey(wx, wy));
      }
      if (oldId === this._chestBlockId || id === this._chestBlockId) {
        this.markChunksDirtyForHorizontalChestNeighbors(wx, wy);
      }
    }
    this.invalidateSkyTopColumn(wx);
    if (this.registry.getById(id).solid) {
      this.nudgeDroppedItemsFromBlock(wx, wy);
    }

    const { cx, cy } = worldToChunk(wx, wy);
    const oldDef = this.registry.getById(oldId);
    const newDef = this.registry.getById(id);
    const affectsSky =
      oldDef.solid !== newDef.solid ||
      oldDef.lightAbsorption !== newDef.lightAbsorption;
    const affectsBlock =
      oldDef.lightEmission !== newDef.lightEmission ||
      oldDef.lightAbsorption !== newDef.lightAbsorption ||
      oldDef.solid !== newDef.solid;
    const lightMode =
      (affectsSky ? LIGHT_RECOMPUTE_SKY : 0) |
      (affectsBlock ? LIGHT_RECOMPUTE_BLOCK : 0);
    if (lightMode !== 0) {
      this._queueLightRecompute(cx, cy, lightMode);
    }
    const localX = ((wx % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    const localY = ((wy % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    if (localX === 0) {
      this._queueLightRecompute(cx - 1, cy, LIGHT_RECOMPUTE_BOTH);
    }
    if (localX === CHUNK_SIZE - 1) {
      this._queueLightRecompute(cx + 1, cy, LIGHT_RECOMPUTE_BOTH);
    }
    if (localY === 0) {
      this._queueLightRecompute(cx, cy - 1, LIGHT_RECOMPUTE_BOTH);
    }
    if (localY === CHUNK_SIZE - 1) {
      this._queueLightRecompute(cx, cy + 1, LIGHT_RECOMPUTE_BOTH);
    }

    this.breakPlantsIfSupportLost(wx, wy);

    this.emitForegroundBlockChanged(wx, wy, oldId, id, oldMeta, newMeta);
    this.markWaterActiveForBlockChange(wx, wy, oldId, id);
    if (
      oldId !== id &&
      this.registry.getById(oldId).water &&
      !this.registry.getById(id).water
    ) {
      this._pendingWaterTopologyResim = true;
    }
    return true;
  }

  private emitForegroundBlockChanged(
    wx: number,
    wy: number,
    oldId: number,
    newId: number,
    oldMeta: number,
    newMeta: number,
  ): void {
    if (oldId !== newId) {
      this.updateDoorBottomIndexOnFgChange(wx, wy, oldId, newId);
    }
    if (this.bus === undefined) {
      return;
    }
    if (oldId === newId && oldMeta === newMeta) {
      return;
    }
    this._pendingBlockChangedEvents.push({
      type: "game:block-changed",
      wx,
      wy,
      blockId: newId,
      previousBlockId: oldId !== newId ? oldId : undefined,
      layer: "fg",
      cellMetadata: newMeta,
    } satisfies GameEvent);
  }

  private emitBackgroundBlockChanged(
    wx: number,
    wy: number,
    oldId: number,
    newId: number,
  ): void {
    if (this.bus === undefined || oldId === newId) {
      return;
    }
    this._pendingBlockChangedEvents.push({
      type: "game:block-changed",
      wx,
      wy,
      blockId: newId,
      previousBlockId: oldId,
      layer: "bg",
    } satisfies GameEvent);
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
      }
      return;
    }

    if (above.doorHalf === "bottom") {
      const okSupport =
        support.solid && !support.replaceable && !support.water;
      if (!okSupport) {
        this.spawnLootForBrokenBlock(above.id, wx, wy + 1);
        this.setBlockWithoutPlantCascade(wx, wy + 1, 0);
        if (wy + 2 <= WORLD_Y_MAX) {
          const topHalf = this.getBlock(wx, wy + 2);
          if (topHalf.doorHalf === "top") {
            this.setBlockWithoutPlantCascade(wx, wy + 2, 0);
          }
        }
      }
      return;
    }

    if (above.doorHalf === "top") {
      if (support.doorHalf !== "bottom") {
        this.spawnLootForBrokenBlock(above.id, wx, wy + 1);
        this.setBlockWithoutPlantCascade(wx, wy + 1, 0);
      }
      return;
    }

    if (above.bedHalf === "foot") {
      const okSupport =
        support.solid && !support.replaceable && !support.water;
      if (!okSupport) {
        const fy = wy + 1;
        const meta = this.getMetadata(wx, fy);
        const headPlusX = bedHeadPlusXFromMeta(meta);
        const headWx = headPlusX ? wx + 1 : wx - 1;
        this.spawnLootForBrokenBlock(above.id, wx, fy);
        this.setBlockWithoutPlantCascade(wx, fy, 0);
        const headCell = this.getBlock(headWx, fy);
        if (headCell.bedHalf === "head") {
          this.setBlockWithoutPlantCascade(headWx, fy, 0);
        }
      }
      return;
    }

    if (above.bedHalf === "head") {
      const okSupport =
        support.solid && !support.replaceable && !support.water;
      if (!okSupport) {
        const hy = wy + 1;
        const meta = this.getMetadata(wx, hy);
        const headPlusX = bedHeadPlusXFromMeta(meta);
        const footWx = headPlusX ? wx - 1 : wx + 1;
        const footCell = this.getBlock(footWx, hy);
        if (footCell.bedHalf === "foot") {
          this.spawnLootForBrokenBlock(footCell.id, footWx, hy);
          this.setBlockWithoutPlantCascade(footWx, hy, 0);
          this.setBlockWithoutPlantCascade(wx, hy, 0);
        } else {
          this.spawnLootForBrokenBlock(above.id, wx, hy);
          this.setBlockWithoutPlantCascade(wx, hy, 0);
        }
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
      if (
        above.id === this.cactusBlockId &&
        !isValidCactusSupportBelow(support, this.cactusBlockId)
      ) {
        let y = wy + 1;
        while (y <= WORLD_Y_MAX) {
          const cell = this.getBlock(wx, y);
          if (cell.id !== this.cactusBlockId) {
            break;
          }
          this.spawnLootForBrokenBlock(cell.id, wx, y);
          this.setBlockWithoutPlantCascade(wx, y, 0);
          y += 1;
        }
      }
      if (
        above.id === this.sugarCaneBlockId &&
        (!isValidSugarCaneSupportBelow(support, this.sugarCaneBlockId) ||
          (support.id !== this.sugarCaneBlockId &&
            !sugarCaneBaseHasAdjacentWater(this, wx, wy)))
      ) {
        let y = wy + 1;
        while (y <= WORLD_Y_MAX) {
          const cell = this.getBlock(wx, y);
          if (cell.id !== this.sugarCaneBlockId) {
            break;
          }
          this.spawnLootForBrokenBlock(cell.id, wx, y);
          this.setBlockWithoutPlantCascade(wx, y, 0);
          y += 1;
        }
      }
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
        }
      }
      this.spawnLootForBrokenBlock(above.id, wx, wy + 1);
      this.setBlockWithoutPlantCascade(wx, wy + 1, 0);
      return;
    }

    this.spawnLootForBrokenBlock(above.id, wx, wy + 1);
    this.setBlockWithoutPlantCascade(wx, wy + 1, 0);
  }

  /** Internal setBlock without re-running plant-cascade (avoids recursion when clearing plants). */
  private setBlockWithoutPlantCascade(
    wx: number,
    wy: number,
    id: number,
    opts?: { skipChestBreak?: boolean },
  ): boolean {
    if (wy < WORLD_Y_MIN || wy > WORLD_Y_MAX) {
      return false;
    }
    const oldId = this.getBlockId(wx, wy);
    if (
      this._bulkFgDepth > 0 &&
      this.tryBulkForegroundWrite(wx, wy, id, 0, oldId)
    ) {
      return true;
    }
    if (
      !opts?.skipChestBreak &&
      this._chestBlockId !== null &&
      oldId === this._chestBlockId &&
      id !== this._chestBlockId
    ) {
      this.breakChestBeforeBlockChange(wx, wy);
    }
    const coord = worldToChunk(wx, wy);
    const chunk = this.chunks.getOrCreateChunk(coord, this._chunkGen);
    const { lx, ly } = worldToLocalBlock(wx, wy);
    const oldMeta = chunk.metadata[localIndex(lx, ly)]!;
    setBlock(chunk, lx, ly, id);
    chunk.metadata[localIndex(lx, ly)] = 0;
    this.syncFurnaceTileAfterBlockChange(wx, wy, id);
    if (this._chestBlockId !== null) {
      if (id === this._chestBlockId) {
        tryMergeChestAfterPlace(wx, wy, this.chestMergeContext());
        this.ensureChestTileAt(wx, wy);
      } else {
        this._chestTiles.delete(chestCellKey(wx, wy));
      }
      if (oldId === this._chestBlockId || id === this._chestBlockId) {
        this.markChunksDirtyForHorizontalChestNeighbors(wx, wy);
      }
    }
    this.invalidateSkyTopColumn(wx);
    if (this.registry.getById(id).solid) {
      this.nudgeDroppedItemsFromBlock(wx, wy);
    }
    const { cx, cy } = worldToChunk(wx, wy);
    const oldDef = this.registry.getById(oldId);
    const newDef = this.registry.getById(id);
    const affectsSky =
      oldDef.solid !== newDef.solid ||
      oldDef.lightAbsorption !== newDef.lightAbsorption;
    const affectsBlock =
      oldDef.lightEmission !== newDef.lightEmission ||
      oldDef.lightAbsorption !== newDef.lightAbsorption ||
      oldDef.solid !== newDef.solid;
    const lightMode =
      (affectsSky ? LIGHT_RECOMPUTE_SKY : 0) |
      (affectsBlock ? LIGHT_RECOMPUTE_BLOCK : 0);
    if (lightMode !== 0) {
      this._queueLightRecompute(cx, cy, lightMode);
    }
    const localX = ((wx % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    const localY = ((wy % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    if (localX === 0) {
      this._queueLightRecompute(cx - 1, cy, LIGHT_RECOMPUTE_BOTH);
    }
    if (localX === CHUNK_SIZE - 1) {
      this._queueLightRecompute(cx + 1, cy, LIGHT_RECOMPUTE_BOTH);
    }
    if (localY === 0) {
      this._queueLightRecompute(cx, cy - 1, LIGHT_RECOMPUTE_BOTH);
    }
    if (localY === CHUNK_SIZE - 1) {
      this._queueLightRecompute(cx, cy + 1, LIGHT_RECOMPUTE_BOTH);
    }
    this.emitForegroundBlockChanged(wx, wy, oldId, id, oldMeta, 0);
    this.markWaterActiveForBlockChange(wx, wy, oldId, id);
    if (
      oldId !== id &&
      this.registry.getById(oldId).water &&
      !this.registry.getById(id).water
    ) {
      this._pendingWaterTopologyResim = true;
    }
    return true;
  }

  /** @internal Fluid sim: clear cells without plant cascade recursion (skips chest break for speed). */
  setBlockWithoutPlantCascadeForWater(wx: number, wy: number, id: number): boolean {
    return this.setBlockWithoutPlantCascade(wx, wy, id, { skipChestBreak: true });
  }

  /** Numeric id of `stratum:water` (cached). */
  getWaterBlockId(): number {
    if (this._waterBlockId === null) {
      this._waterBlockId = this.registry.getByIdentifier("stratum:water").id;
    }
    return this._waterBlockId;
  }

  /** @internal Water flow scan loaded chunks only. */
  iterLoadedChunks(): Iterable<Chunk> {
    return this.chunks.getLoadedChunks();
  }

  /**
   * Host / single-player: flowing water pass (spread from procedural / placed sources).
   * No-op if `stratum:water` is not registered.
   */
  tickWaterSystems(): void {
    try {
      const waterId = this.getWaterBlockId();
      if (this._pendingWaterTopologyResim) {
        this._pendingWaterTopologyResim = false;
        this.setActiveWaterChunkKeys(resimulateWaterFromSources(this, waterId));
      }
      this._waterSimTick += 1;
      if (
        this._waterSimTick % WATER_FLOW_EVERY_N_TICKS === 0 &&
        this._activeWaterChunkKeys.size > 0
      ) {
        const nextActive = tickWaterFlow(
          this,
          this.airId,
          waterId,
          this.takeActiveWaterChunkKeys(),
        );
        this.setActiveWaterChunkKeys(nextActive);
      }
    } catch {
      // Pack without water block
    }
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

  private markWaterNeighborhoodActiveAtChunk(cx: number, cy: number): void {
    this._activeWaterChunkKeys.add(packChunkCoordKey(cx, cy));
    this._activeWaterChunkKeys.add(packChunkCoordKey(cx - 1, cy));
    this._activeWaterChunkKeys.add(packChunkCoordKey(cx + 1, cy));
    this._activeWaterChunkKeys.add(packChunkCoordKey(cx, cy - 1));
    this._activeWaterChunkKeys.add(packChunkCoordKey(cx, cy + 1));
  }

  private markWaterNeighborhoodActiveAtWorldCell(wx: number, wy: number): void {
    const { cx, cy } = worldToChunk(wx, wy);
    this.markWaterNeighborhoodActiveAtChunk(cx, cy);
  }

  private markWaterActiveForBlockChange(
    wx: number,
    wy: number,
    oldId: number,
    newId: number,
  ): void {
    let waterId: number;
    try {
      waterId = this.getWaterBlockId();
    } catch {
      return;
    }
    if (oldId === waterId || newId === waterId) {
      this.markWaterNeighborhoodActiveAtWorldCell(wx, wy);
      return;
    }
    if (
      this.getForegroundBlockId(wx - 1, wy) === waterId ||
      this.getForegroundBlockId(wx + 1, wy) === waterId ||
      this.getForegroundBlockId(wx, wy - 1) === waterId ||
      this.getForegroundBlockId(wx, wy + 1) === waterId
    ) {
      this.markWaterNeighborhoodActiveAtWorldCell(wx, wy);
    }
  }

  takeActiveWaterChunkKeys(): Set<number> {
    const keys = new Set(this._activeWaterChunkKeys);
    this._activeWaterChunkKeys.clear();
    return keys;
  }

  setActiveWaterChunkKeys(keys: ReadonlySet<number>): void {
    this._activeWaterChunkKeys.clear();
    for (const key of keys) {
      const { cx, cy } = unpackChunkCoordKey(key);
      if (this.getChunk(cx, cy) !== undefined) {
        this._activeWaterChunkKeys.add(key);
      }
    }
  }

  clearActiveWaterChunkKeys(): void {
    this._activeWaterChunkKeys.clear();
  }

  getChunkAt(wx: number, wy: number): Chunk | undefined {
    return this.chunks.getChunk(worldToChunk(wx, wy));
  }

  /** Chunk at chunk grid coordinates, or undefined if not loaded. */
  getChunk(chunkX: number, chunkY: number): Chunk | undefined {
    return this.chunks.getChunkXY(chunkX, chunkY);
  }

  /**
   * Host / solo: ensure one chunk exists (IndexedDB or procedural), with lighting.
   * Used when a multiplayer client requests an authoritative chunk from the host.
   */
  async loadOrGenerateChunkAt(cx: number, cy: number): Promise<void> {
    const coord: ChunkCoord = { cx, cy };
    if (this.chunks.getChunk(coord) !== undefined) {
      return;
    }
    const record = await this.store.loadChunk(this.worldUuid, coord);
    if (record !== undefined) {
      const chunk = this.chunkFromRecord(record);
      this.chunks.putChunk(chunk);
      if (record.furnaces !== undefined && record.furnaces.length > 0) {
        this.applyFurnaceEntitiesForChunk(
          coord.cx,
          coord.cy,
          record.furnaces,
          this._needsItemIdLayoutMigration,
        );
      }
      if (record.chests !== undefined && record.chests.length > 0) {
        this.applyChestEntitiesForChunk(
          coord.cx,
          coord.cy,
          record.chests,
          this._needsItemIdLayoutMigration,
        );
      }
      this.invalidateSkyTopStripForChunk(coord.cx);
      this.markWaterNeighborhoodActiveAtChunk(coord.cx, coord.cy);
    } else {
      this.chunks.putChunk(this._chunkGen(coord));
      this.invalidateSkyTopStripForChunk(coord.cx);
      this.markWaterNeighborhoodActiveAtChunk(coord.cx, coord.cy);
    }
    this.recomputeChunkLight(cx, cy);
  }

  /** Iterable of all loaded chunk grid coordinates [cx, cy]. */
  *loadedChunkCoords(): Generator<[number, number], void, undefined> {
    for (const chunk of this.chunks.getLoadedChunks()) {
      yield [chunk.coord.cx, chunk.coord.cy];
    }
  }

  async init(
    progressCallback?: WorldLoadProgressCallback,
    initialCentreBlockX?: number,
    initialCentreBlockY?: number,
  ): Promise<void> {
    await this.store.openDB();
    const { cx, cy } =
      initialCentreBlockX !== undefined && initialCentreBlockY !== undefined
        ? worldToChunk(initialCentreBlockX, initialCentreBlockY)
        : { cx: 0, cy: 0 };
    await this.loadChunksAroundCentre(cx, cy, progressCallback);
    this.streamCentreCx = cx;
    this.streamCentreCy = cy;
  }

  /** Snap the streaming centre so gameplay streaming starts from the player's actual position. */
  resetStreamCentre(bx: number, by: number): void {
    const { cx, cy } = worldToChunk(bx, by);
    this.streamCentreCx = cx;
    this.streamCentreCy = cy;
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
    /**
     * Hysteresis can leave the stream centre several chunks behind the player's chunk on one axis
     * (e.g. westbound: target cx jumps far negative while the threshold still holds the old centre).
     * Rendering only loads meshes within {@link VIEW_DISTANCE_CHUNKS} of the stream centre, so the
     * player would see empty tiles / missing back-wall until they crossed a narrow boundary. Snap when
     * the lag exceeds the view ring so the player's chunk is always inside the rendered set.
     */
    const lag = Math.max(
      Math.abs(this.streamCentreCx - targ.cx),
      Math.abs(this.streamCentreCy - targ.cy),
    );
    if (lag > VIEW_DISTANCE_CHUNKS) {
      this.streamCentreCx = targ.cx;
      this.streamCentreCy = targ.cy;
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
   * Multiplayer clients use {@link setAuthoritativeChunkFetcher} to request `CHUNK_DATA` from the host
   * for missing chunks instead of local procedural generation.
   */
  async loadChunksAroundCentre(
    centreCx: number,
    centreCy: number,
    progressCallback?: WorldLoadProgressCallback,
  ): Promise<void> {
    const t0 = import.meta.env.DEV ? chunkPerfNow() : 0;
    const centre: ChunkCoord = { cx: centreCx, cy: centreCy };
    const evicted = this.chunks.updateLoadedChunks(
      centre,
      SIMULATION_DISTANCE_CHUNKS,
      SPAWN_CHUNK_RADIUS,
      LOADED_CHUNK_HARD_CAP,
      MAX_SPAWN_STRIP_COLUMNS,
    );
    for (const { cx, cy } of evicted) {
      this.removeFurnaceTilesInChunk(cx, cy);
      this.removeChestTilesInChunk(cx, cy);
      this.clearDoorBottomKeysInChunk(cx, cy);
      this._activeWaterChunkKeys.delete(packChunkCoordKey(cx, cy));
    }
    for (const { cx } of evicted) {
      this.invalidateSkyTopStripForChunk(cx);
    }

    const r = SIMULATION_DISTANCE_CHUNKS;
    const pending: ChunkCoord[] = [];
    const seenPending = new Set<string>();

    const enqueue = (cx: number, cy: number): void => {
      const coord: ChunkCoord = { cx, cy };
      const key = `${cx},${cy}`;
      if (seenPending.has(key) || this.chunks.getChunk(coord) !== undefined) {
        return;
      }
      seenPending.add(key);
      pending.push(coord);
    };

    for (let cx = centre.cx - r; cx <= centre.cx + r; cx++) {
      for (let cy = centre.cy - r; cy <= centre.cy + r; cy++) {
        enqueue(cx, cy);
      }
    }
    for (let cx = -SPAWN_CHUNK_RADIUS; cx <= SPAWN_CHUNK_RADIUS; cx++) {
      for (let cy = centre.cy - r; cy <= centre.cy + r; cy++) {
        enqueue(cx, cy);
      }
    }
    if (pending.length > CHUNK_LOAD_PASS_BUDGET) {
      pending.sort((a, b) => {
        const da = Math.max(Math.abs(a.cx - centreCx), Math.abs(a.cy - centreCy));
        const db = Math.max(Math.abs(b.cx - centreCx), Math.abs(b.cy - centreCy));
        if (da !== db) {
          return da - db;
        }
        if (a.cx !== b.cx) {
          return a.cx - b.cx;
        }
        return a.cy - b.cy;
      });
      pending.length = CHUNK_LOAD_PASS_BUDGET;
    }

    const total = pending.length;
    let loaded = 0;
    const tLoad = import.meta.env.DEV ? chunkPerfNow() : 0;
    const records = await this.store.loadChunkBatch(this.worldUuid, pending);
    for (let i = 0; i < pending.length; i++) {
      const coord = pending[i]!;
      const record = records[i];
      if (record !== undefined) {
        const chunk = this.chunkFromRecord(record);
        this.chunks.putChunk(chunk);
        if (record.furnaces !== undefined && record.furnaces.length > 0) {
          this.applyFurnaceEntitiesForChunk(
            coord.cx,
            coord.cy,
            record.furnaces,
            this._needsItemIdLayoutMigration,
          );
        }
        if (record.chests !== undefined && record.chests.length > 0) {
          this.applyChestEntitiesForChunk(
            coord.cx,
            coord.cy,
            record.chests,
            this._needsItemIdLayoutMigration,
          );
        }
        this.invalidateSkyTopStripForChunk(coord.cx);
        this.markWaterNeighborhoodActiveAtChunk(coord.cx, coord.cy);
        loaded++;
        progressCallback?.({
          loaded,
          total,
          source: "db",
          cx: coord.cx,
          cy: coord.cy,
        });
      } else if (this._authoritativeChunkFetch !== null) {
        await this._authoritativeChunkFetch(coord.cx, coord.cy);
        if (this.chunks.getChunk(coord) === undefined) {
          throw new Error(
            `Authoritative chunk fetch did not provide (${coord.cx},${coord.cy})`,
          );
        }
        this.invalidateSkyTopStripForChunk(coord.cx);
        this.markWaterNeighborhoodActiveAtChunk(coord.cx, coord.cy);
        loaded++;
        progressCallback?.({
          loaded,
          total,
          source: "db",
          cx: coord.cx,
          cy: coord.cy,
        });
      } else {
        this.chunks.putChunk(this._chunkGen(coord));
        this.invalidateSkyTopStripForChunk(coord.cx);
        this.markWaterNeighborhoodActiveAtChunk(coord.cx, coord.cy);
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
    const affected = new Set<number>();
    for (const { cx, cy } of pending) {
      affected.add(packChunkCoordKey(cx, cy));
      affected.add(packChunkCoordKey(cx - 1, cy));
      affected.add(packChunkCoordKey(cx + 1, cy));
      affected.add(packChunkCoordKey(cx, cy - 1));
      affected.add(packChunkCoordKey(cx, cy + 1));
    }
    const tLight = import.meta.env.DEV ? chunkPerfNow() : 0;
    for (const key of affected) {
      const { cx, cy } = unpackChunkCoordKey(key);
      this._queueLightRecompute(cx, cy, LIGHT_RECOMPUTE_BOTH);
    }
    if (affected.size > 0) {
      await this._drainPendingLightRecomputesWithinFrames(CHUNK_LOAD_LIGHT_MS_PER_FRAME);
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

  private remapStoredBlockId(storedId: number): number {
    const pal = this._blockLoadPalette;
    if (pal === undefined) {
      return storedId;
    }
    const ident = pal[storedId];
    if (ident === undefined || ident.length === 0) {
      return this.airId;
    }
    try {
      return this.registry.getByIdentifier(ident).id;
    } catch {
      return this.airId;
    }
  }

  private chunkFromRecord(record: ChunkRecord): Chunk {
    const coord: ChunkCoord = { cx: record.cx, cy: record.cy };
    const chunk = createChunk(coord);
    const pal = this._blockLoadPalette;
    if (pal === undefined) {
      chunk.blocks.set(record.blocks);
    } else {
      for (let i = 0; i < record.blocks.length; i++) {
        chunk.blocks[i] = this.remapStoredBlockId(record.blocks[i]!);
      }
    }
    chunk.metadata.set(record.metadata);
    const expected = CHUNK_SIZE * CHUNK_SIZE;
    if (
      record.background !== undefined &&
      record.background.length === expected
    ) {
      if (pal === undefined) {
        chunk.background.set(record.background);
      } else {
        for (let i = 0; i < record.background.length; i++) {
          chunk.background[i] = this.remapStoredBlockId(record.background[i]!);
        }
      }
    }
    chunk.skyLight.fill(0);
    chunk.blockLight.fill(0);
    chunk.dirty = true;
    this.indexDoorBottomsFromChunk(chunk);
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

  /** Queue a chunk for deferred light recomputation (deduped, flushed once per tick). */
  private _queueLightRecompute(cx: number, cy: number, mode = LIGHT_RECOMPUTE_BOTH): void {
    if (mode === 0) {
      return;
    }
    const key = packChunkCoordKey(cx, cy);
    const prev = this._pendingLightChunks.get(key) ?? 0;
    this._pendingLightChunks.set(key, prev | mode);
  }

  /** Flush all queued block-changed events to the EventBus. Call once per tick after all mutations. */
  flushPendingBlockChangedEvents(): void {
    if (this._pendingBlockChangedEvents.length === 0 || this.bus === undefined) {
      return;
    }
    for (let i = 0; i < this._pendingBlockChangedEvents.length; i++) {
      this.bus.emit(this._pendingBlockChangedEvents[i]!);
    }
    this._pendingBlockChangedEvents.length = 0;
  }

  /** Flush all pending light recomputes accumulated during the current tick. */
  flushPendingLightRecomputes(): void {
    const pending = this._pendingLightChunks;
    if (pending.size === 0) {
      return;
    }
    const t0 = import.meta.env.DEV ? chunkPerfNow() : 0;
    let processed = 0;
    const queueBefore = pending.size;
    for (const [key, mode] of pending) {
      const { cx, cy } = unpackChunkCoordKey(key);
      this.recomputeChunkLight(cx, cy, mode);
      pending.delete(key);
      processed += 1;
      if (processed >= LIGHT_RECOMPUTE_BUDGET_PER_TICK) {
        break;
      }
    }
    if (import.meta.env.DEV) {
      chunkPerfLog("world:flushPendingLightRecomputes", chunkPerfNow() - t0, {
        processed,
        queueBefore,
        queueAfter: pending.size,
      });
    }
  }

  /**
   * Process the pending light queue until empty, spending at most `msBudget` per slice
   * then yielding a frame (chunk streaming settle — avoids multi‑hundred‑ms main-thread stalls).
   */
  private async _drainPendingLightRecomputesWithinFrames(msBudget: number): Promise<void> {
    const pending = this._pendingLightChunks;
    while (pending.size > 0) {
      const sliceStart =
        typeof performance !== "undefined" && performance.now !== undefined
          ? performance.now()
          : 0;
      while (pending.size > 0) {
        if (
          typeof performance !== "undefined" &&
          performance.now !== undefined &&
          performance.now() - sliceStart >= msBudget
        ) {
          break;
        }
        const iter = pending.keys().next();
        if (iter.done) {
          break;
        }
        const key = iter.value;
        const mode = pending.get(key);
        pending.delete(key);
        if (mode === undefined) {
          continue;
        }
        const { cx, cy } = unpackChunkCoordKey(key);
        this.recomputeChunkLight(cx, cy, mode);
      }
      if (pending.size > 0) {
        await yieldToNextFrame();
      }
    }
  }

  recomputeChunkLight(chunkX: number, chunkY: number, mode = LIGHT_RECOMPUTE_BOTH): void {
    const chunk = this.chunks.getChunk({ cx: chunkX, cy: chunkY });
    if (chunk === undefined) {
      return;
    }

    const t0 = import.meta.env.DEV ? chunkPerfNow() : 0;
    const reader = this._makeReader();
    if ((mode & LIGHT_RECOMPUTE_SKY) !== 0) {
      computeSkyLight(chunkX, chunkY, chunk.skyLight, reader);
    }
    if ((mode & LIGHT_RECOMPUTE_BLOCK) !== 0) {
      computeBlockLight(chunkX, chunkY, chunk.blockLight, reader);
    }
    if (import.meta.env.DEV) {
      chunkPerfLog("world:recomputeChunkLight", chunkPerfNow() - t0, {
        chunkX,
        chunkY,
        mode,
      });
    }

    this.bus?.emit({
      type: "world:light-updated",
      chunkX,
      chunkY,
    });
  }

  /**
   * Apply host-authoritative block data for one chunk (multiplayer). Zeros per-cell metadata when
   * `metadata` is omitted (legacy wire); otherwise copies host flags (e.g. tree no-collision).
   */
  applyAuthoritativeChunk(
    cx: number,
    cy: number,
    blocks: Uint16Array,
    background?: Uint16Array,
    furnaces?: FurnacePersistedChunk[],
    chests?: ChestPersistedChunk[],
    metadata?: Uint8Array,
  ): void {
    this.applyAuthoritativeChunkBatch([
      { cx, cy, blocks, background, furnaces, chests, metadata },
    ]);
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
      furnaces?: FurnacePersistedChunk[];
      chests?: ChestPersistedChunk[];
      metadata?: Uint8Array;
    }>,
  ): void {
    const expected = CHUNK_SIZE * CHUNK_SIZE;
    const applied: ChunkCoord[] = [];
    for (const { cx, cy, blocks, background, furnaces, chests, metadata } of entries) {
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
      this.clearDoorBottomKeysInChunk(cx, cy);
      chunk.blocks.set(blocks);
      if (background !== undefined && background.length === expected) {
        chunk.background.set(background);
      } else {
        chunk.background.fill(0);
      }
      if (metadata !== undefined && metadata.length === expected) {
        chunk.metadata.set(metadata);
      } else {
        chunk.metadata.fill(0);
      }
      chunk.skyLight.fill(0);
      chunk.blockLight.fill(0);
      chunk.dirty = true;
      if (furnaces !== undefined) {
        this.applyFurnaceEntitiesForChunk(cx, cy, furnaces);
      } else {
        this.removeFurnaceTilesInChunk(cx, cy);
      }
      if (chests !== undefined) {
        this.applyChestEntitiesForChunk(cx, cy, chests);
      } else {
        this.removeChestTilesInChunk(cx, cy);
      }
      this.indexDoorBottomsFromChunk(chunk);
      this.markWaterNeighborhoodActiveAtChunk(cx, cy);
      applied.push(coord);
    }
    const affected = new Set<number>();
    for (const { cx, cy } of applied) {
      affected.add(packChunkCoordKey(cx, cy));
      affected.add(packChunkCoordKey(cx - 1, cy));
      affected.add(packChunkCoordKey(cx + 1, cy));
      affected.add(packChunkCoordKey(cx, cy - 1));
      affected.add(packChunkCoordKey(cx, cy + 1));
    }
    for (const key of affected) {
      const { cx, cy } = unpackChunkCoordKey(key);
      this._queueLightRecompute(cx, cy, LIGHT_RECOMPUTE_BOTH);
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
      isSolid: (wx, wy) => this.getSolidById(this.getBlockId(wx, wy)),
      getLightAbsorption: (wx, wy) => {
        const id = this.getBlockId(wx, wy);
        return this.getLightAbsorptionById(id);
      },
      getLightEmission: (wx, wy) => {
        const id = this.getBlockId(wx, wy);
        return this.getLightEmissionById(id);
      },
      getSkyExposureTop: (wx) => this._getSkyExposureTop(wx),
    };
  }

  private getSolidById(id: number): boolean {
    const hit = this._solidById.get(id);
    if (hit !== undefined) {
      return hit;
    }
    const value = this.registry.getById(id).solid;
    this._solidById.set(id, value);
    return value;
  }

  private getLightAbsorptionById(id: number): number {
    const hit = this._lightAbsorptionById.get(id);
    if (hit !== undefined) {
      return hit;
    }
    const value = this.registry.getById(id).lightAbsorption;
    this._lightAbsorptionById.set(id, value);
    return value;
  }

  private getLightEmissionById(id: number): number {
    const hit = this._lightEmissionById.get(id);
    if (hit !== undefined) {
      return hit;
    }
    const value = this.registry.getById(id).lightEmission;
    this._lightEmissionById.set(id, value);
    return value;
  }

  private _getSkyExposureTop(wx: number): number {
    const hit = this._skyTopByWx.get(wx);
    if (hit !== undefined) {
      return hit;
    }
    const cx = Math.floor(wx / CHUNK_SIZE);
    const lx = ((wx % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    const minCy = Math.floor(WORLD_Y_MIN / CHUNK_SIZE);
    const maxCy = Math.floor(WORLD_Y_MAX / CHUNK_SIZE);
    let top = WORLD_Y_MIN;
    for (let cy = maxCy; cy >= minCy; cy--) {
      const chunk = this.chunks.getChunkXY(cx, cy);
      if (chunk === undefined) {
        continue;
      }
      const chunkWorldY0 = cy * CHUNK_SIZE;
      const yStart = Math.min(WORLD_Y_MAX, chunkWorldY0 + CHUNK_SIZE - 1);
      const yEnd = Math.max(WORLD_Y_MIN, chunkWorldY0);
      for (let wy = yStart; wy >= yEnd; wy--) {
        const ly = wy - chunkWorldY0;
        const id = getBlock(chunk, lx, ly);
        if (this.getSolidById(id)) {
          top = wy;
          this._skyTopByWx.set(wx, top);
          return top;
        }
      }
    }
    this._skyTopByWx.set(wx, top);
    return top;
  }

  /** Numeric foreground block id at world cell (air when chunk missing). */
  getForegroundBlockId(wx: number, wy: number): number {
    return this.getBlockId(wx, wy);
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

  /** @internal Set after block registry includes `stratum:furnace`. */
  setFurnaceBlockId(id: number | null): void {
    this._furnaceBlockId = id;
  }

  getFurnaceBlockId(): number | null {
    return this._furnaceBlockId;
  }

  getFurnaceTile(wx: number, wy: number): FurnaceTileState | undefined {
    return this._furnaceTiles.get(furnaceCellKey(wx, wy));
  }

  /** True when the furnace has smelting work (queue or in-progress cook) — drives lit block texture. */
  isFurnaceVisuallyLit(wx: number, wy: number): boolean {
    const st = this.getFurnaceTile(wx, wy);
    if (st === undefined) {
      return false;
    }
    return this.isFurnaceVisuallyLitFromState(st);
  }

  private isFurnaceVisuallyLitFromState(st: FurnaceTileState): boolean {
    return st.queue.length > 0 || st.cookProgressSec > 1e-6;
  }

  /** Iterate known furnace tile states (skips stale keys if the block was replaced). */
  forEachFurnaceTile(
    callback: (wx: number, wy: number, tile: FurnaceTileState) => void,
  ): void {
    if (this._furnaceBlockId === null) {
      return;
    }
    const fid = this._furnaceBlockId;
    for (const [key, tile] of this._furnaceTiles) {
      const parts = key.split(",");
      const wx = Number.parseInt(parts[0] ?? "", 10);
      const wy = Number.parseInt(parts[1] ?? "", 10);
      if (!Number.isFinite(wx) || !Number.isFinite(wy)) {
        continue;
      }
      if (this.getBlock(wx, wy).id !== fid) {
        continue;
      }
      callback(wx, wy, tile);
    }
  }

  setFurnaceTile(wx: number, wy: number, state: FurnaceTileState): void {
    const key = furnaceCellKey(wx, wy);
    const prev = this._furnaceTiles.get(key);
    const prevLit =
      prev !== undefined && this.isFurnaceVisuallyLitFromState(prev);
    const nextLit = this.isFurnaceVisuallyLitFromState(state);
    this._furnaceTiles.set(key, state);
    if (prevLit !== nextLit) {
      this.markForegroundChunkDirtyAtWorldCell(wx, wy);
    }
  }

  removeFurnaceTile(wx: number, wy: number): void {
    this._furnaceTiles.delete(furnaceCellKey(wx, wy));
  }

  /**
   * Spawn drops for furnace buffer (fuel + 10 output slots). Queued smelt jobs are not refunded
   * (ingredients were already consumed at enqueue).
   */
  spawnFurnaceItemDropsAt(wx: number, wy: number): void {
    const st = this._furnaceTiles.get(furnaceCellKey(wx, wy));
    if (st === undefined) {
      return;
    }
    const px = (wx + 0.5) * BLOCK_SIZE;
    const py = (wy + 0.5) * BLOCK_SIZE;
    if (st.fuel !== null && st.fuel.count > 0) {
      this.spawnItem(
        st.fuel.itemId,
        st.fuel.count,
        px,
        py,
        0,
        0,
        st.fuel.damage ?? 0,
      );
    }
    for (const slot of st.outputSlots) {
      if (slot !== null && slot.count > 0) {
        this.spawnItem(
          slot.itemId,
          slot.count,
          px,
          py,
          0,
          0,
          slot.damage ?? 0,
        );
      }
    }
    this.removeFurnaceTile(wx, wy);
  }

  getFurnaceEntitiesForChunk(cx: number, cy: number): FurnacePersistedChunk[] {
    const out: FurnacePersistedChunk[] = [];
    const baseX = cx * CHUNK_SIZE;
    const baseY = cy * CHUNK_SIZE;
    for (const [key, state] of this._furnaceTiles) {
      const parts = key.split(",");
      const wx = Number.parseInt(parts[0] ?? "", 10);
      const wy = Number.parseInt(parts[1] ?? "", 10);
      if (
        !Number.isFinite(wx) ||
        !Number.isFinite(wy) ||
        wx < baseX ||
        wx >= baseX + CHUNK_SIZE ||
        wy < baseY ||
        wy >= baseY + CHUNK_SIZE
      ) {
        continue;
      }
      out.push(furnaceTileToPersisted(wx, wy, state, this.requireItemRegistry()));
    }
    return out;
  }

  applyFurnaceEntitiesForChunk(
    cx: number,
    cy: number,
    entries: FurnacePersistedChunk[],
    migrateLegacyItemIds = false,
  ): void {
    const items = this.requireItemRegistry();
    this.removeFurnaceTilesInChunk(cx, cy);
    for (const raw of entries) {
      let e = normalizeFurnacePersistedChunk(raw as unknown) ?? raw;
      if (migrateLegacyItemIds && this._needsItemIdLayoutMigration) {
        if (this._itemIdLayoutMigrationKind === "legacy") {
          e = migrateFurnacePersistedChunk(e);
        } else if (this._itemIdLayoutMigrationKind === "rev1Minus2") {
          e = migrateFurnacePersistedChunkFromRevision1(e);
        } else if (this._itemIdLayoutMigrationKind === "rev2Plus6") {
          e = migrateFurnacePersistedChunkFromRevision2(e);
        }
      }
      const { wx, wy } = worldXYFromChunkLocal(cx, cy, e.lx, e.ly);
      this._furnaceTiles.set(furnaceCellKey(wx, wy), persistedToFurnaceTile(e, items));
    }
    const chunk = this.chunks.getChunk({ cx, cy });
    if (chunk !== undefined) {
      chunk.dirty = true;
    }
  }

  removeFurnaceTilesInChunk(cx: number, cy: number): void {
    const baseX = cx * CHUNK_SIZE;
    const baseY = cy * CHUNK_SIZE;
    const stale: string[] = [];
    for (const key of this._furnaceTiles.keys()) {
      const parts = key.split(",");
      const wx = Number.parseInt(parts[0] ?? "", 10);
      const wy = Number.parseInt(parts[1] ?? "", 10);
      if (
        !Number.isFinite(wx) ||
        !Number.isFinite(wy) ||
        wx < baseX ||
        wx >= baseX + CHUNK_SIZE ||
        wy < baseY ||
        wy >= baseY + CHUNK_SIZE
      ) {
        continue;
      }
      stale.push(key);
    }
    for (const k of stale) {
      this._furnaceTiles.delete(k);
    }
  }

  /**
   * Host/offline: advance smelting queue / fuel / output buffer.
   * @param simulationChunkKeys If provided, only furnaces in these chunk keys are ticked.
   *        Furnaces outside are skipped this tick (catch-up via `lastProcessedWorldTimeMs` on re-entry).
   */
  tickFurnaces(
    dtSec: number,
    worldTimeMs: number,
    items: ItemRegistry,
    smelting: SmeltingRegistry,
    simulationChunkKeys?: ReadonlySet<string>,
  ): string[] {
    if (this._furnaceBlockId === null) {
      return [];
    }
    const fid = this._furnaceBlockId;
    const changed: string[] = [];
    for (const [key, prev] of [...this._furnaceTiles.entries()]) {
      const parts = key.split(",");
      const wx = Number.parseInt(parts[0] ?? "", 10);
      const wy = Number.parseInt(parts[1] ?? "", 10);
      if (!Number.isFinite(wx) || !Number.isFinite(wy)) {
        this._furnaceTiles.delete(key);
        continue;
      }
      if (this.getBlock(wx, wy).id !== fid) {
        this._furnaceTiles.delete(key);
        continue;
      }
      if (simulationChunkKeys !== undefined) {
        const { cx, cy } = worldToChunk(wx, wy);
        if (!simulationChunkKeys.has(`${cx},${cy}`)) {
          continue;
        }
      }
      const elapsedMs = worldTimeMs - prev.lastProcessedWorldTimeMs;
      const effectiveDt = elapsedMs > 0 ? Math.max(dtSec, elapsedMs / 1000) : dtSec;
      const next = stepFurnaceTile(prev, effectiveDt, worldTimeMs, items, smelting);
      const prevLit = this.isFurnaceVisuallyLitFromState(prev);
      const nextLit = this.isFurnaceVisuallyLitFromState(next);
      if (!furnaceTilesEqual(prev, next)) {
        changed.push(key);
      }
      if (prevLit !== nextLit) {
        this.markForegroundChunkDirtyAtWorldCell(wx, wy);
      }
      this._furnaceTiles.set(key, next);
    }
    return changed;
  }

  applyFurnaceSnapshotWorld(wx: number, wy: number, data: FurnacePersistedChunk): void {
    if (this._furnaceBlockId === null || this.getBlock(wx, wy).id !== this._furnaceBlockId) {
      return;
    }
    const { lx, ly } = worldToLocalBlock(wx, wy);
    if (data.lx !== lx || data.ly !== ly) {
      return;
    }
    const norm = normalizeFurnacePersistedChunk(data as unknown) ?? data;
    const key = furnaceCellKey(wx, wy);
    const prev = this._furnaceTiles.get(key);
    const prevLit =
      prev !== undefined && this.isFurnaceVisuallyLitFromState(prev);
    const nextTile = persistedToFurnaceTile(norm, this.requireItemRegistry());
    const nextLit = this.isFurnaceVisuallyLitFromState(nextTile);
    this._furnaceTiles.set(key, nextTile);
    if (prevLit !== nextLit) {
      this.markForegroundChunkDirtyAtWorldCell(wx, wy);
    }
  }

  setChestBlockId(id: number | null): void {
    this._chestBlockId = id;
  }

  getChestBlockId(): number | null {
    return this._chestBlockId;
  }

  /**
   * Resizes chest storage at the clicked cell’s anchor to 18 or 36 slots to match paired blocks.
   * Safe to call when opening the chest UI (fixes load / merge edge cases).
   */
  syncChestStorageToLayout(wx: number, wy: number): void {
    this.ensureChestTileAt(wx, wy);
  }

  getChestTileAtAnchor(ax: number, ay: number): ChestTileState | undefined {
    return this._chestTiles.get(chestCellKey(ax, ay));
  }

  setChestTileAtAnchor(ax: number, ay: number, state: ChestTileState): void {
    this._chestTiles.set(chestCellKey(ax, ay), state);
  }

  /** Resolve storage anchor for a chest cell (world coords). */
  getChestStorageAnchorForCell(wx: number, wy: number): { ax: number; ay: number } | null {
    if (this._chestBlockId === null || this.getBlockId(wx, wy) !== this._chestBlockId) {
      return null;
    }
    const cid = this._chestBlockId;
    const isChest = (x: number, y: number) => this.getBlockId(x, y) === cid;
    return chestStorageAnchor(wx, wy, isChest);
  }

  destroyChestForPlayerBreak(wx: number, wy: number, dropsLoot: boolean): void {
    if (this._chestBlockId === null) {
      return;
    }
    const cid = this._chestBlockId;
    if (this.getBlockId(wx, wy) !== cid) {
      return;
    }
    const isChest = (x: number, y: number) => this.getBlockId(x, y) === cid;
    const { ax, ay } = chestStorageAnchor(wx, wy, isChest);
    const st = this._chestTiles.get(chestCellKey(ax, ay));
    const px = (ax + 0.5) * BLOCK_SIZE;
    const py = (ay + 0.5) * BLOCK_SIZE;
    if (st !== undefined) {
      for (const slot of st.slots) {
        if (slot !== null && slot.count > 0) {
          this.spawnItem(slot.itemId, slot.count, px, py);
        }
      }
      this._chestTiles.delete(chestCellKey(ax, ay));
    }
    const dbl = chestIsDoubleAtAnchor(ax, ay, isChest);
    if (dropsLoot) {
      this.spawnLootForBrokenBlock(cid, ax, ay);
      if (dbl) {
        this.spawnLootForBrokenBlock(cid, ax + 1, ay);
      }
    }
    const cells: [number, number][] = dbl ? [[ax, ay], [ax + 1, ay]] : [[ax, ay]];
    for (const [cx, cy] of cells) {
      this.setBlockWithoutPlantCascade(cx, cy, 0, { skipChestBreak: true });
    }
    for (const [cx, cy] of cells) {
      this.markChunksDirtyForHorizontalChestNeighbors(cx, cy);
    }
  }

  getChestEntitiesForChunk(cx: number, cy: number): ChestPersistedChunk[] {
    const out: ChestPersistedChunk[] = [];
    const baseX = cx * CHUNK_SIZE;
    const baseY = cy * CHUNK_SIZE;
    for (const [key, state] of this._chestTiles) {
      const parts = key.split(",");
      const wx = Number.parseInt(parts[0] ?? "", 10);
      const wy = Number.parseInt(parts[1] ?? "", 10);
      if (
        !Number.isFinite(wx) ||
        !Number.isFinite(wy) ||
        wx < baseX ||
        wx >= baseX + CHUNK_SIZE ||
        wy < baseY ||
        wy >= baseY + CHUNK_SIZE
      ) {
        continue;
      }
      out.push(chestTileToPersisted(wx, wy, state, this.requireItemRegistry()));
    }
    return out;
  }

  applyChestEntitiesForChunk(
    cx: number,
    cy: number,
    entries: ChestPersistedChunk[],
    migrateLegacyItemIds = false,
  ): void {
    const items = this.requireItemRegistry();
    this.removeChestTilesInChunk(cx, cy);
    for (const raw of entries) {
      let e = normalizeChestPersistedChunk(raw as unknown) ?? raw;
      if (migrateLegacyItemIds && this._needsItemIdLayoutMigration) {
        if (this._itemIdLayoutMigrationKind === "legacy") {
          e = migrateChestPersistedChunk(e);
        } else if (this._itemIdLayoutMigrationKind === "rev1Minus2") {
          e = migrateChestPersistedChunkFromRevision1(e);
        } else if (this._itemIdLayoutMigrationKind === "rev2Plus6") {
          e = migrateChestPersistedChunkFromRevision2(e);
        }
      }
      const { wx, wy } = worldXYFromChunkLocal(cx, cy, e.lx, e.ly);
      this._chestTiles.set(chestCellKey(wx, wy), persistedToChestTile(e, items));
      this.ensureChestTileAt(wx, wy);
    }
  }

  removeChestTilesInChunk(cx: number, cy: number): void {
    const baseX = cx * CHUNK_SIZE;
    const baseY = cy * CHUNK_SIZE;
    const stale: string[] = [];
    for (const key of this._chestTiles.keys()) {
      const parts = key.split(",");
      const wx = Number.parseInt(parts[0] ?? "", 10);
      const wy = Number.parseInt(parts[1] ?? "", 10);
      if (
        !Number.isFinite(wx) ||
        !Number.isFinite(wy) ||
        wx < baseX ||
        wx >= baseX + CHUNK_SIZE ||
        wy < baseY ||
        wy >= baseY + CHUNK_SIZE
      ) {
        continue;
      }
      stale.push(key);
    }
    for (const k of stale) {
      this._chestTiles.delete(k);
    }
  }

  applyChestSnapshotWorld(wx: number, wy: number, data: ChestPersistedChunk): void {
    if (this._chestBlockId === null || this.getBlockId(wx, wy) !== this._chestBlockId) {
      return;
    }
    const { lx, ly } = worldToLocalBlock(wx, wy);
    if (data.lx !== lx || data.ly !== ly) {
      return;
    }
    const norm = normalizeChestPersistedChunk(data as unknown) ?? data;
    this._chestTiles.set(chestCellKey(wx, wy), persistedToChestTile(norm, this.requireItemRegistry()));
    this.ensureChestTileAt(wx, wy);
  }

  private chestMergeContext(): {
    chestBlockId: number;
    getBlockId(x: number, y: number): number;
    getTile(ax: number, ay: number): ChestTileState | undefined;
    setTile(ax: number, ay: number, t: ChestTileState): void;
    deleteTile(ax: number, ay: number): void;
  } {
    if (this._chestBlockId === null) {
      throw new Error("chest merge without block id");
    }
    const cid = this._chestBlockId;
    return {
      chestBlockId: cid,
      getBlockId: (x, y) => this.getBlockId(x, y),
      getTile: (ax, ay) => this._chestTiles.get(chestCellKey(ax, ay)),
      setTile: (ax, ay, t) => this._chestTiles.set(chestCellKey(ax, ay), t),
      deleteTile: (ax, ay) => this._chestTiles.delete(chestCellKey(ax, ay)),
    };
  }

  /**
   * Ensures storage at the pair anchor matches single vs double layout (18 vs 36 slots).
   * Expands with empty slots when paired; shrinks only when extra slots are empty.
   */
  private ensureChestTileAt(wx: number, wy: number): void {
    if (this._chestBlockId === null) {
      return;
    }
    const cid = this._chestBlockId;
    const isChest = (x: number, y: number) => this.getBlockId(x, y) === cid;
    const { ax, ay } = chestStorageAnchor(wx, wy, isChest);
    const k = chestCellKey(ax, ay);
    const dbl = chestIsDoubleAtAnchor(ax, ay, isChest);
    const want = dbl ? CHEST_DOUBLE_SLOTS : CHEST_SINGLE_SLOTS;

    const existing = this._chestTiles.get(k);
    if (existing === undefined) {
      this._chestTiles.set(k, createEmptyChestTile(want));
      return;
    }
    if (existing.slots.length === want) {
      return;
    }
    if (existing.slots.length < want) {
      const pad = want - existing.slots.length;
      this._chestTiles.set(k, {
        slots: [...existing.slots, ...Array.from({ length: pad }, () => null)],
      });
      return;
    }
    const overflow = existing.slots.slice(want);
    const overflowEmpty = overflow.every(
      (s) => s === null || s === undefined || s.count <= 0,
    );
    if (overflowEmpty) {
      this._chestTiles.set(k, { slots: existing.slots.slice(0, want) });
    }
  }

  /** Spill buffer and clear paired chest cell(s) except (wx,wy); caller then writes (wx,wy). */
  private breakChestBeforeBlockChange(wx: number, wy: number): void {
    if (this._chestBlockId === null) {
      return;
    }
    const cid = this._chestBlockId;
    if (this.getBlockId(wx, wy) !== cid) {
      return;
    }
    const isChest = (x: number, y: number) => this.getBlockId(x, y) === cid;
    const { ax, ay } = chestStorageAnchor(wx, wy, isChest);
    const k = chestCellKey(ax, ay);
    const st = this._chestTiles.get(k);
    const px = (ax + 0.5) * BLOCK_SIZE;
    const py = (ay + 0.5) * BLOCK_SIZE;
    if (st !== undefined) {
      for (const slot of st.slots) {
        if (slot !== null && slot.count > 0) {
          this.spawnItem(slot.itemId, slot.count, px, py);
        }
      }
      this._chestTiles.delete(k);
    }
    const dbl = chestIsDoubleAtAnchor(ax, ay, isChest);
    const cells: [number, number][] = dbl ? [[ax, ay], [ax + 1, ay]] : [[ax, ay]];
    for (const [cx, cy] of cells) {
      if (cx === wx && cy === wy) {
        continue;
      }
      if (this.getBlockId(cx, cy) === cid) {
        this.setBlockWithoutPlantCascade(cx, cy, 0, { skipChestBreak: true });
      }
    }
    for (const [cx, cy] of cells) {
      if (!(cx === wx && cy === wy)) {
        this.markChunksDirtyForHorizontalChestNeighbors(cx, cy);
      }
    }
  }

  private markChunksDirtyForHorizontalChestNeighbors(wx: number, wy: number): void {
    const { cx, cy } = worldToChunk(wx, wy);
    for (const dcx of [-1, 0, 1]) {
      const ch = this.chunks.getChunk({ cx: cx + dcx, cy });
      if (ch !== undefined) {
        ch.dirty = true;
      }
    }
  }

  private syncFurnaceTileAfterBlockChange(wx: number, wy: number, blockId: number): void {
    const fid = this._furnaceBlockId;
    if (fid === null) {
      return;
    }
    const k = furnaceCellKey(wx, wy);
    if (blockId === fid) {
      if (!this._furnaceTiles.has(k)) {
        this._furnaceTiles.set(k, createEmptyFurnaceTileState(0));
      }
    } else {
      this._furnaceTiles.delete(k);
    }
  }

  /** @internal Used by Game; prefer high-level API elsewhere. */
  getChunkManager(): ChunkManager {
    return this.chunks;
  }

  /**
   * Hysteresis-adjusted stream centre used for chunk loading and render culling.
   * Null before {@link init} completes.
   */
  getStreamCentre(): { cx: number; cy: number } | null {
    if (this.streamCentreCx === null || this.streamCentreCy === null) {
      return null;
    }
    return { cx: this.streamCentreCx, cy: this.streamCentreCy };
  }

  /** @internal Used by Game/EntityManager to animate remote peers. */
  updateRemotePlayers(dt: number): void {
    const nowMs = performance.now();
    for (const [peerId, player] of this.remotePlayers) {
      player.stepFixed(dt);
      const bus = this.bus;
      if (bus === undefined) {
        continue;
      }
      const disp = player.getDisplayPose(nowMs);
      const vx = disp.vx;
      const vy = disp.vy;
      const onGround = Math.abs(vy) <= PLAYER_REMOTE_AIR_VY_THRESHOLD;
      let acc = this.remoteGroundKickAccum.get(peerId) ?? 0;
      if (!onGround || Math.abs(vx) <= 10) {
        acc = 0;
      } else {
        acc += dt;
        if (acc >= STEP_INTERVAL) {
          acc = 0;
          const bx = Math.floor(disp.x / BLOCK_SIZE);
          const by = Math.floor(disp.y / BLOCK_SIZE) - 1;
          const block = this.getBlock(bx, by);
          if (!block.water && block.id !== this.airId) {
            bus.emit({
              type: "entity:ground-kick",
              feetWorldX: disp.x,
              feetWorldY: disp.y,
              velocityX: vx,
              blockId: block.id,
            } satisfies GameEvent);
          }
        }
      }
      this.remoteGroundKickAccum.set(peerId, acc);
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
    hotbarSlot: number,
    heldItemId: number,
    miningVisualFromNetwork: boolean,
    armorHelmetId = 0,
    armorChestId = 0,
    armorLeggingsId = 0,
    armorBootsId = 0,
    bowDrawQuantized = 0,
    aimDisplayX = 0,
    aimDisplayY = 0,
  ): void {
    const existing = this.remotePlayers.get(peerId);
    if (existing === undefined) {
      const created = new RemotePlayer(x, y, facingRight, vx, vy);
      created.hotbarSlot = hotbarSlot;
      created.heldItemId = heldItemId;
      created.miningVisualFromNetwork = miningVisualFromNetwork;
      created.armorHelmetId = armorHelmetId;
      created.armorChestId = armorChestId;
      created.armorLeggingsId = armorLeggingsId;
      created.armorBootsId = armorBootsId;
      created.bowDrawQuantized = bowDrawQuantized;
      created.aimDisplayX = aimDisplayX;
      created.aimDisplayY = aimDisplayY;
      this.remotePlayers.set(peerId, created);
    } else {
      existing.setTarget(
        x,
        y,
        vx,
        vy,
        facingRight,
        hotbarSlot,
        heldItemId,
        miningVisualFromNetwork,
        armorHelmetId,
        armorChestId,
        armorLeggingsId,
        armorBootsId,
        bowDrawQuantized,
        aimDisplayX,
        aimDisplayY,
      );
    }
  }

  /**
   * Sync another peer’s mining crack overlay. Creates a minimal {@link RemotePlayer} if we have
   * not yet received pose for that peer.
   */
  updateRemotePlayerBreakFromNetwork(
    peerId: string,
    crackStageEncoded: number,
    wx: number,
    wy: number,
    layerWire: 0 | 1,
  ): void {
    let existing = this.remotePlayers.get(peerId);
    if (existing === undefined) {
      existing = new RemotePlayer(0, 0, true, 0, 0);
      this.remotePlayers.set(peerId, existing);
    }
    existing.setBreakMiningFromNetwork(crackStageEncoded, wx, wy, layerWire);
  }

  /** When a block is placed or broken authoritatively, drop matching remote crack overlays. */
  clearRemoteBreakMiningAtWorldCell(
    wx: number,
    wy: number,
    layer: "fg" | "bg",
  ): void {
    for (const rp of this.remotePlayers.values()) {
      rp.clearBreakMiningIfCell(wx, wy, layer);
    }
  }

  /** @internal Used by Game on net:peer-left. */
  removeRemotePlayer(peerId: string): void {
    this.remotePlayers.delete(peerId);
    this.remoteGroundKickAccum.delete(peerId);
  }

  /** Remove every networked peer (e.g. host disabled multiplayer). */
  clearRemotePlayers(): void {
    this.remotePlayers.clear();
    this.remoteGroundKickAccum.clear();
  }

  /** @internal Used by EntityManager for rendering. */
  getRemotePlayers(): ReadonlyMap<string, RemotePlayer> {
    return this.remotePlayers;
  }

}
