/**
 * coords.glsl.js — GLSL mirror of js/geo/coords.js
 * ═══════════════════════════════════════════════════════════════════════════════
 * Keep this file IN LOCKSTEP with coords.js. Any edit to the canonical frame or
 * UV convention in the JS module must be duplicated here and vice-versa.
 *
 * Usage in a shader:
 *
 *     import { GEO_GLSL } from './geo/coords.glsl.js';
 *     const FRAG = `
 *         precision highp float;
 *         varying vec3 vNormalLocal;
 *         ${GEO_GLSL}
 *         void main() {
 *             vec2 uv = normalToUV(normalize(vNormalLocal));
 *             ...
 *         }
 *     `;
 *
 * All functions take / return RADIANS. Normals are unit vectors in the
 * canonical Y-up, right-handed frame documented in coords.js.
 */

export const GEO_GLSL = /* glsl */ `
    #ifndef GEO_COORDS_INCLUDED
    #define GEO_COORDS_INCLUDED

    const float GEO_PI      = 3.14159265358979323846;
    const float GEO_TAU     = 6.28318530717958647692;
    const float GEO_DEG2RAD = 0.017453292519943295;
    const float GEO_RAD2DEG = 57.29577951308232;

    // Geographic (lat, lon radians) → unit normal on sphere.
    vec3 latLonToNormal(float lat, float lon) {
        float cl = cos(lat);
        return vec3(cl * cos(lon), sin(lat), -cl * sin(lon));
    }

    // Unit normal → (lat, lon) in radians. .x = lat, .y = lon.
    vec2 normalToLatLon(vec3 n) {
        return vec2(
            asin(clamp(n.y, -1.0, 1.0)),
            atan(-n.z, n.x)
        );
    }

    // Unit normal → equirectangular UV.
    //   u = 0 at lon = -180°, u = 1 at lon = +180°
    //   v = 0 at lat = +90°N, v = 1 at lat = -90°S
    vec2 normalToUV(vec3 n) {
        vec2 ll = normalToLatLon(n);
        return vec2(
            (ll.y + GEO_PI) / GEO_TAU,
            0.5 - ll.x / GEO_PI
        );
    }

    // Equirectangular UV → unit normal.
    vec3 uvToNormal(vec2 uv) {
        float lon = uv.x * GEO_TAU - GEO_PI;
        float lat = (0.5 - uv.y) * GEO_PI;
        return latLonToNormal(lat, lon);
    }

    // Geographic → UV (convenience).
    vec2 latLonToUV(float lat, float lon) {
        return vec2(
            (lon + GEO_PI) / GEO_TAU,
            0.5 - lat / GEO_PI
        );
    }

    // UV → (lat, lon) in radians.
    vec2 uvToLatLon(vec2 uv) {
        return vec2(
            (0.5 - uv.y) * GEO_PI,
            uv.x * GEO_TAU - GEO_PI
        );
    }

    // UV → (lat, lon) in DEGREES. Callers that think in degrees (aurora oval,
    // precip regimes, magnetic latitude labels) get a one-line swap.
    vec2 uvToLatLonDeg(vec2 uv) {
        return vec2(
            (0.5 - uv.y) * 180.0,
            uv.x * 360.0 - 180.0
        );
    }

    // (lat, lon) DEGREES → UV.
    vec2 latLonDegToUV(float latDeg, float lonDeg) {
        return vec2(
            (lonDeg + 180.0) / 360.0,
            (90.0 - latDeg)  / 180.0
        );
    }

    // Great-circle angular distance between two unit normals (radians).
    float angularDistance(vec3 a, vec3 b) {
        return acos(clamp(dot(a, b), -1.0, 1.0));
    }

    #endif
`;

export default GEO_GLSL;
