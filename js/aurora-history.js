/**
 * aurora-history.js — append-only ring of OVATION hemispheric power
 *
 * Pairs with swpc-feed.js: every time the SWPC tick lands a fresh
 * `aurora_power_north` / `aurora_power_south` value (now correctly
 * derived from the OVATION grid integration), this module persists
 * the sample to IndexedDB. The forecaster (`aurora-forecast.js`)
 * consumes the resulting timeseries to produce 1/3/6/24-hour
 * predictions, validated against the same observations as they
 * arrive.
 *
 * Schema
 * ──────
 *   key:            t (ms UTC, rounded to 5-minute cadence so the
 *                       OVATION nowcast frequency dedupes naturally)
 *   north_gw:       Northern hemisphere integrated power (GW)
 *   south_gw:       Southern hemisphere integrated power (GW)
 *   kp:             concurrent Kp index (snapshot from swpc-feed)
 *   bz:             concurrent IMF Bz_gsm (nT)
 *   forecastTimeMs: upstream OVATION "Forecast Time" if available
 *
 * Storing kp + bz alongside the power lets the forecaster regress
 * future power on present-state Kp/Bz directly out of one timeseries
 * — no need to re-join two histories at evaluation time.
 *
 * Footprint
 * ─────────
 *   30 days × 12 samples/hour × 5 floats × 8 bytes ≈ 350 KB
 * Trivial for IDB; we keep a fixed 30-day retention so a long-running
 * tab doesn't accumulate years of polar quiet.
 */

const DB_NAME    = 'aurora_history_v1';
const DB_VERSION = 1;
const STORE_NAME = 'samples';
const RETENTION_MS = 30 * 24 * 3_600_000;     // 30 days
const ROUND_BIN_MS = 5 * 60_000;              // 5-min cadence

function openDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: 't' });
            }
        };
        req.onsuccess = (e) => resolve(e.target.result);
        req.onerror   = (e) => reject(e.target.error);
    });
}

function idbGetAll(db) {
    return new Promise((resolve, reject) => {
        const tx  = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).getAll();
        req.onsuccess = () => resolve(req.result ?? []);
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

function idbDeleteOlderThan(db, cutoffMs) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const range = IDBKeyRange.upperBound(cutoffMs, /* open */ true);
        const cursorReq = store.openCursor(range);
        cursorReq.onsuccess = (e) => {
            const c = e.target.result;
            if (c) { c.delete(); c.continue(); }
        };
        tx.oncomplete = () => resolve();
        tx.onerror    = () => reject(tx.error);
    });
}

function _binKey(t) {
    return Math.floor(t / ROUND_BIN_MS) * ROUND_BIN_MS;
}

// ── AuroraHistory ──────────────────────────────────────────────────────────

export class AuroraHistory {
    constructor() {
        /** @type {IDBDatabase | null} */
        this._db = null;
        this._ready = false;
        // In-memory mirror — small (~8 K samples for 30 d × 5 min cadence)
        // and lets the forecaster do AR fitting without touching IDB on
        // every tick. Sorted oldest-first.
        this._mem = [];
        this._lastKey = 0;
    }

    async open() {
        try {
            this._db = await openDB();
            const rows = await idbGetAll(this._db);
            rows.sort((a, b) => a.t - b.t);
            // Trim anything past retention on warm-up — keeps the in-mem
            // mirror tight and avoids paying the prune cost on first
            // ingest.
            const cutoff = Date.now() - RETENTION_MS;
            this._mem = rows.filter(r => r && Number.isFinite(r.t) && r.t > cutoff);
            if (this._mem.length) this._lastKey = this._mem[this._mem.length - 1].t;
        } catch (err) {
            console.warn('[AuroraHistory] IDB unavailable, in-memory only:', err.message);
        }
        this._ready = true;
        return this;
    }

    /**
     * Record a snapshot. Idempotent for repeats inside the same 5-min
     * bin (the bin key acts as upsert primary key, so re-ingests just
     * overwrite with the freshest values).
     *
     * Always-finite-or-null fields: callers can hand us partial
     * snapshots (e.g. a Kp tick with no fresh OVATION grid yet) and
     * we'll persist the partial. The forecaster's AR fit gracefully
     * skips rows with non-finite power.
     */
    ingest({ t, north_gw, south_gw, kp = null, bz = null, forecastTimeMs = null }) {
        if (!this._ready) return;
        if (!Number.isFinite(t)) return;
        // Filter the all-null case — it would pollute the timeseries
        // with empty bins and waste IDB space.
        if (!Number.isFinite(north_gw) && !Number.isFinite(south_gw)) return;
        const key = _binKey(t);
        const rec = {
            t: key,
            north_gw: Number.isFinite(north_gw) ? north_gw : null,
            south_gw: Number.isFinite(south_gw) ? south_gw : null,
            kp: Number.isFinite(kp) ? kp : null,
            bz: Number.isFinite(bz) ? bz : null,
            forecastTimeMs: Number.isFinite(forecastTimeMs) ? forecastTimeMs : null,
        };
        // In-memory mirror upsert.
        const lastIdx = this._mem.length - 1;
        if (lastIdx >= 0 && this._mem[lastIdx].t === key) {
            this._mem[lastIdx] = rec;
        } else if (lastIdx >= 0 && this._mem[lastIdx].t > key) {
            // Out-of-order ingest (e.g. backfill). Insert in sorted spot.
            let i = lastIdx;
            while (i >= 0 && this._mem[i].t > key) i--;
            if (i >= 0 && this._mem[i].t === key) this._mem[i] = rec;
            else this._mem.splice(i + 1, 0, rec);
        } else {
            this._mem.push(rec);
        }
        this._lastKey = key;

        if (this._db) {
            idbPut(this._db, rec).catch(err => {
                console.debug('[AuroraHistory] put skipped:', err?.message);
            });
            // Cheap retention prune — only fire when we cross an hour
            // boundary to avoid one delete per ingest.
            if ((key % 3_600_000) < ROUND_BIN_MS) {
                idbDeleteOlderThan(this._db, Date.now() - RETENTION_MS)
                    .catch(err => console.debug('[AuroraHistory] prune skipped:', err?.message));
            }
        }

        // Notify subscribers (forecaster, validator) that the timeseries
        // grew. The detail object hands over the fresh sample by
        // reference; receivers must treat it as immutable.
        if (typeof document !== 'undefined') {
            document.dispatchEvent(new CustomEvent('aurora-history-ingest', {
                detail: { sample: rec },
            }));
        }
    }

    /** All samples in chronological order (newest last). */
    all() { return this._mem.slice(); }

    /** Most-recent N samples. */
    recent(n = 24) {
        return this._mem.slice(Math.max(0, this._mem.length - n));
    }

    /** Sample count and oldest/newest timestamps — used by the HUD. */
    coverage() {
        if (this._mem.length === 0) return { n: 0, oldestMs: null, newestMs: null };
        return {
            n: this._mem.length,
            oldestMs: this._mem[0].t,
            newestMs: this._mem[this._mem.length - 1].t,
        };
    }

    /** True once open() has resolved (success OR fallback). */
    get isReady() { return this._ready; }
}

export default AuroraHistory;
export { ROUND_BIN_MS, RETENTION_MS };
