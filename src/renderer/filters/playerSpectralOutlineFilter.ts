import { Filter, GlProgram, GpuProgram, UniformGroup } from "pixi.js";

const VERT = `in vec2 aPosition;
out vec2 vTextureCoord;
uniform highp vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform vec4 uOutputTexture;
vec4 filterVertexPosition(void){
  vec2 position = aPosition * uOutputFrame.zw + uOutputFrame.xy;
  position.x = position.x * (2.0 / uOutputTexture.x) - 1.0;
  position.y = position.y * (2.0 * uOutputTexture.z / uOutputTexture.y) - uOutputTexture.z;
  return vec4(position, 0.0, 1.0);
}
vec2 filterTextureCoord(void){
  return aPosition * (uOutputFrame.zw * uInputSize.zw);
}
void main(void){
  gl_Position = filterVertexPosition();
  vTextureCoord = filterTextureCoord();
}`;

const FRAG = `in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform highp vec4 uInputSize;
uniform vec3 uGlowColor;
uniform float uOuterRadius;
uniform float uInnerRadius;
uniform float uOuterAlpha;
uniform float uInnerAlpha;
void main(void){
  vec4 src = texture(uTexture, vTextureCoord);
  /* Per-pixel UV step (same as WGSL path); avoids dFdx/dFdy which need
   * GL_OES_standard_derivatives on WebGL1 and break some GL backends. */
  vec2 px = max(uInputSize.zw, vec2(0.001));
  const float SOLID = 0.45;
  float dMin = 99.0;
  for (int ox = -6; ox <= 6; ox++) {
    for (int oy = -6; oy <= 6; oy++) {
      vec2 o = vec2(float(ox), float(oy));
      float d = length(o);
      if (d > uOuterRadius + 0.5) continue;
      vec4 s = texture(uTexture, vTextureCoord + o * px);
      if (s.a > SOLID) {
        dMin = min(dMin, d);
      }
    }
  }
  if (src.a > SOLID) {
    finalColor = src;
    return;
  }
  if (dMin > 90.0) {
    finalColor = src;
    return;
  }
  float omask = (1.0 - src.a);
  float Wc = max(uInnerRadius, 0.16);
  float Wb = 2.0 * Wc;
  float dOuter = Wc + Wb;
  float Ac = (1.0 - smoothstep(0.0, Wc, dMin)) * uOuterAlpha * omask;
  float Ab =
    smoothstep(Wc * 0.88, Wc + 0.12, dMin) *
    (1.0 - smoothstep(dOuter - 0.4, dOuter + 0.35, dMin)) *
    uInnerAlpha *
    omask;
  float Oa = Ac + Ab * (1.0 - Ac);
  vec3 premultO = uGlowColor * Ac;
  float Sa = src.a;
  vec3 Srgb = src.rgb;
  float Ra = Oa + Sa * (1.0 - Oa);
  vec3 Rrgb = premultO + Srgb * Sa * (1.0 - Oa);
  vec3 straight = Ra > 1e-4 ? clamp(Rrgb / Ra, 0.0, 1.0) : vec3(0.0);
  finalColor = vec4(straight, clamp(Ra, 0.0, 1.0));
}`;

const WGSL = `struct GlobalFilterUniforms {
  uInputSize: vec4<f32>,
  uInputPixel: vec4<f32>,
  uInputClamp: vec4<f32>,
  uOutputFrame: vec4<f32>,
  uGlobalFrame: vec4<f32>,
  uOutputTexture: vec4<f32>,
};
struct OutlineUniformStruct {
  uGlowColor: vec3<f32>,
  uOuterRadius: f32,
  uInnerRadius: f32,
  uOuterAlpha: f32,
  uInnerAlpha: f32,
};
@group(0) @binding(0) var<uniform> gfu: GlobalFilterUniforms;
@group(0) @binding(1) var uTexture: texture_2d<f32>;
@group(0) @binding(2) var uSampler: sampler;
@group(1) @binding(0) var<uniform> outlineUniforms: OutlineUniformStruct;
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
  let src = textureSample(uTexture, uSampler, uv);
  let px = max(gfu.uInputSize.zw, vec2<f32>(0.001));
  let SOLID = 0.45;
  var dMin = 99.0;
  for (var ox = -6; ox <= 6; ox++) {
    for (var oy = -6; oy <= 6; oy++) {
      let o = vec2<f32>(f32(ox), f32(oy));
      let d = length(o);
      if (d > outlineUniforms.uOuterRadius + 0.5) { continue; }
      let s = textureSample(uTexture, uSampler, uv + o * px);
      if (s.a > SOLID) { dMin = min(dMin, d); }
    }
  }
  if (src.a > SOLID) { return src; }
  if (dMin > 90.0) { return src; }
  let omask = 1.0 - src.a;
  let Wc = max(outlineUniforms.uInnerRadius, 0.16);
  let Wb = 2.0 * Wc;
  let dOuter = Wc + Wb;
  let Ac = (1.0 - smoothstep(0.0, Wc, dMin)) * outlineUniforms.uOuterAlpha * omask;
  let Ab =
    smoothstep(Wc * 0.88, Wc + 0.12, dMin) *
    (1.0 - smoothstep(dOuter - 0.4, dOuter + 0.35, dMin)) *
    outlineUniforms.uInnerAlpha *
    omask;
  let Oa = Ac + Ab * (1.0 - Ac);
  let premultO = outlineUniforms.uGlowColor * Ac;
  let Sa = src.a;
  let Srgb = src.rgb;
  var Ra = Oa + Sa * (1.0 - Oa);
  var Rrgb = premultO + Srgb * Sa * (1.0 - Oa);
  let straight = select(vec3<f32>(0.0), clamp(Rrgb / Ra, vec3<f32>(0.0), vec3<f32>(1.0)), Ra > 0.0001);
  return vec4<f32>(straight, clamp(Ra, 0.0, 1.0));
}`;

type OutlineUniforms = {
  uGlowColor: { value: [number, number, number]; type: "vec3<f32>" };
  uOuterRadius: { value: number; type: "f32" };
  uInnerRadius: { value: number; type: "f32" };
  uOuterAlpha: { value: number; type: "f32" };
  uInnerAlpha: { value: number; type: "f32" };
};

let cachedGl: GlProgram | null = null;
let cachedGpu: GpuProgram | null = null;

function glProgram(): GlProgram {
  if (cachedGl === null) {
    cachedGl = GlProgram.from({
      vertex: VERT,
      fragment: FRAG,
      name: "stratum-player-outline-v2",
    });
  }
  return cachedGl;
}
function gpuProgram(): GpuProgram {
  if (cachedGpu === null) {
    cachedGpu = GpuProgram.from({
      vertex: { source: WGSL, entryPoint: "mainVertex" },
      fragment: { source: WGSL, entryPoint: "mainFragment" },
      name: "stratum-player-outline",
    });
  }
  return cachedGpu;
}

/** Mutates filter uniforms so live outline color updates without rebuilding the filter. */
export function updateSpectralOutlineGlowColor(filter: Filter, colorHex: number): void {
  const group = (
    filter as unknown as {
      resources?: { outlineUniforms?: { uniforms?: { uGlowColor?: number[] } } };
    }
  ).resources?.outlineUniforms?.uniforms?.uGlowColor;
  if (group === undefined || group.length < 3) {
    return;
  }
  const r = ((colorHex >> 16) & 0xff) / 255;
  const g = ((colorHex >> 8) & 0xff) / 255;
  const b = (colorHex & 0xff) / 255;
  group[0] = r;
  group[1] = g;
  group[2] = b;
}

export function createPlayerSpectralOutlineFilter(colorHex: number): Filter {
  const r = ((colorHex >> 16) & 0xff) / 255;
  const g = ((colorHex >> 8) & 0xff) / 255;
  const b = (colorHex & 0xff) / 255;
  const outlineUniforms = new UniformGroup<OutlineUniforms>({
    uGlowColor: { value: [r, g, b], type: "vec3<f32>" },
    /** Neighbour search radius (grid steps); keep ≥ Wc + Wb + 1. */
    uOuterRadius: { value: 5.0, type: "f32" },
    /** Color band: glow alpha fades from silhouette to 0 over [0, Wc]; black occupies the next 2×Wc. */
    uInnerRadius: { value: 1.05, type: "f32" },
    uOuterAlpha: { value: 0.96, type: "f32" },
    uInnerAlpha: { value: 0.98, type: "f32" },
  });
  return new Filter({
    glProgram: glProgram(),
    gpuProgram: gpuProgram(),
    resources: { outlineUniforms },
    antialias: "off",
    /** Default 0 clips the halo where the filter samples outside sprite bounds (esp. top/bottom). */
    padding: 24,
    clipToViewport: false,
  });
}
