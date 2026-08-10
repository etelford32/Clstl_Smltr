/**
 * earth-skin.js — Shared Earth surface + cloud renderer for Celestial Simulator
 * ═══════════════════════════════════════════════════════════════════════════════
 * Used by earth.html (full Earth sim), space-weather-globe.js (magnetosphere
 * context), and heliosphere3d.js (solar system sim).
 *
 * Exports:
 *   EARTH_TEXTURES        — { day, night, ocean, clouds } CDN URLs (version-pinned)
 *   EARTH_VERT / EARTH_FRAG — Earth surface GLSL shaders
 *   CLOUD_VERT / CLOUD_FRAG — Cloud layer GLSL shaders (cyclonic storm swirl +
 *                             per-deck layered compositing, see shadeDeck)
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
import { GEO_GLSL } from './geo/coords.glsl.js';
import { INSET_GLSL_HELPERS } from './geo/inset.glsl.js';
import { buildTempLUTPixels, TEMP_RAMP_STOPS, TEMP_LUT_SIZE } from './temp-ramp.js';

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

// ═══════════════════════════════════════════════════════════════════════════════
//  TEMPERATURE COLOUR LUT
// ═══════════════════════════════════════════════════════════════════════════════
// Ramp stops, rationale, and the pixel builder live in js/temp-ramp.js (a
// THREE-free module, so the wx-panel legend and node tests share the exact
// bytes the shaders sample). Sampled in-shader via a 256×1 LUT texture — one
// texture2D tap replaces the legacy 4-stop per-fragment branch chain, and
// keeps the surface tint, the 3-D volume, and the °C legend pixel-identical
// to one another.

/**
 * Build the 256×1 RGBA LUT texture for the temperature ramp. Each consumer
 * gets its own texture object (Three.js textures can't be shared across
 * renderers), but the pixels are deterministic from TEMP_RAMP_STOPS.
 */
export function createTempLUTTexture() {
    const t = new THREE.DataTexture(buildTempLUTPixels(), TEMP_LUT_SIZE, 1, THREE.RGBAFormat);
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearFilter;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.needsUpdate = true;
    return t;
}
export { TEMP_RAMP_STOPS };


// ═══════════════════════════════════════════════════════════════════════════════
//  FOCUS INSETS  (shared GLSL, injected into surface + cloud frags)
// ═══════════════════════════════════════════════════════════════════════════════
// Two nested focus windows ride the camera's ground footprint
// (js/focus-footprint.js): the high-res weather patch (js/weather-patch.js)
// and the GIBS imagery detail inset (js/earth-detail-inset.js). Both share
// the same primitive: a texture whose lat/lon bounds are passed as a vec4
// (lonMin, latMin, lonSpan, latSpan in degrees) and blended over the global
// field with a soft edge. lonMin may sit anywhere in [-180,180) and the
// mod() in insetUV keeps a window straddling the antimeridian continuous.
// Inset rows are stored south-first relative to the computed UV (v=0 ⇔
// latMin) — do NOT "fix" this to match the global textures' row
// conventions; insets are sampled with an explicitly computed UV, not vUv.

// INSET_GLSL_HELPERS (insetUV / insetWeight) now lives in ./geo/inset.glsl.js so
// the terrain-patch vertex shader can share the exact source without pulling
// THREE into node tests. Imported above; still concatenated into EARTH_FRAG /
// CLOUD_FRAG below exactly as before.

const PATCH_GLSL_CORE = /* glsl */`
uniform sampler2D u_patch_weather;  // same packing as u_weather
uniform highp vec4  u_patch_bounds; // lonMin, latMin, lonSpan, latSpan (degrees)
uniform float u_patch_on;

// Drop-in replacement for texture2D(u_weather, uv).
vec4 sampleWeatherField(vec2 uv) {
    vec4 wx = texture2D(u_weather, uv);
    if (u_patch_on > 0.5) {
        vec2 uvP = insetUV(uv, u_patch_bounds);
        float wgt = insetWeight(uvP);
        if (wgt > 0.001) wx = mix(wx, texture2D(u_patch_weather, uvP), wgt);
    }
    return wx;
}
`;

const PATCH_GLSL_CLOUDS = /* glsl */`
uniform sampler2D u_patch_clouds;   // same packing as u_cloud_layers

// Drop-in replacement for texture2D(u_cloud_layers, uv).
vec4 sampleCloudLayers(vec2 uv) {
    vec4 cl = texture2D(u_cloud_layers, uv);
    if (u_patch_on > 0.5) {
        vec2 uvP = insetUV(uv, u_patch_bounds);
        float wgt = insetWeight(uvP);
        if (wgt > 0.001) cl = mix(cl, texture2D(u_patch_clouds, uvP), wgt);
    }
    return cl;
}
`;

// GIBS imagery detail inset (surface shader only). u_detail carries a
// stitched VIIRS/MODIS corrected-reflectance window at up to ~150 m/px,
// blended over the Blue Marble base inside its footprint. sRGB texture —
// three.js handles decode via colorSpace, the shader just mixes.
const DETAIL_GLSL = /* glsl */`
uniform sampler2D u_detail;         // stitched GIBS imagery window
uniform highp vec4  u_detail_bounds; // lonMin, latMin, lonSpan, latSpan (degrees)
uniform float u_detail_on;

// Blend the imagery inset over the global day-texture colour.
vec3 detailBlendDay(vec3 dayCol, vec2 uv) {
    if (u_detail_on < 0.5) return dayCol;
    vec2 uvD = insetUV(uv, u_detail_bounds);
    float wgt = insetWeight(uvD);
    if (wgt < 0.001) return dayCol;
    return mix(dayCol, texture2D(u_detail, uvD).rgb, wgt);
}
`;

// Topology detail inset (surface shader only): a high-res GIBS shaded-relief
// window drives the existing bump pass harder at close range, where the
// 0.176°/texel global height map has no sub-synoptic relief left to give.
const TOPO_GLSL = /* glsl */`
uniform sampler2D u_topo_detail;          // stitched GIBS shaded-relief window
uniform highp vec4  u_topo_detail_bounds; // lonMin, latMin, lonSpan, latSpan (degrees)
uniform float u_topo_detail_on;
uniform vec2  u_topo_detail_texel;        // (1/canvasW, 1/canvasH)

// Height-field gradient at uv, in the units the 85.0 bump gain downstream
// was tuned for: change per GLOBAL texel step (0.176° on both axes),
// x along +u (eastward), y along +v (southward).
vec2 topoGradient(vec2 uv) {
    float hC  = texture2D(u_topology, uv).r;
    float hDx = texture2D(u_topology, uv + vec2(1.0 / 2048.0, 0.0)).r - hC;
    float hDy = texture2D(u_topology, uv + vec2(0.0, 1.0 / 1024.0)).r - hC;
    if (u_topo_detail_on > 0.5) {
        vec2 uvT = insetUV(uv, u_topo_detail_bounds);
        float wgt = insetWeight(uvT);
        if (wgt > 0.001) {
            float tC  = texture2D(u_topo_detail, uvT).r;
            float tDx = texture2D(u_topo_detail, uvT + vec2(u_topo_detail_texel.x, 0.0)).r - tC;
            // +uvT.y is NORTHWARD (inset v=0 ⇔ latMin) while +uv.y is
            // southward — negate so the two gradients agree.
            float tDy = -(texture2D(u_topo_detail, uvT + vec2(0.0, u_topo_detail_texel.y)).r - tC);
            // Rescale the inset's fine-step deltas to the global 0.176° step.
            // The amplification is capped at 32× — real terrain has more
            // slope at finer scales (that's the point), but past the cap the
            // dominant signal is jpeg noise, which uncapped k turns into
            // surface shimmer at deep zooms.
            highp float stepLonDeg = u_topo_detail_bounds.z * u_topo_detail_texel.x;
            highp float stepLatDeg = u_topo_detail_bounds.w * u_topo_detail_texel.y;
            float kx = min(32.0, 0.17578125 / max(1e-5, stepLonDeg));
            float ky = min(32.0, 0.17578125 / max(1e-5, stepLatDeg));
            // "Drive the bump pass harder": modest boost over a strict unit
            // match, so close-range relief visibly pops. Deltas are clamped to
            // roughly the magnitude range the global map produces (±0.06, not
            // the old ±0.25 — that was ~25× the real global delta and, once
            // multiplied by the 85.0 bump gain in main(), flipped the normal
            // and blacked out the terrain). The downstream SLOPE_MAX cap is the
            // hard guarantee; this clamp keeps the pre-cap gradient clean so
            // fewer pixels saturate and JPEG noise doesn't shimmer.
            const float TOPO_DETAIL_BOOST = 1.35;
            hDx = mix(hDx, clamp(tDx * kx * TOPO_DETAIL_BOOST, -0.06, 0.06), wgt);
            hDy = mix(hDy, clamp(tDy * ky * TOPO_DETAIL_BOOST, -0.06, 0.06), wgt);
        }
    }
    return vec2(hDx, hDy);
}
`;

// ═══════════════════════════════════════════════════════════════════════════════
//  EARTH SURFACE SHADERS
// ═══════════════════════════════════════════════════════════════════════════════

export const EARTH_VERT = /* glsl */`
varying vec3 vNormalLocal;     // object-space unit direction (sphere normal)
varying vec3 vWorldNormal;
varying vec3 vWorldPos;
void main() {
    // The object-space direction of this vertex IS its UV address on an
    // equirectangular sphere. The fragment shader reconstructs UV from the
    // interpolated value via normalToUV(), which bypasses the stock sphere
    // mesh's antimeridian seam and pole-fan wedge artifacts entirely.
    vNormalLocal = normalize(position);
    vWorldNormal = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
    vWorldPos    = (modelMatrix * vec4(position, 1.0)).xyz;
    gl_Position  = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

export const EARTH_FRAG = /* glsl */`
precision highp float;

${GEO_GLSL}

uniform sampler2D u_day;
uniform sampler2D u_night;
uniform sampler2D u_specular;   // ocean mask (r = ocean)
uniform sampler2D u_topology;   // grayscale height / elevation (r = normalised height)
uniform sampler2D u_weather;    // R=temp, G=pressure [0=low,1=high], B=humidity, A=wind
uniform sampler2D u_temp_lut;   // 256×1 temperature ramp (createTempLUTTexture)
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
uniform vec3  u_mag_pole;       // geomagnetic dipole pole (unit normal)

// ── Cloud-shadow inputs (Phase 2.4 of the wind+cloud depth plan) ─────────
// The same cloud DataTexture the cloud shells sample, plus the satellite
// mosaic for its confidence channel. u_cloud_shadow is flipped by the
// quality governor at the same tier that enables cloud relief/self-shadow
// (u_quality > 0.83) — consumers that never wire it (space-weather-globe,
// heliosphere3d) stay on the 0 default and skip the whole branch.
uniform sampler2D u_cloud_layers;  // R=cl_low, G=cl_mid, B=cl_high, A=precip
uniform sampler2D u_satellite;     // r = mosaic cloudiness, a = confidence
uniform float u_satellite_on;
uniform float u_cloud_shadow;
uniform vec3  u_sun_dir_obj;       // sun dir in the mesh's OBJECT space —
                                   // the shadow offset feeds normalToUV,
                                   // which lives in object space.

varying vec3 vNormalLocal;
varying vec3 vWorldNormal;
varying vec3 vWorldPos;

${INSET_GLSL_HELPERS}
${PATCH_GLSL_CORE}
${DETAIL_GLSL}
${TOPO_GLSL}

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
// One LUT tap replaces the legacy 4-stop branch chain (see TEMP_RAMP_STOPS in
// this file for the stop table + rationale). The extra smoothstep band paints
// a thin bright seam along the 0 °C isotherm — the freezing line is the
// operational boundary (precip phase, icing) and the diverging ramp pivots
// there, so the seam reads as a natural crest rather than a painted contour.
vec3 weatherOverlay(vec2 uv) {
    float temp = sampleWeatherField(uv).r;            // (T°C + 60) / 110
    vec3 c = texture2D(u_temp_lut, vec2(clamp(temp, 0.0, 1.0), 0.5)).rgb;
    float tC = temp * 110.0 - 60.0;
    float frz = 1.0 - smoothstep(0.35, 1.10, abs(tC));
    return c + vec3(0.22) * frz;
}

void main() {
    // Reconstruct equirectangular UV from the INTERPOLATED surface normal
    // instead of trusting the mesh uv attribute. On stock SphereGeometry
    // this eliminates the pole-fan wedge artifact (where the u coordinate
    // staircases across triangles sharing the pole point); on IcosahedronGeometry
    // it also eliminates the antimeridian seam that PolyhedronGeometry
    // auto-UVs produce. Either way: no more horizontal white stripes.
    vec3 N_sphere = normalize(vNormalLocal);
    vec2 vUv      = normalToUV(N_sphere);

    vec3 N_base = normalize(vWorldNormal);

    vec3 dayCol    = detailBlendDay(texture2D(u_day, vUv).rgb, vUv);
    vec3 nightCol  = texture2D(u_night,    vUv).rgb * 2.5;
    float oceanMsk = texture2D(u_specular, vUv).r;

    // ── Topographic normal perturbation ────────────────────────────────
    // Sample the height map at three offset UVs and build a tangent-space
    // gradient. Project that gradient into the surface tangent basis so
    // mountains cast the right shadow regardless of camera angle. Ocean
    // is kept flat — bump only affects land via (1 - oceanMsk).
    // topoGradient (TOPO_GLSL) reproduces the original three-tap global
    // gradient and, when the high-res topology inset is live, swaps in its
    // rescaled fine-step gradient inside the footprint.
    vec2  hGrad = topoGradient(vUv);
    float hDx   = hGrad.x;
    float hDy   = hGrad.y;
    // East / north tangents at the current surface point
    vec3  up      = vec3(0.0, 1.0, 0.0);
    vec3  tEast   = normalize(cross(up, N_base));
    vec3  tNorth  = normalize(cross(N_base, tEast));
    float landMsk = (1.0 - oceanMsk) * u_bump_strength;
    // Tangential displacement of the surface normal from the height gradient.
    // The 85.0 gain is tuned for the GLOBAL height map's tiny per-texel deltas.
    vec3  slope   = (tEast * hDx + tNorth * hDy) * 85.0 * landMsk;
    // Cap its length. Without this, the high-res topology inset's rescaled
    // gradient (up to ±0.06 after the clamp in topoGradient → ±5 after the
    // gain) rotates the normal clear into the tangent plane, flipping it away
    // from the sun so NdotL — and therefore dayMix and lit — collapse to
    // their dark floor: the "terrain goes black when you zoom in" bug. Bounding
    // the push to SLOPE_MAX keeps the tilt ≤ atan(1.5) ≈ 56° so normalize()
    // always lands on the sunlit side, which turns the runaway over-bump into
    // crisp, stable hillshade relief at close range. The global path never
    // reaches this cap, so the wide-view look is unchanged.
    const float SLOPE_MAX = 1.5;
    float slLen = length(slope);
    if (slLen > SLOPE_MAX) slope *= SLOPE_MAX / slLen;
    vec3  N = normalize(N_base - slope);

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

    // ── Cloud shadows on the ground (Phase 2.4) ──────────────────────────
    // Sample the cloud field OFFSET toward the sun along the local tangent
    // plane: where a deck hangs between this ground point and the sun, the
    // ground darkens. The offset scales with 1/sin(elevation), so decks
    // throw long shadows near the terminator and none at local noon. All
    // math in object space (u_sun_dir_obj) because the lookup feeds
    // normalToUV. Feathered by the mosaic's confidence channel so regions
    // only the procedural fill "covers" cast nothing hard; with no mosaic
    // at all, Open-Meteo decks cast at reduced strength (real data, just
    // coarser). Governor-gated — off below the relief/self-shadow tier.
    if (u_cloud_shadow > 0.5) {
        float sunElev = dot(N_sphere, u_sun_dir_obj);
        if (sunElev > 0.03) {
            const float H_SHADOW = 0.0012;        // ~7.5 km mean deck height, in globe radii
            vec3  LtS = u_sun_dir_obj - N_sphere * sunElev;
            vec3  NcS = normalize(N_sphere + LtS * (H_SHADOW / max(sunElev, 0.20)));
            vec2  uvS = normalToUV(NcS);
            vec4  clS  = texture2D(u_cloud_layers, uvS);
            vec4  satS = texture2D(u_satellite, uvS);
            // Low decks shade hardest; cirrus barely. The mosaic cloudiness
            // reinforces where it saw cloud the model grid missed.
            float cover = clamp(clS.r * 0.55 + clS.g * 0.35 + clS.b * 0.15, 0.0, 1.0);
            cover = max(cover, satS.r * 0.75);
            float conf  = (u_satellite_on > 0.5) ? satS.a : 0.65;
            float shade = cover * conf * smoothstep(0.03, 0.30, sunElev);
            base *= 1.0 - 0.34 * shade;
        }
    }

    // Weather temperature overlay
    if (u_weather_on > 0.5) {
        base = mix(base, weatherOverlay(vUv), 0.28);
    }

    // Aurora — driven by MAGNETIC latitude, not geographic. The dipole pole
    // is tilted ~11° from the spin axis (IGRF 2025 epoch), so the oval sits
    // over northern Canada / Siberia instead of ringing the geographic pole.
    if (u_aurora_on > 0.5 && u_kp > 1.5) {
        vec3  nGeo   = uvToNormal(vUv);
        float sinAbs = absSinMagLat(nGeo, u_mag_pole);   // |cos(magCoLat)|
        float lonRad = uvToLatLon(vUv).y;                // ripple phase stays geographic
        float nightM = 1.0 - smoothstep(-0.20, 0.30, NdotL);
        base += auroraColor(sinAbs, lonRad, u_kp) * nightM;
    }

    // X-ray ionospheric flash (dayside HF blackout)
    if (u_xray > 0.25 && dayMix > 0.4) {
        float flash = (u_xray - 0.25) / 0.75 * dayMix;
        base += vec3(0.3, 0.5, 1.0) * flash * 0.30;
    }

    // Ring current heating: equatorial nightside reddish glow
    if (u_dst_norm > 0.08) {
        float absLat = abs(uvToLatLon(vUv).x);
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
varying vec3 vNormalLocal;     // object-space unit direction (sphere normal)
varying vec3 vWorldNormal;
varying vec3 vWorldPos;        // world-space position — view dir for parallax/scatter
void main() {
    vNormalLocal = normalize(position);
    vWorldNormal = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
    vWorldPos    = (modelMatrix * vec4(position, 1.0)).xyz;
    gl_Position  = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

export const CLOUD_FRAG = /* glsl */`
precision mediump float;

${GEO_GLSL}

uniform sampler2D u_weather;       // R=temp, G=pressure, B=humidity, A=wind
uniform sampler2D u_cloud_layers;  // R=cl_low, G=cl_mid, B=cl_high, A=precip [0-1]
uniform sampler2D u_satellite;     // normalized cloud mosaic: r = cloud fraction
                                   // (LINEAR, cloud-imagery.js pre-decodes every
                                   // GIBS product), a = observation confidence
                                   // (feathered at disc edges — fractional values
                                   // are expected, not just 0/1)
uniform vec3  u_sun_dir;
uniform float u_time;
uniform float u_weather_on;
uniform float u_satellite_on;      // blend satellite into cloud appearance
uniform float u_cloud_data_strength; // Open-Meteo imprint intensity.
                                     //   0.0  = pure noise, no data modulation (debug)
                                     //   0.2  = ±10% soft modulation
                                     //   0.5  = ±25% (default, original behaviour)
                                     //   1.0  = ±50% (data-dominated)
uniform float u_research_mode;       // 0 = composite (procedural fill + data nudge);
                                     // 1 = research / measured-only:
                                     //     • disables BASE_LOW/MID/HIGH constants
                                     //       so coverage comes from data alone
                                     //     • renders satellite no-data regions
                                     //       as a faint hatch instead of plausible
                                     //       procedural cloud
                                     //     • renders alpha = data directly,
                                     //       bypassing u_cloud_data_strength so
                                     //       researchers see what the model says,
                                     //       not what the noise field invents
uniform float u_quality;             // adaptive ALU budget [0..1], default 1.
                                     // This scene is fragment-bound and the FBM
                                     // stack below is its hottest path; the
                                     // resolution governor steps this down once
                                     // pixelRatio hits its floor. Tiers:
                                     //   > 0.83  full octaves + relief + shadow
                                     //   > 0.45  one octave fewer per layer
                                     //   else    two fewer, 2-octave warp, and
                                     //           the relief/self-shadow taps off
                                     // Octave REDUCTION only — never re-gate
                                     // coverage zonally (that's the banding
                                     // regression this shader already fixed).
uniform float u_shell_lift;          // altitude terminator bias (Phase 2.2).
                                     // Added to NdotL so high cirrus stays
                                     // sunlit after the surface terminator
                                     // passes (alpenglow) and low decks darken
                                     // first. Per-shell uniform on the split
                                     // shells; 0 on the composite material,
                                     // where the layered aggregate applies
                                     // the same per-deck biases as constants
                                     // (see the lift block in main()).

// ── Split-shell compilation (Phase 2.1) + layered aggregate (Phase 2.4) ─────
// The same source compiles four ways. With no defines (the composite shell,
// ALSO the floor-quality tier and research mode) all three decks are computed
// in one pass, each lit with its own palette/terminator bias, and composited
// in altitude order — the "layered aggregate". With SHELL_SPLIT + SHELL_LAYER
// ∈ {0,1,2} the material renders exactly one deck: the other two layers'
// noise stacks compile out (so three split shells cost ≈ one composite shell
// in ALU) and their alphas are pinned to 0 after the data blends. Both paths
// share shadeDeck() and the same over-operator (the split meshes get it from
// GPU alpha blending), so a governor tier flip changes parallax fidelity,
// never a deck's character or the stack's total density.

// Storm systems: .xy = UV position, .z = intensity [0-1], .w = spin (+1 CCW/-1 CW)
uniform vec4 u_storms[8];
uniform int  u_storm_count;

varying vec3 vNormalLocal;
varying vec3 vWorldNormal;
varying vec3 vWorldPos;

${INSET_GLSL_HELPERS}
${PATCH_GLSL_CORE}
${PATCH_GLSL_CLOUDS}

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
// warpOctaves trades warp fidelity for ALU under the quality governor; the
// warp itself is never removed (a 2-octave warp still decorrelates the
// lattice — dropping it entirely brings the strips back).
float warpedFbm3(vec3 p, int octaves, int warpOctaves) {
    vec3 warp = vec3(
        fbm3(p * 0.8 + vec3(17.3, -3.1,  0.0), warpOctaves),
        fbm3(p * 0.8 + vec3(-9.6, 12.4,  0.0), warpOctaves),
        fbm3(p * 0.8 + vec3( 4.2,  7.8,  0.0), warpOctaves)
    ) - 0.5;
    return fbm3(p + warp * 1.15, octaves);
}

// ── Cheap cloud-form field for relief + self-shadow ───────────────────────────
// The visible cloud alpha is driven by the expensive warpedFbm3 calls in
// main(). Re-running those at the extra sample points a bump normal and a
// sun-march would need is too costly at 60 fps on a full icosphere. Instead
// this is a lightweight 3-octave field that tracks the *dominant* cumulus
// lumps closely enough that lighting their relief reads as real 3-D form.
// One scalar in, one scalar out, ≤3 vnoise3 taps — cheap enough to call ~5×
// per fragment (centre + 2 gradient offsets + 1 shadow step). Kept at 2
// octaves on purpose: relief only needs the dominant lump, and the headless
// CI smoke test enforces ≥25 fps under software GL, so the tap budget is
// tight — the fine detail is already supplied by the warpedFbm3 alpha field.
float cloudForm(vec3 p) {
    return fbm3(p * 13.0, 2);
}

// ── Rotations on the unit sphere ──────────────────────────────────────────────
// The cloud noise and storm swirl used to operate on equirectangular UV
// offsets, which produced stripes (UV-space stretch + hard-coded cirrus
// anisotropy). Now everything happens in 3-D on the sphere: drift = slow
// rotation about the spin axis, swirl = Rodrigues rotation around each
// storm's 3-D centre.

// Rodrigues rotation of p around unit vector axis by angle radians.
vec3 rotateAroundAxis(vec3 p, vec3 axis, float angle) {
    float c = cos(angle);
    float s = sin(angle);
    return p * c + cross(axis, p) * s + axis * dot(axis, p) * (1.0 - c);
}

// Rotation about the world Y axis (planet spin axis). Cheap specialisation
// of rotateAroundAxis for the "eastward drift" case. Positive angle rotates
// toward +east (prime meridian → lon +90°E).
vec3 rotateY(vec3 p, float angle) {
    float c = cos(angle), s = sin(angle);
    return vec3(p.x * c + p.z * s, p.y, -p.x * s + p.z * c);
}

// ── Cyclonic swirl on the 3-D normal ──────────────────────────────────────────
// For each active storm, rotate the sampling normal around the storm's
// 3-D centre by an angle that falls off with great-circle distance.
// NH (spin = +1): CCW viewed from outside the sphere.
// SH (spin = -1): CW  viewed from outside the sphere.
vec3 stormSwirl3D(vec3 N) {
    vec3 result = N;
    for (int i = 0; i < 8; i++) {
        if (i >= u_storm_count) break;
        vec3  centerN = uvToNormal(u_storms[i].xy);
        float inten   = u_storms[i].z;
        float spin    = u_storms[i].w;

        float ang       = acos(clamp(dot(result, centerN), -1.0, 1.0));
        float radiusAng = 0.12 + inten * 0.10;           // ≈7°–14° = ~800–1550 km

        if (ang < radiusAng * 2.2) {
            float falloff  = smoothstep(radiusAng * 2.2, 0.0, ang);
            float rotAngle = spin * inten * falloff * 2.2;   // peak ~126° at eye
            result = rotateAroundAxis(result, centerN, rotAngle);
        }
    }
    return result;
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

// ── Per-deck shading ─────────────────────────────────────────────────────────
// One deck's lit colour. Shared by the layered aggregate (all three decks in
// one pass) and the split shells (one deck each), so a governor tier flip
// never changes a deck's character. NdotL inputs arrive pre-lifted — the
// per-altitude terminator bias is the caller's job.
//   a        deck alpha (post data/satellite/storm blends)
//   NdotLd   flat-shell sun angle + deck lift       (day/night + terminator)
//   NdotLbD  relief-perturbed sun angle + deck lift (== NdotLd on flat decks)
//   selfShD  self-shadow term (form-owner deck only, else 0)
//   veilD    direct-sun transmission through decks stacked above [0..1]
//   fwd      shared forward-scatter phase pow(max(V·L,0), 6)
//   silverW  silver-lining weight  (cirrus > cumulus > altostratus)
//   termW    terminator warm-tint weight (alpenglow lingers on cirrus)
//   thinCol / coreCol / shadeCol   deck palette
//   dayMixD  OUT: this deck's day/night blend (the precip veil reuses low's)
vec3 shadeDeck(float a, float NdotLd, float NdotLbD, float selfShD, float veilD,
               float fwd, float silverW, float termW,
               vec3 thinCol, vec3 coreCol, vec3 shadeCol, out float dayMixD) {
    dayMixD    = smoothstep(-0.18, 0.20, NdotLd);
    float sunD = clamp(NdotLbD * 0.5 + 0.5, 0.0, 1.0);
    sunD       = sunD * sunD * veilD;
    float litD = mix(0.30, 1.0, sunD) * (1.0 - 0.60 * selfShD);

    // Forward (Mie) scatter — the "silver lining". Thin edges glow when the
    // view is roughly sun-aligned; the cue that most sells cloud volume.
    float thinD   = 1.0 - smoothstep(0.0, 0.55, a);
    float silverD = fwd * (0.30 + 0.70 * thinD) * dayMixD * silverW;

    // Density-driven colour: thick cores opaque and bright, thin wisps a
    // cooler translucent grey. The shadowed side fills with sky ambient
    // rather than going to black, which is what real cloud underbellies do.
    float thickD  = smoothstep(0.12, 0.78, clamp(a * 1.3, 0.0, 1.0));
    vec3  baseD   = mix(thinCol, coreCol, thickD);
    vec3  dayD    = mix(shadeCol, baseD, litD)
                  + vec3(1.00, 0.95, 0.82) * silverD * 0.55;   // golden rim
    vec3  nightD  = vec3(0.15, 0.18, 0.29) * (0.65 + 0.35 * (1.0 - selfShD));
    vec3  colD    = mix(nightD, dayD, dayMixD);

    // Warm golden tint at terminator (sunrise/sunset through the deck)
    float termD = smoothstep(-0.12, 0.0, NdotLd) * smoothstep(0.24, 0.06, NdotLd);
    return mix(colD, vec3(0.97, 0.66, 0.32), termD * termW);
}

void main() {
    // UV reconstructed from the interpolated surface normal — kills the
    // pole-fan wedge artifact that stock SphereGeometry produces and the
    // antimeridian seam that IcosahedronGeometry's auto-UVs would produce.
    vec3 N_sphere = normalize(vNormalLocal);
    vec2 vUv      = normalToUV(N_sphere);

    vec3  N     = normalize(vWorldNormal);
    // Flat-shell sun angle. Per-deck altitude lifts (u_shell_lift on the
    // split shells, matching constants in the layered aggregate) are applied
    // at the shading stage so each deck gets its own terminator response:
    // cirrus keeps catching sun the surface no longer sees; low decks fall
    // dark first.
    float NdotLf = dot(N, u_sun_dir);

    // View direction + the tangent-plane component of it. The tangential
    // part is what drives inter-layer PARALLAX: when you orbit toward the
    // limb, a layer that floats higher must slide further across the deck
    // below it. Giving low/mid/high distinct parallax shifts turns the flat
    // decal into a stack of sheets at real altitudes — the single biggest
    // "this looks 3-D now" cue, and it costs no extra noise taps because the
    // offset is folded into the sample normal *before* the FBM lookups.
    vec3 V    = normalize(cameraPosition - vWorldPos);
    vec3 Vt   = V - N_sphere * dot(V, N_sphere);   // 0 at sub-view point, max at limb

    // ── Sample-normal advection ──────────────────────────────────────────────
    // Apply cyclonic swirl + slow eastward drift directly to the 3-D sampling
    // normal. All noise below reads from the SPHERE, not from equirectangular
    // UV — this is what kills the cirrus stripes and the polar UV-stretch.
    vec3 N_swirled = (u_storm_count > 0) ? stormSwirl3D(N_sphere) : N_sphere;

    // Drift rates match the old UV speeds: original was U units per second,
    // so we multiply by 2π to convert to radians around the Y axis. Preserves
    // the pre-existing cloud-drift cadence.
    const float TAU     = 6.2831853;
    const float yawLow  = 0.0000330 * TAU;
    const float yawMid  = 0.0000480 * TAU;
    const float yawHigh = 0.0000720 * TAU;

    // Per-layer parallax: shift the sample point against the tangential view
    // by an amount proportional to that layer's altitude (low ≈ 2 km, mid ≈
    // 6 km, high ≈ 10 km → relative 0.018 / 0.045 / 0.075 of a globe radius,
    // exaggerated from physical scale so the depth separation is legible at
    // typical zoom). Re-normalised so it stays a unit sphere direction.
    vec3 N_low  = normalize(rotateY(N_swirled, u_time * yawLow)  - Vt * 0.018);
    vec3 N_mid  = normalize(rotateY(N_swirled, u_time * yawMid)  - Vt * 0.045);
    vec3 N_high = normalize(rotateY(N_swirled, u_time * yawHigh) - Vt * 0.075);

    float tLow  = u_time * 0.00060;
    float tMid  = u_time * 0.00085;
    float tHigh = u_time * 0.00120;

    // ── Multi-octave procedural noise per cloud layer ────────────────────────
    // warpedFbm3 samples 3-D noise directly on the sphere normal. Each layer's
    // frequency is isotropic (same scalar on x/y/z) — no more cirrus 22:8
    // east-west stretch. Time is carried as a z-plane offset so clouds morph
    // in place. Per-layer phase offsets (3.7, 7.3) decouple the layers so they
    // don't lock into identical shapes at the same frequency.

    // Quality-tiered octave budget — see the u_quality uniform comment.
    // At full quality these are byte-for-byte the original 5/4/5 + 3-warp.
    int octLow  = u_quality > 0.83 ? 5 : (u_quality > 0.45 ? 4 : 3);
    int octMid  = u_quality > 0.83 ? 4 : (u_quality > 0.45 ? 3 : 2);
    int octWarp = u_quality > 0.45 ? 3 : 2;

    // Split shells compile only their own layer's noise stack — the other
    // two collapse to constants (and their shapes to 0), so the per-shell
    // ALU is ≈ one-third of the composite pass.
    // Low cumulus: defined puffy cells
#if defined(SHELL_SPLIT) && SHELL_LAYER != 0
    float nLow  = 0.0;
#else
    float nLow  = warpedFbm3(N_low  * 14.0 + vec3(0.0, 0.0, tLow),  octLow, octWarp);
#endif
    // Mid altostratus: smoother, broader
#if defined(SHELL_SPLIT) && SHELL_LAYER != 1
    float nMid  = 0.0;
#else
    float nMid  = warpedFbm3(N_mid  *  9.5 + vec3(3.7, 0.0, tMid),  octMid, octWarp);
#endif
    // High cirrus: higher frequency for thinner strands. ISOTROPIC — the
    // wispy elongation will come back later from wind-driven flow advection
    // (step 6 in the plan), not from a hard-coded frequency ratio.
#if defined(SHELL_SPLIT) && SHELL_LAYER != 2
    float nHigh = 0.0;
#else
    float nHigh = warpedFbm3(N_high * 22.0 + vec3(7.3, 7.3, tHigh), octLow, octWarp);
#endif

    // Relief/self-shadow sample normal: each split shell lights its own
    // deck's form field; the composite keeps the classic low-deck relief.
#if defined(SHELL_SPLIT) && SHELL_LAYER == 1
    vec3 N_form = N_mid;
#elif defined(SHELL_SPLIT) && SHELL_LAYER == 2
    vec3 N_form = N_high;
#else
    vec3 N_form = N_low;
#endif

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

    // Global base cover — constant across latitudes so the composite shader
    // can never produce a completely clear band just because the weather grid
    // says so. Research mode zeros these out: coverage = data, full stop.
    const float BASE_LOW_DEFAULT  = 0.72;
    const float BASE_MID_DEFAULT  = 0.48;
    const float BASE_HIGH_DEFAULT = 0.32;
    float baseLow  = mix(BASE_LOW_DEFAULT,  0.0, u_research_mode);
    float baseMid  = mix(BASE_MID_DEFAULT,  0.0, u_research_mode);
    float baseHigh = mix(BASE_HIGH_DEFAULT, 0.0, u_research_mode);

    if (u_weather_on > 0.5) {
        vec4  cl      = sampleCloudLayers(vUv);
        float clLow   = cl.r;
        float clMid   = cl.g;
        float clHigh  = cl.b;
        precip        = cl.a;

        if (u_research_mode > 0.5) {
            // Research / measured-only: alpha = data, period. The texture has
            // already been bilinearly upsampled and box-blurred from the
            // coarse grid (see weather-feed.js _decodeCoarse), so
            // showing it raw is honest, not noisy. The procedural shape
            // factors (shapeLow / shapeMid / shapeHigh) act only as a fine-
            // scale dither at low amplitude so the eye can resolve the 5°
            // grid pitch — they never invent coverage where the data is 0.
            float ditherLow  = mix(0.85, 1.05, shapeLow);
            float ditherMid  = mix(0.90, 1.05, shapeMid);
            float ditherHigh = mix(0.92, 1.05, shapeHigh);
            alphaLow  = clLow  * ditherLow;
            alphaMid  = clMid  * ditherMid;
            alphaHigh = clHigh * ditherHigh;
        } else {
            // Composite mode (default visual). Parameterised data-imprint
            // strength: equivalent to the original ±25% formula when
            // u_cloud_data_strength == 0.5. At 0.0 the data is completely
            // ignored (pure noise-driven clouds) — useful for isolating
            // whether banding comes from the data texture or the shader's
            // own noise field. Precipitation channel is read regardless of
            // strength because it gates the streak overlay, which is
            // meaningful independent of the modulation weight.
            // Data-GATED coverage. The old formula was
            //   alpha = shape * base * (1 + (cl-0.5)*strength)
            // so a clear grid cell (cl=0) still rendered base*0.75 ≈ 0.54
            // cloud — the whole globe was permanently ~half overcast and
            // every sky looked like the same grey soup. Now the data drives a
            // coverage gate from a thin fair-weather floor up to full
            // overcast, so clear cells actually read as clear and storm decks
            // stand out as solid. strength still scales how literally the
            // data is obeyed (0 = procedural, 0.5 = default, 1 = data-locked).
            float g = clamp(u_cloud_data_strength * 2.0, 0.0, 1.0);
            float covLow  = mix(1.0, mix(0.28, 1.15, clLow),  g);
            float covMid  = mix(1.0, mix(0.20, 1.10, clMid),  g);
            float covHigh = mix(1.0, mix(0.16, 1.08, clHigh), g);

            // Precipitation → cloud coupling. Rain physically falls out of a
            // cloud deck, so wherever the precip channel is wet we anchor a
            // deck overhead. Two moves are needed because cloud alpha is
            // shape*base*cov: the coverage gate alone can't help if the
            // procedural SHAPE noise left a hole over the storm, so we also
            // lift the shape floor. Without this the noise field and the
            // precip field drift apart and storms paint rain over gaps in the
            // cloud — the "precip and cloud don't line up" artefact. precip is
            // the normalised channel (/10 mm/hr); 0.02..0.30 ≈ 0.2..3 mm/hr,
            // i.e. light-rain onset to fully-coupled overcast. Gated by g so a
            // pure-procedural debug view (strength 0) is unaffected.
            float wet = smoothstep(0.02, 0.30, precip) * g;
            covLow    = max(covLow, mix(covLow, 1.10, wet));
            covMid    = max(covMid, mix(covMid, 1.00, wet));
            float shapeLowW = max(shapeLow, wet);
            float shapeMidW = max(shapeMid, wet * 0.85);

            alphaLow  = shapeLowW * baseLow  * covLow;
            alphaMid  = shapeMidW * baseMid  * covMid;
            alphaHigh = shapeHigh  * baseHigh * covHigh;
        }
    } else {
        // No weather data: pure noise-driven clouds at the base density.
        // In research mode baseLow/Mid/High are all zero, so the globe
        // stays cloud-free until real data arrives — which is the honest
        // answer for a researcher when the data feed is down.
        alphaLow  = shapeLow  * baseLow;
        alphaMid  = shapeMid  * baseMid;
        alphaHigh = shapeHigh * baseHigh;
    }

    // Satellite observation: when a real cloud-imagery texture is supplied
    // (NASA GIBS mosaic), use its red channel — pre-normalized to linear
    // cloud fraction by cloud-imagery.js — as the dominant coverage signal
    // and fold the procedural noise in as fine-scale detail + motion.
    //
    // The texture's alpha channel is an observation-CONFIDENCE mask.
    // Regions no satellite saw arrive with alpha = 0 and route back to
    // procedural clouds; geostationary disc edges arrive FEATHERED
    // (alpha easing 1 → 0 across ~16° of view angle), so the
    // measured→procedural handoff below is a gradient. That feather is
    // what keeps disc boundaries from rendering as a hard line of
    // cloud-density change — don't quantize or threshold satData here.
    float satNoDataMask = 0.0;   // research-mode hatch flag (set below)
    vec4  satPix = vec4(0.0);    // hoisted: the cloud-top-height pass below reuses it
    if (u_satellite_on > 0.5) {
        vec4  sat      = texture2D(u_satellite, vUv);
        satPix         = sat;
        float satCloud = sat.r;
        float satData  = sat.a;                             // 1 where the satellite saw this pixel
        float satShape = smoothstep(0.18, 0.85, satCloud);
        float satLow   = satShape * mix(0.85, 1.0, shapeLow);
        float satMid   = satShape * mix(0.55, 0.85, shapeMid);
        // Coverage-weighted blend: full satellite influence only where the
        // alpha mask confirms the pixel is real observation.
        float influence = satData * 0.82;
        alphaLow  = mix(alphaLow,  satLow,           influence);
        alphaMid  = mix(alphaMid,  satMid,           0.60 * satData);
        alphaHigh = mix(alphaHigh, satShape * 0.35,  0.35 * satData);

        // Research mode: outside the satellite's footprint (satData < 1) we
        // want the user to SEE that nothing was observed there, not a
        // plausible procedural cloud. Capture an inverted mask for the
        // hatch overlay below; in composite mode this stays at 0 so nothing
        // changes for casual viewers.
        satNoDataMask = (1.0 - satData) * u_research_mode;
    }

#ifdef SHELL_SPLIT
    // Per-shell isolation: this material renders exactly one deck. Done
    // AFTER the data/satellite blends so every coverage source still routes
    // through the shared code path above.
    #if SHELL_LAYER == 0
    alphaMid = 0.0; alphaHigh = 0.0;
    #elif SHELL_LAYER == 1
    alphaLow = 0.0; alphaHigh = 0.0;
    #else
    alphaLow = 0.0; alphaMid = 0.0;
    #endif
#endif

#if !defined(SHELL_SPLIT) || SHELL_LAYER == 2
    // Cloud-top height (Phase 2.3): the mosaic's B channel carries IR
    // brightness-temperature "top coldness" (0 → ~300 K, 1 → ~195 K; see
    // IR_BT_WARM_K/IR_BT_COLD_K in cloud-mosaic-core.js — keep the 26.85 −
    // b·105 ramp below in lockstep). Against the 2 m surface temperature
    // and a 6.5 K/km lapse, cold tops decode to height; deep convection
    // (tops punching past ~7 km) thickens and seeds the high shell so
    // towers visibly rise. Confidence-feathered — procedural-fill regions
    // grow no fake anvils. B = 0 means "no IR estimate" and is skipped.
    // Runs for the split high shell AND the layered aggregate's high deck,
    // so anvils survive a governor collapse to the composite. Research mode
    // is excluded on purpose: the boost ADDS coverage the measured
    // low/mid/high channels didn't supply, and measured-only alpha must
    // stay alpha = data.
    if (u_satellite_on > 0.5 && u_research_mode < 0.5 && satPix.b > 0.02) {
        float t2mC  = sampleWeatherField(vUv).r * 110.0 - 60.0;
        float btC   = 26.85 - satPix.b * 105.0;
        float cthKm = clamp((t2mC - btC) / 6.5, 0.0, 18.0);
        float tower = smoothstep(7.0, 13.0, cthKm) * satPix.a;
        alphaHigh   = clamp(alphaHigh * (1.0 + 0.9 * tower) + 0.12 * tower, 0.0, 1.0);
    }
#endif

    // ── Storm structure (eye / eyewall) ──────────────────────────────────────
    // Applied per deck BEFORE lighting so the carve shapes each deck's own
    // thickness ramp — the eye reads clear at every altitude, exactly as it
    // did against the old flattened alpha.
    if (u_storm_count > 0) {
        float sMult = stormStructure(vUv);
        alphaLow  = clamp(alphaLow  * sMult, 0.0, 0.95);
        alphaMid  = clamp(alphaMid  * sMult, 0.0, 0.95);
        alphaHigh = clamp(alphaHigh * sMult, 0.0, 0.95);
    }

    // ── Relief lighting ──────────────────────────────────────────────────────
    // A bump normal built from the cheap cloud-form field's gradient (same
    // trick the Earth surface shader uses for terrain) so cumulus towers
    // catch the sun on their sunward face and self-shade on the lee. The bump
    // amplitude is gated by the local cloud amount, so flat thin overcast
    // stays flat while a deep convective stack stands proud. The relief
    // belongs to the deck whose form field N_form tracks — the low cumulus in
    // the aggregate, each shell's own deck when split. The other decks are
    // lit flat: the form gradient is uncorrelated with their shapes, and
    // perturbing them with it only added noise-shaped lighting.
#if defined(SHELL_SPLIT) && SHELL_LAYER == 1
    float reliefAlpha = alphaMid;
#elif defined(SHELL_SPLIT) && SHELL_LAYER == 2
    float reliefAlpha = alphaHigh;
#else
    float reliefAlpha = alphaLow;
#endif
    vec3  up   = abs(N_sphere.y) < 0.985 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
    vec3  tE   = normalize(cross(up, N_sphere));      // local east-ish tangent
    vec3  tN   = normalize(cross(N_sphere, tE));      // local north-ish tangent
    // Quality gate: the four cloudForm taps below are pure embellishment
    // (relief + contact shadow). At the lowest tier they're skipped — flat
    // lighting, which is how this shader shipped before the relief pass —
    // saving ~8 vnoise3 evaluations per fragment. tE/tN stay unconditional:
    // the precipitation veil uses them.
    vec3  Nb     = N;
    float selfSh = 0.0;
    if (u_quality > 0.45) {
        const float EPS = 0.02;
        float fC   = cloudForm(N_form);
        float fE   = cloudForm(normalize(N_form + tE * EPS));
        float fN   = cloudForm(normalize(N_form + tN * EPS));
        float relAmp = clamp(reliefAlpha * 1.6, 0.0, 1.0);
        Nb = normalize(N - (tE * (fE - fC) + tN * (fN - fC)) * 8.0 * relAmp);

        // Self-shadow / contact occlusion: one extra form tap a short step toward
        // the sun in the tangent plane. If the cloud is thicker there, this point
        // sits in its shadow. Cheap one-tap approximation of a sun-march.
        vec3  Lt   = u_sun_dir - N_sphere * dot(u_sun_dir, N_sphere);
        float fSun = cloudForm(normalize(N_form + normalize(Lt + 1e-4) * 0.045));
        selfSh = clamp((fSun - fC) * 3.2, 0.0, 1.0) * relAmp;
    }

    // ── Per-deck altitude lifts + relief routing ─────────────────────────────
#ifdef SHELL_SPLIT
    // Split shells: the per-shell uniform carries this deck's altitude bias,
    // and the relief normal belongs to this deck's own form field. (The two
    // sibling decks' alphas are pinned to 0, so their shadeDeck calls below
    // contribute nothing to the composite.)
    float liftLow = u_shell_lift, liftMid = u_shell_lift, liftHigh = u_shell_lift;
    #if SHELL_LAYER == 0
    float relLow = 1.0, relMid = 0.0, relHigh = 0.0;
    #elif SHELL_LAYER == 1
    float relLow = 0.0, relMid = 1.0, relHigh = 0.0;
    #else
    float relLow = 0.0, relMid = 0.0, relHigh = 1.0;
    #endif
#else
    // Layered aggregate: the same per-altitude terminator biases the split
    // shells are constructed with in earth.html (u_shell_lift is 0 on the
    // composite material — keep the two value sets in lockstep), so the
    // aggregate and split renders agree at the terminator: low decks darken
    // first, cirrus keeps the alpenglow.
    float liftLow  = u_shell_lift - 0.04;
    float liftMid  = u_shell_lift + 0.04;
    float liftHigh = u_shell_lift + 0.14;
    float relLow = 1.0, relMid = 0.0, relHigh = 0.0;
#endif

    float NdotLb  = dot(Nb, u_sun_dir);
    float VdotL   = dot(V, u_sun_dir);
    float forward = pow(clamp(VdotL, 0.0, 1.0), 6.0);

    // Direct sun reaching a deck is attenuated by the decks stacked above
    // it — cirrus + altostratus visibly veil the cumulus below. Split shells
    // can't see their siblings (those alphas are pinned to 0), so there the
    // veil stays 1; the aggregate is where the stacked look pays off.
    float veilLow = 1.0 - 0.35 * clamp(alphaMid + alphaHigh, 0.0, 1.0);
    float veilMid = 1.0 - 0.30 * clamp(alphaHigh, 0.0, 1.0);

    float dayMixLow, dayMixMid, dayMixHigh;
    // Low cumulus: the classic bright-core ramp, full relief + self-shadow.
    vec3 colLow  = shadeDeck(alphaLow,
                             NdotLf + liftLow, mix(NdotLf, NdotLb, relLow) + liftLow,
                             selfSh * relLow, veilLow, forward, 1.0, 0.30,
                             vec3(0.60, 0.66, 0.78), vec3(0.98, 0.99, 1.00),
                             vec3(0.40, 0.50, 0.66), dayMixLow);
    // Mid altostratus: a softer, flatter sheet — a slightly dimmer core so a
    // break in the low deck under altostratus still reads as two layers.
    vec3 colMid  = shadeDeck(alphaMid,
                             NdotLf + liftMid, mix(NdotLf, NdotLb, relMid) + liftMid,
                             selfSh * relMid, veilMid, forward, 0.80, 0.30,
                             vec3(0.63, 0.68, 0.79), vec3(0.94, 0.96, 0.99),
                             vec3(0.43, 0.52, 0.68), dayMixMid);
    // High cirrus: an icy translucent veil — never pure white, strongest
    // forward-scatter silver, warmest terminator (alpenglow lingers here).
    vec3 colHigh = shadeDeck(alphaHigh,
                             NdotLf + liftHigh, mix(NdotLf, NdotLb, relHigh) + liftHigh,
                             selfSh * relHigh, 1.0, forward, 1.35, 0.40,
                             vec3(0.74, 0.80, 0.92), vec3(0.90, 0.94, 1.00),
                             vec3(0.55, 0.62, 0.78), dayMixHigh);

    // ── Precipitation: 3-D rain / snow shafts ────────────────────────────────
    // The old version drew fract() stripes in equirectangular UV: they
    // stretched toward the poles, "fell" southward along the lat axis instead
    // of screen-down, and crawled like marching texture on the spinning
    // globe. The replacement is a noise veil sampled in the local TANGENT
    // frame and scrolled along the local vertical, so it reads as shafts
    // hanging under the cloud base regardless of where on the globe it is.
    //
    // Two physical inputs the old code ignored:
    //   • Intensity uses a perceptual (sqrt) curve so drizzle is visible and
    //     heavy rain saturates — the stored channel is linear mm/hr·0.1, so
    //     light rain (the common case) used to be ~invisible.
    //   • Phase (rain↔snow) comes from the weather grid's TEMPERATURE, not
    //     latitude — snow falls in a winter mid-latitude storm and not over a
    //     warm tropical highland, which the old abs(lat) test got backwards.
    // Split shells: the rain/snow veil hangs under the LOW deck only — the
    // mid/high shells must not repeat it at altitude. In the layered
    // aggregate it is painted onto the low deck BEFORE compositing for the
    // same reason: rain must read under a passing cirrus veil, not over it.
#if !defined(SHELL_SPLIT) || SHELL_LAYER == 0
    if (u_weather_on > 0.5 && precip > 0.004) {
        float precipI = clamp(sqrt(precip * 1.7), 0.0, 1.0);

        float tC       = sampleWeatherField(vUv).r * 110.0 - 60.0;   // °C
        float snowFrac = smoothstep(2.0, -1.5, tC);                    // 1 = snow

        vec3  rainDark = vec3(0.34, 0.40, 0.52);
        vec3  snowPale = vec3(0.90, 0.94, 1.00);
        vec3  pcol     = mix(rainDark, snowPale, snowFrac);

        // Local-frame coordinates → streaks stay vertical & unstretched at
        // every latitude. Smeared hard along the fall axis, tight across it,
        // and scrolled by time so it descends. Snow: coarser + slower drift.
        // Scroll rate is decoupled from the spatial frequency on purpose:
        // u_time is unbounded elapsed seconds and the shader is mediump, so
        // folding scl (~400) into the time term would burn float precision
        // within a few minutes and freeze the rain. Keeping 'fall' small
        // (≈ the old code's u_time·fallSpd·freqY magnitude) stays in the
        // precision regime the shipped shader already ran in.
        vec2  rc    = vec2(dot(N_sphere, tE), dot(N_sphere, tN));
        float scl   = mix(430.0, 250.0, snowFrac);
        float fall  = mix(7.0, 2.5, snowFrac);
        float n1    = fbm(vec2(rc.x * scl, rc.y * scl * 0.20 - u_time * fall), 3);
        float shaft = smoothstep(0.46, 0.80, n1);

        float veil = precipI * (0.30 + 0.70 * dayMixLow);
        // Ambient "it is raining here" wash + brighter/darker falling shafts.
        colLow   = mix(colLow, pcol, veil * 0.42);
        colLow   = mix(colLow, pcol * mix(0.80, 1.30, snowFrac), shaft * veil * 0.50);
        alphaLow = clamp(alphaLow + (0.10 + shaft * 0.20) * veil, 0.0, 0.98);
    }
#endif

    // ── Altitude-ordered compositing (premultiplied over) ────────────────────
    // Cirrus over altostratus over cumulus. The old aggregate flattened the
    // decks with max()+add into ONE alpha before colouring, which erased
    // layer identity — and rendered thinner than the split shells, whose
    // three meshes the GPU already blends with this exact over operator. One
    // compositing rule for both paths means a governor tier flip no longer
    // changes the sky's density, only its parallax fidelity.
    float A = alphaHigh;
    vec3  C = colHigh * alphaHigh;
    C += colMid * alphaMid * (1.0 - A);
    A += alphaMid * (1.0 - A);
    C += colLow * alphaLow * (1.0 - A);
    A += alphaLow * (1.0 - A);
    vec3  col   = C / max(A, 1e-4);
    float alpha = min(A, 0.95);

    // Thin cloud edges stay translucent so they don't read as hard cut-outs
    alpha *= mix(0.55, 1.0, smoothstep(0.0, 0.30, alpha));

    // ── Research-mode no-data hatch ──────────────────────────────────────────
    // In composite mode this branch is dormant (satNoDataMask = 0). In
    // research mode it paints a faint diagonal stripe over regions the
    // satellite mosaic didn't cover (polar caps, between-disc gaps), so
    // researchers can immediately tell where coverage ends. The hatch is
    // additive on alpha so it shows even where no procedural cloud was drawn.
    if (satNoDataMask > 0.01) {
        // Diagonal lines at ~3° spacing — independent of latitude so the
        // pattern reads consistently from pole to equator.
        float hatch  = step(0.5, fract((vUv.x + vUv.y) * 60.0));
        float hatchA = hatch * satNoDataMask * 0.18;
        col          = mix(col, vec3(0.55, 0.62, 0.78), hatchA);
        alpha        = clamp(alpha + hatchA, 0.0, 0.95);
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
varying vec3 vNormalLocal;     // object-space unit direction (sphere normal)
varying vec3 vWorldNormal;
void main() {
    vNormalLocal = normalize(position);
    vWorldNormal = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
    gl_Position  = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

export const AURORA_FRAG = /* glsl */`
precision highp float;

${GEO_GLSL}

uniform float u_kp;
uniform float u_time;
uniform vec3  u_sun_dir;
uniform float u_enabled;
uniform float u_bz_south;      // 0..1 normalised southward IMF Bz (1 = very -Bz)
uniform float u_aurora_power;  // 0..1 hemispheric auroral power proxy
uniform vec3  u_mag_pole;      // geomagnetic dipole pole (unit normal)
varying vec3 vNormalLocal;
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
    // Hard kill on toggle off — that is the users intent. We do NOT
    // also discard on low Kp the way the previous version did: that
    // made the toggle silently no-op during quiet periods (Kp below
    // 1.5 is most of the time at solar minimum), so users would flip
    // the checkbox and see no visual response, concluding "the toggle
    // is broken." Instead, the shader always runs while u_enabled is
    // on; a quiet-period multiplier (quietGate below) softly fades
    // the band toward zero alpha so the visual story is "I see the
    // oval is there, it is just dim because nothing is happening."
    if (u_enabled < 0.5) discard;

    // UV reconstructed from interpolated object-space normal (see EARTH_VERT
    // for the rationale). Feed it straight into the same helpers used by the
    // Earth surface shader so oval coordinates and surface lighting agree to
    // the pixel.
    vec3  nGeo        = normalize(vNormalLocal);
    vec2  vUv         = normalToUV(nGeo);

    // Oval position uses MAGNETIC latitude — dipole tilt puts the ring over
    // Hudson Bay / Taymyr, not the geographic pole. Ripple phase keeps using
    // geographic longitude because the wave pattern is visual, not physical.
    float magCoLatDeg = GEO_RAD2DEG * magneticColatitude(nGeo, u_mag_pole);
    float absLat      = 90.0 - min(magCoLatDeg, 180.0 - magCoLatDeg);
    float lonDeg      = uvToLatLonDeg(vUv).y;

    // For visualisation only — when actual Kp is below the climatological
    // floor we *render* as if Kp were 1.5 so the oval has a visible band
    // even at solar minimum. This is purely cosmetic; the actual
    // physical inputs (band width, ray gating, colour ramp) still respond
    // to the live Kp via kpEff.  quietGate later fades the alpha back
    // down so quiet periods don't lie about activity.
    float kpDisplay = max(u_kp, 1.5);

    // Effective storm strength — Kp plus a Bz-south kicker so a fresh
    // southward turning shoves the oval equatorward immediately, without
    // having to wait for the Kp index to catch up.
    float bz      = clamp(u_bz_south, 0.0, 1.0);
    float kpEff   = kpDisplay + bz * 1.8;

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

    // Quiet-period gate — at the actual Kp 0 the oval renders at ~30%
    // of its full alpha; at Kp ≥ 2 it's at full strength. Combined
    // with the kpDisplay floor above, this gives the user a visible
    // "the toggle is on, here's where the oval lives" indicator
    // during solar minimum without overstating the activity.
    float quietGate = mix(0.30, 1.0, smoothstep(0.0, 2.0, u_kp));

    float intensity = band * pulse * nightM * kpGate * rayGlow * powerBoost + substorm * band * nightM;
    float curtain   = 0.55 + 0.45 * eq;

    gl_FragColor = vec4(col * intensity * curtain * 1.8 * quietGate,
                        clamp(intensity * 0.85 * quietGate, 0.0, 1.0));
}`;

// ═══════════════════════════════════════════════════════════════════════════════
//  TEMPERATURE VOLUME SHELL  (ray-marched 3-D T(lat, lon, z))
// ═══════════════════════════════════════════════════════════════════════════════
// Renders the atmospheric temperature field as a translucent volume between
// the surface and u_r_outer. The vertical profile at each column is anchored
// on REAL data at three levels — the 2 m surface T already in u_weather, and
// 850 hPa / 500 hPa temperatures from js/temp-volume-feed.js (Open-Meteo
// pressure-level fields, hourly, past 24 h → +72 h so the profile scrubs with
// simTimeMs) — piecewise-linear between anchors, lapse-extrapolated above
// 500 hPa and capped at the −56.5 °C tropopause isotherm. Until the level
// feed lands it degrades to the 6.5 K/km standard-atmosphere lapse off the
// live surface field, so the toggle never shows an empty shell.
//
// The shell's geometric thickness is vertically EXAGGERATED (~0.06 R vs the
// true troposphere's 0.0017 R) or it would be invisible at globe scale; the
// temperatures themselves are not scaled. The 0 °C crossing gets a bright
// sheet so the freezing-level surface — where the profile crosses phase —
// reads as an actual 3-D surface hugging the terrain of the temperature
// field. 16 fixed march steps; ray-sphere slab intersection is analytic, so
// the cost is one shell draw at ~16 taps/fragment, comparable to one cloud
// FBM octave.

export const TEMPVOL_VERT = /* glsl */ `
varying vec3 vObjPos;
void main() {
    vObjPos = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

export const TEMPVOL_FRAG = /* glsl */ `
${GEO_GLSL}

uniform sampler2D u_weather;      // R = surface T, encoded (T°C+60)/110
uniform sampler2D u_vol_levels;   // R = T850 norm, G = T500 norm (same encoding)
uniform sampler2D u_temp_lut;     // 256×1 shared temperature ramp
uniform vec3  u_cam_obj;          // camera position in the shell's object space
uniform vec3  u_sun_dir_obj;      // sun direction in the shell's object space
uniform float u_r_inner;          // planet surface radius (object units)
uniform float u_r_outer;          // slab top (object units, exaggerated)
uniform float u_alpha;            // overall opacity scale
uniform float u_has_levels;       // 1 → real 850/500 hPa anchors are loaded
uniform float u_top_km;           // physical altitude represented at u_r_outer
varying vec3 vObjPos;

// Analytic ray-sphere intersection: (tNear, tFar); tFar < tNear → miss.
vec2 sphereHit(vec3 ro, vec3 rd, float r) {
    float b = dot(ro, rd);
    float c = dot(ro, ro) - r * r;
    float h = b * b - c;
    if (h < 0.0) return vec2(1e9, -1e9);
    h = sqrt(h);
    return vec2(-b - h, -b + h);
}

// Temperature (°C) at column uv, altitude zKm. Anchors: 2 m surface,
// 850 hPa ≈ 1.457 km, 500 hPa ≈ 5.574 km (US standard-atmosphere heights);
// linear between anchors, environmental-lapse extrapolation above, capped
// at the tropopause isotherm.
float tempAtC(vec2 uv, float zKm) {
    float tSfc = texture2D(u_weather, uv).r * 110.0 - 60.0;
    if (u_has_levels < 0.5) return max(tSfc - 6.5 * zKm, -56.5);
    vec2 lv = texture2D(u_vol_levels, uv).rg * 110.0 - 60.0;
    float z850 = 1.457, z500 = 5.574;
    if (zKm <= z850) return mix(tSfc, lv.r, zKm / z850);
    if (zKm <= z500) return mix(lv.r, lv.g, (zKm - z850) / (z500 - z850));
    float lapse = (lv.g - lv.r) / (z500 - z850);       // K/km, negative
    return max(lv.g + lapse * (zKm - z500), -56.5);
}

void main() {
    vec3 ro = u_cam_obj;
    vec3 rd = normalize(vObjPos - ro);
    vec2 outer = sphereHit(ro, rd, u_r_outer);
    if (outer.y < outer.x) discard;
    float t0 = max(outer.x, 0.0);
    float t1 = outer.y;
    vec2 inner = sphereHit(ro, rd, u_r_inner);
    if (inner.y > inner.x && inner.x > 0.0) t1 = min(t1, inner.x);  // ground ends the march
    if (t1 <= t0) discard;

    const int STEPS = 16;
    float dt   = (t1 - t0) / float(STEPS);
    float span = u_r_outer - u_r_inner;
    vec4 acc = vec4(0.0);
    for (int i = 0; i < STEPS; i++) {
        float t = t0 + (float(i) + 0.5) * dt;
        vec3  p = ro + rd * t;
        float r = length(p);
        vec3  n = p / r;
        vec2  uv = normalToUV(n);
        float zKm = clamp((r - u_r_inner) / span, 0.0, 1.0) * u_top_km;
        float tC  = tempAtC(uv, zKm);
        vec3  col = texture2D(u_temp_lut,
                              vec2(clamp((tC + 60.0) / 110.0, 0.0, 1.0), 0.5)).rgb;
        // Faint isotherm bands every 10 °C — a brightness ridge where the
        // march crosses a decade isotherm surface, so the volume reads as
        // stacked analysis surfaces instead of undifferentiated haze.
        // Multiplicative so the ramp's hue identity is preserved.
        float bandPos = abs(fract(tC * 0.1 + 0.5) - 0.5) * 10.0;   // °C to nearest decade line
        col *= 1.0 + 0.28 * (1.0 - smoothstep(0.15, 0.60, bandPos));
        // Lower troposphere carries most of the visual weight; the 0 °C
        // crossing gets a bright sheet so the freezing-level surface pops.
        float dens = exp(-zKm * 0.30);
        float frz  = 1.0 - smoothstep(0.0, 1.4, abs(tC));
        // Ride the surface's day/night so the volume doesn't glow at night.
        float lit  = 0.45 + 0.55 * smoothstep(-0.15, 0.25, dot(n, u_sun_dir_obj));
        float a = clamp(u_alpha * (dt / span) * 1.4 * (dens + frz * 2.4), 0.0, 1.0);
        acc.rgb += (1.0 - acc.a) * a * col * lit;
        acc.a   += (1.0 - acc.a) * a;
        if (acc.a > 0.96) break;
    }
    if (acc.a < 0.003) discard;
    gl_FragColor = vec4(acc.rgb / max(acc.a, 1e-4), acc.a);
}`;

/** Default temperature-volume uniforms. earth.html points u_weather at the
 *  same DataTexture the surface shader samples, so surface tint and volume
 *  always agree; u_vol_levels is fed by TempVolumeFeed. */
export function createTempVolumeUniforms() {
    return {
        u_weather:     { value: _blackTex() },
        u_vol_levels:  { value: _blackTex() },
        u_temp_lut:    { value: createTempLUTTexture() },
        u_cam_obj:     { value: new THREE.Vector3(0, 0, 3) },
        u_sun_dir_obj: { value: new THREE.Vector3(1, 0, 0) },
        u_r_inner:     { value: 1.0 },
        u_r_outer:     { value: 1.06 },
        u_alpha:       { value: 0.85 },
        u_has_levels:  { value: 0 },
        u_top_km:      { value: 11.0 },
    };
}

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
        u_temp_lut:     { value: createTempLUTTexture() },
        // High-res focus patch (js/weather-patch.js). Off by default — only
        // earth.html wires a feed; other consumers render the global field.
        u_patch_weather:{ value: _blackTex() },
        u_patch_bounds: { value: new THREE.Vector4(0, 0, 1, 1) },
        u_patch_on:     { value: 0 },
        // GIBS imagery detail inset (js/earth-detail-inset.js). Same
        // off-by-default contract as the weather patch.
        u_detail:       { value: _blackTex() },
        u_detail_bounds:{ value: new THREE.Vector4(0, 0, 1, 1) },
        u_detail_on:    { value: 0 },
        // GIBS topology detail inset — drives the bump pass at close range.
        u_topo_detail:        { value: _blackTex() },
        u_topo_detail_bounds: { value: new THREE.Vector4(0, 0, 1, 1) },
        u_topo_detail_on:     { value: 0 },
        u_topo_detail_texel:  { value: new THREE.Vector2(1 / 512, 1 / 512) },
        u_sun_dir:      { value: sunDir.clone() },
        // Cloud-shadow inputs (see EARTH_FRAG). Defaults keep every
        // consumer that doesn't wire them (space-weather-globe,
        // heliosphere3d) on the zero-cost branch: shadow off, black
        // cloud texture, object-space sun equal to world sun.
        u_cloud_layers: { value: _blackTex() },
        u_satellite:    { value: _blackTex() },
        u_satellite_on: { value: 0 },
        u_cloud_shadow: { value: 0 },
        u_sun_dir_obj:  { value: sunDir.clone() },
        u_time:         { value: 0 },
        u_kp:           { value: 0 },
        u_xray:         { value: 0 },
        u_city_lights:  { value: 1 },
        u_aurora_on:    { value: 1 },
        u_weather_on:   { value: 0 },
        u_aurora_power: { value: 0 },
        u_bz_south:     { value: 0 },
        u_dst_norm:     { value: 0 },
        // Geomagnetic dipole north pole as a unit normal — drives the aurora
        // oval off the geographic pole (11° tilt at 2025 epoch). Shared with
        // the aurora mesh uniforms so oval + surface brightness agree.
        u_mag_pole:     { value: geo.magneticPoleNormal() },
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
        // See note in createEarthUniforms — same IGRF-2025 dipole pole.
        u_mag_pole:     { value: geo.magneticPoleNormal() },
    };
}

/** Default cloud layer uniforms. */
export function createCloudUniforms(sunDir = new THREE.Vector3(1, 0, 0)) {
    return {
        u_weather:       { value: _blackTex() },
        u_cloud_layers:  { value: _blackTex() },  // real cloud fraction + precip
        // High-res focus patch — see createEarthUniforms. Cloud frag gets its
        // own cloud-layer patch sampler on top of the shared weather one.
        u_patch_weather: { value: _blackTex() },
        u_patch_clouds:  { value: _blackTex() },
        u_patch_bounds:  { value: new THREE.Vector4(0, 0, 1, 1) },
        u_patch_on:      { value: 0 },
        u_satellite:     { value: _grayTex()  },  // GOES/MODIS satellite imagery
        u_sun_dir:       { value: sunDir.clone() },
        u_time:          { value: 0 },
        u_weather_on:    { value: 0 },
        u_satellite_on:  { value: 0 },            // off until satellite texture arrives
        u_cloud_data_strength: { value: 0.5 },    // 0.5 matches original ±25% imprint
        // Adaptive ALU budget — stepped down by earth.html's resolution
        // governor on struggling GPUs. 1 = original full-quality shader.
        u_quality:       { value: 1 },
        // Research / measured-only mode (see CLOUD_FRAG): 0 = composite (default),
        // 1 = data-only with hatched no-data overlay. UI toggle in earth.html.
        u_research_mode: { value: 0 },
        // Altitude terminator bias (Phase 2.2). 0 on the composite shell —
        // its layered aggregate adds the split shells' per-deck biases as
        // in-shader constants — and overridden per altitude by the split
        // shells via their own uniform entry.
        u_shell_lift:    { value: 0 },
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
 * @param {object} [opts]
 * @param {number} [opts.anisotropy=1] - pass renderer.capabilities.getMaxAnisotropy()
 *   to sharpen oblique/mid-zoom sampling. Mipmaps stay at the TextureLoader
 *   defaults (generateMipmaps=true, LinearMipmapLinearFilter) — anisotropic
 *   filtering rides on top of them.
 * @returns {Promise<void>}
 */
export function loadEarthTextures(earthU, cloudU = null, { anisotropy = 1 } = {}) {
    const loader = new THREE.TextureLoader();

    const loadTex = (url, onLoad, fallbackFn) => new Promise(resolve => {
        loader.load(url,
            tex => {
                tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
                // Canonical UV convention (js/geo/coords.js): v=0 at +90°N.
                // TextureLoader defaults flipY=true, which would map image
                // row 0 (north) to GL t=1 and put the south pole at v=0 —
                // rendering the globe upside-down. Keep image rows aligned
                // with the shader's normalToUV() by disabling the flip.
                tex.flipY = false;
                tex.anisotropy = anisotropy;
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
     * @param {number}  [opts.segments=64]           — legacy; mapped to icoLevel (28→4, 48→5, 80+→6)
     * @param {number}  [opts.icoLevel]              — icosphere subdivision level (overrides segments)
     * @param {boolean} [opts.clouds=true]           — include cloud shell
     * @param {boolean} [opts.atmosphere=true]       — include atmosphere rim
     * @param {boolean} [opts.aurora=true]           — aurora uniforms active
     */
    constructor(parent, sunDir = new THREE.Vector3(1, 0, 0), {
        radius     = 1.0,
        segments   = 64,
        icoLevel,
        clouds     = true,
        atmosphere = true,
    } = {}) {
        this._parent = parent;

        // Map the legacy `segments` count to an icosphere subdivision level.
        // Earth AND clouds share the level so their topology aligns exactly —
        // no more cloud stripes floating relative to continents from mismatched
        // SphereGeometry segment counts.
        const lvl = icoLevel ?? (segments >= 80 ? 6 : segments >= 48 ? 5 : 4);

        // Earth surface
        this.earthU = createEarthUniforms(sunDir);
        const earthMat = new THREE.ShaderMaterial({
            vertexShader: EARTH_VERT, fragmentShader: EARTH_FRAG,
            uniforms: this.earthU,
        });
        this.earthMesh = new THREE.Mesh(
            new THREE.IcosahedronGeometry(radius, lvl),
            earthMat
        );
        parent.add(this.earthMesh);

        // Cloud shell (1.009 R⊕ above surface) — IDENTICAL tessellation level
        // to Earth so cloud features sit exactly over their underlying surface
        // pixels at every latitude.
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
                new THREE.IcosahedronGeometry(radius * 1.009, lvl),
                cloudMat
            );
            this.cloudMesh.renderOrder = 3;  // after atmosphere glow (1)
            parent.add(this.cloudMesh);
        }

        // Atmosphere rim glow — one level lower is plenty for a fresnel shell
        // (silhouette only, no texture sampling).
        if (atmosphere) {
            const atmU = { u_sun_dir: this.earthU.u_sun_dir };
            const atmMat = new THREE.ShaderMaterial({
                vertexShader: ATM_VERT, fragmentShader: ATM_FRAG,
                uniforms: atmU, transparent: true, depthWrite: false,
                side: THREE.BackSide, blending: THREE.AdditiveBlending,
            });
            this._atmMesh = new THREE.Mesh(
                new THREE.IcosahedronGeometry(radius * 1.026, Math.max(3, lvl - 1)),
                atmMat
            );
            this._atmMesh.renderOrder = 1;   // atmosphere glow renders first
            parent.add(this._atmMesh);
        }
    }

    /** Load textures from CDN. Returns Promise<void>. */
    loadTextures(opts = {}) {
        return loadEarthTextures(this.earthU, this.cloudU, opts);
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
