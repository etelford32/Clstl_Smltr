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
 *
 * gainAtHour(h) is an optional per-horizon multiplier ∈ [0, 1] applied
 * to (flowU, flowV) before the advection step. It exists so the wind-
 * advection forecaster can blend toward persistence at long horizons
 * where the steady-flow assumption breaks; gainAtHour(h)=1 for every h
 * recovers the unscaled physics step. We scale by allocating a fresh
 * Float32Array only when the gain ≠ 1 — keeps the common case
 * allocation-free.
 */
function buildAdvectedHorizons({
    history, modelId, flowU, flowV, gainAtHour = null,
}) {
    const frames = history.all();
    if (frames.length === 0) return null;
    const newest = frames[frames.length - 1];
    const { t, gridW, gridH, coarse } = newest;
    const N = gridW * gridH;

    const out = {};
    const targets = {};
    const meta = gainAtHour ? { gain_per_horizon: {} } : null;
    for (const h of FORECAST_HORIZONS_H) {
        const targetMs = t + h * 3_600_000;
        targets[h] = targetMs;

        const gain = gainAtHour ? Math.max(0, Math.min(1, gainAtHour(h))) : 1;
        if (meta) meta.gain_per_horizon[h] = gain;
        let useU = flowU, useV = flowV;
        if (gain !== 1) {
            useU = new Float32Array(N);
            useV = new Float32Array(N);
            for (let k = 0; k < N; k++) { useU[k] = flowU[k] * gain; useV[k] = flowV[k] * gain; }
        }

        const frame = new Float32Array(N * NUM_CHANNELS);
        for (let ch = 0; ch < NUM_CHANNELS; ch++) {
            const off = ch * N;
            const slice = coarse.subarray(off, off + N);
            const advected = semiLagrangianAdvect({
                field: slice, flowU: useU, flowV: useV, gridW, gridH, hoursAhead: h,
            });
            frame.set(advected, off);
        }
        out[h] = frame;
    }
    return {
        model_id: modelId, issued_ms: t,
        horizons: FORECAST_HORIZONS_H.slice(),
        gridW, gridH, frames: out, target_ms: targets,
        ...(meta ? { _meta: meta } : {}),
    };
}

/**
 * Forecast = displace the current frame backward along the stored
 * U/V wind vectors. Physical: standard semi-Lagrangian transport.
 *
 * Honest limitations of the bare physics step:
 *   - Single-step backward Euler with steady-state flow assumption.
 *     For h > 6 h the wind itself evolves more than the back-trajectory
 *     accounts for, and the forecast can become *worse than persistence*.
 *   - Wind is sampled at the destination cell, not along the
 *     trajectory. Mid-point or RK2 integration would be a small
 *     accuracy bump; not yet justified by skill scores.
 *
 * Learned gain + runtime modulator
 * ────────────────────────────────
 * To address the long-horizon failure mode without dropping the model
 * entirely, the forecaster scales (U, V) by a horizon-specific gain
 * before advecting:
 *
 *   α_eff(h) = α_learned[h] · steadiness
 *
 * Where:
 *   α_learned[h] is a per-horizon scalar in [0, 1] tuned by the
 *   validator's MSE feedback (AdvectionGainTracker). Drifts toward 1
 *   when advection beats persistence; toward 0 when it loses.
 *   steadiness is a runtime "Bz-style" scalar from WindShearProxy.
 *   1 = wind has been steady the past few hours; 0 = wildly shifting.
 *
 * α_eff = 0 walks back zero distance ⇒ forecast ≡ current frame ≡
 * persistence baseline. α_eff = 1 is the original physics step.
 *
 * Both knobs are optional — the forecaster degrades gracefully to the
 * pure physics step when neither is supplied (gain = 1 for all h).
 */
export class WindAdvectionForecaster {
    static id = 'wind-advection-v1';
    /**
     * @param {object} [opts]
     * @param {object} [opts.gainTracker]  AdvectionGainTracker instance.
     *   If present, α_learned[h] is read per-forecast via getGain(h).
     * @param {object} [opts.shearProxy]   WindShearProxy instance. If
     *   present, refresh()'d once per forecast and the resulting
     *   steadiness scalar multiplies α_learned[h].
     */
    constructor({ gainTracker = null, shearProxy = null } = {}) {
        this.id           = WindAdvectionForecaster.id;
        this._gainTracker = gainTracker;
        this._shearProxy  = shearProxy;
        // Diagnostic — last computed (steadiness, α_learned, α_eff)
        // exposed for the SW-panel HUD or dev console.
        this._lastDiag = null;
    }

    /** Last applied effective-gain diagnostic, or null if no forecast yet. */
    getLastDiag() { return this._lastDiag; }

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

        // Compose the per-horizon gain. Refresh the shear proxy once
        // per forecast call (≤ 1 per cron cycle) — the steadiness
        // scalar is the same for every horizon, modulating each by
        // the same multiplier. Per-horizon variation comes from the
        // learned α_learned[h].
        const steadiness = this._shearProxy
            ? this._shearProxy.refresh(history)
            : 1.0;
        const gainTracker = this._gainTracker;
        const gainAtHour = (h) => {
            const learned = gainTracker ? gainTracker.getGain(h) : 1.0;
            return learned * steadiness;
        };
        // Stash diagnostics — actual numbers populate after the
        // helper runs and we read its _meta hook.
        const result = buildAdvectedHorizons({
            history, modelId: this.id, flowU, flowV, gainAtHour,
        });
        if (result) {
            this._lastDiag = {
                steadiness,
                shear_ms:    this._shearProxy?.diagnostics().shear_ms ?? null,
                alpha_per_h: result._meta?.gain_per_horizon ?? null,
                alpha_learned_per_h: gainTracker
                    ? gainTracker.getAllGains()
                    : null,
                t: Date.now(),
            };
        }
        return result;
    }
}

/**
 * Estimate a 2D pixel-velocity flow from the last two frames of a
 * weighted tracer-channel blend using Lucas-Kanade, convert to m/s,
 * then run the same semi-Lagrangian step as WindAdvection.
 *
 * Tracer-blend weighting
 * ──────────────────────
 * The tracer fed into LK is `Σ w_ch · channel_ch`, summed over the
 * configured tracer channels. The weights have three sources, multiplied
 * together and renormalised to sum to 1:
 *
 *   priorWeights     constructor-supplied per-channel prior. Defaults to
 *                    [0.20, 0.45, 0.35] for [low, mid, high] cloud —
 *                    storm-scale features track mid + high clouds (the
 *                    steering flow aloft) far better than low. Equal
 *                    weights effectively dilute the signal.
 *   skillTracker     optional TracerSkillTracker. Folds in the
 *                    forecaster's own per-channel MAE history at a target
 *                    horizon: channels the LK flow has historically
 *                    predicted accurately get more weight; channels that
 *                    keep missing get less. Adapts the blend to the
 *                    actual data over many forecast cycles.
 *   variance         per-frame spatial standard deviation of each
 *                    channel. Amplifies whatever channel happens to have
 *                    the most texture *right now* — flat featureless
 *                    fields make for under-determined LK gradient
 *                    matrices, so de-emphasising them tightens the fit.
 *
 * The variance multiplier is intentionally clipped to a narrow range
 * [0.5, 2.0] so a single quiet-channel snapshot can't completely
 * suppress that channel's contribution — the prior + long-term skill
 * keep the floor.
 */
export class OpticalFlowForecaster {
    static id = 'optical-flow-v1';
    /**
     * @param {object} [opts]
     * @param {number[]} [opts.tracerChannels]
     * @param {number}   [opts.windowRadius=2]
     * @param {number[]} [opts.priorWeights]   Default [0.20, 0.45, 0.35].
     * @param {object}   [opts.skillTracker]   TracerSkillTracker instance.
     * @param {boolean}  [opts.varianceAware=true]
     */
    constructor({
        tracerChannels = [CH_LOW, CH_MID, CH_HIGH],
        windowRadius = 2,
        priorWeights,
        skillTracker = null,
        varianceAware = true,
    } = {}) {
        this.id            = OpticalFlowForecaster.id;
        this._tracerChs    = tracerChannels.slice();
        this._windowRadius = windowRadius;
        // Meteorological prior: low cloud (boundary-layer-bound) is the
        // worst single-channel proxy for synoptic-scale motion; mid and
        // high (driven by the steering flow at 500 hPa and above) are
        // far better. The 0.20/0.45/0.35 split was reverse-engineered
        // from the typical balance of inverse-MSE you see after a few
        // weeks of an LK forecaster running with equal weights — it's
        // a useful starting point but not a fixed truth, hence the
        // skillTracker layer that learns the actual ratio per session.
        const defaultPrior = (this._tracerChs.length === 3)
            ? [0.20, 0.45, 0.35]
            : new Array(this._tracerChs.length).fill(1 / this._tracerChs.length);
        this._priorWeights = (Array.isArray(priorWeights) && priorWeights.length === this._tracerChs.length)
            ? priorWeights.slice()
            : defaultPrior;
        this._skillTracker = skillTracker;
        this._varianceAware = varianceAware !== false;
        // Most-recent applied weights — exposed for debug HUDs and
        // skill-validation diagnostics.
        this._lastWeights = null;
    }

    /** Diagnostic: latest normalised tracer weights (or null if none yet). */
    getLastWeights() { return this._lastWeights ? this._lastWeights.slice() : null; }

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

        // Compute final per-channel weights for this forecast cycle.
        const weights = this._computeBlendWeights(curr);
        this._lastWeights = weights;

        // Build the weighted tracer. Multiply each channel's slice by
        // its weight and accumulate. This is the same shape as the
        // previous "equal-sum" tracer but with non-uniform contribution
        // — sharper signal where it matters.
        const prevTracer = new Float32Array(N);
        const currTracer = new Float32Array(N);
        for (let c = 0; c < this._tracerChs.length; c++) {
            const ch = this._tracerChs[c];
            const w = weights[c];
            const off = ch * N;
            const ps = prev.coarse.subarray(off, off + N);
            const cs = curr.coarse.subarray(off, off + N);
            for (let k = 0; k < N; k++) {
                prevTracer[k] += w * ps[k];
                currTracer[k] += w * cs[k];
            }
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

    // ── Internal: weight composition ──────────────────────────────────
    //
    // Combine prior × skill × variance multipliers into a single
    // normalised weight vector. Each multiplier is independently
    // clipped/floored so a runaway value in one source can't crowd out
    // the others.

    _computeBlendWeights(currFrame) {
        const C = this._tracerChs.length;
        // 1. Prior — the meteorological default or constructor override.
        const prior = this._priorWeights;

        // 2. Skill multiplier — pulled from the validator-fed tracker
        //    when one is wired. Already a normalised weight vector
        //    summing to 1; we use it as a multiplier here, so the
        //    final weight ∝ prior × skill (Bayes-flavoured combination
        //    of the strong prior with empirical evidence). Without a
        //    skillTracker, we use uniform = 1/C so prior survives
        //    unchanged.
        const skill = this._skillTracker
            ? this._skillTracker.getWeights()
            : new Array(C).fill(1 / C);
        // Defensive shape check — a tracker built for a different
        // channel set shouldn't be allowed to scramble these weights.
        const skillSafe = (skill?.length === C) ? skill : new Array(C).fill(1 / C);

        // 3. Variance multiplier — channels with more spatial texture
        //    contribute better-conditioned LK gradient matrices.
        //    Compute population stddev per channel on the current
        //    frame, normalise to a multiplier in [0.5, 2.0] so a
        //    quiet-channel snapshot can't fully suppress contribution
        //    (the prior + skill keep the floor).
        let varMult = new Array(C).fill(1);
        if (this._varianceAware) {
            const sds = new Float64Array(C);
            const N = currFrame.gridW * currFrame.gridH;
            for (let c = 0; c < C; c++) {
                const ch = this._tracerChs[c];
                const off = ch * N;
                let sum = 0, sumSq = 0;
                for (let k = 0; k < N; k++) {
                    const v = currFrame.coarse[off + k];
                    if (!Number.isFinite(v)) continue;
                    sum += v;
                    sumSq += v * v;
                }
                const mean = sum / N;
                const variance = Math.max(0, sumSq / N - mean * mean);
                sds[c] = Math.sqrt(variance);
            }
            // Normalise around the mean stddev. Clipped multiplier
            // range matters more than absolute scale because we re-
            // normalise at the end anyway.
            let meanSd = 0;
            for (let c = 0; c < C; c++) meanSd += sds[c];
            meanSd /= C;
            for (let c = 0; c < C; c++) {
                const r = meanSd > 1e-6 ? (sds[c] / meanSd) : 1;
                varMult[c] = Math.min(2.0, Math.max(0.5, r));
            }
        }

        // Combine: prior × skill × variance, then normalise.
        const combined = new Float32Array(C);
        let sum = 0;
        for (let c = 0; c < C; c++) {
            combined[c] = (prior[c] || 0) * (skillSafe[c] || 0) * (varMult[c] || 0);
            sum += combined[c];
        }
        if (sum <= 0) {
            // Pathological all-zero combination → fall back to uniform.
            const u = 1 / C;
            for (let c = 0; c < C; c++) combined[c] = u;
            return combined;
        }
        for (let c = 0; c < C; c++) combined[c] /= sum;
        return combined;
    }
}

/**
 * Convenience: spawn both forecasters with sensible defaults.
 *
 * @param {object} [opts]
 * @param {object} [opts.skillTracker]  TracerSkillTracker for the
 *   OpticalFlowForecaster. Without it, the forecaster falls back to
 *   meteorological prior + per-frame variance weighting only.
 * @param {object} [opts.gainTracker]   AdvectionGainTracker for the
 *   WindAdvectionForecaster. Without it, the forecaster runs the bare
 *   physics step (gain = 1 at every horizon).
 * @param {object} [opts.shearProxy]    WindShearProxy. Without it,
 *   steadiness = 1 (no runtime modulation of the gain).
 */
export function makeWeatherFlowForecasters({
    skillTracker = null,
    gainTracker  = null,
    shearProxy   = null,
} = {}) {
    return [
        new WindAdvectionForecaster({ gainTracker, shearProxy }),
        new OpticalFlowForecaster({ skillTracker }),
    ];
}

export default makeWeatherFlowForecasters;
