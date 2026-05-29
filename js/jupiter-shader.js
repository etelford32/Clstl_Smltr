/**
 * jupiter-shader.js — GLSL shaders for a detailed, *flowing* 3D Jupiter
 *
 * The atmosphere is treated as a 2D advected fluid painted on the sphere:
 * a latitude-dependent zonal-wind profile shears the cloud field, a
 * divergence-free curl-noise flow warps it (so eddies swirl rather than
 * just translate), and a meridional eddy-diffusion blur mixes detail across
 * jets. A second, higher ammonia-cloud layer casts shadows on the deck to
 * read as depth. Two clocks drive it:
 *
 *   u_time      — wall-clock seconds → continuous "always alive" churn.
 *   u_sim_days  — simulation days from J2000 → the evolution that tracks
 *                 the page's time controls (winds advect, the GRS drifts).
 *   u_epoch_year— decimal year → decadal evolution: the Great Red Spot
 *                 shrinks (Simon et al. 2018) and the SEB fades & revives.
 *
 * Quality tiers (u_quality):
 *   Q0 (low):    flat bands + limb darkening (far heliosphere view).
 *   Q1 (medium): zonal-wind shear, advected turbulence, GRS, cloud shadows.
 *   Q2 (high):   + curl-noise flow warp, Kelvin–Helmholtz billows at jets,
 *                meridional diffusion, jet-stream filaments.
 *
 * ── Atmospheric structure ───────────────────────────────────────────────
 *  Visible "surface" is the ~0.5 bar ammonia-ice cloud deck. Bright zones
 *  are upwelling, high NH₃ ice; dark belts are sinking air exposing
 *  chromophore-tinted NH₄SH. Zonal jets peak ~±150 m/s at band boundaries;
 *  the equatorial zone super-rotates (System I, 9h50m) faster than the rest
 *  (System II, 9h55m30s).
 *
 * ── Data-quality notes ──────────────────────────────────────────────────
 *  - Cloud bands / eddies are procedural, not observed imagery.
 *  - Zonal-wind profile is a smooth analytic approximation of the measured
 *    jet structure (Porco et al. 2003; Ingersoll et al. 2004), not a fit.
 *  - GRS diameter vs. epoch is an approximate fit to the historical record
 *    (~40,000 km in the 1880s → ~14,000 km today); longitude drift ≈
 *    1.25°/day in System II.
 *  - SEB fade/revival is a stylised ~7 yr oscillation, not a forecast.
 *
 * ── Physics references ──────────────────────────────────────────────────
 *  Ingersoll et al. (2004) "Dynamics of Jupiter's Atmosphere" (Jupiter, CUP)
 *  Porco et al. (2003) "Cassini Imaging of Jupiter's Atmosphere" Science 299
 *  Simon et al. (2018) "Trends in the Size, Drift, and Color of Jupiter's
 *    Great Red Spot" AJ 155, 151
 *  Bridson et al. (2007) "Curl-Noise for Procedural Fluid Flow" SIGGRAPH
 */

export const JUPITER_VERT = /* glsl */`
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

export const JUPITER_FRAG = /* glsl */`
    precision highp float;

    uniform float u_time;        // wall-clock seconds (continuous churn)
    uniform float u_quality;     // 0 / 1 / 2
    uniform float u_rot_phase;   // cumulative System-II rotation (radians)
    uniform float u_sim_days;    // simulation days from J2000 (evolution)
    uniform float u_epoch_year;  // decimal year (decadal evolution)
    uniform float u_diffusion;   // 0..1 meridional eddy-diffusion strength
    uniform float u_wind_scale;  // multiplies advection rate
    uniform sampler2D u_windTex; // measured zonal-wind profile (R = u encoded)
    uniform float u_useWindTex;  // >0.5 → sample u_windTex instead of analytic

    varying vec3 vNormalView;
    varying vec3 vLocalPos;
    varying vec2 vUv;

    #define PI 3.14159265359

    // ── Noise ───────────────────────────────────────────────────────────
    float hash2(vec2 p) {
        p = fract(p * vec2(127.1, 311.7));
        p += dot(p, p + 19.19);
        return fract(p.x * p.y);
    }
    float vnoise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(
            mix(hash2(i), hash2(i + vec2(1.0, 0.0)), f.x),
            mix(hash2(i + vec2(0.0, 1.0)), hash2(i + vec2(1.0, 1.0)), f.x),
            f.y
        );
    }
    float fbm(vec2 p, int octaves) {
        float v = 0.0, a = 0.5;
        for (int i = 0; i < 5; i++) {
            if (i >= octaves) break;
            v += a * vnoise(p);
            p *= 2.1;
            a *= 0.48;
        }
        return v;
    }

    // ── Divergence-free curl-noise flow (Bridson 2007) ──────────────────
    // velocity = ∇⊥ψ for a scalar potential ψ = fbm. Incompressible-looking
    // swirling flow — the "hydrodynamic" warp that makes eddies rotate.
    vec2 curlFlow(vec2 p) {
        float e = 0.012;
        float dx = fbm(p + vec2(e, 0.0), 3) - fbm(p - vec2(e, 0.0), 3);
        float dy = fbm(p + vec2(0.0, e), 3) - fbm(p - vec2(0.0, e), 3);
        return vec2(dy, -dx) / (2.0 * e);
    }

    // ── Zonal-wind profile u(lat) ───────────────────────────────────────
    // Normalised eastward velocity (units of WIND_PEAK_MS). lat in [-1, 1]
    // (S→N) maps to planetographic latitude lat*90°. When a measured profile
    // texture is supplied (u_useWindTex), it is sampled and decoded
    // (u_norm = R*2 - 1); otherwise a smooth analytic profile is used so
    // consumers that don't bind the texture still render sensibly.
    float zonalWind(float lat) {
        if (u_useWindTex > 0.5) {
            float r = texture2D(u_windTex, vec2(lat * 0.5 + 0.5, 0.5)).r;
            return r * 2.0 - 1.0;
        }
        float eq   = exp(-lat * lat / 0.018);             // equatorial super-rotation
        float jets = 0.55 * sin(lat * PI * 5.2);          // ~5 jets / hemisphere
        jets      *= smoothstep(0.04, 0.22, abs(lat));    // let the eq jet dominate near 0
        float pole = 1.0 - smoothstep(0.82, 1.0, abs(lat));
        return (1.15 * eq + jets) * pole;
    }
    // Meridional shear du/dlat — large at jet boundaries (KH-unstable).
    float windShear(float lat) {
        float e = 0.01;
        return (zonalWind(lat + e) - zonalWind(lat - e)) / (2.0 * e);
    }

    // ── Band colour palette ─────────────────────────────────────────────
    vec3 zoneColor(float lat) {
        vec3 eqZone  = vec3(0.92, 0.87, 0.72);
        vec3 midZone = vec3(0.88, 0.82, 0.68);
        vec3 polZone = vec3(0.72, 0.68, 0.60);
        float polFade = smoothstep(0.8, 1.0, abs(lat));
        return mix(mix(eqZone, midZone, abs(lat) * 1.5), polZone, polFade);
    }
    vec3 beltColor(float lat) {
        vec3 eqBelt  = vec3(0.62, 0.42, 0.22);
        vec3 midBelt = vec3(0.55, 0.40, 0.28);
        vec3 polBelt = vec3(0.40, 0.35, 0.32);
        float polFade = smoothstep(0.7, 1.0, abs(lat));
        return mix(mix(eqBelt, midBelt, abs(lat) * 1.2), polBelt, polFade);
    }

    // ── Band structure (zone=0 bright, belt=1 dark) ─────────────────────
    // flowUv is the wind-advected, curl-warped sample coordinate; dif
    // scales meridional eddy-diffusion blur of the turbulent detail.
    float bandPattern(float lat, vec2 flowUv, float t, float dif) {
        float bands = sin(lat * 22.0) * 0.5 + 0.5;

        float eqWidth = smoothstep(0.12, 0.0, abs(lat));
        bands = mix(bands, 0.0, eqWidth * 0.6);

        float sebZone = smoothstep(0.12, 0.08, lat) * smoothstep(-0.38, -0.12, lat);
        bands = mix(bands, 1.0, sebZone * 0.4);

        if (u_quality > 0.5) {
            // Turbulent band edges, advected with the flow.
            float turb = fbm(vec2(flowUv.x * 28.0, lat * 40.0), 3) * 0.15;
            // Meridional diffusion: average with a latitudinally-offset sample.
            if (dif > 0.001) {
                float turbN = fbm(vec2(flowUv.x * 28.0, (lat + 0.02) * 40.0), 2) * 0.15;
                turb = mix(turb, 0.5 * (turb + turbN), dif);
            }
            bands += turb;

            float chevron = vnoise(vec2(flowUv.x * 60.0 + lat * 20.0, lat * 80.0)) * 0.08;
            bands += chevron;
        }

        if (u_quality > 1.5) {
            // Kelvin–Helmholtz billows: oriented rolls where shear is high.
            // shN normalises shear so this works for both the measured-texture
            // profile (sharp jets → large shear) and the analytic fallback.
            float sh = windShear(lat);
            float shN = abs(sh) / 18.0;
            float rolls = sin(flowUv.x * 120.0 + sh * 4.0 + lat * 30.0);
            bands += rolls * 0.05 * smoothstep(0.35, 1.1, shN);
        }

        return clamp(bands, 0.0, 1.0);
    }

    // ── Great Red Spot diameter vs. epoch (km) ──────────────────────────
    // Approximate fit to the historical shrink: ~40,000 km (1880s) → ~14,000
    // km (mid-2020s); held flat outside the record.
    float grsDiameterKm(float year) {
        float y = clamp(year, 1880.0, 2050.0);
        return 14000.0 + 26000.0 * smoothstep(2024.0, 1880.0, y);
    }

    // ── Great Red Spot ──────────────────────────────────────────────────
    float grsPattern(vec2 flowUv, float lat, float t, float sizeScale) {
        if (u_quality < 0.5) return 0.0;

        float grsLat = -0.245;                                 // ~22° S (lat·90°)
        // Drifts ~1.25°/day in System II; rides the band flow via flowUv.
        float grsLon = fract(0.35 - u_sim_days * (1.25 / 360.0));

        float dlat = (lat - grsLat);
        float dlon = flowUv.x - grsLon;
        if (dlon > 0.5)  dlon -= 1.0;
        if (dlon < -0.5) dlon += 1.0;

        // Oval ~1.4:1, scaled by the epoch size factor.
        float dist = sqrt(dlon * dlon * 50.0 + dlat * dlat * 100.0) / sizeScale;
        float spot = 1.0 - smoothstep(0.0, 1.0, dist);

        if (u_quality > 1.5) {
            // Spiral circulation + a slightly hollow eye.
            float ang = atan(dlat, dlon);
            float spiral = vnoise(vec2(
                dist * 6.0 + sin(ang * 3.0 + t * 0.0008) * 2.0,
                ang * 4.0
            ));
            spot *= 0.72 + spiral * 0.28;
            spot *= 1.0 - 0.25 * smoothstep(0.45, 0.0, dist);   // hollow centre
        }
        return spot;
    }

    // ── Generic oval vortex ─────────────────────────────────────────────
    // Coverage [0,1] of an oval centred at (lonC, latC) in the advected flow
    // frame, with longitudinal/latitudinal radii (rx, ry). Used for the
    // smaller members of the vortex zoo (Oval BA, white ovals, brown barges).
    float ovalSpot(vec2 flowUv, float lat, float lonC, float latC, float rx, float ry) {
        float dlon = flowUv.x - lonC;
        if (dlon > 0.5)  dlon -= 1.0;
        if (dlon < -0.5) dlon += 1.0;
        float dlat = lat - latC;
        float d = sqrt((dlon * dlon) / (rx * rx) + (dlat * dlat) / (ry * ry));
        return 1.0 - smoothstep(0.0, 1.0, d);
    }

    void main() {
        float mu = max(0.001, vNormalView.z);
        float limb = 1.0 - 0.55 * (1.0 - mu);

        vec2 uv  = vUv;
        float lat = (uv.y - 0.5) * 2.0;

        // ── Advection: differential zonal shear + ambient spin ──────────
        // Sim-time drives the evolution; a small wall-clock term keeps the
        // flow alive while paused.
        float advT  = (u_sim_days * 0.65 + u_time * 0.06) * u_wind_scale;
        float spin  = u_time * 0.004 + u_rot_phase * 0.00001;
        float uWind = zonalWind(lat);
        float zonalPhase = uWind * advT * 0.02;
        vec2 flowUv = vec2(fract(uv.x + spin - zonalPhase), uv.y);

        // ── Curl-noise flow warp (Q2) ───────────────────────────────────
        if (u_quality > 1.5) {
            vec2 w = curlFlow(vec2(flowUv.x * 8.0, lat * 6.0) + advT * 0.05);
            flowUv += w * vec2(0.010, 0.006);
        }

        // ── Band field + colour (with SEB fade/revival) ─────────────────
        float band  = bandPattern(lat, flowUv, u_time, u_diffusion);
        vec3  zCol  = zoneColor(lat);
        vec3  bCol  = beltColor(lat);

        // SEB (~7-21° S) periodically fades toward zone colour, then revives.
        float sebMask = smoothstep(-0.24, -0.20, lat) * (1.0 - smoothstep(-0.10, -0.06, lat));
        float sebFade = 0.5 + 0.5 * sin(u_epoch_year * 6.2831853 / 7.0 + 1.0);
        bCol = mix(bCol, mix(bCol, zCol, 0.75), sebMask * sebFade);

        vec3 cloudCol = mix(zCol, bCol, band);
        float zoneMask = 1.0 - band;

        // ── Great Red Spot (epoch-scaled) ───────────────────────────────
        float grsScale = grsDiameterKm(u_epoch_year) / 16000.0;
        float grs = grsPattern(flowUv, lat, u_time, grsScale);
        if (grs > 0.01) {
            vec3 grsCol    = vec3(0.72, 0.28, 0.12);
            vec3 grsCenter = vec3(0.82, 0.42, 0.18);
            vec3 grsBlend  = mix(grsCol, grsCenter, grs * grs);
            cloudCol = mix(cloudCol, grsBlend, grs * 0.85);
        }

        // ── Vortex zoo (Q1+) — ride their bands, drift slowly in longitude ──
        if (u_quality > 0.5) {
            // Oval BA "Red Spot Jr." (~33° S), ~half the GRS, pale red.
            float ba = ovalSpot(flowUv, lat, fract(0.70 - u_sim_days * 0.0006),
                                -0.367, 0.045, 0.020);
            cloudCol = mix(cloudCol, vec3(0.80, 0.52, 0.42), ba * 0.7);

            // White ovals — southern temperate anticyclones (~40° S).
            float wo = ovalSpot(flowUv, lat, fract(0.20 - u_sim_days * 0.0009), -0.44, 0.030, 0.016)
                     + ovalSpot(flowUv, lat, fract(0.55 - u_sim_days * 0.0009), -0.45, 0.026, 0.015)
                     + ovalSpot(flowUv, lat, fract(0.85 - u_sim_days * 0.0009), -0.43, 0.028, 0.015);
            cloudCol = mix(cloudCol, vec3(0.96, 0.94, 0.88), clamp(wo, 0.0, 1.0) * 0.75);

            // Brown barges — elongated cyclones in the NEB (~16° N).
            float bb = ovalSpot(flowUv, lat, fract(0.30 + u_sim_days * 0.0011), 0.185, 0.060, 0.012)
                     + ovalSpot(flowUv, lat, fract(0.75 + u_sim_days * 0.0011), 0.185, 0.055, 0.012);
            cloudCol = mix(cloudCol, vec3(0.38, 0.26, 0.17), clamp(bb, 0.0, 1.0) * 0.6);
        }

        // ── Cloud texture + two-layer shadow depth (Q1+) ────────────────
        if (u_quality > 0.5) {
            float cloudNoise = fbm(flowUv * vec2(24.0, 12.0), 3);
            cloudCol *= 0.88 + cloudNoise * 0.24;

            // High ammonia cloud layer (forms in upwelling zones).
            float hi  = smoothstep(0.55, 0.82, fbm(flowUv * vec2(14.0, 7.0) + advT * 0.04, 3)) * zoneMask;
            // Shadow it casts on the deck, offset along the light direction.
            vec2  L   = normalize(vec2(0.85, 0.22));
            float shf = smoothstep(0.55, 0.82, fbm((flowUv - L * 0.018) * vec2(14.0, 7.0) + advT * 0.04, 3)) * zoneMask;
            cloudCol *= 1.0 - shf * 0.22;                                  // cast shadow → relief
            cloudCol  = mix(cloudCol, vec3(0.95, 0.93, 0.84), hi * 0.55);  // bright high tops
        }

        // ── Jet-stream filaments (Q2) — makes the wind data legible ─────
        // Bright sheared streaks trace the fastest jets of the measured
        // profile, so the wind structure reads directly off the planet.
        if (u_quality > 1.5) {
            float shN = abs(windShear(lat)) / 18.0;
            float jet = smoothstep(0.45, 1.2, shN);
            float streak = smoothstep(0.6, 1.0, sin(flowUv.x * 200.0 + lat * 50.0) * 0.5 + 0.5);
            cloudCol = mix(cloudCol, cloudCol * 1.18, jet * streak * 0.5);
        }

        // ── Polar darkening + blue haze ─────────────────────────────────
        float poleFade = smoothstep(0.7, 1.0, abs(lat));
        cloudCol = mix(cloudCol, vec3(0.35, 0.38, 0.48), poleFade * 0.45);

        // ── Atmospheric limb haze ───────────────────────────────────────
        vec3 hazeCol = vec3(0.45, 0.55, 0.75);
        float hazeFade = pow(1.0 - mu, 3.0);
        cloudCol = mix(cloudCol, hazeCol, hazeFade * 0.35);

        gl_FragColor = vec4(cloudCol * limb, 1.0);
    }
`;

/**
 * Create the uniform block for the Jupiter shader.
 *
 * New uniforms default to safe/present-day values so existing consumers
 * (solar-system.html, heliosphere3d.js, gravity-lab/visuals.js) that only
 * animate `u_time` keep rendering a sensible present-day Jupiter.
 *
 * @param {object} THREE  three.js namespace
 */
export function createJupiterUniforms(THREE) {
    // 1×1 neutral-wind default texture so the sampler is always bound even
    // when no measured profile is supplied (u_useWindTex stays 0 → analytic).
    const flat = new THREE.DataTexture(
        new Uint8Array([128, 128, 128, 255]), 1, 1, THREE.RGBAFormat,
    );
    flat.needsUpdate = true;
    return {
        u_time:       { value: 0.0 },
        u_quality:    { value: 1.0 },
        u_rot_phase:  { value: 0.0 },
        u_sim_days:   { value: 0.0 },
        u_epoch_year: { value: 2025.0 },   // present-day GRS by default
        u_diffusion:  { value: 0.6 },
        u_wind_scale: { value: 1.0 },
        u_windTex:    { value: flat },
        u_useWindTex: { value: 0.0 },
    };
}

/**
 * Great Red Spot diameter (km) as a function of decimal year — the JS twin
 * of the GLSL `grsDiameterKm`, so a UI readout matches what's rendered.
 * Approximate fit to the historical record (~40,000 km 1880s → 14,000 km now).
 */
export function grsDiameterKm(year) {
    const y = Math.max(1880, Math.min(2050, year));
    // GLSL smoothstep(2024, 1880, y)
    let t = (y - 2024) / (1880 - 2024);
    t = Math.max(0, Math.min(1, t));
    const s = t * t * (3 - 2 * t);
    return 14000 + 26000 * s;
}
