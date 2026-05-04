/**
 * weather-history.js — 24-hour ring buffer of coarse weather grids
 *
 * Sibling to solar-weather-history.js. Single tier (1-hr cadence × 24 rows)
 * because that's the upstream truth: pg_cron writes /api/weather/grid once
 * per hour (CACHE_TTL = 3600 in api/weather/grid.js). Storing finer than
 * that is fiction; storing coarser loses information we already have.
 *
 * What we store
 * ─────────────
 * The *coarse* (typically 72×36) field straight off Open-Meteo, after NaN
 * gap-fill and U/V wind decomposition — i.e. the state at the moment
 * `_processRows` finishes its prep but before bilinear upsampling. That's
 * the smallest representation that preserves 100 % of the upstream signal:
 *
 *   channel 0  T          (°C, raw)
 *   channel 1  P          (hPa, raw)
 *   channel 2  RH         (%, raw)
 *   channel 3  windU      (m/s, eastward — post-decomposition)
 *   channel 4  windV      (m/s, northward — post-decomposition)
 *   channel 5  cloud_low  (%, raw)
 *   channel 6  cloud_mid  (%, raw)
 *   channel 7  cloud_high (%, raw)
 *   channel 8  precip     (mm, raw)
 *
 * Layout is channel-major (CHW): all of T first, then all of P, etc. Inner
 * loops in `_bilinear` traverse one channel at a time, so CHW gives better
 * L1 hit rates than HWC pixel-major would.
 *
 * Wind speed is *derived* on decode (hypot(U, V)) — storing it would be
 * redundant and risks drift if a future tweak rescales U/V.
 *
 * Why pre-decomposed wind on disk:
 *   Bilinear of degrees is wrong (350°→10° wraps to 180° not 0°). We pay
 *   the trig cost once at extract time and never again.
 *
 * Sizing
 * ──────
 *   2592 cells × 9 channels × 4 bytes ≈ 94 KB / frame
 *   24 frames                          ≈ 2.24 MB total IDB footprint
 *
 * Comfortable on every browser including mobile Safari, where 75 MB of
 * full-res Float32 history (the alternative) would risk eviction.
 *
 * Storage shape
 * ─────────────
 * IndexedDB store `tier_1h`, keyPath `t`. Records:
 *
 *   {
 *     t:          <ms, rounded to hour-start — guarantees dedup across
 *                  cron double-ticks>,
 *     fetchedAt:  <upstream fetched_at ms — so the UI can show "data as
 *                  of HH:MM UTC" even after a reload>,
 *     source:     'open-meteo:72x36' | 'open-meteo-gfs:72x36' | …,
 *     gridW, gridH,
 *     coarse:     Float32Array(gridW * gridH * 9)   // CHW packed
 *   }
 *
 * Float32Array is structured-cloneable, so it goes into IDB without any
 * base64 dance (unlike weather-feed.js's sessionStorage snapshot, which
 * has to base64 to fit JSON.stringify).
 *
 * Lifecycle
 * ─────────
 *   const history = new WeatherHistory();
 *   await history.open();                        // warm ring from IDB
 *   const wxFeed = new WeatherFeed({ history }); // feed pushes on success
 *   ...
 *   history.nearest(simTimeMs);                  // resolver path (next step)
 */

const NUM_CHANNELS = 9;

// Default 24h window at 1-hr cadence — matches /api/weather/grid CACHE_TTL.
const TIER = { name: 'tier_1h', cadence_ms: 3_600_000, max_rows: 24 };

const DB_NAME    = 'weather_grid_v1';
const DB_VERSION = 1;

// Round a timestamp down to the start of its UTC hour. Used as the IDB
// primary key so two ingests in the same hour collapse to one row — which
// is what we want, because the upstream cron only produces one frame
// per hour anyway.
function _hourKey(t) {
    return Math.floor(t / 3_600_000) * 3_600_000;
}

// ── Ring buffer (oldest-first when read) ────────────────────────────────────
// Keeping a separate in-memory ring on top of IDB so the resolver can
// answer nearest(t) / range(t0, t1) without touching disk on every scrub
// event. The IDB store is the durable backing; the ring is the hot path.

class RingBuffer {
    constructor(capacity) {
        this._cap  = capacity;
        this._buf  = new Array(capacity);
        this._head = 0;
        this._size = 0;
    }

    push(item) {
        this._buf[this._head] = item;
        this._head = (this._head + 1) % this._cap;
        if (this._size < this._cap) this._size++;
    }

    /** Oldest-first ordered copy. */
    toArray() {
        if (this._size === 0) return [];
        if (this._size < this._cap) return this._buf.slice(0, this._size);
        const tail = this._head % this._cap;
        return [...this._buf.slice(tail), ...this._buf.slice(0, tail)];
    }

    last(n = 1) {
        const arr = this.toArray();
        return n === 1 ? arr[arr.length - 1] : arr.slice(-n);
    }

    get size()     { return this._size; }
    get capacity() { return this._cap;  }
}

// ── WeatherHistory ──────────────────────────────────────────────────────────

export class WeatherHistory {
    constructor() {
        this._db    = null;
        this._dbOk  = false;
        this._ready = false;
        this._ring  = new RingBuffer(TIER.max_rows);
        // Last hour-key we ingested into IDB. Used to skip the put when
        // an in-flight refresh produces another sample inside the same
        // hour — the ring buffer dedupes by key, but skipping IDB avoids
        // a redundant txn.
        this._lastHourKey = 0;
    }

    /**
     * Open IndexedDB and warm the ring buffer from any persisted rows.
     * Always resolves — IDB failures degrade to in-memory-only mode.
     */
    async open() {
        try {
            this._db = await this._openDB();
            this._dbOk = true;
            await this._warmRing();
        } catch (err) {
            console.warn('[WeatherHistory] IndexedDB unavailable, using in-memory only:', err.message);
        }
        this._ready = true;
        console.info(`[WeatherHistory] ready — ${this._ring.size}/${this._ring.capacity} frames`);
        return this;
    }

    _openDB() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(TIER.name)) {
                    db.createObjectStore(TIER.name, { keyPath: 't' });
                }
            };
            req.onsuccess = (e) => resolve(e.target.result);
            req.onerror   = (e) => reject(e.target.error);
        });
    }

    async _warmRing() {
        const rows = await this._idbGetAll(TIER.name);
        rows.sort((a, b) => a.t - b.t);
        // If a previous schema version (different gridW/gridH or channel
        // count) is sitting on disk we silently drop it. Without this guard
        // the resolver's _decodeCoarse would walk off the end of `coarse`.
        const compatible = rows.filter(r =>
            r && Number.isFinite(r.t) &&
            r.coarse instanceof Float32Array &&
            Number.isFinite(r.gridW) && Number.isFinite(r.gridH) &&
            r.coarse.length === r.gridW * r.gridH * NUM_CHANNELS
        );
        if (compatible.length < rows.length) {
            const drop = rows.length - compatible.length;
            console.info(`[WeatherHistory] dropped ${drop} incompatible legacy rows on warmup`);
        }
        // Keep the most-recent N if the on-disk store has somehow drifted
        // past max_rows (e.g. crash before prune ran).
        const start = Math.max(0, compatible.length - TIER.max_rows);
        for (let i = start; i < compatible.length; i++) this._ring.push(compatible[i]);
        if (compatible.length > 0) {
            this._lastHourKey = _hourKey(compatible[compatible.length - 1].t);
        }
    }

    _idbGetAll(storeName) {
        return new Promise((resolve, reject) => {
            const tx  = this._db.transaction(storeName, 'readonly');
            const req = tx.objectStore(storeName).getAll();
            req.onsuccess = () => resolve(req.result);
            req.onerror   = () => reject(req.error);
        });
    }

    /**
     * Persist a fresh coarse frame.
     *
     * @param {object} frame
     * @param {number} frame.t              — wall-clock ms (rounded to hour for the key)
     * @param {number} [frame.fetchedAt]    — upstream fetched_at ms (defaults to t)
     * @param {string} [frame.source]
     * @param {number} frame.gridW
     * @param {number} frame.gridH
     * @param {Float32Array} frame.coarse   — CHW-packed (gridW × gridH × 9)
     *
     * Best-effort: returns void, never throws. If IDB is closed or the
     * record fails sanity checks we still update the in-memory ring so
     * the resolver has something to work with for this session.
     */
    ingest({ t, fetchedAt, source, gridW, gridH, coarse } = {}) {
        if (!this._ready) return;     // open() not yet awaited
        if (!Number.isFinite(t) || !Number.isFinite(gridW) || !Number.isFinite(gridH)) return;
        if (!(coarse instanceof Float32Array)) return;
        if (coarse.length !== gridW * gridH * NUM_CHANNELS) {
            console.warn('[WeatherHistory] ingest skipped — coarse length mismatch',
                coarse.length, 'vs', gridW * gridH * NUM_CHANNELS);
            return;
        }

        const key = _hourKey(t);
        const rec = {
            t:         key,
            fetchedAt: Number.isFinite(fetchedAt) ? fetchedAt : t,
            source:    source ?? null,
            gridW, gridH,
            // Defensive copy: caller may reuse its working buffer for the
            // next fetch and we don't want a shared reference under our
            // ring. Allocation is ~94 KB, negligible against the 15-min
            // refresh cadence.
            coarse:    new Float32Array(coarse),
        };

        // In-memory ring: replace if same hour-key, else push.
        const existingIdx = this._ringIndexOfKey(key);
        if (existingIdx >= 0) {
            this._ring._buf[existingIdx] = rec;
        } else {
            this._ring.push(rec);
        }

        // IDB: only put if we've crossed an hour boundary (or first ingest)
        // — within-hour duplicates collapse on the ring anyway and skipping
        // a put avoids a redundant transaction every 15 minutes.
        if (this._dbOk && key !== this._lastHourKey) {
            this._lastHourKey = key;
            this._idbPut(rec);
        } else if (this._dbOk && existingIdx < 0) {
            // First ingest of the session lands on the live hour-key,
            // so the `key !== _lastHourKey` guard above wouldn't fire
            // until the next hour. Force the put on first ingest.
            this._idbPut(rec);
        }

        // Notify subscribers (forecaster registry, validator, future ML
        // pipelines) that a fresh observation is in the ring. The detail
        // object hands over the same record we just stored — receivers
        // are free to read its `coarse` Float32Array but MUST treat it
        // as immutable (it's the live ring entry, not a copy).
        if (typeof document !== 'undefined') {
            document.dispatchEvent(new CustomEvent('weather-history-ingest', {
                detail: { frame: rec },
            }));
        }
    }

    /**
     * Linear scan of the ring for an existing record at this hour-key.
     * Cheap (≤24 entries); keeps the data structure simple. If we ever
     * want O(1) we can layer a Map<key, ringIndex> on top.
     */
    _ringIndexOfKey(key) {
        for (let i = 0; i < this._ring._cap; i++) {
            const entry = this._ring._buf[i];
            if (entry && entry.t === key) return i;
        }
        return -1;
    }

    _idbPut(rec) {
        try {
            const tx    = this._db.transaction(TIER.name, 'readwrite');
            const store = tx.objectStore(TIER.name);
            store.put(rec);
            // Async prune — keep ≤ max_rows + 6 (small slack for races
            // between concurrent puts and prunes).
            const countReq = store.count();
            countReq.onsuccess = () => {
                if (countReq.result <= TIER.max_rows + 6) return;
                // Cursor walks oldest-first (default ascending on keyPath).
                const overflow = countReq.result - TIER.max_rows;
                const cursorReq = store.openCursor();
                let pruned = 0;
                cursorReq.onsuccess = (e) => {
                    const c = e.target.result;
                    if (c && pruned < overflow) {
                        c.delete();
                        pruned++;
                        c.continue();
                    }
                };
            };
        } catch (err) {
            // Quota / closed-db errors are silent — the ring still has
            // the record so this session keeps working.
            console.debug('[WeatherHistory] idb put skipped:', err?.message);
        }
    }

    // ── Read API ────────────────────────────────────────────────────────────

    /** All frames in the ring, oldest first. */
    all() { return this._ring.toArray(); }

    /** Most-recent N frames (or 1 when no arg). Newest last. */
    recent(n = 1) { return this._ring.last(n); }

    /** Number of frames currently in memory. */
    get size() { return this._ring.size; }

    get isReady() { return this._ready; }

    /**
     * Single frame closest to a target timestamp. Returns null if the
     * ring is empty. Callers that want both bracketing frames for
     * interpolation should use `bracket(t)` instead.
     */
    nearest(tMs) {
        const arr = this._ring.toArray();
        if (arr.length === 0) return null;
        let best = arr[0];
        let bestDt = Math.abs(arr[0].t - tMs);
        for (let i = 1; i < arr.length; i++) {
            const dt = Math.abs(arr[i].t - tMs);
            if (dt < bestDt) { best = arr[i]; bestDt = dt; }
        }
        return best;
    }

    /**
     * Two frames bracketing `tMs` for linear interpolation, plus the
     * fractional position between them.
     *
     * Returns one of:
     *   { before, after, frac }   — straddling case (frac in [0, 1])
     *   { before, after: null, frac: 0 }  — t is past the newest frame (clamp)
     *   { before: null, after, frac: 0 }  — t is before the oldest frame (clamp)
     *   null                       — ring empty
     *
     * The clamp behaviour means scrubbing past the ends of history shows
     * the nearest-edge frame frozen, rather than blanking the globe.
     */
    bracket(tMs) {
        const arr = this._ring.toArray();
        if (arr.length === 0) return null;
        if (arr.length === 1) return { before: arr[0], after: null, frac: 0 };

        // Binary search for the first index with t > tMs. (Ring is
        // oldest-first; t is monotonic non-decreasing because we key
        // on hour-rounded timestamps and only ingest forward.)
        let lo = 0, hi = arr.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (arr[mid].t <= tMs) lo = mid + 1;
            else                   hi = mid;
        }
        // lo is now the first index strictly after tMs. The bracket is
        // [arr[lo-1], arr[lo]].
        if (lo === 0)              return { before: null,         after: arr[0], frac: 0 };
        if (lo === arr.length)     return { before: arr[lo - 1],  after: null,   frac: 0 };
        const before = arr[lo - 1];
        const after  = arr[lo];
        const span   = after.t - before.t;
        const frac   = span > 0 ? (tMs - before.t) / span : 0;
        return { before, after, frac };
    }
}

export default WeatherHistory;

// Re-exports for tests / resolver / future consumers.
export { NUM_CHANNELS };
