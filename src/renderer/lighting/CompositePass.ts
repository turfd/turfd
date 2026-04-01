/** Fullscreen filter sprite that multiplies albedo by ambient + ray-marched sun from occlusion. */
import {
  Filter,
  GlProgram,
  RenderTexture,
  Sprite,
  UniformGroup,
} from "pixi.js";
import fragSrc from "./shaders/composite.frag.glsl?raw";
import { OcclusionTexture } from "./OcclusionTexture";
import { IndirectLightTexture } from "./IndirectLightTexture";

type CompositeUniformStruct = {
  uSunDir: { value: Float32Array; type: "vec2<f32>" };
  uAmbient: { value: number; type: "f32" };
  uAmbientTint: { value: Float32Array; type: "vec3<f32>" };
  uSkyLightTint: { value: Float32Array; type: "vec3<f32>" };
  uSunIntensity: { value: number; type: "f32" };
  uSunTint: { value: Float32Array; type: "vec3<f32>" };
  uCameraWorld: { value: Float32Array; type: "vec2<f32>" };
  uBlockPixels: { value: number; type: "f32" };
  uOcclusionOrigin: { value: Float32Array; type: "vec2<f32>" };
  uOcclusionSize: { value: number; type: "f32" };
  uMoonDir: { value: Float32Array; type: "vec2<f32>" };
  uMoonIntensity: { value: number; type: "f32" };
  uMoonTint: { value: Float32Array; type: "vec3<f32>" };
  uTorchActive: { value: number; type: "f32" };
  uTorchWorldPos: { value: Float32Array; type: "vec2<f32>" };
  uTorchRadius: { value: number; type: "f32" };
  uTorchIntensity: { value: number; type: "f32" };
  uTorchColor: { value: Float32Array; type: "vec3<f32>" };
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
  sunDir: [number, number];
  ambient: number;
  ambientTint: [number, number, number];
  skyLightTint: [number, number, number];
  sunIntensity: number;
  sunTint: [number, number, number];
  cameraWorld: [number, number];
  blockPixels: number;
  occlusionOrigin: [number, number];
  occlusionSize: number;
  moonDir: [number, number];
  moonIntensity: number;
  moonTint: [number, number, number];
  /** When null, held torch contribution is disabled. */
  heldTorch: {
    worldBlock: [number, number];
    radiusBlocks: number;
    intensity: number;
    color: [number, number, number];
  } | null;
};

export class CompositePass {
  private readonly _filter: Filter;
  private readonly _sprite: Sprite;
  private readonly _uniformGroup: UniformGroup<CompositeUniformStruct>;

  constructor(
    albedoRT: RenderTexture,
    occlusion: OcclusionTexture,
    indirect: IndirectLightTexture,
  ) {
    this._uniformGroup = new UniformGroup<CompositeUniformStruct>({
      uSunDir: { value: new Float32Array(2), type: "vec2<f32>" },
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
      uMoonDir: { value: new Float32Array(2), type: "vec2<f32>" },
      uMoonIntensity: { value: 0, type: "f32" },
      uMoonTint: {
        value: new Float32Array([0.6, 0.7, 1.0]),
        type: "vec3<f32>",
      },
      uTorchActive: { value: 0, type: "f32" },
      uTorchWorldPos: { value: new Float32Array(2), type: "vec2<f32>" },
      uTorchRadius: { value: 12, type: "f32" },
      uTorchIntensity: { value: 0, type: "f32" },
      uTorchColor: {
        value: new Float32Array([1.0, 0.85, 0.55]),
        type: "vec3<f32>",
      },
    });

    const glProgram = GlProgram.from({
      vertex: FILTER_VERT_SRC,
      fragment: fragSrc,
      name: "turfd-composite",
    });

    this._filter = new Filter({
      glProgram,
      resources: {
        compositeUniforms: this._uniformGroup,
        uOcclusion: occlusion.texture.source,
        uIndirectLight: indirect.texture.source,
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
    if (u.uSunDir[0] !== p.sunDir[0] || u.uSunDir[1] !== p.sunDir[1]) {
      u.uSunDir[0] = p.sunDir[0];
      u.uSunDir[1] = p.sunDir[1];
      dirty = true;
    }
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
    if (u.uMoonDir[0] !== p.moonDir[0] || u.uMoonDir[1] !== p.moonDir[1]) {
      u.uMoonDir[0] = p.moonDir[0];
      u.uMoonDir[1] = p.moonDir[1];
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
    this._filter.destroy(true);
    this._sprite.destroy();
  }
}
