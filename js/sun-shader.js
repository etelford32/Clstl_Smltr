/**
 * sun-shader.js — GLSL shaders for the 3D photosphere sphere
 *
 * Features
 * ─────────
 *  • Two-tier convection: supergranulation (~35 Mm) underlays granulation (~1 Mm),
 *    matching Hinode/SDO surface observations
 *  • Solar limb darkening — linear law  I(μ) = 1 − u(1−μ),  u ≈ 0.6
 *  • Chromospheric spicule fringe at limb — thin bright radial jets visible in Hα
 *  • Chromosphere limb colour gradient (yellow-white center → deep orange-red limb)
 *  • X-ray flux brightness/colour boost (driven by live GOES data)
 *  • Active-region sunspot hotspots — up to 8 vec4(xyz_unit, intensity)
 *  • Flare flash — brief white-out at M/X trigger
 *  • Post-flare UV arc glow at active region site (u_flare_arc/u_flare_lon)
 *  • u_bloom — adjustable corona brightness multiplier (0.3–3.0)
 *
 * Uniforms set by heliosphere3d.js _tickSun():
 *   u_time       float   elapsed seconds
 *   u_xray_norm  float   0–1 log-normalised GOES X-ray flux
 *   u_flare_t    float   0–1 flash intensity (decays after trigger)
 *   u_kp_norm    float   0–1  Kp/9
 *   u_bloom      float   corona bloom multiplier (default 1.0)
 *   u_flare_arc  float   0–1 post-flare UV arcade glow (decays after trigger)
 *   u_flare_lon  vec2    (lat_rad, lon_rad) of most recent flare source
 *   u_regions    vec4[8] xyz = unit-sphere local position, w = 0–1 intensity
 *   u_nRegions   int     number of active regions (0–8)
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
    uniform float u_xray_norm;
    uniform float u_flare_t;
    uniform float u_kp_norm;
    uniform float u_bloom;
    uniform float u_flare_arc;
    uniform vec2  u_flare_lon;   // (lat_rad, lon_rad) of flare source
    uniform vec4  u_regions[8];
    uniform int   u_nRegions;

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

    // ── Supergranulation (~35 Mm cells) ────────────────────────────────────────
    // Visible on the real sun as the 'magnetic network' — darker intergranular
    // lanes at supergranule boundaries.  Slow evolution (hours).
    float supergranulation(vec2 uv, float t) {
        float n = vnoise(uv * 2.2  + vec2( t * 0.0018, t * 0.0011)) * 0.55
                + vnoise(uv * 4.0  + vec2(-t * 0.0025, t * 0.0015)) * 0.35
                + vnoise(uv * 7.5  + vec2( t * 0.0035, -t * 0.0022)) * 0.10;
        // Narrow bright network: cell interiors bright, boundaries dark
        return smoothstep(0.32, 0.68, n);
    }

    // ── Granulation (~1 Mm cells) ─────────────────────────────────────────────
    // Fast-evolving convection (~5 min lifetime).
    float granulation(vec2 uv, float t) {
        float n = vnoise(uv *  7.0  + vec2( t * 0.016,  t * 0.011)) * 0.50
                + vnoise(uv * 15.0  + vec2(-t * 0.025,  t * 0.018)) * 0.30
                + vnoise(uv * 31.0  + vec2( t * 0.041, -t * 0.035)) * 0.20;
        return smoothstep(0.30, 0.70, n);
    }

    // ── Chromospheric spicules — thin radial jets at limb ─────────────────────
    // Observed in Hα as a bright fringe of tiny plasma jets just above the limb.
    // We approximate them as high-frequency radial striations that emerge only
    // at very low μ (near-limb viewing angle).
    float spicules(vec2 uv, float mu, float t) {
        // High-frequency tangential variation, low-frequency radial
        float n = vnoise(vec2(uv.x * 110.0 + t * 0.008, uv.y * 5.0 + t * 0.003)) * 0.6
                + vnoise(vec2(uv.x * 220.0 - t * 0.015, uv.y * 2.5))              * 0.4;
        // Weight: zero at disk centre, bright near limb (mu < 0.18)
        float w = max(0.0, 1.0 - mu / 0.18);
        w = w * w;
        return n * w;
    }

    void main() {
        // ── Limb darkening ────────────────────────────────────────────────────
        float mu   = max(0.001, vNormalView.z);
        float limb = 1.0 - 0.60 * (1.0 - mu);

        // ── Two-tier convection texture ───────────────────────────────────────
        float sgran = supergranulation(vUv, u_time);
        float gran  = granulation(vUv, u_time);

        // Blend: supergranulation sets the large-scale network structure,
        // granulation adds the fine boiling cell texture on top.
        float texture = sgran * 0.38 + gran * 0.62;

        // ── Base photosphere colour ───────────────────────────────────────────
        vec3 centerCol = vec3(1.00, 0.92, 0.62);
        vec3 limbCol   = vec3(0.78, 0.28, 0.04);
        vec3 baseCol   = mix(centerCol, limbCol, pow(1.0 - mu, 2.8));

        // Combined texture modulates brightness ±15%
        vec3 photCol = baseCol * (0.85 + 0.30 * texture) * max(0.5, u_bloom);

        // ── Chromospheric spicule fringe ──────────────────────────────────────
        float sp = spicules(vUv, mu, u_time);
        // Spicules are hot Hα jets — orange-red tint with bright emission
        photCol += vec3(1.0, 0.35, 0.08) * sp * 0.28 * max(0.5, u_bloom);

        // ── X-ray activity boost ──────────────────────────────────────────────
        float xBoost = 1.0 + u_xray_norm * 0.45;
        vec3 actCol  = photCol * xBoost;
        actCol.b    += u_xray_norm * 0.15;

        // ── Active region sunspot hotspots ────────────────────────────────────
        float totalUmbra    = 0.0;
        float totalPenumbra = 0.0;
        for (int k = 0; k < 8; k++) {
            if (k >= u_nRegions) break;
            vec3  arPos  = normalize(u_regions[k].xyz);
            float arInt  = u_regions[k].w;
            float cosAng = clamp(dot(vLocalPos, arPos), -1.0, 1.0);
            float ang    = acos(cosAng);
            float umbra  = exp(-ang * ang / (0.008 * arInt + 0.004)) * arInt;
            float penumb = smoothstep(0.28, 0.08, ang) * (1.0 - smoothstep(0.08, 0.0, ang)) * arInt;
            totalUmbra    += umbra;
            totalPenumbra += penumb;
        }
        totalUmbra    = clamp(totalUmbra,    0.0, 1.0);
        totalPenumbra = clamp(totalPenumbra, 0.0, 1.0);
        actCol = mix(actCol, actCol * 0.15, totalUmbra);
        actCol += vec3(1.0, 0.45, 0.05) * totalPenumbra * 0.35;

        // ── Post-flare UV arc glow at active region site ──────────────────────
        // When u_flare_arc > 0 a bright UV-blue arc appears at the flare source —
        // models the chromospheric evaporation hot plasma trapped in loop arcades.
        // u_flare_lon.x = latitude (rad), u_flare_lon.y = longitude (rad)
        if (u_flare_arc > 0.005) {
            vec3 flareSrc = normalize(vec3(
                cos(u_flare_lon.x) * cos(u_flare_lon.y),
                sin(u_flare_lon.x),
                cos(u_flare_lon.x) * sin(u_flare_lon.y)
            ));
            float cosFA = clamp(dot(vLocalPos, flareSrc), -1.0, 1.0);
            float arcAng = acos(cosFA);
            // Compact bright UV spot at source, fading soft halo around it
            float innerGlow = exp(-arcAng * arcAng / 0.006) * u_flare_arc;
            float outerGlow = exp(-arcAng * arcAng / 0.045) * u_flare_arc * 0.35;
            // Chromospheric evaporation: UV-blue at loop tops, orange-white at footpoints
            actCol += vec3(0.35, 0.60, 1.00) * innerGlow * 2.2;
            actCol += vec3(1.00, 0.82, 0.40) * outerGlow * 1.4;
        }

        // ── Flare flash (white-out) ───────────────────────────────────────────
        // Brief white-out on M/X flare trigger.
        float flash = u_flare_t * u_flare_t;
        actCol = mix(actCol, vec3(1.0, 0.97, 0.85), flash * 0.80);

        // ── Apply limb darkening ──────────────────────────────────────────────
        vec3 finalCol = actCol * limb;

        gl_FragColor = vec4(finalCol, 1.0);
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
        u_xray_norm: { value: 0.0 },
        u_flare_t:   { value: 0.0 },
        u_kp_norm:   { value: 0.0 },
        u_bloom:     { value: 1.0 },
        u_flare_arc: { value: 0.0 },
        u_flare_lon: { value: new THREE.Vector2(0, 0) },
        u_regions:   { value: regions },
        u_nRegions:  { value: 0 },
    };
}
