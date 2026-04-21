/**
 * debris-threat-cache.js — main-thread manager for the debris Web Worker
 * ═══════════════════════════════════════════════════════════════════════════
 * Owns the lifecycle of js/debris-threat-worker.js:
 *   * lazily spawns the worker on the first .run() call,
 *   * caches per-NORAD-ID threat lists keyed by target satellite,
 *   * surfaces state transitions (idle → running → done | error) via a
 *     subscribe() observer so UI code can render progress without polling,
 *   * persists the last successful screen to IndexedDB and restores it on
 *     subsequent page loads within CACHE_MAX_AGE_MS, so the (expensive)
 *     SGP4 run doesn't re-fire on every reload.
 *
 * The IndexedDB row is invalidated when any of:
 *     * the saved record is older than CACHE_MAX_AGE_MS,
 *     * run params don't match (hoursAhead / stepMin / thresholdKm),
 *     * target/debris counts differ by more than 5 % (catalog churn — a
 *       proxy for "CelesTrak has refreshed and the TLEs the old screen
 *       was built on are now stale").
 *
 * Usage:
 *   import { DebrisThreatCache } from './js/debris-threat-cache.js';
 *
 *   const cache = new DebrisThreatCache();
 *   cache.subscribe(evt => { ... });           // progress + done
 *   await cache.restore({ hoursAhead: 24 });   // try IDB; resolves true if hit
 *   if (!restored) cache.run(targets, debris); // else run the worker
 */

const DEFAULT_PARAMS    = { hoursAhead: 24, stepMin: 10, thresholdKm: 50 };
const CACHE_MAX_AGE_MS  = 6 * 60 * 60 * 1000;   // 6 h — CelesTrak updates ~8 h
const IDB_NAME          = 'clstl-debris-threats';
const IDB_STORE         = 'runs';
const IDB_VERSION       = 1;
const IDB_KEY           = 'last-run';

// ── Tiny IDB helpers (inline; no new module) ───────────────────────────────
// Async-reject promises so callers that don't have IDB (private mode,
// Safari quirks, test harnesses) just fall through to a fresh worker run.

function _openDb() {
    return new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') return reject(new Error('no IDB'));
        const req = indexedDB.open(IDB_NAME, IDB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(IDB_STORE)) {
                db.createObjectStore(IDB_STORE);   // out-of-line keys
            }
        };
        req.onerror   = () => reject(req.error);
        req.onsuccess = () => resolve(req.result);
    });
}
async function _idbGet(key) {
    try {
        const db = await _openDb();
        return await new Promise((resolve, reject) => {
            const req = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(key);
            req.onsuccess = () => resolve(req.result ?? null);
            req.onerror   = () => reject(req.error);
        });
    } catch { return null; }
}
async function _idbPut(key, value) {
    try {
        const db = await _openDb();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_STORE, 'readwrite');
            tx.objectStore(IDB_STORE).put(value, key);
            tx.oncomplete = () => resolve();
            tx.onerror    = () => reject(tx.error);
        });
    } catch { /* swallow — cache is best-effort */ }
}
async function _idbDel(key) {
    try {
        const db = await _openDb();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_STORE, 'readwrite');
            tx.objectStore(IDB_STORE).delete(key);
            tx.oncomplete = () => resolve();
            tx.onerror    = () => reject(tx.error);
        });
    } catch { /* swallow */ }
}

function _sameParams(a, b) {
    if (!a || !b) return false;
    return a.hoursAhead  === b.hoursAhead
        && a.stepMin     === b.stepMin
        && a.thresholdKm === b.thresholdKm;
}

export class DebrisThreatCache {
    constructor() {
        this._worker       = null;
        this._wasmReady    = null;      // set by 'ready' message
        this._state        = 'idle';    // idle | running | done | error
        this._progress     = 0;
        this._total        = 0;
        this._error        = null;
        this._completedAt  = null;
        this._threats      = new Map(); // noradId (number) → Threat[]
        this._listeners    = new Set();
        this._lastParams   = null;
        this._source       = null;      // 'worker' | 'idb' — how _threats was last filled
    }

    // ── Public API ──────────────────────────────────────────────────────────

    get state()        { return this._state; }
    get progress()     { return this._progress; }
    get total()        { return this._total; }
    get completedAt()  { return this._completedAt; }
    get threatCount()  { return this._threats.size; }
    get wasmReady()    { return this._wasmReady; }

    /** Look up cached threats for a target sat. Returns null when either
     *  the cache hasn't been populated yet or the sat had zero matches. */
    getThreatsFor(noradId) {
        return this._threats.get(Number(noradId)) ?? null;
    }

    /** Returns 0 when the sat has no threats OR the cache hasn't run yet.
     *  Callers that need to distinguish those two cases should check
     *  `cache.state === 'done'` first. */
    getCountFor(noradId) {
        return this._threats.get(Number(noradId))?.length ?? 0;
    }

    /**
     * Run the worker. Safe to call repeatedly — if a run is already in
     * progress the new call is rejected (returns false); otherwise starts
     * a fresh screen and overwrites the cache on completion.
     *
     * @param {TLE[]} targets   operational satellites to screen
     * @param {TLE[]} debris    debris catalog to screen against
     * @param {object} [params] { hoursAhead, stepMin, thresholdKm }
     * @returns {boolean}       true if run was scheduled
     */
    run(targets, debris, params = {}) {
        if (this._state === 'running') return false;
        if (!targets?.length || !debris?.length) return false;

        const merged = { ...DEFAULT_PARAMS, ...params };
        this._lastParams = merged;
        this._ensureWorker();

        // Reset run-scoped state but keep `_threats` until the worker
        // returns — readers stay useful during the rescan.
        this._state    = 'running';
        this._progress = 0;
        this._total    = targets.length;
        this._error    = null;
        this._notify({
            state: 'running', done: 0, total: targets.length, phase: 'start',
        });

        // Remember catalog sizes so the IDB fingerprint can compare on
        // reload. We don't hash every NORAD ID — a 5 % churn tolerance on
        // counts is a reasonable proxy for "catalog basically unchanged".
        this._lastTargetCount = targets.length;
        this._lastDebrisCount = debris.length;

        this._worker.postMessage({
            type:    'screen-all',
            targets,
            debris,
            params:  merged,
        });
        return true;
    }

    /**
     * Try to restore a previous run from IndexedDB. Returns true when
     * a compatible record was found and loaded (callers should then skip
     * the worker run). Compatibility checks:
     *   * record age < CACHE_MAX_AGE_MS (default 6 h),
     *   * stored params equal requested params,
     *   * catalog sizes within 5 % (proxy for "TLEs roughly the same set").
     *
     * @param {object} params           — same shape as run().
     * @param {number} targetCount      — current target catalog size.
     * @param {number} debrisCount      — current debris catalog size.
     * @returns {Promise<boolean>}
     */
    async restore({ params = {}, targetCount, debrisCount } = {}) {
        const rec = await _idbGet(IDB_KEY);
        if (!rec) return false;

        const ageMs = Date.now() - (rec.savedAt ?? 0);
        if (ageMs > CACHE_MAX_AGE_MS) {
            this._notify({ state: 'idle', phase: 'idb-stale', ageMs });
            _idbDel(IDB_KEY);                   // prune; no need to keep a stale row
            return false;
        }

        const merged = { ...DEFAULT_PARAMS, ...params };
        if (!_sameParams(merged, rec.params)) {
            this._notify({ state: 'idle', phase: 'idb-param-mismatch' });
            return false;
        }

        // Catalog size tolerance — tight enough to catch a refreshed
        // CelesTrak but loose enough to survive minor catalogue churn.
        if (Number.isFinite(targetCount) && rec.targetCount) {
            const d = Math.abs(targetCount - rec.targetCount) / rec.targetCount;
            if (d > 0.05) { this._notify({ state: 'idle', phase: 'idb-catalog-drift' }); return false; }
        }
        if (Number.isFinite(debrisCount) && rec.debrisCount) {
            const d = Math.abs(debrisCount - rec.debrisCount) / rec.debrisCount;
            if (d > 0.05) { this._notify({ state: 'idle', phase: 'idb-catalog-drift' }); return false; }
        }

        const next = new Map();
        for (const [k, v] of Object.entries(rec.results ?? {})) {
            next.set(Number(k), v);
        }
        this._threats     = next;
        this._state       = 'done';
        this._completedAt = new Date(rec.savedAt);
        this._lastParams  = rec.params;
        this._source      = 'idb';
        this._notify({
            state: 'done', phase: 'idb-hit',
            threatCount: next.size,
            completedAt: this._completedAt,
            ageMs,
        });
        return true;
    }

    /** Subscribe to state updates. Returns an unsubscribe thunk. */
    subscribe(fn) {
        this._listeners.add(fn);
        return () => this._listeners.delete(fn);
    }

    /** Tear down the worker. Cached threat data survives — explicit
     *  clearCache() is required to drop it. */
    dispose() {
        if (this._worker) {
            this._worker.terminate();
            this._worker = null;
        }
    }

    clearCache({ persist = true } = {}) {
        this._threats = new Map();
        this._state   = 'idle';
        this._source  = null;
        if (persist !== false) _idbDel(IDB_KEY);
        this._notify({ state: 'idle', phase: 'cleared' });
    }

    /** Where the currently-cached threat data came from:
     *  'worker' (this-session compute), 'idb' (restored from last run),
     *  or null (never populated). */
    get source() { return this._source; }

    // ── Internals ───────────────────────────────────────────────────────────

    _ensureWorker() {
        if (this._worker) return;
        // Resolve the worker URL relative to this module so bundlers that
        // rewrite `new URL(..., import.meta.url)` keep it deterministic.
        const url = new URL('./debris-threat-worker.js', import.meta.url);
        this._worker = new Worker(url, { type: 'module' });
        this._worker.onmessage = (e) => this._onMessage(e.data);
        this._worker.onerror   = (e) => {
            this._state = 'error';
            this._error = String(e.message ?? 'worker error');
            this._notify({ state: 'error', error: this._error });
        };
        this._worker.postMessage({ type: 'init' });
    }

    _onMessage(msg) {
        if (msg.type === 'ready') {
            this._wasmReady = !!msg.wasm;
            this._notify({ state: this._state, phase: 'ready', wasm: msg.wasm });
            return;
        }
        if (msg.type === 'progress') {
            this._progress = msg.done;
            this._total    = msg.total;
            this._notify({
                state: 'running', done: msg.done, total: msg.total, phase: 'tick',
            });
            return;
        }
        if (msg.type === 'complete') {
            // Convert {noradId: threats[]} → Map<number, threats[]>
            const next = new Map();
            for (const [k, v] of Object.entries(msg.results)) {
                next.set(Number(k), v);
            }
            this._threats     = next;
            this._state       = 'done';
            this._completedAt = new Date();
            this._source      = 'worker';
            // Persist to IDB as an object (Map instances don't structured-
            // clone into IDB reliably across engines). Fire and forget —
            // it's a best-effort cache.
            _idbPut(IDB_KEY, {
                savedAt:     this._completedAt.getTime(),
                params:      this._lastParams,
                targetCount: this._lastTargetCount,
                debrisCount: this._lastDebrisCount,
                results:     msg.results,
            });
            this._notify({
                state: 'done',
                phase: 'worker-complete',
                threatCount: next.size,
                completedAt: this._completedAt,
            });
            return;
        }
        if (msg.type === 'error') {
            this._state = 'error';
            this._error = msg.error;
            this._notify({ state: 'error', error: msg.error });
            return;
        }
    }

    _notify(evt) {
        for (const fn of this._listeners) {
            try { fn(evt); }
            catch (err) { console.warn('[DebrisThreatCache] listener threw:', err); }
        }
    }
}
