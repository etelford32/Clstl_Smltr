/**
 * weather-forecast-validation.js
 *
 * Skill scorer for the gridded forecasters in weather-forecast.js. Mirrors
 * the shape of forecast-validation.js (Kp scorer) but is dimensioned for
 * many models × many channels × many horizons, all on a 2592-cell global
 * grid.
 *
 * Aggregation strategy
 * ────────────────────
 * Per-cell scores would be 9 channels × 5 horizons × 2592 cells × N models
 * ≈ 116 K rows per model — too noisy and storage-heavy. Instead, we pool
 * across cells and keep one Welford accumulator per (model, channel,
 * horizon). That's 5 × 9 = 45 entries per model. With ~5 models down the
 * road, ~225 accumulators total: well under the localStorage cap and
 * decay-resistant under quota pressure.
 *
 * MAE is the headline metric (matches what NWP shops report for surface
 * fields). Murphy skill = 1 − MSE_model / MSE_persistence; we keep MSE
 * separately so the registry's UI can compute skill on the fly without a
 * second pass through the buffer.
 *
 * Welford's online algorithm gives us stable variance + mean in a single
 * pass with two doubles per accumulator — works under the "I left the tab
 * open for 30 days" case without overflowing.
 *
 * Lifecycle
 * ─────────
 *   const v = new WeatherForecastValidator({ history });
 *   v.start(registry);              // subscribes to events
 *   v.summary();                    // { [model]: { [channel]: { [h]: { n, mae, mse, … } } } }
 *
 * Trigger graph
 * ─────────────
 *   weather-forecast-update  → enqueue pending(model, channel, horizon)
 *                              keyed by target_ms
 *   weather-history-ingest   → for each pending whose target ≈ new t,
 *                              compute per-channel MAE/MSE pooled over
 *                              cells, fold into Welford state.
 *
 * The pending queue is bounded; oldest entries beyond MATCH_GRACE_MS get
 * dropped on each ingest so a long downtime doesn't bloat localStorage.
 */

import { CHANNEL_NAMES, FORECAST_HORIZONS_H, NUM_CHANNELS } from './weather-forecast.js';

const STORAGE_KEY     = 'parkersphysics.weather-forecast-validation.v2';
const MATCH_WINDOW_MS = 30 * 60_000;            // ±30 min around target
// Drop pending entries that miss their match window by this much. Generous
// enough that a multi-hour browser pause still lets us validate, tight
// enough that we don't accumulate stale forecasts forever.
const MATCH_GRACE_MS  = 6 * 3_600_000;
// Hard cap on the pending queue. Each entry is a Float32 grid + metadata
// (~10 KB). 256 entries ≈ 2.5 MB in memory. Pending lives in IndexedDB,
// not localStorage, because the grids are too large for the 5 MB cap.
const PENDING_CAP     = 256;

// IndexedDB store for pending forecasts. The Welford summary stays in
// localStorage (small, sync-readable for the SW-panel paint). Pending
// frames are heavy (one Float32Array per model per horizon) so they get
// their own store.
const DB_NAME    = 'weather_forecast_pending_v1';
const DB_VERSION = 1;
const STORE_NAME = 'pending';

// ── IndexedDB helpers ──────────────────────────────────────────────────────

function openDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                // autoIncrement so we don't have to manage IDs; the
                // validator iterates everything on each ingest tick.
                db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
            }
        };
        req.onsuccess = (e) => resolve(e.target.result);
        req.onerror   = (e) => reject(e.target.error);
    });
}

function idbAll(db, storeName) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const req = tx.objectStore(storeName).getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror   = () => reject(req.error);
    });
}

function idbPut(db, storeName, record) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        const req = store.put(record);
        req.onsuccess = () => resolve(req.result);
        req.onerror   = () => reject(req.error);
    });
}

function idbDelete(db, storeName, ids) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        for (const id of ids) store.delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror    = () => reject(tx.error);
    });
}

function idbCount(db, storeName) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const req = tx.objectStore(storeName).count();
        req.onsuccess = () => resolve(req.result);
        req.onerror   = () => reject(req.error);
    });
}

// ── Welford summary (localStorage) ─────────────────────────────────────────
// state[model][channel][horizon] = { n, mean, M2, sumSq, sumAbs }
//   - n      : number of folded targets (each target contributes one MAE,
//              one MSE — pooled across all cells already)
//   - mean   : running mean of MAE values
//   - M2     : Welford's running sum-of-squared-deviations of MAE
//   - sumSq  : running sum of MSE values (so we can compute mean MSE
//              without a second Welford on top)
//   - sumAbs : running sum of MAE values; redundant with mean*n but kept
//              for arithmetic stability across schema migrations.

function emptyChannelStats() {
    const out = {};
    for (const h of FORECAST_HORIZONS_H) {
        out[h] = { n: 0, mean: 0, M2: 0, sumSq: 0, sumAbs: 0 };
    }
    return out;
}

function emptyModelStats() {
    const out = {};
    for (const ch of CHANNEL_NAMES) out[ch] = emptyChannelStats();
    return out;
}

function loadSummary() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        return (parsed && typeof parsed === 'object') ? parsed : {};
    } catch (_) {
        return {};
    }
}

function saveSummary(summary) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(summary));
    } catch (_) {
        // Quota / privacy: silent. Validation is best-effort.
    }
}

// Welford update for a single (mae, mse) sample. Writes into `bin` in place.
function welfordFold(bin, mae, mse) {
    bin.n += 1;
    const delta  = mae - bin.mean;
    bin.mean    += delta / bin.n;
    const delta2 = mae - bin.mean;
    bin.M2      += delta * delta2;
    bin.sumSq   += mse;
    bin.sumAbs  += mae;
}

// ── WeatherForecastValidator ───────────────────────────────────────────────

export class WeatherForecastValidator {
    constructor({ history } = {}) {
        if (!history) throw new Error('WeatherForecastValidator: history is required');
        this._history = history;
        this._summary = loadSummary();
        /** @type {IDBDatabase | null} */
        this._db = null;
        this._dbReady = false;
        this._started = false;
        this._onForecast = this._onForecast.bind(this);
        this._onIngest   = this._onIngest.bind(this);
    }

    /**
     * Begin listening for forecast and ingest events. Awaitable so callers
     * can defer until the IDB store is open (otherwise the first few
     * forecasts before open() resolves go to a small in-memory pending
     * fallback — they'll match if the next observation arrives in time).
     */
    async start() {
        if (this._started) return this;
        this._started = true;
        this._fallbackPending = [];   // until IDB opens
        try {
            this._db = await openDB();
            this._dbReady = true;
            // Drain anything that landed in the fallback while opening.
            for (const rec of this._fallbackPending) {
                await idbPut(this._db, STORE_NAME, rec);
            }
            this._fallbackPending = [];
        } catch (err) {
            console.warn('[WeatherForecastValidator] IDB open failed; pending kept in memory only:', err?.message);
        }
        document.addEventListener('weather-forecast-update', this._onForecast);
        document.addEventListener('weather-history-ingest',   this._onIngest);
        return this;
    }

    stop() {
        document.removeEventListener('weather-forecast-update', this._onForecast);
        document.removeEventListener('weather-history-ingest',   this._onIngest);
        this._started = false;
    }

    /** Snapshot of the rolling skill metrics; safe to call from UI code. */
    summary() {
        // Augment stored Welford bins with derived metrics on read so the
        // UI gets MAE / RMSE / std_mae / variance without recomputing.
        const out = {};
        for (const [model, byCh] of Object.entries(this._summary)) {
            out[model] = {};
            for (const [ch, byH] of Object.entries(byCh)) {
                out[model][ch] = {};
                for (const [h, bin] of Object.entries(byH)) {
                    const n = bin.n | 0;
                    out[model][ch][h] = {
                        n,
                        mae:  n > 0 ? bin.sumAbs / n           : null,
                        mse:  n > 0 ? bin.sumSq  / n           : null,
                        rmse: n > 0 ? Math.sqrt(bin.sumSq / n) : null,
                        var_mae: n > 1 ? bin.M2 / (n - 1)      : null,
                    };
                }
            }
        }
        return out;
    }

    /**
     * Murphy skill of `model` against `referenceModel` (default
     * 'persistence-v1') for one channel × horizon. Returns null if either
     * side has fewer than `minN` samples.
     */
    skill(model, channel, horizon, { referenceModel = 'persistence-v1', minN = 5 } = {}) {
        const m = this._summary[model]?.[channel]?.[horizon];
        const r = this._summary[referenceModel]?.[channel]?.[horizon];
        if (!m || !r || m.n < minN || r.n < minN) return null;
        const mseM = m.sumSq / m.n;
        const mseR = r.sumSq / r.n;
        if (mseR === 0) return null;
        return 1 - mseM / mseR;
    }

    // ── Internal ──────────────────────────────────────────────────────────

    /**
     * Fan out the new forecast into pending records keyed by target_ms,
     * one per (model, horizon). We don't shard per-channel here — a single
     * pending row carries all 9 channels' frames for the horizon, which
     * keeps the IDB transaction count low (5 puts per model per ingest).
     */
    async _onForecast(ev) {
        const results = ev?.detail?.results;
        if (!results) return;
        for (const [modelId, fc] of Object.entries(results)) {
            for (const h of fc.horizons) {
                const frame = fc.frames[h];
                if (!(frame instanceof Float32Array)) continue;
                const rec = {
                    model_id: modelId,
                    issued_ms: fc.issued_ms,
                    horizon_h: h,
                    target_ms: fc.target_ms[h],
                    gridW: fc.gridW,
                    gridH: fc.gridH,
                    frame,                      // CHW Float32, structured-cloneable
                };
                await this._enqueue(rec);
            }
        }
        await this._capPending();
    }

    async _enqueue(rec) {
        if (this._dbReady) {
            try { await idbPut(this._db, STORE_NAME, rec); }
            catch (err) {
                console.debug('[WeatherForecastValidator] idb put skipped:', err?.message);
            }
        } else {
            this._fallbackPending.push(rec);
        }
    }

    /**
     * On every observation ingest, walk the pending queue and validate
     * any whose target_ms is within the match window of the new frame.
     * Drop entries that are past the grace cutoff (we'll never match).
     */
    async _onIngest(ev) {
        const frame = ev?.detail?.frame;
        if (!frame || !(frame.coarse instanceof Float32Array)) return;
        const tNew = frame.t;

        const pending = await this._loadPending();
        if (pending.length === 0) return;

        const matchedIds = [];
        const droppedIds = [];
        let dirtySummary = false;

        for (const p of pending) {
            const dt = Math.abs(p.target_ms - tNew);
            if (dt <= MATCH_WINDOW_MS) {
                // Compatible-grid check: a coarse-grid resize between
                // forecast issue time and target would invalidate the
                // pointwise comparison. Drop those pending rows; they're
                // not a forecast failure, they're a schema change.
                if (p.gridW !== frame.gridW || p.gridH !== frame.gridH) {
                    droppedIds.push(p.id);
                    continue;
                }
                this._foldOne(p, frame);
                matchedIds.push(p.id);
                dirtySummary = true;
            } else if (tNew - p.target_ms > MATCH_GRACE_MS) {
                // Past grace: ground truth never landed (cron gap, browser
                // closed). Drop without folding — counts only count what
                // we actually validated.
                droppedIds.push(p.id);
            }
        }

        if (matchedIds.length || droppedIds.length) {
            await this._removeIds([...matchedIds, ...droppedIds]);
        }
        if (dirtySummary) {
            saveSummary(this._summary);
            document.dispatchEvent(new CustomEvent('weather-forecast-validation-update', {
                detail: { summary: this.summary() },
            }));
        }
    }

    /** Per-channel pooled MAE + MSE between forecast and observation. */
    _foldOne(pending, observed) {
        const { gridW, gridH, frame: fc } = pending;
        const obs = observed.coarse;
        const N = gridW * gridH;
        if (fc.length !== N * NUM_CHANNELS || obs.length !== N * NUM_CHANNELS) return;

        // Lazy-init the model bin so first-time models don't need explicit
        // registration with the validator; observing any forecast event is
        // enough to start tracking.
        if (!this._summary[pending.model_id]) {
            this._summary[pending.model_id] = emptyModelStats();
        }
        const modelBin = this._summary[pending.model_id];

        for (let ch = 0; ch < NUM_CHANNELS; ch++) {
            let sumAbs = 0, sumSq = 0;
            const off = ch * N;
            for (let k = 0; k < N; k++) {
                const f = fc[off + k];
                const o = obs[off + k];
                // NaN-safe: NaN propagates through subtraction and would
                // poison the running mean. Skip cells where either side
                // is non-finite.
                if (!Number.isFinite(f) || !Number.isFinite(o)) continue;
                const e = f - o;
                sumAbs += Math.abs(e);
                sumSq  += e * e;
            }
            const mae = sumAbs / N;
            const mse = sumSq  / N;
            const channelName = CHANNEL_NAMES[ch];
            const channelBin  = modelBin[channelName] ?? (modelBin[channelName] = emptyChannelStats());
            const horizonBin  = channelBin[pending.horizon_h] ?? (channelBin[pending.horizon_h] = { n: 0, mean: 0, M2: 0, sumSq: 0, sumAbs: 0 });
            welfordFold(horizonBin, mae, mse);
        }
    }

    async _loadPending() {
        if (!this._dbReady) return this._fallbackPending.slice();
        try { return await idbAll(this._db, STORE_NAME); }
        catch (err) {
            console.debug('[WeatherForecastValidator] idb getAll skipped:', err?.message);
            return [];
        }
    }

    async _removeIds(ids) {
        if (!ids.length) return;
        if (!this._dbReady) {
            this._fallbackPending = this._fallbackPending.filter(p => !ids.includes(p.id));
            return;
        }
        try { await idbDelete(this._db, STORE_NAME, ids); }
        catch (err) {
            console.debug('[WeatherForecastValidator] idb delete skipped:', err?.message);
        }
    }

    /**
     * Trim the pending store back to PENDING_CAP, oldest-first. Runs
     * after every forecast fan-out, so the cap is approximately enforced
     * without scanning on every event.
     */
    async _capPending() {
        if (!this._dbReady) {
            const overflow = this._fallbackPending.length - PENDING_CAP;
            if (overflow > 0) this._fallbackPending.splice(0, overflow);
            return;
        }
        try {
            const count = await idbCount(this._db, STORE_NAME);
            if (count <= PENDING_CAP) return;
            const all = await idbAll(this._db, STORE_NAME);
            all.sort((a, b) => a.issued_ms - b.issued_ms);
            const overflow = count - PENDING_CAP;
            const drop = all.slice(0, overflow).map(r => r.id);
            await this._removeIds(drop);
        } catch (err) {
            console.debug('[WeatherForecastValidator] cap pending skipped:', err?.message);
        }
    }
}

export default WeatherForecastValidator;
