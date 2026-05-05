/**
 * WGSL for {@link CompositePass} WebGPU path. Mirrors {@link compositeFragmentSource.ts};
 * keep both in sync when changing lighting math.
 */
import { MAX_PLACED_TORCHES } from "../../core/constants";

export const COMPOSITE_FILTER_WGSL = `struct GlobalFilterUniforms {
  uInputSize: vec4<f32>,
  uInputPixel: vec4<f32>,
  uInputClamp: vec4<f32>,
  uOutputFrame: vec4<f32>,
  uGlobalFrame: vec4<f32>,
  uOutputTexture: vec4<f32>,
};

struct CompositeUniformStruct {
  uAmbient: f32,
  uAmbientTint: vec3<f32>,
  uSkyLightTint: vec3<f32>,
  uSunIntensity: f32,
  uSunTint: vec3<f32>,
  uCameraWorld: vec2<f32>,
  uBlockPixels: f32,
  uOcclusionOrigin: vec2<f32>,
  uOcclusionSize: f32,
  uMoonIntensity: f32,
  uMoonTint: vec3<f32>,
  uTorchActive: f32,
  uTorchWorldPos: vec2<f32>,
  uTorchRadius: f32,
  uTorchIntensity: f32,
  uTorchColor: vec3<f32>,
  uPlacedTorchCount: i32,
  uPlacedTorchPositions: array<vec4<f32>, ${MAX_PLACED_TORCHES}>,
  uTonemapper: i32,
  uBloomEnabled: f32,
  uBloomMaskActive: f32,
  uPlayerBloomUvBoundsActive: f32,
  uPlayerBloomUvMin: vec2<f32>,
  uPlayerBloomUvMax: vec2<f32>,
  uUvBaseOffset: vec2<f32>,
  uUvScale: vec2<f32>,
  uUvSubpixelOffset: vec2<f32>,
  uLightingQuality: i32,
};

@group(0) @binding(0) var<uniform> gfu: GlobalFilterUniforms;
@group(0) @binding(1) var uTexture: texture_2d<f32>;
@group(0) @binding(2) var uSampler: sampler;
@group(1) @binding(0) var<uniform> compositeUniforms: CompositeUniformStruct;
@group(1) @binding(1) var uOcclusion: texture_2d<f32>;
@group(1) @binding(2) var uOcclusionSampler: sampler;
@group(1) @binding(3) var uIndirectLight: texture_2d<f32>;
@group(1) @binding(4) var uIndirectLightSampler: sampler;
@group(1) @binding(5) var uPlayerBloomMask: texture_2d<f32>;
@group(1) @binding(6) var uPlayerBloomMaskSampler: sampler;

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

const SHADOW_FLOOR_DAY: f32 = 0.20;
const SHADOW_FLOOR_NIGHT: f32 = 0.34;

fn ACESFilm(x: vec3<f32>) -> vec3<f32> {
  let a = 2.51;
  let b = 0.03;
  let c = 2.43;
  let d = 0.59;
  let e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), vec3<f32>(0.0), vec3<f32>(1.0));
}

fn ACESPostDisplay(c: vec3<f32>) -> vec3<f32> {
  var o = clamp(c, vec3<f32>(0.0), vec3<f32>(1.0));
  let lum = dot(o, vec3<f32>(0.2126, 0.7152, 0.0722));
  let hi = smoothstep(0.52, 0.88, lum);
  o = mix(o, vec3<f32>(lum), hi * 0.2);
  o = pow(o, vec3<f32>(0.95));
  return clamp(o, vec3<f32>(0.0), vec3<f32>(1.0));
}

fn ACESFilmTonemap(hdr: vec3<f32>) -> vec3<f32> {
  let preExposure = 0.87;
  return ACESPostDisplay(ACESFilm(hdr * preExposure));
}

fn ExtendedReinhardToneMap(color: vec3<f32>) -> vec3<f32> {
  let WHITE_POINT = 1.25;
  let luminance = dot(color, vec3<f32>(0.2126, 0.7152, 0.0722));
  let mult = (1.0 + luminance * (1.0 / (WHITE_POINT * WHITE_POINT))) / (1.0 + luminance);
  return clamp(color * mult, vec3<f32>(0.0), vec3<f32>(1.0));
}

fn AgXContrastApprox(x: vec3<f32>) -> vec3<f32> {
  let x2 = x * x;
  let x4 = x2 * x2;
  return 15.5 * x4 * x2
    - 40.14 * x4 * x
    + 31.96 * x4
    - 6.868 * x2 * x
    + 0.4298 * x2
    + 0.1191 * x
    - vec3<f32>(0.00232);
}

fn AgXPostDisplay(c: vec3<f32>) -> vec3<f32> {
  var o = clamp(c, vec3<f32>(0.0), vec3<f32>(1.0));
  o = o * o * (vec3<f32>(3.0) - 2.0 * o);
  o = clamp((o - vec3<f32>(0.5)) * 1.22 + vec3<f32>(0.5), vec3<f32>(0.0), vec3<f32>(1.0));
  let l = dot(o, vec3<f32>(0.2126, 0.7152, 0.0722));
  o = mix(vec3<f32>(l), o, 1.42);
  o = mix(o * o, o, smoothstep(0.0, 0.65, l));
  return clamp(o, vec3<f32>(0.0), vec3<f32>(1.0));
}

fn AgXTonemap(val: vec3<f32>) -> vec3<f32> {
  let inMatrix = mat3x3<f32>(
    vec3<f32>(0.842479062253094, 0.0784335999999992, 0.0792237451477643),
    vec3<f32>(0.0423282422610123, 0.878468636469772, 0.0791661274605434),
    vec3<f32>(0.0423756549057051, 0.0784336, 0.879142973793104),
  );
  let outMatrix = mat3x3<f32>(
    vec3<f32>(1.19687900512017, -0.0980208811401368, -0.0990297440797205),
    vec3<f32>(-0.0528968517574562, 1.15190312990417, -0.0989611768448433),
    vec3<f32>(-0.0529716355144438, -0.0980434501171241, 1.15107367264116),
  );
  var v = inMatrix * val;
  v = clamp((log2(max(v, vec3<f32>(1e-10))) + vec3<f32>(12.47393)) / vec3<f32>(16.5), vec3<f32>(0.0), vec3<f32>(1.0));
  v = AgXContrastApprox(v);
  v = outMatrix * v;
  v = clamp(v, vec3<f32>(0.0), vec3<f32>(1.0));
  v = AgXPostDisplay(v);
  return clamp(v, vec3<f32>(0.0), vec3<f32>(1.0));
}

fn smoothOcclusionUV(worldPosBlocks: vec2<f32>) -> vec2<f32> {
  return (worldPosBlocks - compositeUniforms.uOcclusionOrigin) / compositeUniforms.uOcclusionSize;
}

fn sampleIndirectSky(worldPosBlocks: vec2<f32>) -> f32 {
  let uv = clamp(smoothOcclusionUV(worldPosBlocks), vec2<f32>(0.001), vec2<f32>(0.999));
  return textureSample(uIndirectLight, uIndirectLightSampler, uv).r;
}

fn softSolidSkyExposure(worldPosBlocks: vec2<f32>) -> f32 {
  let lq = compositeUniforms.uLightingQuality;
  if (lq <= 0) {
    return sampleIndirectSky(worldPosBlocks);
  }
  if (lq == 1) {
    let sUp = sampleIndirectSky(worldPosBlocks + vec2<f32>(0.0, 1.0));
    let s0 = sampleIndirectSky(worldPosBlocks);
    let sD1 = sampleIndirectSky(worldPosBlocks + vec2<f32>(0.0, -0.65));
    let avg = sUp * 0.18 + s0 * 0.46 + sD1 * 0.36;
    let darker = min(s0, sD1);
    return mix(avg, darker, 0.34);
  }
  let sUp = sampleIndirectSky(worldPosBlocks + vec2<f32>(0.0, 1.0));
  let s0 = sampleIndirectSky(worldPosBlocks);
  let sD1 = sampleIndirectSky(worldPosBlocks + vec2<f32>(0.0, -0.65));
  let sD2 = sampleIndirectSky(worldPosBlocks + vec2<f32>(0.0, -1.35));
  let sD3 = sampleIndirectSky(worldPosBlocks + vec2<f32>(0.0, -2.2));
  let avg = sUp * 0.07 + s0 * 0.20 + sD1 * 0.26 + sD2 * 0.25 + sD3 * 0.22;
  let darker = min(s0, sD1);
  return mix(avg, darker, 0.34);
}

fn torchBloomGain(worldPos: vec2<f32>, tip: vec2<f32>) -> f32 {
  let dPx = (worldPos - tip) * 16.0;
  let hw = 4.05;
  let hh = 6.1;
  let g = max(0.0, 1.0 - length(vec2<f32>(dPx.x / hw, dPx.y / hh)));
  return g * g;
}

@fragment
fn mainFragment(@location(0) vTextureCoord: vec2<f32>) -> @location(0) vec4<f32> {
  let sampleUvRaw = clamp(
    vTextureCoord * compositeUniforms.uUvScale + compositeUniforms.uUvBaseOffset + compositeUniforms.uUvSubpixelOffset,
    vec2<f32>(0.0),
    vec2<f32>(1.0),
  );
  let ts = max(gfu.uInputSize.xy, vec2<f32>(1.0));
  let sampleUv = (floor(sampleUvRaw * ts) + vec2<f32>(0.5)) / ts;
  let albedo = textureSample(uTexture, uSampler, sampleUv);

  let padPx = compositeUniforms.uUvBaseOffset * gfu.uInputSize.xy;
  let viewPx = sampleUv * gfu.uInputSize.xy - padPx;
  var worldPos: vec2<f32>;
  worldPos.x = compositeUniforms.uCameraWorld.x + viewPx.x / compositeUniforms.uBlockPixels;
  worldPos.y = compositeUniforms.uCameraWorld.y - viewPx.y / compositeUniforms.uBlockPixels;

  var skyTerm = 1.0;
  var blockTerm = 0.0;
  let indirectUV = smoothOcclusionUV(worldPos);
  let inIndirect =
    (indirectUV.x >= 0.0) &&
    (indirectUV.x <= 1.0) &&
    (indirectUV.y >= 0.0) &&
    (indirectUV.y <= 1.0);
  let indirectSampUv = clamp(indirectUV, vec2<f32>(0.001), vec2<f32>(0.999));
  let ind = textureSample(uIndirectLight, uIndirectLightSampler, indirectSampUv).rg;
  let solidSky = softSolidSkyExposure(worldPos);
  let occSolid = textureSample(uOcclusion, uOcclusionSampler, indirectSampUv).r;
  let skyTermIn = mix(ind.r, solidSky, smoothstep(0.25, 0.75, occSolid));
  skyTerm = select(1.0, skyTermIn, inIndirect);
  blockTerm = select(0.0, ind.g, inIndirect);

  let nightPenumbra = 1.0 - smoothstep(0.06, 0.24, compositeUniforms.uAmbient);
  let R = mix(1.5, 2.15, nightPenumbra);
  let blurCenter = worldPos + vec2<f32>(0.0, -0.2);
  var smoothedSky: f32;
  let lq = compositeUniforms.uLightingQuality;
  if (lq <= 0) {
    smoothedSky = sampleIndirectSky(blurCenter);
  } else if (lq == 1) {
    let s01 = sampleIndirectSky(blurCenter + vec2<f32>(-R, 0.0));
    let s11 = sampleIndirectSky(blurCenter);
    let s21 = sampleIndirectSky(blurCenter + vec2<f32>(R, 0.0));
    let s10 = sampleIndirectSky(blurCenter + vec2<f32>(0.0, -R));
    let s12 = sampleIndirectSky(blurCenter + vec2<f32>(0.0, R));
    smoothedSky = (s01 + s21 + s10 + s12) * 0.15 + s11 * 0.4;
  } else {
    let s00 = sampleIndirectSky(blurCenter + vec2<f32>(-R, -R));
    let s10 = sampleIndirectSky(blurCenter + vec2<f32>(0.0, -R));
    let s20 = sampleIndirectSky(blurCenter + vec2<f32>(R, -R));
    let s01 = sampleIndirectSky(blurCenter + vec2<f32>(-R, 0.0));
    let s11 = sampleIndirectSky(blurCenter);
    let s21 = sampleIndirectSky(blurCenter + vec2<f32>(R, 0.0));
    let s02 = sampleIndirectSky(blurCenter + vec2<f32>(-R, R));
    let s12 = sampleIndirectSky(blurCenter + vec2<f32>(0.0, R));
    let s22 = sampleIndirectSky(blurCenter + vec2<f32>(R, R));
    smoothedSky =
      (s00 + s20 + s02 + s22) * (1.0 / 16.0) +
      (s10 + s01 + s21 + s12) * (2.0 / 16.0) +
      s11 * (4.0 / 16.0);
  }

  let shadowFloor = mix(SHADOW_FLOOR_DAY, SHADOW_FLOOR_NIGHT, nightPenumbra);
  let skyGamma = mix(0.50, 0.36, nightPenumbra);
  let skyS = pow(clamp(smoothedSky, 0.0, 1.0), skyGamma);
  let shadowFactor = shadowFloor + (1.0 - shadowFloor) * skyS;

  let directSun = compositeUniforms.uSunIntensity * shadowFactor;
  let directMoon = compositeUniforms.uMoonIntensity * shadowFactor;
  let skyExposure = max(smoothedSky, mix(0.03, 0.10, nightPenumbra));

  var light =
    vec3<f32>(compositeUniforms.uAmbient * skyExposure) * compositeUniforms.uAmbientTint * compositeUniforms.uSkyLightTint
    + vec3<f32>(directSun) * compositeUniforms.uSunTint
    + vec3<f32>(directMoon) * compositeUniforms.uMoonTint;

  let indirectSky =
    smoothedSky * (0.3 + 0.7 * clamp(compositeUniforms.uAmbient, 0.0, 1.0) + nightPenumbra * 0.2);
  let indirectBlock = blockTerm;
  var indirect = vec3<f32>(0.0);
  indirect += indirectSky * compositeUniforms.uAmbientTint * compositeUniforms.uSkyLightTint * 0.9;
  indirect += indirectBlock * vec3<f32>(1.0, 0.85, 0.65) * 1.2;
  light += indirect;

  if (compositeUniforms.uTorchActive > 0.5) {
    let toTorch = compositeUniforms.uTorchWorldPos - worldPos;
    let tdist = length(toTorch);
    if (tdist < compositeUniforms.uTorchRadius) {
      let n = tdist / max(compositeUniforms.uTorchRadius, 1e-4);
      var atten = max(0.0, 1.0 - n);
      atten = atten * atten * 0.7 + atten * 0.3;
      let heldTorchLight = compositeUniforms.uTorchIntensity * atten;
      light += compositeUniforms.uTorchColor * clamp(heldTorchLight, 0.0, 1.0);
    }
  }

  let PLACED_TORCH_RADIUS = 14.0;
  var placedTorchAmt = 0.0;
  let ptCount = compositeUniforms.uPlacedTorchCount;
  for (var i: i32 = 0; i < ${MAX_PLACED_TORCHES}; i = i + 1) {
    if (i >= ptCount) {
      break;
    }
    let placed = compositeUniforms.uPlacedTorchPositions[u32(i)];
    let tp = placed.xy;
    let placedStrength = max(0.0, placed.z);
    let ptdist = length(tp - worldPos);
    let inPlacedRadius = ptdist < PLACED_TORCH_RADIUS;
    let n = ptdist / PLACED_TORCH_RADIUS;
    var patten = max(0.0, 1.0 - n);
    patten = patten * patten * 0.7 + patten * 0.3;
    let placedContrib = 0.75 * patten * placedStrength;
    placedTorchAmt = max(placedTorchAmt, select(0.0, placedContrib, inPlacedRadius));
  }
  light += vec3<f32>(1.0, 0.85, 0.55) * placedTorchAmt;
  light = clamp(light, vec3<f32>(0.0), vec3<f32>(1.0));

  var bloom = vec3<f32>(0.0);
  var bloomPlayerOccl = 1.0;
  if (compositeUniforms.uBloomEnabled > 0.5) {
    let bloomTipShift = vec2<f32>(1.0 / compositeUniforms.uBlockPixels, -13.0 / compositeUniforms.uBlockPixels);

    var placedBloomAmt = 0.0;
    for (var j: i32 = 0; j < ${MAX_PLACED_TORCHES}; j = j + 1) {
      if (j >= ptCount) {
        break;
      }
      let placedB = compositeUniforms.uPlacedTorchPositions[u32(j)];
      let tpB = placedB.xy;
      let placedStrengthB = max(0.0, placedB.z);
      let wBloomMeta = placedB.w;
      let placedBloomWeight = select(1.0, 0.0, wBloomMeta < -0.5);
      let bloomTipShiftScale = select(
        clamp(wBloomMeta, 0.0, 1.0),
        0.0,
        wBloomMeta < 0.0,
      );
      let gB = torchBloomGain(worldPos, tpB + bloomTipShift * bloomTipShiftScale);
      placedBloomAmt = max(
        placedBloomAmt,
        placedBloomWeight * 0.42 * gB * placedStrengthB,
      );
    }
    bloom += vec3<f32>(1.0, 0.85, 0.50) * placedBloomAmt;

    let dUv = vec2<f32>(1.0 / max(gfu.uInputSize.x, 1.0), 1.0 / max(gfu.uInputSize.y, 1.0)) * 1.25;
    let bloomMaskA = max(
      max(
        max(
          textureSample(uPlayerBloomMask, uPlayerBloomMaskSampler, sampleUv).a,
          textureSample(uPlayerBloomMask, uPlayerBloomMaskSampler, sampleUv + vec2<f32>(dUv.x, 0.0)).a,
        ),
        textureSample(uPlayerBloomMask, uPlayerBloomMaskSampler, sampleUv - vec2<f32>(dUv.x, 0.0)).a,
      ),
      max(
        textureSample(uPlayerBloomMask, uPlayerBloomMaskSampler, sampleUv + vec2<f32>(0.0, dUv.y)).a,
        textureSample(uPlayerBloomMask, uPlayerBloomMaskSampler, sampleUv - vec2<f32>(0.0, dUv.y)).a,
      ),
    );
    bloomPlayerOccl = mix(
      1.0,
      1.0 - smoothstep(0.06, 0.52, bloomMaskA),
      compositeUniforms.uBloomMaskActive,
    );
    if (compositeUniforms.uPlayerBloomUvBoundsActive > 0.5) {
      let ax = smoothstep(
        compositeUniforms.uPlayerBloomUvMin.x - 0.0014,
        compositeUniforms.uPlayerBloomUvMin.x + 0.0014,
        sampleUv.x,
      );
      let bx = 1.0 - smoothstep(
        compositeUniforms.uPlayerBloomUvMax.x - 0.0014,
        compositeUniforms.uPlayerBloomUvMax.x + 0.0014,
        sampleUv.x,
      );
      let ay = smoothstep(
        compositeUniforms.uPlayerBloomUvMin.y - 0.0014,
        compositeUniforms.uPlayerBloomUvMin.y + 0.0014,
        sampleUv.y,
      );
      let by = 1.0 - smoothstep(
        compositeUniforms.uPlayerBloomUvMax.y - 0.0014,
        compositeUniforms.uPlayerBloomUvMax.y + 0.0014,
        sampleUv.y,
      );
      let insideUv = ax * bx * ay * by;
      bloomPlayerOccl *= (1.0 - 0.998 * insideUv);
    }
  }

  let bloomApplied = bloom * bloomPlayerOccl;
  let hdrColor = albedo.rgb * light + bloomApplied;

  var tonemapped: vec3<f32>;
  let tm = compositeUniforms.uTonemapper;
  if (tm == 1) {
    tonemapped = ACESFilmTonemap(hdrColor);
  } else if (tm == 2) {
    tonemapped = AgXTonemap(hdrColor);
  } else if (tm == 3) {
    tonemapped = ExtendedReinhardToneMap(hdrColor);
  } else {
    tonemapped = clamp(hdrColor, vec3<f32>(0.0), vec3<f32>(1.0));
  }
  let bloomAlpha = clamp(max(bloomApplied.r, max(bloomApplied.g, bloomApplied.b)), 0.0, 1.0);
  return vec4<f32>(tonemapped, max(albedo.a, bloomAlpha));
}
`;
