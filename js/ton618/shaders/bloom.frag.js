// Tier 1A — Bloom pipeline shaders.
//
// Two post-process shaders share the same vertex shader (FULLSCREEN_VERT):
//
//   BLOOM_EXTRACT_FRAG   — bright-pass with smooth knee. Reads the linear
//                          HDR scene texture; writes the bright fraction
//                          downsampled to a half-resolution RGBA16F target.
//   BLOOM_BLUR_FRAG      — separable Gaussian (9 taps, σ ≈ 2). One pass
//                          horizontal then one pass vertical via the
//                          u_axis uniform; ping-pongs between two half-res
//                          textures.
//
// The "smooth knee" formulation (Karis 2013, Real Shading in Unreal
// Engine 4) avoids the hard threshold flicker artifact: pixels just under
// the knee contribute proportionally instead of cutting off discontinuously.

export const BLOOM_EXTRACT_FRAG = /* glsl */ `#version 300 es
precision highp float;

in  vec2 v_ndc;
out vec4 fragColor;

uniform sampler2D u_scene;
uniform vec2  u_texel;       // 1.0 / scene resolution (full-res texels)
uniform float u_threshold;   // luminance below this contributes nothing
uniform float u_knee;        // soft-knee half-width

vec3 brightExtract(vec3 c) {
    float br = max(c.r, max(c.g, c.b));
    // Soft-knee curve: smoothly ramps from 0 at (threshold − knee) to
    // (br − threshold) at (threshold + knee). Avoids hard cut-off.
    float soft = clamp(br - u_threshold + u_knee, 0.0, 2.0 * u_knee);
    soft = soft * soft / (4.0 * u_knee + 1.0e-4);
    float weight = max(soft, br - u_threshold) / max(br, 1.0e-4);
    return c * weight;
}

void main() {
    // 4-tap bilinear box downsample to half-res, with bright-pass per tap.
    // Sampling at half-pixel offsets in scene space gives a clean 2× downsample.
    vec2 uv = v_ndc * 0.5 + 0.5;
    vec3 c0 = texture(u_scene, uv + vec2(-0.5, -0.5) * u_texel).rgb;
    vec3 c1 = texture(u_scene, uv + vec2( 0.5, -0.5) * u_texel).rgb;
    vec3 c2 = texture(u_scene, uv + vec2(-0.5,  0.5) * u_texel).rgb;
    vec3 c3 = texture(u_scene, uv + vec2( 0.5,  0.5) * u_texel).rgb;
    vec3 avg = 0.25 * (brightExtract(c0) + brightExtract(c1)
                     + brightExtract(c2) + brightExtract(c3));
    fragColor = vec4(avg, 1.0);
}
`;

export const BLOOM_BLUR_FRAG = /* glsl */ `#version 300 es
precision highp float;

in  vec2 v_ndc;
out vec4 fragColor;

uniform sampler2D u_input;
uniform vec2  u_texel;       // 1.0 / input texture resolution
uniform vec2  u_axis;        // (1, 0) for horizontal, (0, 1) for vertical

// 9-tap Gaussian, σ ≈ 2. Symmetric weights, normalized to sum 1.
const float W0 = 0.172;
const float W1 = 0.155;
const float W2 = 0.129;
const float W3 = 0.086;
const float W4 = 0.043;

void main() {
    vec2 uv = v_ndc * 0.5 + 0.5;
    vec3 c = vec3(0.0);
    c += W0 * texture(u_input, uv).rgb;
    c += W1 * texture(u_input, uv + u_axis * u_texel * 1.0).rgb;
    c += W1 * texture(u_input, uv - u_axis * u_texel * 1.0).rgb;
    c += W2 * texture(u_input, uv + u_axis * u_texel * 2.0).rgb;
    c += W2 * texture(u_input, uv - u_axis * u_texel * 2.0).rgb;
    c += W3 * texture(u_input, uv + u_axis * u_texel * 3.0).rgb;
    c += W3 * texture(u_input, uv - u_axis * u_texel * 3.0).rgb;
    c += W4 * texture(u_input, uv + u_axis * u_texel * 4.0).rgb;
    c += W4 * texture(u_input, uv - u_axis * u_texel * 4.0).rgb;
    fragColor = vec4(c, 1.0);
}
`;
