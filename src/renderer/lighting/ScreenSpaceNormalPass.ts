/**
 * Full-resolution normals from the **main albedo** buffer (same texture the composite lights).
 * Height = luminance detail → optional blur → Sobel normals. No EDT / quarter-res (avoids drift & bevel blobs).
 */
import {
  Container,
  Filter,
  GlProgram,
  RenderTexture,
  Sprite,
  Texture,
  UniformGroup,
  type Renderer,
  type TextureSource,
} from "pixi.js";
import {
  SSN_BLUR_HEIGHT_FRAG,
  SSN_FILTER_VERT,
  SSN_HEIGHT_FROM_ALBEDO_FRAG,
  SSN_NORMAL_FRAG,
} from "./screenSpaceNormalShaders";

const MAX_BLUR_RADIUS = 10;
const ALPHA_CUTOFF = 10 / 255;

export type ScreenSpaceNormalParams = {
  bevel: number;
  strength: number;
  smooth: number;
  detail: number;
  invertX: boolean;
  invertY: boolean;
};

export const DEFAULT_SCREEN_SPACE_NORMAL_PARAMS: ScreenSpaceNormalParams = {
  bevel: 4,
  strength: 2.5,
  smooth: 1,
  detail: 0.2,
  invertX: false,
  invertY: false,
};

type F32 = { value: number; type: "f32" };
type Vec2F32 = { value: Float32Array; type: "vec2<f32>" };
type I32 = { value: number; type: "i32" };

function makeRT(w: number, h: number, resolution: number): RenderTexture {
  return RenderTexture.create({
    width: w,
    height: h,
    resolution,
    dynamic: true,
  });
}

export class ScreenSpaceNormalPass {
  private readonly _renderer: Renderer;
  private readonly _root = new Container();
  private readonly _sprite = new Sprite();

  private _fullW = 1;
  private _fullH = 1;
  /** Must match {@link Renderer#resolution} so RT pixels align with albedo / filter uniforms. */
  private _resolution = 1;

  private _heightA: RenderTexture;
  private _heightB: RenderTexture;
  private readonly _normalFull: RenderTexture;

  private readonly _filterHeight: Filter;
  private readonly _filterBlur: Filter;
  private readonly _filterNormal: Filter;

  private readonly _uHeight: UniformGroup<{
    uAlphaCutoff: F32;
    uDetail: F32;
  }>;
  private readonly _uBlur: UniformGroup<{
    uDirection: Vec2F32;
    uTexel: Vec2F32;
    uRadius: I32;
  }>;
  private readonly _uNormal: UniformGroup<{
    uTexel: Vec2F32;
    uStrength: F32;
    uInvertX: F32;
    uInvertY: F32;
  }>;

  constructor(renderer: Renderer) {
    this._renderer = renderer;

    this._uHeight = new UniformGroup({
      uAlphaCutoff: { value: ALPHA_CUTOFF, type: "f32" },
      uDetail: { value: 0.2, type: "f32" },
    });
    this._uBlur = new UniformGroup({
      uDirection: { value: new Float32Array([1, 0]), type: "vec2<f32>" },
      uTexel: { value: new Float32Array([1, 1]), type: "vec2<f32>" },
      uRadius: { value: 0, type: "i32" },
    });
    this._uNormal = new UniformGroup({
      uTexel: { value: new Float32Array([1, 1]), type: "vec2<f32>" },
      uStrength: { value: 2.5, type: "f32" },
      uInvertX: { value: 1, type: "f32" },
      uInvertY: { value: 1, type: "f32" },
    });

    this._filterHeight = new Filter({
      glProgram: GlProgram.from({
        vertex: SSN_FILTER_VERT,
        fragment: SSN_HEIGHT_FROM_ALBEDO_FRAG,
        name: "stratum-ssn-height",
      }),
      resources: { ssnHeightU: this._uHeight },
      antialias: "off",
      clipToViewport: false,
      resolution: renderer.resolution,
    });

    this._filterBlur = new Filter({
      glProgram: GlProgram.from({
        vertex: SSN_FILTER_VERT,
        fragment: SSN_BLUR_HEIGHT_FRAG,
        name: "stratum-ssn-blur-h",
      }),
      resources: { ssnBlurU: this._uBlur },
      antialias: "off",
      clipToViewport: false,
      resolution: renderer.resolution,
    });

    this._filterNormal = new Filter({
      glProgram: GlProgram.from({
        vertex: SSN_FILTER_VERT,
        fragment: SSN_NORMAL_FRAG,
        name: "stratum-ssn-normal",
      }),
      resources: {
        ssnNormalU: this._uNormal,
        uAlbedo: Texture.EMPTY.source,
      },
      antialias: "off",
      clipToViewport: false,
      resolution: renderer.resolution,
    });

    const r0 = renderer.resolution;
    this._resolution = r0;
    this._heightA = makeRT(1, 1, r0);
    this._heightB = makeRT(1, 1, r0);
    this._normalFull = makeRT(1, 1, r0);
    // Match albedo RT: nearest in {@link CompositePass} so N·L samples align at edges (linear skews there).
    this._normalFull.source.scaleMode = "nearest";

    this._root.addChild(this._sprite);
  }

  /** Full-resolution normal map for {@link CompositePass} (RGBA, tangent normals). */
  get output(): TextureSource {
    return this._normalFull.source;
  }

  /**
   * @param resolution — when omitted, uses {@link Renderer#resolution}. Prefer passing the
   * source resolution of the terrain/albedo RT so internal RTs match the bound texture exactly.
   */
  resize(fullW: number, fullH: number, resolution?: number): void {
    this._fullW = Math.max(1, fullW);
    this._fullH = Math.max(1, fullH);
    this._resolution = resolution ?? this._renderer.resolution;

    const res = this._resolution;
    const resizeRT = (rt: RenderTexture, w: number, h: number): void => {
      if (
        rt.width !== w ||
        rt.height !== h ||
        rt.source.resolution !== res
      ) {
        rt.resize(w, h, res);
      }
    };

    resizeRT(this._heightA, this._fullW, this._fullH);
    resizeRT(this._heightB, this._fullW, this._fullH);
    resizeRT(this._normalFull, this._fullW, this._fullH);

    this._filterHeight.resolution = res;
    this._filterBlur.resolution = res;
    this._filterNormal.resolution = res;

    const pw = Math.max(1, Math.round(this._fullW * res));
    const ph = Math.max(1, Math.round(this._fullH * res));
    const tx = 1 / pw;
    const ty = 1 / ph;
    this._uBlur.uniforms.uTexel[0] = tx;
    this._uBlur.uniforms.uTexel[1] = ty;
    this._uBlur.update();
    this._uNormal.uniforms.uTexel[0] = tx;
    this._uNormal.uniforms.uTexel[1] = ty;
    this._uNormal.update();
  }

  /**
   * @param sceneAlbedo — gameplay albedo RT after the world pass (same pixels as {@link CompositePass} input).
   */
  update(sceneAlbedo: RenderTexture, p: ScreenSpaceNormalParams): void {
    // Match the **actual** RenderTexture dimensions (logical × resolution). Using renderer.width
    // alone can differ by a pixel from `texture.source.width`, which stretches the filter quad
    // and misaligns the normal RT vs albedo in the composite (same UV, different pixel grids).
    const src = sceneAlbedo.source;
    // Use RenderTexture logical size (matches composite filter primary texture).
    const lw = Math.max(1, Math.round(sceneAlbedo.width));
    const lh = Math.max(1, Math.round(sceneAlbedo.height));
    const res = src.resolution;
    if (
      lw !== this._fullW ||
      lh !== this._fullH ||
      res !== this._resolution
    ) {
      this.resize(lw, lh, res);
    }

    const fw = this._fullW;
    const fh = this._fullH;

    this._uHeight.uniforms.uDetail = p.detail;
    this._uHeight.update();

    const blurR = Math.min(
      MAX_BLUR_RADIUS,
      Math.max(0, Math.floor(p.smooth + p.bevel * 0.5)),
    );
    this._uBlur.uniforms.uRadius = blurR;
    this._uBlur.update();

    this._uNormal.uniforms.uStrength = p.strength;
    this._uNormal.uniforms.uInvertX = p.invertX ? -1 : 1;
    this._uNormal.uniforms.uInvertY = p.invertY ? -1 : 1;
    this._uNormal.update();

    this._sprite.texture = sceneAlbedo;
    this._sprite.width = fw;
    this._sprite.height = fh;
    this._sprite.filters = [this._filterHeight];
    this._renderer.render({
      container: this._root,
      target: this._heightA,
      clear: true,
      clearColor: "rgba(0,0,0,0)",
    });

    let hRead: RenderTexture = this._heightA;
    let hWrite: RenderTexture = this._heightB;
    this._sprite.filters = [this._filterBlur];
    if (blurR > 0) {
      this._uBlur.uniforms.uDirection[0] = 1;
      this._uBlur.uniforms.uDirection[1] = 0;
      this._uBlur.update();
      this._sprite.texture = hRead;
      this._renderer.render({
        container: this._root,
        target: hWrite,
        clear: true,
        clearColor: "rgba(0,0,0,0)",
      });
      hRead = hWrite;
      hWrite = hRead === this._heightA ? this._heightB : this._heightA;

      this._uBlur.uniforms.uDirection[0] = 0;
      this._uBlur.uniforms.uDirection[1] = 1;
      this._uBlur.update();
      this._sprite.texture = hRead;
      this._renderer.render({
        container: this._root,
        target: hWrite,
        clear: true,
        clearColor: "rgba(0,0,0,0)",
      });
      hRead = hWrite;
    }

    (this._filterNormal.resources as { uAlbedo: TextureSource }).uAlbedo =
      sceneAlbedo.source;
    this._sprite.texture = hRead;
    this._sprite.filters = [this._filterNormal];
    this._renderer.render({
      container: this._root,
      target: this._normalFull,
      clear: true,
      clearColor: "rgba(0,0,0,0)",
    });
  }

  destroy(): void {
    this._filterHeight.destroy(false);
    this._filterBlur.destroy(false);
    this._filterNormal.destroy(false);
    this._sprite.destroy();
    this._root.destroy({ children: true });
    this._heightA.destroy(true);
    this._heightB.destroy(true);
    this._normalFull.destroy(true);
  }
}
