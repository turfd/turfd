import { Filter, GlProgram, GpuProgram, UniformGroup } from "pixi.js";
import { SLIME_SPRITE_ALPHA } from "./mobConstants";

/** Same filter vertex as Pixi default filters / {@link CompositePass}. */
const SLIME_FILTER_VERT = `in vec2 aPosition;
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

/**
 * Perceived darkness (after unpremultiply): low = eyes/outline, high = bright jelly.
 * smoothstep(sh0, sh1, 1.0 - lum) → 1 on dark features (keep alpha), 0 on highlights (gel alpha).
 */
const SLIME_GEL_SHADOW_SMOOTH0 = 0.1;
const SLIME_GEL_SHADOW_SMOOTH1 = 0.56;

const SLIME_GEL_ALPHA_FRAG = `in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform float uBodyAlpha;
uniform float uShadow0;
uniform float uShadow1;

void main(void)
{
    vec4 c = texture(uTexture, vTextureCoord);
    // Kill fringe/halo from filter RT edge bleed and AA (unpremul math blows up near a≈0).
    if (c.a < 0.02) {
        finalColor = vec4(0.0);
        return;
    }
    float a0 = c.a;
    vec3 lin = c.rgb / a0;
    float lum = dot(lin, vec3(0.299, 0.587, 0.114));
    float shadow = smoothstep(uShadow0, uShadow1, 1.0 - lum);
    float aOut = mix(a0 * uBodyAlpha, a0, shadow);
    finalColor = vec4(lin * aOut, aOut);
}
`;

const SLIME_FILTER_WGSL = `struct GlobalFilterUniforms {
  uInputSize: vec4<f32>,
  uInputPixel: vec4<f32>,
  uInputClamp: vec4<f32>,
  uOutputFrame: vec4<f32>,
  uGlobalFrame: vec4<f32>,
  uOutputTexture: vec4<f32>,
};

struct SlimeGelUniformStruct {
  uBodyAlpha: f32,
  uShadow0: f32,
  uShadow1: f32,
};

@group(0) @binding(0) var<uniform> gfu: GlobalFilterUniforms;
@group(0) @binding(1) var uTexture: texture_2d<f32>;
@group(0) @binding(2) var uSampler: sampler;
@group(1) @binding(0) var<uniform> slimeGelUniforms: SlimeGelUniformStruct;

struct VSOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

fn filterVertexPosition(aPosition: vec2<f32>) -> vec4<f32> {
  var position = aPosition * gfu.uOutputFrame.zw + gfu.uOutputFrame.xy;
  position.x = position.x * (2.0 / gfu.uOutputTexture.x) - 1.0;
  position.y = position.y * (2.0 * gfu.uOutputTexture.z / gfu.uOutputTexture.y) - gfu.uOutputTexture.z;
  return vec4<f32>(position, 0.0, 1.0);
}

fn filterTextureCoord(aPosition: vec2<f32>) -> vec2<f32> {
  return aPosition * (gfu.uOutputFrame.zw * gfu.uInputSize.zw);
}

@vertex
fn mainVertex(@location(0) aPosition: vec2<f32>) -> VSOutput {
  return VSOutput(filterVertexPosition(aPosition), filterTextureCoord(aPosition));
}

@fragment
fn mainFragment(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
  let c = textureSample(uTexture, uSampler, uv);
  if (c.a < 0.02) {
    return vec4<f32>(0.0);
  }
  let a0 = c.a;
  let lin = c.rgb / a0;
  let lum = dot(lin, vec3<f32>(0.299, 0.587, 0.114));
  let shadow = smoothstep(
    slimeGelUniforms.uShadow0,
    slimeGelUniforms.uShadow1,
    1.0 - lum,
  );
  let aOut = mix(a0 * slimeGelUniforms.uBodyAlpha, a0, shadow);
  return vec4<f32>(lin * aOut, aOut);
}
`;

type SlimeGelUniforms = {
  uBodyAlpha: { value: number; type: "f32" };
  uShadow0: { value: number; type: "f32" };
  uShadow1: { value: number; type: "f32" };
};

let cachedGlProgram: GlProgram | null = null;
let cachedGpuProgram: GpuProgram | null = null;

function slimeGelGlProgram(): GlProgram {
  if (cachedGlProgram === null) {
    cachedGlProgram = GlProgram.from({
      vertex: SLIME_FILTER_VERT,
      fragment: SLIME_GEL_ALPHA_FRAG,
      name: "stratum-slime-gel-alpha",
    });
  }
  return cachedGlProgram;
}

function slimeGelGpuProgram(): GpuProgram {
  if (cachedGpuProgram === null) {
    cachedGpuProgram = GpuProgram.from({
      vertex: { source: SLIME_FILTER_WGSL, entryPoint: "mainVertex" },
      fragment: { source: SLIME_FILTER_WGSL, entryPoint: "mainFragment" },
      name: "stratum-slime-gel-alpha",
    });
  }
  return cachedGpuProgram;
}

/** One filter instance per slime sprite (shared GL program under the hood). */
export function createSlimeGelAlphaFilter(): Filter {
  const slimeGelUniforms = new UniformGroup<SlimeGelUniforms>({
    uBodyAlpha: { value: SLIME_SPRITE_ALPHA, type: "f32" },
    uShadow0: { value: SLIME_GEL_SHADOW_SMOOTH0, type: "f32" },
    uShadow1: { value: SLIME_GEL_SHADOW_SMOOTH1, type: "f32" },
  });
  return new Filter({
    gpuProgram: slimeGelGpuProgram(),
    glProgram: slimeGelGlProgram(),
    resources: {
      slimeGelUniforms,
    },
    antialias: "off",
    clipToViewport: true,
  });
}
