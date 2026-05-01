/**
 * Surface vegetation pass for {@link WorldGenerator}: short/tall grass + flowers
 * on grass cells, sugar cane next to water, and desert cacti / dead bushes.
 *
 * Runs *after* terrain + sea-flood + tree placement so the decorator can read the
 * already-stamped chunk for adjacency checks (water cardinals, cactus stack
 * collisions). Block IDs are injected via constructor so the decorator stays
 * independent of `WorldGenerator`'s registry plumbing.
 *
 * Determinism: every randomized choice derives from {@link hash2} on world
 * coordinates; identical for a given seed regardless of which chunk is
 * generated first under the parallel-dispatch worker path.
 */
import { CHUNK_SIZE } from "../../core/constants";
import type { TerrainNoise } from "../../core/TerrainNoise";
import type { BlockRegistry } from "../blocks/BlockRegistry";
import type { Chunk } from "../chunk/Chunk";
import { localIndex } from "../chunk/ChunkCoord";
import { hash2 } from "./genHash";

const CARDINAL_NEIGHBOR_OFFSETS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

const HORIZONTAL_NEIGHBOR_DX = [-1, 1] as const;

export type SurfaceDecoratorDeps = {
  blockRegistry: BlockRegistry;
  terrain: TerrainNoise;
  airId: number;
  grassId: number;
  dirtId: number;
  sandId: number;
  cactusId: number;
  sugarCaneId: number;
  deadBushId: number;
  shortGrassId: number;
  tallGrassBottomId: number;
  tallGrassTopId: number;
  dandelionId: number;
  poppyId: number;
  waterId: number | null;
};

export class SurfaceDecorator {
  private readonly blockRegistry: BlockRegistry;
  private readonly terrain: TerrainNoise;
  private readonly airId: number;
  private readonly grassId: number;
  private readonly dirtId: number;
  private readonly sandId: number;
  private readonly cactusId: number;
  private readonly sugarCaneId: number;
  private readonly deadBushId: number;
  private readonly shortGrassId: number;
  private readonly tallGrassBottomId: number;
  private readonly tallGrassTopId: number;
  private readonly dandelionId: number;
  private readonly poppyId: number;
  private readonly waterId: number | null;

  constructor(deps: SurfaceDecoratorDeps) {
    this.blockRegistry = deps.blockRegistry;
    this.terrain = deps.terrain;
    this.airId = deps.airId;
    this.grassId = deps.grassId;
    this.dirtId = deps.dirtId;
    this.sandId = deps.sandId;
    this.cactusId = deps.cactusId;
    this.sugarCaneId = deps.sugarCaneId;
    this.deadBushId = deps.deadBushId;
    this.shortGrassId = deps.shortGrassId;
    this.tallGrassBottomId = deps.tallGrassBottomId;
    this.tallGrassTopId = deps.tallGrassTopId;
    this.dandelionId = deps.dandelionId;
    this.poppyId = deps.poppyId;
    this.waterId = deps.waterId;
  }

  /** Grass-topped columns: short/tall grass and flowers in air above (after trees). */
  decorateSurfaceVegetation(chunk: Chunk, originWx: number, originWy: number): void {
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
        const h = hash2(wx * 131 + 17, wy * 91 + 9);
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

  /** Sugar cane: 1–3 tall, only on sand/grass/dirt, only when adjacent to water. */
  decorateWaterEdgeSugarCane(chunk: Chunk, originWx: number, originWy: number): void {
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
      const h = hash2(wx * 599 + 11, wy * 283 + 7);
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

  /** Sparse cacti and dead bushes on desert surface sand (same chunk only for cactus stacks). */
  decorateDesertSurface(chunk: Chunk, originWx: number, originWy: number): void {
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
      const h = hash2(wx * 401 + 3, wy * 307 + 19);
      if (h % 1000 >= 160) {
        continue;
      }
      const h2 = hash2(wx * 811 + 1, wy * 503 + 29);
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
   * (common after sea fill when the neighbor column's surface sits a step down).
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
}
