/**
 * wind-shear-proxy.js — runtime "is the flow steady?" scalar
 *
 * Lifted from the magnetosphere playbook: in the magnetosphere, southward
 * IMF Bz drives reconnection — a *runtime* signal that the steady
 * description (quiet Earth) is breaking down. The atmosphere has the
 * same kind of break-down for the semi-Lagrangian advection forecaster:
 * when the wind field shifts a lot between consecutive hours, the
 * single-step backward-Euler trajectory we draw stops being a faithful
 * approximation of where the parcel actually came from.
 *
 * This module computes a scalar in [0, 1] that the wind-advection
 * forecaster can multiply into its α gain to back off in turbulent
 * regimes. Definitions:
 *
 *   steadiness = 1   — wind hasn't changed direction OR magnitude in
 *                       the last few hours; trust the full advection
 *                       step
 *   steadiness = 0   — wind is shifting wildly; back off the gain
 *                       toward 0 so the forecast collapses to
 *                       persistence rather than emit confidently-wrong
 *                       trajectories
 *
 * Estimator
 * ─────────
 * For the most-recent N frames in the WeatherHistory, compute per-cell
 * temporal variance of (U, V) over those frames, area-weight by
 * cos(lat), sum to a global scalar. Higher variance = more shear.
 * Map to steadiness ∈ [0, 1] via:
 *
 *   steadiness = exp(-shear / shear_scale)
 *
 * `shear_scale` is calibrated so: a calm day's frames vary U/V by ≲
 * 1 m/s ⇒ shear ~ 1 ⇒ steadiness ~ 0.95; a synoptic-scale storm
 * passing has gust shear ~ 8-12 m/s ⇒ steadiness ~ 0.05.
 *
 * Cheap to compute: 2 channels × 24 frames × 2592 cells = ~125k FLOPs
 * per call. Once per forecast cycle (≤1 per 15 min); negligible.
 */

const CH_U = 3;
const CH_V = 4;

// Number of recent frames to average over. Too few = noisy; too many =
// a transient gust looks calmer than it is. 6 frames at 1-h cadence
// captures the past ~6 hours, which matches the synoptic-scale time
// constant.
const HISTORY_WINDOW_FRAMES = 6;

// Calibration constant — RMS shear magnitude (m/s) at which steadiness
// halves. Mid-latitude gust fronts sit around 5-7 m/s temporal RMS,
// so a 5 m/s scale puts a real synoptic disturbance into the
// steadiness ~0.37 band.
const SHEAR_SCALE_MS = 5.0;

export class WindShearProxy {
    constructor({ windowFrames = HISTORY_WINDOW_FRAMES } = {}) {
        this._window = Math.max(2, windowFrames | 0);
        this._lastSteadiness = 1.0;
        this._lastShearMs   = 0.0;
        this._lastNFrames   = 0;
        this._lastT         = 0;
    }

    /**
     * Recompute the steadiness scalar from a WeatherHistory ring.
     * Returns the scalar; also caches it for cheap re-reads via
     * getSteadiness() inside the same forecast cycle.
     */
    refresh(history) {
        const frames = (history?.recent?.(this._window)) ?? [];
        const arr = Array.isArray(frames) ? frames : [frames];
        if (arr.length < 2) {
            // Not enough history — return "fully steady" so we don't
            // arbitrarily down-weight advection on a fresh load.
            this._lastSteadiness = 1.0;
            this._lastShearMs   = 0.0;
            this._lastNFrames   = arr.length;
            return 1.0;
        }
        const newest = arr[arr.length - 1];
        const { gridW, gridH } = newest;
        const N = gridW * gridH;

        // Compute per-cell mean of U, V across the window.
        const meanU = new Float64Array(N);
        const meanV = new Float64Array(N);
        for (const fr of arr) {
            if (!fr || fr.gridW !== gridW || fr.gridH !== gridH) continue;
            const offU = CH_U * N, offV = CH_V * N;
            const cs = fr.coarse;
            for (let k = 0; k < N; k++) {
                meanU[k] += cs[offU + k];
                meanV[k] += cs[offV + k];
            }
        }
        const M = arr.length;
        for (let k = 0; k < N; k++) { meanU[k] /= M; meanV[k] /= M; }

        // Sum-of-squared-deviations per cell, accumulating with cos(lat)
        // area weighting. We sum SQUARED RMS: sqrt(E[(U−Ū)²] +
        // E[(V−V̄)²]) at the end, then take the area-weighted mean.
        let totalShear2 = 0, totalWeight = 0;
        for (let j = 0; j < gridH; j++) {
            const lat = -90 + (j + 0.5) * (180 / gridH);
            const w = Math.max(0, Math.cos(lat * Math.PI / 180));
            for (let i = 0; i < gridW; i++) {
                const k = j * gridW + i;
                let s2 = 0;
                for (const fr of arr) {
                    if (!fr || fr.gridW !== gridW || fr.gridH !== gridH) continue;
                    const u = fr.coarse[CH_U * N + k] - meanU[k];
                    const v = fr.coarse[CH_V * N + k] - meanV[k];
                    s2 += u * u + v * v;
                }
                s2 /= M;
                totalShear2 += s2 * w;
                totalWeight += w;
            }
        }
        const meanShearMs = Math.sqrt(Math.max(0, totalShear2 / Math.max(1e-9, totalWeight)));

        // Map to steadiness: exp(-shear / scale).  A shear of zero gives
        // steadiness = 1; a 5 m/s shear gives ≈ 0.37; a 10 m/s shear
        // gives ≈ 0.14.
        const steadiness = Math.exp(-meanShearMs / SHEAR_SCALE_MS);

        this._lastSteadiness = steadiness;
        this._lastShearMs   = meanShearMs;
        this._lastNFrames   = arr.length;
        this._lastT         = newest.t;
        return steadiness;
    }

    /** Most-recent steadiness scalar (∈ [0, 1]). 1 by default until refresh() runs. */
    getSteadiness() { return this._lastSteadiness; }

    /** Diagnostic snapshot for the SW-panel HUD or dev console. */
    diagnostics() {
        return {
            steadiness: this._lastSteadiness,
            shear_ms:   this._lastShearMs,
            n_frames:   this._lastNFrames,
            t:          this._lastT,
        };
    }
}

export default WindShearProxy;
export { SHEAR_SCALE_MS, HISTORY_WINDOW_FRAMES };
