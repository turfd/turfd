/**
 * GLSL fragment source for {@link CompositePass}. Kept as a TS string so bundlers always
 * ship real shader text (`.glsl?raw` can resolve to null in some dev/prebundle paths).
 */
import { MAX_PLACED_TORCHES } from "../../core/constants";

export const COMPOSITE_FRAGMENT_GLSL = `in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform sampler2D uOcclusion;
uniform sampler2D uIndirectLight;
/** Screen-space silhouette of the local player; alpha occludes bloom only. */
uniform sampler2D uPlayerBloomMask;

uniform highp vec4 uInputSize;

uniform vec2 uSunDir;
uniform float uAmbient;
uniform vec3 uAmbientTint;
uniform vec3 uSkyLightTint;
uniform float uSunIntensity;
uniform vec3 uSunTint;
uniform vec2 uCameraWorld;
uniform float uBlockPixels;
uniform vec2 uOcclusionOrigin;
uniform float uOcclusionSize;

uniform vec2 uMoonDir;
uniform float uMoonIntensity;
uniform vec3 uMoonTint;

uniform float uTorchActive;
uniform vec2 uTorchWorldPos;
uniform float uTorchRadius;
uniform float uTorchIntensity;
uniform vec3 uTorchColor;

const int MAX_PLACED_TORCHES = ${MAX_PLACED_TORCHES};
uniform int uPlacedTorchCount;
uniform vec4 uPlacedTorchPositions[${MAX_PLACED_TORCHES}];

// 0 = none (hard clamp), 1 = ACES, 2 = AgX, 3 = extended Reinhard (luminance / white point)
uniform int uTonemapper;
// 1.0 = bloom on, 0.0 = bloom off
uniform float uBloomEnabled;
// 1.0 = apply uPlayerBloomMask to bloom; 0.0 = ignore mask (menu / no gameplay root)
uniform float uBloomMaskActive;

uniform sampler2D uNormalMap;
/** Nudge normal-map sampling in **logical** pixels (same space as uInputSize.xy). */
uniform vec2 uNormalOffsetPx;
/** 1 = match albedo; below 1 zooms normal map out, above 1 zooms in (about screen center). */
uniform float uNormalUvScale;
/** 0 = legacy flat shading; 1 = full screen-space normal diffuse on direct lights. */
uniform float uNormalStrength;
/** 1 = output encoded normal RGB for debugging (same UV as albedo). */
uniform float uDebugNormals;
uniform float uSunLightZ;
uniform float uMoonLightZ;
uniform float uTorchLightZ;

const float SHADOW_FLOOR_DAY = 0.20;
const float SHADOW_FLOOR_NIGHT = 0.34;

// Narkowicz ACES filmic tonemapper.
vec3 ACESFilm(vec3 x) {
  float a = 2.51;
  float b = 0.03;
  float c = 2.43;
  float d = 0.59;
  float e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

// LDR game HDR (bloom + albedo) often pegs ACES to flat, chalky whites; trim input and
// soften display so torch pools and highlights keep a hint of color and less edge harshness.
vec3 ACESPostDisplay(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float hi = smoothstep(0.52, 0.88, lum);
  c = mix(c, vec3(lum), hi * 0.2);
  c = pow(c, vec3(0.95));
  return clamp(c, 0.0, 1.0);
}

vec3 ACESFilmTonemap(vec3 hdr) {
  const float preExposure = 0.87;
  return ACESPostDisplay(ACESFilm(hdr * preExposure));
}

// Extended Reinhard (luminance), FancyLighting.Utils.ToneMapping — WhitePoint = 1.25
vec3 ExtendedReinhardToneMap(vec3 color) {
  const float WHITE_POINT = 1.25;
  float luminance = dot(color, vec3(0.2126, 0.7152, 0.0722));
  float mult = (1.0 + luminance * (1.0 / (WHITE_POINT * WHITE_POINT))) / (1.0 + luminance);
  return clamp(color * mult, 0.0, 1.0);
}

// AgX sigmoid contrast curve (Sobotka / Blender approximation).
vec3 AgXContrastApprox(vec3 x) {
  vec3 x2 = x * x;
  vec3 x4 = x2 * x2;
  return 15.5  * x4 * x2
       - 40.14 * x4 * x
       + 31.96 * x4
       - 6.868 * x2 * x
       + 0.4298 * x2
       + 0.1191 * x
       - 0.00232;
}

// After log + matrices, the Blender-style AgX approx reads grey / low-chroma on typical
// LDR game HDR (mostly [0,1] with mild bloom). Stronger display grade: S-curve contrast,
// saturation, and a slight shadow deepen so blacks/UI don't sit in milky mid-grey.
vec3 AgXPostDisplay(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  // Midtone S-curve (punchier than a single linear contrast mul).
  c = c * c * (3.0 - 2.0 * c);
  c = clamp((c - 0.5) * 1.22 + 0.5, 0.0, 1.0);
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, 1.42);
  // Deepen lifted fog without killing highlights (luma-weighted).
  c = mix(c * c, c, smoothstep(0.0, 0.65, l));
  return clamp(c, 0.0, 1.0);
}

// AgX tonemapper (Troy Sobotka / Blender reference implementation).
vec3 AgXTonemap(vec3 val) {
  // sRGB linear → AgX log space
  mat3 inMatrix = mat3(
     0.842479062253094,  0.0423282422610123, 0.0423756549057051,
     0.0784335999999992, 0.878468636469772,  0.0784336,
     0.0792237451477643, 0.0791661274605434, 0.879142973793104
  );
  // AgX log space → sRGB linear
  mat3 outMatrix = mat3(
     1.19687900512017,  -0.0528968517574562, -0.0529716355144438,
    -0.0980208811401368, 1.15190312990417,   -0.0980434501171241,
    -0.0990297440797205,-0.0989611768448433,  1.15107367264116
  );
  val = inMatrix * val;
  // Log2 encode and normalise to [0, 1] over the display range [-12.47, +4.03] EV
  val = clamp((log2(max(val, vec3(1e-10))) + 12.47393) / 16.5, 0.0, 1.0);
  val = AgXContrastApprox(val);
  val = outMatrix * val;
  val = clamp(val, 0.0, 1.0);
  val = AgXPostDisplay(val);
  return clamp(val, 0.0, 1.0);
}

vec2 smoothOcclusionUV(vec2 worldPosBlocks) {
  return (worldPosBlocks - uOcclusionOrigin) / uOcclusionSize;
}

float sampleIndirectSky(vec2 worldPosBlocks) {
  vec2 uv = clamp(smoothOcclusionUV(worldPosBlocks), vec2(0.001), vec2(0.999));
  return texture(uIndirectLight, uv).r;
}

float softSolidSkyExposure(vec2 worldPosBlocks) {
  float sUp = sampleIndirectSky(worldPosBlocks + vec2(0.0, 1.0));
  float s0 = sampleIndirectSky(worldPosBlocks);
  float sD1 = sampleIndirectSky(worldPosBlocks + vec2(0.0, -0.65));
  float sD2 = sampleIndirectSky(worldPosBlocks + vec2(0.0, -1.35));
  float sD3 = sampleIndirectSky(worldPosBlocks + vec2(0.0, -2.2));
  float avg =
    sUp * 0.07 + s0 * 0.20 + sD1 * 0.26 + sD2 * 0.25 + sD3 * 0.22;
  float darker = min(s0, sD1);
  return mix(avg, darker, 0.34);
}

// Ray-march from 'from' toward 'to' sampling the occlusion mask.
// Returns a soft visibility factor in [0, 1] using a 3-ray cone for penumbra.
float placedTorchShadow(vec2 from, vec2 to) {
  vec2 delta = to - from;
  float dist = length(delta);
  if (dist < 0.001) return 1.0;
  vec2 dir  = delta / dist;
  vec2 perp = vec2(-dir.y, dir.x);
  float totalVis = 0.0;
  for (int r = 0; r < 3; r++) {
    vec2 rayOffset = perp * (float(r - 1) * 0.35);
    float vis = 1.0;
    for (int s = 0; s < 8; s++) {
      float t = dist * (float(s) + 0.5) / 8.0;
      vec2 sp = from + dir * t + rayOffset;
      vec2 uv = smoothOcclusionUV(sp);
      if (uv.x > 0.0 && uv.x < 1.0 && uv.y > 0.0 && uv.y < 1.0) {
        float occ = texture(uOcclusion, uv).r;
        vis *= 1.0 - occ * 0.88;
      }
    }
    totalVis += vis;
  }
  return totalVis / 3.0;
}

// Bloom: elliptical falloff in 16px-tile space; center shifted slightly below flame tip on screen.
float torchBloomGain(vec2 worldPos, vec2 tip) {
  vec2 dPx = (worldPos - tip) * 16.0;
  // hw: horizontal semi-axis in dPx space (+1 here = +2 px total bloom width).
  const float hw = 2.55;
  const float hh = 4.6;
  float g = max(0.0, 1.0 - length(vec2(dPx.x / hw, dPx.y / hh)));
  return g * g;
}

vec3 tangentNormalFromMap(vec4 albedo, vec2 uv) {
  vec4 nm = texture(uNormalMap, uv);
  if (albedo.a < 0.04 || nm.a < 0.04) {
    return vec3(0.0, 0.0, 1.0);
  }
  return normalize(vec3(nm.xy * 2.0 - 1.0, nm.z * 2.0 - 1.0));
}

void main() {
  // Scale normal-map UVs about center (debug: slight size mismatch vs albedo).
  vec2 uvScaled =
    (vTextureCoord - vec2(0.5)) * uNormalUvScale + vec2(0.5);
  // Positive offset = shift the normal map layer right / down on screen (matches slider labels).
  vec2 uvNormal = uvScaled - vec2(
    uNormalOffsetPx.x / uInputSize.x,
    uNormalOffsetPx.y / uInputSize.y
  );
  vec4 albedo = texture(uTexture, vTextureCoord);
  vec3 tN = vec3(0.0, 0.0, 1.0);
  if (uNormalStrength > 0.001) {
    tN = tangentNormalFromMap(albedo, uvNormal);
  }

  vec2 screenPos = vTextureCoord * uInputSize.xy;
  vec2 worldPos;
  worldPos.x = uCameraWorld.x + screenPos.x / uBlockPixels;
  worldPos.y = uCameraWorld.y - screenPos.y / uBlockPixels;

  float skyTerm = 1.0;
  float blockTerm = 0.0;
  vec2 indirectUV = smoothOcclusionUV(worldPos);
  if (indirectUV.x >= 0.0 && indirectUV.x <= 1.0 && indirectUV.y >= 0.0 && indirectUV.y <= 1.0) {
    vec2 ind = texture(uIndirectLight, indirectUV).rg;
    float airSky = ind.r;
    blockTerm = ind.g;
    float solidSky = softSolidSkyExposure(worldPos);
    float occSolid = texture(uOcclusion, indirectUV).r;
    skyTerm = mix(airSky, solidSky, smoothstep(0.25, 0.75, occSolid));
  }

  float nightPenumbra = 1.0 - smoothstep(0.06, 0.24, uAmbient);

  float R = mix(1.5, 2.15, nightPenumbra);
  vec2 blurCenter = worldPos + vec2(0.0, -.2);
  float s00 = sampleIndirectSky(blurCenter + vec2(-R, -R));
  float s10 = sampleIndirectSky(blurCenter + vec2(0.0, -R));
  float s20 = sampleIndirectSky(blurCenter + vec2( R, -R));
  float s01 = sampleIndirectSky(blurCenter + vec2(-R, 0.0));
  float s11 = sampleIndirectSky(blurCenter);
  float s21 = sampleIndirectSky(blurCenter + vec2( R, 0.0));
  float s02 = sampleIndirectSky(blurCenter + vec2(-R,  R));
  float s12 = sampleIndirectSky(blurCenter + vec2(0.0, R));
  float s22 = sampleIndirectSky(blurCenter + vec2( R,  R));
  float smoothedSky =
    (s00 + s20 + s02 + s22) * (1.0 / 16.0) +
    (s10 + s01 + s21 + s12) * (2.0 / 16.0) +
    s11 * (4.0 / 16.0);

  float shadowFloor = mix(SHADOW_FLOOR_DAY, SHADOW_FLOOR_NIGHT, nightPenumbra);
  float skyGamma = mix(0.50, 0.36, nightPenumbra);
  float skyS = pow(clamp(smoothedSky, 0.0, 1.0), skyGamma);
  float shadowFactor = shadowFloor + (1.0 - shadowFloor) * skyS;

  float heldTorchVis = 1.0;
  if (uTorchActive > 0.5) {
    heldTorchVis = placedTorchShadow(worldPos, uTorchWorldPos);
  }

  float directSun = uSunIntensity * shadowFactor;
  float directMoon = uMoonIntensity * shadowFactor;

  float skyExposure = max(smoothedSky, mix(0.03, 0.10, nightPenumbra));

  vec3 Lsun = normalize(vec3(uSunDir.x, -uSunDir.y, uSunLightZ));
  vec3 Lmoon = normalize(vec3(uMoonDir.x, -uMoonDir.y, uMoonLightZ));
  const vec3 tFlat = vec3(0.0, 0.0, 1.0);
  float ndlSun = max(0.0, dot(tN, Lsun));
  float ndlMoon = max(0.0, dot(tN, Lmoon));
  float ndlSunFlat = max(0.0, dot(tFlat, Lsun));
  float ndlMoonFlat = max(0.0, dot(tFlat, Lmoon));
  float sunMul = mix(1.0, ndlSun / max(ndlSunFlat, 1e-4), uNormalStrength);
  float moonMul = mix(1.0, ndlMoon / max(ndlMoonFlat, 1e-4), uNormalStrength);
  vec3 sunContrib = vec3(directSun * sunMul) * uSunTint;
  vec3 moonContrib = vec3(directMoon * moonMul) * uMoonTint;
  vec3 light = vec3(uAmbient * skyExposure) * uAmbientTint * uSkyLightTint + sunContrib + moonContrib;

  float indirectSky =
    smoothedSky * (0.3 + 0.7 * clamp(uAmbient, 0.0, 1.0) + nightPenumbra * 0.2);
  float indirectBlock = blockTerm;
  vec3 indirect = vec3(0.0);
  indirect += indirectSky * uAmbientTint * uSkyLightTint * 0.9;
  indirect += indirectBlock * vec3(1.0, 0.85, 0.65) * 1.2;
  light += indirect;

  if (uTorchActive > 0.5) {
    vec2 toTorch = uTorchWorldPos - worldPos;
    float dist = length(toTorch);
    if (dist < uTorchRadius) {
      float n = dist / max(uTorchRadius, 1e-4);
      float atten = max(0.0, 1.0 - n);
      atten = atten * atten * 0.7 + atten * 0.3;
      // Same as placed torches: distance × ray-marched visibility (not a screen-space overlay).
      vec3 Lheld = normalize(vec3(toTorch.x, -toTorch.y, uTorchLightZ));
      float ndlHeld = max(0.0, dot(tN, Lheld));
      float ndlHeldFlat = max(0.0, dot(tFlat, Lheld));
      float heldMul = mix(1.0, ndlHeld / max(ndlHeldFlat, 1e-4), uNormalStrength);
      float heldTorchLight = uTorchIntensity * atten * heldTorchVis * heldMul;
      light += uTorchColor * clamp(heldTorchLight, 0.0, 1.0);
    }
  }

  // Placed torches: take the strongest single contribution only (no stacking). Summing
  // multiple ray-marched shadows caused harsh lines where visibility differed per torch.
  const float PLACED_TORCH_RADIUS = 14.0;
  float placedTorchAmt = 0.0;
  for (int i = 0; i < MAX_PLACED_TORCHES; i++) {
    if (i >= uPlacedTorchCount) break;
    vec2 tp = uPlacedTorchPositions[i].xy;
    float dist = length(tp - worldPos);
    if (dist < PLACED_TORCH_RADIUS) {
      float n = dist / PLACED_TORCH_RADIUS;
      float atten = max(0.0, 1.0 - n);
      atten = atten * atten * 0.7 + atten * 0.3;
      float shadow = placedTorchShadow(worldPos, tp);
      vec2 toPl = tp - worldPos;
      vec3 Lpl = normalize(vec3(toPl.x, -toPl.y, uTorchLightZ));
      float ndlPl = max(0.0, dot(tN, Lpl));
      float ndlPlFlat = max(0.0, dot(tFlat, Lpl));
      float plMul = mix(1.0, ndlPl / max(ndlPlFlat, 1e-4), uNormalStrength);
      placedTorchAmt = max(placedTorchAmt, 0.75 * atten * shadow * plMul);
    }
  }
  light += vec3(1.0, 0.85, 0.55) * placedTorchAmt;

  // Bloom: same flame tips as lighting; nudge in screen px (world: 1 block = uBlockPixels px).
  vec2 bloomTipShift = vec2(1.0 / uBlockPixels, -13.0 / uBlockPixels);
  vec3 bloom = vec3(0.0);

  if (uTorchActive > 0.5) {
    float g = torchBloomGain(worldPos, uTorchWorldPos + bloomTipShift);
    float heldBloom = uTorchIntensity * 0.48 * g * heldTorchVis;
    bloom += uTorchColor * clamp(heldBloom, 0.0, 1.0);
  }

  float placedBloomAmt = 0.0;
  for (int i = 0; i < MAX_PLACED_TORCHES; i++) {
    if (i >= uPlacedTorchCount) break;
    vec2 tp = uPlacedTorchPositions[i].xy;
    float g = torchBloomGain(worldPos, tp + bloomTipShift);
    placedBloomAmt = max(placedBloomAmt, 0.42 * g);
  }
  bloom += vec3(1.0, 0.85, 0.50) * placedBloomAmt;

  // Clamp base lighting to [0, 1] so daytime brightness matches the original
  // behaviour. Only the bloom contribution is allowed to exceed 1.0, giving
  // ACES something to compress without over-brightening the base scene.
  light = clamp(light, 0.0, 1.0);
  float bloomPlayerOccl = mix(1.0, 1.0 - texture(uPlayerBloomMask, vTextureCoord).a, uBloomMaskActive);
  vec3 hdrColor = albedo.rgb * light + bloom * albedo.a * uBloomEnabled * bloomPlayerOccl;

  if (uDebugNormals > 0.5) {
    vec4 nmDbg = texture(uNormalMap, uvNormal);
    finalColor = vec4(nmDbg.rgb, 1.0);
    return;
  }

  vec3 tonemapped;
  if (uTonemapper == 1) {
    tonemapped = ACESFilmTonemap(hdrColor);
  } else if (uTonemapper == 2) {
    tonemapped = AgXTonemap(hdrColor);
  } else if (uTonemapper == 3) {
    tonemapped = ExtendedReinhardToneMap(hdrColor);
  } else {
    tonemapped = clamp(hdrColor, 0.0, 1.0);
  }
  finalColor = vec4(tonemapped, albedo.a);
}
`;
