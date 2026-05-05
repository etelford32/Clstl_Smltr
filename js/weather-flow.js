/**
 * weather-flow.js — advective nowcasting + Lucas-Kanade optical flow
 *
 * Phase 3 of WEATHER_FORECAST_PLAN.md. Two forecasters, both registering
 * into the existing ForecastRegistry alongside persistence + the precip
 * + cloud + wind anomaly variants:
 *
 *   1. WindAdvectionForecaster (semi-Lagrangian)
 *      Uses the stored U/V wind channels directly: at each forecast cell
 *      and horizon, walk backward along the wind for `h` hours to find
 *      the upwind origin, bilinearly sample the current field there,
 *      that's the forecast. Physical: this is the standard
 *      semi-Lagrangian transport scheme used in operational NWP — the
 *      wind already tells us where each parcel came from. Beats AR
 *      whenever a feature is *advected* across the grid (cold fronts,
 *      ridge axes, atmospheric rivers) because AR has no notion of
 *      space.
 *
 *   2. OpticalFlowForecaster (Lucas-Kanade)
 *      Estimates a pixel-velocity field from two consecutive frames of
 *      a "tracer" channel (default: total cloud cover) using the
 *      Lucas-Kanade method, then runs the same semi-Lagrangian step
 *      with that flow. Useful where feature motion ≠ wind motion (e.g.
 *      mid-level cloud bands moving with the steering flow aloft, not
 *      the surface wind we have stored). Also a useful cross-check on
 *      WindAdvection: if LK and U/V disagree by a lot at a cell, that
 *      cell's forecast carries more uncertainty than a single model
 *      would suggest.
 *
 * Both produce 9-channel CHW frames matching the schema PersistenceForecaster
 * already emits, so the WeatherForecastValidator scores them automatically
 * against persistence-v1 with no additional wiring.
 *
 * Why this isn't five files
 * ─────────────────────────
 * The plan budgets "~1 file" for Phase 3. The math (bilinear sampler,
 * coordinate helpers, LK kernel, semi-Lagrangian core) is small enough
 * to keep co-located, and bundling helps cross-referencing between the
 * forecasters and the primitives. We export the helpers separately so
 * tests / future modules can use them without instantiating a Forecaster.
 *
 * Coordinate convention
 * ─────────────────────
 * Lockstep with weather-history.js + the cron grid generator
 * (api/cron/refresh-weather-grid.js): coarse buffer is row-major, lat
 * slow, lat ASCENDING south → north. Cell (j=0, i=0) sits at
 * (-87.5° lat, -177.5° lon) for the default 72×36 grid. So:
 *
 *   latOfRow(j, gridH) = -90 + (j + 0.5) * (180 / gridH)
 *   lonOfColumn(i, gridW) = -180 + (i + 0.5) * (360 / gridW)
 *
 * U is eastward (positive → air moves east), V is northward (positive →
 * air moves north). Both in m/s, lockstep with weather-feed.js channel
 * 3/4 conventions.
 */

import { FORECAST_HORIZONS_H } from './weather-forecast.js';

const NUM_CHANNELS = 9;
const CH_U      = 3;
const CH_V      = 4;
const CH_LOW    = 5;
const CH_MID    = 6;
const CH_HIGH   = 7;

// Earth's radius in metres (mean) — used to convert m/s to deg/s.
// 1° lat ≈ 111_320 m at sea level; 1° lon shrinks by cos(lat).
const M_PER_DEG_LAT = 111_320;

// Clamp the latitude during sampling to avoid the cos(lat) singularity
// at the poles. ±89° is well past anywhere with active data on the
// 5° grid (the polar strip is at ±87.5°) so we lose nothing.
const LAT_CLAMP_DEG = 89.0;

// ── Coordinate helpers ─────────────────────────────────────────────────────

export function latOfRow(j, gridH) {
    return -90 + (j + 0.5) * (180 / gridH);
}
export function lonOfColumn(i, gridW) {
    return -180 + (i + 0.5) * (360 / gridW);
}

// Inverse: which row index does this lat fall into? Returns a fractional
// row so the bilinear sampler can interpolate. Latitude is clamped before
// the conversion so we never produce a row index outside [0, gridH-1].
function rowOfLat(latDeg, gridH) {
    const clamped = Math.max(-LAT_CLAMP_DEG, Math.min(LAT_CLAMP_DEG, latDeg));
    return (clamped + 90) * (gridH / 180) - 0.5;
}
function colOfLon(lonDeg, gridW) {
    // Longitude is periodic — wrap before converting so a back-step over
    // the dateline doesn't index into a phantom column.
    let l = ((lonDeg + 540) % 360) - 180;
    return (l + 180) * (gridW / 360) - 0.5;
}

// ── Bilinear sampler ───────────────────────────────────────────────────────
//
// Samples one channel of a CHW Float32 buffer at fractional (col, row)
// pixel coordinates. Wraps periodically in column (longitude is a
// circle); clamps in row (the field doesn't continue across the pole,
// the polar strip is the field's edge).

export function bilinearSample(field, gridW, gridH, col, row) {
    // Clamp row, wrap col.
    const r = Math.max(0, Math.min(gridH - 1.000001, row));
    const c = ((col % gridW) + gridW) % gridW;
    const r0 = Math.floor(r);
    const r1 = Math.min(gridH - 1, r0 + 1);
    const c0 = Math.floor(c);
    const c1 = (c0 + 1) % gridW;
    const fr = r - r0;
    const fc = c - c0;
    const v00 = field[r0 * gridW + c0];
    const v10 = field[r0 * gridW + c1];
    const v01 = field[r1 * gridW + c0];
    const v11 = field[r1 * gridW + c1];
    return (1 - fc) * (1 - fr) * v00
         +      fc  * (1 - fr) * v10
         + (1 - fc) *      fr  * v01
         +      fc  *      fr  * v11;
}

// ── Semi-Lagrangian advection ─────────────────────────────────────────────
//
// For each cell at the forecast time t+h, we ask: "where did the air
// here come from?" Walk backward along the (U, V) velocity at the
// destination cell for h hours to find the origin, then bilinearly
// sample the current field at that origin. Single-step backward Euler;
// good enough for h ≤ 6 h on a 5° grid where the wind doesn't reverse
// inside one step.
//
// `flowU`, `flowV`: m/s, eastward + northward respectively. They are
// SAMPLED AT THE DESTINATION CELL — that's the standard semi-Lagrangian
// approximation; for short horizons it's effectively first-order
// accurate. For h > 6 h the integrator should iterate (Euler →
// midpoint), but at h=24 the error from the steady-flow assumption
// already dominates so we don't bother.

/**
 * Advect one channel of `field` forward by `hoursAhead` hours using the
 * supplied (flowU, flowV) m/s velocity arrays. Returns a fresh
 * Float32Array(N).
 */
export function semiLagrangianAdvect({ field, flowU, flowV, gridW, gridH, hoursAhead }) {
    const N = gridW * gridH;
    const out = new Float32Array(N);
    const seconds = hoursAhead * 3600;

    for (let j = 0; j < gridH; j++) {
        const lat = latOfRow(j, gridH);
        const cosLat = Math.cos(lat * Math.PI / 180);
        // Avoid divide-by-zero at the poles — clamp the secant so a
        // stray "wind blowing through the pole" doesn't send the
        // origin index to ±∞. cos(89°) ≈ 0.0175, secant ≈ 57.3.
        const secLat = 1 / Math.max(0.02, Math.abs(cosLat));
        for (let i = 0; i < gridW; i++) {
            const k = j * gridW + i;
            const u = flowU[k] || 0;       // m/s east
            const v = flowV[k] || 0;       // m/s north
            // Origin in metres relative to (lat, lon):
            //   dx = u * dt   (eastward displacement OF THE PARCEL)
            //   dy = v * dt   (northward displacement)
            // Origin = destination − displacement.
            const dxMeters = u * seconds;
            const dyMeters = v * seconds;
            // Convert to degrees with appropriate metric.
            const dlatDeg = dyMeters / M_PER_DEG_LAT;
            const dlonDeg = dxMeters / M_PER_DEG_LAT * secLat;
            const latO = lat - dlatDeg;
            const lonO = lonOfColumn(i, gridW) - dlonDeg;
            const rowO = rowOfLat(latO, gridH);
            const colO = colOfLon(lonO, gridW);
            out[k] = bilinearSample(field, gridW, gridH, colO, rowO);
        }
    }
    return out;
}

// ── Lucas-Kanade flow ─────────────────────────────────────────────────────
//
// Classical 2-frame LK on a single tracer channel. For each cell, sum
// gradient products in a (2r+1) × (2r+1) window and solve a 2×2
// system for (u, v) in pixels-per-frame. Default window radius 2 →
// 5×5 = 25 samples, well-conditioned for a 72×36 grid.
//
// Output is in pixel-velocity (per frame). The forecaster converts
// pixels/frame → m/s before handing off to semiLagrangianAdvect:
//   U_ms = u * (360/gridW) deg-lon * (111320 * cos(lat)) / framePeriodSec
//   V_ms = v * (180/gridH) deg-lat * 111320            / framePeriodSec
//
// Window edges wrap in column (longitude periodic) and clamp in row
// (lat not periodic). Cells with a near-singular gradient matrix
// (|det| below a small threshold) get a (0, 0) flow — better than a
// noise-amplified explosion.

/**
 * @param {object} args
 * @param {Float32Array} args.prev    Previous frame, single channel slice (length gridW*gridH).
 * @param {Float32Array} args.curr    Current frame, same shape.
 * @param {number}       args.gridW
 * @param {number}       args.gridH
 * @param {number}       [args.windowRadius=2]   LK window half-size.
 * @returns {{ u: Float32Array, v: Float32Array }}  pixel-velocity per frame
 */
export function lucasKanadeFlow({ prev, curr, gridW, gridH, windowRadius = 2 }) {
    const N = gridW * gridH;
    const u = new Float32Array(N);
    const v = new Float32Array(N);

    // Pre-compute spatial gradients of `curr` once. Central differences
    // in pixel space; wrap in column, clamp in row.
    const Ix = new Float32Array(N);
    const Iy = new Float32Array(N);
    const It = new Float32Array(N);
    for (let j = 0; j < gridH; j++) {
        const jUp = Math.min(gridH - 1, j + 1);
        const jDn = Math.max(0, j - 1);
        for (let i = 0; i < gridW; i++) {
            const iE = (i + 1) % gridW;
            const iW = (i - 1 + gridW) % gridW;
            const k = j * gridW + i;
            Ix[k] = 0.5 * (curr[j * gridW + iE] - curr[j * gridW + iW]);
            // +Iy means "value increases with j" which means "increases
            // northward" given the south-first row convention.
            Iy[k] = 0.5 * (curr[jUp * gridW + i] - curr[jDn * gridW + i]);
            It[k] = curr[k] - prev[k];
        }
    }

    // For each cell, sum gradient products over the LK window and solve
    // [Sxx Sxy; Sxy Syy] [u v]^T = -[Sxt; Syt]. Window edges wrap in
    // column, clamp in row.
    const r = windowRadius;
    for (let j = 0; j < gridH; j++) {
        for (let i = 0; i < gridW; i++) {
            let Sxx = 0, Syy = 0, Sxy = 0, Sxt = 0, Syt = 0;
            for (let dj = -r; dj <= r; dj++) {
                const jj = Math.max(0, Math.min(gridH - 1, j + dj));
                for (let di = -r; di <= r; di++) {
                    const ii = ((i + di) % gridW + gridW) % gridW;
                    const kk = jj * gridW + ii;
                    const ix = Ix[kk], iy = Iy[kk], it = It[kk];
                    Sxx += ix * ix;
                    Syy += iy * iy;
                    Sxy += ix * iy;
                    Sxt += ix * it;
                    Syt += iy * it;
                }
            }
            const det = Sxx * Syy - Sxy * Sxy;
            // det threshold: a tiny window-sum det means the local
            // gradient field is degenerate (flat region — "aperture
            // problem"). Returning (0, 0) flow is the right call;
            // pretending we have flow info from a flat patch would
            // inject pure noise into the advection step.
            if (Math.abs(det) < 1e-6) { u[j * gridW + i] = 0; v[j * gridW + i] = 0; continue; }
            const invDet = 1 / det;
            // [u v] = -[Syy -Sxy; -Sxy Sxx]/det * [Sxt; Syt]
            u[j * gridW + i] = -(Syy * Sxt - Sxy * Syt) * invDet;
            v[j * gridW + i] = -(Sxx * Syt - Sxy * Sxt) * invDet;
        }
    }
    return { u, v };
}

/**
 * Convert LK pixel-velocity (per frame) into m/s on the (eastward,
 * northward) basis the U/V channels use. Cell-dependent because the
 * longitudinal pixel size shrinks with latitude.
 */
export function lkPixelsToMs({ u, v, gridW, gridH, framePeriodSec }) {
    const N = gridW * gridH;
    const Ums = new Float32Array(N);
    const Vms = new Float32Array(N);
    const dLonDegPerPx = 360 / gridW;
    const dLatDegPerPx = 180 / gridH;
    for (let j = 0; j < gridH; j++) {
        const lat = latOfRow(j, gridH);
        const cosLat = Math.cos(lat * Math.PI / 180);
        for (let i = 0; i < gridW; i++) {
            const k = j * gridW + i;
            // u pixels east → u * dLonDegPerPx degrees east → metres east via cos(lat).
            Ums[k] = u[k] * dLonDegPerPx * (M_PER_DEG_LAT * cosLat) / framePeriodSec;
            // v pixels north → v * dLatDegPerPx degrees north → metres north.
            Vms[k] = v[k] * dLatDegPerPx * M_PER_DEG_LAT / framePeriodSec;
        }
    }
    return { U: Ums, V: Vms };
}

// ── Forecasters ────────────────────────────────────────────────────────────

/**
 * Common scaffolding: builds full 9-channel CHW frames at every
 * FORECAST_HORIZONS_H, advecting each channel using the supplied
 * (flowU, flowV) velocity field. Used by both forecasters; only the
 * source of the velocity field differs between them.
 */
function buildAdvectedHorizons({
    history, modelId, flowU, flowV,
}) {
    const frames = history.all();
    if (frames.length === 0) return null;
    const newest = frames[frames.length - 1];
    const { t, gridW, gridH, coarse } = newest;
    const N = gridW * gridH;

    const out = {};
    const targets = {};
    for (const h of FORECAST_HORIZONS_H) {
        const targetMs = t + h * 3_600_000;
        targets[h] = targetMs;
        const frame = new Float32Array(N * NUM_CHANNELS);
        for (let ch = 0; ch < NUM_CHANNELS; ch++) {
            const off = ch * N;
            const slice = coarse.subarray(off, off + N);
            const advected = semiLagrangianAdvect({
                field: slice, flowU, flowV, gridW, gridH, hoursAhead: h,
            });
            frame.set(advected, off);
        }
        out[h] = frame;
    }
    return {
        model_id: modelId, issued_ms: t,
        horizons: FORECAST_HORIZONS_H.slice(),
        gridW, gridH, frames: out, target_ms: targets,
    };
}

/**
 * Forecast = displace the current frame backward along the stored
 * U/V wind vectors. Physical: standard semi-Lagrangian transport.
 *
 * Honest limitations:
 *   - Single-step backward Euler with steady-state flow assumption.
 *     For h > 6 h the wind itself evolves more than the back-trajectory
 *     accounts for. We accept this — it's the simplest version of the
 *     scheme and the validator will tell us where it breaks.
 *   - Wind is sampled at the destination cell, not along the
 *     trajectory. Mid-point or RK2 integration would be a small
 *     accuracy bump; not yet justified by skill scores.
 */
export class WindAdvectionForecaster {
    static id = 'wind-advection-v1';
    constructor() { this.id = WindAdvectionForecaster.id; }

    forecast({ history }) {
        const frames = history.all();
        if (frames.length === 0) return null;
        const newest = frames[frames.length - 1];
        const { gridW, gridH, coarse } = newest;
        const N = gridW * gridH;
        // Pull U, V slices straight from the latest frame — no derivation
        // needed, the channels are already in m/s.
        const flowU = coarse.subarray(CH_U * N, (CH_U + 1) * N);
        const flowV = coarse.subarray(CH_V * N, (CH_V + 1) * N);
        return buildAdvectedHorizons({
            history,
            modelId: this.id,
            flowU, flowV,
        });
    }
}

/**
 * Estimate a 2D pixel-velocity flow from the last two frames of a
 * tracer channel using Lucas-Kanade, convert to m/s, then run the
 * same semi-Lagrangian step as WindAdvection. Defaults to advecting
 * by total cloud cover (low+mid+high), which captures synoptic-scale
 * feature motion well even when surface wind disagrees with the
 * steering flow aloft.
 */
export class OpticalFlowForecaster {
    static id = 'optical-flow-v1';
    constructor({ tracerChannels = [CH_LOW, CH_MID, CH_HIGH], windowRadius = 2 } = {}) {
        this.id            = OpticalFlowForecaster.id;
        this._tracerChs    = tracerChannels.slice();
        this._windowRadius = windowRadius;
    }

    forecast({ history }) {
        const frames = history.all();
        // Need at least two frames to estimate flow. If we have only
        // one we can't build the temporal gradient — bail and let
        // WindAdvection / persistence carry the load.
        if (frames.length < 2) return null;
        const prev = frames[frames.length - 2];
        const curr = frames[frames.length - 1];
        if (prev.gridW !== curr.gridW || prev.gridH !== curr.gridH) return null;
        const { gridW, gridH, coarse } = curr;
        const N = gridW * gridH;

        // Build the tracer channel as the sum of `_tracerChs`. Summing
        // total cloud cover before LK is a quick way to amplify the
        // signal-to-noise without sacrificing spatial resolution —
        // optical flow on a brighter, more-textured field gives
        // tighter gradient matrices and better-conditioned LK
        // solutions.
        const prevTracer = new Float32Array(N);
        const currTracer = new Float32Array(N);
        for (const ch of this._tracerChs) {
            const off = ch * N;
            const ps = prev.coarse.subarray(off, off + N);
            const cs = curr.coarse.subarray(off, off + N);
            for (let k = 0; k < N; k++) { prevTracer[k] += ps[k]; currTracer[k] += cs[k]; }
        }

        const { u, v } = lucasKanadeFlow({
            prev: prevTracer, curr: currTracer,
            gridW, gridH, windowRadius: this._windowRadius,
        });
        // Frames in the history ring are 1-hour-spaced (cron cadence);
        // cells with NaN flow already became 0 in lucasKanadeFlow's
        // det-threshold branch, so we don't need to scrub here.
        const { U: flowU, V: flowV } = lkPixelsToMs({
            u, v, gridW, gridH, framePeriodSec: 3600,
        });

        return buildAdvectedHorizons({
            history,
            modelId: this.id,
            flowU, flowV,
        });
    }
}

// Convenience: spawn both forecasters with sensible defaults.
export function makeWeatherFlowForecasters() {
    return [
        new WindAdvectionForecaster(),
        new OpticalFlowForecaster(),
    ];
}

export default makeWeatherFlowForecasters;
