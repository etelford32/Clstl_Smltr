/**
 * inset.glsl.js — equirectangular "focus inset" GLSL helpers (THREE-free string).
 *
 * insetUV / insetWeight map a global equirectangular UV into a lat/lon-bounded
 * window and feather its edge, so a high-res patch (weather patch, GIBS imagery
 * inset, DEM inset) blends into the global field with no seam. Consumers must
 * concatenate GEO_GLSL (js/geo/coords.glsl.js) BEFORE this — insetUV calls
 * uvToLatLonDeg from there.
 *
 * Lives in its own THREE-free module so both the surface/cloud fragment shaders
 * (js/earth-skin.js) and the terrain-patch vertex shader (js/earth-terrain-patch.js)
 * import the SAME source — inset math can never drift between the two stages —
 * without pulling the THREE runtime into node unit tests.
 */
export const INSET_GLSL_HELPERS = /* glsl */`
// highp: the cloud frag runs mediump by default, and fp16 quantises
// degree-range values to 0.06–0.125° — up to half a weather-patch cell at
// the 0.25° floor. Inset math must stay full-precision on mobile GPUs.

// Equirectangular uv → inset-local uv (may land outside [0,1]).
highp vec2 insetUV(vec2 uv, highp vec4 b) {
    highp vec2 llDeg = uvToLatLonDeg(uv);                 // (lat, lon)
    highp float dLon = mod(llDeg.y - b.x, 360.0);
    return vec2(dLon / max(1e-3, b.z),
                (llDeg.x - b.y) / max(1e-3, b.w));
}

// 1 in the inset interior, easing to 0 across the outer ~12% so the
// high-res window blends into the global field with no visible seam.
float insetWeight(vec2 uvP) {
    vec2 edge = min(uvP, 1.0 - uvP);
    return smoothstep(0.0, 0.12, min(edge.x, edge.y));
}
`;
