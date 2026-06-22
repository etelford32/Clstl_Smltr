/**
 * uranus-shader.js — GLSL shaders for a detailed 3D Uranus
 *
 * Uranus is the blandest planet in the Solar System to the eye. Where Neptune
 * shows dark spots and bright cirrus, Voyager 2 (1986) found Uranus almost
 * featureless: a smooth, pale cyan disc. The colour and the (lack of) structure
 * come from:
 *
 *  - A pale greenish-cyan base. Methane (CH₄) absorbs red light; the residual
 *    scattered light is cyan. A deep, sluggish haze layer mutes any contrast,
 *    so Uranus looks far blander than Neptune even though both are ice giants.
 *    (Irwin et al. 2024 re-balanced the Voyager colours: Uranus is a pale
 *    green-cyan, not the saturated turquoise of older composites.)
 *  - Extremely faint zonal banding — only visible at all in heavily stretched
 *    images, far lower contrast than Neptune, let alone Jupiter.
 *  - A bright polar "hood": a thick, high methane-haze cap over the summer pole.
 *    Because Uranus is tipped 97.8°, a pole faces the Sun for ~42 years at a
 *    time; the sunlit pole develops the bright hood and a polar collar. As of
 *    the 2020s the north pole is rotating into sunlight ahead of the 2030
 *    northern solstice and has visibly brightened.
 *  - Sparse discrete bright methane-ice cloud spots at mid-northern latitudes —
 *    the only high-contrast features Keck/HST ever resolve.
 *
 * ── Winds ────────────────────────────────────────────────────────────────────
 *  Uranus's winds blow retrograde (westward) at the equator (~ −100 m/s) and
 *  prograde at high latitudes (up to ~+200 m/s near ±60°). We encode that
 *  latitude-dependent drift so the few cloud features shear realistically.
 *
 * ── Quality tiers ────────────────────────────────────────────────────────────
 *  Q0 (low): flat banding + limb darkening + polar hood.
 *  Q1 (medium): faint turbulent bands, polar collar, a couple of cloud spots.
 *  Q2 (high): more cloud spots, brighter polar hood mottling, haze detail.
 *
 * ── References ───────────────────────────────────────────────────────────────
 *  Smith et al. (1986) "Voyager 2 in the Uranian System" Science 233
 *  Sromovsky & Fry (2005) "Dynamics of cloud features on Uranus" Icarus 179
 *  de Pater et al. (2015) "Record-setting Uranus storms" (Keck)
 *  Irwin et al. (2024) "Colour of Uranus and Neptune" MNRAS
 */

export const URANUS_VERT = /* glsl */`
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

export const URANUS_FRAG = /* glsl */`
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

    // ── Band colour palette (pale cyan, very low contrast) ──────────────────────
    vec3 zoneColor(float lat) {
        vec3 eqZone  = vec3(0.42, 0.69, 0.71);   // equatorial: pale cyan
        vec3 midZone = vec3(0.39, 0.66, 0.70);   // mid-latitude
        vec3 polZone = vec3(0.58, 0.80, 0.79);   // brighter near the hood
        float polFade = smoothstep(0.7, 1.0, abs(lat));
        return mix(mix(eqZone, midZone, abs(lat) * 1.2), polZone, polFade);
    }
    vec3 beltColor(float lat) {
        vec3 eqBelt  = vec3(0.35, 0.62, 0.67);   // marginally deeper belts
        vec3 midBelt = vec3(0.33, 0.60, 0.66);
        vec3 polBelt = vec3(0.50, 0.74, 0.75);
        float polFade = smoothstep(0.7, 1.0, abs(lat));
        return mix(mix(eqBelt, midBelt, abs(lat) * 1.05), polBelt, polFade);
    }

    // Faint zonal banding (even lower contrast than Neptune)
    float bandPattern(float lat, vec2 uv, float t) {
        float bands = sin(lat * 11.0) * 0.5 + 0.5;
        // Broad, faintly darker equatorial belt.
        float eqBand = smoothstep(0.20, 0.0, abs(lat));
        bands = mix(bands, 0.62, eqBand * 0.30);

        if (u_quality > 0.5) {
            float turb = fbm(vec2(uv.x * 14.0 + t * 0.0006, lat * 22.0), 3) * 0.06;
            bands += turb;
        }
        return clamp(bands, 0.0, 1.0);
    }

    // ── Sparse discrete bright methane-ice cloud spots (mid-N latitudes) ─────────
    float cloudSpots(vec2 uv, float lat, float t) {
        if (u_quality < 0.5) return 0.0;
        // A few small bright ovals that drift slowly westward.
        float total = 0.0;
        // spot A — bright northern cloud
        {
            float sLat = 0.42;
            float sLon = fract(0.20 - t * 0.0000011);
            float dlat = lat - sLat;
            float dlon = uv.x - sLon;
            if (dlon >  0.5) dlon -= 1.0;
            if (dlon < -0.5) dlon += 1.0;
            float d = sqrt(dlon * dlon * 220.0 + dlat * dlat * 360.0);
            total += (1.0 - smoothstep(0.0, 1.0, d)) * 0.9;
        }
        if (u_quality > 1.5) {
            // spot B — fainter southern cloud
            float sLat = -0.36;
            float sLon = fract(0.66 + t * 0.0000009);
            float dlat = lat - sLat;
            float dlon = uv.x - sLon;
            if (dlon >  0.5) dlon -= 1.0;
            if (dlon < -0.5) dlon += 1.0;
            float d = sqrt(dlon * dlon * 260.0 + dlat * dlat * 420.0);
            total += (1.0 - smoothstep(0.0, 1.0, d)) * 0.7;
            // spot C — small bright knot
            float s2Lat = 0.55;
            float s2Lon = fract(0.85 - t * 0.0000013);
            float d2lat = lat - s2Lat;
            float d2lon = uv.x - s2Lon;
            if (d2lon >  0.5) d2lon -= 1.0;
            if (d2lon < -0.5) d2lon += 1.0;
            float d2 = sqrt(d2lon * d2lon * 340.0 + d2lat * d2lat * 520.0);
            total += (1.0 - smoothstep(0.0, 1.0, d2)) * 0.6;
        }
        return clamp(total, 0.0, 1.0);
    }

    // ── Zonal wind drift (equatorial retrograde, high-lat prograde) ─────────────
    float zonalDrift(float lat) {
        float eqRetro = exp(-lat * lat / 0.06) * (-0.10);    // westward at equator
        float midPro  = sin(lat * 3.2) * lat * 0.20;          // prograde toward ±60°
        return eqRetro + midPro;
    }

    void main() {
        float mu = max(0.001, vNormalView.z);

        // Limb darkening (Rayleigh + thick methane haze)
        float limb = 1.0 - 0.46 * (1.0 - mu);

        vec2 uv = vUv;
        float lat = (uv.y - 0.5) * 2.0;   // -1 (S) .. +1 (N)

        // Latitude-dependent zonal drift
        float drift = zonalDrift(lat) * u_time;
        uv.x = fract(uv.x + drift * 0.00010 + u_rot_phase * 0.00001);

        // Base banded cloud colour
        float band = bandPattern(lat, uv, u_time);
        vec3 cloudCol = mix(zoneColor(lat), beltColor(lat), band);

        // Subtle cloud texture
        if (u_quality > 0.5) {
            float cloudNoise = fbm(uv * vec2(13.0, 7.0) + u_time * 0.0003, 3);
            cloudCol *= 0.94 + cloudNoise * 0.10;
        }

        // Bright discrete cloud spots (methane ice)
        float spot = cloudSpots(uv, lat, u_time);
        cloudCol = mix(cloudCol, vec3(0.82, 0.92, 0.92), spot * 0.55);

        // ── Bright polar hood + collar over the (summer) north pole ─────────────
        // North pole is rotating into sunlight ahead of the 2030 solstice.
        float hood = smoothstep(0.62, 0.96, lat);
        float hoodMottle = 1.0 + (fbm(uv * vec2(10.0, 6.0) + 4.0, 3) - 0.5) * 0.16;
        cloudCol = mix(cloudCol, vec3(0.74, 0.88, 0.85) * hoodMottle, hood * 0.55);
        // Bright polar collar ring just equatorward of the hood.
        float collar = smoothstep(0.42, 0.55, lat) * smoothstep(0.74, 0.60, lat);
        cloudCol = mix(cloudCol, vec3(0.66, 0.84, 0.82), collar * 0.30);
        // A fainter southern (winter) hood remnant.
        float sHood = smoothstep(0.74, 0.98, -lat);
        cloudCol = mix(cloudCol, vec3(0.52, 0.74, 0.74), sHood * 0.25);

        // Atmospheric limb haze → paler cyan at the limb
        vec3 hazeCol = vec3(0.60, 0.82, 0.84);
        float hazeFade = pow(1.0 - mu, 3.0);
        cloudCol = mix(cloudCol, hazeCol, hazeFade * 0.38);

        vec3 finalCol = cloudCol * limb;
        gl_FragColor = vec4(finalCol, 1.0);
    }
`;

/**
 * Create uniform block for the Uranus shader.
 * @param {object} THREE  three.js namespace
 */
export function createUranusUniforms(THREE) {
    return {
        u_time:      { value: 0.0 },
        u_quality:   { value: 1.0 },
        u_rot_phase: { value: 0.0 },
    };
}
