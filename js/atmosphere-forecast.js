/**
 * atmosphere-forecast.js — generic climatology / anomaly-persistence /
 *                          anomaly-AR forecasters for any channel set
 *
 * The precip module pioneered this trio (Climatology → AnomalyPersistence
 * → AnomalyAR). Clouds and wind benefit from the exact same structure
 * with one knob change: precip uses log1p to tame the heavy storm-tail;
 * clouds and wind don't — their distributions are bounded (cloud
 * fraction ∈ [0,1]) or roughly Gaussian (wind anomaly).
 *
 * makeAtmosphereForecasters({ climatology, idPrefix, transform }) returns
 * three Forecaster instances ready to register into ForecastRegistry:
 *
 *   <prefix>-climatology-v1          long-horizon floor (diurnal cycle)
 *   <prefix>-anomaly-persistence-v1  baseline that subtracts the cycle
 *   <prefix>-anomaly-ar3-v1          pooled AR(3) on the de-meaned anomaly
 *
 * `transform` is optional: { fwd: x => log1p(x), inv: y => expm1(y) }.
 * Identity by default.
 */

import { fitAR, forecastAR } from './solar-weather-forecast.js';
import { FORECAST_HORIZONS_H } from './weather-forecast.js';

const NUM_CHANNELS = 9;
const AR_ORDER     = 3;

// Identity transform — used by clouds + wind. log1p variant lives in
// precip-forecast.js where it's already calibrated against IMERG.
const IDENTITY = { fwd: x => x, inv: y => y };

// ── Helpers ────────────────────────────────────────────────────────────────

function fillFromLatest(out, coarseLatest, gridW, gridH, skipChannels) {
    const N = gridW * gridH;
    const skip = new Set(skipChannels);
    for (let ch = 0; ch < NUM_CHANNELS; ch++) {
        if (skip.has(ch)) continue;
        const off = ch * N;
        out.set(coarseLatest.subarray(off, off + N), off);
    }
}

function clampNonNegative(arr) {
    for (let i = 0; i < arr.length; i++) {
        if (!(arr[i] >= 0)) arr[i] = 0;
    }
}

// Apply a 9-channel "out" frame's `channels` slices using a CHW slab
// the climatology returned (length = channels.length × N).
function writeChannelSlab(outFrame, slab, channels, gridW, gridH, clampNeg = false) {
    const N = gridW * gridH;
    for (let c = 0; c < channels.length; c++) {
        const dstOff = channels[c] * N;
        const src = slab.subarray(c * N, (c + 1) * N);
        outFrame.set(src, dstOff);
        if (clampNeg) {
            for (let k = 0; k < N; k++) {
                if (!(outFrame[dstOff + k] >= 0)) outFrame[dstOff + k] = 0;
            }
        }
    }
}

// ── Climatology forecaster ─────────────────────────────────────────────────

class ClimatologyForecaster {
    constructor({ id, climatology, channels, clampNeg, fillFromLatestCh }) {
        this.id          = id;
        this._clim       = climatology;
        this._channels   = channels;
        this._clampNeg   = !!clampNeg;
        this._skipFill   = fillFromLatestCh;   // copies through everything except our channels
    }

    forecast({ history }) {
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
            fillFromLatest(frame, coarse, gridW, gridH, this._skipFill);
            const slab = this._clim.sample({ targetMs, gridW, gridH });
            if (slab) {
                writeChannelSlab(frame, slab, this._channels, gridW, gridH, this._clampNeg);
            } else {
                // No climatology yet — fall through to current value
                // for our channels. Still strictly no worse than
                // persistence on those channels.
                for (const ch of this._channels) {
                    const off = ch * N;
                    frame.set(coarse.subarray(off, off + N), off);
                }
            }
            out[h] = frame;
        }
        return {
            model_id: this.id, issued_ms: t,
            horizons: FORECAST_HORIZONS_H.slice(),
            gridW, gridH, frames: out, target_ms: targets,
        };
    }
}

// ── Anomaly persistence forecaster ─────────────────────────────────────────

class AnomalyPersistenceForecaster {
    constructor({ id, climatology, channels, clampNeg, fillFromLatestCh, transform }) {
        this.id        = id;
        this._clim     = climatology;
        this._channels = channels;
        this._clampNeg = !!clampNeg;
        this._skipFill = fillFromLatestCh;
        this._tr       = transform || IDENTITY;
    }

    forecast({ history }) {
        const frames = history.all();
        if (frames.length === 0) return null;
        const newest = frames[frames.length - 1];
        const { t, gridW, gridH, coarse } = newest;
        const N = gridW * gridH;

        const climNow = this._clim.sample({ targetMs: t, gridW, gridH });
        // Per-channel anomaly = transform(observed) − transform(clim_now).
        // Stored as Float32Array(channels × N) for slicing.
        const C = this._channels.length;
        const anomSlab = new Float32Array(C * N);
        for (let c = 0; c < C; c++) {
            const ch  = this._channels[c];
            const off = ch * N;
            const aBase = c * N;
            for (let k = 0; k < N; k++) {
                const v = coarse[off + k];
                if (!Number.isFinite(v)) { anomSlab[aBase + k] = 0; continue; }
                const cv = climNow ? climNow[c * N + k] : 0;
                anomSlab[aBase + k] = this._tr.fwd(v) - this._tr.fwd(cv);
            }
        }

        const out = {};
        const targets = {};
        for (const h of FORECAST_HORIZONS_H) {
            const targetMs = t + h * 3_600_000;
            targets[h] = targetMs;
            const frame = new Float32Array(N * NUM_CHANNELS);
            fillFromLatest(frame, coarse, gridW, gridH, this._skipFill);

            const climTarget = this._clim.sample({ targetMs, gridW, gridH });
            for (let c = 0; c < C; c++) {
                const ch = this._channels[c];
                const off = ch * N;
                if (climTarget) {
                    for (let k = 0; k < N; k++) {
                        const ct = climTarget[c * N + k];
                        const y  = this._tr.fwd(ct) + anomSlab[c * N + k];
                        let val  = this._tr.inv(y);
                        if (this._clampNeg && !(val >= 0)) val = 0;
                        frame[off + k] = val;
                    }
                } else {
                    // No climatology → effectively persistence in the
                    // transformed space, then inverse-transform back.
                    for (let k = 0; k < N; k++) {
                        let val = this._tr.inv(this._tr.fwd(coarse[off + k]) + 0);
                        if (this._clampNeg && !(val >= 0)) val = 0;
                        frame[off + k] = val;
                    }
                }
            }
            out[h] = frame;
        }
        return {
            model_id: this.id, issued_ms: t,
            horizons: FORECAST_HORIZONS_H.slice(),
            gridW, gridH, frames: out, target_ms: targets,
        };
    }
}

// ── Anomaly AR forecaster ──────────────────────────────────────────────────
//
// One pooled AR(3) per channel — same trick as the precip variant, just
// generalised to multi-channel. Pooling demeaned per-cell anomaly series
// across the grid lifts the effective sample count from 24 (single cell)
// to ~62 K (whole grid), which keeps the AR coefficients stable.

class AnomalyARForecaster {
    constructor({ id, climatology, channels, clampNeg, fillFromLatestCh, transform, minHistory = 6 }) {
        this.id          = id;
        this._clim       = climatology;
        this._channels   = channels;
        this._clampNeg   = !!clampNeg;
        this._skipFill   = fillFromLatestCh;
        this._tr         = transform || IDENTITY;
        this._minHistory = minHistory;
    }

    forecast({ history }) {
        const frames = history.all();
        if (frames.length < this._minHistory) return null;
        const newest = frames[frames.length - 1];
        const { t, gridW, gridH, coarse } = newest;
        const N = gridW * gridH;
        const T = frames.length;
        const C = this._channels.length;
        const tr = this._tr;

        // Pre-fetch climatology per frame timestamp so we don't pay
        // N×T sample() calls.
        const climPerT = new Array(T);
        let anyClim = false;
        for (let s = 0; s < T; s++) {
            const slab = this._clim.sample({ targetMs: frames[s].t, gridW, gridH });
            if (slab) anyClim = true;
            climPerT[s] = slab;
        }

        const maxH = FORECAST_HORIZONS_H[FORECAST_HORIZONS_H.length - 1];
        const out = {};
        const targets = {};
        const horizonFrames = {};
        for (const h of FORECAST_HORIZONS_H) {
            const frame = new Float32Array(N * NUM_CHANNELS);
            fillFromLatest(frame, coarse, gridW, gridH, this._skipFill);
            horizonFrames[h] = frame;
            targets[h] = t + h * 3_600_000;
        }

        // Per channel: build anomaly series, pool, fit AR, forecast each cell.
        for (let c = 0; c < C; c++) {
            const ch = this._channels[c];
            const off = ch * N;

            // Per-cell anomaly time series (length T) + per-cell mean
            // for the pool demean step.
            const anomSeries = new Array(N);
            const cellMean   = new Float32Array(N);
            for (let k = 0; k < N; k++) {
                const series = new Array(T);
                let sum = 0, cnt = 0;
                for (let s = 0; s < T; s++) {
                    const fr = frames[s];
                    if (!fr || !fr.coarse) { series[s] = 0; continue; }
                    const v = fr.coarse[off + k];
                    const cv = anyClim ? (climPerT[s]?.[c * N + k] ?? 0) : 0;
                    const a = Number.isFinite(v) ? (tr.fwd(v) - tr.fwd(cv)) : 0;
                    series[s] = a;
                    sum += a; cnt++;
                }
                anomSeries[k] = series;
                cellMean[k]   = cnt > 0 ? sum / cnt : 0;
            }

            // Pool: concatenate every cell's demeaned anomaly into one
            // long vector and fit a single AR(3). Closed-form Levinson
            // -Durbin in fitAR — no autograd, ~10 ms in JS.
            const pooled = new Float64Array(T * N);
            for (let k = 0; k < N; k++) {
                const s = anomSeries[k];
                const m = cellMean[k];
                const base = k * T;
                for (let i = 0; i < T; i++) pooled[base + i] = s[i] - m;
            }
            const arModel = fitAR(Array.from(pooled), AR_ORDER);

            // Per-cell forecast: apply AR coefs to the cell's tail,
            // re-add cellMean, re-add target-hour climatology, inverse
            // transform.
            for (let k = 0; k < N; k++) {
                const tail = anomSeries[k].slice(-Math.max(AR_ORDER, T));
                const m    = cellMean[k];
                const demeanedTail = tail.map(x => x - m);
                const fc = forecastAR(arModel, demeanedTail, maxH);
                for (const h of FORECAST_HORIZONS_H) {
                    const slab = this._clim.sample({ targetMs: targets[h], gridW, gridH });
                    const climVal = slab ? slab[c * N + k] : 0;
                    const anomY  = (fc.mean[h - 1] ?? 0) + m;
                    const targetY = anomY + tr.fwd(climVal);
                    let val = tr.inv(targetY);
                    if (this._clampNeg && !(val >= 0)) val = 0;
                    horizonFrames[h][off + k] = val;
                }
            }
        }

        for (const h of FORECAST_HORIZONS_H) out[h] = horizonFrames[h];
        return {
            model_id: this.id, issued_ms: t,
            horizons: FORECAST_HORIZONS_H.slice(),
            gridW, gridH, frames: out, target_ms: targets,
        };
    }
}

// ── Factory ────────────────────────────────────────────────────────────────

/**
 * Build the standard climatology / anomaly-persistence / anomaly-AR
 * forecaster trio for a given channel set.
 *
 * @param {object} opts
 * @param {AtmosphereClimatology} opts.climatology  Already-open store.
 * @param {string} opts.idPrefix       Used in model_id, e.g. 'cloud' →
 *                                     'cloud-climatology-v1', etc.
 * @param {boolean} [opts.clampNeg]    Clamp output ≥ 0 (true for clouds,
 *                                     since cloud fraction is non-negative).
 *                                     Wind anomalies are signed → false.
 * @param {{ fwd, inv }} [opts.transform]  Variance-stabilising transform.
 *                                     Identity by default.
 */
export function makeAtmosphereForecasters({
    climatology, idPrefix, clampNeg = false, transform,
} = {}) {
    if (!climatology)  throw new Error('makeAtmosphereForecasters: climatology required');
    if (!idPrefix)     throw new Error('makeAtmosphereForecasters: idPrefix required');
    const channels = climatology.channels;
    const common = {
        climatology, channels, clampNeg,
        fillFromLatestCh: channels,
        transform,
    };
    return [
        new ClimatologyForecaster({
            ...common, id: `${idPrefix}-climatology-v1`,
        }),
        new AnomalyPersistenceForecaster({
            ...common, id: `${idPrefix}-anomaly-persistence-v1`,
        }),
        new AnomalyARForecaster({
            ...common, id: `${idPrefix}-anomaly-ar3-v1`,
        }),
    ];
}

export { ClimatologyForecaster, AnomalyPersistenceForecaster, AnomalyARForecaster };
export default makeAtmosphereForecasters;
