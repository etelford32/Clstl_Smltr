/**
 * precip-forecast.js — precipitation-specialised forecasters
 *
 * Three models, each registered as a peer of PersistenceForecaster in the
 * weather-forecast.js registry:
 *
 *   PrecipClimatologyForecaster
 *     For each (cell, target_local_hour) returns the long-running climatology
 *     mean from PrecipClimatology. Knows nothing about the current weather —
 *     this is the floor that any "real" model has to clear at long horizons
 *     (12-24 h) to claim it's actually predicting *this storm* rather than
 *     rediscovering "rain peaks at the coast in the late afternoon".
 *
 *   PrecipAnomalyPersistenceForecaster
 *     The right baseline for diurnal-cycle channels. Subtract the cell's
 *     current-hour climatology from the latest observation (= anomaly),
 *     persist the anomaly, re-add the *target-hour* climatology. Shifts
 *     persistence to forecast the *deviation from normal* rather than
 *     "tomorrow looks like today" — meaningful at 12-24 h where naive
 *     persistence beats AR because the diurnal cycle dominates.
 *
 *   PrecipAnomalyARForecaster
 *     Pool an AR(3) per channel across the 2592-cell grid on the log1p(precip)
 *     anomaly. log1p tames the heavy tail; pooling stabilises the fit at
 *     ~24 samples/cell × 2592 cells = 62 K samples per pool. Forecast the
 *     anomaly, expm1 back, re-add climatology. Heavy-tailed channels benefit
 *     from the variance-stabilising transform; raw AR on mm/hr is biased
 *     because the noise grows with the mean.
 *
 * All three emit full 9-channel CHW Float32 frames — matching the shape
 * produced by PersistenceForecaster — but only the precip channel (8) is
 * model-specific. Other channels are filled with the latest observation
 * so the forecast frame is still valid for downstream consumers (resolver,
 * IsobarLayer) that don't care which model produced precip.
 *
 * Channel index 8 is locked by weather-history.js's CHW layout. If that
 * layout ever moves, update PRECIP_CHANNEL here and in
 * nasa-precip-extractor.js / precip-climatology.js (the latter takes a
 * `precipChannelOffset` arg).
 */

import { fitAR, forecastAR } from './solar-weather-forecast.js';
import { FORECAST_HORIZONS_H } from './weather-forecast.js';

const PRECIP_CHANNEL = 8;
const NUM_CHANNELS   = 9;
// Pooled AR samples are demeaned per cell and log1p-transformed. Order 3
// is the smallest order that captures both the immediate persistence
// term and the next-step decay; higher orders need more history than
// 24 samples/cell can robustly provide.
const AR_ORDER = 3;

// ── Helpers ────────────────────────────────────────────────────────────────

function fillNonPrecipFromLatest(out, coarseLatest, gridW, gridH) {
    const N = gridW * gridH;
    for (let ch = 0; ch < NUM_CHANNELS; ch++) {
        if (ch === PRECIP_CHANNEL) continue;
        const off = ch * N;
        out.set(coarseLatest.subarray(off, off + N), off);
    }
}

function clampNonNegative(arr) {
    for (let i = 0; i < arr.length; i++) {
        if (!(arr[i] >= 0)) arr[i] = 0;     // also catches NaN
    }
}

// ── Climatology forecaster ─────────────────────────────────────────────────

export class PrecipClimatologyForecaster {
    static id = 'precip-climatology-v1';

    /**
     * @param {{ climatology: import('./precip-climatology.js').PrecipClimatology }} opts
     */
    constructor({ climatology }) {
        if (!climatology) throw new Error('PrecipClimatologyForecaster: climatology required');
        this.id = PrecipClimatologyForecaster.id;
        this._clim = climatology;
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
            fillNonPrecipFromLatest(frame, coarse, gridW, gridH);

            const clim = this._clim.sample({ targetMs, gridW, gridH });
            const off  = PRECIP_CHANNEL * N;
            if (clim) {
                frame.set(clim, off);
            } else {
                // Climatology empty — degrade gracefully to persistence
                // for this horizon. Still ranks above "predict NaN" and
                // gives the validator something to score.
                frame.set(coarse.subarray(off, off + N), off);
            }
            out[h] = frame;
        }
        return {
            model_id: this.id,
            issued_ms: t,
            horizons: FORECAST_HORIZONS_H.slice(),
            gridW, gridH,
            frames: out,
            target_ms: targets,
        };
    }
}

// ── Anomaly persistence forecaster ─────────────────────────────────────────

export class PrecipAnomalyPersistenceForecaster {
    static id = 'precip-anomaly-persistence-v1';

    constructor({ climatology }) {
        if (!climatology) throw new Error('PrecipAnomalyPersistenceForecaster: climatology required');
        this.id = PrecipAnomalyPersistenceForecaster.id;
        this._clim = climatology;
    }

    forecast({ history }) {
        const frames = history.all();
        if (frames.length === 0) return null;
        const newest = frames[frames.length - 1];
        const { t, gridW, gridH, coarse } = newest;
        const N = gridW * gridH;
        const off = PRECIP_CHANNEL * N;
        const obsPrecip = coarse.subarray(off, off + N);

        // Anomaly at the *current* time = observed - climatology(now)
        const climNow = this._clim.sample({ targetMs: t, gridW, gridH });
        const anom = new Float32Array(N);
        if (climNow) {
            for (let k = 0; k < N; k++) anom[k] = (obsPrecip[k] || 0) - climNow[k];
        } else {
            // No climatology yet → anomaly = 0 → forecast equals climatology
            // at the target time, which is what we'd return anyway.
        }

        const out = {};
        const targets = {};
        for (const h of FORECAST_HORIZONS_H) {
            const targetMs = t + h * 3_600_000;
            targets[h] = targetMs;
            const frame = new Float32Array(N * NUM_CHANNELS);
            fillNonPrecipFromLatest(frame, coarse, gridW, gridH);

            const climTarget = this._clim.sample({ targetMs, gridW, gridH });
            const fc = new Float32Array(N);
            if (climTarget) {
                // Re-add target-hour climatology to persisted anomaly. The
                // anomaly is *not* horizon-decayed here: that's what
                // distinguishes this from the AR variant. Honest-to-the-
                // baseline: just persistence, but in the right space.
                for (let k = 0; k < N; k++) fc[k] = climTarget[k] + anom[k];
            } else {
                fc.set(obsPrecip);
            }
            clampNonNegative(fc);
            frame.set(fc, off);
            out[h] = frame;
        }

        return {
            model_id: this.id,
            issued_ms: t,
            horizons: FORECAST_HORIZONS_H.slice(),
            gridW, gridH,
            frames: out,
            target_ms: targets,
        };
    }
}

// ── Anomaly AR forecaster ──────────────────────────────────────────────────

export class PrecipAnomalyARForecaster {
    static id = 'precip-anomaly-ar3-v1';

    constructor({ climatology, minHistory = 6 }) {
        if (!climatology) throw new Error('PrecipAnomalyARForecaster: climatology required');
        this.id = PrecipAnomalyARForecaster.id;
        this._clim = climatology;
        this._minHistory = minHistory;
    }

    forecast({ history }) {
        const frames = history.all();
        if (frames.length < this._minHistory) return null;

        const newest = frames[frames.length - 1];
        const { t, gridW, gridH, coarse } = newest;
        const N = gridW * gridH;
        const off = PRECIP_CHANNEL * N;
        const T = frames.length;

        // Build per-cell log1p anomaly history. Climatology may not exist
        // for early sessions; fall back to per-cell mean of the window
        // so the AR fit still has something stationary to chew on.
        const anomSeries = new Array(N);
        const cellMean   = new Float32Array(N);
        const fallbackUsed = !this._clim;

        // Pre-fetch the climatology per frame timestamp to avoid N×T calls.
        const climPerT = new Array(T);
        let anyClim = false;
        for (let s = 0; s < T; s++) {
            const c = this._clim?.sample({ targetMs: frames[s].t, gridW, gridH });
            if (c) anyClim = true;
            climPerT[s] = c;
        }

        for (let k = 0; k < N; k++) {
            const series = new Array(T);
            let sum = 0, cnt = 0;
            for (let s = 0; s < T; s++) {
                const fr = frames[s];
                if (!fr || !fr.coarse) { series[s] = 0; continue; }
                const v = fr.coarse[off + k];
                const c = anyClim ? (climPerT[s]?.[k] ?? 0) : 0;
                // log1p tames the heavy tail. Anomaly = log1p(obs) -
                // log1p(climatology) keeps both terms in the same units
                // so subtraction is meaningful for skewed data.
                const a = Math.log1p(Math.max(0, v || 0)) - Math.log1p(Math.max(0, c));
                series[s] = a;
                sum += a; cnt++;
            }
            anomSeries[k] = series;
            cellMean[k]   = cnt > 0 ? sum / cnt : 0;
        }

        // Pool: concatenate every cell's demeaned anomaly series into one
        // long vector and fit ONE AR(3) shared across cells. Keeps coefs
        // stable on 24-sample tails by sharing strength across the grid.
        const pooled = new Float64Array(T * N);
        for (let k = 0; k < N; k++) {
            const s = anomSeries[k];
            const m = cellMean[k];
            const base = k * T;
            for (let i = 0; i < T; i++) pooled[base + i] = s[i] - m;
        }
        const arModel = fitAR(Array.from(pooled), AR_ORDER);

        // Per-cell forecast: apply the global AR coefs to the cell's
        // demeaned anomaly tail, then re-add cellMean and the target-hour
        // climatology in the original units (after expm1).
        const maxH = FORECAST_HORIZONS_H[FORECAST_HORIZONS_H.length - 1];
        const out = {};
        const targets = {};
        const horizonFrames = {};
        for (const h of FORECAST_HORIZONS_H) {
            const frame = new Float32Array(N * NUM_CHANNELS);
            fillNonPrecipFromLatest(frame, coarse, gridW, gridH);
            horizonFrames[h] = frame;
            targets[h] = t + h * 3_600_000;
        }

        for (let k = 0; k < N; k++) {
            const tail = anomSeries[k].slice(-Math.max(AR_ORDER, T));
            const m    = cellMean[k];
            const demeanedTail = tail.map(x => x - m);
            const fc = forecastAR(arModel, demeanedTail, maxH);
            for (const h of FORECAST_HORIZONS_H) {
                const targetMs   = targets[h];
                const climTarget = this._clim?.sample({ targetMs, gridW, gridH });
                const climVal    = climTarget ? climTarget[k] : 0;
                // forecastAR clamps mean into [0, 9] (Kp range). For
                // precipitation we ignore that clamp — the value is in
                // log-anomaly space, not physical units.
                const anomLog    = (fc.mean[h - 1] ?? 0) + m;
                const targetLog  = anomLog + Math.log1p(Math.max(0, climVal));
                const mmhr       = Math.max(0, Math.expm1(targetLog));
                horizonFrames[h][PRECIP_CHANNEL * N + k] = mmhr;
            }
        }

        for (const h of FORECAST_HORIZONS_H) out[h] = horizonFrames[h];

        return {
            model_id: this.id,
            issued_ms: t,
            horizons: FORECAST_HORIZONS_H.slice(),
            gridW, gridH,
            frames: out,
            target_ms: targets,
            // Diagnostic: surfaces the fit quality for offline review.
            // Not consumed by the validator; just helps a developer
            // confirm the AR coefs aren't drifting to nonsense.
            _meta: {
                ar_phi:  arModel.phi,
                ar_sigma: Math.sqrt(arModel.sigma2),
                fallback_no_climatology: fallbackUsed,
            },
        };
    }
}

export { PRECIP_CHANNEL };
