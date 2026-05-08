/**
 * atmosphere-climatology.js — per-cell × per-local-hour climatology for
 *                             any subset of weather-history channels
 *
 * Generalisation of the precip-climatology pattern. The precip module
 * shipped first because precipitation has the most aggressive diurnal
 * cycle and the heaviest storm-tail; clouds (channels 5/6/7) and wind
 * (channels 3/4) benefit from the same long-memory prior, just with
 * different transform choices.
 *
 * Why this exists in addition to PrecipClimatology
 * ────────────────────────────────────────────────
 * PrecipClimatology hard-codes channel 8 + a "no negative values"
 * assumption (precip is non-negative; clamp at 0). Wind components
 * (U, V) are signed; cloud fractions are bounded [0, 1] but otherwise
 * benign. Generalising into one class lets the cloud and wind
 * forecasters reuse exactly the same store + helpers, with the host
 * picking which channels participate.
 *
 * Storage
 * ───────
 * IndexedDB store `clim_v1`, keyed by `gridKey` = `${gridW}x${gridH}`.
 * One record per resolution carries:
 *   mean[ch, hour, cell]    Float32Array(C × 24 × N)
 *   count[ch, hour, cell]   Uint32Array(C × 24 × N)
 *
 * Where C = channels.length, N = gridW × gridH. Layout is C-outer so
 * a single channel's slice is contiguous (good for the forecaster's
 * bulk read at sample time).
 *
 * Footprint per channel: 72×36 × 24 × 8 bytes ≈ 500 KB. Three cloud
 * channels stack to ~1.5 MB; two wind channels to ~1 MB. Trivial.
 *
 * Forever-growing
 * ───────────────
 * Like PrecipClimatology, this store is never pruned. Every observation
 * contributes to the running mean; older sessions compound into stronger
 * priors. Coverage diagnostics (cells × hours × channels with ≥ minN
 * samples) are exposed for the SW-panel HUD so a returning user sees
 * the prior maturing visually.
 */

const HOURS_PER_DAY = 24;

function _hourKey(t, lonDeg) {
    // Same naive solar-local hour as PrecipClimatology — sub-hour
    // resolution isn't worth the bin-count blow-up for our visualisation.
    const utcHours = t / 3_600_000;
    const local    = utcHours + lonDeg / 15;
    let h = ((local % HOURS_PER_DAY) + HOURS_PER_DAY) % HOURS_PER_DAY;
    return Math.floor(h);
}

function _lonOfColumn(i, gridW) {
    const stepDeg = 360 / gridW;
    return -180 + stepDeg * (i + 0.5);
}

function _openDB(dbName) {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(dbName, 1);
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains('clim_v1')) {
                db.createObjectStore('clim_v1', { keyPath: 'gridKey' });
            }
        };
        req.onsuccess = (e) => resolve(e.target.result);
        req.onerror   = (e) => reject(e.target.error);
    });
}
function _idbGet(db, key) {
    return new Promise((resolve, reject) => {
        const req = db.transaction('clim_v1', 'readonly').objectStore('clim_v1').get(key);
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror   = () => reject(req.error);
    });
}
function _idbPut(db, rec) {
    return new Promise((resolve, reject) => {
        const req = db.transaction('clim_v1', 'readwrite').objectStore('clim_v1').put(rec);
        req.onsuccess = () => resolve();
        req.onerror   = () => reject(req.error);
    });
}

// ── AtmosphereClimatology ──────────────────────────────────────────────────

export class AtmosphereClimatology {
    /**
     * @param {object} opts
     * @param {number[]} opts.channels   List of channel indices into the
     *   weather-history coarse buffer. e.g. [5,6,7] for clouds, [3,4] for
     *   wind, [0] for temperature.
     * @param {string}   opts.dbName     IndexedDB name. Distinct stores
     *   per channel set keep the schema simple and let us evolve one
     *   prior without touching the others.
     */
    constructor({ channels, dbName }) {
        if (!Array.isArray(channels) || channels.length === 0) {
            throw new Error('AtmosphereClimatology: channels[] required');
        }
        if (typeof dbName !== 'string' || !dbName) {
            throw new Error('AtmosphereClimatology: dbName required');
        }
        this._channels = channels.slice();
        this._dbName   = dbName;
        this._db       = null;
        this._mem      = new Map();   // gridKey → { gridW, gridH, mean, count }
        this._dirty    = new Set();
        this._flushTimer = null;
        this._ready    = false;
    }

    async open() {
        try {
            this._db = await _openDB(this._dbName);
        } catch (err) {
            console.warn(`[AtmosphereClimatology:${this._dbName}] IDB unavailable, in-memory only:`, err.message);
        }
        this._ready = true;
        return this;
    }

    /**
     * Fold a fresh observation frame into the climatology. Welford's
     * running mean per (channel, local-hour, cell). NaN-safe — non-
     * finite cells silently skip rather than poisoning the mean.
     */
    async ingest({ t, gridW, gridH, coarse }) {
        if (!this._ready || !Number.isFinite(t)) return;
        if (!(coarse instanceof Float32Array)) return;
        const N = gridW * gridH;
        const C = this._channels.length;
        // Sanity-check: every requested channel must fit inside the
        // coarse buffer.
        for (const ch of this._channels) {
            if (coarse.length < (ch + 1) * N) return;
        }

        const gridKey = `${gridW}x${gridH}`;
        let bin = this._mem.get(gridKey);
        if (!bin) {
            bin = await this._loadOrCreate(gridKey, gridW, gridH);
            this._mem.set(gridKey, bin);
        }
        const meanArr  = bin.mean;     // length = C × 24 × N
        const countArr = bin.count;

        // Pre-compute local-hour for each column once — every row in a
        // column shares the same longitude. Saves N·gridH redundant
        // lookups per ingest.
        const hourByCol = new Int8Array(gridW);
        for (let i = 0; i < gridW; i++) {
            hourByCol[i] = _hourKey(t, _lonOfColumn(i, gridW));
        }

        for (let c = 0; c < C; c++) {
            const ch  = this._channels[c];
            const off = ch * N;
            // Stride into mean/count for this channel.
            const cBase = c * HOURS_PER_DAY * N;
            for (let j = 0; j < gridH; j++) {
                for (let i = 0; i < gridW; i++) {
                    const k = j * gridW + i;
                    const v = coarse[off + k];
                    if (!Number.isFinite(v)) continue;
                    const idx = cBase + hourByCol[i] * N + k;
                    const n   = countArr[idx] + 1;
                    const delta = v - meanArr[idx];
                    meanArr[idx]  += delta / n;
                    countArr[idx] = n;
                }
            }
        }

        this._dirty.add(gridKey);
        if (!this._flushTimer) {
            this._flushTimer = setTimeout(() => this._flush(), 1500);
        }
    }

    /**
     * Sample the climatology at a target time → CHW Float32Array shaped
     * for the channels this store covers. The returned array is
     * length channels.length × N — caller writes those slices into the
     * full 9-channel forecast frame at the original channel offsets.
     *
     * Returns null when no climatology exists yet for this resolution.
     */
    sample({ targetMs, gridW, gridH }) {
        const bin = this._mem.get(`${gridW}x${gridH}`);
        if (!bin) return null;
        const N = gridW * gridH;
        const C = this._channels.length;
        const out = new Float32Array(C * N);
        const meanArr = bin.mean;
        const countArr = bin.count;
        const hourByCol = new Int8Array(gridW);
        for (let i = 0; i < gridW; i++) {
            hourByCol[i] = _hourKey(targetMs, _lonOfColumn(i, gridW));
        }
        for (let c = 0; c < C; c++) {
            const cBase = c * HOURS_PER_DAY * N;
            const oBase = c * N;
            for (let j = 0; j < gridH; j++) {
                for (let i = 0; i < gridW; i++) {
                    const k   = j * gridW + i;
                    const idx = cBase + hourByCol[i] * N + k;
                    // Cells with zero samples at this local-hour fall
                    // back to the channel's overall mean (sum across
                    // all 24 hours / total count). We don't pre-compute
                    // that — instead we just return 0, which the
                    // caller treats as "anomaly = current value" and
                    // falls back to persistence. Cheap.
                    out[oBase + k] = countArr[idx] > 0 ? meanArr[idx] : 0;
                }
            }
        }
        return out;
    }

    /**
     * Coverage stats: how many (channel × cell × local-hour) bins have
     * ≥ minN samples. The HUD turns this into "climatology N% bins ≥ M
     * samples" so the user can see the prior maturing.
     */
    coverage({ gridW, gridH, minN = 3 } = {}) {
        const bin = this._mem.get(`${gridW}x${gridH}`);
        if (!bin) return { populated: 0, total: 0, frac: 0 };
        const total = bin.count.length;
        let pop = 0;
        const arr = bin.count;
        for (let i = 0; i < total; i++) if (arr[i] >= minN) pop++;
        return { populated: pop, total, frac: pop / total };
    }

    /** Channels covered by this store (so callers don't have to remember). */
    get channels() { return this._channels.slice(); }

    /** Force flush to disk — call on visibilitychange:hidden. */
    async flushNow() {
        if (this._flushTimer) {
            clearTimeout(this._flushTimer);
            this._flushTimer = null;
        }
        await this._flush();
    }

    // ── Internal ──────────────────────────────────────────────────────

    async _loadOrCreate(gridKey, gridW, gridH) {
        const N = gridW * gridH;
        const C = this._channels.length;
        const expected = C * HOURS_PER_DAY * N;
        if (this._db) {
            try {
                const rec = await _idbGet(this._db, gridKey);
                if (rec && rec.mean instanceof Float32Array && rec.count instanceof Uint32Array
                    && rec.mean.length === expected && rec.count.length === expected) {
                    return { gridW, gridH, mean: rec.mean, count: rec.count };
                }
            } catch (err) {
                console.debug(`[AtmosphereClimatology:${this._dbName}] get skipped:`, err?.message);
            }
        }
        return {
            gridW, gridH,
            mean:  new Float32Array(expected),
            count: new Uint32Array(expected),
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
                await _idbPut(this._db, {
                    gridKey,
                    gridW: bin.gridW,
                    gridH: bin.gridH,
                    mean:  new Float32Array(bin.mean),
                    count: new Uint32Array(bin.count),
                    updatedAt: Date.now(),
                });
            } catch (err) {
                console.debug(`[AtmosphereClimatology:${this._dbName}] put skipped:`, err?.message);
            }
        }
    }
}

export default AtmosphereClimatology;
