/** CPU R8 occlusion grid (solid vs air) for a fixed chunk region, uploaded for ray-march sampling. */
import { BufferImageSource, Texture } from "pixi.js";
import { CHUNK_SIZE } from "../../core/constants";
import { getBlock } from "../../world/chunk/Chunk";
import type { World } from "../../world/World";

const OCCLUSION_REGION_CHUNKS = 7;
const OCCLUSION_REGION_BLOCKS = OCCLUSION_REGION_CHUNKS * CHUNK_SIZE;

export class OcclusionTexture {
  static readonly REGION_BLOCKS = OCCLUSION_REGION_BLOCKS;

  private readonly _data: Uint8Array;
  private readonly _source: BufferImageSource;
  readonly texture: Texture;

  private _centerCX = 0;
  private _centerCY = 0;
  private _forceDirty = true;
  private _gpuUploadPending = true;

  constructor() {
    const size = OcclusionTexture.REGION_BLOCKS;
    this._data = new Uint8Array(size * size);
    this._source = new BufferImageSource({
      resource: this._data,
      width: size,
      height: size,
      format: "r8unorm",
    });
    this.texture = new Texture({ source: this._source });
    this.texture.source.scaleMode = "linear";
  }

  /**
   * Rebuild the occlusion map centered on chunk grid coordinates (centerChunkCX, centerChunkCY).
   * Fills by chunk to avoid per-cell `getBlock` / map churn (~50k calls per frame).
   */
  markDirty(): void {
    this._forceDirty = true;
  }

  /**
   * @returns true if CPU buffer was rebuilt (caller should {@link upload} when true).
   */
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

    const half = Math.floor(OCCLUSION_REGION_CHUNKS / 2);
    const originChunkCX = centerChunkCX - half;
    const originChunkCY = centerChunkCY - half;
    const originWX = originChunkCX * CHUNK_SIZE;
    const originWY = originChunkCY * CHUNK_SIZE;
    const size = OcclusionTexture.REGION_BLOCKS;
    const reg = world.getRegistry();
    const airId = world.getAirBlockId();

    for (let dcy = 0; dcy < OCCLUSION_REGION_CHUNKS; dcy++) {
      for (let dcx = 0; dcx < OCCLUSION_REGION_CHUNKS; dcx++) {
        const ccx = originChunkCX + dcx;
        const ccy = originChunkCY + dcy;
        const chunk = world.getChunk(ccx, ccy);
        for (let ly = 0; ly < CHUNK_SIZE; ly++) {
          for (let lx = 0; lx < CHUNK_SIZE; lx++) {
            const wx = ccx * CHUNK_SIZE + lx;
            const wy = ccy * CHUNK_SIZE + ly;
            const col = wx - originWX;
            const row = wy - originWY;
            const id =
              chunk === undefined ? airId : getBlock(chunk, lx, ly);
            this._data[row * size + col] = reg.isSolid(id) ? 255 : 0;
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
    const half = Math.floor(OCCLUSION_REGION_CHUNKS / 2);
    return (this._centerCX - half) * CHUNK_SIZE;
  }

  get originY(): number {
    const half = Math.floor(OCCLUSION_REGION_CHUNKS / 2);
    return (this._centerCY - half) * CHUNK_SIZE;
  }

  destroy(): void {
    this.texture.destroy(true);
  }
}
