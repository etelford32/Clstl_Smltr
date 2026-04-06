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

// ── Texture CDNs — CORS-enabled sources only ─────────────────────────────────
// three-globe@2.31.1 (latest) for reliable CDN assets
// NASA GIBS daily snapshot used as live day texture via earth-hires.js
const _CDN = 'https://unpkg.com/three-globe@2.31.1/example/img/';
export const EARTH_TEXTURES = {
    day:    _CDN + 'earth-blue-marble.jpg',
    night:  _CDN + 'earth-night.jpg',
    ocean:  _CDN + 'earth-water.png',
    clouds: _CDN + 'earth-topology.png',   // reuse topology as cloud noise seed
    bump:   _CDN + 'earth-topology.png',
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
//  EARTH SURFACE SHADERS
// ═══════════════════════════════════════════════════════════════════════════════

export const EARTH_VERT = /* glsl */`
varying vec2 vUv;
varying vec3 vWorldNormal;
varying vec3 vWorldPos;
varying vec3 vWorldTangent;
varying vec3 vWorldBitangent;
void main() {
    vUv          = uv;
    vWorldNormal = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
    vWorldPos    = (modelMatrix * vec4(position, 1.0)).xyz;

    // Compute tangent/bitangent from sphere geometry for normal mapping.
    // On a unit sphere, tangent = dP/dLon (east), bitangent = dP/dLat (north).
    vec3 N = normalize(normal);
    // Tangent: perpendicular to N in the horizontal plane (east direction)
    vec3 up = vec3(0.0, 1.0, 0.0);
    vec3 T  = normalize(cross(up, N));
    // Handle poles where cross product degenerates
    if (length(cross(up, N)) < 0.001) T = vec3(1.0, 0.0, 0.0);
    vec3 B = cross(N, T);
    vWorldTangent   = normalize((modelMatrix * vec4(T, 0.0)).xyz);
    vWorldBitangent = normalize((modelMatrix * vec4(B, 0.0)).xyz);

    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

export const EARTH_FRAG = /* glsl */`
#ifdef GL_OES_standard_derivatives
#extension GL_OES_standard_derivatives : enable
#endif
precision highp float;

uniform sampler2D u_day;
uniform sampler2D u_night;
uniform sampler2D u_specular;   // ocean mask (r = ocean)
uniform sampler2D u_weather;    // R=temp, G=pressure [0=low,1=high], B=humidity, A=wind
uniform sampler2D u_bump;       // elevation/topology grayscale
uniform sampler2D u_hires;      // hi-res satellite tile composite (GIBS WMTS)
uniform float u_hires_on;       // 1 = blend hi-res tiles, 0 = base texture only
uniform vec4  u_hires_bounds;   // (lonMin, latMin, lonMax, latMax) of visible tile region
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
uniform float u_bump_strength; // terrain relief intensity (0 = off, 1 = default)

varying vec2 vUv;
varying vec3 vWorldNormal;
varying vec3 vWorldPos;
varying vec3 vWorldTangent;
varying vec3 vWorldBitangent;

// ── Terrain normal perturbation from bump/topology map ─────────────────────────
vec3 perturbNormal(vec3 N, vec3 T, vec3 B, vec2 uv, float strength) {
    // Use screen-space derivatives for proper texel stepping (adapts to zoom level)
    vec2 dUVdx = dFdx(uv);
    vec2 dUVdy = dFdy(uv);
    float texelScale = max(length(dUVdx), length(dUVdy));
    // Clamp to at least 1 texel of a 2048-wide map to avoid zero-step sampling
    vec2 texel = max(vec2(texelScale), vec2(1.0 / 2048.0));

    float hL = texture2D(u_bump, uv - vec2(texel.x, 0.0)).r;
    float hR = texture2D(u_bump, uv + vec2(texel.x, 0.0)).r;
    float hD = texture2D(u_bump, uv - vec2(0.0, texel.y)).r;
    float hU = texture2D(u_bump, uv + vec2(0.0, texel.y)).r;

    // Gradient in tangent space
    float dU = (hR - hL) * strength;
    float dV = (hU - hD) * strength;

    // Perturbed normal in world space
    return normalize(N - T * dU - B * dV);
}

// ── Aurora curtains (optimized: 2 sin, altitude-dependent colour) ─────────────
vec3 auroraColor(float sinAbsLat, float lon, float kp) {
    float kpEff  = kp + u_bz_south * 2.5;
    float ovalCtr = 0.940 - clamp(kpEff, 0.0, 9.0) * 0.0197;
    float ovalW   = 0.045 + (kpEff / 9.0) * 0.055;

    float zone = smoothstep(ovalCtr - ovalW * 1.8, ovalCtr - ovalW * 0.3, sinAbsLat)
               * (1.0 - smoothstep(ovalCtr + ovalW * 0.3, ovalCtr + ovalW * 1.2, sinAbsLat));
    if (zone < 0.001) return vec3(0.0);

    // 2-sine curtain pattern (reduced from 6 — visually equivalent with proper phase offsets)
    float phase = u_time * 1.2 + lon * 12.0;
    float anim = 0.55 + 0.30 * sin(phase) + 0.15 * sin(phase * 0.6 + 2.1);

    float powerScale = 0.30 + 0.70 * u_aurora_power;
    float bright = zone * anim * powerScale;

    // Altitude-dependent colour (green → red poleward, purple equatorward in storms)
    float latOff = (sinAbsLat - ovalCtr) / (ovalW * 1.5);
    vec3 col = vec3(0.08, 0.95, 0.18);  // green base
    col = mix(col, vec3(0.85, 0.12, 0.15), smoothstep(0.0, 0.8, latOff) * 0.5);  // red poleward
    col = mix(col, vec3(0.55, 0.10, 0.85), smoothstep(0.0, -0.5, latOff) * clamp((kpEff - 3.0) / 5.0, 0.0, 0.5));

    return col * bright;
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

// ── Ocean wave normal perturbation (3 layers — fast, visually rich) ──────────
// Reduced from 6 to 3 sine layers (saves 7 sin/cos calls per ocean pixel).
// The dominant swell + wind chop + capillary trio captures the visual essence.
vec2 oceanWaveNormal(vec2 uv, float t) {
    // Dominant swell (~200m wavelength)
    float s1 = sin(uv.x * 280.0 + t * 0.65) * cos(uv.y * 240.0 + t * 0.48);
    // Wind chop (~40m) + cross-swell
    float s2 = sin(uv.x * 520.0 + uv.y * 350.0 - t * 0.9) * 0.55;
    // Capillary sparkle (~5m) — visible at close zoom
    float s3 = sin(uv.x * 1200.0 + uv.y * 900.0 + t * 2.2) * 0.18;
    return vec2(s1 + s2 + s3, s2 + s1 * 0.6 + s3) * 0.0014;
}

// ── Aerial perspective (atmospheric haze with distance) ──────────────────────
// Objects further from camera appear bluer/hazier due to Rayleigh in-scattering.
// The #1 feature that makes professional Earth renderers look photorealistic.
vec3 aerialPerspective(vec3 surfaceCol, float dist, float NdotL, vec3 L) {
    float day = smoothstep(-0.05, 0.15, NdotL);

    // Rayleigh blue dominates dayside; warm orange near terminator; dark at night
    vec3 hazeCol = mix(vec3(0.012, 0.016, 0.04), vec3(0.20, 0.36, 0.62), day);

    // Terminator haze shifts warm (Rayleigh through thick atmosphere path)
    float termFade = smoothstep(-0.10, 0.0, NdotL) * smoothstep(0.15, 0.02, NdotL);
    hazeCol = mix(hazeCol, vec3(0.40, 0.22, 0.08), termFade * 0.45);

    // Exponential distance fog
    float hazeDensity = 1.0 - exp(-max(0.0, dist - 0.8) * 0.55);
    hazeDensity *= 0.50;

    return mix(surfaceCol, hazeCol, hazeDensity);
}

// ── Polar ice/snow BRDF ──────────────────────────────────────────────────────
// Ice caps have much higher albedo (~0.8) and distinct specular character
// (broad, low-intensity glint from granular microstructure)
float isIceRegion(vec2 uv, vec3 dayCol) {
    float lat = abs((0.5 - uv.y) * 3.14159265);
    // High-latitude regions + brightness check (ice is white in texture)
    float latMask = smoothstep(1.10, 1.35, lat);  // > ~63° latitude
    float brightness = dot(dayCol, vec3(0.299, 0.587, 0.114));
    // Ice is bright white in Blue Marble; combine with latitude
    return latMask * smoothstep(0.55, 0.75, brightness);
}

// ── Cloud shadow approximation ───────────────────────────────────────────────
// Sample the cloud texture to darken the surface beneath thick clouds.
// This creates visible cloud shadows on the ground, adding tremendous depth.
float cloudShadow(vec2 uv, vec3 sunDir) {
    // Offset UV in sun direction to approximate shadow projection
    vec2 shadowOffset = vec2(sunDir.x, -sunDir.y) * 0.004;
    float cloud = texture2D(u_specular, uv).g;  // reuse specular G channel if available
    // Sample cloud texture for shadow density
    // (actual cloud texture is on a separate mesh, so we approximate with noise)
    float shadow = texture2D(u_bump, uv + shadowOffset + vec2(u_time * 0.00005, 0.0)).r;
    // Invert and threshold: high bump values ≈ cloud-free, low ≈ shadowed
    return 1.0 - smoothstep(0.3, 0.6, shadow) * 0.12;
}

void main() {
    vec3 Nflat = normalize(vWorldNormal);
    vec3 T     = normalize(vWorldTangent);
    vec3 B     = normalize(vWorldBitangent);
    vec3 V     = normalize(cameraPosition - vWorldPos);
    vec3 L     = normalize(u_sun_dir);

    // ── Texture sampling ──────────────────────────────────────────────────────
    vec3  dayCol   = texture2D(u_day,      vUv).rgb;
    vec3  nightCol = texture2D(u_night,    vUv).rgb;
    float oceanMsk = texture2D(u_specular, vUv).r;

    // ── Hi-res satellite tile overlay (NASA GIBS MODIS/VIIRS true-color) ──���─
    // When zoomed close, blend daily satellite imagery over the base texture
    // for real-time land detail (vegetation, snow, deserts, urban areas)
    if (u_hires_on > 0.5) {
        // Composite texture uses same equirectangular UV as base — just sample directly.
        // Tiles are drawn at correct geographic positions on the canvas.
        // Works across antimeridian (Asia, Pacific, etc) with no bounds remapping.
        vec3 hiCol = texture2D(u_hires, vUv).rgb;
        // Only blend where composite has actual imagery (not black/empty areas)
        float hiLum = dot(hiCol, vec3(0.299, 0.587, 0.114));
        float hiBlend = smoothstep(0.02, 0.10, hiLum);
        dayCol = mix(dayCol, hiCol, hiBlend * 0.88);
    }

    // ── Normal perturbation ───────────────────────────────────────────────────
    float bumpStr = u_bump_strength * 2.8;
    vec3 N = (bumpStr > 0.01) ? perturbNormal(Nflat, T, B, vUv, bumpStr) : Nflat;

    // Suppress terrain bump on ocean; add wave ripple instead
    if (oceanMsk > 0.5) {
        vec2 waveOff = oceanWaveNormal(vUv, u_time);
        N = normalize(Nflat + T * waveOff.x + B * waveOff.y);
    }

    float NdotL  = dot(N, L);
    float NdotLf = dot(Nflat, L);  // flat normal for global lighting decisions

    // ── Multi-zone terminator transition ──────────────────────────────────────
    // Real terminator has 3 zones: civil twilight (-6°), nautical (-12°), astronomical (-18°)
    // NdotL ≈ 0 at terminator; -0.10 ≈ ~6° below horizon
    float dayFull    = smoothstep(0.0,  0.15, NdotLf);     // full daylight
    float twilight   = smoothstep(-0.18, 0.0, NdotLf);     // civil+nautical twilight zone
    float nightFull  = 1.0 - smoothstep(-0.22, -0.05, NdotLf); // deep night

    // ── Surface colour composition ────────────────────────────────────────────
    // Day side: Blue Marble is already a photo — apply subtle colour grading
    vec3 dayGraded = dayCol;
    // Boost saturation slightly on dayside for vivid continents
    float dayLum = dot(dayGraded, vec3(0.299, 0.587, 0.114));
    dayGraded = mix(vec3(dayLum), dayGraded, 1.12);

    // Night side: city lights with brightness boost + warm amber tint
    // Apply population-density-aware falloff (brighter lights = larger cities)
    float lightBright = max(nightCol.r, max(nightCol.g, nightCol.b));
    // Non-linear boost: dim lights stay dim, bright cities pop
    vec3 cityLights = nightCol * (1.8 + lightBright * 3.5);
    // Warm amber colour shift for sodium vapor streetlights
    cityLights *= vec3(1.0, 0.82, 0.55);

    // City lights fade during twilight (not hard cutoff)
    float cityVis = (1.0 - twilight) * u_city_lights;
    // Keep some faint lights visible even in civil twilight
    cityVis = max(cityVis, nightFull * u_city_lights * 0.6);

    // ── Ocean deep colour ─────────────────────────────────────────────────────
    // Open ocean is darker/bluer than coastal shallows visible in the texture
    if (oceanMsk > 0.5) {
        vec3 deepOcean = vec3(0.01, 0.04, 0.12);
        vec3 shallowOcean = dayCol;
        // Latitude-based depth approximation (polar waters darker/greener)
        float lat = abs((0.5 - vUv.y) * 3.14159265);
        float depthMix = oceanMsk * 0.35 * (1.0 - lat * 0.3);
        dayGraded = mix(dayGraded, mix(shallowOcean, deepOcean, 0.5), depthMix);
    }

    // ── Polar ice detection ─────────────────────────────────────────────────────
    float iceMask = isIceRegion(vUv, dayCol);

    // Ice albedo boost: polar ice/snow reflects ~80% of light
    if (iceMask > 0.1) {
        dayGraded = mix(dayGraded, vec3(0.85, 0.88, 0.92), iceMask * 0.4);
    }

    // ── Blend day/night ───────────────────────────────────────────────────────
    vec3 base = mix(cityLights * cityVis, dayGraded, dayFull);

    // ── Lighting model ────────────────────────────────────────────────────────
    float lambert = max(NdotL, 0.0);

    // Indirect sky illumination: hemisphere integral approximation
    float skyVis = 0.5 + 0.5 * Nflat.y;
    vec3 skyAmbient = mix(vec3(0.02, 0.015, 0.01), vec3(0.04, 0.06, 0.12), skyVis);

    // Subsurface forward-scattering at terminator: sunlight filters through
    // the atmosphere and illuminates the dark side near the terminator.
    // This creates a soft warm glow just past the shadow line.
    float sssZone = smoothstep(-0.15, 0.0, NdotLf) * smoothstep(0.05, -0.08, NdotLf);
    vec3 sssLight = vec3(0.18, 0.06, 0.01) * sssZone * 0.8;

    // Direct light: warm-white sunlight
    vec3 sunCol = vec3(1.0, 0.98, 0.92);
    vec3 directLight = sunCol * lambert * dayFull;

    // Cloud shadow on surface (darkens ground beneath thick clouds)
    float cShadow = cloudShadow(vUv, L);

    // Total illumination
    vec3 illumination = (directLight * cShadow) + skyAmbient + sssLight;
    base *= illumination;

    // ── Ocean specular (single GGX + Fresnel) ──────────────────────────────────
    // Merged dual-lobe into one medium-roughness lobe (0.08) — visually equivalent,
    // eliminates one pow() call. Sun glitter folded into wave normal perturbation.
    if (oceanMsk > 0.3 && dayFull > 0.01) {
        vec3  H2     = normalize(L + V);
        float NdotV  = max(dot(N, V), 0.001);
        float NdotH  = max(dot(N, H2), 0.0);

        // Schlick Fresnel (F0 = 0.02 for seawater)
        float fresnel = 0.02 + 0.98 * pow(1.0 - max(dot(V, H2), 0.0), 5.0);

        // Single GGX lobe (roughness 0.08 — between calm swell and wind chop)
        float r2 = 0.0064;  // 0.08²
        float denom = NdotH * NdotH * (r2 - 1.0) + 1.0;
        float D = r2 / (3.14159265 * denom * denom);
        float spec = D * fresnel * oceanMsk * dayFull;
        base += vec3(spec * 0.85, spec * 0.92, spec) * 0.55;

        // Fresnel sky reflection at grazing angles + tropical SSS
        float rimF = pow(1.0 - NdotV, 4.0) * oceanMsk * dayFull;
        base += vec3(0.10, 0.18, 0.32) * rimF * 0.20;

        // Tropical subsurface scattering (turquoise shallow water)
        float tropLat = smoothstep(0.7, 0.2, abs((0.5 - vUv.y) * 3.14159265));
        base += vec3(0.02, 0.08, 0.06) * max(dot(N, -L), 0.0) * tropLat * dayFull * 0.35;
    }
    // Night ocean: faint ambient
    if (oceanMsk > 0.3 && nightFull > 0.01) {
        base += vec3(0.004, 0.006, 0.014) * nightFull * oceanMsk;
    }

    // ── Ice/snow specular (broad, diffuse glint) ─────────────────────────────
    if (iceMask > 0.1) {
        vec3  H2     = normalize(L + V);
        float NdotH  = max(dot(Nflat, H2), 0.0);
        // Ice: very rough specular (granular microstructure, roughness ~0.4)
        float iceRough2 = 0.4 * 0.4;
        float iceDenom  = NdotH * NdotH * (iceRough2 - 1.0) + 1.0;
        float iceD      = iceRough2 / (3.14159265 * iceDenom * iceDenom);
        float iceSpec   = iceD * iceMask * dayFull * 0.15;
        // Ice reflects white-blue, broader and dimmer than ocean
        base += vec3(0.85, 0.90, 1.00) * iceSpec;
    }

    // ── Terminator atmospheric glow ───────────────────────────────────────────
    // Wide warm band from Rayleigh scattering through ~100 km of atmosphere
    // at grazing angle. Three-colour gradient: gold core → orange → deep red edge
    float termCore = smoothstep(-0.04, 0.01, NdotLf) * smoothstep(0.08, 0.02, NdotLf);
    float termWide = smoothstep(-0.12, -0.02, NdotLf) * smoothstep(0.14, 0.04, NdotLf);
    vec3 termCol = vec3(0.0);
    termCol += vec3(0.65, 0.38, 0.08) * termCore * 0.28;  // gold core
    termCol += vec3(0.50, 0.18, 0.04) * termWide * 0.14;  // orange halo
    termCol += vec3(0.30, 0.06, 0.02) * smoothstep(-0.18, -0.06, NdotLf)
             * smoothstep(-0.02, -0.10, NdotLf) * 0.08;   // deep red edge
    base += termCol;

    // ── Weather temperature overlay ──────────────────────────────────────��────
    if (u_weather_on > 0.5) {
        base = mix(base, weatherOverlay(vUv) * illumination, 0.28);
    }

    // ── Aurora ────────────────────────────────────────────────────────────────
    if (u_aurora_on > 0.5 && u_kp > 1.5) {
        float lat    = (0.5 - vUv.y) * 3.14159265;
        float lon    = (vUv.x - 0.5) * 6.28318530;
        float sinAbs = abs(sin(lat));
        float nightM = 1.0 - smoothstep(-0.20, 0.30, NdotLf);
        base += auroraColor(sinAbs, lon, u_kp) * nightM;
    }

    // ── X-ray ionospheric flash (dayside HF blackout) ─────────────────────────
    if (u_xray > 0.25 && dayFull > 0.3) {
        float flash = (u_xray - 0.25) / 0.75 * dayFull;
        base += vec3(0.3, 0.5, 1.0) * flash * 0.25;
    }

    // ── Ring current heating: equatorial nightside reddish glow ───────────────
    if (u_dst_norm > 0.08) {
        float lat    = (0.5 - vUv.y) * 3.14159265;
        float absLat = abs(lat);
        float rcZone = smoothstep(0.0, 0.20, 0.55 - absLat) * nightFull;
        base += vec3(0.85, 0.25, 0.05) * rcZone * u_dst_norm * 0.22;
    }

    // ── Southward Bz particle injection (nightside) ──────────────────────────
    if (u_bz_south > 0.15) {
        float bzGlow = (u_bz_south - 0.15) / 0.85;
        base += vec3(0.10, 0.35, 0.90) * bzGlow * nightFull * 0.10;
    }

    // ── Aerial perspective (atmospheric haze) ───────────────────────────────
    // The #1 feature that makes professional Earth renderers look photorealistic.
    // Objects near the limb appear bluer/hazier due to Rayleigh in-scattering.
    float viewDist = length(vWorldPos - cameraPosition);
    base = aerialPerspective(base, viewDist, NdotLf, L);

    // ── Filmic tone mapping ──────────────────────────────────────────────────
    // ACES-inspired S-curve: lifts shadows, compresses highlights naturally
    vec3 x = base;
    vec3 toneMapped = (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14);
    base = mix(base, clamp(toneMapped, 0.0, 1.0), 0.45);

    gl_FragColor = vec4(base, 1.0);
}`;

// ═══════════════════════════════════════════════════════════════════════════════
//  CLOUD LAYER SHADERS  (with cyclonic storm swirl)
// ═══════════════════════════════════════════════════════════════════════════════

export const CLOUD_VERT = /* glsl */`
varying vec2 vUv;
varying vec3 vWorldNormal;
varying vec3 vWorldPos;
void main() {
    vUv          = uv;
    vWorldNormal = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
    vWorldPos    = (modelMatrix * vec4(position, 1.0)).xyz;
    gl_Position  = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

export const CLOUD_FRAG = /* glsl */`
precision highp float;

uniform sampler2D u_clouds;
uniform sampler2D u_weather;       // R=temp, G=pressure, B=humidity, A=wind
uniform sampler2D u_cloud_layers;  // R=cl_low, G=cl_mid, B=cl_high, A=precip [0-1]
uniform sampler2D u_satellite;     // GOES/MODIS cloud image (grayscale brightness)
uniform vec3  u_sun_dir;
uniform float u_time;
uniform float u_weather_on;
uniform float u_satellite_on;      // blend satellite into cloud appearance
uniform float u_cam_dist;          // camera distance (Earth radii) for LOD detail

// Storm systems: .xy = UV position, .z = intensity [0-1], .w = spin (+1 CCW/-1 CW)
uniform vec4 u_storms[8];
uniform int  u_storm_count;

varying vec2 vUv;
varying vec3 vWorldNormal;
varying vec3 vWorldPos;

// ── Volumetric cloud constants ────────────────────────────────────────────────
const float R_CLOUD_BOTTOM = 1.005;   // cloud base altitude (≈ 3 km)
const float R_CLOUD_TOP    = 1.018;   // cloud top altitude (≈ 12 km)

// Aggressive step counts — the #1 GPU cost lever.
// Close (< 1.5 Re): 16 primary / 2 light
// Far   (> 3 Re):   6 primary / 1 light
const int   MAX_VOL_STEPS  = 16;
const int   MAX_LIGHT_STEPS = 2;

// ── Cyclonic swirl UV offset ──────────────────────────────────────────────────
vec2 stormSwirl(vec2 uv) {
    vec2 swirl = vec2(0.0);
    for (int i = 0; i < 8; i++) {
        if (i >= u_storm_count) break;
        vec2  center = u_storms[i].xy;
        float inten  = u_storms[i].z;
        float spin   = u_storms[i].w;

        vec2 d = uv - center;
        if (d.x >  0.5) d.x -= 1.0;
        if (d.x < -0.5) d.x += 1.0;

        float dist   = length(d);
        float radius = 0.07 + inten * 0.05;

        if (dist < radius * 2.2) {
            float falloff = smoothstep(radius * 2.2, 0.0, dist);
            float angle   = spin * inten * falloff * 2.2;
            float c = cos(angle), s = sin(angle);
            vec2 rotated = vec2(d.x * c - d.y * s, d.x * s + d.y * c);
            swirl += (rotated - d) * falloff;
        }
    }
    return swirl;
}

// ── Eye / eyewall structure for intense storms ────────────────────────────────
float stormStructure(vec2 uv) {
    float mult = 1.0;
    for (int i = 0; i < 8; i++) {
        if (i >= u_storm_count) break;
        vec2  center = u_storms[i].xy;
        float inten  = u_storms[i].z;
        if (inten < 0.35) continue;

        vec2 d = uv - center;
        if (d.x >  0.5) d.x -= 1.0;
        if (d.x < -0.5) d.x += 1.0;
        float dist = length(d);

        float eyeR   = 0.008 + inten * 0.006;
        float wallR  = eyeR * 2.2;

        float eyeMask = 1.0 - smoothstep(eyeR * 0.5, eyeR, dist);
        float wallMask = smoothstep(eyeR, eyeR * 1.2, dist)
                       * (1.0 - smoothstep(wallR, wallR * 1.5, dist));

        mult = mix(mult, 0.05, eyeMask * inten);
        mult = clamp(mult + wallMask * inten * 0.9, 0.0, 1.8);
    }
    return mult;
}

// ── Ultra-fast noise for volumetric clouds ────────────────────────────────────
// Optimized: uses a single dot-product hash (cheaper than fract-based hash13)
// and quintic interpolation for smoother gradients with fewer octaves.
float hash31(vec3 p) {
    p = fract(p * vec3(0.1031, 0.1030, 0.0973));
    p += dot(p, p.yxz + 33.33);
    return fract((p.x + p.y) * p.z);
}

float noise3D(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    // Quintic interpolation (smoother than Hermite, fewer octaves needed)
    f = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);

    // 8-corner hash (inlined, avoids redundant adds)
    float a = hash31(i);
    float b = hash31(i + vec3(1,0,0));
    float c = hash31(i + vec3(0,1,0));
    float d = hash31(i + vec3(1,1,0));
    float e = hash31(i + vec3(0,0,1));
    float g = hash31(i + vec3(1,0,1));
    float h = hash31(i + vec3(0,1,1));
    float k = hash31(i + vec3(1,1,1));

    return mix(mix(mix(a,b,f.x), mix(c,d,f.x), f.y),
               mix(mix(e,g,f.x), mix(h,k,f.x), f.y), f.z);
}

// 2-octave FBM — primary density. Quintic smoothing lets us get away with fewer octaves.
float fbm2(vec3 p) {
    return noise3D(p) * 0.62 + noise3D(p * 2.17) * 0.38;
}

// 1-octave noise — light sampling. Shadows are soft so detail is invisible.
float noise1(vec3 p) {
    return noise3D(p);
}

// ── Sphere UV from world-space point ──────────────────────────────────────────
vec2 worldToUV(vec3 p) {
    vec3 n = normalize(p);
    float u = atan(n.x, n.z) / (2.0 * 3.14159265) + 0.5;
    float v = 0.5 - asin(clamp(n.y, -1.0, 1.0)) / 3.14159265;
    return vec2(u, v);
}

// ── Cloud density: primary ray sampling (2-octave FBM) ────────────────────────
// Takes pre-computed UV to avoid atan/asin per call (the #1 perf killer).
// lodScale and driftLow are pre-computed outside the loop.
float cloudDens(vec3 pos, vec2 uv, vec2 swirl, float lodScale, vec2 drift) {
    float r = length(pos);
    float hFrac = (r - R_CLOUD_BOTTOM) * (1.0 / (R_CLOUD_TOP - R_CLOUD_BOTTOM));
    hFrac = clamp(hFrac, 0.0, 1.0);
    float vProfile = smoothstep(0.0, 0.2, hFrac) * smoothstep(1.0, 0.65, hFrac);

    float texNoise = texture2D(u_clouds, uv + drift + swirl).r;
    vec3 noisePos = normalize(pos) * lodScale + vec3(u_time * 0.008, 0.0, u_time * 0.005);
    float density = texNoise * 0.60 + fbm2(noisePos) * 0.40;

    // Weather modulation
    if (u_weather_on > 0.5) {
        vec4  cl = texture2D(u_cloud_layers, uv);
        float coverage = cl.r * smoothstep(0.5, 0.0, hFrac)
                       + cl.g * (smoothstep(0.0, 0.4, hFrac) * smoothstep(0.9, 0.5, hFrac))
                       + cl.b * smoothstep(0.5, 1.0, hFrac);
        density *= coverage;
    } else {
        float pressure = texture2D(u_weather, uv).g;
        density *= density * mix(1.0, 0.55, pressure);  // pow(d,1.3) ≈ d*d for cheap approx
    }

    return clamp(density * vProfile, 0.0, 1.0);
}

// ── Cloud density: light sampling (1-octave noise, no weather lookup) ─────────
// Self-shadowing is extremely forgiving — even 1 noise octave looks fine.
// Eliminates ALL texture reads from the light loop (massive savings).
float cloudDensLight(vec3 pos, float lodScale) {
    float r = length(pos);
    float hFrac = clamp((r - R_CLOUD_BOTTOM) * (1.0 / (R_CLOUD_TOP - R_CLOUD_BOTTOM)), 0.0, 1.0);
    float vProfile = smoothstep(0.0, 0.2, hFrac) * smoothstep(1.0, 0.65, hFrac);
    vec3 noisePos = normalize(pos) * lodScale + vec3(u_time * 0.008, 0.0, u_time * 0.005);
    return clamp(noise1(noisePos) * 0.7 * vProfile, 0.0, 1.0);
}

// ── Ray-sphere intersection ───────────────────────────────────────────────────
bool hitSphere(vec3 o, vec3 d, float r, out float tN, out float tF) {
    float b = dot(o, d);
    float c = dot(o, o) - r * r;
    float disc = b * b - c;
    if (disc < 0.0) return false;
    float sq = sqrt(disc);
    tN = -b - sq;
    tF = -b + sq;
    return tF >= 0.0;
}

void main() {
    vec3  N     = normalize(vWorldNormal);
    float NdotL = dot(N, u_sun_dir);
    vec3  L     = normalize(u_sun_dir);

    // ═══ FAST PATH: when zoomed out (> 3.5 Re), use cheap 2D cloud rendering ════
    // Skips volumetric ray march entirely — 100× faster for medium/distant views.
    // Enhanced with simple self-shadowing approximation for visual quality.
    if (u_cam_dist > 3.5) {
        vec2 driftLow = vec2(u_time * 0.000050, u_time * 0.000007);
        float texNoise = texture2D(u_clouds, vUv + driftLow).r;
        float pressure = texture2D(u_weather, vUv).g;
        float coverage = texNoise * mix(1.0, 0.55, pressure);

        // Day/night shading with terminator warmth
        float dayMix = smoothstep(-0.12, 0.20, NdotL);
        vec3 dayCol  = mix(vec3(0.82, 0.85, 0.92), vec3(0.97, 0.98, 1.00), dayMix);
        vec3 nightC  = vec3(0.08, 0.09, 0.14);
        vec3 col = mix(nightC, dayCol, dayMix);

        // Simple self-shadow: thicker clouds are darker on the underside
        float shadow = 1.0 - coverage * 0.25;
        col *= shadow;

        // Terminator golden tint
        float termZ = smoothstep(-0.08, 0.0, NdotL) * smoothstep(0.18, 0.04, NdotL);
        col = mix(col, vec3(0.92, 0.68, 0.25), termZ * 0.30);

        float alpha = smoothstep(0.25, 0.55, coverage) * 0.85;
        gl_FragColor = vec4(col, alpha);
        return;
    }

    // Compute cyclonic UV swirl from active storm systems
    vec2 swirl = (u_storm_count > 0) ? stormSwirl(vUv) : vec2(0.0);

    // ── Volumetric ray march through cloud slab ───────────────────────────────
    vec3 rayOrigin = cameraPosition;
    vec3 rayDir    = normalize(vWorldPos - cameraPosition);

    // Intersect ray with cloud shell (inner + outer spheres)
    float tNear, tFar, tInner, tInnerFar;
    bool hitOuter = hitSphere(rayOrigin, rayDir, R_CLOUD_TOP, tNear, tFar);
    if (!hitOuter) discard;

    tNear = max(tNear, 0.0);

    // Clip to inner sphere (don't march below cloud base)
    if (hitSphere(rayOrigin, rayDir, R_CLOUD_BOTTOM, tInner, tInnerFar)) {
        if (tInner > 0.0) tFar = min(tFar, tInner);  // camera outside: stop at inner
        else tNear = max(tNear, tInnerFar);            // camera inside inner sphere
    }

    if (tNear >= tFar) discard;

    // ── Pre-compute everything possible outside the loop ─────────────────────
    float distLOD = clamp((u_cam_dist - 1.2) / 3.0, 0.0, 1.0);
    float fVolSteps   = float(MAX_VOL_STEPS) - distLOD * 10.0;  // 16 close → 6 far
    float fLightSteps = float(MAX_LIGHT_STEPS) - distLOD * 1.0; // 2 close → 1 far
    float stepLen = (tFar - tNear) / fVolSteps;

    // LOD noise scale (computed once, not per sample)
    float lodScale = mix(120.0, 42.0, clamp((u_cam_dist - 1.02) / 2.0, 0.0, 1.0));
    vec2 drift = vec2(u_time * 0.000050, u_time * 0.000007);

    float transmittance = 1.0;
    vec3  scatteredLight = vec3(0.0);

    // All lighting constants (computed once)
    float dayMix     = smoothstep(-0.12, 0.20, NdotL);
    vec3  cloudBright = mix(vec3(0.82, 0.85, 0.92), vec3(0.97, 0.98, 1.00), dayMix);
    vec3  cloudDark   = vec3(0.32, 0.35, 0.42);
    vec3  nightCol    = vec3(0.12, 0.14, 0.22);
    float cosTheta = dot(rayDir, L);
    // Simplified single-lobe HG (cheaper than dual-lobe, visually close)
    float hgPhase = 0.25 / max(0.01, 1.0 + 2.0 * (1.0 - cosTheta));
    float termZone = smoothstep(-0.10, 0.0, NdotL) * smoothstep(0.22, 0.06, NdotL);
    vec3 sunsetCol = vec3(0.95, 0.72, 0.28);
    float sigmaA = 18.0;

    // Skip light march entirely on deep nightside (no sunlight to scatter)
    bool doLightMarch = dayMix > 0.01;

    // UV at ray entry point (interpolate along ray instead of atan/asin per step)
    vec2 uvStart = worldToUV(rayOrigin + rayDir * tNear);
    vec2 uvEnd   = worldToUV(rayOrigin + rayDir * tFar);
    // Handle antimeridian wrap
    if (abs(uvEnd.x - uvStart.x) > 0.5) {
        if (uvEnd.x < uvStart.x) uvEnd.x += 1.0;
        else uvStart.x += 1.0;
    }

    for (int i = 0; i < MAX_VOL_STEPS; i++) {
        if (float(i) >= fVolSteps) break;

        float frac = (float(i) + 0.5) / fVolSteps;
        float t = tNear + frac * (tFar - tNear);
        vec3  samplePos = rayOrigin + rayDir * t;

        // Interpolate UV along ray (avoids atan+asin per step!)
        vec2 uv = mix(uvStart, uvEnd, frac);
        uv.x = fract(uv.x);  // wrap

        float dens = cloudDens(samplePos, uv, swirl, lodScale, drift);
        if (dens < 0.02) continue;

        // ── Light march (skip on nightside — huge savings) ───────────────────
        float lightTransmit = 1.0;
        if (doLightMarch) {
            float lightOptDepth = 0.0;
            float lStepLen = max((R_CLOUD_TOP - length(samplePos)) / fLightSteps, 0.001);
            for (int j = 0; j < MAX_LIGHT_STEPS; j++) {
                if (float(j) >= fLightSteps) break;
                vec3 lPos = samplePos + L * (float(j) + 0.5) * lStepLen;
                float lr = length(lPos);
                if (lr > R_CLOUD_TOP || lr < R_CLOUD_BOTTOM) break;
                lightOptDepth += cloudDensLight(lPos, lodScale) * lStepLen;
            }
            lightTransmit = exp(-lightOptDepth * sigmaA * 0.6);
        }

        // Colour
        vec3 sampleCol = mix(cloudDark, cloudBright, lightTransmit * dayMix);
        sampleCol = mix(nightCol, sampleCol, dayMix);
        sampleCol += cloudBright * hgPhase * lightTransmit * dayMix * 0.15;
        sampleCol = mix(sampleCol, sunsetCol, termZone * 0.30);

        // Accumulate (Beer's law)
        float sampleAtten = exp(-dens * stepLen * sigmaA);
        scatteredLight += transmittance * (sampleCol * (1.0 - sampleAtten));
        transmittance  *= sampleAtten;

        if (transmittance < 0.01) break;
    }

    float alpha = 1.0 - transmittance;
    alpha = clamp(alpha, 0.0, 0.96);

    // Add a subtle warm glow under high-precipitation regions (reflected city light on rain)
    if (u_weather_on > 0.5 && alpha > 0.1) {
        vec4 clData = texture2D(u_cloud_layers, vUv);
        float precip = clData.a;
        float nightFade = 1.0 - smoothstep(-0.10, 0.15, NdotL);
        scatteredLight += vec3(0.12, 0.08, 0.04) * precip * nightFade * alpha * 0.3;
    }

    gl_FragColor = vec4(scatteredLight / max(alpha, 0.01), alpha);
}`;

// ═══════════════════════════════════════════════════════════════════════════════
//  ATMOSPHERE RIM SHADERS  (shared, used by earth.html + space-weather-globe)
// ═══════════════════════════════════════════════════════════════════════════════

export const ATM_VERT = /* glsl */`
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
void main() {
    vWorldNormal = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
    vWorldPos    = (modelMatrix * vec4(position, 1.0)).xyz;
    gl_Position  = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

export const ATM_FRAG = /* glsl */`
precision highp float;

uniform vec3  u_sun_dir;
uniform float u_time;
uniform float u_xray;      // X-ray intensity normalized [0,1] for D-layer blackout
uniform float u_kp;        // Kp index for aurora airglow intensity

varying vec3 vWorldPos;
varying vec3 vWorldNormal;

// ── Physical constants (Earth-scale, normalised to R_earth = 1.0) ─────────
const float R_PLANET   = 1.0;
const float R_ATM      = 1.045;          // atmosphere top (≈ 60 km scaled)
const float H_RAYLEIGH = 0.012;          // Rayleigh scale height (~8 km / 6371 km)
const float H_MIE      = 0.004;          // Mie scale height (~1.2 km)
const float H_OZONE    = 0.0055;         // Ozone scale height (~3.5 km)
const int   NUM_STEPS  = 16;             // primary ray march steps (16 is visually identical to 24)
const int   NUM_LSTEPS = 4;              // light ray march steps (4 is sufficient for smooth gradient)

// Rayleigh scattering coefficients at sea level (λ = 680, 550, 440 nm)
const vec3  BETA_R0 = vec3(5.8e-3, 13.5e-3, 33.1e-3);
// Mie scattering coefficient (wavelength-independent)
const float BETA_M0 = 3.0e-3;
// Ozone absorption coefficients (Chappuis band: peaks ~600nm, absorbs red/green)
// This is what gives Earth its deep blue colour from space — ozone absorbs in the visible
const vec3  BETA_OZONE = vec3(3.426e-3, 8.298e-3, 0.356e-3);  // absorption cross-sections
const float OZONE_PEAK = 0.004;          // ~25 km altitude (ozone layer peak)
const float OZONE_WIDTH = 0.0047;        // ~30 km layer width

// Mie preferred scattering direction (Henyey-Greenstein g)
const float MIE_G   = 0.76;

// Airglow emission altitudes (normalized to R_earth)
const float H_GREEN_PEAK = 0.015;    // OI 557.7nm peak at ~97 km
const float H_GREEN_W    = 0.005;    // ~30 km layer width
const float H_RED_PEAK   = 0.038;    // OI 630.0nm peak at ~250 km
const float H_RED_W      = 0.018;    // ~120 km layer width
const float H_PURPLE_PEAK = 0.013;   // N₂⁺ 391.4nm (1st negative band) at ~85 km
const float H_PURPLE_W    = 0.004;   // ~25 km width

// D-layer absorption altitude
const float H_DLAYER     = 0.012;    // ~80 km (D-layer peak)
const float H_DLAYER_W   = 0.006;    // ~40 km width

// ── Ray-sphere intersection (origin, dir, radius) → (t_near, t_far) ──────
bool raySphere(vec3 o, vec3 d, float r, out float tN, out float tF) {
    float b = dot(o, d);
    float c = dot(o, o) - r * r;
    float disc = b * b - c;
    if (disc < 0.0) return false;
    float sq = sqrt(disc);
    tN = -b - sq;
    tF = -b + sq;
    return tF >= 0.0;
}

// ── Phase functions ───────────────────────────────────────────────────────
float phaseR(float cosTheta) {
    return (3.0 / (16.0 * 3.14159265)) * (1.0 + cosTheta * cosTheta);
}
float phaseM(float cosTheta) {
    float g2 = MIE_G * MIE_G;
    float num = (1.0 - g2);
    float den = pow(1.0 + g2 - 2.0 * MIE_G * cosTheta, 1.5);
    return (3.0 / (8.0 * 3.14159265)) * num / den;
}

// ── Cornette-Shanks phase function (improved Mie for forward peak) ────────
float phaseMCS(float cosTheta) {
    float g2 = MIE_G * MIE_G;
    float num = 1.5 * (1.0 - g2) * (1.0 + cosTheta * cosTheta);
    float den = (2.0 + g2) * pow(1.0 + g2 - 2.0 * MIE_G * cosTheta, 1.5);
    return num / (4.0 * 3.14159265 * den);
}

// ── Ozone density profile (Chapman layer) ─────────────────────────────────
float ozoneDensity(float h) {
    float d = (h - OZONE_PEAK) / OZONE_WIDTH;
    return exp(-0.5 * d * d);
}

// ── Airglow emission profile ──────────────────────────────────────────────
// OI 557.7 nm (green line): chemiluminescence from O + O + M → O₂* + M
// OI 630.0 nm (red line): dissociative recombination of O₂⁺
// N₂⁺ 391.4 nm (purple): first negative band at ~85 km
vec3 airglowEmission(float h, float NdotL, float kp, float t) {
    float nightMask = smoothstep(0.15, -0.10, NdotL);

    // Green OI 557.7nm
    float greenLayer = exp(-pow((h - H_GREEN_PEAK) / H_GREEN_W, 2.0));
    float greenPulse = 0.85 + 0.15 * sin(t * 0.42);
    vec3 greenCol = vec3(0.15, 0.92, 0.25) * greenLayer * 0.14 * greenPulse;

    // Red OI 630.0nm — enhanced during geomagnetic activity
    float redLayer = exp(-pow((h - H_RED_PEAK) / H_RED_W, 2.0));
    float kpBoost = 1.0 + clamp(kp - 2.0, 0.0, 7.0) * 0.22;
    vec3 redCol = vec3(0.85, 0.18, 0.08) * redLayer * 0.08 * kpBoost;

    // Purple N₂⁺ — faint violet glow at lower mesosphere, enhanced by particle precipitation
    float purpleLayer = exp(-pow((h - H_PURPLE_PEAK) / H_PURPLE_W, 2.0));
    float purpleBoost = 1.0 + clamp(kp - 4.0, 0.0, 5.0) * 0.3;
    vec3 purpleCol = vec3(0.55, 0.15, 0.90) * purpleLayer * 0.04 * purpleBoost;

    return (greenCol + redCol + purpleCol) * nightMask;
}

// ── D-layer radio blackout glow ───────────────────────────────────────────
vec3 dLayerBlackout(float h, float NdotL, float xray) {
    if (xray < 0.15) return vec3(0.0);
    float dProfile = exp(-pow((h - H_DLAYER) / H_DLAYER_W, 2.0));
    float dayMask = smoothstep(-0.05, 0.25, NdotL);
    float intensity = smoothstep(0.15, 1.0, xray);
    vec3 mColor = vec3(1.0, 0.65, 0.15);
    vec3 xColor = vec3(1.0, 0.25, 0.05);
    vec3 col = mix(mColor, xColor, smoothstep(0.4, 0.85, xray));
    return col * dProfile * dayMask * intensity * 0.18;
}

void main() {
    vec3 N = normalize(vWorldNormal);
    vec3 V = normalize(cameraPosition - vWorldPos);
    vec3 L = normalize(u_sun_dir);

    vec3 camPos = cameraPosition;
    vec3 rayDir = normalize(vWorldPos - cameraPosition);

    // Intersect view ray with atmosphere shell
    float tN, tF;
    if (!raySphere(camPos, rayDir, R_ATM, tN, tF)) discard;
    tN = max(tN, 0.0);

    // If ray hits planet surface, clip far intersection
    float tPN, tPF;
    if (raySphere(camPos, rayDir, R_PLANET, tPN, tPF) && tPN > 0.0) {
        tF = min(tF, tPN);
    }

    float segLen = (tF - tN) / float(NUM_STEPS);

    // Accumulate Rayleigh + Mie + ozone in-scattering + emission layers
    vec3  sumR = vec3(0.0);
    vec3  sumM = vec3(0.0);
    vec3  sumEmission = vec3(0.0);
    float optDepthR = 0.0;
    float optDepthM = 0.0;
    float optDepthO = 0.0;

    for (int i = 0; i < NUM_STEPS; i++) {
        float tMid = tN + (float(i) + 0.5) * segLen;
        vec3  samplePos = camPos + rayDir * tMid;
        float h = length(samplePos) - R_PLANET;

        // Skip samples below planet or above atmosphere
        if (h < 0.0 || h > R_ATM - R_PLANET) continue;

        float densR = exp(-h / H_RAYLEIGH) * segLen;
        float densM = exp(-h / H_MIE)      * segLen;
        float densO = ozoneDensity(h) * segLen;
        optDepthR += densR;
        optDepthM += densM;
        optDepthO += densO;

        // Light ray from sample to sun (compact: combine Rayleigh+Mie+Ozone in one pass)
        float ltN, ltF;
        raySphere(samplePos, L, R_ATM, ltN, ltF);
        float lSegLen = ltF / float(NUM_LSTEPS);

        float lOptR = 0.0, lOptM = 0.0, lOptO = 0.0;
        bool  shadow = false;
        for (int j = 0; j < NUM_LSTEPS; j++) {
            vec3  lPos = samplePos + L * ((float(j) + 0.5) * lSegLen);
            float lH   = length(lPos) - R_PLANET;
            if (lH < 0.0) { shadow = true; break; }
            // Combined exp for Rayleigh+Mie is cheaper than separate
            lOptR += exp(-lH / H_RAYLEIGH) * lSegLen;
            lOptM += exp(-lH / H_MIE)      * lSegLen;
            lOptO += ozoneDensity(lH) * lSegLen;
        }
        if (shadow) continue;

        vec3 tau = BETA_R0 * (optDepthR + lOptR)
                 + BETA_M0 * (optDepthM + lOptM)
                 + BETA_OZONE * (optDepthO + lOptO);
        vec3 atten = exp(-tau);

        sumR += densR * atten;
        sumM += densM * atten;

        // Emission layers (only compute if Kp or xray is active — saves work in quiet conditions)
        float sampleNdotL = dot(normalize(samplePos), L);
        if (u_kp > 1.0 || u_xray > 0.15) {
            sumEmission += airglowEmission(h, sampleNdotL, u_kp, u_time) * segLen * 10.0;
            sumEmission += dLayerBlackout(h, sampleNdotL, u_xray) * segLen * 10.0;
        }

        // Early exit: if optical depth is very high, remaining contributions are negligible
        if (optDepthR > 8.0) break;
    }

    float cosTheta = dot(rayDir, L);

    // Use Cornette-Shanks for Mie (better forward scattering peak for sun glare)
    vec3 scatter = sumR * BETA_R0 * phaseR(cosTheta)
                 + sumM * BETA_M0 * phaseMCS(cosTheta);

    // Combine scattering + emission
    scatter += sumEmission;

    // Multi-scatter approximation: add a fraction of total Rayleigh as ambient
    // to simulate photons that scatter 2+ times (fills in dark regions)
    float multiScatterFactor = 0.06;
    scatter += sumR * BETA_R0 * multiScatterFactor;

    // Exposure tone mapping (tuned for sunrise/sunset dynamic range)
    scatter = 1.0 - exp(-scatter * 32.0);

    // Limb-based alpha: stronger at the edges (grazing angle)
    float rim = 1.0 - max(dot(V, N), 0.0);
    float alpha = rim * rim * 0.92;

    // Boost alpha where scattering or emission is strong
    float lum = dot(scatter, vec3(0.299, 0.587, 0.114));
    alpha = max(alpha, lum * 0.88);
    alpha = clamp(alpha, 0.0, 0.94);

    gl_FragColor = vec4(scatter, alpha);
}`;

// ═══════════════════════════════════════════════════════════════════════════════
//  UNIFORM FACTORIES
// ═══════════════════════════════════════════════════════════════════════════════

/** Default Earth surface uniforms.  All toggles default to conservative values. */
export function createEarthUniforms(sunDir = new THREE.Vector3(1, 0, 0)) {
    const blackFallback = _blackTex();
    return {
        u_day:            { value: blackFallback },
        u_night:          { value: blackFallback },
        u_specular:       { value: blackFallback },
        u_weather:        { value: _blackTex() },
        u_bump:           { value: _blackTex() },
        u_hires:          { value: _blackTex() },
        u_hires_on:       { value: 0 },
        u_hires_bounds:   { value: new THREE.Vector4(-180, -90, 180, 90) },
        u_sun_dir:        { value: sunDir.clone() },
        u_time:           { value: 0 },
        u_kp:             { value: 0 },
        u_xray:           { value: 0 },
        u_city_lights:    { value: 1 },
        u_aurora_on:      { value: 1 },
        u_weather_on:     { value: 0 },
        u_aurora_power:   { value: 0 },
        u_bz_south:       { value: 0 },
        u_dst_norm:       { value: 0 },
        u_bump_strength:  { value: 1.0 },
    };
}

/** Default cloud layer uniforms. */
export function createCloudUniforms(sunDir = new THREE.Vector3(1, 0, 0)) {
    return {
        u_clouds:        { value: _grayTex() },
        u_weather:       { value: _blackTex() },
        u_cloud_layers:  { value: _blackTex() },  // real cloud fraction + precip
        u_satellite:     { value: _grayTex()  },  // GOES/MODIS satellite imagery
        u_sun_dir:       { value: sunDir.clone() },
        u_time:          { value: 0 },
        u_weather_on:    { value: 0 },
        u_satellite_on:  { value: 0 },            // off until satellite texture arrives
        u_cam_dist:      { value: 3.0 },          // camera distance for LOD detail scaling
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
 * @param {object} cloudU - uniforms object from createCloudUniforms() (or null to skip clouds.png)
 * @returns {Promise<void>}
 */
export function loadEarthTextures(earthU, cloudU = null, renderer = null) {
    const loader = new THREE.TextureLoader();

    // Detect max anisotropy from renderer (or use sensible default)
    const maxAniso = renderer
        ? renderer.capabilities.getMaxAnisotropy()
        : 16;

    const loadTex = (url, onLoad, fallbackFn) => new Promise(resolve => {
        loader.load(url,
            tex => {
                tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
                // High-quality filtering: trilinear + max anisotropy
                tex.minFilter = THREE.LinearMipmapLinearFilter;
                tex.magFilter = THREE.LinearFilter;
                tex.anisotropy = maxAniso;
                tex.generateMipmaps = true;
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

        loadTex(EARTH_TEXTURES.bump, tex => {
            earthU.u_bump.value = tex;
        }, _blackTex),
    ];

    if (cloudU) {
        promises.push(
            loadTex(EARTH_TEXTURES.clouds, tex => {
                cloudU.u_clouds.value = tex;
            }, _grayTex)
        );
    }

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
            extensions: { derivatives: true },
        });
        this.earthMesh = new THREE.Mesh(
            new THREE.SphereGeometry(radius, segments, segments),
            earthMat
        );
        parent.add(this.earthMesh);

        // Cloud shell — mesh at cloud-top altitude (volumetric shader raymarches down)
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
                new THREE.SphereGeometry(radius * 1.018, Math.round(segments * 0.75), Math.round(segments * 0.75)),
                cloudMat
            );
            parent.add(this.cloudMesh);
        }

        // Atmosphere rim glow (with airglow + D-layer blackout)
        this._atmU = null;
        if (atmosphere) {
            this._atmU = {
                u_sun_dir: this.earthU.u_sun_dir,
                u_time:    { value: 0 },
                u_xray:    { value: 0 },
                u_kp:      { value: 0 },
            };
            const atmMat = new THREE.ShaderMaterial({
                vertexShader: ATM_VERT, fragmentShader: ATM_FRAG,
                uniforms: this._atmU, transparent: true, depthWrite: false,
                side: THREE.BackSide, blending: THREE.AdditiveBlending,
            });
            this._atmMesh = new THREE.Mesh(
                new THREE.SphereGeometry(radius * 1.026, Math.round(segments * 0.5), Math.round(segments * 0.5)),
                atmMat
            );
            parent.add(this._atmMesh);
        }
    }

    /** Load textures from CDN. Pass renderer for max anisotropy detection. */
    loadTextures(renderer = null) {
        return loadEarthTextures(this.earthU, this.cloudU, renderer);
    }

    /** Call every frame with elapsed time in seconds and optional camera distance. */
    update(t, camDist = 3.0) {
        this.earthU.u_time.value = t;
        if (this.cloudU) {
            this.cloudU.u_time.value = t;
            this.cloudU.u_cam_dist.value = camDist;
        }
        if (this._atmU) this._atmU.u_time.value = t;
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
        // Push to atmosphere shader for airglow + D-layer blackout
        if (this._atmU) {
            this._atmU.u_kp.value   = kp;
            this._atmU.u_xray.value = xray;
        }
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
            // UV coordinate from lat/lon (Three.js SphereGeometry convention)
            const u = (s.lon + 180) / 360;
            const v = (90 - s.lat) / 180;
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
