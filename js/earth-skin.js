/**
 * earth-skin.js — Shared Earth surface + cloud renderer for Celestial Simulator
 * ═══════════════════════════════════════════════════════════════════════════════
 * Used by earth.html (full Earth sim), space-weather-globe.js (magnetosphere
 * context), and heliosphere3d.js (solar system sim).
 *
 * Exports:
 *   EARTH_TEXTURES        — { day, night, ocean, clouds } CDN URLs (version-pinned)
 *   EARTH_VERT / EARTH_FRAG — Earth surface GLSL shaders
 *   CLOUD_VERT / CLOUD_FRAG — Cloud layer GLSL shaders (with cyclonic storm swirl)
 *   createEarthUniforms(sunDir) — default uniform block for earth surface
 *   createCloudUniforms(sunDir) — default uniform block for cloud layer
 *   loadEarthTextures(eu, cu)   — loads textures into uniforms, returns Promise
 *   EarthSkin                   — convenience class: creates + manages the full stack
 *
 * OWNERSHIP SPLIT (pages):
 *   earth.html          full fidelity — 80 seg, aurora, weather, storms, city lights
 *   space-weather-globe  medium — 64 seg, aurora, no weather data, no storms
 *   heliosphere3d        lightweight — 28 seg, no aurora, no storms (too distant)
 */

import * as THREE from 'three';
import { geo } from './geo/coords.js';

// ── Version-pinned CDN — avoids broken URLs from three-globe package updates ──
const _CDN = 'https://unpkg.com/three-globe@2.31.0/example/img/';
export const EARTH_TEXTURES = {
    day:      _CDN + 'earth-blue-marble.jpg',
    night:    _CDN + 'earth-night.jpg',
    ocean:    _CDN + 'earth-water.png',
    topology: _CDN + 'earth-topology.png',
};

// ── Safe 1×1 placeholder textures (prevent null-sampler GPU crashes) ─────────
function _blackTex() {
    const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat);
    t.needsUpdate = true;
    return t;
}
function _grayTex() {
    const t = new THREE.DataTexture(new Uint8Array([180, 185, 200, 255]), 1, 1, THREE.RGBAFormat);
    t.needsUpdate = true;
    return t;
}

// ── Procedural noise texture (replaces CDN clouds.png dependency) ────────────
// Generates a tileable multi-octave value noise texture on the CPU.
// Used as the fine-detail layer in the cloud shader (25% blend weight).
function _proceduralCloudNoise(W = 512, H = 256) {
    function hash(ix, iy) {
        let n = Math.sin(ix * 127.1 + iy * 311.7) * 43758.5453;
        return n - Math.floor(n);
    }
    function vnoise(x, y) {
        const ix = Math.floor(x), iy = Math.floor(y);
        const fx = x - ix, fy = y - iy;
        const sx = fx * fx * (3 - 2 * fx);
        const sy = fy * fy * (3 - 2 * fy);
        const a = hash(ix, iy), b = hash(ix + 1, iy);
        const c = hash(ix, iy + 1), d = hash(ix + 1, iy + 1);
        return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
    }
    function fbm(x, y) {
        let val = 0, amp = 0.5, freq = 1;
        for (let o = 0; o < 5; o++) {
            val += amp * vnoise(x * freq, y * freq);
            freq *= 2.0; amp *= 0.5;
        }
        return val;
    }
    const data = new Uint8Array(W * H * 4);
    for (let j = 0; j < H; j++) {
        for (let i = 0; i < W; i++) {
            const n = fbm(i / W * 10, j / H * 5);
            const v = Math.max(0, Math.min(255, (n * 255) | 0));
            const k = (j * W + i) * 4;
            data[k] = data[k + 1] = data[k + 2] = v;
            data[k + 3] = 255;
        }
    }
    const t = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.needsUpdate = true;
    return t;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  EARTH SURFACE SHADERS
// ═══════════════════════════════════════════════════════════════════════════════

export const EARTH_VERT = /* glsl */`
varying vec2 vUv;
varying vec3 vWorldNormal;
varying vec3 vWorldPos;
void main() {
    vUv          = uv;
    vWorldNormal = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
    vWorldPos    = (modelMatrix * vec4(position, 1.0)).xyz;
    gl_Position  = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

export const EARTH_FRAG = /* glsl */`
precision highp float;

uniform sampler2D u_day;
uniform sampler2D u_night;
uniform sampler2D u_specular;   // ocean mask (r = ocean)
uniform sampler2D u_topology;   // grayscale height / elevation (r = normalised height)
uniform sampler2D u_weather;    // R=temp, G=pressure [0=low,1=high], B=humidity, A=wind
uniform vec3  u_sun_dir;
uniform float u_time;
uniform float u_kp;
uniform float u_xray;
uniform float u_city_lights;
uniform float u_aurora_on;
uniform float u_weather_on;
uniform float u_aurora_power;
uniform float u_bz_south;
uniform float u_dst_norm;
uniform float u_bump_strength;  // 0 = flat, ~1 = pronounced relief

varying vec2 vUv;
varying vec3 vWorldNormal;
varying vec3 vWorldPos;

// ── Aurora curtains ────────────────────────────────────────────────────────────
vec3 auroraColor(float sinAbsLat, float lon, float kp) {
    float kpEff  = kp + u_bz_south * 2.5;
    float ovalCtr = 0.940 - clamp(kpEff, 0.0, 9.0) * 0.0197;
    float ovalW   = 0.045 + (kpEff / 9.0) * 0.055;

    float zone = smoothstep(ovalCtr - ovalW * 1.5, ovalCtr, sinAbsLat)
               * (1.0 - smoothstep(ovalCtr + ovalW * 0.4, ovalCtr + ovalW * 1.5, sinAbsLat));
    if (zone < 0.001) return vec3(0.0);

    float phase  = u_time * 1.4 + lon * 9.0;
    float anim   = (0.55 + 0.45 * sin(phase)) * (0.7 + 0.3 * sin(phase * 2.1 + 1.0));

    float powerScale = 0.30 + 0.70 * u_aurora_power;
    float bright = zone * anim * powerScale;

    vec3 lo = vec3(0.05, 0.95, 0.15);
    vec3 hi = vec3(0.90, 0.10, 0.80);
    float stormMix = clamp((kpEff - 3.0) / 6.0, 0.0, 1.0);
    return mix(lo, hi, stormMix) * bright * 0.90;
}

// ── Weather / temperature colour ramp ─────────────────────────────────────────
vec3 weatherOverlay(vec2 uv) {
    float temp = texture2D(u_weather, uv).r;
    vec3 polar    = vec3(0.05, 0.15, 0.80);
    vec3 tempZone = vec3(0.20, 0.75, 0.30);
    vec3 subtrop  = vec3(0.95, 0.60, 0.05);
    vec3 tropic   = vec3(0.85, 0.05, 0.10);
    vec3 c;
    if (temp < 0.33)      c = mix(polar,    tempZone, temp / 0.33);
    else if (temp < 0.55) c = mix(tempZone, subtrop,  (temp - 0.33) / 0.22);
    else                  c = mix(subtrop,  tropic,   (temp - 0.55) / 0.45);
    return c;
}

void main() {
    vec3 N_base = normalize(vWorldNormal);

    vec3 dayCol    = texture2D(u_day,      vUv).rgb;
    vec3 nightCol  = texture2D(u_night,    vUv).rgb * 2.5;
    float oceanMsk = texture2D(u_specular, vUv).r;

    // ── Topographic normal perturbation ────────────────────────────────
    // Sample the height map at three offset UVs and build a tangent-space
    // gradient. Project that gradient into the surface tangent basis so
    // mountains cast the right shadow regardless of camera angle. Ocean
    // is kept flat — bump only affects land via (1 - oceanMsk).
    float hC   = texture2D(u_topology, vUv).r;
    float hDx  = texture2D(u_topology, vUv + vec2(1.0 / 2048.0, 0.0)).r - hC;
    float hDy  = texture2D(u_topology, vUv + vec2(0.0, 1.0 / 1024.0)).r - hC;
    // East / north tangents at the current surface point
    vec3  up      = vec3(0.0, 1.0, 0.0);
    vec3  tEast   = normalize(cross(up, N_base));
    vec3  tNorth  = normalize(cross(N_base, tEast));
    float landMsk = (1.0 - oceanMsk) * u_bump_strength;
    vec3  N = normalize(N_base - (tEast * hDx + tNorth * hDy) * 85.0 * landMsk);

    float NdotL  = dot(N, u_sun_dir);
    float dayMix = smoothstep(-0.10, 0.20, NdotL);

    // Self-shadow: terrain shading is strongest when sun is low and hitting
    // the slope obliquely. Boosts mountain-range relief at the terminator.
    float shading = mix(1.0, clamp(NdotL * 0.5 + 0.5, 0.55, 1.25),
                        landMsk * smoothstep(-0.20, 0.10, NdotL));
    dayCol *= shading;

    // Keep the Blue Marble readable on the night side at ~55% instead of
    // fading it to black. City lights layer additively on top so both cues
    // co-exist near the terminator (photograph + lamps), not cross-fade.
    vec3 base = dayCol * (0.55 + 0.45 * dayMix)
              + nightCol * u_city_lights * (1.0 - dayMix);

    // Ocean specular glint (use the un-perturbed normal; water doesn't
    // inherit the height map's bumps).
    vec3  V    = normalize(cameraPosition - vWorldPos);
    vec3  H    = normalize(u_sun_dir + V);
    float spec = pow(max(dot(N_base, H), 0.0), 90.0) * oceanMsk * dayMix * 0.60;
    base += vec3(spec * 0.7, spec * 0.85, spec);

    // Weather temperature overlay
    if (u_weather_on > 0.5) {
        base = mix(base, weatherOverlay(vUv), 0.28);
    }

    // Aurora
    if (u_aurora_on > 0.5 && u_kp > 1.5) {
        float lat    = (vUv.y - 0.5) * 3.14159265;
        float lon    = (vUv.x - 0.5) * 6.28318530;
        float sinAbs = abs(sin(lat));
        float nightM = 1.0 - smoothstep(-0.20, 0.30, NdotL);
        base += auroraColor(sinAbs, lon, u_kp) * nightM;
    }

    // X-ray ionospheric flash (dayside HF blackout)
    if (u_xray > 0.25 && dayMix > 0.4) {
        float flash = (u_xray - 0.25) / 0.75 * dayMix;
        base += vec3(0.3, 0.5, 1.0) * flash * 0.30;
    }

    // Ring current heating: equatorial nightside reddish glow
    if (u_dst_norm > 0.08) {
        float lat    = (vUv.y - 0.5) * 3.14159265;
        float absLat = abs(lat);
        float rcZone = smoothstep(0.0, 0.20, 0.55 - absLat) * (1.0 - dayMix);
        base += vec3(0.85, 0.25, 0.05) * rcZone * u_dst_norm * 0.28;
    }

    // Southward Bz: faint particle injection on nightside
    if (u_bz_south > 0.15) {
        float bzGlow = (u_bz_south - 0.15) / 0.85;
        float nightM = 1.0 - smoothstep(-0.25, 0.10, NdotL);
        base += vec3(0.10, 0.35, 0.90) * bzGlow * nightM * 0.12;
    }

    // Lighting: half-Lambert without squaring — Blue Marble is already a daylit photo;
    // squaring creates a harsh spotlight effect.  Keep a gentle falloff + raised ambient.
    float halfLamb = clamp(NdotL * 0.5 + 0.5, 0.0, 1.0);
    float lit      = mix(0.35, halfLamb, dayMix);
    base *= lit;

    // Terminator warm glow
    float termZone = smoothstep(-0.08, 0.0, NdotL) * smoothstep(0.18, 0.06, NdotL);
    base += vec3(0.55, 0.25, 0.04) * termZone * 0.22;

    gl_FragColor = vec4(base, 1.0);
}`;

// ═══════════════════════════════════════════════════════════════════════════════
//  CLOUD LAYER SHADERS  (with cyclonic storm swirl)
// ═══════════════════════════════════════════════════════════════════════════════

export const CLOUD_VERT = /* glsl */`
varying vec2 vUv;
varying vec3 vWorldNormal;
void main() {
    vUv          = uv;
    vWorldNormal = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
    gl_Position  = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

export const CLOUD_FRAG = /* glsl */`
precision mediump float;

uniform sampler2D u_clouds;
uniform sampler2D u_weather;       // R=temp, G=pressure, B=humidity, A=wind
uniform sampler2D u_cloud_layers;  // R=cl_low, G=cl_mid, B=cl_high, A=precip [0-1]
uniform sampler2D u_satellite;     // GOES/MODIS cloud image (grayscale brightness)
uniform vec3  u_sun_dir;
uniform float u_time;
uniform float u_weather_on;
uniform float u_satellite_on;      // blend satellite into cloud appearance

// Storm systems: .xy = UV position, .z = intensity [0-1], .w = spin (+1 CCW/-1 CW)
uniform vec4 u_storms[8];
uniform int  u_storm_count;

varying vec2 vUv;
varying vec3 vWorldNormal;

// ── Procedural noise for natural cloud shapes ────────────────────────────────
// Hash-based value noise + FBM give multi-scale cloud structure directly in
// the shader, independent of texture resolution. We also keep a 3-D variant
// so the third coordinate can be fed u_time — clouds then MORPH in place
// instead of rigidly drifting across the globe.

float hash21(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

float hash31(vec3 p) {
    p = fract(p * vec3(0.1031, 0.1030, 0.0973));
    p += dot(p, p.yzx + 33.33);
    return fract((p.x + p.y) * p.z);
}

float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// 3-D value noise — trilinear interpolation of hashed lattice values
float vnoise3(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float n000 = hash31(i);
    float n100 = hash31(i + vec3(1.0, 0.0, 0.0));
    float n010 = hash31(i + vec3(0.0, 1.0, 0.0));
    float n110 = hash31(i + vec3(1.0, 1.0, 0.0));
    float n001 = hash31(i + vec3(0.0, 0.0, 1.0));
    float n101 = hash31(i + vec3(1.0, 0.0, 1.0));
    float n011 = hash31(i + vec3(0.0, 1.0, 1.0));
    float n111 = hash31(i + vec3(1.0, 1.0, 1.0));
    float x00 = mix(n000, n100, f.x);
    float x10 = mix(n010, n110, f.x);
    float x01 = mix(n001, n101, f.x);
    float x11 = mix(n011, n111, f.x);
    float y0  = mix(x00, x10, f.y);
    float y1  = mix(x01, x11, f.y);
    return mix(y0, y1, f.z);
}

float fbm(vec2 p, int octaves) {
    float val = 0.0;
    float amp = 0.5;
    float freq = 1.0;
    for (int i = 0; i < 6; i++) {
        if (i >= octaves) break;
        val += amp * vnoise(p * freq);
        freq *= 2.0;
        amp *= 0.5;
    }
    return val;
}

// 3-D FBM — same construction in (x, y, z). Third coord is time-sliced by
// callers to give clouds the slow morph of real convection.
float fbm3(vec3 p, int octaves) {
    float val = 0.0;
    float amp = 0.5;
    float freq = 1.0;
    for (int i = 0; i < 6; i++) {
        if (i >= octaves) break;
        val += amp * vnoise3(p * freq);
        freq *= 2.0;
        amp *= 0.5;
    }
    return val;
}

// Domain-warped 3-D FBM. A low-frequency FBM lookup is used as an offset
// into a higher-frequency FBM, which breaks straight-line artifacts that
// pure FBM leaves behind — no more horizontal "strips" in the cloud cover.
float warpedFbm3(vec3 p, int octaves) {
    vec3 warp = vec3(
        fbm3(p * 0.8 + vec3(17.3, -3.1,  0.0), 3),
        fbm3(p * 0.8 + vec3(-9.6, 12.4,  0.0), 3),
        fbm3(p * 0.8 + vec3( 4.2,  7.8,  0.0), 3)
    ) - 0.5;
    return fbm3(p + warp * 1.15, octaves);
}

// ── Cyclonic swirl UV offset ──────────────────────────────────────────────────
// For each active storm, rotate the cloud lookup UV around the storm eye.
// Northern Hemisphere: CCW (spin=+1). Southern Hemisphere: CW (spin=-1).
vec2 stormSwirl(vec2 uv) {
    vec2 swirl = vec2(0.0);
    for (int i = 0; i < 8; i++) {
        if (i >= u_storm_count) break;
        vec2  center = u_storms[i].xy;
        float inten  = u_storms[i].z;
        float spin   = u_storms[i].w;

        vec2 d = uv - center;
        // Wrap longitude seam (UV u is periodic)
        if (d.x >  0.5) d.x -= 1.0;
        if (d.x < -0.5) d.x += 1.0;

        float dist   = length(d);
        float radius = 0.07 + inten * 0.05;   // storm radius in UV space (≈ 700–1200 km)

        if (dist < radius * 2.2) {
            float falloff = smoothstep(radius * 2.2, 0.0, dist);
            float angle   = spin * inten * falloff * 2.2;   // max ~126° spiral
            float c = cos(angle), s = sin(angle);
            vec2 rotated = vec2(d.x * c - d.y * s, d.x * s + d.y * c);
            swirl += (rotated - d) * falloff;
        }
    }
    return swirl;
}

// ── Eye / eyewall structure for intense storms ────────────────────────────────
// Storms with intensity > 0.5 (tropical storm / hurricane threshold) get a
// clear eye at the center and a dense eyewall ring just outside it.
// Returns a [0,1] multiplier to apply to cloud alpha.
float stormStructure(vec2 uv) {
    float mult = 1.0;
    for (int i = 0; i < 8; i++) {
        if (i >= u_storm_count) break;
        vec2  center = u_storms[i].xy;
        float inten  = u_storms[i].z;
        if (inten < 0.35) continue;   // only TS / hurricane strength

        vec2 d = uv - center;
        if (d.x >  0.5) d.x -= 1.0;
        if (d.x < -0.5) d.x += 1.0;
        float dist = length(d);

        float eyeR   = 0.008 + inten * 0.006;   // eye radius (~60–100 km)
        float wallR  = eyeR * 2.2;               // eyewall outer edge

        // Clear eye
        float eyeMask = 1.0 - smoothstep(eyeR * 0.5, eyeR, dist);
        // Dense eyewall ring: max density between eyeR and wallR
        float wallMask = smoothstep(eyeR, eyeR * 1.2, dist)
                       * (1.0 - smoothstep(wallR, wallR * 1.5, dist));

        mult = mix(mult, 0.05, eyeMask * inten);
        mult = clamp(mult + wallMask * inten * 0.9, 0.0, 1.8);
    }
    return mult;
}

void main() {
    vec3  N     = normalize(vWorldNormal);
    float NdotL = dot(N, u_sun_dir);
    float lit   = clamp(NdotL * 0.5 + 0.5, 0.0, 1.0);
    lit = lit * lit;

    // Compute cyclonic UV swirl from active storm systems
    vec2 swirl = (u_storm_count > 0) ? stormSwirl(vUv) : vec2(0.0);

    // Slow horizontal drift + independent time slice fed into the third
    // noise dimension — the 3-D slice lets clouds MORPH (form / dissipate)
    // in place instead of sliding across the sphere as a rigid texture.
    vec2  driftLow  = vec2(u_time * 0.0000330, u_time * 0.0000040);
    vec2  driftMid  = vec2(u_time * 0.0000480, u_time * 0.0000060);
    vec2  driftHigh = vec2(u_time * 0.0000720, u_time * 0.0000090);
    float tLow  = u_time * 0.00060;
    float tMid  = u_time * 0.00085;
    float tHigh = u_time * 0.00120;

    vec2 uvLow  = vUv + driftLow  + swirl;
    vec2 uvMid  = vUv + driftMid  + swirl * 0.7;
    vec2 uvHigh = vUv + driftHigh + swirl * 0.4;

    // ── Multi-octave procedural noise per cloud layer ────────────────────────
    // Each layer samples domain-warped 3-D FBM at its own frequency + time
    // slice so layers evolve independently and nothing reads as parallel bands.

    // Low cumulus: defined puffy cells
    float nLow  = warpedFbm3(vec3(uvLow  * 14.0,        tLow),  5);
    // Mid altostratus: smoother, broader
    float nMid  = warpedFbm3(vec3(uvMid  *  9.5 + 3.7,  tMid),  4);
    // High cirrus: anisotropic sampling gives the wispy elongated look,
    // but the domain warp keeps it from reading as horizontal stripes.
    float nHigh = warpedFbm3(vec3(uvHigh.x * 22.0, uvHigh.y * 8.0, tHigh) + vec3(7.3, 7.3, 0.0), 5);

    // Previously we blended a separate procedural noise texture in at
    // ~10-12% for pixel-scale grain. That texture was generated flat on a
    // 2:1 equirect canvas, which stretched features into horizontal stripes
    // when wrapped onto a sphere. The shader's own warpedFbm3 already gives
    // multi-octave detail on a spherical domain (no seams, no elongation),
    // so the lookup is intentionally skipped.

    float alphaLow = 0.0, alphaMid = 0.0, alphaHigh = 0.0;
    float precip   = 0.0;

    // ── Cloud formation ─────────────────────────────────────────────────────
    // Previous implementation gated formation by the zonal weather fraction
    // (smoothstep 0.03→0.45 on a ~10°-coarse input). On most days the input
    // is strongly zonal, so entire latitude bands were suppressed and the
    // user saw horizontal strips of cloud / no-cloud.
    //
    // New formation: the noise always produces a *full* cloud field; the
    // weather fraction only nudges local density up or down by ±25%, and
    // the global cover is rate-limited to a sane base. A longitudinally
    // offset bias term from the noise itself prevents any residual banding.
    float shapeLow  = smoothstep(0.36, 0.58, nLow);
    float shapeMid  = smoothstep(0.38, 0.62, nMid);
    float shapeHigh = smoothstep(0.40, 0.72, nHigh);

    // Global base cover — constant across latitudes so the shader can never
    // produce a completely clear band just because the weather grid says so.
    const float BASE_LOW  = 0.72;
    const float BASE_MID  = 0.48;
    const float BASE_HIGH = 0.32;

    if (u_weather_on > 0.5) {
        vec4  cl      = texture2D(u_cloud_layers, vUv);
        float clLow   = cl.r;
        float clMid   = cl.g;
        float clHigh  = cl.b;
        precip        = cl.a;

        // ±25% modulation. clLow in [0,1] → modulator in [0.75, 1.25].
        float modLow  = 0.75 + clLow  * 0.50;
        float modMid  = 0.75 + clMid  * 0.50;
        float modHigh = 0.75 + clHigh * 0.50;

        alphaLow  = shapeLow  * BASE_LOW  * modLow;
        alphaMid  = shapeMid  * BASE_MID  * modMid;
        alphaHigh = shapeHigh * BASE_HIGH * modHigh;
    } else {
        // No weather data: pure noise-driven clouds at the base density.
        alphaLow  = shapeLow  * BASE_LOW;
        alphaMid  = shapeMid  * BASE_MID;
        alphaHigh = shapeHigh * BASE_HIGH;
    }

    // Satellite observation: when a real cloud-imagery texture is supplied
    // (NASA GIBS, GOES, etc.), use its brightness as the dominant coverage
    // signal and fold the procedural noise in as fine-scale detail + motion.
    //
    // The texture's alpha channel is a NO-DATA mask set by GIBS. Regions
    // the satellite didn't see (polar winter darkness, MODIS orbit gaps,
    // coastline masks) arrive with alpha = 0 and we route them back to
    // procedural clouds, so the globe never shows a permanent fake cap.
    if (u_satellite_on > 0.5) {
        vec4  sat      = texture2D(u_satellite, vUv);
        float satCloud = sat.r;
        float satData  = sat.a;                             // 1 where MODIS has coverage
        float satShape = smoothstep(0.18, 0.85, satCloud);
        float satLow   = satShape * mix(0.85, 1.0, shapeLow);
        float satMid   = satShape * mix(0.55, 0.85, shapeMid);
        // Coverage-weighted blend: full satellite influence only where the
        // alpha mask confirms the pixel is real data.
        float influence = satData * 0.82;
        alphaLow  = mix(alphaLow,  satLow,           influence);
        alphaMid  = mix(alphaMid,  satMid,           0.60 * satData);
        alphaHigh = mix(alphaHigh, satShape * 0.35,  0.35 * satData);
    }

    // Composite layers: opaque low clouds dominate, cirrus adds on top
    float alpha = max(alphaLow, alphaMid);
    alpha = clamp(alpha + alphaHigh * (1.0 - alpha * 0.55), 0.0, 0.95);

    // Eye/eyewall structure for active hurricanes/typhoons
    if (u_storm_count > 0) {
        alpha *= stormStructure(vUv);
        alpha  = clamp(alpha, 0.0, 0.95);
    }

    // ── Cloud colour ──────────────────────────────────────────────────────────
    vec3 cloudWhite = mix(vec3(0.82, 0.85, 0.92), vec3(0.97, 0.98, 1.00), lit);
    vec3 rainGrey   = vec3(0.50, 0.53, 0.62);
    vec3 cirrusTint = vec3(0.88, 0.92, 1.00);
    vec3 nightCol   = vec3(0.22, 0.26, 0.38);

    float dayMix  = smoothstep(-0.12, 0.20, NdotL);
    vec3  col     = mix(nightCol, cloudWhite, dayMix);

    // Thin cloud edges: slightly blue-tinted for translucency
    float edgeSoft = smoothstep(0.0, 0.35, alpha);
    col = mix(col * vec3(0.92, 0.94, 1.0), col, edgeSoft);

    // Blend in precipitation darkening (only visible side)
    float precipVis = precip * dayMix;
    col = mix(col, rainGrey, precipVis * 0.55);

    // Blend in cirrus tint where high-cloud fraction dominates
    float cirrusDom = alphaHigh / max(0.01, alpha);
    col = mix(col, cirrusTint, cirrusDom * dayMix * 0.35);

    // Warm golden tint at terminator (sunrise/sunset through clouds)
    float termZone = smoothstep(-0.10, 0.0, NdotL) * smoothstep(0.22, 0.06, NdotL);
    col = mix(col, vec3(0.95, 0.72, 0.28), termZone * 0.32 * (1.0 - precipVis * 0.5));

    // ── Falling precipitation streaks ────────────────────────────────────────
    // Where the weather feed's precipitation channel is non-zero, paint short
    // downward-scrolling streaks on top of the cloud. The pattern is purely
    // procedural: narrow stripes in longitude, short dashes in latitude, the
    // dashes slide toward the equator-facing side over time to read as rain
    // falling out of the cloud base.
    //
    // Regime separation: tropical latitudes render tighter, denser, faster
    // streaks (convective cells); mid-latitudes render longer, sparser,
    // slower streaks (frontal rain). High-latitude precip shifts toward a
    // lighter blue-white tint so it reads as sleet/snow rather than rain.
    if (u_weather_on > 0.5 && precip > 0.02) {
        float latDeg = (vUv.y - 0.5) * 180.0;
        float absLat = abs(latDeg);

        // 0 = tropical (convective), 1 = frontal (stratiform)
        float regime = smoothstep(15.0, 45.0, absLat);

        float freqX     = mix(260.0, 210.0, regime);   // streak density across lon
        float freqY     = mix(160.0, 105.0, regime);   // dash length along lat
        float fallSpd   = mix(0.055, 0.032, regime);   // v-axis scroll rate

        // Per-column random phase so dashes don't march in lockstep across
        // whole latitude bands. hash21 is defined in the noise block above.
        float colId    = floor(vUv.x * freqX);
        float colPhase = hash21(vec2(colId, 17.3)) * 3.0;

        float sx = vUv.x * freqX;
        float sy = vUv.y * freqY - u_time * fallSpd * freqY - colPhase;

        // Horizontal mask — thin vertical stripe centred in each unit cell.
        float streakH = 1.0 - smoothstep(0.06, 0.16, abs(fract(sx) - 0.5));

        // Vertical mask — short dash that fades in and out within each cell.
        float fy = fract(sy);
        float streakV = smoothstep(0.0, 0.28, fy) * (1.0 - smoothstep(0.52, 0.92, fy));

        float streak = streakH * streakV;

        // Gate by precip intensity (0.02 → fade in, 0.30 → full) and modulate
        // by daylight so the streaks don't overwhelm the night side where the
        // cloud base is already dark. They stay faintly visible at night so
        // storms remain identifiable over populated regions.
        float precipMask = smoothstep(0.02, 0.30, precip);
        streak *= precipMask * (0.35 + 0.65 * dayMix);

        // Rain colour: mid grey-blue on warm regions, pale icy blue toward
        // the poles to hint at frozen precipitation.
        vec3 rainShade = mix(
            vec3(0.30, 0.38, 0.52),    // rain
            vec3(0.78, 0.86, 1.00),    // sleet/snow
            smoothstep(55.0, 72.0, absLat)
        );

        // Apply: darken the cloud under the streaks and bump alpha so the
        // rain shows even over already-opaque overcast.
        col    = mix(col, rainShade, streak * 0.70);
        alpha  = clamp(alpha + streak * 0.30, 0.0, 0.98);
    }

    gl_FragColor = vec4(col, alpha);
}`;

// ═══════════════════════════════════════════════════════════════════════════════
//  ATMOSPHERE RIM SHADERS  (shared, used by earth.html + space-weather-globe)
// ═══════════════════════════════════════════════════════════════════════════════

export const ATM_VERT = /* glsl */`
varying vec3 vWorldNormal;
varying vec3 vViewDir;
void main() {
    vWorldNormal = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
    vec3 wp  = (modelMatrix * vec4(position, 1.0)).xyz;
    vViewDir = normalize(cameraPosition - wp);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

export const ATM_FRAG = /* glsl */`
precision highp float;
uniform vec3 u_sun_dir;
varying vec3 vWorldNormal;
varying vec3 vViewDir;

// Simplified atmospheric scattering — physically-motivated approximation
// without precomputed LUTs, so the cost stays at one fragment pass.
//
//   Rayleigh  — strong forward + back scatter, blue-weighted by λ⁻⁴.
//   Mie       — forward-biased via Henyey–Greenstein, provides the warm
//               tint around the sun and the orange/pink terminator band.
//   Altitude  — approximated by the view angle through the shell, so the
//               rim brightens naturally toward the limb.
//
// This replaces the flat rim-glow with a sky that reads blue on the day
// limb, navy on the night side, pink/orange at the terminator, and gets
// that sun-facing flare you see from orbit when the Sun is near the edge.

// Rayleigh phase: 3/(16π) · (1 + cos²θ)
float rayleighPhase(float cosT) {
    return 0.75 * (1.0 + cosT * cosT);
}

// Mie phase (Henyey–Greenstein), forward-scattering asymmetry g
float miePhase(float cosT, float g) {
    float g2 = g * g;
    return (1.0 - g2) / pow(max(1e-4, 1.0 + g2 - 2.0 * g * cosT), 1.5) * 0.375;
}

void main() {
    vec3  N = normalize(vWorldNormal);
    vec3  V = normalize(vViewDir);
    vec3  L = normalize(u_sun_dir);

    // Geometry
    float VdotN = dot(V, N);
    float NdotL = dot(N, L);
    float VdotL = dot(V, L);

    // Atmosphere is visible at the rim (grazing view) and fades as the
    // surface turns face-on. rim² gives a soft limb gradient.
    float rim = pow(1.0 - abs(VdotN), 2.2);

    // Day / night blending — scattering only happens where the atmosphere
    // is actually illuminated. Terminator is the smooth band in between.
    float dayMix     = smoothstep(-0.10, 0.30, NdotL);
    float termBand   = smoothstep(-0.25, 0.00, NdotL)
                     * (1.0 - smoothstep(0.10, 0.30, NdotL));  // peak at terminator

    // Wavelength-dependent Rayleigh scatter coefficients, based on the
    // standard 680 / 550 / 440 nm approximation.
    vec3 betaR = vec3(5.8e-3, 13.5e-3, 33.1e-3) * 20.0;
    vec3 betaM = vec3(21.0e-3)                  * 1.0;

    // Phase contributions
    float pR = rayleighPhase(VdotL);
    float pM = miePhase(VdotL, 0.76);

    // Rayleigh colour — dominant blue on the day limb, turns violet near
    // the terminator as the longer path scatters out the red first.
    vec3 rayleigh = betaR * pR * dayMix;

    // Mie — adds the warm halo around the sun when it's on-screen, plus
    // the orange terminator band you see from orbit.
    vec3 mieSun    = betaM * pM * dayMix;
    vec3 mieTermCol = vec3(1.00, 0.52, 0.26);
    vec3 mieTerm    = mieTermCol * termBand * 0.22;

    // Night side: very faint navy glow so the sphere's rim isn't black.
    vec3 nightGlow  = vec3(0.015, 0.022, 0.050) * (1.0 - dayMix);

    vec3 col = rayleigh + mieSun + mieTerm + nightGlow;

    // Scale by rim so the atmosphere is concentrated near the limb, not
    // spread across the face of the sphere. Alpha mirrors the colour so
    // additive-blend compositing reads cleanly over the surface shader.
    float alpha = rim * (0.60 + 0.40 * dayMix) + termBand * 0.18;
    alpha = clamp(alpha, 0.0, 1.0);

    gl_FragColor = vec4(col * rim * 1.6, alpha);
}`;

// ═══════════════════════════════════════════════════════════════════════════════
//  AURORA OVAL SHADER
//
//  Renders an undulating band at the equatorward auroral oval boundary
//  (north + south hemispheres) whose colour, width, and brightness scale
//  with the live Kp index. Designed to sit on its own thin shell just
//  inside the cloud mesh; nightside-only, discards the dayside so it
//  never obscures weather cards / city lights on the lit hemisphere.
//
//  Boundary formula matches js/user-location.js auroraVisibility():
//      equatorward boundary (deg) = max(55, 72 - Kp * 17/9)
//  so if a user sees "Needs Kp ≥ 6" in their saved-location card, the
//  oval on the globe will touch their city when Kp crosses 6.
//
//  Animation:
//    - sin ripple in longitude + value-noise jitter for organic edges
//    - pulse in intensity with time and Kp
//    - colour ramps green → cyan → magenta across Kp 2 → 5 → 9
// ═══════════════════════════════════════════════════════════════════════════════

export const AURORA_VERT = /* glsl */`
varying vec2 vUv;
varying vec3 vWorldNormal;
void main() {
    vUv          = uv;
    vWorldNormal = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
    gl_Position  = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

export const AURORA_FRAG = /* glsl */`
precision highp float;
uniform float u_kp;
uniform float u_time;
uniform vec3  u_sun_dir;
uniform float u_enabled;
uniform float u_bz_south;      // 0..1 normalised southward IMF Bz (1 = very -Bz)
uniform float u_aurora_power;  // 0..1 hemispheric auroral power proxy
varying vec2 vUv;
varying vec3 vWorldNormal;

float hash21(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
    vec2 i = floor(p); vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

void main() {
    if (u_enabled < 0.5 || u_kp < 1.5) discard;

    float latDeg = (vUv.y - 0.5) * 180.0;
    float absLat = abs(latDeg);
    float lonDeg = (vUv.x - 0.5) * 360.0;

    // Effective storm strength — Kp plus a Bz-south kicker so a fresh
    // southward turning shoves the oval equatorward immediately, without
    // having to wait for the Kp index to catch up.
    float bz      = clamp(u_bz_south, 0.0, 1.0);
    float kpEff   = u_kp + bz * 1.8;

    // Equatorward boundary (deg). Matches js/user-location.js#auroraVisibility
    // with a -Bz shift added so reconnection-driven expansion shows visibly.
    float boundary = max(52.0, 72.0 - kpEff * (17.0 / 9.0));

    // Undulation. Two travelling sine waves + value-noise jitter so the oval
    // wobbles like a real curtain. Ripple amplitude scales with Bz: quiet
    // northward IMF holds the oval steady, strong southward IMF makes it
    // churn visibly.
    float turbulence = 0.6 + bz * 2.0;
    float ripple = sin(lonDeg * 0.105 + u_time * 0.35) * 0.85 * turbulence
                 + sin(lonDeg * 0.047 - u_time * 0.22) * 1.1  * turbulence
                 + (vnoise(vec2(lonDeg * 0.028 + u_time * 0.06, 0.0)) - 0.5) * 2.4 * turbulence;
    float dynBoundary = boundary + ripple;

    // Band width grows with Kp + Bz. Bz south widens the oval so substorms
    // look like explosively brightening curtains, not a thin ribbon.
    float widthEq  = 3.0 + kpEff * 0.55;
    float widthPol = 6.0 + kpEff * 1.10 + bz * 2.5;

    float offset = absLat - dynBoundary;
    float eq = smoothstep(-widthEq, 0.0, offset);
    float po = 1.0 - smoothstep(0.0, widthPol, offset);
    float band = eq * po;

    // Radial "rays" — thin vertical-ish streaks within the band that flicker
    // on/off at active periods. Longitudinally high-frequency stripes shift
    // with time so the curtain reads as turbulent plasma motion, not a solid
    // neon band. Rays are gated on Bz + Kp; quiet periods see smooth bands,
    // active periods see visible structure.
    float rayFreq  = 90.0;
    float rayShift = u_time * (0.6 + bz * 1.2);
    float raySeed  = lonDeg * rayFreq / 360.0 + rayShift;
    float rayA     = fract(raySeed);
    float rayMask  = smoothstep(0.35, 0.50, rayA) * (1.0 - smoothstep(0.55, 0.70, rayA));
    // Per-column flicker — each ray has an independent on/off cycle so the
    // curtain shimmers instead of scrolling uniformly.
    float rayFlick = step(0.45, hash21(vec2(floor(raySeed), floor(u_time * 1.3))));
    float rayContribution = rayMask * rayFlick * smoothstep(0.1, 0.6, bz + u_aurora_power * 0.5);
    float rayGlow = 1.0 + 0.9 * rayContribution;

    // Temporal pulse — scales with Kp AND Bz so a Bz-south event visibly
    // quickens the heartbeat.
    float pulseHz = 0.85 + bz * 1.4;
    float pulse   = 0.70 + 0.30 * sin(u_time * pulseHz + absLat * 0.18);
    pulse *= 0.85 + 0.25 * smoothstep(3.0, 7.0, kpEff);

    // Substorm kicker — occasional brief bright surges when Bz is very south,
    // emulating the expansion phase of a magnetospheric substorm.
    float subStrength = max(0.0, bz - 0.55);  // only fires on strong -Bz
    float subPulse    = pow(0.5 + 0.5 * sin(u_time * 0.25), 32.0);  // sharp peak
    float substorm    = subStrength * subPulse * 1.6;

    // Mask out the dayside.
    vec3  N      = normalize(vWorldNormal);
    float NdotL  = dot(N, u_sun_dir);
    float nightM = 1.0 - smoothstep(-0.18, 0.22, NdotL);

    // Colour ramp: green → cyan → magenta as effective Kp rises.
    float kpNorm = clamp((kpEff - 2.0) / 7.0, 0.0, 1.0);
    vec3 cLow  = vec3(0.15, 0.95, 0.40);
    vec3 cMid  = vec3(0.35, 0.85, 1.00);
    vec3 cHigh = vec3(1.00, 0.30, 0.90);
    vec3 col   = kpNorm < 0.5
        ? mix(cLow, cMid, kpNorm / 0.5)
        : mix(cMid, cHigh, (kpNorm - 0.5) / 0.5);

    // Hot tips at the equatorward edge when rays are firing — reddish pink
    // tint that you only see in real photos at substorm peak.
    col = mix(col, vec3(1.0, 0.55, 0.75), rayContribution * 0.4);

    // Hemispheric-power brightening: proxy for live PED output.
    float powerBoost = 1.0 + u_aurora_power * 1.0;

    // Fade in over Kp_eff 1.5 → 3.
    float kpGate = smoothstep(1.5, 3.0, kpEff);

    float intensity = band * pulse * nightM * kpGate * rayGlow * powerBoost + substorm * band * nightM;
    float curtain   = 0.55 + 0.45 * eq;

    gl_FragColor = vec4(col * intensity * curtain * 1.8, clamp(intensity * 0.85, 0.0, 1.0));
}`;

// ═══════════════════════════════════════════════════════════════════════════════
//  UNIFORM FACTORIES
// ═══════════════════════════════════════════════════════════════════════════════

/** Default Earth surface uniforms.  All toggles default to conservative values. */
export function createEarthUniforms(sunDir = new THREE.Vector3(1, 0, 0)) {
    const blackFallback = _blackTex();
    return {
        u_day:          { value: blackFallback },
        u_night:        { value: blackFallback },
        u_specular:     { value: blackFallback },
        u_topology:     { value: _blackTex() },   // flat until texture loads
        u_bump_strength:{ value: 0.85 },           // 0 disables bump, 1 is strong
        u_weather:      { value: _blackTex() },
        u_sun_dir:      { value: sunDir.clone() },
        u_time:         { value: 0 },
        u_kp:           { value: 0 },
        u_xray:         { value: 0 },
        u_city_lights:  { value: 1 },
        u_aurora_on:    { value: 1 },
        u_weather_on:   { value: 0 },
        u_aurora_power: { value: 0 },
        u_bz_south:     { value: 0 },
        u_dst_norm:     { value: 0 },
    };
}

/** Default aurora oval uniforms. */
export function createAuroraUniforms(sunDir = new THREE.Vector3(1, 0, 0)) {
    return {
        u_kp:           { value: 0 },
        u_time:         { value: 0 },
        u_sun_dir:      { value: sunDir.clone() },
        u_enabled:      { value: 1 },
        // Southward IMF Bz, normalised to [0, 1] (1 = very southward Bz).
        // Drives ripple turbulence, brightness, and equatorward boundary shift.
        u_bz_south:     { value: 0 },
        // Hemispheric auroral power proxy [0, 1]. Scales overall brightness
        // so real substorm surges show up as a globe-visible beat.
        u_aurora_power: { value: 0 },
    };
}

/** Default cloud layer uniforms. */
export function createCloudUniforms(sunDir = new THREE.Vector3(1, 0, 0)) {
    return {
        u_clouds:        { value: _proceduralCloudNoise() },
        u_weather:       { value: _blackTex() },
        u_cloud_layers:  { value: _blackTex() },  // real cloud fraction + precip
        u_satellite:     { value: _grayTex()  },  // GOES/MODIS satellite imagery
        u_sun_dir:       { value: sunDir.clone() },
        u_time:          { value: 0 },
        u_weather_on:    { value: 0 },
        u_satellite_on:  { value: 0 },            // off until satellite texture arrives
        u_storms:        { value: Array.from({ length: 8 }, () => new THREE.Vector4(0, 0, 0, 1)) },
        u_storm_count:   { value: 0 },
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  TEXTURE LOADER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Load all four Earth textures from the version-pinned CDN.
 * Sets them on earthUniforms + cloudUniforms with RepeatWrapping applied.
 * Resolves when all four have either loaded or failed (safe fallback used on error).
 *
 * @param {object} earthU - uniforms object from createEarthUniforms()
 * @param {object} cloudU - uniforms object from createCloudUniforms() (unused, kept for API compat)
 * @returns {Promise<void>}
 */
export function loadEarthTextures(earthU, cloudU = null) {
    const loader = new THREE.TextureLoader();

    const loadTex = (url, onLoad, fallbackFn) => new Promise(resolve => {
        loader.load(url,
            tex => {
                tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
                onLoad(tex);
                resolve();
            },
            undefined,
            () => {
                console.warn(`[EarthSkin] texture load failed: ${url}`);
                onLoad(fallbackFn());
                resolve();
            }
        );
    });

    const promises = [
        loadTex(EARTH_TEXTURES.day, tex => {
            tex.colorSpace = THREE.SRGBColorSpace;
            earthU.u_day.value = tex;
        }, _blackTex),

        loadTex(EARTH_TEXTURES.night, tex => {
            tex.colorSpace = THREE.SRGBColorSpace;
            earthU.u_night.value = tex;
        }, _blackTex),

        loadTex(EARTH_TEXTURES.ocean, tex => {
            earthU.u_specular.value = tex;
        }, _blackTex),

        // Grayscale topology map — drives the bump / shading pass in the
        // surface fragment shader. If the CDN fetch fails the fallback
        // black texture leaves the surface flat, matching the old look.
        loadTex(EARTH_TEXTURES.topology, tex => {
            earthU.u_topology.value = tex;
        }, _blackTex),
    ];

    // Cloud noise texture is now procedurally generated at init time
    // (no CDN dependency).  Skip loading the old clouds.png.

    return Promise.all(promises);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  EARTHSKIN  — convenience class: creates the full Earth surface + cloud stack
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Creates and manages a textured Earth sphere + optional cloud shell.
 *
 * @example
 * const skin = new EarthSkin(scene, sunDir, { segments: 64, clouds: true, aurora: true });
 * skin.loadTextures().then(() => console.log('ready'));
 *
 * // In animation loop:
 * skin.update(elapsedSeconds);
 *
 * // From swpc-update event:
 * skin.setSpaceWeather({ kp: 5, bzSouth: 0.3, auroraOn: true });
 *
 * // From storm-update event:
 * skin.setStorms([ { lat, lon, intensity, hemisphere } ]);
 *
 * // From weather-update event (earth.html only):
 * skin.earthU.u_weather.value = dataTexture;
 * skin.cloudU.u_weather.value = dataTexture;
 * skin.earthU.u_weather_on.value = 1;
 * skin.cloudU.u_weather_on.value = 1;
 */
export class EarthSkin {
    /**
     * @param {THREE.Scene|THREE.Object3D}  parent   — scene or group to add meshes to
     * @param {THREE.Vector3}               sunDir   — initial sun direction (world space)
     * @param {object}                      opts
     * @param {number}  [opts.radius=1.0]            — Earth sphere radius
     * @param {number}  [opts.segments=64]           — sphere tessellation
     * @param {boolean} [opts.clouds=true]           — include cloud shell
     * @param {boolean} [opts.atmosphere=true]       — include atmosphere rim
     * @param {boolean} [opts.aurora=true]           — aurora uniforms active
     */
    constructor(parent, sunDir = new THREE.Vector3(1, 0, 0), {
        radius     = 1.0,
        segments   = 64,
        clouds     = true,
        atmosphere = true,
    } = {}) {
        this._parent = parent;

        // Earth surface
        this.earthU = createEarthUniforms(sunDir);
        const earthMat = new THREE.ShaderMaterial({
            vertexShader: EARTH_VERT, fragmentShader: EARTH_FRAG,
            uniforms: this.earthU,
        });
        this.earthMesh = new THREE.Mesh(
            new THREE.SphereGeometry(radius, segments, segments),
            earthMat
        );
        parent.add(this.earthMesh);

        // Cloud shell (1.009 R⊕ above surface)
        this.cloudU   = null;
        this.cloudMesh = null;
        if (clouds) {
            this.cloudU = createCloudUniforms(sunDir);
            // Share weather texture between earth and cloud shaders
            this.cloudU.u_weather = this.earthU.u_weather;
            const cloudMat = new THREE.ShaderMaterial({
                vertexShader: CLOUD_VERT, fragmentShader: CLOUD_FRAG,
                uniforms: this.cloudU, transparent: true, depthWrite: false,
            });
            this.cloudMesh = new THREE.Mesh(
                new THREE.SphereGeometry(radius * 1.009, Math.round(segments * 0.75), Math.round(segments * 0.75)),
                cloudMat
            );
            this.cloudMesh.renderOrder = 3;  // after atmosphere glow (1)
            parent.add(this.cloudMesh);
        }

        // Atmosphere rim glow
        if (atmosphere) {
            const atmU = { u_sun_dir: this.earthU.u_sun_dir };
            const atmMat = new THREE.ShaderMaterial({
                vertexShader: ATM_VERT, fragmentShader: ATM_FRAG,
                uniforms: atmU, transparent: true, depthWrite: false,
                side: THREE.BackSide, blending: THREE.AdditiveBlending,
            });
            this._atmMesh = new THREE.Mesh(
                new THREE.SphereGeometry(radius * 1.026, Math.round(segments * 0.5), Math.round(segments * 0.5)),
                atmMat
            );
            this._atmMesh.renderOrder = 1;   // atmosphere glow renders first
            parent.add(this._atmMesh);
        }
    }

    /** Load textures from CDN. Returns Promise<void>. */
    loadTextures() {
        return loadEarthTextures(this.earthU, this.cloudU);
    }

    /** Call every frame with elapsed time in seconds. */
    update(t) {
        this.earthU.u_time.value = t;
        if (this.cloudU) this.cloudU.u_time.value = t;
    }

    /** Update sun direction (call when Earth or camera rotates). */
    setSunDir(vec3) {
        this.earthU.u_sun_dir.value.copy(vec3);
        if (this.cloudU) this.cloudU.u_sun_dir.value.copy(vec3);
    }

    /**
     * Push live NOAA space-weather data into uniforms.
     * @param {{ kp, bzSouth, xray, auroraOn, auroraAW, dstNorm }} sw
     */
    setSpaceWeather({ kp = 0, bzSouth = 0, xray = 0, auroraOn = true,
                      auroraAW = 0, dstNorm = 0 } = {}) {
        const u = this.earthU;
        u.u_kp.value           = kp;
        u.u_bz_south.value     = bzSouth;
        u.u_xray.value         = xray;
        u.u_aurora_on.value    = auroraOn ? 1 : 0;
        u.u_aurora_power.value = auroraAW;
        u.u_dst_norm.value     = dstNorm;
    }

    /**
     * Push active storm systems into cloud uniforms.
     * @param {Array<{ lat, lon, intensityKt, hemisphere }>} storms
     *   intensityKt — sustained wind speed in knots (35kt = TS, 64kt = Cat1 hurricane)
     */
    setStorms(storms = []) {
        if (!this.cloudU) return;
        const arr = this.cloudU.u_storms.value;
        const n   = Math.min(storms.length, 8);

        for (let i = 0; i < n; i++) {
            const s = storms[i];
            // UV coordinate from lat/lon via the unified coordinate module.
            // geo.deg.latLonToUV applies the canonical convention:
            //   u = (lon + 180) / 360,  v = (90 - lat) / 180
            // — byte-for-byte the same as the old inline formula, but sourced
            // from the same primitive the GLSL side uses after 3b.
            const uv = geo.deg.latLonToUV(s.lat, s.lon);
            const u = uv.x, v = uv.y;
            // Intensity: 0 at 35kt (tropical storm threshold), 1.0 at 157kt (Cat 5)
            const inten = Math.min(Math.max((s.intensityKt - 35) / 122, 0), 1);
            // Cyclone spin: CCW in NH (+1), CW in SH (-1)
            const spin  = (s.lat >= 0) ? 1.0 : -1.0;
            arr[i].set(u, v, inten, spin);
        }
        // Zero out unused slots
        for (let i = n; i < 8; i++) arr[i].set(0, 0, 0, 1);
        this.cloudU.u_storm_count.value = n;
    }
}
