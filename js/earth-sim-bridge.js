/**
 * earth-sim-bridge.js — main-thread façade for js/earth-sim-worker.js
 *
 * Lazily spawns the Earth-system Web Worker, dispatches `series` requests,
 * and caches the most recent reply for cheap interpolated lookups. The
 * worker is the single source of *deterministic ground truth* for the
 * Earth + Moon + Phobos + Deimos positions: because every sample is a
 * closed-form function of JD, the same (jd0, dt_s, count) input always
 * yields the same bytes (verified by `hash`).
 *
 * Typical usage in threejs.html:
 *
 *   import { EarthSimBridge } from './js/earth-sim-bridge.js';
 *   const bridge = new EarthSimBridge();
 *   bridge.onUpdate = (series) => updateBadge(series.hash, series.count);
 *
 *   // Each animation frame, after computing the current sim JD:
 *   bridge.maintain(simJD, simSpeed);   // refreshes the buffer when stale
 *   const truth = bridge.sample(simJD); // { moon:[x,y,z], phobos:..., deimos:..., earth:... }
 *
 * The worker file is resolved relative to *this* module so bundlers and
 * file:// dev servers both work.
 */

const WORKER_URL = new URL('./earth-sim-worker.js', import.meta.url);

export class EarthSimBridge {
    constructor() {
        this._worker      = null;
        this._ready       = false;
        this._nextId      = 1;
        this._inFlight    = false;
        this._lastRequest = 0;       // performance.now() ms
        this._series      = null;    // last reply: { jd0, dt_s, count, hash, body }
        this._tmp         = [0, 0, 0];

        // Public hook — set by the host page to react to fresh series.
        this.onUpdate = null;        // (series) => void
        this.onError  = null;        // (err) => void
    }

    /** Idempotent. Returns true once the worker has acknowledged readiness. */
    isReady() { return this._ready; }

    /** Most recent reply (or null). */
    latest() { return this._series; }

    _ensure() {
        if (this._worker) return;
        try {
            this._worker = new Worker(WORKER_URL, { type: 'module' });
        } catch (err) {
            // Some browsers (older Safari) refuse module workers — fall back
            // to a degraded mode where the bridge silently no-ops.
            console.warn('[earth-sim-bridge] module worker unsupported:', err);
            return;
        }
        this._worker.addEventListener('message', (ev) => this._onMsg(ev.data));
        this._worker.addEventListener('error', (err) => {
            if (this.onError) this.onError(err);
        });
    }

    _onMsg(msg) {
        if (!msg) return;
        if (msg.type === 'ready') { this._ready = true; return; }
        if (msg.type === 'series') {
            this._inFlight = false;
            this._series   = msg;
            if (this.onUpdate) this.onUpdate(msg);
            return;
        }
        if (msg.type === 'error') {
            this._inFlight = false;
            if (this.onError) this.onError(new Error(msg.error || 'worker error'));
            return;
        }
    }

    /**
     * Issue a fresh series request if the buffer is missing or stale.
     * Throttled to one in-flight request at a time.
     *
     * @param {number} simJD     Current sim Julian Day
     * @param {number} simSpeed  Real-time multiplier (sim seconds per real second)
     * @param {object} [opts]    { count, horizon_s, refreshMs }
     */
    maintain(simJD, simSpeed, opts = {}) {
        this._ensure();
        if (!this._worker || this._inFlight) return;

        const count     = opts.count     ?? 64;
        const horizon_s = opts.horizon_s ?? Math.max(60, Math.abs(simSpeed) * 8); // ~8 real-sec window
        const refreshMs = opts.refreshMs ?? 250;
        const dt_s      = horizon_s / Math.max(1, count - 1);

        const now = performance.now();
        if (this._series) {
            // Refresh when (a) we've drifted to within 2 samples of the buffer end
            // or (b) refreshMs has elapsed (whichever first), so paused / very-slow
            // sims still get the occasional re-anchor.
            const s   = this._series;
            const idx = (simJD - s.jd0) * 86400 / s.dt_s;
            const tail = s.count - idx;
            if (tail > 2 && (now - this._lastRequest) < refreshMs) return;
        }

        this._lastRequest = now;
        this._inFlight    = true;
        const id = this._nextId++;
        // Anchor a few samples before now so we're never extrapolating.
        const jd0 = simJD - dt_s * 4 / 86400;
        this._worker.postMessage({ type: 'series', id, jd0, dt_s, count });
    }

    /**
     * Linear interpolation of the cached series at JD. Returns null if the
     * buffer is missing or the JD lies outside the buffer window. The result
     * is { moon:[x,y,z], phobos:..., deimos:..., earth:... } in the same
     * frames as the worker output (parent-equator km for moons; ecliptic AU
     * for Earth).
     */
    sample(simJD) {
        const s = this._series;
        if (!s) return null;
        const u = (simJD - s.jd0) * 86400 / s.dt_s;   // sample-space coord
        if (u < 0 || u > s.count - 1) return null;
        const i = Math.floor(u);
        const f = u - i;
        const get = (arr) => {
            const o0 = i * 3, o1 = (i + 1) * 3;
            return [
                arr[o0    ] * (1 - f) + arr[o1    ] * f,
                arr[o0 + 1] * (1 - f) + arr[o1 + 1] * f,
                arr[o0 + 2] * (1 - f) + arr[o1 + 2] * f,
            ];
        };
        return {
            moon:   get(s.body.moon),
            phobos: get(s.body.phobos),
            deimos: get(s.body.deimos),
            earth:  get(s.body.earth),
        };
    }

    dispose() {
        if (this._worker) { this._worker.terminate(); this._worker = null; }
        this._ready = false;
        this._series = null;
    }
}

export default EarthSimBridge;
