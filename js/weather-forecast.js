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

// ── Forecast paint provider ─────────────────────────────────────────────────

/**
 * Bridges a single "pinned" forecaster to the WeatherFrameResolver so the
 * future-scrub globe renders OUR forecast instead of the upstream NWP
 * frames sitting in the history forecast ring. This is the "Phase 3
 * resolver render" hook described in WEATHER_FORECAST_PLAN.md / the
 * weather-forecast.js header.
 *
 * Lifecycle
 *   On each `weather-history-ingest` (a fresh observation landed) it asks
 *   the pinned forecaster for a DENSE hourly set (0..maxHorizonH), decodes
 *   each coarse frame into a renderer trio once, and caches them keyed by
 *   absolute target_ms. h=0 is the current observation, so the cache spans
 *   [issued_ms, issued_ms + maxHorizonH·h] continuously and the
 *   live→forecast handoff has no seam.
 *
 *   The resolver calls bracket(tEff) on every future tick; that's a cheap
 *   binary-search + reference return (no decode), so dragging the slider
 *   is allocation-light. Recompute/decode happens once per ingest (~hourly).
 *
 * Open-Meteo is intentionally NOT consulted here — it stays a scored
 * leaderboard baseline (read from the history forecast ring by
 * OpenMeteoNWPForecaster), never a paint source.
 */
export class ForecastPaintProvider {
    /**
     * @param {object} opts
     * @param {{ forecastDense(ctx): object|null }} opts.forecaster  Pinned model.
     * @param {import('./weather-history.js').WeatherHistory} opts.history
     * @param {(coarse: Float32Array, gridW: number, gridH: number) => object} opts.decode
     *   CHW-coarse → { weatherBuf, windBuf, cloudBuf }. Pass the feed's
     *   _decodeCoarse so the forecast goes through the exact same
     *   bilinear+blur+pack pipeline observations use.
     * @param {number} [opts.maxHorizonH=24]
     * @param {boolean} [opts.handoffBeyondHorizon=true]  When true, bracket()
     *   returns null for timestamps past the pinned model's deepest horizon
     *   instead of clamping to the last frame. That null is the resolver's
     *   cue to fall through to WeatherHistory.bracket(), which lerps the
     *   Open-Meteo NWP forecast ring hour-by-hour — so the globe keeps
     *   evolving from +maxHorizonH out to the deepest loaded NWP batch
     *   instead of freezing on the RK2 model's last (near-persistence)
     *   frame for ~13 days. Set false to restore the old clamp behaviour.
     */
    constructor({ forecaster, history, decode, maxHorizonH = 24,
                  handoffBeyondHorizon = true } = {}) {
        if (!forecaster || typeof forecaster.forecastDense !== 'function') {
            throw new Error('ForecastPaintProvider: forecaster with forecastDense() required');
        }
        if (!history) throw new Error('ForecastPaintProvider: history required');
        if (typeof decode !== 'function') throw new Error('ForecastPaintProvider: decode fn required');
        this._forecaster  = forecaster;
        this._history     = history;
        this._decode      = decode;
        this._maxHorizonH = maxHorizonH;
        this._handoff     = handoffBeyondHorizon !== false;

        this._issuedMs = null;
        this._targets  = [];          // sorted ascending target_ms
        this._coarse   = new Map();   // target_ms → coarse CHW Float32 (cheap to hold)
        this._trios    = new Map();   // target_ms → decoded trio (LRU, filled lazily)
        this._trioCap  = 6;           // decoded-trio cap (~6 × 3.1 MB ≈ 19 MB)
        this._gridW    = null;
        this._gridH    = null;
        this._modelId  = forecaster.id ?? 'forecast';

        // Debounce ingest-driven rebuilds. forecastDense is ~350 ms on the
        // main thread; a cold-start backfill fires ~24 ingests in a tight
        // loop, which back-to-back would freeze the page for seconds. Coalesce
        // them into one rebuild ~200 ms after the burst settles. Direct
        // refresh() callers (construction warm-up, tests) are unaffected.
        this._refreshTimer = 0;
        this._onIngest = () => {
            if (typeof setTimeout !== 'function') { this.refresh(); return; }
            clearTimeout(this._refreshTimer);
            this._refreshTimer = setTimeout(() => this.refresh(), 200);
        };
        document.addEventListener('weather-history-ingest', this._onIngest);
    }

    /** Rebuild the dense forecast from current history (decode is lazy). */
    refresh() {
        let dense = null;
        try {
            dense = this._forecaster.forecastDense({
                history: this._history, maxHorizonH: this._maxHorizonH,
            });
        } catch (err) {
            console.info('[ForecastPaintProvider] forecast threw:', err?.message);
        }
        this._trios.clear();
        this._coarse.clear();
        this._targets = [];
        if (!dense) { this._issuedMs = null; return; }

        const targets = [];
        for (const h of dense.horizons) {
            const coarse = dense.frames[h];
            const tt     = dense.target_ms[h];
            if (!(coarse instanceof Float32Array) || !Number.isFinite(tt)) continue;
            // Store the coarse frame only; decode lazily in bracket() via
            // _trioFor(). A refresh runs hourly (every observation ingest), so
            // decoding all 25 frames here would burn ~375 ms and pin ~78 MB
            // of trios for frames the user may never scrub to.
            this._coarse.set(tt, coarse);
            targets.push(tt);
        }
        targets.sort((a, b) => a - b);
        this._targets  = targets;
        this._issuedMs = dense.issued_ms;
        this._gridW    = dense.gridW;
        this._gridH    = dense.gridH;
        this._modelId  = dense.model_id ?? this._modelId;
    }

    /**
     * Decode + LRU-cache the trio for a target_ms. Misses pay one decode
     * (~15 ms); hits are O(1). Capped at _trioCap so deep scrubs don't pin
     * the whole 0..maxHorizonH set in memory.
     */
    _trioFor(tt) {
        const hit = this._trios.get(tt);
        if (hit) { this._trios.delete(tt); this._trios.set(tt, hit); return hit; }  // bump recency
        const coarse = this._coarse.get(tt);
        if (!coarse) return null;
        const trio = this._decode(coarse, this._gridW, this._gridH);
        if (this._trios.size >= this._trioCap) {
            this._trios.delete(this._trios.keys().next().value);   // evict oldest
        }
        this._trios.set(tt, trio);
        return trio;
    }

    /**
     * Bracketing decoded trios for a future timestamp.
     *   - null when tEff is at/before the issue time (the resolver's own
     *     replay/clamp path owns the past) or no forecast is loaded.
     *   - null past the deepest horizon when handoffBeyondHorizon (default):
     *     the resolver then paints the NWP forecast ring instead, so the
     *     globe keeps evolving rather than freezing on the last RK2 frame.
     *   - otherwise clamps to the deepest horizon beyond the forecast range.
     * @returns {null | { a, b, frac, meta }}
     */
    bracket(tEff) {
        const targets = this._targets;
        if (targets.length === 0) return null;
        const first = targets[0];                       // == issued_ms (h=0 anchor)
        const last  = targets[targets.length - 1];
        if (tEff < first) return null;                  // past / live — not ours
        if (tEff >= last) {
            // Hand the deep future to the resolver's NWP-ring path. Returning
            // null is the documented signal in WeatherFrameResolver._dispatchReplay
            // to fall through to WeatherHistory.bracket(tEff). When the ring
            // has no frame deeper than `last` yet (prefetch still walking
            // forward), the ring clamps to its own newest forecast frame —
            // identical to the old behaviour — and un-freezes progressively
            // as deeper NWP batches land.
            if (this._handoff) return null;
            const trio = this._trioFor(last);
            return trio ? { a: trio, b: trio, frac: 0, meta: this._meta(last) } : null;
        }
        // First target strictly greater than tEff.
        let lo = 0, hi = targets.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (targets[mid] <= tEff) lo = mid + 1; else hi = mid;
        }
        const beforeT = targets[lo - 1];
        const afterT  = targets[lo];
        const a = this._trioFor(beforeT);
        const b = this._trioFor(afterT);
        if (!a || !b) return null;
        const span = afterT - beforeT;
        const frac = span > 0 ? (tEff - beforeT) / span : 0;
        return { a, b, frac, meta: this._meta(beforeT) };
    }

    /**
     * Absolute ms of the deepest forecast frame (== issued_ms + maxHorizonH·h),
     * or null when no forecast is loaded. The resolver uses this to locate the
     * model→NWP seam and crossfade across it. Read-only; cheap.
     */
    horizonEndMs() {
        return this._targets.length ? this._targets[this._targets.length - 1] : null;
    }

    _meta(targetMs) {
        return {
            model_id:  this._modelId,
            source:    this._modelId,
            issued_ms: this._issuedMs,
            target_ms: targetMs,
            gridW:     this._gridW,
            gridH:     this._gridH,
            isForecast: true,
        };
    }

    stop() {
        if (typeof clearTimeout === 'function') clearTimeout(this._refreshTimer);
        document.removeEventListener('weather-history-ingest', this._onIngest);
        this._trios.clear();
        this._coarse.clear();
        this._targets = [];
    }
}

export { NUM_CHANNELS };
