/**
 * precip-bias-tracker.js — per-cell EWMA bias between modelled and observed precip
 *
 * Why this exists
 * ───────────────
 * Open-Meteo's precip channel is *modelled* (GFS / ECMWF). NASA IMERG, via
 * nasa-precip-extractor.js, is *observed* (microwave + IR fusion). For any
 * given grid cell the two will systematically differ — coastal upslope
 * convection that NWP under-predicts, ITCZ rain bands that microwave radiometers
 * over-count, etc. The systematic part of that disagreement is bias: a
 * per-cell offset that, once estimated, lets us correct the modelled field
 * before forecasting from it.
 *
 * Strategy
 * ────────
 * For each cell `k`:
 *
 *     bias[k] ← α · (modelled[k] − observed[k]) + (1 − α) · bias[k]
 *
 * α is small (~0.1) so bias evolves over many pairings rather than chasing
 * single-frame noise. The tracker keeps:
 *
 *  - a Float32Array(N) of running EWMA bias estimates (in mm/hr)
 *  - a Uint16Array(N) of pair counts per cell — used as a confidence
 *    multiplier when the forecaster decides whether to apply the bias
 *  - a single global pair count — surfaced as "fusion samples" in the HUD
 *
 * Pairing
 * ───────
 * IMERG Late Run is a daily composite at ~24 h latency. Open-Meteo updates
 * hourly. We don't pair "the modelled frame at the same minute as the
 * IMERG frame" — instead, every time NASA emits, we pair against the
 * *most recent* model frame whose timestamp is within MAX_PAIR_LAG_MS of
 * the NASA observation. That's intentionally loose: IMERG's daily-mean
 * value is a smoothed signal, so matching it to a near-current modelled
 * frame is fine for bias estimation even though they're not strictly
 * simultaneous.
 *
 * Persistence
 * ───────────
 * One IDB record per grid resolution (gridKey). Tiny (~20 KB per
 * resolution), structured-cloneable, no base64 dance. Survives reloads —
 * the user shouldn't lose a week of bias accumulation by closing the tab.
 */

const DB_NAME    = 'precip_bias_v1';
const DB_VERSION = 1;
const STORE_NAME = 'bias_v1';

// EWMA mixing coefficient. 0.1 means a step takes ~10 pairings to reach
// 65% of the new value — slow enough to ignore single-frame noise, fast
// enough that a real shift in regime (e.g. season change) propagates
// within a few weeks.
const ALPHA = 0.1;

// Generous: IMERG Late Run is daily-composite at ~24 h latency. The
// modelled frame within 18 h of the NASA observation is a fair match for
// estimating a slowly-evolving systematic offset.
const MAX_PAIR_LAG_MS = 18 * 3_600_000;

// Cap on the EWMA bias magnitude. Real precipitation biases are at most a
// few mm/hr; values an order of magnitude larger almost certainly come
// from NASA colour-ramp inversion errors near saturation. Clamping
// protects the fusion forecaster from heavy-tail single-frame outliers
// poisoning the running estimate.
const BIAS_CLAMP_MMHR = 20;

function openDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: 'gridKey' });
            }
        };
        req.onsuccess = (e) => resolve(e.target.result);
        req.onerror   = (e) => reject(e.target.error);
    });
}

function idbGet(db, gridKey) {
    return new Promise((resolve, reject) => {
        const tx  = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).get(gridKey);
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror   = () => reject(req.error);
    });
}

function idbPut(db, rec) {
    return new Promise((resolve, reject) => {
        const tx  = db.transaction(STORE_NAME, 'readwrite');
        const req = tx.objectStore(STORE_NAME).put(rec);
        req.onsuccess = () => resolve();
        req.onerror   = () => reject(req.error);
    });
}

// ── PrecipBiasTracker ──────────────────────────────────────────────────────

export class PrecipBiasTracker {
    /**
     * @param {object} opts
     * @param {number} [opts.precipChannelOffset] — channel index of precip
     *   in the CHW history coarse buffer. Defaults to 8 (matches
     *   weather-history.js layout).
     */
    constructor({ precipChannelOffset = 8 } = {}) {
        this._precipCh = precipChannelOffset;
        /** @type {IDBDatabase | null} */
        this._db = null;
        // gridKey → { gridW, gridH, bias: Float32Array(N), count: Uint16Array(N), totalPairs: number }
        this._mem = new Map();
        // Latest modelled precip frame, keyed by gridKey. We only keep one
        // — pairing is "most recent model + new observation," not a
        // historical join.
        this._lastModel = new Map();   // gridKey → { t, gridW, gridH, precip: Float32Array(N) }
        this._ready = false;
        this._dirty = new Set();
        this._flushTimer = null;
    }

    async open() {
        try {
            this._db = await openDB();
        } catch (err) {
            console.warn('[PrecipBiasTracker] IDB unavailable, in-memory only:', err.message);
        }
        this._ready = true;
        return this;
    }

    /**
     * Record a fresh modelled precip frame from weather-history-ingest.
     * Stored as the "latest model" until a NASA observation comes in to
     * pair against it.
     */
    ingestModel({ t, gridW, gridH, coarse }) {
        if (!this._ready) return;
        if (!Number.isFinite(t)) return;
        if (!(coarse instanceof Float32Array)) return;
        const N = gridW * gridH;
        if (coarse.length < N * (this._precipCh + 1)) return;

        const off = this._precipCh * N;
        const precip = new Float32Array(N);
        precip.set(coarse.subarray(off, off + N));
        this._lastModel.set(`${gridW}x${gridH}`, { t, gridW, gridH, precip });
    }

    /**
     * Record a NASA IMERG-derived observed precip frame (already on the
     * coarse grid via nasa-precip-extractor.js) and update the per-cell
     * EWMA bias against the most recent paired model frame.
     *
     * Returns { paired: boolean, lagMs: number|null, totalPairs: number }
     * so the HUD can show "last pairing N hours ago, M total."
     */
    async ingestObservation({ t, gridW, gridH, precip }) {
        if (!this._ready) return { paired: false, lagMs: null, totalPairs: 0 };
        if (!Number.isFinite(t)) return { paired: false, lagMs: null, totalPairs: 0 };
        if (!(precip instanceof Float32Array)) return { paired: false, lagMs: null, totalPairs: 0 };
        const N = gridW * gridH;
        if (precip.length !== N) return { paired: false, lagMs: null, totalPairs: 0 };

        const gridKey = `${gridW}x${gridH}`;
        const model   = this._lastModel.get(gridKey);
        if (!model) return { paired: false, lagMs: null, totalPairs: 0 };
        const lag = Math.abs(t - model.t);
        if (lag > MAX_PAIR_LAG_MS) {
            // Modelled frame is too stale to fairly pair. Don't fold it
            // — better to wait for the next live cron tick.
            return { paired: false, lagMs: lag, totalPairs: this._totalPairs(gridKey) };
        }

        let bin = this._mem.get(gridKey);
        if (!bin) {
            bin = await this._loadOrCreate(gridKey, gridW, gridH);
            this._mem.set(gridKey, bin);
        }
        const biasArr  = bin.bias;
        const countArr = bin.count;

        for (let k = 0; k < N; k++) {
            const m = model.precip[k];
            const o = precip[k];
            // Skip cells where either side is non-finite. NaN propagates
            // through the EWMA and would poison the running estimate
            // permanently — once it lands you can't recover by averaging.
            if (!Number.isFinite(m) || !Number.isFinite(o)) continue;
            const diff = m - o;
            // First sample: snap to the raw difference rather than
            // dragging from 0 — the EWMA's "warm-up" otherwise needs ~10
            // pairings to escape its zero initialisation.
            const prev = countArr[k] === 0 ? diff : biasArr[k];
            let next = ALPHA * diff + (1 - ALPHA) * prev;
            if      (next >  BIAS_CLAMP_MMHR) next =  BIAS_CLAMP_MMHR;
            else if (next < -BIAS_CLAMP_MMHR) next = -BIAS_CLAMP_MMHR;
            biasArr[k] = next;
            // Saturate the count at u16 max so we still know "very
            // mature" without overflowing.
            if (countArr[k] < 0xffff) countArr[k] += 1;
        }
        bin.totalPairs += 1;

        this._dirty.add(gridKey);
        if (!this._flushTimer) {
            this._flushTimer = setTimeout(() => this._flush(), 1500);
        }

        return { paired: true, lagMs: lag, totalPairs: bin.totalPairs };
    }

    /**
     * Per-cell bias snapshot for a grid resolution. Returns null if no
     * pairings have happened yet (so the fusion forecaster knows to skip
     * the correction term entirely rather than apply a near-zero EWMA
     * that hasn't warmed up).
     */
    getBias({ gridW, gridH, minPairs = 3 } = {}) {
        const bin = this._mem.get(`${gridW}x${gridH}`);
        if (!bin || bin.totalPairs < minPairs) return null;
        return bin.bias;
    }

    /**
     * One-line diagnostic: total pairings + mean confidence + median |bias|.
     * Surfaced in the SW panel so the user can watch fusion warm up.
     */
    diagnostics({ gridW, gridH } = {}) {
        const bin = this._mem.get(`${gridW}x${gridH}`);
        if (!bin) return { totalPairs: 0, populated: 0, total: 0, medianAbsBias: 0 };
        const N = bin.bias.length;
        let pop = 0;
        const abs = [];
        for (let k = 0; k < N; k++) {
            if (bin.count[k] > 0) {
                pop++;
                abs.push(Math.abs(bin.bias[k]));
            }
        }
        abs.sort((a, b) => a - b);
        const med = abs.length ? abs[Math.floor(abs.length / 2)] : 0;
        return { totalPairs: bin.totalPairs, populated: pop, total: N, medianAbsBias: med };
    }

    async flushNow() {
        if (this._flushTimer) {
            clearTimeout(this._flushTimer);
            this._flushTimer = null;
        }
        await this._flush();
    }

    // ── Internal ──────────────────────────────────────────────────────

    _totalPairs(gridKey) {
        const bin = this._mem.get(gridKey);
        return bin?.totalPairs ?? 0;
    }

    async _loadOrCreate(gridKey, gridW, gridH) {
        const N = gridW * gridH;
        if (this._db) {
            try {
                const rec = await idbGet(this._db, gridKey);
                if (rec && rec.bias instanceof Float32Array && rec.count instanceof Uint16Array
                    && rec.bias.length === N && rec.count.length === N) {
                    return {
                        gridW, gridH,
                        bias:  rec.bias,
                        count: rec.count,
                        totalPairs: rec.totalPairs | 0,
                    };
                }
            } catch (err) {
                console.debug('[PrecipBiasTracker] idb get skipped:', err?.message);
            }
        }
        return {
            gridW, gridH,
            bias:  new Float32Array(N),
            count: new Uint16Array(N),
            totalPairs: 0,
        };
    }

    async _flush() {
        this._flushTimer = null;
        if (!this._db) { this._dirty.clear(); return; }
        const dirty = [...this._dirty];
        this._dirty.clear();
        for (const gridKey of dirty) {
            const bin = this._mem.get(gridKey);
            if (!bin) continue;
            try {
                await idbPut(this._db, {
                    gridKey,
                    gridW: bin.gridW,
                    gridH: bin.gridH,
                    bias:  new Float32Array(bin.bias),
                    count: new Uint16Array(bin.count),
                    totalPairs: bin.totalPairs,
                    updatedAt: Date.now(),
                });
            } catch (err) {
                console.debug('[PrecipBiasTracker] idb put skipped:', err?.message);
            }
        }
    }
}

export default PrecipBiasTracker;
