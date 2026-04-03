/** Deterministic chunk fill: terrain columns, caves, ores, bedrock. */
import { CHUNK_SIZE, WORLD_Y_MIN, WORLDGEN_NO_COLLIDE } from "../../core/constants";
import type { BlockRegistry } from "../blocks/BlockRegistry";
import { chunkToWorldOrigin, localIndex } from "../chunk/ChunkCoord";
import type { ChunkCoord } from "../chunk/ChunkCoord";
import { createChunk, type Chunk } from "../chunk/Chunk";
import { GeneratorContext } from "./GeneratorContext";
import { TerrainNoise, type ForestType } from "./TerrainNoise";
import { CaveGenerator } from "./CaveGenerator";
import { OreVeins } from "./OreVeins";
import { SedimentPockets } from "./SedimentPockets";
import { forEachDeciduousBushCell, forEachSpruceBushCell } from "./treeCanopy";

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

type SpruceTreeSpec = {
  trunkHeight: number;
  /** Canopy layers from top (narrow) to bottom (wide). Each value = half-width at that row. */
  canopyLayers: readonly number[];
  /** How far above surface the bottom of the canopy starts. */
  canopyStartDy: number;
};

const SPRUCE_VARIANTS: readonly SpruceTreeSpec[] = [
  {
    trunkHeight: 6,
    canopyLayers: [0, 1, 1, 2, 2, 3],
    canopyStartDy: 2,
  },
  {
    trunkHeight: 7,
    canopyLayers: [0, 1, 1, 2, 2, 3, 3],
    canopyStartDy: 2,
  },
  {
    trunkHeight: 8,
    canopyLayers: [0, 0, 1, 1, 2, 2, 3, 3],
    canopyStartDy: 2,
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

export class WorldGenerator {
  private readonly blockRegistry: BlockRegistry;
  private readonly terrain: TerrainNoise;
  private readonly caves: CaveGenerator;
  private readonly ores: OreVeins;
  private readonly sediment: SedimentPockets;
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
  private readonly deadBushId: number;

  constructor(seed: number, registry: BlockRegistry) {
    this.blockRegistry = registry;
    const root = new GeneratorContext(seed);
    this.terrain = new TerrainNoise(seed);
    this.caves = new CaveGenerator(root.fork(0xca_57));
    this.ores = new OreVeins(root.fork(0x0e5), registry);
    this.sediment = new SedimentPockets(root.fork(0x5ed1_000), registry);
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
    this.deadBushId = registry.getByIdentifier("stratum:dead_bush").id;
  }

  getSurfaceHeight(wx: number): number {
    return this.terrain.getSurfaceHeight(wx);
  }

  generateChunk(coord: ChunkCoord): Chunk {
    const chunk = createChunk(coord);
    const origin = chunkToWorldOrigin(coord);

    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      const wx = origin.wx + lx;
      const surfaceY = this.terrain.getSurfaceHeight(wx);

      for (let ly = 0; ly < CHUNK_SIZE; ly++) {
        const wy = origin.wy + ly;
        chunk.blocks[localIndex(lx, ly)] = this.pickBlock(wx, wy, surfaceY);
      }
    }
    this.placeBackgroundTrees(chunk, origin.wx, origin.wy);
    this.decorateSurfaceVegetation(chunk, origin.wx, origin.wy);
    this.decorateDesertSurface(chunk, origin.wx, origin.wy);
    this.fillTerrainBackgroundLayer(chunk, origin.wx, origin.wy);

    chunk.dirty = true;
    return chunk;
  }

  /**
   * Back-wall tiles: geological column ignoring caves; ores → stone; sky → 0.
   * Matches dirt/gravel pockets used in foreground stone.
   */
  private fillTerrainBackgroundLayer(chunk: Chunk, originWx: number, originWy: number): void {
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      const wx = originWx + lx;
      const surfaceY = this.terrain.getSurfaceHeight(wx);
      for (let ly = 0; ly < CHUNK_SIZE; ly++) {
        const wy = originWy + ly;
        chunk.background[localIndex(lx, ly)] = this.naturalBackdropId(wx, wy, surfaceY);
      }
    }
  }

  private naturalBackdropId(wx: number, wy: number, surfaceY: number): number {
    if (wy > surfaceY) {
      return 0;
    }
    const topsoilDepth = this.topsoilDepth(wx);
    if (wy > surfaceY - topsoilDepth) {
      return this.topsoilBlockId(wx, wy, surfaceY);
    }
    if (wy === WORLD_Y_MIN) {
      return this.stoneId;
    }
    if (wy <= WORLD_Y_MIN + 5 && wy > WORLD_Y_MIN) {
      if (this.ores.getOreAt(wx, wy, surfaceY) !== null) {
        return this.stoneId;
      }
      return this.sediment.getFill(wx, wy);
    }
    if (this.ores.getOreAt(wx, wy, surfaceY) !== null) {
      return this.stoneId;
    }
    return this.sediment.getFill(wx, wy);
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
        const wx = originWx + lx;
        const wy = originWy + ly;
        const h = this.hash2(wx * 131 + 17, wy * 91 + 9);
        const r = h % 1000;
        if (r < 180) {
          chunk.blocks[aboveIdx] = this.shortGrassId;
        } else if (r < 250 && ly + 2 < CHUNK_SIZE) {
          const above2Idx = localIndex(lx, ly + 2);
          if (chunk.blocks[above2Idx] === this.airId) {
            chunk.blocks[aboveIdx] = this.tallGrassBottomId;
            chunk.blocks[above2Idx] = this.tallGrassTopId;
          }
        } else if (r < 300) {
          chunk.blocks[aboveIdx] = this.dandelionId;
        } else if (r < 340) {
          chunk.blocks[aboveIdx] = this.poppyId;
        }
      }
    }
  }

  /** In-chunk ±X neighbors: solid non-replaceable blocks invalidate cactus (matches player rules at edges). */
  private horizontalNeighborSolidForCactus(chunk: Chunk, lx: number, ly: number): boolean {
    for (const dlx of [-1, 1] as const) {
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
      for (let ly = 0; ly < CHUNK_SIZE; ly++) {
        const wy = originWy + ly;
        if (wy !== surfaceY) {
          continue;
        }
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

    // Place trunk (overwrites leaves in the trunk column)
    for (let dy = 1; dy <= spec.trunkHeight; dy++) {
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
    if (chunk.blocks[idx] !== this.airId) {
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
      return this.sediment.getFill(wx, wy);
    }
    if (this.caves.isCave(wx, wy, surfaceY)) {
      return this.airId;
    }
    const ore = this.ores.getOreAt(wx, wy, surfaceY);
    if (ore !== null) {
      return ore;
    }
    return this.sediment.getFill(wx, wy);
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
