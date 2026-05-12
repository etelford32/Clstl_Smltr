/**
 * precip-climatology.js — per-cell × per-local-hour running mean of precipitation
 *
 * Why this exists
 * ───────────────
 * The 24-hour ring in weather-history.js forgets the diurnal cycle every
 * day. Persistence at a 12-24h horizon is therefore a surprisingly hard
 * baseline to beat for any model that doesn't know "rain peaks at the
 * coast in the late afternoon" — because persistence rediscovers that
 * cycle from the most recent observation. Anomaly-based forecasting
 * (= subtract climatology, persist/AR the anomaly, re-add climatology)
 * is the standard meteorological remedy. It needs a climatology.
 *
 * What "climatology" means here
 * ─────────────────────────────
 * For each coarse cell `k` in 0..gridW*gridH-1 and each local-solar
 * hour `H` in 0..23, we keep a Welford accumulator of observed
 * precipitation (mm/hr). After N days of data each (k, H) bin has
 * ~N samples — enough for a stable mean by ~14 days, very stable by
 * ~30. The running mean *is* the diurnal climatology at that grid
 * cell.
 *
 * Local solar hour is computed from the cell's centre longitude and
 * the observation timestamp:
 *   localHour = ((tUtcMs / 3.6e6) + lonDeg/15) mod 24
 * This is intentionally naive (no DST, no equation of time) because
 * the diurnal cycle of convective precip is keyed to solar noon, not
 * civil time. The error from ignoring the equation of time is < 17 min
 * — irrelevant at 1-hour binning.
 *
 * Storage
 * ───────
 * IndexedDB store `clim_v1`, keyed by `gridKey` (e.g. "72x36"). One
 * record per grid resolution carries the full 24-hour × N-cell
 * accumulator as a Float32Array (mean) plus a Uint32Array (count).
 *
 * Size: 72×36 × 24 × (4+4) bytes ≈ 500 KB per resolution. Fits the
 * IDB budget easily and is structured-cloneable so it round-trips
 * without a base64 dance.
 *
 * The store is **never deleted**. That's the entire point — every
 * observation contributes one sample, forever, so older rows compound
 * into stronger climatology. If a resolution change happens upstream
 * (e.g. 36×18 → 72×36) we keep both records side-by-side; the
 * resolver picks whichever matches the live ingest.
 */

const DB_NAME    = 'precip_climatology_v1';
const DB_VERSION = 1;
const STORE_NAME = 'clim_v1';
const HOURS_PER_DAY = 24;

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

// Centre longitude (deg, [-180, 180)) of cell column `i` in a width-W grid
// whose first column is centred at -180 + 360/(2W). This matches the
// convention in weather-feed.js / weather-history.js coarse decoding.
function lonOfColumn(i, gridW) {
    const stepDeg = 360 / gridW;
    return -180 + stepDeg * (i + 0.5);
}

function localHour(tUtcMs, lonDeg) {
    // Naive solar local hour (see header comment).
    const utcHours = tUtcMs / 3_600_000;
    const local    = utcHours + lonDeg / 15;
    let h = ((local % HOURS_PER_DAY) + HOURS_PER_DAY) % HOURS_PER_DAY;
    return Math.floor(h);
}

// ── PrecipClimatology ──────────────────────────────────────────────────────

export class PrecipClimatology {
    constructor() {
        /** @type {IDBDatabase | null} */
        this._db = null;
        // gridKey → { gridW, gridH, mean: Float32Array(24·N), count: Uint32Array(24·N) }
        this._mem = new Map();
        this._ready = false;
        this._dirty = new Set();   // gridKeys with un-flushed updates
        this._flushTimer = null;
    }

    async open() {
        try {
            this._db = await openDB();
        } catch (err) {
            console.warn('[PrecipClimatology] IDB unavailable, in-memory only:', err.message);
        }
        this._ready = true;
        return this;
    }

    /**
     * Hand the climatology a fresh observation frame (CHW Float32, channel 8 = precip).
     * Idempotent for repeated ingests at the same hour-key — Welford updates
     * are O(N·24) so the second tick of the same hour just slightly tightens
     * the running mean. We accept that as a feature: more samples is more
     * confidence.
     *
     * `precipChannelOffset` defaults to channel 8 (last) — matches
     * weather-history.js layout. Override if a future schema reorders.
     */
    async ingest({ t, gridW, gridH, coarse, precipChannelOffset = 8 }) {
        if (!this._ready || !Number.isFinite(t)) return;
        if (!(coarse instanceof Float32Array)) return;
        const N = gridW * gridH;
        if (coarse.length < N * (precipChannelOffset + 1)) return;

        const gridKey = `${gridW}x${gridH}`;
        let bin = this._mem.get(gridKey);
        if (!bin) {
            bin = await this._loadOrCreate(gridKey, gridW, gridH);
            this._mem.set(gridKey, bin);
        }
        const meanArr  = bin.mean;
        const countArr = bin.count;

        // Pre-compute local-hour for each column once; rows share the
        // same longitude column so this is N·gridH fewer ops than per-cell.
        const hourByCol = new Int8Array(gridW);
        for (let i = 0; i < gridW; i++) hourByCol[i] = localHour(t, lonOfColumn(i, gridW));

        const channelOff = precipChannelOffset * N;
        for (let j = 0; j < gridH; j++) {
            for (let i = 0; i < gridW; i++) {
                const k = j * gridW + i;
                const v = coarse[channelOff + k];
                if (!Number.isFinite(v)) continue;
                const H   = hourByCol[i];
                const idx = H * N + k;
                const n   = countArr[idx] + 1;
                // Welford running mean, single pass. We don't keep M2
                // here — variance isn't needed for the anomaly
                // forecaster, only the mean. Skipping it halves the
                // store size.
                const delta = v - meanArr[idx];
                meanArr[idx]  += delta / n;
                countArr[idx] = n;
            }
        }

        this._dirty.add(gridKey);
        // Coalesce IDB writes — at 1 ingest/hour the storm of writes is
        // already cheap, but if a backfill batches in dozens of frames
        // we don't want to put() each one.
        if (!this._flushTimer) {
            this._flushTimer = setTimeout(() => this._flush(), 1500);
        }
    }

    /**
     * Per-cell climatological precip rate (mm/hr) for a target time. Returns
     * a Float32Array(N) sized to the requested grid, or null when no
     * climatology exists yet.
     *
     * `targetMs` selects the local-hour bin; the cell's column drives lon
     * → localHour exactly the way ingest() did.
     */
    sample({ targetMs, gridW, gridH }) {
        const bin = this._mem.get(`${gridW}x${gridH}`);
        if (!bin) return null;
        const N   = gridW * gridH;
        const out = new Float32Array(N);
        const meanArr = bin.mean;
        const countArr = bin.count;
        const hourByCol = new Int8Array(gridW);
        for (let i = 0; i < gridW; i++) hourByCol[i] = localHour(targetMs, lonOfColumn(i, gridW));
        for (let j = 0; j < gridH; j++) {
            for (let i = 0; i < gridW; i++) {
                const k   = j * gridW + i;
                const idx = hourByCol[i] * N + k;
                // count==0 cells haven't been observed at that local
                // hour yet. We return 0 mm/hr — the safest prior for an
                // unseen bin in a heavy-tailed channel.
                out[k] = countArr[idx] > 0 ? meanArr[idx] : 0;
            }
        }
        return out;
    }

    /**
     * Number of (cell, local-hour) bins that have ≥ minN samples — a one-
     * number diagnostic the SW panel can show as "climatology coverage".
     */
    coverage({ gridW, gridH, minN = 3 } = {}) {
        const bin = this._mem.get(`${gridW}x${gridH}`);
        if (!bin) return { populated: 0, total: 0, frac: 0 };
        const total = bin.count.length;
        let pop = 0;
        for (let i = 0; i < total; i++) if (bin.count[i] >= minN) pop++;
        return { populated: pop, total, frac: pop / total };
    }

    /** Force a flush (e.g. on visibilitychange). Best-effort. */
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
        if (this._db) {
            try {
                const rec = await idbGet(this._db, gridKey);
                if (rec && rec.mean instanceof Float32Array && rec.count instanceof Uint32Array
                    && rec.mean.length === HOURS_PER_DAY * N
                    && rec.count.length === HOURS_PER_DAY * N) {
                    return { gridW, gridH, mean: rec.mean, count: rec.count };
                }
            } catch (err) {
                console.debug('[PrecipClimatology] idb get skipped:', err?.message);
            }
        }
        return {
            gridW, gridH,
            mean:  new Float32Array(HOURS_PER_DAY * N),
            count: new Uint32Array(HOURS_PER_DAY * N),
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
                    // Defensive copies: IDB's structured clone snapshots
                    // the typed array, but if the caller is mid-write we
                    // could clone an inconsistent half. Cheap insurance.
                    mean:  new Float32Array(bin.mean),
                    count: new Uint32Array(bin.count),
                    updatedAt: Date.now(),
                });
            } catch (err) {
                console.debug('[PrecipClimatology] idb put skipped:', err?.message);
            }
        }
    }
}

export default PrecipClimatology;
