// Tier 1A — Final composite pass.
//
// Inputs: linear HDR scene (full-res) + blurred bloom (half-res).
// Output: tonemapped sRGB pixels written to the default framebuffer.
//
// Pipeline:
//   1. Add bloom contribution (texture-space resampled to full res).
//   2. Apply exposure (multiplicative, in stops via 2^E).
//   3. ACES filmic tonemap (Narkowicz approximation — fast, looks correct).
//   4. Linear → sRGB via ~2.2 gamma.
//
// References: Narkowicz 2015 "ACES Filmic Tone Mapping Curve"; Karis 2013
// "Real Shading in Unreal Engine 4" (bloom pyramid). Numerically stable
// and visually neutral — preserves Tanner-Helland blackbody hue chroma in
// the disk, the deep violet of the redshifted Lyα halo, and the orange-
// red Doppler-receding side of the inner disk simultaneously.

export const COMPOSITE_FRAG = /* glsl */ `#version 300 es
precision highp float;

in  vec2 v_ndc;
out vec4 fragColor;

uniform sampler2D u_scene;
uniform sampler2D u_bloom;
uniform float u_bloom_strength;       // 0..3 typical
uniform float u_exposure_stops;       // -3..+3 stops (multiplicative 2^E)

// Narkowicz ACES filmic curve.
vec3 aces(vec3 x) {
    const float a = 2.51;
    const float b = 0.03;
    const float c = 2.43;
    const float d = 0.59;
    const float e = 0.14;
    return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

void main() {
    vec2 uv = v_ndc * 0.5 + 0.5;
    vec3 scene = texture(u_scene, uv).rgb;
    vec3 bloom = texture(u_bloom, uv).rgb;

    vec3 hdr = scene + u_bloom_strength * bloom;
    hdr *= exp2(u_exposure_stops);

    vec3 ldr = aces(hdr);
    // Linear → sRGB (cheap 2.2 gamma).
    ldr = pow(ldr, vec3(1.0 / 2.2));
    fragColor = vec4(ldr, 1.0);
}
`;
