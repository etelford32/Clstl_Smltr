/**
 * sun-shader.js — GLSL shaders for the 3D photosphere sphere
 *
 * Features
 * ─────────
 *  • Multi-octave value-noise granulation (time-animated, boiling convection cells)
 *  • Solar limb darkening — linear law  I(μ) = 1 − u(1−μ),  u ≈ 0.6
 *  • Chromosphere limb colour gradient (yellow-white center → deep orange-red limb)
 *  • X-ray flux brightness/colour boost (driven by live GOES data)
 *  • Active-region sunspot hotspots — up to 8 vec4(xyz_unit, intensity)
 *    Each region shows a dark umbra + bright orange penumbra glow
 *  • Flare flash uniform — brief white-out at M/X flare trigger (decays per-frame)
 *
 * Uniforms set by heliosphere3d.js _tickSun():
 *   u_time       float   elapsed seconds (drives granulation animation)
 *   u_xray_norm  float   0–1 log-normalised GOES X-ray flux
 *   u_flare_t    float   0–1 flash intensity (decays after trigger)
 *   u_kp_norm    float   0–1  Kp/9
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
    uniform vec4  u_regions[8];
    uniform int   u_nRegions;

    varying vec3 vNormalView;
    varying vec3 vLocalPos;
    varying vec2 vUv;

    // ── Hash / noise ─────────────────────────────────────────────────────────────

    float hash2(vec2 p) {
        p  = fract(p * vec2(127.1, 311.7));
        p += dot(p, p + 19.19);
        return fract(p.x * p.y);
    }

    float vnoise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);   // smoothstep
        return mix(
            mix(hash2(i),                   hash2(i + vec2(1.0, 0.0)), f.x),
            mix(hash2(i + vec2(0.0, 1.0)),  hash2(i + vec2(1.0, 1.0)), f.x),
            f.y
        );
    }

    // ── Three-octave granulation texture (boiling convection cells) ──────────────
    // Mimics the ~1 Mm solar granulation: bright hot cell interiors separated by
    // narrow dark intergranular lanes.  Animation rate kept slow (~2 min/cell lifetime).

    float granulation(vec2 uv, float t) {
        float n = vnoise(uv *  7.0  + vec2( t * 0.016,  t * 0.011)) * 0.50
                + vnoise(uv * 15.0  + vec2(-t * 0.025,  t * 0.018)) * 0.30
                + vnoise(uv * 31.0  + vec2( t * 0.041, -t * 0.035)) * 0.20;
        // Sharpen: squeeze to [0,1] with high contrast so lanes are clearly dark
        return smoothstep(0.30, 0.70, n);
    }

    void main() {
        // ── Limb darkening ────────────────────────────────────────────────────────
        // μ = N·V in view space (z-component of view-space normal).
        // μ = 1.0 at disk center, 0.0 at the geometric limb.
        float mu   = max(0.001, vNormalView.z);
        float limb = 1.0 - 0.60 * (1.0 - mu);   // linear law, u = 0.6

        // ── Granulation ───────────────────────────────────────────────────────────
        float gran = granulation(vUv, u_time);

        // ── Base photosphere colour ───────────────────────────────────────────────
        // Disk center ≈ 5778 K → warm yellow-white.
        // Limb ≈ cooler chromosphere → deep orange-red.
        // Power-law blend ensures narrow bright center and wide warm limb zone.
        vec3 centerCol = vec3(1.00, 0.92, 0.62);
        vec3 limbCol   = vec3(0.78, 0.28, 0.04);
        vec3 baseCol   = mix(centerCol, limbCol, pow(1.0 - mu, 2.8));

        // Granulation modulates brightness ±12% — bright interiors, dark lanes
        vec3 photCol = baseCol * (0.88 + 0.24 * gran);

        // ── X-ray activity boost ──────────────────────────────────────────────────
        // High GOES flux → corona brighter, slight blue-white shift (hotter)
        float xBoost = 1.0 + u_xray_norm * 0.45;
        vec3 actCol  = photCol * xBoost;
        actCol.b    += u_xray_norm * 0.15;   // blue-white tint under X-class

        // ── Active region / sunspot hotspots ──────────────────────────────────────
        // Each region is a vec4: xyz = unit-sphere direction in local mesh space,
        // w = intensity (0–1, scaled from area_norm and magnetic complexity).
        // Distance on the sphere surface: angDist = acos(dot(vLocalPos, arPos)).
        //   Umbra:    angDist < 0.10 rad (~6°)  → dark core
        //   Penumbra: 0.10–0.26 rad (~15°)      → bright orange rim
        float totalUmbra   = 0.0;
        float totalPenumbra = 0.0;
        for (int k = 0; k < 8; k++) {
            if (k >= u_nRegions) break;
            vec3  arPos  = normalize(u_regions[k].xyz);
            float arInt  = u_regions[k].w;
            float cosAng = clamp(dot(vLocalPos, arPos), -1.0, 1.0);
            float ang    = acos(cosAng);
            // Umbra: gaussian dark core
            float umbra  = exp(-ang * ang / (0.008 * arInt + 0.004)) * arInt;
            // Penumbra: broader soft ring
            float penumb = smoothstep(0.28, 0.08, ang) * (1.0 - smoothstep(0.08, 0.0, ang)) * arInt;
            totalUmbra    += umbra;
            totalPenumbra += penumb;
        }
        totalUmbra    = clamp(totalUmbra,    0.0, 1.0);
        totalPenumbra = clamp(totalPenumbra, 0.0, 1.0);
        // Darken umbra, add orange penumbra glow
        actCol = mix(actCol, actCol * 0.15, totalUmbra);
        actCol += vec3(1.0, 0.45, 0.05) * totalPenumbra * 0.35;

        // ── Flare flash ───────────────────────────────────────────────────────────
        // Brief white-out on M/X flare trigger.  u_flare_t is set to 1.0 at trigger
        // and decays in _tickSun() so we just map it here.
        float flash = u_flare_t * u_flare_t;
        actCol = mix(actCol, vec3(1.0, 0.97, 0.85), flash * 0.80);

        // ── Apply limb darkening ──────────────────────────────────────────────────
        vec3 finalCol = actCol * limb;

        // The sun sphere is purely emissive — output full HDR colour directly.
        gl_FragColor = vec4(finalCol, 1.0);
    }
`;

/**
 * Create the uniform block for the sun ShaderMaterial.
 * THREE must be passed in because this module is loaded as a plain ES module
 * without a bundler-resolved THREE import.
 *
 * @param {object} THREE  three.js namespace
 * @returns {object}      uniform descriptor object
 */
export function createSunUniforms(THREE) {
    // Initialise 8 dummy region vectors pointing to "north pole" with zero intensity.
    const regions = [];
    for (let i = 0; i < 8; i++) regions.push(new THREE.Vector4(0, 1, 0, 0));
    return {
        u_time:      { value: 0.0 },
        u_xray_norm: { value: 0.0 },
        u_flare_t:   { value: 0.0 },
        u_kp_norm:   { value: 0.0 },
        u_regions:   { value: regions },
        u_nRegions:  { value: 0 },
    };
}
