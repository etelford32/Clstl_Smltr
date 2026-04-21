/**
 * debris-threat-cache.js — main-thread manager for the debris Web Worker
 * ═══════════════════════════════════════════════════════════════════════════
 * Owns the lifecycle of js/debris-threat-worker.js:
 *   * lazily spawns the worker on the first .run() call,
 *   * caches per-NORAD-ID threat lists keyed by target satellite,
 *   * surfaces state transitions (idle → running → done | error) via a
 *     subscribe() observer so UI code can render progress without polling.
 *
 * Usage:
 *   import { DebrisThreatCache } from './js/debris-threat-cache.js';
 *
 *   const cache = new DebrisThreatCache();
 *   cache.subscribe(evt => {
 *       if (evt.state === 'running') showProgressBar(evt.done / evt.total);
 *       if (evt.state === 'done')    populateNearMissColumn();
 *   });
 *
 *   // Fire once both catalogs exist on the main thread.
 *   cache.run(operationalTles, debrisTles, { hoursAhead: 24, thresholdKm: 50 });
 *
 *   // Read-side (on satellite selection):
 *   const count   = cache.getCountFor(noradId);   // number
 *   const threats = cache.getThreatsFor(noradId); // Threat[] | null
 */

const DEFAULT_PARAMS = { hoursAhead: 24, stepMin: 10, thresholdKm: 50 };

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

        this._worker.postMessage({
            type:    'screen-all',
            targets,
            debris,
            params:  merged,
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

    clearCache() {
        this._threats = new Map();
        this._state   = 'idle';
        this._notify({ state: 'idle' });
    }

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
            this._notify({
                state: 'done',
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
