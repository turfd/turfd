/** Deterministic chunk fill: terrain columns, caves, ores, bedrock. */
import {
  CHUNK_SIZE,
  LAKE_BIOME_TREE_SUPPRESS_INFLUENCE,
  WATER_SEA_LEVEL_WY,
  WORLD_Y_MIN,
  WORLDGEN_NO_COLLIDE,
} from "../../core/constants";
import type { WorldGenType } from "../../core/types";
import type { BlockRegistry } from "../blocks/BlockRegistry";
import { chunkToWorldOrigin, localIndex } from "../chunk/ChunkCoord";
import type { ChunkCoord } from "../chunk/ChunkCoord";
import { createChunk, type Chunk } from "../chunk/Chunk";
import { GeneratorContext } from "./GeneratorContext";
import { TerrainNoise, type ForestType } from "../../core/TerrainNoise";
import { CaveGenerator } from "./CaveGenerator";
import { GraniteVeins } from "./GraniteVeins";
import { OreVeins } from "./OreVeins";
import { SedimentPockets } from "./SedimentPockets";
import { forEachDeciduousBushCell, forEachSpruceBushCell } from "./treeCanopy";
import {
  applySeaLevelFloodWater,
  applySeaLevelFloodWaterRegion,
} from "./SeaLevelWaterFill";
import type { ParsedStructure } from "../structure/structureSchema";
import type { StructureFeatureEntry } from "../structure/StructureRegistry";

/**
 * Surface Y for `"flat"` worlds (grass row). Sits comfortably above
 * {@link WATER_SEA_LEVEL_WY} so sea-level flood never touches the ground.
 */
const FLAT_WORLD_SURFACE_Y = 4;
/** Number of dirt rows below the grass cap on flat worlds. */
const FLAT_WORLD_DIRT_DEPTH = 3;
export type GeneratedStructureEntity =
  | {
      type: "container";
      wx: number;
      wy: number;
      lootTable?: string;
      items?: Array<{ key: string; count: number; damage?: number } | null>;
    }
  | {
      type: "furnace";
      wx: number;
      wy: number;
      state: unknown;
    }
  | {
      type: "spawner";
      wx: number;
      wy: number;
      state: unknown;
    };

type StructurePlacementResolution = {
  featureIndex: number;
  structure: ParsedStructure;
  originX: number;
  originY: number;
};

// ---------------------------------------------------------------------------
// Oak tree shapes (round-ish canopy)
// ---------------------------------------------------------------------------

type SingleTreeSpec = {
  trunkHeight: number;
  canopyCenterDy: number;
  radiusX: number;
  radiusY: number;
};

type TwinForkSpec = {
  baseTrunkH: number;
  canopyCenterDy: number;
  radiusX: number;
  radiusY: number;
};

type OakTreeShape =
  | { kind: "single"; spec: SingleTreeSpec }
  | { kind: "twinFork"; spec: TwinForkSpec };

const OAK_SINGLE_VARIANTS: readonly SingleTreeSpec[] = [
  { trunkHeight: 3, canopyCenterDy: 4, radiusX: 2, radiusY: 2 },
  { trunkHeight: 4, canopyCenterDy: 5, radiusX: 2, radiusY: 3 },
  { trunkHeight: 4, canopyCenterDy: 5, radiusX: 3, radiusY: 2 },
] as const;

const OAK_TWIN_FORK_SPEC: TwinForkSpec = {
  baseTrunkH: 3,
  canopyCenterDy: 6,
  radiusX: 3,
  radiusY: 3,
} as const;

// ---------------------------------------------------------------------------
// Spruce tree shapes (tall conical canopy)
// ---------------------------------------------------------------------------

/**
 * Spruce tree spec (Terraria-style conifer). `canopyLayers` is top→bottom; each
 * width usually repeats for two rows for a clean stepped cone.
 *
 * The trunk is placed *after* leaves, from `surfaceY + 1` through
 * `surfaceY + canopyStartDy + canopyLayers.length - 1` (inclusive of the
 * top-of-tree row), so the log column is visible all the way through the crown
 * in the same way as a classic Minecraft-style spruce.
 */
type SpruceTreeSpec = {
  /** Canopy layers from top (narrow) to bottom (wide). Each value = half-width at that row. */
  canopyLayers: readonly number[];
  /**
   * How many blocks *above* the surface the bottom (widest) canopy row starts.
   * (First log above surface is `dy === 1`.)
   */
  canopyStartDy: number;
};

const SPRUCE_VARIANTS: readonly SpruceTreeSpec[] = [
  // Small — canopy 9 wide × 9 tall, ~2 blocks of exposed trunk below.
  {
    canopyLayers: [0, 1, 1, 2, 2, 3, 3, 4, 4],
    canopyStartDy: 3,
  },
  // Medium — canopy 11 wide × 13 tall, ~3 blocks of exposed trunk.
  {
    canopyLayers: [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 5],
    canopyStartDy: 4,
  },
  // Large — canopy 13 wide × 16 tall, ~4 blocks of exposed trunk.
  {
    canopyLayers: [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 5, 6, 6, 6],
    canopyStartDy: 5,
  },
] as const;

/** Birch: taller trunk; avoid radiusY 1 (reads as a flat cap on the grid). */
const BIRCH_SINGLE_VARIANTS: readonly SingleTreeSpec[] = [
  { trunkHeight: 5, canopyCenterDy: 6, radiusX: 2, radiusY: 2 },
  { trunkHeight: 6, canopyCenterDy: 7, radiusX: 2, radiusY: 2 },
  { trunkHeight: 5, canopyCenterDy: 6, radiusX: 2, radiusY: 3 },
] as const;

type TreeShape =
  | { type: "oak"; shape: OakTreeShape }
  | { type: "birch"; spec: SingleTreeSpec }
  | { type: "spruce"; spec: SpruceTreeSpec };

const TREE_PADDING_BLOCKS = 10;
/** Keep one of every N structure torches (deterministic by world cell). */
const STRUCTURE_TORCH_KEEP_PERIOD = 2;

const CARDINAL_NEIGHBOR_OFFSETS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

const HORIZONTAL_NEIGHBOR_DX = [-1, 1] as const;

export class WorldGenerator {
  private readonly blockRegistry: BlockRegistry;
  private readonly genType: WorldGenType;
  private readonly terrain: TerrainNoise;
  private readonly caves: CaveGenerator;
  private readonly ores: OreVeins;
  private readonly sediment: SedimentPockets;
  private readonly granite: GraniteVeins;
  private readonly airId: number;
  private readonly grassId: number;
  private readonly dirtId: number;
  private readonly stoneId: number;
  private readonly bedrockId: number;
  private readonly oakLogId: number;
  private readonly spruceLogId: number;
  private readonly oakLeavesId: number;
  private readonly spruceLeavesId: number;
  private readonly birchLogId: number;
  private readonly birchLeavesId: number;
  private readonly shortGrassId: number;
  private readonly tallGrassBottomId: number;
  private readonly tallGrassTopId: number;
  private readonly dandelionId: number;
  private readonly poppyId: number;
  private readonly sandId: number;
  private readonly sandstoneId: number;
  private readonly cactusId: number;
  private readonly sugarCaneId: number;
  private readonly deadBushId: number;
  private readonly waterId: number | null;
  private readonly torchId: number | null;
  private _structureFeatures: Array<{
    identifier: string;
    structures: ParsedStructure[];
    placement: StructureFeatureEntry["placement"];
  }> = [];

  constructor(seed: number, registry: BlockRegistry, genType: WorldGenType = "normal") {
    this.blockRegistry = registry;
    this.genType = genType;
    const root = new GeneratorContext(seed);
    this.terrain = new TerrainNoise(seed);
    this.caves = new CaveGenerator(root.fork(0xca_57));
    this.ores = new OreVeins(root.fork(0x0e5), registry);
    this.sediment = new SedimentPockets(root.fork(0x5ed1_000), registry);
    this.granite = new GraniteVeins(root.fork(0x6a32), registry);
    this.airId = registry.getByIdentifier("stratum:air").id;
    this.grassId = registry.getByIdentifier("stratum:grass").id;
    this.dirtId = registry.getByIdentifier("stratum:dirt").id;
    this.stoneId = registry.getByIdentifier("stratum:stone").id;
    this.bedrockId = registry.getByIdentifier("stratum:bedrock").id;
    this.oakLogId = registry.getByIdentifier("stratum:oak_log").id;
    this.spruceLogId = registry.getByIdentifier("stratum:spruce_log").id;
    this.oakLeavesId = registry.getByIdentifier("stratum:oak_leaves").id;
    this.spruceLeavesId = registry.getByIdentifier("stratum:spruce_leaves").id;
    this.birchLogId = registry.getByIdentifier("stratum:birch_log").id;
    this.birchLeavesId = registry.getByIdentifier("stratum:birch_leaves").id;
    this.shortGrassId = registry.getByIdentifier("stratum:short_grass").id;
    this.tallGrassBottomId = registry.getByIdentifier("stratum:tall_grass_bottom").id;
    this.tallGrassTopId = registry.getByIdentifier("stratum:tall_grass_top").id;
    this.dandelionId = registry.getByIdentifier("stratum:dandelion").id;
    this.poppyId = registry.getByIdentifier("stratum:poppy").id;
    this.sandId = registry.getByIdentifier("stratum:sand").id;
    this.sandstoneId = registry.getByIdentifier("stratum:sandstone").id;
    this.cactusId = registry.getByIdentifier("stratum:cactus").id;
    this.sugarCaneId = registry.getByIdentifier("stratum:sugar_cane").id;
    this.deadBushId = registry.getByIdentifier("stratum:dead_bush").id;
    this.waterId = registry.isRegistered("stratum:water")
      ? registry.getByIdentifier("stratum:water").id
      : null;
    this.torchId = registry.isRegistered("stratum:torch")
      ? registry.getByIdentifier("stratum:torch").id
      : null;
  }

  setStructureFeatures(
    features: Array<{
      identifier: string;
      structures: ParsedStructure[];
      placement: StructureFeatureEntry["placement"];
    }>,
  ): void {
    this._structureFeatures = [...features];
  }

  getSurfaceHeight(wx: number): number {
    if (this.genType === "flat") {
      return FLAT_WORLD_SURFACE_Y;
    }
    return this.terrain.getSurfaceHeight(wx);
  }

  /** Same desert mask as surface sand/cacti (column `wx`). */
  isDesertColumn(wx: number): boolean {
    if (this.genType === "flat") {
      return false;
    }
    return this.terrain.isDesert(wx);
  }

  /**
   * Terrain columns, caves, ores, backdrop — no sea fill, trees, or surface decor.
   * Pair with {@link applySeaLevelFloodToChunkRegion} + {@link decorateChunkSurface} for multi-chunk strips.
   */
  generateChunkTerrainOnly(coord: ChunkCoord): Chunk {
    const chunk = createChunk(coord);
    const origin = chunkToWorldOrigin(coord);

    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      const wx = origin.wx + lx;
      const surfaceY = this.getSurfaceHeight(wx);

      for (let ly = 0; ly < CHUNK_SIZE; ly++) {
        const wy = origin.wy + ly;
        const idx = localIndex(lx, ly);
        chunk.blocks[idx] = this.pickBlock(wx, wy, surfaceY);
        chunk.background[idx] = this.naturalBackdropId(wx, wy, surfaceY);
      }
    }
    return chunk;
  }

  /** Trees, flowers, desert plants — run after water placement. */
  decorateChunkSurface(chunk: Chunk, originWx: number, originWy: number): void {
    if (this.genType === "flat") {
      // Flat worlds intentionally skip vegetation/trees for a clean superflat slate.
      chunk.dirty = true;
      chunk.renderDirty = true;
      return;
    }
    this.placeBackgroundTrees(chunk, originWx, originWy);
    this.decorateSurfaceVegetation(chunk, originWx, originWy);
    this.decorateWaterEdgeSugarCane(chunk, originWx, originWy);
    this.decorateDesertSurface(chunk, originWx, originWy);
    chunk.dirty = true;
    chunk.renderDirty = true;
  }

  /** Sugar cane: 1–3 tall, only on sand/grass/dirt, only when adjacent to water. */
  private decorateWaterEdgeSugarCane(chunk: Chunk, originWx: number, originWy: number): void {
    if (this.waterId === null) {
      return;
    }
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      const wx = originWx + lx;
      const surfaceY = this.terrain.getSurfaceHeight(wx);
      const ly = surfaceY - originWy;
      if (ly < 0 || ly >= CHUNK_SIZE) {
        continue;
      }
      const baseIdx = localIndex(lx, ly);
      const baseId = chunk.blocks[baseIdx]!;
      const baseOk =
        baseId === this.sandId || baseId === this.grassId || baseId === this.dirtId;
      if (!baseOk) {
        continue;
      }
      if (ly + 1 >= CHUNK_SIZE) {
        continue;
      }
      const plantIdx = localIndex(lx, ly + 1);
      if (chunk.blocks[plantIdx] !== this.airId) {
        continue;
      }
      if (!this.soilTouchesWaterForSugarCane(chunk, lx, ly)) {
        continue;
      }

      const wy = surfaceY;
      const h = this.hash2(wx * 599 + 11, wy * 283 + 7);
      if (h % 1000 >= 220) {
        continue;
      }
      const height = 1 + ((h >>> 10) % 3);
      let ok = true;
      for (let k = 1; k <= height; k++) {
        if (ly + k >= CHUNK_SIZE) {
          ok = false;
          break;
        }
        if (chunk.blocks[localIndex(lx, ly + k)] !== this.airId) {
          ok = false;
          break;
        }
      }
      if (!ok) {
        continue;
      }
      for (let k = 1; k <= height; k++) {
        chunk.blocks[localIndex(lx, ly + k)] = this.sugarCaneId;
      }
    }
  }

  /**
   * Sea / lake flood across many chunks (same rules as per-chunk {@link applySeaLevelFloodWater},
   * but air connects across chunk borders).
   */
  applySeaLevelFloodToChunkRegion(
    chunkMap: Map<string, Chunk>,
    bounds: {
      minCx: number;
      maxCx: number;
      minCy: number;
      maxCy: number;
    },
  ): void {
    if (this.waterId === null || this.genType === "flat") {
      return;
    }
    applySeaLevelFloodWaterRegion(chunkMap, bounds, {
      registry: this.blockRegistry,
      airId: this.airId,
      waterId: this.waterId,
      grassId: this.grassId,
      sandId: this.sandId,
      dirtId: this.dirtId,
      seaLevelWy: WATER_SEA_LEVEL_WY,
      getSurfaceHeight: (wx) => this.terrain.getSurfaceHeight(wx),
      shouldPlaceWater: (wx) => !this.terrain.isDesert(wx),
    });
  }

  generateChunk(coord: ChunkCoord): Chunk {
    const chunk = this.generateChunkTerrainOnly(coord);
    const origin = chunkToWorldOrigin(coord);
    if (this.waterId !== null && this.genType !== "flat") {
      applySeaLevelFloodWater(chunk, origin.wx, origin.wy, {
        registry: this.blockRegistry,
        airId: this.airId,
        waterId: this.waterId,
        grassId: this.grassId,
        sandId: this.sandId,
        dirtId: this.dirtId,
        seaLevelWy: WATER_SEA_LEVEL_WY,
        getSurfaceHeight: (wx) => this.terrain.getSurfaceHeight(wx),
        shouldPlaceWater: (wx) => !this.terrain.isDesert(wx),
      });
    }
    this.decorateChunkSurface(chunk, origin.wx, origin.wy);
    if (this.genType !== "flat") {
      this.applyStructureFeatures(chunk, origin.wx, origin.wy);
    }
    return chunk;
  }

  private naturalBackdropId(wx: number, wy: number, surfaceY: number): number {
    if (wy > surfaceY) {
      return 0;
    }
    if (this.genType === "flat") {
      return this.flatBlockId(wy, surfaceY);
    }
    const topsoilDepth = this.topsoilDepth(wx);
    if (wy > surfaceY - topsoilDepth) {
      return this.topsoilBlockId(wx, wy, surfaceY);
    }
    if (wy === WORLD_Y_MIN) {
      return this.stoneId;
    }
    const backdropOre = this.ores.getOreAt(wx, wy, surfaceY);
    if (backdropOre !== null) {
      return backdropOre;
    }
    const backdropFill = this.sediment.getBackdropFill(wx, wy);
    return this.granite.applyToStoneFill(wx, wy, surfaceY, backdropFill);
  }

  /** Grass-topped columns: short/tall grass and flowers in air above (after trees). */
  private decorateSurfaceVegetation(chunk: Chunk, originWx: number, originWy: number): void {
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      for (let ly = 0; ly < CHUNK_SIZE; ly++) {
        const idx = localIndex(lx, ly);
        if (chunk.blocks[idx] !== this.grassId) {
          continue;
        }
        if (ly + 1 >= CHUNK_SIZE) {
          continue;
        }
        const aboveIdx = localIndex(lx, ly + 1);
        if (chunk.blocks[aboveIdx] !== this.airId) {
          continue;
        }
        if (this.foregroundTouchesWaterCardinal(chunk, lx, ly + 1)) {
          continue;
        }
        const wx = originWx + lx;
        const wy = originWy + ly;
        const h = this.hash2(wx * 131 + 17, wy * 91 + 9);
        const r = h % 1000;
        /* Short/tall grass bands widened (~28% / ~10% of grass tiles) vs older 18%/7%. */
        if (r < 280) {
          chunk.blocks[aboveIdx] = this.shortGrassId;
        } else if (r < 380 && ly + 2 < CHUNK_SIZE) {
          const above2Idx = localIndex(lx, ly + 2);
          if (chunk.blocks[above2Idx] === this.airId) {
            chunk.blocks[aboveIdx] = this.tallGrassBottomId;
            chunk.blocks[above2Idx] = this.tallGrassTopId;
          }
        } else if (r < 430) {
          chunk.blocks[aboveIdx] = this.dandelionId;
        } else if (r < 470) {
          chunk.blocks[aboveIdx] = this.poppyId;
        }
      }
    }
  }

  /** In-chunk ±X neighbors: solid non-replaceable blocks invalidate cactus (matches player rules at edges). */
  private horizontalNeighborSolidForCactus(chunk: Chunk, lx: number, ly: number): boolean {
    for (const dlx of HORIZONTAL_NEIGHBOR_DX) {
      const nx = lx + dlx;
      if (nx < 0 || nx >= CHUNK_SIZE) {
        continue;
      }
      const nid = chunk.blocks[localIndex(nx, ly)]!;
      if (nid === this.airId) {
        continue;
      }
      const def = this.blockRegistry.getById(nid);
      if (def.solid && !def.replaceable) {
        return true;
      }
    }
    return false;
  }

  /** Sparse cacti and dead bushes on desert surface sand (same chunk only for cactus stacks). */
  private decorateDesertSurface(chunk: Chunk, originWx: number, originWy: number): void {
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      const wx = originWx + lx;
      if (!this.terrain.isDesert(wx)) {
        continue;
      }
      const surfaceY = this.terrain.getSurfaceHeight(wx);
      const ly = surfaceY - originWy;
      if (ly < 0 || ly >= CHUNK_SIZE) {
        continue;
      }
      const wy = surfaceY;
      const idx = localIndex(lx, ly);
      if (chunk.blocks[idx] !== this.sandId) {
        continue;
      }
      if (ly + 1 >= CHUNK_SIZE) {
        continue;
      }
      const aboveIdx = localIndex(lx, ly + 1);
      if (chunk.blocks[aboveIdx] !== this.airId) {
        continue;
      }
      if (this.foregroundTouchesWaterCardinal(chunk, lx, ly + 1)) {
        continue;
      }
      const h = this.hash2(wx * 401 + 3, wy * 307 + 19);
      if (h % 1000 >= 160) {
        continue;
      }
      const h2 = this.hash2(wx * 811 + 1, wy * 503 + 29);
      if (h2 % 10 < 5) {
        const height = 2 + ((h2 >>> 8) % 3);
        let ok = true;
        for (let k = 1; k <= height; k++) {
          if (ly + k >= CHUNK_SIZE) {
            ok = false;
            break;
          }
          if (chunk.blocks[localIndex(lx, ly + k)] !== this.airId) {
            ok = false;
            break;
          }
          if (this.horizontalNeighborSolidForCactus(chunk, lx, ly + k)) {
            ok = false;
            break;
          }
          if (this.foregroundTouchesWaterCardinal(chunk, lx, ly + k)) {
            ok = false;
            break;
          }
        }
        if (!ok) {
          continue;
        }
        for (let k = 1; k <= height; k++) {
          chunk.blocks[localIndex(lx, ly + k)] = this.cactusId;
        }
      } else {
        chunk.blocks[aboveIdx] = this.deadBushId;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Tree placement
  // -------------------------------------------------------------------------

  private placeBackgroundTrees(chunk: Chunk, originWx: number, originWy: number): void {
    const startWx = originWx - TREE_PADDING_BLOCKS;
    const endWx = originWx + CHUNK_SIZE + TREE_PADDING_BLOCKS;
    for (let anchorWx = startWx; anchorWx < endWx; anchorWx++) {
      const surfaceY = this.terrain.getSurfaceHeight(anchorWx);
      const density = this.terrain.getForestDensity(anchorWx);
      if (!this.shouldSpawnTreeAt(anchorWx, surfaceY, density)) {
        continue;
      }
      const forestType = this.terrain.getForestType(anchorWx);
      const shape = this.pickTreeShape(anchorWx, surfaceY, density, forestType);
      this.placeTreeShapeIntoChunk(chunk, originWx, originWy, anchorWx, surfaceY, shape);
    }
  }

  private placeTreeShapeIntoChunk(
    chunk: Chunk,
    originWx: number,
    originWy: number,
    anchorWx: number,
    surfaceY: number,
    shape: TreeShape,
  ): void {
    if (this.treeFootprintIntersectsWater(anchorWx)) {
      return;
    }
    const plantedY = this.resolvePlantedSurfaceY(anchorWx, surfaceY, shape);
    if (plantedY === null) {
      return;
    }
    surfaceY = plantedY;
    if (shape.type === "spruce") {
      this.placeSpruceTree(chunk, originWx, originWy, anchorWx, surfaceY, shape.spec);
      return;
    }

    if (shape.type === "birch") {
      const s = shape.spec;
      this.placeSymmetricCanopy(
        chunk,
        originWx,
        originWy,
        anchorWx,
        surfaceY + s.canopyCenterDy,
        s.radiusX,
        s.radiusY,
        this.birchLeavesId,
      );
      for (let dy = 1; dy <= s.trunkHeight; dy++) {
        this.placeTrunkCell(chunk, originWx, originWy, anchorWx, surfaceY + dy, this.birchLogId);
      }
      return;
    }

    const oakShape = shape.shape;
    const trunkId = this.oakLogId;

    if (oakShape.kind === "single") {
      this.placeSymmetricCanopy(
        chunk,
        originWx,
        originWy,
        anchorWx,
        surfaceY + oakShape.spec.canopyCenterDy,
        oakShape.spec.radiusX,
        oakShape.spec.radiusY,
        this.oakLeavesId,
      );
      for (let dy = 1; dy <= oakShape.spec.trunkHeight; dy++) {
        this.placeTrunkCell(chunk, originWx, originWy, anchorWx, surfaceY + dy, trunkId);
      }
      return;
    }

    const s = oakShape.spec;
    const canopyCx = anchorWx + 1;
    const canopyCy = surfaceY + s.canopyCenterDy;
    this.placeSymmetricCanopy(
      chunk,
      originWx,
      originWy,
      canopyCx,
      canopyCy,
      s.radiusX,
      s.radiusY,
      this.oakLeavesId,
    );

    for (let dy = 1; dy <= s.baseTrunkH; dy++) {
      this.placeTrunkCell(chunk, originWx, originWy, anchorWx, surfaceY + dy, trunkId);
      this.placeTrunkCell(chunk, originWx, originWy, anchorWx + 1, surfaceY + dy, trunkId);
    }
    const forkY = surfaceY + s.baseTrunkH + 1;
    this.placeTrunkCell(chunk, originWx, originWy, anchorWx - 1, forkY, trunkId);
    this.placeTrunkCell(chunk, originWx, originWy, anchorWx + 2, forkY, trunkId);
  }

  /**
   * World Y of the block the tree should grow from (grass/sand), after flood/shore passes.
   * Noise surface can sit above the real top soil when water filled the column above the bed
   * (trunk cells skip water → floating logs). Twin oaks use the lower of the two columns when both resolve.
   */
  private resolvePlantedSurfaceY(anchorWx: number, nominalSurfaceY: number, shape: TreeShape): number {
    const sy0 = nominalSurfaceY;
    const twinFork = shape.type === "oak" && shape.shape.kind === "twinFork";
    if (!twinFork) {
      return sy0;
    }
    const sy1 = this.terrain.getSurfaceHeight(anchorWx + 1);
    return Math.min(sy0, sy1);
  }

  // -------------------------------------------------------------------------
  // Spruce tree placement (conical canopy)
  // -------------------------------------------------------------------------

  private placeSpruceTree(
    chunk: Chunk,
    originWx: number,
    originWy: number,
    anchorWx: number,
    surfaceY: number,
    spec: SpruceTreeSpec,
  ): void {
    const trunkId = this.spruceLogId;
    const layers = spec.canopyLayers;
    const canopyBottom = surfaceY + spec.canopyStartDy;

    forEachSpruceBushCell(anchorWx, canopyBottom, layers, (wx, wy) => {
      this.placeBackgroundCell(chunk, originWx, originWy, wx, wy, this.spruceLeavesId);
    });

    // Trunk: full column through the lower trunk and the canopy, ending at the tip
    // row. Placed after leaves so it overwrites the centre of each crown layer.
    const trunkTopDy = spec.canopyStartDy + layers.length - 1;
    for (let dy = 1; dy <= trunkTopDy; dy++) {
      this.placeTrunkCell(chunk, originWx, originWy, anchorWx, surfaceY + dy, trunkId);
    }
  }

  // -------------------------------------------------------------------------
  // Canopy / trunk primitives
  // -------------------------------------------------------------------------

  /** Rounded deciduous crown (oak/birch); bushier than a plain grid ellipse. */
  private placeSymmetricCanopy(
    chunk: Chunk,
    originWx: number,
    originWy: number,
    canopyCx: number,
    canopyCy: number,
    radiusX: number,
    radiusY: number,
    leavesId: number,
  ): void {
    forEachDeciduousBushCell(canopyCx, canopyCy, radiusX, radiusY, (wx, wy) => {
      this.placeBackgroundCell(chunk, originWx, originWy, wx, wy, leavesId);
    });
  }

  /**
   * Skip the whole tree if any in-chunk cell in a broad footprint (trunk + canopy + shoreline)
   * is water — avoids trunks through pools, roots on water, and floating crowns over lakes.
   */
  private treeFootprintIntersectsWater(anchorWx: number): boolean {
    if (this.waterId === null) {
      return false;
    }
    const padX = 12;
    let minSurf = this.terrain.getSurfaceHeight(anchorWx);
    for (let wx = anchorWx - padX; wx <= anchorWx + padX; wx++) {
      const s = this.terrain.getSurfaceHeight(wx);
      if (s < minSurf) {
        minSurf = s;
      }
      if (s < WATER_SEA_LEVEL_WY && !this.terrain.isDesert(wx)) {
        return true;
      }
    }
    return false;
  }

  private foregroundTouchesWaterCardinal(
    chunk: Chunk,
    lx: number,
    ly: number,
  ): boolean {
    if (this.waterId === null) {
      return false;
    }
    const wid = this.waterId;
    for (const [dx, dy] of CARDINAL_NEIGHBOR_OFFSETS) {
      const nx = lx + dx;
      const ny = ly + dy;
      if (nx < 0 || nx >= CHUNK_SIZE || ny < 0 || ny >= CHUNK_SIZE) {
        continue;
      }
      if (chunk.blocks[localIndex(nx, ny)] === wid) {
        return true;
      }
    }
    return false;
  }

  /**
   * Sugar cane soil: same as cardinal-from-soil, plus water in east/west cells one block lower
   * (common after sea fill when the neighbor column’s surface sits a step down).
   */
  private soilTouchesWaterForSugarCane(chunk: Chunk, lx: number, ly: number): boolean {
    if (this.foregroundTouchesWaterCardinal(chunk, lx, ly)) {
      return true;
    }
    if (this.waterId === null || ly <= 0) {
      return false;
    }
    const wid = this.waterId;
    const ny = ly - 1;
    for (const dlx of HORIZONTAL_NEIGHBOR_DX) {
      const nx = lx + dlx;
      if (nx < 0 || nx >= CHUNK_SIZE) {
        continue;
      }
      if (chunk.blocks[localIndex(nx, ny)] === wid) {
        return true;
      }
    }
    return false;
  }

  private placeBackgroundCell(
    chunk: Chunk,
    originWx: number,
    originWy: number,
    wx: number,
    wy: number,
    blockId: number,
  ): void {
    const lxLocal = wx - originWx;
    const lyLocal = wy - originWy;
    if (lxLocal < 0 || lxLocal >= CHUNK_SIZE || lyLocal < 0 || lyLocal >= CHUNK_SIZE) {
      return;
    }
    const idx = localIndex(lxLocal, lyLocal);
    const existing = chunk.blocks[idx]!;
    if (this.waterId !== null && existing === this.waterId) {
      return;
    }
    if (existing !== this.airId) {
      return;
    }
    chunk.blocks[idx] = blockId;
    chunk.metadata[idx] = chunk.metadata[idx]! | WORLDGEN_NO_COLLIDE;
  }

  private placeTrunkCell(
    chunk: Chunk,
    originWx: number,
    originWy: number,
    wx: number,
    wy: number,
    trunkId: number,
  ): void {
    const lxLocal = wx - originWx;
    const lyLocal = wy - originWy;
    if (lxLocal < 0 || lxLocal >= CHUNK_SIZE || lyLocal < 0 || lyLocal >= CHUNK_SIZE) {
      return;
    }
    const idx = localIndex(lxLocal, lyLocal);
    const existing = chunk.blocks[idx]!;
    if (this.waterId !== null && existing === this.waterId) {
      return;
    }
    if (
      existing !== this.airId &&
      existing !== this.oakLeavesId &&
      existing !== this.spruceLeavesId &&
      existing !== this.birchLeavesId
    ) {
      return;
    }
    chunk.blocks[idx] = trunkId;
    chunk.metadata[idx] = chunk.metadata[idx]! | WORLDGEN_NO_COLLIDE;
  }

  // -------------------------------------------------------------------------
  // Tree spawn logic
  // -------------------------------------------------------------------------

  private shouldSpawnTreeAt(wx: number, surfaceY: number, density: number): boolean {
    if (this.terrain.isDesert(wx)) {
      return false;
    }
    if (this.terrain.getLakeBiomeInfluence(wx) > LAKE_BIOME_TREE_SUPPRESS_INFLUENCE) {
      return false;
    }
    if (density <= 0.01) {
      return false;
    }

    const spawnChance = this.treeSpawnChance(density);
    const roll = this.random01(this.hash2(wx, surfaceY * 17 + 11));
    if (roll >= spawnChance) {
      return false;
    }

    const spacing = this.localSpacingForDensity(density);
    const myScore = this.anchorScore(wx, surfaceY);
    for (let ox = wx - spacing; ox <= wx + spacing; ox++) {
      if (ox === wx) {
        continue;
      }
      const od = this.terrain.getForestDensity(ox);
      if (od <= 0.01) {
        continue;
      }
      const osy = this.terrain.getSurfaceHeight(ox);
      const ochance = this.treeSpawnChance(od);
      const oroll = this.random01(this.hash2(ox, osy * 17 + 11));
      if (oroll >= ochance) {
        continue;
      }
      const otherScore = this.anchorScore(ox, osy);
      if (otherScore > myScore || (otherScore === myScore && ox < wx)) {
        return false;
      }
    }

    return true;
  }

  private treeSpawnChance(density: number): number {
    const d = Math.max(0, Math.min(1, density));
    const curved = d * d * (3 - 2 * d);
    return 0.02 + curved * 0.4;
  }

  private localSpacingForDensity(density: number): number {
    if (density > 0.75) {
      return 2;
    }
    if (density > 0.45) {
      return 3;
    }
    return 5;
  }

  private anchorScore(wx: number, surfaceY: number): number {
    return this.random01(this.hash2(wx * 41 + 7, surfaceY * 23 + 3));
  }

  private pickTreeShape(wx: number, surfaceY: number, density: number, forestType: ForestType): TreeShape {
    const h = this.hash2(wx * 13 + 5, surfaceY * 19 + 7);

    if (forestType === "spruce") {
      const idx = h % SPRUCE_VARIANTS.length;
      return { type: "spruce", spec: SPRUCE_VARIANTS[idx]! };
    }

    if (forestType === "birch") {
      const idx = h % BIRCH_SINGLE_VARIANTS.length;
      return { type: "birch", spec: BIRCH_SINGLE_VARIANTS[idx]! };
    }

    if (density >= 0.35 && h % 7 === 0) {
      return { type: "oak", shape: { kind: "twinFork", spec: OAK_TWIN_FORK_SPEC } };
    }
    const idx = h % OAK_SINGLE_VARIANTS.length;
    return { type: "oak", shape: { kind: "single", spec: OAK_SINGLE_VARIANTS[idx]! } };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private random01(h: number): number {
    return h / 0xffff_ffff;
  }

  private hash2(a: number, b: number): number {
    let h = (a * 0x45d9f3b) ^ (b * 0x119de1f3);
    h ^= h >>> 16;
    h = Math.imul(h, 0x7feb352d);
    h ^= h >>> 15;
    h = Math.imul(h, 0x846ca68b);
    h ^= h >>> 16;
    return h >>> 0;
  }

  private pickBlock(wx: number, wy: number, surfaceY: number): number {
    if (wy > surfaceY) {
      return this.airId;
    }
    if (this.genType === "flat") {
      return this.flatBlockId(wy, surfaceY);
    }
    const topsoilDepth = this.topsoilDepth(wx);
    if (wy > surfaceY - topsoilDepth) {
      return this.topsoilBlockId(wx, wy, surfaceY);
    }
    if (wy === WORLD_Y_MIN) {
      return this.bedrockId;
    }
    if (wy <= WORLD_Y_MIN + 5 && wy > WORLD_Y_MIN) {
      const ore = this.ores.getOreAt(wx, wy, surfaceY);
      if (ore !== null) {
        return ore;
      }
      const fill = this.sediment.getFill(wx, wy);
      return this.granite.applyToStoneFill(wx, wy, surfaceY, fill);
    }
    if (this.caves.isCave(wx, wy, surfaceY)) {
      return this.airId;
    }
    const ore = this.ores.getOreAt(wx, wy, surfaceY);
    if (ore !== null) {
      return ore;
    }
    const fill = this.sediment.getFill(wx, wy);
    return this.granite.applyToStoneFill(wx, wy, surfaceY, fill);
  }

  /**
   * Flat-world column profile: bedrock at {@link WORLD_Y_MIN}, stone, dirt, grass cap.
   * Caller guarantees `wy <= surfaceY`.
   */
  private flatBlockId(wy: number, surfaceY: number): number {
    if (wy === WORLD_Y_MIN) {
      return this.bedrockId;
    }
    if (wy === surfaceY) {
      return this.grassId;
    }
    if (wy >= surfaceY - FLAT_WORLD_DIRT_DEPTH) {
      return this.dirtId;
    }
    return this.stoneId;
  }

  private applyStructureFeatures(chunk: Chunk, originWx: number, originWy: number): void {
    if (this._structureFeatures.length === 0) {
      return;
    }
    const chunkX = Math.floor(originWx / CHUNK_SIZE);
    const chunkY = Math.floor(originWy / CHUNK_SIZE);
    const accepted: StructurePlacementResolution[] = [];
    for (let i = 0; i < this._structureFeatures.length; i++) {
      const feature = this._structureFeatures[i]!;
      if (feature.structures.length === 0) continue;
      let maxWidth = 1;
      let maxHeight = 1;
      for (const s of feature.structures) {
        maxWidth = Math.max(maxWidth, s.width);
        maxHeight = Math.max(maxHeight, s.height);
      }
      const spanX = Math.max(1, Math.ceil(maxWidth / CHUNK_SIZE));
      const spanY = Math.max(1, Math.ceil(maxHeight / CHUNK_SIZE));
      for (let sourceChunkY = chunkY - (spanY - 1); sourceChunkY <= chunkY; sourceChunkY++) {
        for (let sourceChunkX = chunkX - (spanX - 1); sourceChunkX <= chunkX; sourceChunkX++) {
          const sourceOriginWx = sourceChunkX * CHUNK_SIZE;
          const sourceOriginWy = sourceChunkY * CHUNK_SIZE;
          const resolved = this.resolveFeaturePlacementForChunk(
            i,
            sourceChunkX,
            sourceChunkY,
            sourceOriginWx,
            sourceOriginWy,
            sourceChunkX === chunkX && sourceChunkY === chunkY ? chunk : undefined,
          );
          if (resolved === null) {
            continue;
          }
          const { structure, originX, originY } = resolved;
          if (
            originX + structure.width <= originWx ||
            originX >= originWx + CHUNK_SIZE ||
            originY + structure.height <= originWy ||
            originY >= originWy + CHUNK_SIZE
          ) {
            continue;
          }
          const candidate: StructurePlacementResolution = {
            featureIndex: i,
            structure,
            originX,
            originY,
          };
          if (this.overlapsAcceptedPlacement(candidate, accepted)) {
            continue;
          }
          accepted.push(candidate);
          this.stampStructure(chunk, originWx, originWy, originX, originY, structure, i);
          if (feature.placement.suppress_vegetation) {
            const pad = feature.placement.terrain?.pad_x ?? 0;
            this.clearVegetationInRange(
              chunk,
              originWx,
              originWy,
              originX - pad,
              originX + structure.width - 1 + pad,
              originY,
              originY + structure.height - 1,
            );
          }
        }
      }
    }
  }

  /**
   * Deterministically resolves structure tile-entities that land inside `coord`.
   * Used by World after procedural chunk generation to materialize barrels/chests/furnaces.
   */
  getStructureEntitiesForChunk(coord: ChunkCoord): GeneratedStructureEntity[] {
    if (this._structureFeatures.length === 0) {
      return [];
    }
    const out: GeneratedStructureEntity[] = [];
    const origin = chunkToWorldOrigin(coord);
    const originWx = origin.wx;
    const originWy = origin.wy;
    const chunkX = Math.floor(originWx / CHUNK_SIZE);
    const chunkY = Math.floor(originWy / CHUNK_SIZE);
    const accepted: StructurePlacementResolution[] = [];
    for (let i = 0; i < this._structureFeatures.length; i++) {
      const feature = this._structureFeatures[i]!;
      if (feature.structures.length === 0) continue;
      let maxWidth = 1;
      let maxHeight = 1;
      for (const s of feature.structures) {
        maxWidth = Math.max(maxWidth, s.width);
        maxHeight = Math.max(maxHeight, s.height);
      }
      const spanX = Math.max(1, Math.ceil(maxWidth / CHUNK_SIZE));
      const spanY = Math.max(1, Math.ceil(maxHeight / CHUNK_SIZE));
      for (let sourceChunkY = chunkY - (spanY - 1); sourceChunkY <= chunkY; sourceChunkY++) {
        for (let sourceChunkX = chunkX - (spanX - 1); sourceChunkX <= chunkX; sourceChunkX++) {
          const sourceOriginWx = sourceChunkX * CHUNK_SIZE;
          const sourceOriginWy = sourceChunkY * CHUNK_SIZE;
          const resolved = this.resolveFeaturePlacementForChunk(
            i,
            sourceChunkX,
            sourceChunkY,
            sourceOriginWx,
            sourceOriginWy,
          );
          if (resolved === null) {
            continue;
          }
          const { structure, originX, originY } = resolved;
          if (
            originX + structure.width <= originWx ||
            originX >= originWx + CHUNK_SIZE ||
            originY + structure.height <= originWy ||
            originY >= originWy + CHUNK_SIZE
          ) {
            continue;
          }
          const candidate: StructurePlacementResolution = {
            featureIndex: i,
            structure,
            originX,
            originY,
          };
          if (this.overlapsAcceptedPlacement(candidate, accepted)) {
            continue;
          }
          accepted.push(candidate);
          for (const e of structure.entities) {
            const wx = originX + e.x;
            const wy = originY + e.y;
            if (
              wx < originWx ||
              wx >= originWx + CHUNK_SIZE ||
              wy < originWy ||
              wy >= originWy + CHUNK_SIZE
            ) {
              continue;
            }
            if (e.type === "furnace") {
              out.push({ type: "furnace", wx, wy, state: e.state });
            } else if (e.type === "spawner") {
              out.push({ type: "spawner", wx, wy, state: e.state });
            } else {
              out.push({
                type: "container",
                wx,
                wy,
                lootTable: e.lootTable,
                items: e.items ?? undefined,
              });
            }
          }
        }
      }
    }
    return out;
  }

  private overlapsAcceptedPlacement(
    candidate: StructurePlacementResolution,
    accepted: StructurePlacementResolution[],
  ): boolean {
    const cMinX = candidate.originX;
    const cMaxX = candidate.originX + candidate.structure.width - 1;
    const cMinY = candidate.originY;
    const cMaxY = candidate.originY + candidate.structure.height - 1;
    for (const existing of accepted) {
      const eMinX = existing.originX;
      const eMaxX = existing.originX + existing.structure.width - 1;
      const eMinY = existing.originY;
      const eMaxY = existing.originY + existing.structure.height - 1;
      const overlapX = cMinX <= eMaxX && cMaxX >= eMinX;
      const overlapY = cMinY <= eMaxY && cMaxY >= eMinY;
      if (overlapX && overlapY) {
        return true;
      }
    }
    return false;
  }

  private resolveFeaturePlacementForChunk(
    featureIndex: number,
    chunkX: number,
    chunkY: number,
    originWx: number,
    originWy: number,
    chunk?: Chunk,
  ): StructurePlacementResolution | null {
    const feature = this._structureFeatures[featureIndex]!;
    if (feature.structures.length === 0) {
      return null;
    }
    const h = this.hash2(chunkX * 7919 + featureIndex * 149, chunkY * 6151 + 97);
    const pick = (h >>> 20) % feature.structures.length;
    const structure = feature.structures[pick]!;
    const roll = (h % 1_000_000) / 1_000_000;
    if (roll >= feature.placement.frequency) {
      return null;
    }
    const retryCount = feature.placement.pass === "underground" ? 4 : 1;
    for (let attempt = 0; attempt < retryCount; attempt++) {
      const attemptHash = this.hash2(h + attempt * 0x9e37, h ^ (attempt * 0x85eb));
      const anchorLx = (attemptHash >>> 8) % CHUNK_SIZE;
      const originX = originWx + anchorLx;
      const undergroundOriginY = this.resolveUndergroundOriginY(featureIndex, attemptHash, originX, structure);
      if (feature.placement.pass === "underground") {
        if (undergroundOriginY === null) {
          continue;
        }
        return { featureIndex, structure, originX, originY: undergroundOriginY };
      }
      const surfacePlacement = this.resolveSurfaceOriginY(featureIndex, originX, structure);
      if (surfacePlacement === null) {
        continue;
      }
      if (surfacePlacement.flatten !== null && chunk !== undefined) {
        this.flattenColumns(
          chunk,
          originWx,
          originWy,
          originX - surfacePlacement.padX,
          originX + structure.width - 1 + surfacePlacement.padX,
          surfacePlacement.flatten,
        );
      }
      return { featureIndex, structure, originX, originY: surfacePlacement.originY };
    }
    return null;
  }

  private resolveUndergroundOriginY(
    featureIndex: number,
    attemptHash: number,
    originX: number,
    structure: ParsedStructure,
  ): number | null {
    const feature = this._structureFeatures[featureIndex]!;
    const minDepth = Math.max(0, feature.placement.min_depth);
    const maxDepth = Math.max(minDepth, feature.placement.max_depth);
    const depth = minDepth + ((attemptHash >>> 12) % (maxDepth - minDepth + 1));
    const originY = -depth;
    const structureTopY = originY + structure.height - 1;
    const clearance = feature.placement.clearance?.height ?? 0;
    for (let dx = 0; dx < structure.width; dx++) {
      const wx = originX + dx;
      const surfaceY = this.terrain.getSurfaceHeight(wx);
      if (structureTopY + clearance > surfaceY) {
        return null;
      }
    }
    const bedrockSafetyMargin = 5;
    const structureBottomY = originY;
    if (structureBottomY <= WORLD_Y_MIN + bedrockSafetyMargin) {
      return null;
    }
    return originY;
  }

  private resolveSurfaceOriginY(
    featureIndex: number,
    originX: number,
    structure: ParsedStructure,
  ): { originY: number; flatten: number | null; padX: number } | null {
    const feature = this._structureFeatures[featureIndex]!;
    const padX = feature.placement.terrain?.pad_x ?? 0;
    const sampleMin = originX - padX;
    const sampleMax = originX + structure.width - 1 + padX;
    let minSurface = Number.POSITIVE_INFINITY;
    let maxSurface = Number.NEGATIVE_INFINITY;
    let sumSurface = 0;
    let samples = 0;
    for (let wx = sampleMin; wx <= sampleMax; wx++) {
      const sy = this.terrain.getSurfaceHeight(wx);
      minSurface = Math.min(minSurface, sy);
      maxSurface = Math.max(maxSurface, sy);
      sumSurface += sy;
      samples++;
    }
    const maxSlope = feature.placement.terrain?.max_slope ?? 999;
    if (maxSurface - minSurface > maxSlope) {
      return null;
    }
    const targetGroundY =
      feature.placement.terrain?.mode === "flatten"
        ? Math.round(sumSurface / Math.max(1, samples))
        : this.terrain.getSurfaceHeight(originX);
    const originY = targetGroundY - (structure.height - 1);
    return {
      originY,
      flatten: feature.placement.terrain?.mode === "flatten" ? targetGroundY : null,
      padX,
    };
  }

  private flattenColumns(
    chunk: Chunk,
    originWx: number,
    originWy: number,
    minWx: number,
    maxWx: number,
    targetGroundY: number,
  ): void {
    for (let wx = minWx; wx <= maxWx; wx++) {
      const lx = wx - originWx;
      if (lx < 0 || lx >= CHUNK_SIZE) continue;
      let topSolidLy = -1;
      for (let ly = CHUNK_SIZE - 1; ly >= 0; ly--) {
        if (chunk.blocks[localIndex(lx, ly)] !== this.airId) {
          topSolidLy = ly;
          break;
        }
      }
      const targetLy = targetGroundY - originWy;
      if (targetLy < 1 || targetLy >= CHUNK_SIZE) continue;
      if (topSolidLy >= 0 && topSolidLy > targetLy) {
        for (let ly = targetLy + 1; ly <= topSolidLy; ly++) {
          const idx = localIndex(lx, ly);
          chunk.blocks[idx] = this.airId;
          chunk.metadata[idx] = 0;
        }
      } else if (topSolidLy >= 0 && topSolidLy < targetLy) {
        for (let ly = topSolidLy + 1; ly <= targetLy; ly++) {
          const idx = localIndex(lx, ly);
          chunk.blocks[idx] = this.dirtId;
          chunk.metadata[idx] = 0;
        }
      }
      const topIdx = localIndex(lx, targetLy);
      chunk.blocks[topIdx] = this.grassId;
      chunk.metadata[topIdx] = 0;
    }
  }

  private clearVegetationInRange(
    chunk: Chunk,
    originWx: number,
    originWy: number,
    minWx: number,
    maxWx: number,
    minWy: number,
    maxWy: number,
  ): void {
    const wipe = new Set<number>([
      this.shortGrassId,
      this.tallGrassBottomId,
      this.tallGrassTopId,
      this.dandelionId,
      this.poppyId,
      this.deadBushId,
      this.cactusId,
      this.oakLeavesId,
      this.spruceLeavesId,
      this.birchLeavesId,
    ]);
    for (let wx = minWx; wx <= maxWx; wx++) {
      const lx = wx - originWx;
      if (lx < 0 || lx >= CHUNK_SIZE) continue;
      for (let wy = minWy; wy <= maxWy; wy++) {
        const ly = wy - originWy;
        if (ly < 0 || ly >= CHUNK_SIZE) continue;
        const idx = localIndex(lx, ly);
        if (wipe.has(chunk.blocks[idx]!)) {
          chunk.blocks[idx] = this.airId;
          chunk.metadata[idx] = 0;
        }
      }
    }
  }

  private stampStructure(
    chunk: Chunk,
    originWx: number,
    originWy: number,
    placeWx: number,
    placeWy: number,
    structure: ParsedStructure,
    featureIndex: number,
  ): void {
    for (const cell of structure.blocks) {
      const wx = placeWx + cell.x;
      const wy = placeWy + cell.y;
      const lx = wx - originWx;
      const ly = wy - originWy;
      if (lx < 0 || lx >= CHUNK_SIZE || ly < 0 || ly >= CHUNK_SIZE) continue;
      const idx = localIndex(lx, ly);
      if (this.blockRegistry.isRegistered(cell.foreground.identifier)) {
        const fgId = this.blockRegistry.getByIdentifier(cell.foreground.identifier).id;
        const shouldThinTorch =
          this.torchId !== null &&
          fgId === this.torchId &&
          STRUCTURE_TORCH_KEEP_PERIOD > 1 &&
          this.shouldThinStructureTorch(wx, wy, featureIndex);
        chunk.blocks[idx] = shouldThinTorch ? this.airId : fgId;
        // Structure stamps must overwrite inherited terrain flags/orientation bits.
        chunk.metadata[idx] = shouldThinTorch ? 0 : (cell.foreground.metadata ?? 0);
      }
      if (this.blockRegistry.isRegistered(cell.background.identifier)) {
        chunk.background[idx] = this.blockRegistry.getByIdentifier(cell.background.identifier).id;
      }
    }
  }

  /** Deterministic structure torch thinning to cap emitter density in generated chunks. */
  private shouldThinStructureTorch(wx: number, wy: number, featureIndex: number): boolean {
    const h = this.hash2(wx * 31337 + featureIndex * 97, wy * 911);
    return h % STRUCTURE_TORCH_KEEP_PERIOD !== 0;
  }

  /** Temperate: 1 grass + 4 dirt. Desert: 3–5 sand + 2–3 sandstone (per-column hash). */
  private topsoilDepth(wx: number): number {
    if (!this.terrain.isDesert(wx)) {
      return 5;
    }
    const { sandDepth, sandstoneDepth } = this.desertTopsoilSlices(wx);
    return sandDepth + sandstoneDepth;
  }

  private desertTopsoilSlices(wx: number): { sandDepth: number; sandstoneDepth: number } {
    const h = this.hash2(wx * 923 + 11, 0xdea9_01);
    const sandDepth = 3 + (h % 3);
    const sandstoneDepth = 2 + ((h >>> 8) % 2);
    return { sandDepth, sandstoneDepth };
  }

  private topsoilBlockId(wx: number, wy: number, surfaceY: number): number {
    const d = surfaceY - wy;
    if (!this.terrain.isDesert(wx)) {
      if (d === 0) {
        return this.grassId;
      }
      return this.dirtId;
    }
    const { sandDepth, sandstoneDepth } = this.desertTopsoilSlices(wx);
    if (d < sandDepth) {
      return this.sandId;
    }
    if (d < sandDepth + sandstoneDepth) {
      return this.sandstoneId;
    }
    return this.sandId;
  }
}
