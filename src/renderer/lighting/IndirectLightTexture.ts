import { BufferImageSource, Texture } from "pixi.js";
import { BLOCK_LIGHT_MAX, CHUNK_SIZE, SKY_LIGHT_MAX } from "../../core/constants";
import type { World } from "../../world/World";
import { getBlock } from "../../world/chunk/Chunk";
import { OcclusionTexture } from "./OcclusionTexture";

const REGION_CHUNKS = OcclusionTexture.REGION_BLOCKS / CHUNK_SIZE;
const TOTAL_VIEWPORT_CHUNKS = REGION_CHUNKS * REGION_CHUNKS;

/**
 * Solid-cell indirect blending reads cardinal neighbors in scratch space. After a partial
 * light update, edge cells in adjacent chunks still depend on fresh neighbor scratch — pass 2
 * widens dirty chunks cardinally; pass 1 must refill scratch for that same set (not only the
 * originally dirty chunks) or seams appear at chunk boundaries on doors / opaque blocks.
 */
function expandDirtyChunksWithCardinalNeighbors(dirty: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const key of dirty) {
    out.add(key);
    const comma = key.indexOf(",");
    if (comma <= 0) {
      continue;
    }
    const cx = Number.parseInt(key.slice(0, comma), 10);
    const cy = Number.parseInt(key.slice(comma + 1), 10);
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) {
      continue;
    }
    out.add(`${cx + 1},${cy}`);
    out.add(`${cx - 1},${cy}`);
    out.add(`${cx},${cy + 1}`);
    out.add(`${cx},${cy - 1}`);
  }
  return out;
}

/** CPU RG light grid (sky, block) aligned with OcclusionTexture's region. */
export class IndirectLightTexture {
  static readonly REGION_BLOCKS = OcclusionTexture.REGION_BLOCKS;

  private readonly _data: Uint8Array;
  private readonly _source: BufferImageSource;
  readonly texture: Texture;

  /** Per-cell sky / block level for the region; pass 1 fills, pass 2 reads neighbors (avoids 8× world lookups per solid cell). */
  private readonly _scratchSky: Uint8Array;
  private readonly _scratchBlock: Uint8Array;

  private _centerCX = 0;
  private _centerCY = 0;
  private readonly _dirtyChunks = new Set<string>();
  private _allDirty = true;
  private _gpuUploadPending = true;

  constructor() {
    const size = IndirectLightTexture.REGION_BLOCKS;
    const cells = size * size;
    this._scratchSky = new Uint8Array(cells);
    this._scratchBlock = new Uint8Array(cells);
    this._data = new Uint8Array(cells * 2);
    this._source = new BufferImageSource({
      resource: this._data,
      width: size,
      height: size,
      format: "rg8unorm",
    });
    this.texture = new Texture({ source: this._source });
    this.texture.source.scaleMode = "linear";
  }

  markDirty(cx: number, cy: number): void {
    this._dirtyChunks.add(`${cx},${cy}`);
  }

  markAllDirty(): void {
    this._allDirty = true;
  }

  rebuild(centerChunkCX: number, centerChunkCY: number, world: World): boolean {
    const centerMoved =
      centerChunkCX !== this._centerCX || centerChunkCY !== this._centerCY;
    if (centerMoved) {
      this._allDirty = true;
    }
    if (!this._allDirty && this._dirtyChunks.size === 0) {
      return false;
    }
    this._centerCX = centerChunkCX;
    this._centerCY = centerChunkCY;

    const size = IndirectLightTexture.REGION_BLOCKS;
    const regionChunks = REGION_CHUNKS;
    const halfChunks = Math.floor(regionChunks / 2);
    const originChunkCX = centerChunkCX - halfChunks;
    const originChunkCY = centerChunkCY - halfChunks;
    const reg = world.getRegistry();

    const clamp01 = (v: number): number => {
      if (v < 0) return 0;
      if (v > 1) return 1;
      return v;
    };

    const scratchSky = this._scratchSky;
    const scratchBlock = this._scratchBlock;

    const fullScan =
      this._allDirty ||
      this._dirtyChunks.size >= TOTAL_VIEWPORT_CHUNKS;

    // Scratch must match pass 2's read set: solid cells blend cardinals from scratch, so when
    // only chunk A is dirty, chunk B's scratch column along the shared edge must still refresh
    // or seams appear at doors / opaque blocks (air/torches read chunk arrays directly in pass 2).
    const partialChunkKeys = fullScan
      ? null
      : expandDirtyChunksWithCardinalNeighbors(this._dirtyChunks);

    // Pass 1: fill scratch arrays with raw sky/block light values.
    if (fullScan) {
      for (let dcy = 0; dcy < regionChunks; dcy++) {
        for (let dcx = 0; dcx < regionChunks; dcx++) {
          this._fillScratchChunk(originChunkCX + dcx, originChunkCY + dcy, dcx, dcy, size, scratchSky, scratchBlock, world);
        }
      }
    } else if (partialChunkKeys !== null) {
      for (const key of partialChunkKeys) {
        const comma = key.indexOf(",");
        const cx = Number.parseInt(key.slice(0, comma), 10);
        const cy = Number.parseInt(key.slice(comma + 1), 10);
        const dcx = cx - originChunkCX;
        const dcy = cy - originChunkCY;
        if (dcx >= 0 && dcx < regionChunks && dcy >= 0 && dcy < regionChunks) {
          this._fillScratchChunk(cx, cy, dcx, dcy, size, scratchSky, scratchBlock, world);
        }
      }
    }

    // Pass 2: compute blended indirect light output.
    const pass2ChunkKeys = fullScan ? null : partialChunkKeys;
    if (fullScan) {
      for (let dcy = 0; dcy < regionChunks; dcy++) {
        for (let dcx = 0; dcx < regionChunks; dcx++) {
          this._computeOutputChunk(originChunkCX + dcx, originChunkCY + dcy, dcx, dcy, size, reg, scratchSky, scratchBlock, clamp01, world);
        }
      }
    } else if (pass2ChunkKeys !== null) {
      for (const key of pass2ChunkKeys) {
        const comma = key.indexOf(",");
        const cx = Number.parseInt(key.slice(0, comma), 10);
        const cy = Number.parseInt(key.slice(comma + 1), 10);
        const dcx = cx - originChunkCX;
        const dcy = cy - originChunkCY;
        if (dcx >= 0 && dcx < regionChunks && dcy >= 0 && dcy < regionChunks) {
          this._computeOutputChunk(cx, cy, dcx, dcy, size, reg, scratchSky, scratchBlock, clamp01, world);
        }
      }
    }

    this._allDirty = false;
    this._dirtyChunks.clear();
    this._gpuUploadPending = true;
    return true;
  }

  private _fillScratchChunk(
    ccx: number, ccy: number, dcx: number, dcy: number,
    size: number,
    scratchSky: Uint8Array, scratchBlock: Uint8Array,
    world: World,
  ): void {
    const chunk = world.getChunk(ccx, ccy);
    for (let ly = 0; ly < CHUNK_SIZE; ly++) {
      const row = dcy * CHUNK_SIZE + ly;
      if (row < 0 || row >= size) continue;
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const col = dcx * CHUNK_SIZE + lx;
        if (col < 0 || col >= size) continue;
        const flat = row * size + col;
        if (chunk === undefined) {
          scratchSky[flat] = SKY_LIGHT_MAX;
          scratchBlock[flat] = 0;
        } else {
          const idxLocal = ly * CHUNK_SIZE + lx;
          scratchSky[flat] = chunk.skyLight[idxLocal] ?? 0;
          scratchBlock[flat] = chunk.blockLight[idxLocal] ?? 0;
        }
      }
    }
  }

  private _computeOutputChunk(
    ccx: number, ccy: number, dcx: number, dcy: number,
    size: number,
    reg: { isSolid(id: number): boolean },
    scratchSky: Uint8Array, scratchBlock: Uint8Array,
    clamp01: (v: number) => number,
    world: World,
  ): void {
    const chunk = world.getChunk(ccx, ccy);
    for (let ly = 0; ly < CHUNK_SIZE; ly++) {
      const row = dcy * CHUNK_SIZE + ly;
      if (row < 0 || row >= size) continue;
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const col = dcx * CHUNK_SIZE + lx;
        if (col < 0 || col >= size) continue;
        const flat = row * size + col;
        let skyNorm = 1;
        let blockNorm = 0;
        if (chunk !== undefined) {
          const blockId = getBlock(chunk, lx, ly);
          if (reg.isSolid(blockId)) {
            const ownSky = scratchSky[flat] ?? 0;
            const nL = col > 0 ? scratchSky[flat - 1]! : SKY_LIGHT_MAX;
            const nR = col < size - 1 ? scratchSky[flat + 1]! : SKY_LIGHT_MAX;
            const nU = row > 0 ? scratchSky[flat - size]! : SKY_LIGHT_MAX;
            const nD = row < size - 1 ? scratchSky[flat + size]! : SKY_LIGHT_MAX;
            const maxSky = Math.max(nL, nR, nU, nD);
            const bL = col > 0 ? scratchBlock[flat - 1]! : 0;
            const bR = col < size - 1 ? scratchBlock[flat + 1]! : 0;
            const bU = row > 0 ? scratchBlock[flat - size]! : 0;
            const bD = row < size - 1 ? scratchBlock[flat + size]! : 0;
            const maxBlock = Math.max(bL, bR, bU, bD);
            const blendedSky = Math.min(
              SKY_LIGHT_MAX,
              ownSky * 0.62 + maxSky * 0.38,
            );
            skyNorm = clamp01(blendedSky / SKY_LIGHT_MAX);
            blockNorm = clamp01(maxBlock / BLOCK_LIGHT_MAX);
          } else {
            const idxLocal = ly * CHUNK_SIZE + lx;
            skyNorm = clamp01((chunk.skyLight[idxLocal] ?? SKY_LIGHT_MAX) / SKY_LIGHT_MAX);
            blockNorm = clamp01((chunk.blockLight[idxLocal] ?? 0) / BLOCK_LIGHT_MAX);
          }
        }
        const idx = flat * 2;
        this._data[idx + 0] = Math.round(skyNorm * 255);
        this._data[idx + 1] = Math.round(blockNorm * 255);
      }
    }
  }

  upload(): void {
    if (!this._gpuUploadPending) {
      return;
    }
    this._gpuUploadPending = false;
    this._source.update();
  }

  get originX(): number {
    const halfChunks = Math.floor(IndirectLightTexture.REGION_BLOCKS / CHUNK_SIZE / 2);
    return (this._centerCX - halfChunks) * CHUNK_SIZE;
  }

  get originY(): number {
    const halfChunks = Math.floor(IndirectLightTexture.REGION_BLOCKS / CHUNK_SIZE / 2);
    return (this._centerCY - halfChunks) * CHUNK_SIZE;
  }

  destroy(): void {
    this.texture.destroy(true);
  }
}

