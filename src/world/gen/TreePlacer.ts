/**
 * Surface tree placement (oak / birch / spruce) for {@link WorldGenerator}.
 *
 * Owns:
 *  - tree shape variants (oak singles, oak twin-fork, birch singles, spruce
 *    conifers) and the chunk-local stamp primitives (`placeBackgroundCell`,
 *    `placeTrunkCell`),
 *  - per-anchor spawn / tie-break logic via {@link hash2}/{@link random01} so
 *    chunk-local placement remains globally deterministic across chunk
 *    boundaries (a tree that spans chunks resolves identically when either
 *    chunk is generated first).
 *
 * Does not own: terrain noise, water flood, structures. The {@link TerrainNoise}
 * instance is injected for forest density / surface-height queries.
 */
import {
  CHUNK_SIZE,
  LAKE_BIOME_TREE_SUPPRESS_INFLUENCE,
  WATER_SEA_LEVEL_WY,
  WORLDGEN_NO_COLLIDE,
} from "../../core/constants";
import { TerrainNoise, type ForestType } from "../../core/TerrainNoise";
import type { Chunk } from "../chunk/Chunk";
import { localIndex } from "../chunk/ChunkCoord";
import {
  forEachDeciduousBushCell,
  forEachSpruceBushCell,
} from "./treeCanopy";
import { hash2, random01 } from "./genHash";

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

/**
 * Trees outside the chunk can still drop branches/leaves into it (especially
 * twin oaks and large spruce). Iterating this much padding around the chunk
 * lets cross-chunk canopies render correctly even when the neighbour chunk
 * isn't (yet) generated.
 */
const TREE_PADDING_BLOCKS = 10;

export type TreePlacerDeps = {
  terrain: TerrainNoise;
  airId: number;
  waterId: number | null;
  oakLogId: number;
  oakLeavesId: number;
  spruceLogId: number;
  spruceLeavesId: number;
  birchLogId: number;
  birchLeavesId: number;
};

export class TreePlacer {
  private readonly terrain: TerrainNoise;
  private readonly airId: number;
  private readonly waterId: number | null;
  private readonly oakLogId: number;
  private readonly oakLeavesId: number;
  private readonly spruceLogId: number;
  private readonly spruceLeavesId: number;
  private readonly birchLogId: number;
  private readonly birchLeavesId: number;

  constructor(deps: TreePlacerDeps) {
    this.terrain = deps.terrain;
    this.airId = deps.airId;
    this.waterId = deps.waterId;
    this.oakLogId = deps.oakLogId;
    this.oakLeavesId = deps.oakLeavesId;
    this.spruceLogId = deps.spruceLogId;
    this.spruceLeavesId = deps.spruceLeavesId;
    this.birchLogId = deps.birchLogId;
    this.birchLeavesId = deps.birchLeavesId;
  }

  /** Walk the chunk + padding columns and stamp every selected anchor's tree shape. */
  placeBackgroundTrees(chunk: Chunk, originWx: number, originWy: number): void {
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
  private resolvePlantedSurfaceY(
    anchorWx: number,
    nominalSurfaceY: number,
    shape: TreeShape,
  ): number {
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
    const roll = random01(hash2(wx, surfaceY * 17 + 11));
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
      const oroll = random01(hash2(ox, osy * 17 + 11));
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
    return 0.03 + curved * 0.44;
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
    return random01(hash2(wx * 41 + 7, surfaceY * 23 + 3));
  }

  private pickTreeShape(
    wx: number,
    surfaceY: number,
    density: number,
    forestType: ForestType,
  ): TreeShape {
    const h = hash2(wx * 13 + 5, surfaceY * 19 + 7);

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
}
