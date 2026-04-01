/** Deterministic chunk fill: terrain columns, caves, ores, bedrock. */
import { CHUNK_SIZE, WORLD_Y_MIN } from "../../core/constants";
import type { BlockRegistry } from "../blocks/BlockRegistry";
import { chunkToWorldOrigin, localIndex } from "../chunk/ChunkCoord";
import type { ChunkCoord } from "../chunk/ChunkCoord";
import { createChunk, type Chunk } from "../chunk/Chunk";
import { GeneratorContext } from "./GeneratorContext";
import { TerrainNoise } from "./TerrainNoise";
import { CaveGenerator } from "./CaveGenerator";
import { OreVeins } from "./OreVeins";

/** Single-stem tree; canopy is always symmetric around the trunk column (no horizontal shift). */
type SingleTreeSpec = {
  trunkHeight: number;
  canopyCenterDy: number;
  radiusX: number;
  radiusY: number;
};

/** Double trunk + short Y branch + one merged canopy (modestly larger than a single tree). */
type TwinForkSpec = {
  baseTrunkH: number;
  canopyCenterDy: number;
  radiusX: number;
  radiusY: number;
};

type TreeShape = { kind: "single"; spec: SingleTreeSpec } | { kind: "twinFork"; spec: TwinForkSpec };

const SINGLE_TREE_VARIANTS: readonly SingleTreeSpec[] = [
  { trunkHeight: 3, canopyCenterDy: 4, radiusX: 2, radiusY: 2 },
  { trunkHeight: 4, canopyCenterDy: 5, radiusX: 2, radiusY: 3 },
  { trunkHeight: 4, canopyCenterDy: 5, radiusX: 3, radiusY: 2 },
] as const;

const TWIN_FORK_SPEC: TwinForkSpec = {
  baseTrunkH: 3,
  canopyCenterDy: 6,
  radiusX: 3,
  radiusY: 3,
} as const;

const TREE_PADDING_BLOCKS = 10;

export class WorldGenerator {
  private readonly terrain: TerrainNoise;
  private readonly caves: CaveGenerator;
  private readonly ores: OreVeins;
  private readonly airId: number;
  private readonly grassId: number;
  private readonly dirtId: number;
  private readonly stoneId: number;
  private readonly gravelId: number;
  private readonly bedrockId: number;
  private readonly treeTrunkBackId: number;
  private readonly treeLeavesBackId: number;
  private readonly shortGrassId: number;
  private readonly tallGrassBottomId: number;
  private readonly tallGrassTopId: number;
  private readonly dandelionId: number;
  private readonly poppyId: number;

  constructor(seed: number, registry: BlockRegistry) {
    const root = new GeneratorContext(seed);
    this.terrain = new TerrainNoise(seed);
    this.caves = new CaveGenerator(root.fork(0xca_57));
    this.ores = new OreVeins(root.fork(0x0e5), registry);
    this.airId = registry.getByIdentifier("turfd:air").id;
    this.grassId = registry.getByIdentifier("turfd:grass").id;
    this.dirtId = registry.getByIdentifier("turfd:dirt").id;
    this.stoneId = registry.getByIdentifier("turfd:stone").id;
    this.gravelId = registry.getByIdentifier("turfd:gravel").id;
    this.bedrockId = registry.getByIdentifier("turfd:bedrock").id;
    this.treeTrunkBackId = registry.getByIdentifier("turfd:wood_log_back").id;
    this.treeLeavesBackId = registry.getByIdentifier("turfd:leaves_back").id;
    this.shortGrassId = registry.getByIdentifier("turfd:short_grass").id;
    this.tallGrassBottomId = registry.getByIdentifier("turfd:tall_grass_bottom").id;
    this.tallGrassTopId = registry.getByIdentifier("turfd:tall_grass_top").id;
    this.dandelionId = registry.getByIdentifier("turfd:dandelion").id;
    this.poppyId = registry.getByIdentifier("turfd:poppy").id;
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

  /** Stone layer fill: pockets of dirt/gravel; ores handled by caller. */
  private pickStoneOrPocket(wx: number, wy: number): number {
    const n = this.random01(this.hash2(wx * 0x1a2b3c4d + 0x70, wy * 0x5d6e7f89 + 0x11));
    if (n > 0.93) {
      return this.gravelId;
    }
    if (n > 0.82) {
      return this.dirtId;
    }
    return this.stoneId;
  }

  /**
   * Solid geology at (wx, wy) with caves ignored; ore cells resolve to stone for backdrops.
   */
  private naturalBackdropId(wx: number, wy: number, surfaceY: number): number {
    if (wy > surfaceY) {
      return 0;
    }
    if (wy === surfaceY) {
      return this.grassId;
    }
    if (wy >= surfaceY - 4 && wy < surfaceY) {
      return this.dirtId;
    }
    if (wy === WORLD_Y_MIN) {
      return this.stoneId;
    }
    if (wy <= WORLD_Y_MIN + 5 && wy > WORLD_Y_MIN) {
      if (this.ores.getOreAt(wx, wy, surfaceY) !== null) {
        return this.stoneId;
      }
      return this.pickStoneOrPocket(wx, wy);
    }
    if (this.ores.getOreAt(wx, wy, surfaceY) !== null) {
      return this.stoneId;
    }
    return this.pickStoneOrPocket(wx, wy);
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
        if (r < 120) {
          chunk.blocks[aboveIdx] = this.shortGrassId;
        } else if (r < 170 && ly + 2 < CHUNK_SIZE) {
          const above2Idx = localIndex(lx, ly + 2);
          if (chunk.blocks[above2Idx] === this.airId) {
            chunk.blocks[aboveIdx] = this.tallGrassBottomId;
            chunk.blocks[above2Idx] = this.tallGrassTopId;
          }
        } else if (r < 220) {
          chunk.blocks[aboveIdx] = this.dandelionId;
        } else if (r < 260) {
          chunk.blocks[aboveIdx] = this.poppyId;
        }
      }
    }
  }

  private placeBackgroundTrees(chunk: Chunk, originWx: number, originWy: number): void {
    const startWx = originWx - TREE_PADDING_BLOCKS;
    const endWx = originWx + CHUNK_SIZE + TREE_PADDING_BLOCKS;
    for (let anchorWx = startWx; anchorWx < endWx; anchorWx++) {
      const surfaceY = this.terrain.getSurfaceHeight(anchorWx);
      const density = this.terrain.getForestDensity(anchorWx);
      if (!this.shouldSpawnTreeAt(anchorWx, surfaceY, density)) {
        continue;
      }
      const shape = this.pickTreeShape(anchorWx, surfaceY, density);
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
    if (shape.kind === "single") {
      this.placeSymmetricCanopy(
        chunk,
        originWx,
        originWy,
        anchorWx,
        surfaceY + shape.spec.canopyCenterDy,
        shape.spec.radiusX,
        shape.spec.radiusY,
      );
      for (let dy = 1; dy <= shape.spec.trunkHeight; dy++) {
        this.placeTrunkCell(chunk, originWx, originWy, anchorWx, surfaceY + dy);
      }
      return;
    }

    const s = shape.spec;
    const canopyCx = anchorWx + 1;
    const canopyCy = surfaceY + s.canopyCenterDy;
    this.placeSymmetricCanopy(chunk, originWx, originWy, canopyCx, canopyCy, s.radiusX, s.radiusY);

    for (let dy = 1; dy <= s.baseTrunkH; dy++) {
      this.placeTrunkCell(chunk, originWx, originWy, anchorWx, surfaceY + dy);
      this.placeTrunkCell(chunk, originWx, originWy, anchorWx + 1, surfaceY + dy);
    }
    const forkY = surfaceY + s.baseTrunkH + 1;
    this.placeTrunkCell(chunk, originWx, originWy, anchorWx - 1, forkY);
    this.placeTrunkCell(chunk, originWx, originWy, anchorWx + 2, forkY);
  }

  /** Ellipse canopy symmetric in ±dx (no per-cell jitter — avoids lopsided crowns). */
  private placeSymmetricCanopy(
    chunk: Chunk,
    originWx: number,
    originWy: number,
    canopyCx: number,
    canopyCy: number,
    radiusX: number,
    radiusY: number,
  ): void {
    for (let dy = -radiusY; dy <= radiusY; dy++) {
      for (let dx = -radiusX; dx <= radiusX; dx++) {
        const nx = dx / radiusX;
        const ny = dy / radiusY;
        const dist = nx * nx + ny * ny;
        if (dist > 1) {
          continue;
        }
        if (dy < 0 && Math.abs(dx) > radiusX - 1 && dist > 0.78) {
          continue;
        }
        this.placeBackgroundCell(
          chunk,
          originWx,
          originWy,
          canopyCx + dx,
          canopyCy + dy,
          this.treeLeavesBackId,
        );
      }
    }
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
  }

  private placeTrunkCell(
    chunk: Chunk,
    originWx: number,
    originWy: number,
    wx: number,
    wy: number,
  ): void {
    const lxLocal = wx - originWx;
    const lyLocal = wy - originWy;
    if (lxLocal < 0 || lxLocal >= CHUNK_SIZE || lyLocal < 0 || lyLocal >= CHUNK_SIZE) {
      return;
    }
    const idx = localIndex(lxLocal, lyLocal);
    const existing = chunk.blocks[idx]!;
    if (existing !== this.airId && existing !== this.treeLeavesBackId) {
      return;
    }
    chunk.blocks[idx] = this.treeTrunkBackId;
  }

  private shouldSpawnTreeAt(wx: number, surfaceY: number, density: number): boolean {
    if (density <= 0.01) {
      return false;
    }

    const spawnChance = this.treeSpawnChance(density);
    const roll = this.random01(this.hash2(wx, surfaceY * 17 + 11));
    if (roll >= spawnChance) {
      return false;
    }

    // Ownership rule: only the strongest candidate in a local window spawns.
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

  private pickTreeShape(wx: number, surfaceY: number, density: number): TreeShape {
    const h = this.hash2(wx * 13 + 5, surfaceY * 19 + 7);
    if (density >= 0.35 && h % 7 === 0) {
      return { kind: "twinFork", spec: TWIN_FORK_SPEC };
    }
    const idx = h % SINGLE_TREE_VARIANTS.length;
    return { kind: "single", spec: SINGLE_TREE_VARIANTS[idx]! };
  }

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
    if (wy === surfaceY) {
      return this.grassId;
    }
    if (wy >= surfaceY - 4 && wy < surfaceY) {
      return this.dirtId;
    }
    if (wy === WORLD_Y_MIN) {
      return this.bedrockId;
    }
    if (wy <= WORLD_Y_MIN + 5 && wy > WORLD_Y_MIN) {
      const ore = this.ores.getOreAt(wx, wy, surfaceY);
      if (ore !== null) {
        return ore;
      }
      return this.pickStoneOrPocket(wx, wy);
    }
    if (this.caves.isCave(wx, wy, surfaceY)) {
      return this.airId;
    }
    const ore = this.ores.getOreAt(wx, wy, surfaceY);
    if (ore !== null) {
      return ore;
    }
    return this.pickStoneOrPocket(wx, wy);
  }
}
