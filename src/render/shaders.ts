/**
 * GLSL ES 3.00 for the compositing pipeline.
 *
 * Coordinate convention: every offscreen target is IMAGE SPACE with row 0 = top of the photo
 * (gl_FragCoord.y = 0.5 writes row 0, and the photo is uploaded unflipped), so passes can use
 * gl_FragCoord.xy directly as image pixels. Only the final pass to the canvas flips y.
 */

export const fullscreenVS = /* glsl */ `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

/**
 * Downsample the (linear-sampled) photo into the base target, using the mip chain. With a body
 * mask the output is premultiplied (rgb·m, m) so the following blur is a normalized
 * convolution: skin colour near the silhouette isn't polluted by the background.
 */
export const downsampleFS = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform sampler2D uMask;
uniform int uHasMask;
uniform float uLod;
uniform vec2 uDstSize;
out vec4 o;
void main() {
  vec2 uv = gl_FragCoord.xy / uDstSize;
  float m = uHasMask == 1 ? texture(uMask, uv).r : 1.0;
  o = vec4(textureLod(uSrc, uv, uLod).rgb * m, m);
}`;

/** The design mesh: image-px positions, design UVs, per-vertex visibility (horizon fade). */
export const meshVS = /* glsl */ `#version 300 es
in vec2 aPos;
in vec2 aUv;
in float aVis;
uniform vec2 uImageSize;
out vec2 vUv;
out float vVis;
void main() {
  vUv = aUv;
  vVis = aVis;
  // Image space: row 0 at gl_FragCoord.y = 0.5, so no y flip here.
  gl_Position = vec4(aPos / uImageSize * 2.0 - 1.0, 0.0, 1.0);
}`;

export const meshFS = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uDesign;  // ink density, mipmapped: the design compresses toward the horizon
in vec2 vUv;
in float vVis;
out vec4 o;
void main() {
  o = vec4(texture(uDesign, vUv).r * vVis, 0.0, 0.0, 1.0);
}`;

/** One axis of a separable Gaussian. Source and destination are the same size. */
export const blurFS = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uDir;      // (1,0) or (0,1)
uniform float uSigma;   // in texels; max ~16
out vec4 o;
void main() {
  vec2 size = vec2(textureSize(uSrc, 0));
  vec2 uv = gl_FragCoord.xy / size;
  if (uSigma < 0.25) { o = texture(uSrc, uv); return; }
  int r = int(ceil(uSigma * 3.0));
  vec4 acc = vec4(0.0);
  float wsum = 0.0;
  for (int i = -48; i <= 48; i++) {
    if (i < -r || i > r) continue;
    float w = exp(-float(i * i) / (2.0 * uSigma * uSigma));
    acc += w * texture(uSrc, uv + uDir * float(i) / size);
    wsum += w;
  }
  o = acc / wsum;
}`;

/**
 * Ink density test shapes, analytic and antialiased to 1px. Deliverable 4 replaces this with
 * the warped design mesh; the composite pass doesn't care where density comes from.
 *   0 rect  — flat density, judges the blend itself
 *   1 ramp  — density 0→1 left to right, judges the opacity curve (Beer–Lambert)
 *   2 rings — line art from hairline to bold, judges edge softness against the photo
 */
export const shapeFS = /* glsl */ `#version 300 es
precision highp float;
uniform vec2 uCenter;   // image px
uniform vec2 uHalf;     // half extents, image px
uniform float uRot;
uniform int uShape;
out vec4 o;

float boxSdf(vec2 p, vec2 h) {
  vec2 d = abs(p) - h;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}

void main() {
  vec2 d = gl_FragCoord.xy - uCenter;
  float c = cos(uRot), s = sin(uRot);
  vec2 p = vec2(c * d.x + s * d.y, -s * d.x + c * d.y);

  float cover = clamp(0.5 - boxSdf(p, uHalf), 0.0, 1.0);
  float dens = 1.0;
  if (uShape == 1) {
    dens = clamp(p.x / uHalf.x * 0.5 + 0.5, 0.0, 1.0);
  } else if (uShape == 2) {
    float r = length(p);
    float R = min(uHalf.x, uHalf.y);
    float period = R / 7.0;
    float t = clamp(r / R, 0.0, 1.0);
    float width = mix(0.03, 0.45, t) * period;          // hairline at the centre, bold at the rim
    float toLine = abs(fract(r / period) - 0.5) * period - 0.5 * width;
    dens = clamp(0.5 - toLine, 0.0, 1.0);
    cover = clamp(0.5 - (r - R), 0.0, 1.0);
  }
  o = vec4(cover * dens, 0.0, 0.0, 1.0);
}`;

/**
 * The composite. Model:
 *   photo C = D + S         D: diffuse (light that went into the skin and came back, skin-coloured)
 *                           S: specular (surface reflection, ~achromatic)
 *   ink sits under the epidermis, so it filters D and leaves S alone:
 *   out = D·T + S
 *
 * Shading transfer falls out of this for free: D already carries the photo's shading, and
 * multiplying in LINEAR space keeps the ink exactly as much darker in shadow as the skin is.
 *
 * D/S split: dichromatic reflection model. Each pixel is a·k + s·white, where k is the local
 * skin colour from the heavily blurred base. Least squares for (a, s), s clamped to ≥ 0.
 *
 * Transmittance T: Beer–Lambert, T = Tfull^density, so diluted ink (grey wash) gets lighter
 * AND bluer the way real dilutions do, instead of just fading. Tfull is the ink's colour
 * lifted by epidermal scatter, which is stronger at short wavelengths: that's why healed
 * black reads blue-black.
 */
export const compositeFS = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uPhoto;   // SRGB8_ALPHA8 → linear on sample
uniform sampler2D uBase;    // blurred linear photo: local skin colour
uniform sampler2D uTrans;   // product of all layers' transmittance, image space (1 = no ink)
uniform sampler2D uStick;   // ablation modes: layers alpha-composited in sRGB, premultiplied
uniform vec2 uImageSize;
uniform vec2 uCanvasSize;
uniform vec3 uView;         // (scale, offsetX, offsetY): canvas px (y down) = image px * scale + offset
uniform float uSpecPass;    // 1 = specular passes over ink (physical), 0 = plain multiply
uniform float uSpecFloor;
uniform float uGrain;
uniform float uNoiseSigma;  // photo noise std-dev, sRGB 0..1
uniform int uMode;          // 0 physical (linear), 1 multiply in sRGB, 2 normal alpha ("sticker")
uniform int uDebug;         // 0 composite, 1 original, 2 diffuse, 3 specular ×4, 4 transmittance, 5 density
out vec4 o;

vec3 toSrgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
vec3 toLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}

// Stable per-image-pixel hash → approx. unit Gaussian (sum of 4 uniforms, recentred).
float hash(uvec2 p) {
  uint h = p.x * 1664525u + p.y * 1013904223u;
  h ^= h >> 16; h *= 2246822519u; h ^= h >> 13; h *= 3266489917u; h ^= h >> 16;
  return float(h) / 4294967295.0;
}
float gauss(vec2 px) {
  uvec2 p = uvec2(px);
  float s = hash(p) + hash(p + uvec2(7919u, 0u)) + hash(p + uvec2(0u, 104729u)) + hash(p + uvec2(1299709u));
  return (s - 2.0) * 1.7320508;  // var of sum of 4 U(0,1) = 1/3
}

void main() {
  vec2 canvasPx = vec2(gl_FragCoord.x, uCanvasSize.y - gl_FragCoord.y);
  vec2 imgPx = (canvasPx - uView.yz) / uView.x;
  if (any(lessThan(imgPx, vec2(0.0))) || any(greaterThanEqual(imgPx, uImageSize))) {
    o = vec4(0.07, 0.07, 0.08, 1.0);
    return;
  }
  vec2 uv = imgPx / uImageSize;
  vec3 C = texture(uPhoto, uv).rgb;
  vec4 baseP = texture(uBase, uv);
  vec3 B = baseP.a > 1e-3 ? baseP.rgb / baseP.a : C;   // un-premultiply the masked base
  vec3 T = texture(uTrans, uv).rgb;
  vec4 st = texture(uStick, uv);

  // Dichromatic split: solve [k·k k·w; k·w 3][a; s] = [k·C; w·C], w = (1,1,1).
  float kk = dot(B, B), kw = B.r + B.g + B.b, kc = dot(B, C), wc = C.r + C.g + C.b;
  float det = 3.0 * kk - kw * kw;
  float sin2 = det / max(3.0 * kk, 1e-8);           // sin² of the angle between skin colour and white
  float conf = smoothstep(0.01, 0.05, sin2);         // grey-ish base: can't separate, assume matte
  // Colour alone confuses "desaturated" with "has white added": existing tattoo ink, hair and
  // stubble are darker and greyer than skin and read as specular. Real highlights add light,
  // so only pixels brighter than their local base may carry any.
  const vec3 Y = vec3(0.2126, 0.7152, 0.0722);
  conf *= smoothstep(1.0, 1.15, dot(C, Y) / max(dot(B, Y), 1e-4));
  float s = det > 1e-8 ? (kk * wc - kw * kc) / det : 0.0;
  s = clamp(s - uSpecFloor, 0.0, min(C.r, min(C.g, C.b))) * conf;
  vec3 S = vec3(s);
  vec3 D = C - S;

  vec3 outSrgb;
  if (uDebug == 1) { o = vec4(toSrgb(C), 1.0); return; }
  if (uDebug == 2) { o = vec4(toSrgb(D), 1.0); return; }
  if (uDebug == 3) { o = vec4(toSrgb(S * 4.0), 1.0); return; }
  if (uDebug == 4) { o = vec4(toSrgb(T), 1.0); return; }
  if (uDebug == 5) { o = vec4(vec3(st.a), 1.0); return; }

  if (uMode == 0) {
    vec3 lin = D * T + S * mix(T, vec3(1.0), uSpecPass);
    outSrgb = toSrgb(lin);
    // Multiplying by T also scaled down the photo's own sensor noise, so inked areas come out
    // cleaner than the skin around them: a giveaway. Put back what was removed.
    float coverage = 1.0 - dot(T, vec3(1.0 / 3.0));
    outSrgb += gauss(imgPx) * uNoiseSigma * uGrain * coverage;
  } else if (uMode == 1) {
    // The common mistake: multiply on gamma-encoded values. Exact for one layer:
    // mix(1, ink, a) = 1 - a + ink·a with the premultiplied ink·a in st.rgb.
    outSrgb = toSrgb(C) * (vec3(1.0 - st.a) + st.rgb);
  } else {
    // The sticker: paint ink over the photo.
    outSrgb = st.rgb + toSrgb(C) * (1.0 - st.a);
  }
  o = vec4(clamp(outSrgb, 0.0, 1.0), 1.0);
}`;


/**
 * One layer's contribution, accumulated with blending:
 *   uTarget 0 → transmittance, multiply-blended into the running product (Beer–Lambert stacks:
 *               two overlapping inks transmit T1·T2, like real overlapping pigment)
 *   uTarget 1 → premultiplied sRGB ink over the running "sticker" composite, for the ablations
 * The body mask is applied here, so ink never lands on the background.
 */
export const accumulateFS = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uDensity;  // this layer's blurred ink density
uniform sampler2D uMask;
uniform int uHasMask;
uniform vec3 uInkColor;      // linear, saturation applied
uniform float uOpacity;
uniform float uScatter;
uniform int uTarget;
out vec4 o;

vec3 toSrgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

void main() {
  vec2 uv = gl_FragCoord.xy / vec2(textureSize(uDensity, 0));
  float mask = uHasMask == 1 ? smoothstep(0.3, 0.7, texture(uMask, uv).r) : 1.0;
  float rho = clamp(texture(uDensity, uv).r * uOpacity * mask, 0.0, 1.0);
  if (uTarget == 0) {
    vec3 scatter = uScatter * vec3(0.55, 0.8, 1.0);
    vec3 Tfull = 1.0 - (1.0 - uInkColor) * (1.0 - scatter);
    o = vec4(pow(max(Tfull, vec3(1e-4)), vec3(rho)), 1.0);
  } else {
    o = vec4(toSrgb(uInkColor) * rho, rho);
  }
}`;
