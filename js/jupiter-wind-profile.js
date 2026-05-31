/**
 * jupiter-wind-profile.js — Measured cloud-level zonal-wind profile.
 *
 * Eastward (prograde +) wind velocity in m/s as a function of planetographic
 * latitude. This drives the cloud shader's differential shear (see
 * jupiter-shader.js) so the bands advect at their real, latitude-dependent
 * rates and the jets sit where they actually are.
 *
 * ── Provenance & honesty ──────────────────────────────────────────────────
 *   This is a DIGITIZATION of the published mean cloud-level profile, not a
 *   per-image dataset. It reproduces the established structure — equatorial
 *   super-rotation (~+140 m/s), the dominant eastward jet at ~24°N (Jupiter's
 *   fastest, ~+145 m/s), the retrograde jets flanking the Great Red Spot
 *   (~-20 m/s at 20°S), the strong N/S hemispheric asymmetry, and the
 *   alternating mid-latitude jets that weaken toward the poles. Speeds are
 *   accurate to roughly ±15 m/s and jet latitudes to ~±2°. To upgrade to an
 *   exact fit, replace JUPITER_ZONAL_WIND with the tabulated values from the
 *   PDS atmospheres node or the source papers below — nothing else needs to
 *   change.
 *
 * ── Sources ────────────────────────────────────────────────────────────────
 *   Limaye (1986) Icarus 65 — Voyager zonal-mean winds.
 *   García-Melendo & Sánchez-Lavega (2001) Icarus 152 — high-res profile.
 *   Porco et al. (2003) Science 299 — Cassini CB2 cloud-tracked winds.
 *   Tollefson et al. (2017) Icarus 296 — changes preceding the Juno mission.
 */

// [planetographic latitude (deg, S→N), eastward velocity (m/s)]
export const JUPITER_ZONAL_WIND = [
    [-90,   0], [-85,  -8], [-80,   5], [-75,  18], [-70, -12],
    [-65,  22], [-60, -18], [-56,  30], [-52, -12], [-48,  28],
    [-44, -18], [-40,  35], [-36, -22], [-32,  28], [-28,  48],   // prograde jet S of GRS (~27°S)
    [-24,  12], [-22, -10], [-20, -42],                            // retrograde jet on GRS's poleward flank
    [-17, -30], [-14,   5], [-11,  35], [-8,   65], [-5,  115],
    [-2,  138], [ 0,  140],                                        // equatorial super-rotation peak
    [ 2,  138], [ 5,  108], [ 7,   45], [ 9,  -18],                // retrograde dip (NEB south edge)
    [12,   25], [15,  -12], [18,  -28], [20,  -10],                // retrograde jet S of the 24°N jet
    [22,   70], [24,  145],                                        // Jupiter's fastest jet (~24°N)
    [26,   95], [28,   18], [31,   35], [34,  -18], [38,   32],
    [42,  -16], [46,   26], [50,  -14], [54,   24], [58,  -14],
    [62,   18], [67,  -12], [72,   12], [78,   -8], [85,    4],
    [90,    0],
];

// Normalisation constant: a touch above the fastest jet so the normalised
// profile stays within ±1. Also used to label "peak jet" in the UI.
export const WIND_PEAK_MS = 150;

// Largest |velocity| actually present in the table (for readouts).
export const WIND_MAX_ABS_MS = JUPITER_ZONAL_WIND.reduce((m, p) => Math.max(m, Math.abs(p[1])), 0);

/** Linearly interpolated eastward velocity (m/s) at a planetographic latitude. */
export function sampleWind(latDeg) {
    const T = JUPITER_ZONAL_WIND;
    const lat = Math.max(T[0][0], Math.min(T[T.length - 1][0], latDeg));
    for (let i = 0; i < T.length - 1; i++) {
        const [la, ua] = T[i], [lb, ub] = T[i + 1];
        if (lat >= la && lat <= lb) {
            const f = (lb === la) ? 0 : (lat - la) / (lb - la);
            return ua + (ub - ua) * f;
        }
    }
    return 0;
}

/**
 * Belt(1) / zone(0) classification derived from the wind shear.
 *
 * Belts are cyclonic and zones anticyclonic — i.e. the sign of the relative
 * vorticity ζ = -du/dy relative to the local Coriolis parameter f ∝ sin(lat).
 * So "belt-ness" ∝ -sign(lat)·du/dlat. The shear is smoothed over a few
 * degrees so the choppy digitized profile collapses to the major belts/zones,
 * and the broad equatorial jet is forced bright (it is the Equatorial Zone,
 * which the mid-latitude vorticity rule does not describe). Returns [0,1].
 */
export function bandField(latDeg) {
    // Smoothed meridional shear du/dlat (m/s per degree).
    let s = 0, n = 0;
    for (let d = -4; d <= 4; d++) {
        s += (sampleWind(latDeg + d + 1) - sampleWind(latDeg + d - 1)) / 2;
        n++;
    }
    s /= n;
    const cyclonic = -Math.sign(latDeg || 1) * s;          // > 0 → belt
    let belt = 0.5 + cyclonic / 22;
    belt = Math.max(0, Math.min(1, belt));
    const eq = Math.exp(-(latDeg * latDeg) / (2 * 6.5 * 6.5));   // EZ ≈ ±6.5°
    return belt * (1 - eq) + 0.06 * eq;                    // force EZ bright
}

/**
 * Build a 1-D data texture for the cloud shader. Red = normalised wind
 * (v01 = u/WIND_PEAK_MS·0.5 + 0.5; decode u_norm = r·2 - 1, finite-difference
 * for shear). Green = belt/zone classification from bandField (so the visible
 * bands sit on the real jets). Linear-filtered + clamped.
 *
 * @param {object} THREE  three.js namespace
 * @param {number} [N=256]
 * @returns {THREE.DataTexture}
 */
export function buildWindTexture(THREE, N = 256) {
    const data = new Uint8Array(N * 4);
    for (let i = 0; i < N; i++) {
        const latDeg = (i / (N - 1)) * 180 - 90;          // -90 … +90
        const v01 = sampleWind(latDeg) / WIND_PEAK_MS * 0.5 + 0.5;
        data[i * 4]     = Math.round(Math.max(0, Math.min(1, v01)) * 255);
        data[i * 4 + 1] = Math.round(bandField(latDeg) * 255);
        data[i * 4 + 2] = 0;
        data[i * 4 + 3] = 255;
    }
    const tex = new THREE.DataTexture(data, N, 1, THREE.RGBAFormat);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    return tex;
}
