/**
 * weather-uplift.js — wind-convergence / uplift diagnostic field
 *
 * Surfaces the exact dynamical signal the RK2 forecaster uses to grow
 * precipitation (see applyConvergenceGrowth in weather-flow.js): the
 * horizontal divergence of the wind field. Where the flow CONVERGES
 * (∇·V < 0) air is forced upward — that uplift is what spins up cloud and
 * rain — and where it DIVERGES (∇·V > 0) air subsides and skies clear.
 *
 * computeUpliftField() turns the decoded fine-grid wind buffer (the same
 * Float32Array WindParticles advects) into an RGBA field the convergence
 * overlay shader paints directly, so the operator sees *why* a storm is
 * developing, in lockstep with the forecast that's growing it:
 *
 *   out.R = signed, normalised convergence  ∈ [-1, +1]
 *           (+1 = strong uplift / convergence, −1 = strong subsidence)
 *   out.A = |convergence| magnitude         ∈ [ 0, +1]   (drives overlay alpha)
 *
 * Both are normalised against UPLIFT_FULL_SCALE so the shader needs no
 * unit knowledge; the hover readout multiplies R back by UPLIFT_FULL_SCALE
 * to report s⁻¹. Buffer convention is lockstep with weather-feed.js /
 * earth.html samplers: row-major, row 0 = 90°S, longitude wraps, the wind
 * channels are U,V normalised by maxWind (eastward / northward, m/s).
 */

// Mean Earth radius metric — 1° latitude ≈ 111_320 m (matches weather-flow.js).
const M_PER_DEG_LAT = 111_320;

// Convergence magnitude (s⁻¹) that saturates the overlay colour/alpha.
// Synoptic convergence runs ~1e-5 s⁻¹; a vigorous front or tropical
// convergence line reaches ~2–3e-5, so this keeps everyday weather visible
// without clipping the strong systems to a flat wash.
export const UPLIFT_FULL_SCALE = 2.5e-5;

// cos(lat) floor — avoids the 1/cos blow-up at the poles where the
// longitude metric collapses (mirrors LAT_CLAMP in weather-flow.js).
const COSLAT_FLOOR = 0.05;

/**
 * Compute the convergence/uplift field from a decoded wind buffer.
 *
 * @param {Float32Array} windBuf  texW·texH·4, channels [U/max, V/max, speed/max, 1].
 * @param {number} texW
 * @param {number} texH
 * @param {number} maxWind        m/s scale the wind channels were normalised by.
 * @param {Float32Array} [out]    texW·texH·4 destination (allocated if omitted).
 * @returns {Float32Array} out
 */
export function computeUpliftField(windBuf, texW, texH, maxWind, out = null) {
    const N = texW * texH;
    if (!out || out.length !== N * 4) out = new Float32Array(N * 4);
    if (!windBuf) return out;

    const dLatDeg = 180 / (texH - 1);          // row spacing (matches earth.html sampler)
    const dyM     = dLatDeg * M_PER_DEG_LAT;
    const dLonDeg = 360 / texW;

    for (let y = 0; y < texH; y++) {
        const lat    = -90 + y * dLatDeg;       // row 0 = 90°S
        const cosLat = Math.max(COSLAT_FLOOR, Math.abs(Math.cos(lat * Math.PI / 180)));
        const dxM    = dLonDeg * M_PER_DEG_LAT * cosLat;
        const yp = Math.min(texH - 1, y + 1);
        const ym = Math.max(0, y - 1);
        const dySpan = (yp - ym) * dyM || dyM;

        for (let x = 0; x < texW; x++) {
            const xp = (x + 1) % texW;          // longitude wraps
            const xm = (x - 1 + texW) % texW;

            const uE = windBuf[(y  * texW + xp) * 4]     * maxWind;
            const uW = windBuf[(y  * texW + xm) * 4]     * maxWind;
            const vN = windBuf[(yp * texW + x)  * 4 + 1] * maxWind;
            const vS = windBuf[(ym * texW + x)  * 4 + 1] * maxWind;

            const dUdx = (uE - uW) / (2 * dxM);
            const dVdy = (vN - vS) / dySpan;
            const conv = -(dUdx + dVdy);         // >0 convergence/uplift, <0 divergence

            const norm = Math.max(-1, Math.min(1, conv / UPLIFT_FULL_SCALE));
            const o = (y * texW + x) * 4;
            out[o]     = norm;                   // R: signed normalised convergence
            out[o + 1] = 0;
            out[o + 2] = 0;
            out[o + 3] = Math.abs(norm);         // A: magnitude for overlay alpha
        }
    }
    return out;
}

// ── Relative vorticity (Phase 4.2 of the wind+cloud depth plan) ─────────────
// Same finite-difference stencil as the divergence above, rotated:
// ζ = ∂V/∂x − ∂U/∂y. Where the uplift field answers "is air piling up
// here", vorticity answers "is it spinning" — at 250 hPa it traces jet
// streaks and cutoff lows, at the surface it rings synoptic storm centres.
//
// Operates on the COARSE m/s grids (72×36 CHW slices from the level feed /
// weather grid, lat ascending, lon wrapping) rather than the decoded
// 360×180 texture: vorticity is a derivative, and differencing an
// upsampled field just measures the interpolator. The output RGBA buffer
// renders at grid resolution and lets the GPU's LinearFilter upsample.
//
// Sign convention: the raw ζ is multiplied by the hemisphere sign so the
// stored value is CYCLONIC-positive everywhere (NH counterclockwise, SH
// clockwise both read +). This is what a forecaster's eye expects — storm
// centres and jet-left exit regions paint warm in both hemispheres.
export const VORT_FULL_SCALE = 1.5e-4;   // s⁻¹ — deep mid-lat trough / jet streak

/**
 * @param {Float32Array} u       eastward wind, m/s, gridW·gridH (lat ascending)
 * @param {Float32Array} v       northward wind, m/s, same shape
 * @param {number} gridW
 * @param {number} gridH
 * @param {Float32Array} [out]   gridW·gridH·4 RGBA destination
 * @returns {Float32Array} out — R = signed cyclonic ζ/VORT_FULL_SCALE ∈ [-1,1],
 *                               A = |R| (overlay alpha), G/B = 0.
 */
export function computeVorticityField(u, v, gridW, gridH, out = null) {
    const N = gridW * gridH;
    if (!out || out.length !== N * 4) out = new Float32Array(N * 4);
    if (!u || !v) return out;

    const dLatDeg = 180 / gridH;
    const dyM     = dLatDeg * M_PER_DEG_LAT;
    const dLonDeg = 360 / gridW;
    const f = (x) => (x === x ? x : 0);   // NaN (feed gap) → 0

    for (let j = 0; j < gridH; j++) {
        const lat    = -90 + (j + 0.5) * dLatDeg;     // cell-centred rows
        const cosLat = Math.max(COSLAT_FLOOR, Math.abs(Math.cos(lat * Math.PI / 180)));
        const dxM    = dLonDeg * M_PER_DEG_LAT * cosLat;
        const hemi   = lat >= 0 ? 1 : -1;             // cyclonic-positive fold
        const jp = Math.min(gridH - 1, j + 1);
        const jm = Math.max(0, j - 1);
        const dySpan = (jp - jm) * dyM || dyM;

        for (let i = 0; i < gridW; i++) {
            const ip = (i + 1) % gridW;               // longitude wraps
            const im = (i - 1 + gridW) % gridW;

            const dVdx = (f(v[j * gridW + ip]) - f(v[j * gridW + im])) / (2 * dxM);
            const dUdy = (f(u[jp * gridW + i]) - f(u[jm * gridW + i])) / dySpan;
            const zeta = (dVdx - dUdy) * hemi;

            const norm = Math.max(-1, Math.min(1, zeta / VORT_FULL_SCALE));
            const o = (j * gridW + i) * 4;
            out[o]     = norm;
            out[o + 1] = 0;
            out[o + 2] = 0;
            out[o + 3] = Math.abs(norm);
        }
    }
    return out;
}

export default computeUpliftField;
