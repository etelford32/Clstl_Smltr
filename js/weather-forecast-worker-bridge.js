/**
 * weather-forecast-worker-bridge.js — main-thread façade for the RK2 dense
 * forecast worker (js/weather-forecast-worker.js).
 *
 * Lazily spawns the module worker on first request, tracks in-flight requests
 * by id, and resolves each with the dense forecast the worker posts back.
 * Any spawn/runtime failure flips `available()` to false so the caller
 * (ForecastPaintProvider) transparently falls back to inline computation —
 * the forecast must never silently disappear because a worker died.
 *
 *   const bridge = new WeatherForecastWorkerBridge();
 *   if (bridge.available()) {
 *       const dense = await bridge.request(forecaster.denseInputs({ history }));
 *   }
 */

const WORKER_URL = new URL('./weather-forecast-worker.js', import.meta.url);

export class WeatherForecastWorkerBridge {
    constructor() {
        this._worker  = null;
        this._failed  = false;      // sticky: once a worker dies we stop trying
        this._nextId  = 1;
        this._pending = new Map();  // id → { resolve, reject }
    }

    /** True when a worker can be (or already is) used. */
    available() {
        return typeof Worker !== 'undefined' && !this._failed;
    }

    _ensure() {
        if (this._worker || this._failed) return this._worker;
        if (typeof Worker === 'undefined') { this._failed = true; return null; }
        try {
            const w = new Worker(WORKER_URL, { type: 'module' });
            w.onmessage = (e) => {
                const m = e.data;
                // Request ids are unique across message types, so one pending
                // map serves both 'forecast' and 'mlevels' replies.
                if (!m || (m.type !== 'forecast' && m.type !== 'mlevels')) return;  // ignore 'ready'
                const p = this._pending.get(m.id);
                if (!p) return;
                this._pending.delete(m.id);
                if (m.error) p.reject(new Error(m.error));
                else         p.resolve(m.dense ?? null);
            };
            w.onerror = (e) => this._die(e?.message || 'worker error');
            this._worker = w;
        } catch (err) {
            this._die(err?.message || String(err));
        }
        return this._worker;
    }

    _die(reason) {
        this._failed = true;
        for (const p of this._pending.values()) p.reject(new Error(reason));
        this._pending.clear();
        try { this._worker?.terminate(); } catch (_) { /* ignore */ }
        this._worker = null;
    }

    /**
     * Run a dense computation off-thread. With the default type, `inputs` is
     * the object returned by WindAdvectionRK2Forecaster.denseInputs(); with
     * type 'mlevels' it is MultiLevelAdvectionForecaster.levelsDenseInputs().
     * Resolves with the dense result (or null if there was nothing to seed
     * from); rejects on worker error so the caller can fall back inline.
     */
    request(inputs, type = 'forecast') {
        const w = this._ensure();
        if (!w) return Promise.reject(new Error('forecast worker unavailable'));
        const id = this._nextId++;
        return new Promise((resolve, reject) => {
            this._pending.set(id, { resolve, reject });
            try {
                w.postMessage({ type, id, ...inputs });
            } catch (err) {
                this._pending.delete(id);
                reject(err);
            }
        });
    }

    stop() {
        try { this._worker?.terminate(); } catch (_) { /* ignore */ }
        this._worker = null;
        this._pending.clear();
    }
}

export default WeatherForecastWorkerBridge;
