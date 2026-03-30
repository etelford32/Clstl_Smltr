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

// ── Version-pinned CDN — avoids broken URLs from three-globe package updates ──
const _CDN = 'https://unpkg.com/three-globe@2.31.0/example/img/';
export const EARTH_TEXTURES = {
    day:    _CDN + 'earth-blue-marble.jpg',
    night:  _CDN + 'earth-night.jpg',
    ocean:  _CDN + 'earth-water.png',
    clouds: _CDN + 'clouds.png',
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
    vec3 N = normalize(vWorldNormal);

    float NdotL  = dot(N, u_sun_dir);
    float dayMix = smoothstep(-0.10, 0.20, NdotL);

    vec3 dayCol    = texture2D(u_day,      vUv).rgb;
    vec3 nightCol  = texture2D(u_night,    vUv).rgb * 2.5;
    float oceanMsk = texture2D(u_specular, vUv).r;

    vec3 base = mix(nightCol * u_city_lights, dayCol, dayMix);

    // Ocean specular glint
    vec3  V    = normalize(cameraPosition - vWorldPos);
    vec3  H    = normalize(u_sun_dir + V);
    float spec = pow(max(dot(N, H), 0.0), 90.0) * oceanMsk * dayMix * 0.60;
    base += vec3(spec * 0.7, spec * 0.85, spec);

    // Weather temperature overlay
    if (u_weather_on > 0.5) {
        base = mix(base, weatherOverlay(vUv), 0.28);
    }

    // Aurora
    if (u_aurora_on > 0.5 && u_kp > 1.5) {
        float lat    = (0.5 - vUv.y) * 3.14159265;
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
        float lat    = (0.5 - vUv.y) * 3.14159265;
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
    float lit      = mix(0.10, halfLamb, dayMix);
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

    // Three-layer drift: low clouds slow, mid medium, high cirrus fastest
    vec2 driftLow  = vec2(u_time * 0.000050, u_time * 0.000007);
    vec2 driftMid  = vec2(u_time * 0.000072, u_time * 0.000010);
    vec2 driftHigh = vec2(u_time * 0.000100, u_time * 0.000014);

    // Noise texture samples per layer
    float noiseLow  = texture2D(u_clouds, vUv + driftLow  + swirl).r;
    float noiseMid  = texture2D(u_clouds, vUv + driftMid  + swirl * 0.7).r;
    float noiseHigh = texture2D(u_clouds, vUv + driftHigh + swirl * 0.4).r;

    float alphaLow = 0.0, alphaMid = 0.0, alphaHigh = 0.0;
    float precip   = 0.0;

    if (u_weather_on > 0.5) {
        // Real cloud fraction data from weather feed
        vec4  cl      = texture2D(u_cloud_layers, vUv);
        float clLow   = cl.r;   // 0-1 low-cloud fraction  (cumulus/stratus)
        float clMid   = cl.g;   // 0-1 mid-cloud fraction  (altostratus)
        float clHigh  = cl.b;   // 0-1 high-cloud fraction (cirrus/cirrostratus)
        precip        = cl.a;   // 0-1 precipitation rate

        // Low clouds: dense white cumulus, driven by actual cloud fraction
        alphaLow  = clLow  * pow(noiseLow,  1.2) * 0.94;
        // Mid clouds: semi-transparent altostratus
        alphaMid  = clMid  * pow(noiseMid,  1.5) * 0.72;
        // High cirrus: thin, wispy, translucent
        alphaHigh = clHigh * pow(noiseHigh, 2.0) * 0.50;
    } else {
        // Fallback to legacy pressure/humidity modulation when weather off
        float pressure = texture2D(u_weather, vUv).g;
        float humidity = texture2D(u_weather, vUv).b;
        float base     = pow(max(noiseLow, noiseHigh * 0.55), 1.4) * 0.90;
        float clear    = mix(1.0, 0.55, pressure);
        float boost    = max(0.0, 0.45 - pressure) * 2.2;
        base = clamp(base * clear + base * boost, 0.0, 1.0);
        base = clamp(base * (0.7 + humidity * 0.5), 0.0, 1.0);
        alphaLow  = base;
        alphaHigh = noiseHigh * 0.3;
    }

    // Satellite data blending: replaces noise-driven alpha with observed cloud density
    if (u_satellite_on > 0.5) {
        float satCloud = texture2D(u_satellite, vUv).r;
        // Blend: satellite gives large-scale structure; noise adds fine detail
        alphaLow  = mix(alphaLow,  satCloud * 0.95, 0.55);
        alphaMid  = mix(alphaMid,  satCloud * 0.60, 0.30);
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
    // Day colour: bright white for thick clouds, ice-blue tint for cirrus
    vec3 cloudWhite = mix(vec3(0.82, 0.85, 0.92), vec3(0.97, 0.98, 1.00), lit);
    // Precipitation: grey-blue underbelly on raining clouds
    vec3 rainGrey   = vec3(0.50, 0.53, 0.62);
    // Cirrus tint: slight blue-white at high altitude
    vec3 cirrusTint = vec3(0.88, 0.92, 1.00);
    // Night: dark grey-blue
    vec3 nightCol   = vec3(0.22, 0.26, 0.38);

    float dayMix  = smoothstep(-0.12, 0.20, NdotL);
    vec3  col     = mix(nightCol, cloudWhite, dayMix);

    // Blend in precipitation darkening (only visible side)
    float precipVis = precip * dayMix;
    col = mix(col, rainGrey, precipVis * 0.55);

    // Blend in cirrus tint where high-cloud fraction dominates
    float cirrusDom = alphaHigh / max(0.01, alpha);
    col = mix(col, cirrusTint, cirrusDom * dayMix * 0.35);

    // Warm golden tint at terminator (sunrise/sunset through clouds)
    float termZone = smoothstep(-0.10, 0.0, NdotL) * smoothstep(0.22, 0.06, NdotL);
    col = mix(col, vec3(0.95, 0.72, 0.28), termZone * 0.32 * (1.0 - precipVis * 0.5));

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
precision mediump float;
uniform vec3 u_sun_dir;
varying vec3 vWorldNormal;
varying vec3 vViewDir;
void main() {
    vec3  N   = normalize(vWorldNormal);
    vec3  V   = normalize(vViewDir);
    float rim = pow(1.0 - abs(dot(V, N)), 2.4);
    float NdotL  = dot(N, u_sun_dir);
    float dayMix = clamp(NdotL * 2.0 + 0.5, 0.0, 1.0);
    vec3 rayleigh = mix(vec3(0.03, 0.01, 0.08), vec3(0.14, 0.42, 1.00), dayMix);
    float mie = pow(max(dot(-V, normalize(u_sun_dir)), 0.0), 8.0) * dayMix;
    vec3 col = rayleigh + mie * vec3(0.30, 0.18, 0.06);
    gl_FragColor = vec4(col * rim, rim * 0.82);
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
