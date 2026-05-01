/**
 * Procedural placement of mod-defined structure features (villages, mineshafts,
 * dungeons, etc.) for {@link WorldGenerator}.
 *
 * Owns:
 *  - the resolver pipeline (`resolveStructurePlacementsForChunk` →
 *    `stampAcceptedPlacements` / `extractEntitiesFromAcceptedPlacements`),
 *  - per-feature surface flatten + vegetation cleanup helpers,
 *  - structure-stamp + torch-thinning logic.
 *
 * Does not own: terrain / cave / ore generation. The {@link TerrainNoise}
 * instance is injected for surface-height queries needed by underground vs
 * surface placement passes.
 *
 * Determinism: every placement decision derives from {@link hash2} on
 * `(chunkX, chunkY, featureIndex)` so a feature whose footprint spans two
 * chunks resolves identically when either chunk is generated first — required
 * for the parallel chunk dispatch path in `World.loadChunksAroundCentre`.
 */
import { CHUNK_SIZE, WORLD_Y_MIN } from "../../core/constants";
import { TerrainNoise } from "../../core/TerrainNoise";
import type { BlockRegistry } from "../blocks/BlockRegistry";
import type { Chunk } from "../chunk/Chunk";
import { chunkToWorldOrigin, localIndex } from "../chunk/ChunkCoord";
import type { ChunkCoord } from "../chunk/ChunkCoord";
import type { ParsedStructure } from "../structure/structureSchema";
import type { StructureFeatureEntry } from "../structure/StructureRegistry";
import type { FurnaceTileState } from "../furnace/FurnaceTileState";
import type { SpawnerTileState } from "../spawner/SpawnerTileState";
import { hash2 } from "./genHash";

/** Keep one of every N structure torches (deterministic by world cell). */
const STRUCTURE_TORCH_KEEP_PERIOD = 2;

/** Tile-entity payload emitted by {@link StructurePlacer.extractEntitiesFromAcceptedPlacements}. */
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
      state: FurnaceTileState;
    }
  | {
      type: "spawner";
      wx: number;
      wy: number;
      state: SpawnerTileState;
    };

export type StructureFeature = {
  identifier: string;
  structures: ParsedStructure[];
  placement: StructureFeatureEntry["placement"];
};

export type StructurePlacementResolution = {
  featureIndex: number;
  structure: ParsedStructure;
  originX: number;
  originY: number;
};

export type StructurePlacerDeps = {
  blockRegistry: BlockRegistry;
  terrain: TerrainNoise;
  airId: number;
  dirtId: number;
  grassId: number;
  torchId: number | null;
  shortGrassId: number;
  tallGrassBottomId: number;
  tallGrassTopId: number;
  dandelionId: number;
  poppyId: number;
  deadBushId: number;
  cactusId: number;
  oakLeavesId: number;
  spruceLeavesId: number;
  birchLeavesId: number;
};

export class StructurePlacer {
  private readonly blockRegistry: BlockRegistry;
  private readonly terrain: TerrainNoise;
  private readonly airId: number;
  private readonly dirtId: number;
  private readonly grassId: number;
  private readonly torchId: number | null;
  private readonly shortGrassId: number;
  private readonly tallGrassBottomId: number;
  private readonly tallGrassTopId: number;
  private readonly dandelionId: number;
  private readonly poppyId: number;
  private readonly deadBushId: number;
  private readonly cactusId: number;
  private readonly oakLeavesId: number;
  private readonly spruceLeavesId: number;
  private readonly birchLeavesId: number;
  private _features: StructureFeature[] = [];

  constructor(deps: StructurePlacerDeps) {
    this.blockRegistry = deps.blockRegistry;
    this.terrain = deps.terrain;
    this.airId = deps.airId;
    this.dirtId = deps.dirtId;
    this.grassId = deps.grassId;
    this.torchId = deps.torchId;
    this.shortGrassId = deps.shortGrassId;
    this.tallGrassBottomId = deps.tallGrassBottomId;
    this.tallGrassTopId = deps.tallGrassTopId;
    this.dandelionId = deps.dandelionId;
    this.poppyId = deps.poppyId;
    this.deadBushId = deps.deadBushId;
    this.cactusId = deps.cactusId;
    this.oakLeavesId = deps.oakLeavesId;
    this.spruceLeavesId = deps.spruceLeavesId;
    this.birchLeavesId = deps.birchLeavesId;
  }

  setFeatures(features: readonly StructureFeature[]): void {
    this._features = [...features];
  }

  hasFeatures(): boolean {
    return this._features.length > 0;
  }

  /**
   * Single-pass placement resolver: walks features × source chunks, applies
   * frequency rolls, dedupes overlaps, and (for the home chunk only) triggers
   * the surface-flatten side effect inside {@link resolveFeaturePlacementForChunk}.
   *
   * Both stamping and entity extraction consume the resulting `accepted`
   * list so the placement loop only runs once per chunk.
   */
  resolveStructurePlacementsForChunk(
    coord: ChunkCoord,
    chunk?: Chunk,
  ): StructurePlacementResolution[] {
    if (this._features.length === 0) {
      return [];
    }
    const origin = chunkToWorldOrigin(coord);
    const originWx = origin.wx;
    const originWy = origin.wy;
    const chunkX = Math.floor(originWx / CHUNK_SIZE);
    const chunkY = Math.floor(originWy / CHUNK_SIZE);
    const accepted: StructurePlacementResolution[] = [];
    for (let i = 0; i < this._features.length; i++) {
      const feature = this._features[i]!;
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
          const isHome = sourceChunkX === chunkX && sourceChunkY === chunkY;
          const resolved = this.resolveFeaturePlacementForChunk(
            i,
            sourceChunkX,
            sourceChunkY,
            sourceOriginWx,
            sourceOriginWy,
            isHome ? chunk : undefined,
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
        }
      }
    }
    return accepted;
  }

  /** Stamps blocks for accepted placements + per-feature `suppress_vegetation` cleanup. */
  stampAcceptedPlacements(
    chunk: Chunk,
    originWx: number,
    originWy: number,
    accepted: readonly StructurePlacementResolution[],
  ): void {
    for (let i = 0; i < accepted.length; i++) {
      const a = accepted[i]!;
      const feature = this._features[a.featureIndex]!;
      this.stampStructure(
        chunk,
        originWx,
        originWy,
        a.originX,
        a.originY,
        a.structure,
        a.featureIndex,
      );
      if (feature.placement.suppress_vegetation) {
        const pad = feature.placement.terrain?.pad_x ?? 0;
        this.clearVegetationInRange(
          chunk,
          originWx,
          originWy,
          a.originX - pad,
          a.originX + a.structure.width - 1 + pad,
          a.originY,
          a.originY + a.structure.height - 1,
        );
      }
    }
  }

  /** Pulls per-cell `entities` out of the accepted placement list, clipped to the chunk. */
  extractEntitiesFromAcceptedPlacements(
    accepted: readonly StructurePlacementResolution[],
    originWx: number,
    originWy: number,
  ): GeneratedStructureEntity[] {
    const out: GeneratedStructureEntity[] = [];
    for (let i = 0; i < accepted.length; i++) {
      const { structure, originX, originY } = accepted[i]!;
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
          /**
           * Structure JSON schema declares `state: z.unknown()` for furnace tiles
           * (hand-authored content); we trust the structure author here and cross
           * into {@link FurnaceTileState} at this single boundary so the worker
           * protocol type stays concrete and clone-safe by construction.
           */
          out.push({ type: "furnace", wx, wy, state: e.state as FurnaceTileState });
        } else if (e.type === "spawner") {
          /** Same rationale as furnace; downstream `setSpawnerTile` resets transient timeline fields. */
          out.push({ type: "spawner", wx, wy, state: e.state as SpawnerTileState });
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
    return out;
  }

  /**
   * Convenience wrapper for callers (e.g. `WorldGenerator.applyStructureFeatures`)
   * that need both placement resolution + block stamping in one shot.
   */
  resolveAndStamp(chunk: Chunk, originWx: number, originWy: number): void {
    const coord: ChunkCoord = {
      cx: Math.floor(originWx / CHUNK_SIZE),
      cy: Math.floor(originWy / CHUNK_SIZE),
    };
    const accepted = this.resolveStructurePlacementsForChunk(coord, chunk);
    this.stampAcceptedPlacements(chunk, originWx, originWy, accepted);
  }

  private overlapsAcceptedPlacement(
    candidate: StructurePlacementResolution,
    accepted: readonly StructurePlacementResolution[],
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
    const feature = this._features[featureIndex]!;
    if (feature.structures.length === 0) {
      return null;
    }
    const h = hash2(chunkX * 7919 + featureIndex * 149, chunkY * 6151 + 97);
    const pick = (h >>> 20) % feature.structures.length;
    const structure = feature.structures[pick]!;
    const roll = (h % 1_000_000) / 1_000_000;
    if (roll >= feature.placement.frequency) {
      return null;
    }
    const retryCount = feature.placement.pass === "underground" ? 4 : 1;
    for (let attempt = 0; attempt < retryCount; attempt++) {
      const attemptHash = hash2(h + attempt * 0x9e37, h ^ (attempt * 0x85eb));
      const anchorLx = (attemptHash >>> 8) % CHUNK_SIZE;
      const originX = originWx + anchorLx;
      const undergroundOriginY = this.resolveUndergroundOriginY(
        featureIndex,
        attemptHash,
        originX,
        structure,
      );
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
    const feature = this._features[featureIndex]!;
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
    const feature = this._features[featureIndex]!;
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
    const h = hash2(wx * 31337 + featureIndex * 97, wy * 911);
    return h % STRUCTURE_TORCH_KEEP_PERIOD !== 0;
  }
}
