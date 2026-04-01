in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform sampler2D uOcclusion;
uniform sampler2D uIndirectLight;

/** Set by Pixi filter system: texture size in pixels (xy), inverse (zw). Must match uTexture. */
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

/** Floor so fully-shadowed areas aren't pitch black (day baseline; night blends higher). */
const float SHADOW_FLOOR_DAY = 0.20;
const float SHADOW_FLOOR_NIGHT = 0.34;

/** Smooth UV — maps sub-block positions so bilinear filtering blends at block edges. */
vec2 smoothOcclusionUV(vec2 worldPosBlocks) {
  return (worldPosBlocks - uOcclusionOrigin) / uOcclusionSize;
}

/** Indirect sky sample; UV clamp keeps offsets near region edges stable. */
float sampleIndirectSky(vec2 worldPosBlocks) {
  vec2 uv = clamp(smoothOcclusionUV(worldPosBlocks), vec2(0.001), vec2(0.999));
  return texture(uIndirectLight, uv).r;
}

/**
 * For solid voxels, vertical multi-tap + min-blend so ambient darkening starts nearer the
 * surface (world +Y = toward sky, -Y = deeper) instead of stepping down only after several
 * blocks of dirt.
 */
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

void main() {
  vec4 albedo = texture(uTexture, vTextureCoord);

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

  // When global ambient is low (night outdoors, very dark interiors), ease contrast:
  // wider penumbra, brighter shadow floor, gentler curve so lit→unlit isn't a hard cliff.
  float nightPenumbra = 1.0 - smoothstep(0.06, 0.24, uAmbient);

  // 2D Gaussian blur on sky exposure so shadow edges fade smoothly in all
  // directions. Offset pulls shadow closer to the terrain surface.
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

  float directSun = uSunIntensity * shadowFactor;
  float directMoon = uMoonIntensity * shadowFactor;

  float skyExposure = max(smoothedSky, mix(0.03, 0.10, nightPenumbra));

  vec3 sunContrib = vec3(directSun) * uSunTint;
  vec3 moonContrib = directMoon * uMoonTint;
  vec3 light = vec3(uAmbient * skyExposure) * uAmbientTint * uSkyLightTint + sunContrib + moonContrib;

  float indirectSky =
    smoothedSky * (0.3 + 0.7 * clamp(uAmbient, 0.0, 1.0) + nightPenumbra * 0.2);
  float indirectBlock = blockTerm;
  vec3 indirect = vec3(0.0);
  indirect += indirectSky * uAmbientTint * uSkyLightTint * 0.9;
  indirect += indirectBlock * vec3(1.0, 0.85, 0.65) * 1.2;
  light += indirect;

  // Held torch: isotropic falloff like block-light BFS (no view-ray shadow march — that
  // read as a directional beam vs placed torches, which use flood-fill only).
  if (uTorchActive > 0.5) {
    vec2 toTorch = uTorchWorldPos - worldPos;
    float dist = length(toTorch);
    if (dist < uTorchRadius) {
      float n = dist / max(uTorchRadius, 1e-4);
      float atten = max(0.0, 1.0 - n);
      atten = atten * atten * 0.7 + atten * 0.3;
      light += uTorchColor * uTorchIntensity * atten;
    }
  }

  light = clamp(light, 0.0, 1.0);
  finalColor = vec4(albedo.rgb * light, albedo.a);
}
