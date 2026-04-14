import { Filter, GlProgram, UniformGroup } from "pixi.js";
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

type SlimeGelUniforms = {
  uBodyAlpha: { value: number; type: "f32" };
  uShadow0: { value: number; type: "f32" };
  uShadow1: { value: number; type: "f32" };
};

let cachedGlProgram: GlProgram | null = null;

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

/** One filter instance per slime sprite (shared GL program under the hood). */
export function createSlimeGelAlphaFilter(): Filter {
  const slimeGelUniforms = new UniformGroup<SlimeGelUniforms>({
    uBodyAlpha: { value: SLIME_SPRITE_ALPHA, type: "f32" },
    uShadow0: { value: SLIME_GEL_SHADOW_SMOOTH0, type: "f32" },
    uShadow1: { value: SLIME_GEL_SHADOW_SMOOTH1, type: "f32" },
  });
  return new Filter({
    glProgram: slimeGelGlProgram(),
    resources: {
      slimeGelUniforms,
    },
    antialias: "off",
    clipToViewport: true,
  });
}
