/**
 * conjunction-screener.js — main-thread manager for the predictions-first
 * conjunction screen used by the Operations console.
 *
 * Wraps a single instance of debris-threat-worker.js. Unlike
 * DebrisThreatCache (the satellites.html consumer), this manager:
 *   - anchors at a caller-supplied epochMs (sim time, not wall clock),
 *   - takes an arbitrary `secondaries` set rather than a fixed debris
 *     catalog,
 *   - returns a Promise-per-run plus progress events,
 *   - issues per-run IDs so a stale screen's results are discarded if
 *     the user re-screens (or re-anchors) before the previous run
 *     finishes,
 *   - does NOT persist to IndexedDB. Time anchor and group filter
 *     drift continuously, so an IDB hit would almost always be wrong.
 *
 * Usage:
 *   const screener = new ConjunctionScreener();
 *   const off = screener.subscribe(evt => { ... }); // progress
 *   const results = await screener.run({
 *     targets:     [{ tle, group }, ...],
 *     secondaries: [{ tle, group }, ...],
 *     epochMs:     timeBus.getState().simTimeMs,
 *     params:      { horizonH: 14*24, stepMin: 10, thresholdKm: 50 },
 *   });
 *   off();
 *
 * `results` is { [primaryNoradId]: Threat[] } where Threat carries
 *   name, norad_id, group, dist_km, hours_ahead, tca_jd, tca_ms,
 *   dv_kms, miss_unit.
 */

const DEFAULT_PARAMS = Object.freeze({
    horizonH:    14 * 24,
    stepMin:     10,
    thresholdKm: 50,
    refine:      true,
    withDv:      true,
});

export class ConjunctionScreener {
    constructor() {
        this._worker      = null;
        this._wasmReady   = null;
        this._listeners   = new Set();
        this._runs        = new Map();   // runId → { resolve, reject }
        this._nextRunId   = 1;
        this._activeRunId = null;
        this._lastEvent   = null;
    }

    /** Subscribe to lifecycle events ({ phase, runId, done, total, ... }). */
    subscribe(fn) {
        this._listeners.add(fn);
        if (this._lastEvent) {
            try { fn(this._lastEvent); } catch (_) {}
        }
        return () => { this._listeners.delete(fn); };
    }

    get wasmReady() { return this._wasmReady; }
    get isRunning() { return this._activeRunId !== null; }

    /**
     * Run a screen. Resolves with the full results map; rejects on
     * worker error or if the run was superseded by a newer one.
     */
    run({ targets, secondaries, epochMs, params = {} } = {}) {
        if (!Array.isArray(targets)      || targets.length === 0)      return Promise.resolve({});
        if (!Array.isArray(secondaries)  || secondaries.length === 0)  return Promise.resolve({});
        if (!Number.isFinite(epochMs))   epochMs = Date.now();

        const merged = { ...DEFAULT_PARAMS, ...params };
        this._ensureWorker();

        // Cancel any in-flight run by rejecting it. The worker keeps
        // chugging, but its results will be ignored when they land.
        if (this._activeRunId !== null) {
            const prior = this._runs.get(this._activeRunId);
            if (prior) {
                prior.reject(Object.assign(new Error('superseded'), { code: 'superseded' }));
                this._runs.delete(this._activeRunId);
            }
        }

        const runId = this._nextRunId++;
        this._activeRunId = runId;

        const promise = new Promise((resolve, reject) => {
            this._runs.set(runId, { resolve, reject });
        });

        this._notify({
            phase: 'start', runId,
            total: targets.length, done: 0,
            epochMs, params: merged,
        });

        this._worker.postMessage({
            type:        'screen-fleet',
            runId,
            epochMs,
            targets,
            secondaries,
            params:      merged,
        });

        return promise;
    }

    /** Tear down the worker. In-flight runs reject. */
    dispose() {
        for (const [runId, { reject }] of this._runs) {
            reject(Object.assign(new Error('disposed'), { code: 'disposed', runId }));
        }
        this._runs.clear();
        this._activeRunId = null;
        if (this._worker) {
            this._worker.terminate();
            this._worker = null;
        }
    }

    // ── Internals ──────────────────────────────────────────────────────

    _ensureWorker() {
        if (this._worker) return;
        const url = new URL('../debris-threat-worker.js', import.meta.url);
        this._worker = new Worker(url, { type: 'module' });
        this._worker.onmessage = (e) => this._onMessage(e.data);
        this._worker.onerror   = (e) => {
            // A worker-level error nukes every in-flight run; there's
            // no runId on these so we surface it to all of them.
            const err = Object.assign(new Error(e.message ?? 'worker error'), { code: 'worker-error' });
            for (const [runId, { reject }] of this._runs) reject(err);
            this._runs.clear();
            this._activeRunId = null;
            this._notify({ phase: 'error', error: err.message });
        };
        this._worker.postMessage({ type: 'init' });
    }

    _onMessage(msg) {
        if (msg.type === 'ready') {
            this._wasmReady = !!msg.wasm;
            this._notify({ phase: 'ready', wasm: msg.wasm });
            return;
        }
        if (msg.type === 'progress') {
            // Stale runs still tick — silently ignore them for the UI.
            if (msg.runId !== this._activeRunId) return;
            this._notify({
                phase: 'progress', runId: msg.runId,
                done: msg.done, total: msg.total,
            });
            return;
        }
        if (msg.type === 'complete') {
            const entry = this._runs.get(msg.runId);
            this._runs.delete(msg.runId);
            // If a newer run displaced this one, drop the result on
            // the floor — caller already moved on.
            if (msg.runId !== this._activeRunId) return;
            this._activeRunId = null;
            this._notify({
                phase: 'complete', runId: msg.runId,
                primaryCount: Object.keys(msg.results).length,
            });
            entry?.resolve(msg.results);
            return;
        }
        if (msg.type === 'error') {
            const entry = this._runs.get(msg.runId);
            this._runs.delete(msg.runId);
            if (msg.runId === this._activeRunId) this._activeRunId = null;
            entry?.reject(Object.assign(new Error(msg.error), { code: 'worker-error', runId: msg.runId }));
            this._notify({ phase: 'error', runId: msg.runId, error: msg.error });
            return;
        }
    }

    _notify(evt) {
        this._lastEvent = evt;
        for (const fn of this._listeners) {
            try { fn(evt); }
            catch (err) { console.warn('[ConjunctionScreener] listener threw:', err); }
        }
    }
}
