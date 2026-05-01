/**
 * Procedural world generation coordinator.
 *
 * Owns the deterministic per-chunk pipeline:
 *  1. {@link generateChunkTerrainOnly} — terrain columns, caves, ores, sediment, granite, backdrop.
 *  2. Sea-level water flood (per-chunk via {@link applySeaLevelFloodWater}; multi-chunk via {@link applySeaLevelFloodToChunkRegion}).
 *  3. {@link decorateChunkSurface} — surface vegetation + delegated tree placement.
 *  4. Structure feature placement (delegated to {@link StructurePlacer}).
 *
 * Trees and structures live in their own modules ({@link TreePlacer} / {@link StructurePlacer})
 * so this coordinator stays focused on terrain assembly + the surface-decoration
 * heuristics that aren't part of either subsystem.
 */
import {
  CHUNK_SIZE,
  WATER_SEA_LEVEL_WY,
  WORLD_Y_MIN,
} from "../../core/constants";
import type { WorldGenType } from "../../core/types";
import type { BlockRegistry } from "../blocks/BlockRegistry";
import { chunkToWorldOrigin, localIndex } from "../chunk/ChunkCoord";
import type { ChunkCoord } from "../chunk/ChunkCoord";
import { createChunk, type Chunk } from "../chunk/Chunk";
import { GeneratorContext } from "./GeneratorContext";
import { TerrainNoise } from "../../core/TerrainNoise";
import { CaveGenerator } from "./CaveGenerator";
import { GraniteVeins } from "./GraniteVeins";
import { OreVeins } from "./OreVeins";
import { SedimentPockets } from "./SedimentPockets";
import {
  applySeaLevelFloodWater,
  applySeaLevelFloodWaterRegion,
} from "./SeaLevelWaterFill";
import { TreePlacer } from "./TreePlacer";
import {
  StructurePlacer,
  type GeneratedStructureEntity,
  type StructureFeature,
} from "./StructurePlacer";
import { SurfaceDecorator } from "./SurfaceDecorator";
import { hash2 } from "./genHash";

/** Re-exported so the existing `import type { GeneratedStructureEntity } from ".../WorldGenerator"` call sites keep working. */
export type { GeneratedStructureEntity } from "./StructurePlacer";

/**
 * Surface Y for `"flat"` worlds (grass row). Sits comfortably above
 * {@link WATER_SEA_LEVEL_WY} so sea-level flood never touches the ground.
 */
const FLAT_WORLD_SURFACE_Y = 4;
/** Number of dirt rows below the grass cap on flat worlds. */
const FLAT_WORLD_DIRT_DEPTH = 3;

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
  private readonly sandId: number;
  private readonly sandstoneId: number;
  private readonly waterId: number | null;
  private readonly trees: TreePlacer;
  private readonly structures: StructurePlacer;
  private readonly surface: SurfaceDecorator;

  constructor(seed: number, registry: BlockRegistry, genType: WorldGenType = "normal") {
    this.blockRegistry = registry;
    this.genType = genType;
    const root = new GeneratorContext(seed);
    this.terrain = new TerrainNoise(seed);
    this.caves = new CaveGenerator(root.fork(0xca_57));
    this.ores = new OreVeins(root.fork(0x0e5), registry);
    this.sediment = new SedimentPockets(root.fork(0x5ed1_000), registry);
    this.granite = new GraniteVeins(root.fork(0x6a32), registry);
    const id = (key: string): number => registry.getByIdentifier(key).id;
    const optId = (key: string): number | null =>
      registry.isRegistered(key) ? registry.getByIdentifier(key).id : null;
    this.airId = id("stratum:air");
    this.grassId = id("stratum:grass");
    this.dirtId = id("stratum:dirt");
    this.stoneId = id("stratum:stone");
    this.bedrockId = id("stratum:bedrock");
    this.sandId = id("stratum:sand");
    this.sandstoneId = id("stratum:sandstone");
    this.waterId = optId("stratum:water");
    const shortGrassId = id("stratum:short_grass");
    const tallGrassBottomId = id("stratum:tall_grass_bottom");
    const tallGrassTopId = id("stratum:tall_grass_top");
    const dandelionId = id("stratum:dandelion");
    const poppyId = id("stratum:poppy");
    const cactusId = id("stratum:cactus");
    const sugarCaneId = id("stratum:sugar_cane");
    const deadBushId = id("stratum:dead_bush");
    const oakLeavesId = id("stratum:oak_leaves");
    const spruceLeavesId = id("stratum:spruce_leaves");
    const birchLeavesId = id("stratum:birch_leaves");
    this.trees = new TreePlacer({
      terrain: this.terrain,
      airId: this.airId,
      waterId: this.waterId,
      oakLogId: id("stratum:oak_log"),
      oakLeavesId,
      spruceLogId: id("stratum:spruce_log"),
      spruceLeavesId,
      birchLogId: id("stratum:birch_log"),
      birchLeavesId,
    });
    this.structures = new StructurePlacer({
      blockRegistry: this.blockRegistry,
      terrain: this.terrain,
      airId: this.airId,
      dirtId: this.dirtId,
      grassId: this.grassId,
      torchId: optId("stratum:torch"),
      shortGrassId,
      tallGrassBottomId,
      tallGrassTopId,
      dandelionId,
      poppyId,
      deadBushId,
      cactusId,
      oakLeavesId,
      spruceLeavesId,
      birchLeavesId,
    });
    this.surface = new SurfaceDecorator({
      blockRegistry: this.blockRegistry,
      terrain: this.terrain,
      airId: this.airId,
      grassId: this.grassId,
      dirtId: this.dirtId,
      sandId: this.sandId,
      cactusId,
      sugarCaneId,
      deadBushId,
      shortGrassId,
      tallGrassBottomId,
      tallGrassTopId,
      dandelionId,
      poppyId,
      waterId: this.waterId,
    });
  }

  setStructureFeatures(features: readonly StructureFeature[]): void {
    this.structures.setFeatures(features);
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
    this.trees.placeBackgroundTrees(chunk, originWx, originWy);
    this.surface.decorateSurfaceVegetation(chunk, originWx, originWy);
    this.surface.decorateWaterEdgeSugarCane(chunk, originWx, originWy);
    this.surface.decorateDesertSurface(chunk, originWx, originWy);
    chunk.dirty = true;
    chunk.renderDirty = true;
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
    return this.generateChunkWithEntities(coord).chunk;
  }

  /**
   * Combined chunk + structure-entity pipeline: generates the chunk and resolves
   * structure tile-entities in **one** pass over the structure feature table,
   * sharing the placement resolver between stamping (block writes) and entity
   * extraction (chest/furnace/spawner emission).
   *
   * Prefer this over calling {@link generateChunk} + {@link getStructureEntitiesForChunk}
   * separately whenever both outputs are needed (the worker path and the
   * sync fallback in `World._generateChunkAsync`): the alternative pays the
   * structure-resolution cost twice per chunk for chunks containing villages /
   * cabins / mineshafts.
   */
  generateChunkWithEntities(coord: ChunkCoord): {
    chunk: Chunk;
    structureEntities: GeneratedStructureEntity[];
  } {
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
    let structureEntities: GeneratedStructureEntity[] = [];
    if (this.genType !== "flat" && this.structures.hasFeatures()) {
      const accepted = this.structures.resolveStructurePlacementsForChunk(coord, chunk);
      this.structures.stampAcceptedPlacements(chunk, origin.wx, origin.wy, accepted);
      structureEntities = this.structures.extractEntitiesFromAcceptedPlacements(
        accepted,
        origin.wx,
        origin.wy,
      );
    }
    return { chunk, structureEntities };
  }

  /**
   * Deterministically resolves structure tile-entities that land inside `coord`.
   * Used by World after procedural chunk generation to materialize barrels/chests/furnaces.
   *
   * Prefer {@link generateChunkWithEntities} when chunk generation is also needed —
   * it shares the placement resolver pass between block stamping and entity extraction.
   */
  getStructureEntitiesForChunk(coord: ChunkCoord): GeneratedStructureEntity[] {
    if (!this.structures.hasFeatures()) {
      return [];
    }
    const accepted = this.structures.resolveStructurePlacementsForChunk(coord);
    const origin = chunkToWorldOrigin(coord);
    return this.structures.extractEntitiesFromAcceptedPlacements(accepted, origin.wx, origin.wy);
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

  private flatBlockId(wy: number, surfaceY: number): number {
    if (wy === surfaceY) {
      return this.grassId;
    }
    if (wy > surfaceY) {
      return this.airId;
    }
    if (wy >= surfaceY - FLAT_WORLD_DIRT_DEPTH) {
      return this.dirtId;
    }
    return this.stoneId;
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
    const h = hash2(wx * 923 + 11, 0xdea9_01);
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
