import { BufferImageSource, Texture } from "pixi.js";
import { BLOCK_LIGHT_MAX, CHUNK_SIZE, SKY_LIGHT_MAX } from "../../core/constants";
import type { World } from "../../world/World";
import { getBlock } from "../../world/chunk/Chunk";
import { OcclusionTexture } from "./OcclusionTexture";

/** CPU RG light grid (sky, block) aligned with OcclusionTexture's region. */
export class IndirectLightTexture {
  static readonly REGION_BLOCKS = OcclusionTexture.REGION_BLOCKS;

  private readonly _data: Uint8Array;
  private readonly _source: BufferImageSource;
  readonly texture: Texture;

  private _centerCX = 0;
  private _centerCY = 0;
  private _forceDirty = true;
  private _gpuUploadPending = true;

  constructor() {
    const size = IndirectLightTexture.REGION_BLOCKS;
    this._data = new Uint8Array(size * size * 2);
    this._source = new BufferImageSource({
      resource: this._data,
      width: size,
      height: size,
      format: "rg8unorm",
    });
    this.texture = new Texture({ source: this._source });
    this.texture.source.scaleMode = "linear";
  }

  markDirty(): void {
    this._forceDirty = true;
  }

  rebuild(centerChunkCX: number, centerChunkCY: number, world: World): boolean {
    if (
      !this._forceDirty &&
      centerChunkCX === this._centerCX &&
      centerChunkCY === this._centerCY
    ) {
      return false;
    }
    this._forceDirty = false;
    this._centerCX = centerChunkCX;
    this._centerCY = centerChunkCY;

    const size = IndirectLightTexture.REGION_BLOCKS;
    const regionChunks = OcclusionTexture.REGION_BLOCKS / CHUNK_SIZE;
    const halfChunks = Math.floor(regionChunks / 2);
    const originChunkCX = centerChunkCX - halfChunks;
    const originChunkCY = centerChunkCY - halfChunks;
    const reg = world.getRegistry();

    const clamp01 = (v: number): number => {
      if (v < 0) return 0;
      if (v > 1) return 1;
      return v;
    };

    for (let dcy = 0; dcy < regionChunks; dcy++) {
      for (let dcx = 0; dcx < regionChunks; dcx++) {
        const ccx = originChunkCX + dcx;
        const ccy = originChunkCY + dcy;
        const chunk = world.getChunk(ccx, ccy);
        for (let ly = 0; ly < CHUNK_SIZE; ly++) {
          const row = dcy * CHUNK_SIZE + ly;
          if (row < 0 || row >= size) continue;
          for (let lx = 0; lx < CHUNK_SIZE; lx++) {
            const col = dcx * CHUNK_SIZE + lx;
            if (col < 0 || col >= size) continue;
            let skyNorm = 1;
            let blockNorm = 0;
            if (chunk !== undefined) {
              const blockId = getBlock(chunk, lx, ly);
              if (reg.isSolid(blockId)) {
                const wx = ccx * CHUNK_SIZE + lx;
                const wy = ccy * CHUNK_SIZE + ly;
                const idxLocal = ly * CHUNK_SIZE + lx;
                const ownSky = chunk.skyLight[idxLocal] ?? 0;
                const maxSky = Math.max(
                  world.getSkyLight(wx - 1, wy),
                  world.getSkyLight(wx + 1, wy),
                  world.getSkyLight(wx, wy - 1),
                  world.getSkyLight(wx, wy + 1),
                );
                const maxBlock = Math.max(
                  world.getBlockLight(wx - 1, wy),
                  world.getBlockLight(wx + 1, wy),
                  world.getBlockLight(wx, wy - 1),
                  world.getBlockLight(wx, wy + 1),
                );
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
            const idx = (row * size + col) * 2;
            this._data[idx + 0] = Math.round(skyNorm * 255);
            this._data[idx + 1] = Math.round(blockNorm * 255);
          }
        }
      }
    }
    this._gpuUploadPending = true;
    return true;
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

