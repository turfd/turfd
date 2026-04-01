/** CPU RGBA buffer and Pixi BufferImageSource for one chunk’s sky + block light texels. */
import { Texture, BufferImageSource } from "pixi.js";
import { CHUNK_SIZE } from "../../core/constants";

export class LightTexture {
  /** Width and height in texels — one texel per block. */
  static readonly SIZE = CHUNK_SIZE;

  private readonly _data: Uint8Array;
  private readonly _source: BufferImageSource;
  readonly texture: Texture;

  constructor() {
    const count = LightTexture.SIZE * LightTexture.SIZE;
    this._data = new Uint8Array(count * 4);
    for (let i = 0; i < count; i++) {
      this._data[i * 4 + 0] = 255;
      this._data[i * 4 + 1] = 0;
      this._data[i * 4 + 2] = 0;
      this._data[i * 4 + 3] = 255;
    }
    this._source = new BufferImageSource({
      resource: this._data,
      width: LightTexture.SIZE,
      height: LightTexture.SIZE,
    });
    this.texture = new Texture({ source: this._source });
  }

  /**
   * Write sky and block light arrays into the RGBA texture data.
   * skyLight and blockLight are Uint8Arrays of length CHUNK_SIZE².
   * Values are in [0, 15]; mapped to [0, 255] by multiplying by 17.
   * @returns true if any texel changed (caller may skip {@link upload} when false).
   */
  update(skyLight: Uint8Array, blockLight: Uint8Array): boolean {
    const count = LightTexture.SIZE * LightTexture.SIZE;
    let changed = false;
    for (let i = 0; i < count; i++) {
      const r = (skyLight[i] ?? 0) * 17;
      const g = (blockLight[i] ?? 0) * 17;
      const o = i * 4;
      if (
        this._data[o + 0] !== r ||
        this._data[o + 1] !== g ||
        this._data[o + 2] !== 0 ||
        this._data[o + 3] !== 255
      ) {
        changed = true;
      }
      this._data[o + 0] = r;
      this._data[o + 1] = g;
      this._data[o + 2] = 0;
      this._data[o + 3] = 255;
    }
    return changed;
  }

  /** Push the CPU buffer to the GPU texture. */
  upload(): void {
    this._source.update();
  }

  destroy(): void {
    this.texture.destroy(true);
  }
}
