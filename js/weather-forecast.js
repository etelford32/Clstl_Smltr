/**
 * weather-forecast.js — gridded weather forecaster + registry
 *
 * Companion to weather-history.js / weather-frame-resolver.js. Where the
 * resolver paints what we have observed, this module produces what we
 * predict. Output frames have the same CHW Float32 shape as observations
 * so they flow through the same _decodeCoarse pipeline downstream
 * consumers (resolver scratch, IsobarLayer, WindParticles) already use.
 *
 * Architecture
 * ────────────
 *   ForecastRegistry         — singleton-ish hub that owns the active
 *                              forecasters, dispatches per-ingest fan-out,
 *                              and emits a unified 'weather-forecast-update'
 *                              event keyed by issued_at + horizons.
 *   Forecaster (interface)   — every model implements a static `id` plus
 *                              forecast({ history }) → { issued_ms,
 *                              horizons[], frames: { h: Float32Array,
 *                              … }, gridW, gridH, model_id, sigma? }.
 *                              Returns null when there is not enough
 *                              history to produce anything sensible.
 *   PersistenceForecaster    — phase-1 baseline. Every horizon gets the
 *                              latest observation. Murphy skill against
 *                              this is the bar every other model has to
 *                              clear.
 *
 * Why a registry from day 1
 *   The downstream story (EARTH_ML_FIRST_PRINCIPLES.md) is a leaderboard
 *   of mutually-comparable models — reservoir computing, symbolic
 *   regression, LLM-gated, etc. — each scored on the same observations.
 *   Building the registry now (even with one entry) makes adding the next
 *   model a one-liner and forces every contender to expose the same
 *   interface, which is what the validator consumes.
 *
 * Output frame shape
 *   `frames[h]` is a CHW Float32Array of length `gridW * gridH * NUM_CHANNELS`
 *   matching the on-disk format in weather-history.js. A future Phase 3
 *   `forecast` event will let the resolver render forecast frames directly
 *   when simTimeMs > newest history frame.
 *
 * Channel order (lockstep with weather-feed.js / weather-history.js):
 *   0 T  1 P  2 RH  3 windU  4 windV
 *   5 cloud_low  6 cloud_mid  7 cloud_high  8 precip
 */

import { NUM_CHANNELS } from './weather-history.js';

export const CHANNEL_NAMES = [
    'T', 'P', 'RH', 'U', 'V',
    'cl_low', 'cl_mid', 'cl_high', 'precip',
];

// Horizons in hours. Match the targets in WEATHER_FORECAST_PLAN.md so the
// validator's skill table has fixed columns the SW panel can render
// without re-laying-out on first ingest.
export const FORECAST_HORIZONS_H = [1, 3, 6, 12, 24];

// ── Persistence forecaster ─────────────────────────────────────────────────

/**
 * The trivial baseline: forecast(t + h) ≈ observation(t).
 *
 * Why ship this first
 *   1. It's the right reference. Murphy skill = 1 − MSE_model / MSE_persistence.
 *      Without persistence in the registry, no other model can be scored
 *      meaningfully.
 *   2. It validates the wiring. If the validator can score persistence
 *      correctly (and it should — MAE will be non-zero, skill will be 0
 *      vs itself) then the wiring is sound for whatever comes next.
 *   3. Diurnal cycle is strong; persistence-at-24h is genuinely hard to
 *      beat. Half the value of running this baseline is realising how
 *      much of the apparent "predictive skill" of more complex models is
 *      actually just rediscovering "tomorrow's noon looks like today's
 *      noon".
 */
export class PersistenceForecaster {
    static id = 'persistence-v1';

    constructor() {
        this.id = PersistenceForecaster.id;
    }

    /**
     * @param {{ history: import('./weather-history.js').WeatherHistory }} ctx
     * @returns {null | {
     *   model_id: string,
     *   issued_ms: number,
     *   horizons: number[],
     *   gridW: number,
     *   gridH: number,
     *   frames: Object<number, Float32Array>,   // keyed by horizon-hours
     *   target_ms: Object<number, number>,      // keyed by horizon-hours
     * }}
     */
    forecast({ history }) {
        const frames = history.all();
        if (frames.length === 0) return null;
        const newest = frames[frames.length - 1];
        const { t, gridW, gridH, coarse } = newest;

        // Defensive copy per horizon. The receiver (validator, future
        // resolver) is allowed to keep a reference; we don't want the
        // history ring's buffer aliased into the registry's pending queue.
        const out = {};
        const targets = {};
        for (const h of FORECAST_HORIZONS_H) {
            out[h] = new Float32Array(coarse);
            targets[h] = t + h * 3_600_000;
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

// ── Open-Meteo NWP forecaster ──────────────────────────────────────────────

/**
 * Wraps the upstream NWP (Open-Meteo GFS-blend) already in the WeatherHistory
 * forecast ring as a Forecaster. No prediction logic — the heavy lifting
 * happens on NOAA / DWD's compute. We just expose what's in the ring as
 * predictions so the validator can score them against the in-browser models
 * (persistence, anomaly-AR, optical-flow, wind-advection) on the same
 * pooled-MAE / Murphy-skill scale.
 *
 * Honesty model
 *   At each weather-history-ingest event (T0), runAll() invokes us. We read
 *   the forecast ring's frame at T0 + h·HOUR for each h ∈ FORECAST_HORIZONS_H
 *   and register it as a pending prediction. WeatherHistory.purgeStaleForecasts
 *   has already removed the ring entry at T0 by the time we run, so we cannot
 *   accidentally use ground truth as a prediction. When the observation for
 *   T0 + h arrives an hour later, the validator scores our pending row against
 *   it just like every other forecaster's output.
 *
 * Caveat
 *   The NWP frame for target T was issued by some GFS cycle (00/06/12/18 UTC)
 *   before T0. The effective lead time at NWP-issue is therefore ≥ h hours,
 *   not exactly h. Our headline "h-hour skill" characterises "what does the
 *   latest GFS run available to a browser at T0 say about T0 + h" — which is
 *   the right thing for ranking models in this registry, but slightly
 *   pessimistic for GFS vs. its native ≥h-hour skill at issue time.
 */
const HOUR_MS = 3_600_000;

export class OpenMeteoNWPForecaster {
    static id = 'open-meteo-gfs-v1';

    constructor() {
        this.id = OpenMeteoNWPForecaster.id;
    }

    forecast({ history }) {
        const past = history.all();
        if (past.length === 0) return null;
        const newest = past[past.length - 1];
        const { t: issuedMs, gridW, gridH } = newest;

        const futures = typeof history.allForecasts === 'function'
            ? history.allForecasts()
            : [];
        if (futures.length === 0) return null;

        // Index by hour-aligned t. WeatherHistory.ingestForecast already
        // hour-floors `t`, so an exact === lookup suffices.
        const byTarget = new Map();
        for (const f of futures) byTarget.set(f.t, f);

        const frames  = {};
        const targets = {};
        const matched = [];
        for (const h of FORECAST_HORIZONS_H) {
            const tt = Math.floor((issuedMs + h * HOUR_MS) / HOUR_MS) * HOUR_MS;
            const f  = byTarget.get(tt);
            if (!f || f.gridW !== gridW || f.gridH !== gridH) continue;
            if (!(f.coarse instanceof Float32Array)) continue;
            // Defensive copy. The forecast ring entry may be overwritten on
            // the next batch fetch; the validator may hold this in IDB for
            // up to MATCH_GRACE_MS waiting for ground truth.
            frames[h]  = new Float32Array(f.coarse);
            targets[h] = f.t;
            matched.push(h);
        }
        if (matched.length === 0) return null;

        return {
            model_id:  this.id,
            issued_ms: issuedMs,
            horizons:  matched,
            gridW, gridH,
            frames,
            target_ms: targets,
        };
    }
}

// ── Forecast registry ──────────────────────────────────────────────────────

/**
 * Holds the active forecasters, drives them on each new observation, and
 * emits a single coalesced 'weather-forecast-update' event the validator
 * (and, eventually, the resolver) listens to.
 *
 * The registry intentionally swallows per-forecaster errors — one model's
 * bug must not take the others (or the page) down. Failures are logged at
 * `info` so they're visible in DevTools without spamming the console.
 */
export class ForecastRegistry {
    constructor({ history } = {}) {
        if (!history) throw new Error('ForecastRegistry: history is required');
        this._history = history;
        /** @type {Map<string, Forecaster>} */
        this._forecasters = new Map();
        /** Most-recent forecast object per model_id, exposed to the
         *  validator and the future resolver hook. Plain object so
         *  iteration is predictable. */
        this._latest = {};
        // Subscribed to weather-history-ingest dispatches from
        // WeatherHistory.ingest. Re-bound so we can remove on stop().
        this._onIngest = this._onIngest.bind(this);
        document.addEventListener('weather-history-ingest', this._onIngest);
    }

    /** Add a forecaster instance. Idempotent on model_id. */
    register(forecaster) {
        if (!forecaster?.id) {
            throw new Error('ForecastRegistry.register: forecaster missing static id');
        }
        this._forecasters.set(forecaster.id, forecaster);
        return this;
    }

    /** Names of registered models, deterministic insertion order. */
    listModels() { return [...this._forecasters.keys()]; }

    /**
     * Run every registered forecaster against the current history and
     * emit the union as a single event. Safe to call manually (e.g. on
     * page load before the first ingest fires). Returns a map of
     * model_id → forecast result for the caller's convenience.
     */
    runAll() {
        const out = {};
        for (const [id, fc] of this._forecasters) {
            try {
                const result = fc.forecast({ history: this._history });
                if (result) out[id] = result;
            } catch (err) {
                console.info(`[ForecastRegistry] ${id} threw:`, err?.message);
            }
        }
        this._latest = out;
        document.dispatchEvent(new CustomEvent('weather-forecast-update', {
            detail: { results: out, issued_ms: Date.now() },
        }));
        return out;
    }

    /** Latest output from `id`, or null. */
    getLatest(id) { return this._latest[id] ?? null; }

    /** All latest outputs as a plain object — used by validator + UI. */
    getAllLatest() { return this._latest; }

    stop() {
        document.removeEventListener('weather-history-ingest', this._onIngest);
        this._forecasters.clear();
        this._latest = {};
    }

    // ── Internal ──────────────────────────────────────────────────────────

    _onIngest() {
        // The history ring has just absorbed a new frame. That gives every
        // forecaster a fresh tail to predict from. Run them all and emit.
        // Cheap for persistence (~1 alloc per horizon), more expensive for
        // future AR/reservoir models — but those are still O(grid) per
        // call, well under one rAF.
        this.runAll();
    }
}

export { NUM_CHANNELS };
