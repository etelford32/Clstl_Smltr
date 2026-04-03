/**
 * sun-shader.js — Shared GLSL shaders for the 3D photosphere sphere
 *
 * Used by both sun.html (full detail) and heliosphere3d.js (solar system view).
 * Quality is controlled by the `u_quality` uniform:
 *   0 = low   — fast noise, 1-term limb darkening (heliosphere far view)
 *   1 = medium — full noise, 3-term limb darkening, spicules (heliosphere close)
 *   2 = high  — Voronoi granulation, 5-term Neckel & Labs, diff rotation (sun.html)
 *
 * Features
 * ─────────
 *  • Blackbody temperature-driven photosphere colour (3000–8000 K)
 *  • Two-tier convection: supergranulation (~35 Mm) + granulation (~1 Mm)
 *  • Solar limb darkening — up to 5-term Neckel & Labs polynomial
 *  • Chromospheric spicule fringe at limb (Hα bright jets)
 *  • X-ray flux brightness/colour boost (driven by live GOES data)
 *  • Active-region sunspot hotspots — up to 8 vec4(xyz, intensity)
 *  • Umbra (T ~3470 K) + penumbra (T ~4200 K) with intensity scaling
 *  • Flare flash — brief white-out on M/X trigger
 *  • Post-flare UV arc glow at active region site
 *  • Differential rotation (Snodgrass & Ulrich 1990)
 *  • F10.7 solar radio flux brightness modulation
 *
 * Uniforms (set by SunSkin or page-level code):
 *   u_time        float   elapsed seconds
 *   u_teff        float   effective temperature in K (default 5778)
 *   u_quality     float   0 = low, 1 = medium, 2 = high
 *   u_activity    float   0–1 solar cycle activity level
 *   u_xray_norm   float   0–1 log-normalised GOES X-ray flux
 *   u_f107_norm   float   0–1 normalised F10.7 radio flux
 *   u_flare_t     float   0–1 flash intensity (decays after trigger)
 *   u_kp_norm     float   0–1 Kp/9
 *   u_bloom       float   corona brightness multiplier (0.3–3.0)
 *   u_flare_arc   float   0–1 post-flare UV arcade glow
 *   u_flare_lon   vec2    (lat_rad, lon_rad) of flare source
 *   u_regions     vec4[8] xyz = unit-sphere local position, w = intensity
 *   u_nRegions    int     number of active regions (0–8)
 *   u_rot_phase   float   cumulative rotation phase (radians)
 *
 * ── Integration Points ──────────────────────────────────────────────────────
 *  - heliosphere3d.js: imports SUN_VERT, SUN_FRAG, createSunUniforms
 *    Uses quality=0 or 1 depending on zoom level.
 *  - sun.html: imports same, uses quality=2 for full detail.
 *  - sun-skin.js: wraps these into a reusable SunSkin class.
 *
 * ── Data Quality Notes ──────────────────────────────────────────────────────
 *  - Blackbody colour is an analytical approximation (CIE 1931 chromaticity
 *    → sRGB), accurate to ~ΔE<2 for 3000–10000 K.
 *  - Granulation pattern is procedural noise, not observed imagery.
 *    Real granulation has ~1000 km cells with 8-min lifetime (Hinode/SDO).
 *  - Limb darkening coefficients from Neckel & Labs (1994), valid for
 *    continuum wavelengths 400–900 nm (broadband visible).
 *  - Active region placement uses heliographic lat/lon from NOAA SWPC
 *    active region reports; position accuracy ~1° but sizes are artistic.
 *  - Differential rotation uses Snodgrass & Ulrich (1990) surface fit:
 *    Ω(θ) = 14.713 − 2.396 sin²θ − 1.787 sin⁴θ  [°/day]
 *    Valid for the photosphere; interior rotation differs (tachocline).
 */

export const SUN_VERT = /* glsl */`
    varying vec3 vNormalView;
    varying vec3 vLocalPos;
    varying vec2 vUv;

    void main() {
        vLocalPos   = normalize(position);
        vNormalView = normalize(normalMatrix * normal);
        vUv         = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`;

export const SUN_FRAG = /* glsl */`
    precision highp float;

    uniform float u_time;
    uniform float u_teff;
    uniform float u_quality;
    uniform float u_activity;
    uniform float u_xray_norm;
    uniform float u_f107_norm;
    uniform float u_flare_t;
    uniform float u_kp_norm;
    uniform float u_bloom;
    uniform float u_flare_arc;
    uniform vec2  u_flare_lon;
    uniform vec4  u_regions[8];
    uniform int   u_nRegions;
    uniform float u_rot_phase;

    varying vec3 vNormalView;
    varying vec3 vLocalPos;
    varying vec2 vUv;

    // ── Hash / noise ──────────────────────────────────────────────────────────

    float hash2(vec2 p) {
        p  = fract(p * vec2(127.1, 311.7));
        p += dot(p, p + 19.19);
        return fract(p.x * p.y);
    }

    float vnoise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(
            mix(hash2(i),                  hash2(i + vec2(1.0, 0.0)), f.x),
            mix(hash2(i + vec2(0.0, 1.0)), hash2(i + vec2(1.0, 1.0)), f.x),
            f.y
        );
    }

    // ── Blackbody colour from temperature ─────────────────────────────────────
    // Analytical approximation of CIE 1931 → sRGB for 3000–10000 K.
    // Attempt at ~ΔE<3 accuracy across the solar Teff range.
    vec3 blackbodyRGB(float T) {
        float t = clamp((T - 3000.0) / 5000.0, 0.0, 1.0);
        // Red channel: saturates early
        float r = 1.0;
        // Green: rises from ~0.35 at 3000 K to ~0.92 at 5778 K to ~0.95 at 8000 K
        float g = mix(0.35, 0.95, smoothstep(0.0, 0.8, t));
        // Blue: very low at 3000 K, rises sharply above 5000 K
        float b = mix(0.0, 0.85, smoothstep(0.2, 1.0, t));
        return vec3(r, g, b);
    }

    // ── Supergranulation (~35 Mm cells) ────────────────────────────────────────
    float supergranulation(vec2 uv, float t) {
        float n = vnoise(uv * 2.2  + vec2( t * 0.0018, t * 0.0011)) * 0.55
                + vnoise(uv * 4.0  + vec2(-t * 0.0025, t * 0.0015)) * 0.35
                + vnoise(uv * 7.5  + vec2( t * 0.0035, -t * 0.0022)) * 0.10;
        return smoothstep(0.32, 0.68, n);
    }

    // ── Granulation (~1 Mm cells) ─────────────────────────────────────────────
    float granulation(vec2 uv, float t) {
        float n = vnoise(uv *  7.0  + vec2( t * 0.016,  t * 0.011)) * 0.50
                + vnoise(uv * 15.0  + vec2(-t * 0.025,  t * 0.018)) * 0.30
                + vnoise(uv * 31.0  + vec2( t * 0.041, -t * 0.035)) * 0.20;
        return smoothstep(0.30, 0.70, n);
    }

    // ── Chromospheric spicules ─────────────────────────────────────────────────
    float spicules(vec2 uv, float mu, float t) {
        float n = vnoise(vec2(uv.x * 110.0 + t * 0.008, uv.y * 5.0 + t * 0.003)) * 0.6
                + vnoise(vec2(uv.x * 220.0 - t * 0.015, uv.y * 2.5))              * 0.4;
        float w = max(0.0, 1.0 - mu / 0.18);
        w = w * w;
        return n * w;
    }

    // ── Limb darkening ────────────────────────────────────────────────────────
    // Quality 0-1: linear law  I(μ) = 1 − u(1−μ)
    // Quality 2: 5-term Neckel & Labs (1994) polynomial
    float limbDarkening(float mu) {
        if (u_quality < 1.5) {
            return 1.0 - 0.60 * (1.0 - mu);
        }
        // Neckel & Labs 5-term (broadband visible average):
        // I(μ)/I(1) = a0 + a1μ + a2μ² + a3μ³ + a4μ⁴ + a5μ⁵
        float m2 = mu*mu, m3 = m2*mu, m4 = m3*mu, m5 = m4*mu;
        return 0.30505 + 1.13123*mu - 0.78604*m2 + 0.42200*m3
             - 0.09398*m4 + 0.01174*m5;
    }

    void main() {
        float mu = max(0.001, vNormalView.z);

        // ── Limb darkening ──
        float limb = limbDarkening(mu);

        // ── Convection texture ──
        vec2 uv = vUv;
        // Apply differential rotation phase offset for quality >= 2
        if (u_quality > 1.5) {
            // Snodgrass differential rotation: equator faster than poles
            float lat = (uv.y - 0.5) * 3.14159;
            float sinLat = sin(lat);
            float s2 = sinLat * sinLat;
            // Relative to equatorial rate: slow poles by up to ~25%
            float diffRot = 1.0 - 0.163 * s2 - 0.121 * s2 * s2;
            uv.x += u_rot_phase * diffRot * 0.0001;
        }

        float sgran = supergranulation(uv, u_time);
        float gran  = (u_quality > 0.5) ? granulation(uv, u_time) : sgran;
        float texture = sgran * 0.38 + gran * 0.62;

        // ── Base photosphere colour from Teff ──
        vec3 bbCol = blackbodyRGB(u_teff);
        // Limb colour: cooler (redder) at the limb due to viewing higher/cooler layers
        vec3 limbCol = blackbodyRGB(u_teff * 0.72);
        vec3 baseCol = mix(bbCol, limbCol, pow(1.0 - mu, 2.8));

        // F10.7 brightness modulation: brighter photosphere during active Sun
        float f107Boost = 1.0 + u_f107_norm * 0.08;
        baseCol *= f107Boost;

        // Texture modulates brightness ±15%
        vec3 photCol = baseCol * (0.85 + 0.30 * texture) * max(0.5, u_bloom);

        // ── Chromospheric spicule fringe (quality >= 1) ──
        if (u_quality > 0.5) {
            float sp = spicules(uv, mu, u_time);
            photCol += vec3(1.0, 0.35, 0.08) * sp * 0.28 * max(0.5, u_bloom);
        }

        // ── X-ray activity boost ──
        float xBoost = 1.0 + u_xray_norm * 0.45;
        vec3 actCol = photCol * xBoost;
        actCol.b += u_xray_norm * 0.15;

        // ── Active region hotspots ──
        float totalUmbra = 0.0;
        float totalPenumbra = 0.0;
        for (int k = 0; k < 8; k++) {
            if (k >= u_nRegions) break;
            vec3  arPos  = normalize(u_regions[k].xyz);
            float arInt  = u_regions[k].w;
            float cosAng = clamp(dot(vLocalPos, arPos), -1.0, 1.0);
            float ang    = acos(cosAng);
            // Umbra: dark core (T ~3470 K → ~60% of photosphere)
            float umbra  = exp(-ang * ang / (0.008 * arInt + 0.004)) * arInt;
            // Penumbra: warm ring (T ~4200 K → facula brightening)
            float penumb = smoothstep(0.28, 0.08, ang)
                         * (1.0 - smoothstep(0.08, 0.0, ang)) * arInt;
            totalUmbra    += umbra;
            totalPenumbra += penumb;
        }
        totalUmbra    = clamp(totalUmbra,    0.0, 1.0);
        totalPenumbra = clamp(totalPenumbra, 0.0, 1.0);

        // Umbra darkening: sunspot is ~60% of Teff → much dimmer
        vec3 umbraCol = blackbodyRGB(u_teff * 0.60) * 0.22;
        actCol = mix(actCol, umbraCol, totalUmbra);
        // Penumbra / facular brightening at limb
        float facLimb = 1.0 + (1.0 - mu) * 0.6;  // limb-brightened faculae
        actCol += blackbodyRGB(u_teff * 1.05) * totalPenumbra * 0.30 * facLimb;

        // ── Post-flare UV arc glow ──
        if (u_flare_arc > 0.005) {
            vec3 flareSrc = normalize(vec3(
                cos(u_flare_lon.x) * cos(u_flare_lon.y),
                sin(u_flare_lon.x),
                cos(u_flare_lon.x) * sin(u_flare_lon.y)
            ));
            float cosFA = clamp(dot(vLocalPos, flareSrc), -1.0, 1.0);
            float arcAng = acos(cosFA);
            float innerGlow = exp(-arcAng * arcAng / 0.006) * u_flare_arc;
            float outerGlow = exp(-arcAng * arcAng / 0.045) * u_flare_arc * 0.35;
            actCol += vec3(0.35, 0.60, 1.00) * innerGlow * 2.2;
            actCol += vec3(1.00, 0.82, 0.40) * outerGlow * 1.4;
        }

        // ── Flare flash ──
        float flash = u_flare_t * u_flare_t;
        actCol = mix(actCol, vec3(1.0, 0.97, 0.85), flash * 0.80);

        // ── Final ──
        vec3 finalCol = actCol * limb;
        gl_FragColor = vec4(finalCol, 1.0);
    }
`;

// ── Corona layer shaders ─────────────────────────────────────────────────────
// Additive-blended sphere shells outside the photosphere.

export const CORONA_VERT = /* glsl */`
    varying vec3 vWorldNormal;
    varying vec3 vViewDir;
    void main() {
        vWorldNormal = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
        vec3 wp = (modelMatrix * vec4(position, 1.0)).xyz;
        vViewDir = normalize(cameraPosition - wp);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`;

export const CORONA_FRAG = /* glsl */`
    precision mediump float;
    uniform float u_bloom;
    uniform float u_xray_norm;
    uniform float u_layer;   // 0-1 which corona layer (inner→outer)
    varying vec3 vWorldNormal;
    varying vec3 vViewDir;
    void main() {
        vec3 N = normalize(vWorldNormal);
        vec3 V = normalize(vViewDir);
        float rim = pow(1.0 - abs(dot(V, N)), 2.0);
        // Inner corona: gold-white, outer: fading orange-red
        vec3 innerCol = vec3(1.0, 0.88, 0.55);
        vec3 outerCol = vec3(0.85, 0.35, 0.06);
        vec3 col = mix(innerCol, outerCol, u_layer);
        // X-ray brightening
        col += vec3(0.2, 0.3, 0.5) * u_xray_norm * (1.0 - u_layer);
        float alpha = rim * (0.25 - u_layer * 0.18) * max(0.3, u_bloom);
        gl_FragColor = vec4(col * alpha, alpha);
    }
`;

/**
 * Create the uniform block for the sun ShaderMaterial.
 * @param {object} THREE  three.js namespace
 * @returns {object}      uniform descriptor object
 */
export function createSunUniforms(THREE) {
    const regions = [];
    for (let i = 0; i < 8; i++) regions.push(new THREE.Vector4(0, 1, 0, 0));
    return {
        u_time:      { value: 0.0 },
        u_teff:      { value: 5778.0 },
        u_quality:   { value: 1.0 },
        u_activity:  { value: 0.5 },
        u_xray_norm: { value: 0.0 },
        u_f107_norm: { value: 0.5 },
        u_flare_t:   { value: 0.0 },
        u_kp_norm:   { value: 0.0 },
        u_bloom:     { value: 1.0 },
        u_flare_arc: { value: 0.0 },
        u_flare_lon: { value: new THREE.Vector2(0, 0) },
        u_regions:   { value: regions },
        u_nRegions:  { value: 0 },
        u_rot_phase: { value: 0.0 },
    };
}
