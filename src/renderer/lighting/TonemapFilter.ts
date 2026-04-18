/**
 * Lightweight fullscreen filter that applies ACES / AgX / no tonemapping to a
 * pre-composited image (e.g. the parallax background layer).  Shares the same
 * uTonemapper convention as {@link CompositePass}:
 *   0 = none (clamp), 1 = ACES, 2 = AgX, 3 = extended Reinhard.
 */
import { Filter, GlProgram, UniformGroup } from "pixi.js";

// Standard Pixi filter vertex shader (identical to CompositePass).
const VERT_SRC = `in vec2 aPosition;
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

const FRAG_SRC = `in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform int uTonemapper;

vec3 ACESFilm(vec3 x) {
  float a = 2.51;
  float b = 0.03;
  float c = 2.43;
  float d = 0.59;
  float e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

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

vec3 ExtendedReinhardToneMap(vec3 color) {
  const float WHITE_POINT = 1.25;
  float luminance = dot(color, vec3(0.2126, 0.7152, 0.0722));
  float mult = (1.0 + luminance * (1.0 / (WHITE_POINT * WHITE_POINT))) / (1.0 + luminance);
  return clamp(color * mult, 0.0, 1.0);
}

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

vec3 AgXPostDisplay(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  c = c * c * (3.0 - 2.0 * c);
  c = clamp((c - 0.5) * 1.22 + 0.5, 0.0, 1.0);
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, 1.42);
  c = mix(c * c, c, smoothstep(0.0, 0.65, l));
  return clamp(c, 0.0, 1.0);
}

vec3 AgXTonemap(vec3 val) {
  mat3 inMatrix = mat3(
     0.842479062253094,  0.0423282422610123, 0.0423756549057051,
     0.0784335999999992, 0.878468636469772,  0.0784336,
     0.0792237451477643, 0.0791661274605434, 0.879142973793104
  );
  mat3 outMatrix = mat3(
     1.19687900512017,  -0.0528968517574562, -0.0529716355144438,
    -0.0980208811401368, 1.15190312990417,   -0.0980434501171241,
    -0.0990297440797205,-0.0989611768448433,  1.15107367264116
  );
  val = inMatrix * val;
  val = clamp((log2(max(val, vec3(1e-10))) + 12.47393) / 16.5, 0.0, 1.0);
  val = AgXContrastApprox(val);
  val = outMatrix * val;
  val = clamp(val, 0.0, 1.0);
  val = AgXPostDisplay(val);
  return clamp(val, 0.0, 1.0);
}

void main() {
  vec4 col = texture(uTexture, vTextureCoord);
  float a = col.a;
  // Blur (and most Pixi filters) output premultiplied RGB. Tonemappers expect associated
  // (straight) color; otherwise edges — e.g. blurred bright foliage on dark sky — pick up
  // a dark fringe. Un-premul → grade → re-premul.
  vec3 rgb = col.rgb;
  if (a > 1e-5) {
    rgb /= a;
  }
  if (uTonemapper == 1) {
    rgb = ACESFilmTonemap(rgb);
  } else if (uTonemapper == 2) {
    rgb = AgXTonemap(rgb);
  } else if (uTonemapper == 3) {
    rgb = ExtendedReinhardToneMap(rgb);
  } else {
    rgb = clamp(rgb, 0.0, 1.0);
  }
  finalColor = vec4(rgb * a, a);
}
`;

type TonemapUniformStruct = {
  uTonemapper: { value: number; type: "i32" };
};

export class TonemapFilter {
  private readonly _filter: Filter;
  private readonly _uniformGroup: UniformGroup<TonemapUniformStruct>;

  constructor() {
    this._uniformGroup = new UniformGroup<TonemapUniformStruct>({
      uTonemapper: { value: 1, type: "i32" },
    });

    const glProgram = GlProgram.from({
      vertex: VERT_SRC,
      fragment: FRAG_SRC,
      name: "stratum-tonemap",
    });

    this._filter = new Filter({
      glProgram,
      resources: { tonemapUniforms: this._uniformGroup },
    });
  }

  get filter(): Filter {
    return this._filter;
  }

  setTonemapper(mode: 0 | 1 | 2 | 3): void {
    if (this._uniformGroup.uniforms.uTonemapper !== mode) {
      this._uniformGroup.uniforms.uTonemapper = mode;
      this._uniformGroup.update();
    }
  }

  /** Must use destroy(false) — GlProgram.from() returns a global singleton. */
  destroy(): void {
    this._filter.destroy(false);
  }
}
