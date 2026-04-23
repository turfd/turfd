/** Fullscreen filter sprite that multiplies albedo by ambient + ray-marched sun from occlusion. */
import {
  Filter,
  GlProgram,
  RenderTexture,
  Sprite,
  Texture,
  UniformGroup,
  type TextureSource,
} from "pixi.js";
import { COMPOSITE_FRAGMENT_GLSL } from "./compositeFragmentSource";
import { OcclusionTexture } from "./OcclusionTexture";
import { MAX_PLACED_TORCHES } from "../../core/constants";

function assertCompositeFragmentSource(src: string): string {
  if (typeof src !== "string" || !src.includes("void main")) {
    throw new Error(
      `[CompositePass] Invalid fragment shader module (got ${typeof src}). ` +
        "Clear devtools cache / hard-reload.",
    );
  }
  return src;
}
import { IndirectLightTexture } from "./IndirectLightTexture";

type CompositeUniformStruct = {
  uAmbient: { value: number; type: "f32" };
  uAmbientTint: { value: Float32Array; type: "vec3<f32>" };
  uSkyLightTint: { value: Float32Array; type: "vec3<f32>" };
  uSunIntensity: { value: number; type: "f32" };
  uSunTint: { value: Float32Array; type: "vec3<f32>" };
  uCameraWorld: { value: Float32Array; type: "vec2<f32>" };
  uBlockPixels: { value: number; type: "f32" };
  uOcclusionOrigin: { value: Float32Array; type: "vec2<f32>" };
  uOcclusionSize: { value: number; type: "f32" };
  uMoonIntensity: { value: number; type: "f32" };
  uMoonTint: { value: Float32Array; type: "vec3<f32>" };
  uTorchActive: { value: number; type: "f32" };
  uTorchWorldPos: { value: Float32Array; type: "vec2<f32>" };
  uTorchRadius: { value: number; type: "f32" };
  uTorchIntensity: { value: number; type: "f32" };
  uTorchColor: { value: Float32Array; type: "vec3<f32>" };
  uPlacedTorchCount: { value: number; type: "i32" };
  /** One vec4 per torch (.xy = world flame tip). `size` must be set — Pixi defaults array uniforms to 1. */
  uPlacedTorchPositions: { value: Float32Array; type: "vec4<f32>"; size: number };
  uTonemapper: { value: number; type: "i32" };
  uBloomEnabled: { value: number; type: "f32" };
  uBloomMaskActive: { value: number; type: "f32" };
  /** 1 = multiply torch bloom by UV AABB from local player (same space as sampleUv). */
  uPlayerBloomUvBoundsActive: { value: number; type: "f32" };
  uPlayerBloomUvMin: { value: Float32Array; type: "vec2<f32>" };
  uPlayerBloomUvMax: { value: Float32Array; type: "vec2<f32>" };
  uUvBaseOffset: { value: Float32Array; type: "vec2<f32>" };
  uUvScale: { value: Float32Array; type: "vec2<f32>" };
  uUvSubpixelOffset: { value: Float32Array; type: "vec2<f32>" };
};

const FILTER_VERT_SRC = `in vec2 aPosition;
out vec2 vTextureCoord;

uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform vec4 uOutputTexture;

vec4 filterVertexPosition( void )
{
    vec2 position = aPosition * uOutputFrame.zw + uOutputFrame.xy;
    
    position.x = position.x * (2.0 / uOutputTexture.x) - 1.0;
    position.y = position.y * (2.0*uOutputTexture.z / uOutputTexture.y) - uOutputTexture.z;

    return vec4(position, 0.0, 1.0);
}

vec2 filterTextureCoord( void )
{
    return aPosition * (uOutputFrame.zw * uInputSize.zw);
}

void main(void)
{
    gl_Position = filterVertexPosition();
    vTextureCoord = filterTextureCoord();
}
`;

export type CompositeUniforms = {
  ambient: number;
  ambientTint: [number, number, number];
  skyLightTint: [number, number, number];
  sunIntensity: number;
  sunTint: [number, number, number];
  cameraWorld: [number, number];
  blockPixels: number;
  occlusionOrigin: [number, number];
  occlusionSize: number;
  moonIntensity: number;
  moonTint: [number, number, number];
  /** When null, held torch contribution is disabled. */
  heldTorch: {
    worldBlock: [number, number];
    radiusBlocks: number;
    intensity: number;
    color: [number, number, number];
  } | null;
  /**
   * Nearby placed/dynamic emitters (up to MAX_PLACED_TORCHES).
   * Tuple: [worldX, worldY, strength(0..1+)].
   */
  placedTorches: [number, number, number?][];
  /**
   * How many entries in {@link placedTorches} are valid this frame. When set, preferred over
   * `placedTorches.length` so the buffer can stay preallocated without truncating.
   */
  placedTorchCount?: number;
  /** 0 = none (hard clamp), 1 = ACES, 2 = AgX, 3 = extended Reinhard (luminance). */
  tonemapper: 0 | 1 | 2 | 3;
  bloomEnabled: boolean;
  /** When true, bloom is multiplied by (1 - player silhouette alpha). */
  bloomMaskActive: boolean;
  /** UV offset to the inner, visible rect of the albedo RT (overscan crop). */
  uvBaseOffset: [number, number];
  /** UV scale of the visible rect inside the albedo RT (overscan crop). */
  uvScale: [number, number];
  /** Frame-local camera subpixel shift in albedo UV space. */
  uvSubpixelOffset: [number, number];
  /** When true, torch bloom is suppressed inside the UV rectangle (local player silhouette). */
  playerBloomUvBoundsActive: boolean;
  /** Min corner (U,V) in full albedo texture UV space; see {@link playerBloomUvBoundsActive}. */
  playerBloomUvMin: [number, number];
  /** Max corner (U,V) in full albedo texture UV space. */
  playerBloomUvMax: [number, number];
};

export class CompositePass {
  private readonly _filter: Filter;
  private readonly _sprite: Sprite;
  private readonly _uniformGroup: UniformGroup<CompositeUniformStruct>;

  constructor(
    albedoRT: RenderTexture,
    occlusion: OcclusionTexture,
    indirect: IndirectLightTexture,
    playerBloomMaskSource: TextureSource,
  ) {
    this._uniformGroup = new UniformGroup<CompositeUniformStruct>({
      uAmbient: { value: 1, type: "f32" },
      uAmbientTint: {
        value: new Float32Array([1, 1, 1]),
        type: "vec3<f32>",
      },
      uSkyLightTint: {
        value: new Float32Array([1, 1, 1]),
        type: "vec3<f32>",
      },
      uSunIntensity: { value: 0, type: "f32" },
      uSunTint: {
        value: new Float32Array([1, 1, 1]),
        type: "vec3<f32>",
      },
      uCameraWorld: { value: new Float32Array(2), type: "vec2<f32>" },
      uBlockPixels: { value: 32, type: "f32" },
      uOcclusionOrigin: { value: new Float32Array(2), type: "vec2<f32>" },
      uOcclusionSize: { value: OcclusionTexture.REGION_BLOCKS, type: "f32" },
      uMoonIntensity: { value: 0, type: "f32" },
      uMoonTint: {
        value: new Float32Array([0.6, 0.7, 1.0]),
        type: "vec3<f32>",
      },
      uTorchActive: { value: 0, type: "f32" },
      uTorchWorldPos: { value: new Float32Array(2), type: "vec2<f32>" },
      uTorchRadius: { value: 14, type: "f32" },
      uTorchIntensity: { value: 0, type: "f32" },
      uTorchColor: {
        value: new Float32Array([1.0, 0.85, 0.55]),
        type: "vec3<f32>",
      },
      uPlacedTorchCount: { value: 0, type: "i32" },
      uPlacedTorchPositions: {
        value: new Float32Array(MAX_PLACED_TORCHES * 4),
        type: "vec4<f32>",
        size: MAX_PLACED_TORCHES,
      },
      uTonemapper: { value: 1, type: "i32" },
      uBloomEnabled: { value: 1, type: "f32" },
      uBloomMaskActive: { value: 0, type: "f32" },
      uPlayerBloomUvBoundsActive: { value: 0, type: "f32" },
      uPlayerBloomUvMin: { value: new Float32Array(2), type: "vec2<f32>" },
      uPlayerBloomUvMax: { value: new Float32Array(2), type: "vec2<f32>" },
      uUvBaseOffset: { value: new Float32Array(2), type: "vec2<f32>" },
      uUvScale: { value: new Float32Array([1, 1]), type: "vec2<f32>" },
      uUvSubpixelOffset: { value: new Float32Array(2), type: "vec2<f32>" },
    });

    const fragmentSrc = assertCompositeFragmentSource(COMPOSITE_FRAGMENT_GLSL);
    const glProgram = GlProgram.from({
      vertex: FILTER_VERT_SRC,
      fragment: fragmentSrc,
      name: "stratum-composite",
    });

    this._filter = new Filter({
      glProgram,
      resources: {
        compositeUniforms: this._uniformGroup,
        uOcclusion: occlusion.texture.source,
        uIndirectLight: indirect.texture.source,
        uPlayerBloomMask: playerBloomMaskSource,
      },
      clipToViewport: false,
    });

    this._sprite = new Sprite({ texture: albedoRT });
    this._sprite.eventMode = "none";
    this._sprite.filters = [this._filter];
  }

  updateUniforms(p: CompositeUniforms): void {
    const u = this._uniformGroup.uniforms;
    let dirty = false;
    if (u.uAmbient !== p.ambient) {
      u.uAmbient = p.ambient;
      dirty = true;
    }
    if (
      u.uAmbientTint[0] !== p.ambientTint[0] ||
      u.uAmbientTint[1] !== p.ambientTint[1] ||
      u.uAmbientTint[2] !== p.ambientTint[2]
    ) {
      u.uAmbientTint[0] = p.ambientTint[0];
      u.uAmbientTint[1] = p.ambientTint[1];
      u.uAmbientTint[2] = p.ambientTint[2];
      dirty = true;
    }
    if (
      u.uSkyLightTint[0] !== p.skyLightTint[0] ||
      u.uSkyLightTint[1] !== p.skyLightTint[1] ||
      u.uSkyLightTint[2] !== p.skyLightTint[2]
    ) {
      u.uSkyLightTint[0] = p.skyLightTint[0];
      u.uSkyLightTint[1] = p.skyLightTint[1];
      u.uSkyLightTint[2] = p.skyLightTint[2];
      dirty = true;
    }
    if (u.uSunIntensity !== p.sunIntensity) {
      u.uSunIntensity = p.sunIntensity;
      dirty = true;
    }
    if (
      u.uSunTint[0] !== p.sunTint[0] ||
      u.uSunTint[1] !== p.sunTint[1] ||
      u.uSunTint[2] !== p.sunTint[2]
    ) {
      u.uSunTint[0] = p.sunTint[0];
      u.uSunTint[1] = p.sunTint[1];
      u.uSunTint[2] = p.sunTint[2];
      dirty = true;
    }
    if (
      u.uCameraWorld[0] !== p.cameraWorld[0] ||
      u.uCameraWorld[1] !== p.cameraWorld[1]
    ) {
      u.uCameraWorld[0] = p.cameraWorld[0];
      u.uCameraWorld[1] = p.cameraWorld[1];
      dirty = true;
    }
    if (u.uBlockPixels !== p.blockPixels) {
      u.uBlockPixels = p.blockPixels;
      dirty = true;
    }
    if (
      u.uOcclusionOrigin[0] !== p.occlusionOrigin[0] ||
      u.uOcclusionOrigin[1] !== p.occlusionOrigin[1]
    ) {
      u.uOcclusionOrigin[0] = p.occlusionOrigin[0];
      u.uOcclusionOrigin[1] = p.occlusionOrigin[1];
      dirty = true;
    }
    if (u.uOcclusionSize !== p.occlusionSize) {
      u.uOcclusionSize = p.occlusionSize;
      dirty = true;
    }
    if (u.uMoonIntensity !== p.moonIntensity) {
      u.uMoonIntensity = p.moonIntensity;
      dirty = true;
    }
    if (
      u.uMoonTint[0] !== p.moonTint[0] ||
      u.uMoonTint[1] !== p.moonTint[1] ||
      u.uMoonTint[2] !== p.moonTint[2]
    ) {
      u.uMoonTint[0] = p.moonTint[0];
      u.uMoonTint[1] = p.moonTint[1];
      u.uMoonTint[2] = p.moonTint[2];
      dirty = true;
    }
    if (p.heldTorch !== null) {
      if (u.uTorchActive !== 1) {
        u.uTorchActive = 1;
        dirty = true;
      }
      if (
        u.uTorchWorldPos[0] !== p.heldTorch.worldBlock[0] ||
        u.uTorchWorldPos[1] !== p.heldTorch.worldBlock[1]
      ) {
        u.uTorchWorldPos[0] = p.heldTorch.worldBlock[0];
        u.uTorchWorldPos[1] = p.heldTorch.worldBlock[1];
        dirty = true;
      }
      if (u.uTorchRadius !== p.heldTorch.radiusBlocks) {
        u.uTorchRadius = p.heldTorch.radiusBlocks;
        dirty = true;
      }
      if (u.uTorchIntensity !== p.heldTorch.intensity) {
        u.uTorchIntensity = p.heldTorch.intensity;
        dirty = true;
      }
      if (
        u.uTorchColor[0] !== p.heldTorch.color[0] ||
        u.uTorchColor[1] !== p.heldTorch.color[1] ||
        u.uTorchColor[2] !== p.heldTorch.color[2]
      ) {
        u.uTorchColor[0] = p.heldTorch.color[0];
        u.uTorchColor[1] = p.heldTorch.color[1];
        u.uTorchColor[2] = p.heldTorch.color[2];
        dirty = true;
      }
    } else if (u.uTorchActive !== 0) {
      u.uTorchActive = 0;
      dirty = true;
    }
    const ptCount = Math.min(
      p.placedTorchCount ?? p.placedTorches.length,
      MAX_PLACED_TORCHES,
    );
    if (u.uPlacedTorchCount !== ptCount) {
      u.uPlacedTorchCount = ptCount;
      dirty = true;
    }
    const ptBuf = u.uPlacedTorchPositions;
    for (let i = 0; i < ptCount; i++) {
      const entry = p.placedTorches[i];
      if (entry === undefined) {
        continue;
      }
      const px = entry[0];
      const py = entry[1];
      const strength = entry[2] ?? 1;
      const b = i * 4;
      if (ptBuf[b] !== px || ptBuf[b + 1] !== py || ptBuf[b + 2] !== strength) {
        ptBuf[b] = px;
        ptBuf[b + 1] = py;
        ptBuf[b + 2] = strength;
        ptBuf[b + 3] = 0;
        dirty = true;
      }
    }
    if (u.uTonemapper !== p.tonemapper) {
      u.uTonemapper = p.tonemapper;
      dirty = true;
    }
    const bloomVal = p.bloomEnabled ? 1 : 0;
    if (u.uBloomEnabled !== bloomVal) {
      u.uBloomEnabled = bloomVal;
      dirty = true;
    }
    const bma = p.bloomMaskActive ? 1 : 0;
    if (u.uBloomMaskActive !== bma) {
      u.uBloomMaskActive = bma;
      dirty = true;
    }
    const pbba = p.playerBloomUvBoundsActive ? 1 : 0;
    if (u.uPlayerBloomUvBoundsActive !== pbba) {
      u.uPlayerBloomUvBoundsActive = pbba;
      dirty = true;
    }
    if (
      u.uPlayerBloomUvMin[0] !== p.playerBloomUvMin[0] ||
      u.uPlayerBloomUvMin[1] !== p.playerBloomUvMin[1]
    ) {
      u.uPlayerBloomUvMin[0] = p.playerBloomUvMin[0];
      u.uPlayerBloomUvMin[1] = p.playerBloomUvMin[1];
      dirty = true;
    }
    if (
      u.uPlayerBloomUvMax[0] !== p.playerBloomUvMax[0] ||
      u.uPlayerBloomUvMax[1] !== p.playerBloomUvMax[1]
    ) {
      u.uPlayerBloomUvMax[0] = p.playerBloomUvMax[0];
      u.uPlayerBloomUvMax[1] = p.playerBloomUvMax[1];
      dirty = true;
    }
    if (
      u.uUvBaseOffset[0] !== p.uvBaseOffset[0] ||
      u.uUvBaseOffset[1] !== p.uvBaseOffset[1]
    ) {
      u.uUvBaseOffset[0] = p.uvBaseOffset[0];
      u.uUvBaseOffset[1] = p.uvBaseOffset[1];
      dirty = true;
    }
    if (u.uUvScale[0] !== p.uvScale[0] || u.uUvScale[1] !== p.uvScale[1]) {
      u.uUvScale[0] = p.uvScale[0];
      u.uUvScale[1] = p.uvScale[1];
      dirty = true;
    }
    if (
      u.uUvSubpixelOffset[0] !== p.uvSubpixelOffset[0] ||
      u.uUvSubpixelOffset[1] !== p.uvSubpixelOffset[1]
    ) {
      u.uUvSubpixelOffset[0] = p.uvSubpixelOffset[0];
      u.uUvSubpixelOffset[1] = p.uvSubpixelOffset[1];
      dirty = true;
    }
    if (dirty) {
      this._uniformGroup.update();
    }
  }

  get displayObject(): Sprite {
    return this._sprite;
  }

  resize(width: number, height: number): void {
    this._sprite.width = width;
    this._sprite.height = height;
  }

  destroy(): void {
    // Pixi `GlProgram.from()` returns a **global singleton** per (vertex, fragment) source.
    // Loading UI ({@link MenuBackground}) and gameplay ({@link LightingComposer}) both use this
    // pass with identical sources. `filter.destroy(true)` calls `GlProgram.destroy()`, which
    // nulls `vertex`/`fragment` on that shared object — the surviving game's filter still
    // references it → WebGL compiles the literal "null" and terrain disappears until GL reset.
    this._filter.destroy(false);
    this._sprite.destroy();
  }
}

/** Placeholder bind for `uPlayerBloomMask` when no RT exists (e.g. menu). */
export function emptyBloomMaskSource(): TextureSource {
  return Texture.EMPTY.source;
}
