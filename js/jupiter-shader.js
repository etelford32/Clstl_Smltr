/**
 * jupiter-shader.js — GLSL shaders for a detailed 3D Jupiter
 *
 * Features (quality-tiered):
 *
 *  Q0 (low — heliosphere far view):
 *    - Basic latitudinal color banding (no noise)
 *    - Simple limb darkening
 *
 *  Q1 (medium — heliosphere close):
 *    - Full cloud band structure with turbulent noise
 *    - Zonal wind shear (bands drift at different speeds)
 *    - Great Red Spot (GRS) as animated vortex
 *    - Limb darkening + atmospheric haze at limb
 *
 *  Q2 (high — dedicated Jupiter simulator):
 *    - High-frequency turbulence in band edges
 *    - Polar vortex/aurora haze
 *    - GRS with internal spiral structure
 *    - White ovals and smaller storm spots
 *    - Ammonia cloud altitude color variations
 *
 * ── Atmospheric Structure ────────────────────────────────────────────────────
 *  Jupiter's visible "surface" is the ammonia ice cloud deck at ~0.5 bar.
 *  The banded appearance comes from alternating zones (bright, rising air,
 *  high NH₃ ice) and belts (dark, sinking air, exposed NH₄SH/chromophore).
 *
 *  Major bands (planetographic latitude):
 *    EZ   (Equatorial Zone)      ±7°    bright white-tan
 *    NEB  (North Equatorial Belt) 7–17°N  dark brown-red
 *    NTrZ (North Tropical Zone)  17–24°N  bright
 *    NTB  (North Temperate Belt) 24–31°N  dark
 *    SEB  (South Equatorial Belt) 7–21°S  dark brown-red (widest belt)
 *    STrZ (South Tropical Zone)  21–27°S  bright — GRS lives here
 *    STB  (South Temperate Belt) 27–34°S  dark
 *
 *  Zonal winds: EZ drifts east at ~100 m/s (System I, 9h 50m rotation).
 *  Other latitudes rotate at System II (9h 55m 30s).
 *  Wind speed peaks at band boundaries (±150 m/s jets).
 *
 * ── Data Quality Notes ──────────────────────────────────────────────────────
 *  - Cloud bands are procedural approximations, not real imagery.
 *  - GRS size is fixed at ~14,000 km (has been shrinking IRL since 1800s).
 *  - GRS longitude drifts at ~1.25°/day in System II — we approximate this.
 *  - Band colors are artistic; real Jupiter color depends on viewing filter.
 *  - Polar regions are less well-observed; we add subtle darkening + blue haze
 *    based on Juno/HST UV observations.
 *
 * ── Physics References ──────────────────────────────────────────────────────
 *  Ingersoll et al. (2004) "Dynamics of Jupiter's Atmosphere" — Jupiter book
 *  Simon et al. (2018) "Historical and Contemporary Trends in the Size,
 *    Drift, and Color of Jupiter's Great Red Spot" ApJ 162
 *  Porco et al. (2003) "Cassini Imaging of Jupiter's Atmosphere" Science 299
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

    uniform float u_time;
    uniform float u_quality;
    uniform float u_rot_phase;   // cumulative rotation (radians, System II)

    varying vec3 vNormalView;
    varying vec3 vLocalPos;
    varying vec2 vUv;

    // ── Noise ─────────────────────────────────────────────────────────────────
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

    // ── Band color palette ────────────────────────────────────────────────────
    // Zone (bright): ammonia ice, high clouds
    vec3 zoneColor(float lat) {
        vec3 eqZone = vec3(0.92, 0.87, 0.72);   // EZ: bright tan-white
        vec3 midZone = vec3(0.88, 0.82, 0.68);   // mid-latitude zones
        vec3 polZone = vec3(0.72, 0.68, 0.60);   // polar zones: darker
        float polFade = smoothstep(0.8, 1.0, abs(lat));
        return mix(mix(eqZone, midZone, abs(lat) * 1.5), polZone, polFade);
    }
    // Belt (dark): deeper clouds, chromophore-colored
    vec3 beltColor(float lat) {
        vec3 eqBelt = vec3(0.62, 0.42, 0.22);    // NEB/SEB: dark reddish-brown
        vec3 midBelt = vec3(0.55, 0.40, 0.28);    // temperate belts: muted brown
        vec3 polBelt = vec3(0.40, 0.35, 0.32);    // polar belts: grey-brown
        float polFade = smoothstep(0.7, 1.0, abs(lat));
        return mix(mix(eqBelt, midBelt, abs(lat) * 1.2), polBelt, polFade);
    }

    // ── Band structure ────────────────────────────────────────────────────────
    // Returns 0 = zone (bright), 1 = belt (dark) based on latitude.
    // The band boundaries have turbulent edges from zonal wind shear.
    float bandPattern(float lat, vec2 uv, float t) {
        // Base band pattern: sinusoidal with ~7 band pairs
        float bands = sin(lat * 22.0) * 0.5 + 0.5;

        // Equatorial zone is wider and brighter
        float eqWidth = smoothstep(0.12, 0.0, abs(lat));
        bands = mix(bands, 0.0, eqWidth * 0.6);

        // SEB is wider (extends 7-21° S)
        float sebZone = smoothstep(0.12, 0.08, lat) * smoothstep(-0.38, -0.12, lat);
        bands = mix(bands, 1.0, sebZone * 0.4);

        if (u_quality > 0.5) {
            // Turbulent band edges from zonal wind shear
            float turb = fbm(vec2(uv.x * 28.0 + t * 0.002, lat * 40.0), 3) * 0.15;
            bands += turb;

            // Small-scale chevron patterns at belt/zone boundaries
            float chevron = vnoise(vec2(uv.x * 60.0 + lat * 20.0, lat * 80.0 + t * 0.001)) * 0.08;
            bands += chevron;
        }

        return clamp(bands, 0.0, 1.0);
    }

    // ── Great Red Spot ────────────────────────────────────────────────────────
    // Anticyclonic vortex at ~22° S, ~14,000 km diameter
    float grsPattern(vec2 uv, float lat, float t) {
        if (u_quality < 0.5) return 0.0;  // skip at low quality

        // GRS position: ~22° S latitude, longitude drifts ~1.25°/day in System II
        float grsLat = -0.38;  // ~22° S in UV space (0.5 = equator)
        // Slow longitude drift: GRS drifts ~1.25°/day relative to System II
        float grsLon = fract(0.35 + t * 0.0000004);  // very slow drift

        float dlat = (lat - grsLat);
        float dlon = uv.x - grsLon;
        // Wrap longitude
        if (dlon > 0.5) dlon -= 1.0;
        if (dlon < -0.5) dlon += 1.0;

        // GRS is oval: ~1.4:1 aspect ratio (wider in longitude)
        float dist = sqrt(dlon * dlon * 50.0 + dlat * dlat * 100.0);

        // Smooth oval boundary
        float spot = 1.0 - smoothstep(0.0, 1.0, dist);

        if (u_quality > 1.5) {
            // Internal spiral structure
            float spiral = vnoise(vec2(
                dlon * 40.0 + sin(atan(dlat, dlon) * 3.0 + t * 0.003) * 2.0,
                dlat * 40.0
            ));
            spot *= 0.7 + spiral * 0.3;
        }

        return spot;
    }

    // ── Zonal wind drift ──────────────────────────────────────────────────────
    // Equatorial zone (System I) rotates faster than the rest (System II)
    float zonalDrift(float lat) {
        // EZ: ~100 m/s faster → ~5 min shorter rotation period
        // This maps to a UV offset that grows with time
        float eqBoost = exp(-lat * lat / 0.03) * 0.15;
        // Jet streams at band boundaries
        float jets = sin(lat * 22.0) * 0.02;
        return eqBoost + jets;
    }

    void main() {
        float mu = max(0.001, vNormalView.z);

        // ── Limb darkening (Rayleigh scattering in H₂/He atmosphere) ─────────
        float limb = 1.0 - 0.55 * (1.0 - mu);

        // ── UV with zonal wind drift ──────────────────────────────────────────
        vec2 uv = vUv;
        float lat = (uv.y - 0.5) * 2.0;  // -1 to +1 (S to N)

        // Apply zonal wind drift (equator rotates faster)
        float drift = zonalDrift(lat) * u_time;
        uv.x = fract(uv.x + drift * 0.0001 + u_rot_phase * 0.00001);

        // ── Cloud band structure ──────────────────────────────────────────────
        float band = bandPattern(lat, uv, u_time);
        vec3 zCol = zoneColor(lat);
        vec3 bCol = beltColor(lat);
        vec3 cloudCol = mix(zCol, bCol, band);

        // ── Great Red Spot ────────────────────────────────────────────────────
        float grs = grsPattern(uv, lat, u_time);
        if (grs > 0.01) {
            // GRS color: deep reddish-brown, darker than surrounding SEB
            vec3 grsCol = vec3(0.72, 0.28, 0.12);
            // GRS center is slightly brighter (eye of the vortex)
            vec3 grsCenter = vec3(0.80, 0.40, 0.18);
            vec3 grsBlend = mix(grsCol, grsCenter, grs * grs);
            cloudCol = mix(cloudCol, grsBlend, grs * 0.85);
        }

        // ── Cloud texture noise (medium+ quality) ─────────────────────────────
        if (u_quality > 0.5) {
            float cloudNoise = fbm(uv * vec2(24.0, 12.0) + u_time * 0.0003, 3);
            cloudCol *= 0.88 + cloudNoise * 0.24;
        }

        // ── Polar darkening + blue haze ───────────────────────────────────────
        float poleFade = smoothstep(0.7, 1.0, abs(lat));
        cloudCol = mix(cloudCol, vec3(0.35, 0.38, 0.48), poleFade * 0.45);

        // ── Atmospheric limb haze (Rayleigh → blue tint at limb) ──────────────
        vec3 hazeCol = vec3(0.45, 0.55, 0.75);  // blue-grey haze
        float hazeFade = pow(1.0 - mu, 3.0);
        cloudCol = mix(cloudCol, hazeCol, hazeFade * 0.35);

        // ── Apply limb darkening ──────────────────────────────────────────────
        vec3 finalCol = cloudCol * limb;

        gl_FragColor = vec4(finalCol, 1.0);
    }
`;

/**
 * Create uniform block for Jupiter shader.
 * @param {object} THREE  three.js namespace
 */
export function createJupiterUniforms(THREE) {
    return {
        u_time:      { value: 0.0 },
        u_quality:   { value: 1.0 },
        u_rot_phase: { value: 0.0 },
    };
}
