/**
 * moon-skin.js — Lunar surface renderer + radiation environment for Celestial Simulator
 * ═══════════════════════════════════════════════════════════════════════════════════════
 * Renders a photorealistic Moon with:
 *   - High-res surface texture (Clementine/LRO-derived)
 *   - Bump/displacement mapping for crater relief
 *   - Regolith micro-normal procedural detail
 *   - Terminator shadow with subsurface scattering approximation
 *   - Lunar radiation environment (GCR + SEP flux visualization)
 *   - Earthshine illumination on nightside
 *
 * Exports:
 *   MOON_TEXTURES           — CDN URLs for lunar surface + bump textures
 *   MOON_VERT / MOON_FRAG   — Lunar surface GLSL shaders
 *   createMoonUniforms(sunDir) — default uniform block
 *   loadMoonTextures(mu)    — loads textures, returns Promise
 *   MoonSkin                — convenience class: creates + manages lunar mesh stack
 *
 * Radiation model references:
 *   Schwadron et al. (2018) "Lunar Surface Dose Rate from GCR" — GCR flux model
 *   Wimmer-Schweingruber et al. (2021) "LND/Chang'E-4 dose rate measurements"
 *   CRaTER/LRO (2009–present) — Cosmic Ray Telescope for the Effects of Radiation
 *   PREDICCS (2015) — Predictions of radiation from REleASE, EMMREM, and Data
 */

import * as THREE from 'three';

// ── Texture URLs ────────────────────────────────────────────────────────────
// Using Solar System Scope textures (CC-licensed educational use)
const _CDN = 'https://upload.wikimedia.org/wikipedia/commons/';
export const MOON_TEXTURES = {
    surface: _CDN + 'thumb/2/23/Moon_texture_nasa_lro_lola.jpg/2560px-Moon_texture_nasa_lro_lola.jpg',
    bump:    _CDN + 'thumb/4/4f/Moon_bump.jpg/2560px-Moon_bump.jpg',
};

// ── Safe fallback textures ──────────────────────────────────────────────────
function _grayTex() {
    const t = new THREE.DataTexture(new Uint8Array([120, 120, 120, 255]), 1, 1, THREE.RGBAFormat);
    t.needsUpdate = true; return t;
}
function _blackTex() {
    const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat);
    t.needsUpdate = true; return t;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  LUNAR SURFACE SHADERS
// ═══════════════════════════════════════════════════════════════════════════════

export const MOON_VERT = /* glsl */`
varying vec2 vUv;
varying vec3 vWorldNormal;
varying vec3 vWorldPos;
varying vec3 vWorldTangent;
varying vec3 vWorldBitangent;
void main() {
    vUv          = uv;
    vWorldNormal = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
    vWorldPos    = (modelMatrix * vec4(position, 1.0)).xyz;

    vec3 N = normalize(normal);
    vec3 up = vec3(0.0, 1.0, 0.0);
    vec3 T = normalize(cross(up, N));
    if (length(cross(up, N)) < 0.001) T = vec3(1.0, 0.0, 0.0);
    vec3 B = cross(N, T);
    vWorldTangent   = normalize((modelMatrix * vec4(T, 0.0)).xyz);
    vWorldBitangent = normalize((modelMatrix * vec4(B, 0.0)).xyz);

    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

export const MOON_FRAG = /* glsl */`
#ifdef GL_OES_standard_derivatives
#extension GL_OES_standard_derivatives : enable
#endif
precision highp float;

uniform sampler2D u_surface;
uniform sampler2D u_bump;
uniform vec3  u_sun_dir;
uniform vec3  u_earth_dir;     // direction from Moon to Earth (for earthshine)
uniform float u_time;
uniform float u_bump_strength;
uniform float u_earthshine;    // earthshine brightness (0–1, driven by lunar phase)
uniform float u_radiation_vis; // radiation visualization overlay toggle
uniform float u_gcr_flux;      // galactic cosmic ray flux (normalized 0–1)
uniform float u_sep_flux;      // solar energetic particle flux (normalized 0–1)
uniform float u_kp;            // geomagnetic index (drives magnetotail particle flux)

varying vec2 vUv;
varying vec3 vWorldNormal;
varying vec3 vWorldPos;
varying vec3 vWorldTangent;
varying vec3 vWorldBitangent;

// ── Hash-based noise for regolith micro-structure ────────────────────────────
float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

float valueNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash12(i);
    float b = hash12(i + vec2(1.0, 0.0));
    float c = hash12(i + vec2(0.0, 1.0));
    float d = hash12(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float regolithFBM(vec2 p) {
    float v = 0.0;
    float amp = 0.5;
    for (int i = 0; i < 4; i++) {
        v += valueNoise(p) * amp;
        p *= 2.17;
        amp *= 0.48;
    }
    return v;
}

// ── Bump map normal perturbation ─────────────────────────────────────────────
vec3 perturbNormal(vec3 N, vec3 T, vec3 B, vec2 uv, float strength) {
    vec2 dUVdx = dFdx(uv);
    vec2 dUVdy = dFdy(uv);
    float texelScale = max(length(dUVdx), length(dUVdy));
    vec2 texel = max(vec2(texelScale), vec2(1.0 / 2048.0));

    float hL = texture2D(u_bump, uv - vec2(texel.x, 0.0)).r;
    float hR = texture2D(u_bump, uv + vec2(texel.x, 0.0)).r;
    float hD = texture2D(u_bump, uv - vec2(0.0, texel.y)).r;
    float hU = texture2D(u_bump, uv + vec2(0.0, texel.y)).r;

    float dU = (hR - hL) * strength;
    float dV = (hU - hD) * strength;
    return normalize(N - T * dU - B * dV);
}

// ── Radiation dose rate model ────────────────────────────────────────────────
// Schwadron et al. (2018): GCR dose rate varies with solar modulation (phi)
// Typical range: 13–38 cGy/yr on lunar surface
// SEP events: 0.5–50 cGy in minutes during major solar particle events
vec3 radiationOverlay(vec3 N, float NdotL) {
    float gcr = u_gcr_flux;
    float sep = u_sep_flux;

    // GCR is isotropic — hits all surfaces equally, slightly higher at poles
    // (less regolith self-shielding from oblique angles)
    float lat = asin(clamp(N.y, -1.0, 1.0));
    float polarBoost = 1.0 + abs(lat) * 0.15;
    float gcrDose = gcr * polarBoost;

    // SEP flux comes from sun direction — only hits sunlit hemisphere
    float sepDose = sep * max(NdotL, 0.0);

    // Magnetotail particles when Moon passes through Earth's magnetotail
    // (happens ~4 days per orbit near full moon)
    float tailDose = u_kp * 0.05 * max(-dot(N, u_earth_dir), 0.0);

    float total = gcrDose * 0.6 + sepDose * 1.5 + tailDose;

    // Color ramp: green (low) → yellow → orange → red (high)
    vec3 low  = vec3(0.1, 0.8, 0.2);
    vec3 mid  = vec3(1.0, 0.8, 0.0);
    vec3 high = vec3(1.0, 0.15, 0.05);

    vec3 col;
    if (total < 0.35) col = mix(low, mid, total / 0.35);
    else              col = mix(mid, high, clamp((total - 0.35) / 0.65, 0.0, 1.0));

    return col * total;
}

void main() {
    vec3 Nflat = normalize(vWorldNormal);
    vec3 T     = normalize(vWorldTangent);
    vec3 B     = normalize(vWorldBitangent);

    // Bump map + regolith micro-normal perturbation
    float bumpStr = u_bump_strength * 3.5;
    vec3 N = (bumpStr > 0.01) ? perturbNormal(Nflat, T, B, vUv, bumpStr) : Nflat;

    // Add procedural regolith micro-structure at close range
    vec2 regUV = vUv * 800.0;
    float regDetail = regolithFBM(regUV) * 0.15;
    N = normalize(N + T * (regDetail - 0.075) + B * (regDetail - 0.075));

    vec3 L = normalize(u_sun_dir);
    float NdotL = dot(N, L);

    // ── Base surface color ────────────────────────────────────────────────────
    vec3 surfaceCol = texture2D(u_surface, vUv).rgb;

    // Lunar Hapke BRDF approximation — opposition surge at zero phase angle
    vec3 V = normalize(cameraPosition - vWorldPos);
    float phaseAngle = acos(clamp(dot(V, L), -1.0, 1.0));
    float oppSurge = 1.0 + 0.4 * exp(-phaseAngle * phaseAngle * 8.0);

    // Half-Lambert for soft terminator (no atmosphere to scatter light)
    float dayMix = smoothstep(-0.02, 0.08, NdotL);
    float halfLamb = clamp(NdotL * 0.5 + 0.5, 0.0, 1.0);
    float lit = halfLamb * dayMix * oppSurge;

    vec3 base = surfaceCol * lit;

    // ── Earthshine — illumination from reflected Earth on nightside ──────────
    if (u_earthshine > 0.01) {
        float NdotE = max(dot(Nflat, normalize(u_earth_dir)), 0.0);
        float nightMask = 1.0 - smoothstep(-0.05, 0.15, NdotL);
        vec3 earthColor = vec3(0.25, 0.4, 0.65);  // blue-tinted Earth albedo
        base += earthColor * NdotE * nightMask * u_earthshine * 0.12;
    }

    // ── Specular — very subtle (lunar albedo ~0.12, very rough) ──────────────
    vec3 H = normalize(L + V);
    float NdotH = max(dot(N, H), 0.0);
    float spec = pow(NdotH, 12.0) * dayMix * 0.08;
    base += vec3(spec);

    // ── Terminator detail — crater shadows become dramatic at terminator ──────
    float termZone = smoothstep(-0.04, 0.0, NdotL) * smoothstep(0.10, 0.02, NdotL);
    float craterShadow = (1.0 - texture2D(u_bump, vUv).r) * termZone;
    base *= 1.0 - craterShadow * 0.6;

    // ── Radiation environment overlay ─────────────────────────────────────────
    if (u_radiation_vis > 0.5) {
        vec3 radCol = radiationOverlay(Nflat, NdotL);
        base = mix(base, base + radCol, 0.55);
    }

    gl_FragColor = vec4(base, 1.0);
}`;

// ═══════════════════════════════════════════════════════════════════════════════
//  RADIATION RING SHADER — visualizes GCR/SEP flux shell around Moon
// ═══════════════════════════════════════════════════════════════════════════════

export const RAD_RING_VERT = /* glsl */`
varying vec3 vWorldNormal;
varying vec3 vWorldPos;
void main() {
    vWorldNormal = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
    vWorldPos    = (modelMatrix * vec4(position, 1.0)).xyz;
    gl_Position  = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

export const RAD_RING_FRAG = /* glsl */`
precision mediump float;
uniform vec3  u_sun_dir;
uniform float u_gcr_flux;
uniform float u_sep_flux;
uniform float u_time;
varying vec3 vWorldNormal;
varying vec3 vWorldPos;
void main() {
    vec3 N = normalize(vWorldNormal);
    vec3 V = normalize(cameraPosition - vWorldPos);
    float rim = pow(1.0 - abs(dot(V, N)), 2.5);

    // GCR: isotropic, faint cyan-white glow
    vec3 gcrCol = vec3(0.3, 0.6, 0.9) * u_gcr_flux;

    // SEP: directional from sun, orange-red glow on sunlit side
    float sunFace = max(dot(N, normalize(u_sun_dir)), 0.0);
    vec3 sepCol = vec3(1.0, 0.4, 0.1) * u_sep_flux * sunFace;

    // Animate slightly
    float pulse = 0.85 + 0.15 * sin(u_time * 1.5 + dot(N, vec3(1.0)));

    vec3 col = (gcrCol + sepCol) * rim * pulse;
    float alpha = rim * 0.5 * (u_gcr_flux + u_sep_flux * sunFace);

    gl_FragColor = vec4(col, clamp(alpha, 0.0, 0.6));
}`;

// ═══════════════════════════════════════════════════════════════════════════════
//  UNIFORM FACTORIES
// ═══════════════════════════════════════════════════════════════════════════════

export function createMoonUniforms(sunDir = new THREE.Vector3(1, 0, 0)) {
    return {
        u_surface:        { value: _grayTex() },
        u_bump:           { value: _blackTex() },
        u_sun_dir:        { value: sunDir.clone() },
        u_earth_dir:      { value: new THREE.Vector3(-1, 0, 0) },
        u_time:           { value: 0 },
        u_bump_strength:  { value: 1.0 },
        u_earthshine:     { value: 0.3 },
        u_radiation_vis:  { value: 0 },
        u_gcr_flux:       { value: 0.45 },    // baseline GCR (solar min ≈ 0.7, solar max ≈ 0.3)
        u_sep_flux:       { value: 0.0 },      // 0 unless active SEP event
        u_kp:             { value: 0 },
    };
}

export function createRadRingUniforms(sunDir = new THREE.Vector3(1, 0, 0)) {
    return {
        u_sun_dir:   { value: sunDir.clone() },
        u_gcr_flux:  { value: 0.45 },
        u_sep_flux:  { value: 0.0 },
        u_time:      { value: 0 },
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  TEXTURE LOADER
// ═══════════════════════════════════════════════════════════════════════════════

export function loadMoonTextures(moonU, renderer = null) {
    const loader = new THREE.TextureLoader();
    const maxAniso = renderer ? renderer.capabilities.getMaxAnisotropy() : 16;

    const loadTex = (url, onLoad, fallbackFn) => new Promise(resolve => {
        loader.load(url,
            tex => {
                tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
                tex.minFilter = THREE.LinearMipmapLinearFilter;
                tex.magFilter = THREE.LinearFilter;
                tex.anisotropy = maxAniso;
                tex.generateMipmaps = true;
                onLoad(tex);
                resolve();
            },
            undefined,
            () => {
                console.warn(`[MoonSkin] texture load failed: ${url}`);
                onLoad(fallbackFn());
                resolve();
            }
        );
    });

    return Promise.all([
        loadTex(MOON_TEXTURES.surface, tex => {
            tex.colorSpace = THREE.SRGBColorSpace;
            moonU.u_surface.value = tex;
        }, _grayTex),
        loadTex(MOON_TEXTURES.bump, tex => {
            moonU.u_bump.value = tex;
        }, _blackTex),
    ]);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  MOONSKIN CLASS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Creates and manages the full Moon visual stack.
 *
 * @example
 * const moon = new MoonSkin(scene, sunDir, { segments: 128, radiation: true });
 * moon.loadTextures(renderer).then(() => console.log('ready'));
 * // In loop:
 * moon.update(t);
 * moon.setRadiation({ gcrFlux: 0.5, sepFlux: 0.0, kp: 2 });
 */
export class MoonSkin {
    constructor(parent, sunDir = new THREE.Vector3(1, 0, 0), {
        radius   = 1.0,
        segments = 128,
        radiation = true,
    } = {}) {
        this._parent = parent;

        // Moon surface
        this.moonU = createMoonUniforms(sunDir);
        const moonMat = new THREE.ShaderMaterial({
            vertexShader: MOON_VERT, fragmentShader: MOON_FRAG,
            uniforms: this.moonU,
            extensions: { derivatives: true },
        });
        this.moonMesh = new THREE.Mesh(
            new THREE.SphereGeometry(radius, segments, segments),
            moonMat
        );
        parent.add(this.moonMesh);

        // Radiation ring (GCR + SEP flux shell)
        this.radU = null;
        this._radMesh = null;
        if (radiation) {
            this.radU = createRadRingUniforms(sunDir);
            const radMat = new THREE.ShaderMaterial({
                vertexShader: RAD_RING_VERT, fragmentShader: RAD_RING_FRAG,
                uniforms: this.radU, transparent: true, depthWrite: false,
                side: THREE.BackSide, blending: THREE.AdditiveBlending,
            });
            this._radMesh = new THREE.Mesh(
                new THREE.SphereGeometry(radius * 1.06, Math.round(segments * 0.5), Math.round(segments * 0.5)),
                radMat
            );
            parent.add(this._radMesh);
        }
    }

    loadTextures(renderer = null) {
        return loadMoonTextures(this.moonU, renderer);
    }

    update(t) {
        this.moonU.u_time.value = t;
        if (this.radU) this.radU.u_time.value = t;
    }

    setSunDir(v) {
        this.moonU.u_sun_dir.value.copy(v);
        if (this.radU) this.radU.u_sun_dir.value.copy(v);
    }

    setEarthDir(v) {
        this.moonU.u_earth_dir.value.copy(v);
    }

    setRadiation({ gcrFlux = 0.45, sepFlux = 0, kp = 0 } = {}) {
        this.moonU.u_gcr_flux.value = gcrFlux;
        this.moonU.u_sep_flux.value = sepFlux;
        this.moonU.u_kp.value       = kp;
        if (this.radU) {
            this.radU.u_gcr_flux.value = gcrFlux;
            this.radU.u_sep_flux.value = sepFlux;
        }
    }

    setRadiationVisible(v) {
        this.moonU.u_radiation_vis.value = v ? 1 : 0;
        if (this._radMesh) this._radMesh.visible = v;
    }

    setEarthshine(v) {
        this.moonU.u_earthshine.value = v;
    }
}
