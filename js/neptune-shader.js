/**
 * neptune-shader.js — GLSL shaders for a detailed 3D Neptune
 *
 * Neptune is a deep-blue ice giant. Unlike Jupiter's busy belt/zone structure,
 * Neptune shows a comparatively muted disc dominated by:
 *
 *  - A deep azure base colour. Methane (CH₄) in the upper atmosphere absorbs
 *    red light strongly; the residual scattered light is blue. (Methane alone
 *    does not explain why Neptune is *bluer* than Uranus — an unknown second
 *    chromophore / haze is implicated — so the base tint here is artistic.)
 *  - Faint zonal banding, much lower contrast than Jupiter.
 *  - The Great Dark Spot (GDS-89): an anticyclonic vortex at ~22°S that
 *    Voyager 2 imaged in 1989. It is *transient* — gone by the 1994 HST images,
 *    with new dark spots appearing since. We render one canonical GDS plus a
 *    bright methane-ice "companion cloud" on its equatorward flank.
 *  - Bright high-altitude methane cirrus streaks ("Scooter" and friends) that
 *    cast shadows in Voyager imagery — Neptune's clouds sit *above* the main
 *    deck, unlike Jupiter's.
 *  - A brighter south-polar region (the pole facing the Sun in 1989).
 *
 * ── Winds ────────────────────────────────────────────────────────────────────
 *  Neptune has the fastest winds in the Solar System: the equatorial jet blows
 *  *retrograde* (westward, against rotation) at up to ~400 m/s relative to the
 *  interior, reaching ~2,100 km/h in places. Mid-latitudes are prograde. We
 *  encode that latitude-dependent drift so the cloud features shear realistically.
 *
 * ── Quality tiers ────────────────────────────────────────────────────────────
 *  Q0 (low): flat banding + limb darkening.
 *  Q1 (medium): turbulent bands, GDS + companion cloud, cirrus streaks.
 *  Q2 (high): internal vortex spiral, extra dark spots, brighter cirrus,
 *             south-polar haze detail.
 *
 * ── References ───────────────────────────────────────────────────────────────
 *  Smith et al. (1989) "Voyager 2 at Neptune: Imaging Science Results" Science 246
 *  Sromovsky et al. (2001) "Neptune's Atmospheric Circulation and Cloud Morphology"
 *  Hammel et al. (1995) — disappearance of the Great Dark Spot (HST)
 *  Irwin et al. (2022) — Uranus/Neptune aerosol layers (why Neptune is bluer)
 */

export const NEPTUNE_VERT = /* glsl */`
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

export const NEPTUNE_FRAG = /* glsl */`
    precision highp float;

    uniform float u_time;
    uniform float u_quality;
    uniform float u_rot_phase;   // cumulative rotation (radians)

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

    // ── Band colour palette (low-contrast, blue) ────────────────────────────────
    vec3 zoneColor(float lat) {
        vec3 eqZone  = vec3(0.16, 0.36, 0.74);   // equatorial: slightly lighter azure
        vec3 midZone = vec3(0.13, 0.31, 0.70);   // mid-latitude
        vec3 polZone = vec3(0.22, 0.42, 0.72);   // brighter near poles (S-polar haze)
        float polFade = smoothstep(0.7, 1.0, abs(lat));
        return mix(mix(eqZone, midZone, abs(lat) * 1.3), polZone, polFade);
    }
    vec3 beltColor(float lat) {
        vec3 eqBelt  = vec3(0.10, 0.24, 0.60);   // deeper blue belts
        vec3 midBelt = vec3(0.09, 0.22, 0.58);
        vec3 polBelt = vec3(0.14, 0.30, 0.62);
        float polFade = smoothstep(0.7, 1.0, abs(lat));
        return mix(mix(eqBelt, midBelt, abs(lat) * 1.1), polBelt, polFade);
    }

    // Faint zonal banding (much lower contrast than Jupiter)
    float bandPattern(float lat, vec2 uv, float t) {
        float bands = sin(lat * 13.0) * 0.5 + 0.5;
        // Equatorial belt is broad and a touch darker
        float eqBand = smoothstep(0.22, 0.0, abs(lat));
        bands = mix(bands, 0.72, eqBand * 0.4);

        if (u_quality > 0.5) {
            float turb = fbm(vec2(uv.x * 18.0 + t * 0.001, lat * 26.0), 3) * 0.10;
            bands += turb;
        }
        return clamp(bands, 0.0, 1.0);
    }

    // ── Great Dark Spot (anticyclone at ~22°S) + bright companion cloud ──────────
    // Returns vec2(darkSpot, brightCompanion) in [0,1].
    vec2 darkSpotPattern(vec2 uv, float lat, float t) {
        if (u_quality < 0.5) return vec2(0.0);

        // GDS at ~22°S (lat -0.40 in [-1,1] space). Drifts slowly in longitude.
        float gdsLat = -0.40;
        float gdsLon = fract(0.30 - t * 0.0000006);   // slow westward drift

        float dlat = lat - gdsLat;
        float dlon = uv.x - gdsLon;
        if (dlon >  0.5) dlon -= 1.0;
        if (dlon < -0.5) dlon += 1.0;

        // Oval ~2:1 (wider in longitude)
        float dist = sqrt(dlon * dlon * 38.0 + dlat * dlat * 95.0);
        float spot = 1.0 - smoothstep(0.0, 1.0, dist);

        if (u_quality > 1.5) {
            float spiral = vnoise(vec2(
                dlon * 36.0 + sin(atan(dlat, dlon) * 3.0 + t * 0.004) * 2.0,
                dlat * 36.0
            ));
            spot *= 0.72 + spiral * 0.28;
        }

        // Bright methane companion cloud on the equatorward flank of the GDS.
        float cdlat = lat - (gdsLat + 0.10);
        float cdlon = dlon + 0.02;
        float cdist = sqrt(cdlon * cdlon * 90.0 + cdlat * cdlat * 220.0);
        float comp  = (1.0 - smoothstep(0.0, 1.0, cdist)) * 0.9;

        // A secondary smaller dark spot in the north at high quality.
        float spot2 = 0.0;
        if (u_quality > 1.5) {
            float s2lat = lat - 0.34;
            float s2lon = uv.x - fract(0.72 + t * 0.0000010);
            if (s2lon >  0.5) s2lon -= 1.0;
            if (s2lon < -0.5) s2lon += 1.0;
            float d2 = sqrt(s2lon * s2lon * 70.0 + s2lat * s2lat * 150.0);
            spot2 = (1.0 - smoothstep(0.0, 1.0, d2)) * 0.7;
        }

        return vec2(max(spot, spot2), comp);
    }

    // Bright high-altitude methane cirrus streaks (above the main deck).
    float cirrusPattern(vec2 uv, float lat, float t) {
        if (u_quality < 0.5) return 0.0;
        // Streaks concentrated at mid southern + mid northern latitudes.
        float streak = fbm(vec2(uv.x * 40.0 + t * 0.002, lat * 8.0), 3);
        streak = smoothstep(0.62, 0.95, streak);
        float latMask = smoothstep(0.18, 0.45, abs(lat)) * smoothstep(0.85, 0.55, abs(lat));
        return streak * latMask;
    }

    // ── Zonal wind drift (equatorial RETROGRADE jet, the signature of Neptune) ──
    float zonalDrift(float lat) {
        // Strong westward (retrograde) flow at the equator, prograde mid-lats.
        float eqRetro =  exp(-lat * lat / 0.05) * (-0.22);   // negative = westward
        float midPro  = (sin(lat * 6.0)) * 0.06;
        return eqRetro + midPro;
    }

    void main() {
        float mu = max(0.001, vNormalView.z);

        // Limb darkening (Rayleigh/methane haze)
        float limb = 1.0 - 0.50 * (1.0 - mu);

        vec2 uv = vUv;
        float lat = (uv.y - 0.5) * 2.0;   // -1 (S) .. +1 (N)

        // Latitude-dependent zonal drift (Neptune's fierce winds)
        float drift = zonalDrift(lat) * u_time;
        uv.x = fract(uv.x + drift * 0.00012 + u_rot_phase * 0.00001);

        // Base banded cloud colour
        float band = bandPattern(lat, uv, u_time);
        vec3 cloudCol = mix(zoneColor(lat), beltColor(lat), band);

        // Subtle cloud texture
        if (u_quality > 0.5) {
            float cloudNoise = fbm(uv * vec2(18.0, 9.0) + u_time * 0.0004, 3);
            cloudCol *= 0.90 + cloudNoise * 0.18;
        }

        // Great Dark Spot + companion cloud
        vec2 spots = darkSpotPattern(uv, lat, u_time);
        if (spots.x > 0.01) {
            vec3 darkCol = vec3(0.05, 0.12, 0.34);   // very deep blue-black
            cloudCol = mix(cloudCol, darkCol, spots.x * 0.85);
        }
        if (spots.y > 0.01) {
            vec3 compCol = vec3(0.86, 0.92, 0.98);   // bright methane ice
            cloudCol = mix(cloudCol, compCol, spots.y * 0.6);
        }

        // Bright cirrus streaks
        float cirrus = cirrusPattern(uv, lat, u_time);
        cloudCol = mix(cloudCol, vec3(0.82, 0.90, 0.98), cirrus * 0.5);

        // Brighter, hazier south pole (sunlit pole in 1989)
        float spole = smoothstep(0.55, 1.0, -lat);
        cloudCol = mix(cloudCol, vec3(0.30, 0.50, 0.78), spole * 0.30);

        // Atmospheric limb haze → lighter blue at the limb
        vec3 hazeCol = vec3(0.40, 0.58, 0.85);
        float hazeFade = pow(1.0 - mu, 3.0);
        cloudCol = mix(cloudCol, hazeCol, hazeFade * 0.40);

        vec3 finalCol = cloudCol * limb;
        gl_FragColor = vec4(finalCol, 1.0);
    }
`;

/**
 * Create uniform block for the Neptune shader.
 * @param {object} THREE  three.js namespace
 */
export function createNeptuneUniforms(THREE) {
    return {
        u_time:      { value: 0.0 },
        u_quality:   { value: 1.0 },
        u_rot_phase: { value: 0.0 },
    };
}
