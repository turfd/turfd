/** GLSL fragments for {@link ScreenSpaceNormalPass} — full-res height from terrain albedo, blur, normals. */

export const SSN_FILTER_VERT = `in vec2 aPosition;
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
 * Height from luminance (texture detail). Input is the **main** albedo RT (same buffer as composite).
 * Sprites/lighting can affect Sobel near entities; tradeoff for pixel-locked alignment vs a second render.
 */
export const SSN_HEIGHT_FROM_ALBEDO_FRAG = `in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform float uAlphaCutoff;
uniform float uDetail;

void main(void) {
  vec4 c = texture(uTexture, vTextureCoord);
  if (c.a <= uAlphaCutoff) {
    finalColor = vec4(0.0);
    return;
  }
  float lum = dot(c.rgb, vec3(0.299, 0.587, 0.114));
  float h = 0.5 + lum * uDetail;
  h = clamp(h, 0.0, 4.0);
  finalColor = vec4(h / 4.0, 0.0, 0.0, 1.0);
}
`;

/** Separable box blur on encoded height in R. */
export const SSN_BLUR_HEIGHT_FRAG = `in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform vec2 uDirection;
uniform vec2 uTexel;
uniform int uRadius;

void main(void) {
  vec4 c0 = texture(uTexture, vTextureCoord);
  if (c0.a < 0.5) {
    finalColor = vec4(0.0);
    return;
  }
  float acc = c0.r;
  int count = 1;
  for (int i = 1; i <= 10; i++) {
    if (i > uRadius) break;
    vec2 o = uDirection * uTexel * float(i);
    vec4 c1 = texture(uTexture, vTextureCoord + o);
    vec4 c2 = texture(uTexture, vTextureCoord - o);
    if (c1.a >= 0.5) { acc += c1.r; count++; }
    if (c2.a >= 0.5) { acc += c2.r; count++; }
  }
  finalColor = vec4(acc / float(count), 0.0, 0.0, 1.0);
}
`;

export const SSN_NORMAL_FRAG = `in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform sampler2D uAlbedo;
uniform vec2 uTexel;
uniform float uStrength;
uniform float uInvertX;
uniform float uInvertY;

void main(void) {
  vec4 alb = texture(uAlbedo, vTextureCoord);
  if (alb.a < 0.04) {
    finalColor = vec4(0.5, 0.5, 1.0, 0.0);
    return;
  }
  vec2 tc = vTextureCoord;
  vec4 hL = texture(uTexture, tc - vec2(uTexel.x, 0.0));
  vec4 hR = texture(uTexture, tc + vec2(uTexel.x, 0.0));
  vec4 hT = texture(uTexture, tc - vec2(0.0, uTexel.y));
  vec4 hB = texture(uTexture, tc + vec2(0.0, uTexel.y));
  float hl = hL.a >= 0.5 ? hL.r * 4.0 : 0.0;
  float hr = hR.a >= 0.5 ? hR.r * 4.0 : 0.0;
  float ht = hT.a >= 0.5 ? hT.r * 4.0 : 0.0;
  float hb = hB.a >= 0.5 ? hB.r * 4.0 : 0.0;
  float dx = (hl - hr) * uStrength * uInvertX;
  float dy = (ht - hb) * uStrength * uInvertY;
  float dz = 1.0;
  float mag = sqrt(dx * dx + dy * dy + dz * dz);
  float nx = mag > 0.0 ? dx / mag : 0.0;
  float ny = mag > 0.0 ? dy / mag : 0.0;
  float nz = mag > 0.0 ? dz / mag : 1.0;
  finalColor = vec4(
    nx * 0.5 + 0.5,
    ny * 0.5 + 0.5,
    nz * 0.5 + 0.5,
    1.0
  );
}
`;
