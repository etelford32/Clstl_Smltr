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

// ── Texture CDNs — high-res NASA-derived where available ─────────────────────
// Primary: Solar System Scope (4K equirectangular, CC BY 4.0 educational)
// Fallback: three-globe CDN (~2K, version-pinned)
const _CDN     = 'https://unpkg.com/three-globe@2.31.0/example/img/';
const _SSS     = 'https://upload.wikimedia.org/wikipedia/commons/thumb/';
export const EARTH_TEXTURES = {
    day:    _SSS + '2/23/Blue_Marble_2002.png/2560px-Blue_Marble_2002.png',
    night:  _SSS + 'b/ba/The_earth_at_night.jpg/2560px-The_earth_at_night.jpg',
    ocean:  _CDN + 'earth-water.png',
    clouds: _CDN + 'clouds.png',
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

// ── Ocean wave normal micro-perturbation ─────────────────────────────────────
// Multi-scale Gerstner-inspired waves for realistic sun-glint sparkle
vec2 oceanWaveNormal(vec2 uv, float t) {
    // Large swell (wind-driven, ~200m wavelength)
    float s1 = sin(uv.x * 320.0 + t * 0.8) * cos(uv.y * 280.0 + t * 0.6);
    // Medium chop (~50m)
    float s2 = sin(uv.x * 510.0 - t * 1.1) * cos(uv.y * 440.0 - t * 0.9);
    // Capillary ripples (~5m) — visible at close zoom
    float s3 = sin(uv.x * 1200.0 + uv.y * 900.0 + t * 2.2) * 0.3;
    float s4 = sin(uv.x * 190.0 + uv.y * 220.0 + t * 0.5);
    return vec2(s1 + s2 * 0.5 + s3, s4 + s2 * 0.5 + s3) * 0.0012;
}

// ── Aerial perspective (atmospheric haze with distance) ──────────────────────
// Objects further from camera appear bluer/hazier due to in-scattering.
// This is the #1 feature that makes professional Earth renderers look real.
vec3 aerialPerspective(vec3 surfaceCol, float dist, float NdotL, vec3 L) {
    // Haze colour: blue on dayside (Rayleigh), dark blue-grey on nightside
    float day = smoothstep(-0.05, 0.15, NdotL);
    vec3 hazeCol = mix(vec3(0.015, 0.02, 0.05), vec3(0.22, 0.38, 0.65), day);

    // Haze density increases with view distance (exponential fog)
    // At 1.0 Earth radius distance, ~0% haze. At 3.0 RE, ~30%. At limb, ~60%.
    float hazeDensity = 1.0 - exp(-max(0.0, dist - 0.8) * 0.6);
    hazeDensity *= 0.55;  // cap at 55% so surface is always visible

    // Sun-forward scattering brightens haze near the terminator
    float forwardScatter = pow(max(dot(normalize(cameraPosition - vec3(0.0)), L), 0.0), 6.0);
    hazeCol += vec3(0.15, 0.10, 0.04) * forwardScatter * day * 0.3;

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
        // Convert UV to geographic coordinates
        float lon = (vUv.x - 0.5) * 360.0;
        float lat = (0.5 - vUv.y) * 180.0;
        // Check if this fragment is within the loaded tile bounds
        vec4 b = u_hires_bounds;
        float inBounds = step(b.x, lon) * step(lon, b.z) * step(b.y, lat) * step(lat, b.w);
        if (inBounds > 0.5) {
            // Map geographic coords to hi-res texture UV
            vec2 hiUv = vec2(
                (lon - b.x) / (b.z - b.x),
                1.0 - (lat - b.y) / (b.w - b.y)
            );
            vec3 hiCol = texture2D(u_hires, hiUv).rgb;
            // Only blend where the tile has actual data (not black/transparent)
            float hiLum = dot(hiCol, vec3(0.299, 0.587, 0.114));
            float hiBlend = smoothstep(0.02, 0.08, hiLum) * inBounds;
            // Feather at tile edges to avoid hard seams
            float edgeFade = smoothstep(0.0, 0.05, hiUv.x) * smoothstep(1.0, 0.95, hiUv.x)
                           * smoothstep(0.0, 0.05, hiUv.y) * smoothstep(1.0, 0.95, hiUv.y);
            dayCol = mix(dayCol, hiCol, hiBlend * edgeFade * 0.85);
        }
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

    // ── Ocean specular (Fresnel + GGX + wave perturbation) ────────────────────
    if (oceanMsk > 0.3) {
        vec3  H2     = normalize(L + V);
        float NdotV  = max(dot(N, V), 0.001);
        float NdotH  = max(dot(N, H2), 0.0);
        float fresnel = 0.02 + 0.98 * pow(1.0 - NdotV, 5.0);
        float rough2 = 0.06 * 0.06;
        float denom2 = NdotH * NdotH * (rough2 - 1.0) + 1.0;
        float D      = rough2 / (3.14159265 * denom2 * denom2);
        float spec   = D * fresnel * oceanMsk * dayFull * 0.55;
        base += vec3(spec * 0.80, spec * 0.90, spec);

        // Ocean Fresnel reflection: at grazing angles, ocean reflects sky colour
        float oceanFresnel = pow(1.0 - NdotV, 4.0) * oceanMsk * dayFull;
        base += vec3(0.10, 0.18, 0.30) * oceanFresnel * 0.20;

        // Night ocean: faint moonlight-like reflection (indirect)
        float nightOcean = nightFull * oceanMsk;
        base += vec3(0.003, 0.005, 0.012) * nightOcean;
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
const int   VOL_STEPS      = 20;      // primary ray march steps (eliminates banding)
const int   LIGHT_STEPS    = 6;       // sun-direction steps for self-shadowing

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

// ── Hash-based noise for volumetric detail ────────────────────────────────────
float hash13(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.zyx + 31.32);
    return fract((p.x + p.y) * p.z);
}

// Simple 3D value noise (smooth)
float noise3D(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);

    float n000 = hash13(i);
    float n100 = hash13(i + vec3(1,0,0));
    float n010 = hash13(i + vec3(0,1,0));
    float n110 = hash13(i + vec3(1,1,0));
    float n001 = hash13(i + vec3(0,0,1));
    float n101 = hash13(i + vec3(1,0,1));
    float n011 = hash13(i + vec3(0,1,1));
    float n111 = hash13(i + vec3(1,1,1));

    float n00 = mix(n000, n100, f.x);
    float n01 = mix(n001, n101, f.x);
    float n10 = mix(n010, n110, f.x);
    float n11 = mix(n011, n111, f.x);

    float n0 = mix(n00, n10, f.y);
    float n1 = mix(n01, n11, f.y);

    return mix(n0, n1, f.z);
}

// Fractal Brownian Motion — 6 octaves for detailed close-up clouds
float fbm3(vec3 p) {
    float v   = 0.0;
    float amp = 0.50;
    float frq = 1.0;
    for (int i = 0; i < 6; i++) {
        v   += noise3D(p * frq) * amp;
        amp *= 0.48;
        frq *= 2.13;
    }
    return v;
}

// ── Sphere UV from world-space point ──────────────────────────────────────────
vec2 worldToUV(vec3 p) {
    vec3 n = normalize(p);
    float u = atan(n.x, n.z) / (2.0 * 3.14159265) + 0.5;
    float v = 0.5 - asin(clamp(n.y, -1.0, 1.0)) / 3.14159265;
    return vec2(u, v);
}

// ── Sample cloud density at a 3D world-space point ────────────────────────────
float cloudDensity(vec3 pos, vec2 swirl) {
    float r = length(pos);
    // Height fraction within cloud slab [0,1]
    float hFrac = clamp((r - R_CLOUD_BOTTOM) / (R_CLOUD_TOP - R_CLOUD_BOTTOM), 0.0, 1.0);

    // Vertical profile: denser in the middle, tapering at edges
    float vProfile = smoothstep(0.0, 0.2, hFrac) * smoothstep(1.0, 0.65, hFrac);

    // UV for texture lookups
    vec2 uv = worldToUV(pos);

    // Three-layer drift (matches original)
    vec2 driftLow  = vec2(u_time * 0.000050, u_time * 0.000007);
    vec2 driftHigh = vec2(u_time * 0.000100, u_time * 0.000014);

    // Cloud noise from texture + 3D procedural detail
    float texNoise = texture2D(u_clouds, uv + driftLow + swirl).r;

    // 3D volumetric detail noise — frequency scales with camera distance for LOD
    // Close-up: higher frequency reveals finer cloud edges and billows
    float lodScale = mix(120.0, 42.0, clamp((u_cam_dist - 1.02) / 2.0, 0.0, 1.0));
    vec3 noisePos = normalize(pos) * lodScale + vec3(u_time * 0.008, 0.0, u_time * 0.005);
    float detailNoise = fbm3(noisePos);

    // Combine: texture gives large-scale cloud patterns, 3D noise gives volumetric edges
    float density = texNoise * 0.7 + detailNoise * 0.3;

    // Apply weather data or pressure-based modulation
    float baseDensity;
    float precipOut = 0.0;

    if (u_weather_on > 0.5) {
        vec4  cl     = texture2D(u_cloud_layers, uv);
        float clLow  = cl.r;
        float clMid  = cl.g;
        float clHigh = cl.b;
        precipOut     = cl.a;

        // Layer blending based on altitude within cloud slab
        float lowW  = smoothstep(0.5, 0.0, hFrac);   // bottom half
        float midW  = smoothstep(0.0, 0.4, hFrac) * smoothstep(0.9, 0.5, hFrac); // middle
        float highW = smoothstep(0.5, 1.0, hFrac);    // top

        float coverage = clLow * lowW + clMid * midW + clHigh * highW;
        baseDensity = density * coverage;
    } else {
        float pressure = texture2D(u_weather, uv).g;
        float humidity = texture2D(u_weather, uv).b;
        float clear    = mix(1.0, 0.55, pressure);
        float boost    = max(0.0, 0.45 - pressure) * 2.0;
        baseDensity = pow(density, 1.3) * (clear + boost) * (0.7 + humidity * 0.5);
    }

    // Satellite data blending
    if (u_satellite_on > 0.5) {
        float satCloud = texture2D(u_satellite, uv).r;
        baseDensity = mix(baseDensity, satCloud * 0.9, 0.45);
    }

    // Apply vertical profile and storm structure
    baseDensity *= vProfile;

    if (u_storm_count > 0) {
        baseDensity *= stormStructure(uv);
    }

    return clamp(baseDensity, 0.0, 1.0);
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

    float stepLen = (tFar - tNear) / float(VOL_STEPS);

    // Accumulated transmittance and in-scattered light
    float transmittance = 1.0;
    vec3  scatteredLight = vec3(0.0);
    float totalDensity   = 0.0;

    // Cloud colours
    float dayMix    = smoothstep(-0.12, 0.20, NdotL);
    vec3  cloudBright = mix(vec3(0.82, 0.85, 0.92), vec3(0.97, 0.98, 1.00), dayMix);
    vec3  cloudDark   = vec3(0.32, 0.35, 0.42);  // self-shadowed / thick cloud underbelly
    vec3  nightCol    = vec3(0.12, 0.14, 0.22);

    // Beer's law absorption coefficient
    float sigmaA = 18.0;

    for (int i = 0; i < VOL_STEPS; i++) {
        float t = tNear + (float(i) + 0.5) * stepLen;
        vec3  samplePos = rayOrigin + rayDir * t;

        float dens = cloudDensity(samplePos, swirl);
        if (dens < 0.01) continue;

        totalDensity += dens * stepLen;

        // ── Self-shadowing: march toward sun to estimate optical depth ────────
        float lightOptDepth = 0.0;
        float lStepLen = (R_CLOUD_TOP - length(samplePos)) / float(LIGHT_STEPS);
        lStepLen = max(lStepLen, 0.001);

        for (int j = 0; j < LIGHT_STEPS; j++) {
            vec3 lPos = samplePos + L * (float(j) + 0.5) * lStepLen;
            float lr = length(lPos);
            if (lr > R_CLOUD_TOP) break;
            if (lr < R_CLOUD_BOTTOM) { lightOptDepth += 2.0; break; }
            lightOptDepth += cloudDensity(lPos, swirl) * lStepLen;
        }

        // Light reaching this sample (Beer's law)
        float lightTransmit = exp(-lightOptDepth * sigmaA * 0.6);

        // Cloud color: bright where sunlit, dark in shadow
        vec3 sampleCol = mix(cloudDark, cloudBright, lightTransmit * dayMix);
        sampleCol = mix(nightCol, sampleCol, dayMix);

        // Silver-lining effect at cloud edges (forward scattering)
        float cosTheta = dot(rayDir, L);
        float hg = 0.25 / (1.0 + 2.0 * (1.0 - cosTheta));  // simplified HG
        sampleCol += cloudBright * hg * lightTransmit * dayMix * 0.4;

        // Warm golden tint at terminator
        float termZone = smoothstep(-0.10, 0.0, NdotL) * smoothstep(0.22, 0.06, NdotL);
        sampleCol = mix(sampleCol, vec3(0.95, 0.72, 0.28), termZone * 0.30);

        // Accumulate using beer's law
        float sampleAtten = exp(-dens * stepLen * sigmaA);
        vec3 integScatter = sampleCol * (1.0 - sampleAtten);
        scatteredLight += transmittance * integScatter;
        transmittance  *= sampleAtten;

        // Early exit if nearly opaque
        if (transmittance < 0.01) break;
    }

    float alpha = 1.0 - transmittance;
    alpha = clamp(alpha, 0.0, 0.95);

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
const int   NUM_STEPS  = 20;             // primary ray march steps (smooth gradient)
const int   NUM_LSTEPS = 8;              // light (sun) ray march steps

// Rayleigh scattering coefficients at sea level (λ = 680, 550, 440 nm)
const vec3  BETA_R0 = vec3(5.8e-3, 13.5e-3, 33.1e-3);
// Mie scattering coefficient (wavelength-independent)
const float BETA_M0 = 3.0e-3;
// Mie preferred scattering direction (Henyey-Greenstein g)
const float MIE_G   = 0.76;

// Airglow emission altitudes (normalized to R_earth)
const float H_GREEN_PEAK = 0.015;    // OI 557.7nm peak at ~97 km
const float H_GREEN_W    = 0.005;    // ~30 km layer width
const float H_RED_PEAK   = 0.038;    // OI 630.0nm peak at ~250 km
const float H_RED_W      = 0.018;    // ~120 km layer width

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

// ── Airglow emission profile ──────────────────────────────────────────────
// OI 557.7 nm (green line): chemiluminescence from O + O + M → O₂* + M
//   Peak at ~97 km, FWHM ~30 km, ~250 Rayleighs at night
// OI 630.0 nm (red line): dissociative recombination of O₂⁺
//   Peak at ~250 km, FWHM ~120 km, ~100 Rayleighs at night, enhanced by Kp
vec3 airglowEmission(float h, float NdotL, float kp, float t) {
    // Nightside only — airglow quenched on dayside by solar UV photoionisation
    float nightMask = smoothstep(0.15, -0.10, NdotL);

    // Green OI 557.7nm — altitude-dependent Gaussian
    float greenLayer = exp(-pow((h - H_GREEN_PEAK) / H_GREEN_W, 2.0));
    // Subtle pulsation from gravity waves (~15 min period)
    float greenPulse = 0.85 + 0.15 * sin(t * 0.42);
    vec3 greenCol = vec3(0.15, 0.92, 0.25) * greenLayer * 0.12 * greenPulse;

    // Red OI 630.0nm — broader layer, enhanced during geomagnetic activity
    float redLayer = exp(-pow((h - H_RED_PEAK) / H_RED_W, 2.0));
    float kpBoost = 1.0 + clamp(kp - 2.0, 0.0, 7.0) * 0.18;  // Kp > 2 enhances red
    vec3 redCol = vec3(0.85, 0.18, 0.08) * redLayer * 0.06 * kpBoost;

    return (greenCol + redCol) * nightMask;
}

// ── D-layer radio blackout glow ───────────────────────────────────────────
// Solar X-rays (1–8 Å) ionise the D-layer (60–90 km), causing HF absorption.
// Visible as a faint orange-red glow on the sunlit hemisphere.
// R1–R5 scale: 0.2 = C-class (R0), 0.5 = M-class (R1-R2), 1.0 = X-class (R3-R5)
vec3 dLayerBlackout(float h, float NdotL, float xray) {
    if (xray < 0.15) return vec3(0.0);  // below C-class threshold

    // D-layer altitude profile
    float dProfile = exp(-pow((h - H_DLAYER) / H_DLAYER_W, 2.0));

    // Dayside only — X-rays can only ionise the sunlit D-layer
    float dayMask = smoothstep(-0.05, 0.25, NdotL);

    // Intensity scales with X-ray flux (log scale: C→M→X)
    float intensity = smoothstep(0.15, 1.0, xray);

    // Colour: warm amber at M-class, angry red-orange at X-class
    vec3 mColor = vec3(1.0, 0.65, 0.15);  // amber (M-class)
    vec3 xColor = vec3(1.0, 0.25, 0.05);  // red-orange (X-class)
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

    // Accumulate Rayleigh + Mie in-scattering + emission layers
    vec3  sumR = vec3(0.0);
    vec3  sumM = vec3(0.0);
    vec3  sumEmission = vec3(0.0);  // airglow + D-layer blackout
    float optDepthR = 0.0;
    float optDepthM = 0.0;

    for (int i = 0; i < NUM_STEPS; i++) {
        float tMid = tN + (float(i) + 0.5) * segLen;
        vec3  samplePos = camPos + rayDir * tMid;
        float h = length(samplePos) - R_PLANET;

        float densR = exp(-h / H_RAYLEIGH) * segLen;
        float densM = exp(-h / H_MIE)      * segLen;
        optDepthR += densR;
        optDepthM += densM;

        // Light ray from sample to sun
        float ltN, ltF;
        raySphere(samplePos, L, R_ATM, ltN, ltF);
        float lSegLen = ltF / float(NUM_LSTEPS);

        float lOptR = 0.0, lOptM = 0.0;
        bool  shadow = false;
        for (int j = 0; j < NUM_LSTEPS; j++) {
            vec3  lPos = samplePos + L * ((float(j) + 0.5) * lSegLen);
            float lH   = length(lPos) - R_PLANET;
            if (lH < 0.0) { shadow = true; break; }
            lOptR += exp(-lH / H_RAYLEIGH) * lSegLen;
            lOptM += exp(-lH / H_MIE)      * lSegLen;
        }
        if (shadow) continue;

        vec3 tau = BETA_R0 * (optDepthR + lOptR) + BETA_M0 * (optDepthM + lOptM);
        vec3 atten = exp(-tau);

        sumR += densR * atten;
        sumM += densM * atten;

        // ── Emission layers (self-luminous, no sun illumination needed) ────
        float sampleNdotL = dot(normalize(samplePos), L);

        // Airglow — nightside OI green + red emission bands
        sumEmission += airglowEmission(h, sampleNdotL, u_kp, u_time) * segLen * 8.0;

        // D-layer blackout — dayside X-ray ionisation glow
        sumEmission += dLayerBlackout(h, sampleNdotL, u_xray) * segLen * 8.0;
    }

    float cosTheta = dot(rayDir, L);
    vec3 scatter = sumR * BETA_R0 * phaseR(cosTheta)
                 + sumM * BETA_M0 * phaseM(cosTheta);

    // Combine scattering + emission
    scatter += sumEmission;

    // Exposure tone mapping
    scatter = 1.0 - exp(-scatter * 28.0);

    // Limb-based alpha: stronger at the edges (grazing angle)
    float rim = 1.0 - max(dot(V, N), 0.0);
    float alpha = rim * rim * 0.9;

    // Boost alpha where scattering or emission is strong
    float lum = dot(scatter, vec3(0.299, 0.587, 0.114));
    alpha = max(alpha, lum * 0.85);
    alpha = clamp(alpha, 0.0, 0.92);

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
