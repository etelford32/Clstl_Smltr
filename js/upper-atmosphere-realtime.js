/**
 * upper-atmosphere-realtime.js — Live driver + sim-clock for the
 * upper-atmosphere page.
 * ═══════════════════════════════════════════════════════════════════════════
 * Fuses three asynchronous data streams into a single, continuously
 * updated state vector:
 *
 *   1. NOAA SWPC indices  — F10.7 (daily), Kp / Ap (3-hour cadence,
 *                           1-min sampling). Pulled via fetchLiveIndices().
 *   2. Solar-wind bus     — Bz, v_sw, n_sw arriving on the
 *                           'swpc-update' window event (1-min cadence
 *                           when DSCOVR / ACE feeds are alive).
 *   3. Sim-clock          — user-controlled time-warp + scrubbing across
 *                           the last 72 h of buffered history.
 *
 * Between SWPC ticks, a Burton–style Dst* integrator runs every second
 * off the upstream solar-wind values (Bz, v_sw, n_sw), and a heuristic
 * Dst → Ap-surrogate map produces a continuously evolving Ap that the
 * UI applies to the engine. This is what makes density, temperature,
 * and drag respond *between* the slow Kp updates instead of stair-
 * stepping every three hours.
 *
 *   Ey  = -v_sw · Bz       (mV/m;     v in km/s, Bz in nT, ÷1000)
 *   VBs = v_sw · max(-Bz, 0)
 *   dDst_star/dt = a*max(0, Ey-Ec)  - Dst_star/tau
 *     a  = -4.4 nT/hr per (mV/m)
 *     Ec = 0.49 mV/m
 *     tau = 7.7 h
 *   Dst = Dst_star + b*sqrt(Pdyn) - c    (b=7.26 nT/sqrt(nPa), c=11 nT)
 *
 *   Ap_proxy = max(Ap_swpc, 15 + 0.85·|min(Dst,0)|^1.2)
 *
 * The clock model:
 *   - mode='live'   → simTimeMs follows wall-clock with offset=0.
 *   - mode='paused' → simTimeMs frozen at the last value.
 *   - mode='warp'   → simTimeMs advances at `rate` × wall-clock; can
 *                     be negative (replay) and bounded to history span.
 *
 * Emits:
 *   - 'ua-realtime-tick'   { simTimeMs, f107, ap, kp, dst, bz, v, n,
 *                            apSwpc, apProxy, source, mode, rate, isLive,
 *                            historyStartMs, historyEndMs }
 *   - 'ua-realtime-history'{ history, head }   on every push to the ring
 *
 * Public surface (singleton via getRealtimeDriver()):
 *   start()                  begin polling + integrating
 *   stop()
 *   refreshNow()             force an SWPC fetch now
 *   setMode(mode, rate?)     'live' | 'paused' | 'warp'
 *   setRate(rate)            time-warp multiplier (signed)
 *   jumpToNow()              snap simTimeMs to wall clock
 *   scrubTo(ms)              jump to a specific moment in history
 *   getState()               most recent fused state vector
 *   getHistory()             ring buffer (read-only view)
 */

import { fetchLiveIndices, kpToAp } from './upper-atmosphere-engine.js';
// Phase C — the driver no longer owns simTimeMs/mode/rate; it reads
// them from the shared TimeBus and adjusts via bus.setRate / setSimTime.
// Same external API (setMode, setRate, jumpToNow, scrubTo, getState),
// same emitted 'ua-realtime-tick' shape — every downstream consumer
// is unchanged. Only the source of truth moves.
import { getTimeBus } from './upper-atmosphere-time-bus.js';

// ── Tunables ──────────────────────────────────────────────────────────────
const SWPC_F107_INTERVAL_MS = 60 * 60 * 1000;     // 1 h
const SWPC_AP_INTERVAL_MS   = 3  * 60 * 1000;     // 3 min — Kp 1-min feed
const INTEGRATOR_MS         = 1000;               // 1 Hz Burton step
const HISTORY_SPAN_MS       = 72 * 60 * 60 * 1000; // 72 h replay window
const HISTORY_STEP_MS       = 30 * 1000;           // 30 s ring resolution

const BURTON = {
    a:  -4.4,   // nT/hr per (mV/m)
    Ec:  0.49,  // mV/m
    tau: 7.7,   // hours
    b:   7.26,  // nT / √nPa
    c:  11.0,   // nT
};

// ── Singleton ─────────────────────────────────────────────────────────────
let _instance = null;
export function getRealtimeDriver() {
    if (!_instance) _instance = new UpperAtmosphereRealtime();
    return _instance;
}

class UpperAtmosphereRealtime {
    constructor() {
        // Live source-of-truth indices (updated on SWPC fetch).
        this.f107Sfu = 150;
        this.apSwpc  = 15;
        this.kpSwpc  = 2;
        this.f107At  = 0;
        this.apAt    = 0;
        this.source  = 'climatology';

        // Solar-wind bus (updated on every swpc-update event).
        this.bz      = 0;
        this.vSw     = 400;
        this.nSw     = 5;
        this.swAt    = 0;

        // Burton integrator state.
        this.dstStar = 0;          // Dst* (pressure-corrected ring current)
        this.dst     = 0;          // Dst, presented to UI
        this.apProxy = 15;         // surrogate Ap (max of SWPC + Burton-derived)

        // Phase C: sim-clock state now lives on the shared TimeBus.
        // No more this.simTimeMs / this.mode / this.rate /
        // this._lastTickWallMs — everything is read from the bus and
        // mutated via its setters. The driver's emit cadence stays
        // 10 Hz (this._timers.clock) so DOM event consumers don't get
        // 60 Hz spam from the bus's animate-rate tick.
        this._bus = getTimeBus();
        // Subscribe to discrete repositioning so scrubTo() reflects
        // instantly in the emitted 'ua-realtime-tick' event without
        // waiting for the next 10 Hz poll.
        this._unsubJump = this._bus.onJump(() => this._emitTick());

        // Rolling 72-h ring buffer of fused snapshots.
        this.history = [];
        this._lastHistoryAt = 0;

        this._timers = { f107: null, ap: null, integ: null, clock: null };
        this._busBound = null;
        this._running = false;
    }

    // ── Lifecycle ──────────────────────────────────────────────────────────

    start() {
        if (this._running) return;
        this._running = true;

        // Bind solar-wind bus once.
        this._busBound = (e) => this._onSwpcBus(e?.detail);
        window.addEventListener('swpc-update', this._busBound);

        // Kick off SWPC pulls immediately (they're async + cheap).
        this._fetchF107Ap();

        // Schedules.
        this._timers.f107  = setInterval(() => this._fetchF107Ap('f107'), SWPC_F107_INTERVAL_MS);
        this._timers.ap    = setInterval(() => this._fetchF107Ap('ap'),   SWPC_AP_INTERVAL_MS);
        this._timers.integ = setInterval(() => this._stepIntegrator(),    INTEGRATOR_MS);
        // Phase C: 10 Hz emit timer reads bus state + dispatches the
        // 'ua-realtime-tick' event. The bus's own advance happens in
        // the globe's RAF loop (60+ Hz); throttling here keeps DOM
        // event consumers at a sensible cadence.
        this._timers.clock = setInterval(() => this._emitTick(),          100);
    }

    stop() {
        // Phase C: bus subscription is created in the constructor (not
        // start), so the unsub must run regardless of _running state.
        // Otherwise a stopped-but-never-started driver keeps emitting
        // realtime-tick on every bus scrub.
        this._unsubJump?.();
        this._unsubJump = null;

        if (!this._running) return;
        this._running = false;
        for (const k of Object.keys(this._timers)) {
            clearInterval(this._timers[k]);
            this._timers[k] = null;
        }
        if (this._busBound) {
            window.removeEventListener('swpc-update', this._busBound);
            this._busBound = null;
        }
    }

    // ── Sim-clock controls ────────────────────────────────────────────────

    // Phase C: all clock mutations route through the bus. External API
    // shape is identical — these stay on the driver so existing UI
    // doesn't need rewiring. The bus's onJump subscription (constructor)
    // re-emits 'ua-realtime-tick' on every discrete mutation so the
    // immediate-feedback behaviour of the old setters is preserved.

    setMode(mode, rate) {
        if (!['live', 'paused', 'warp'].includes(mode)) return;
        if (mode === 'live') {
            this._bus.snapToNow();              // sim=now + rate=1
        } else if (mode === 'paused') {
            this._bus.pause();
        } else if (mode === 'warp') {
            this._bus.setRate(Number.isFinite(rate) ? rate : this._bus.getRate() || 1);
        }
    }

    setRate(rate) {
        if (!Number.isFinite(rate)) return;
        this._bus.setRate(rate);
    }

    jumpToNow() { this._bus.snapToNow(); }

    scrubTo(ms) {
        if (!Number.isFinite(ms)) return;
        // Bus enforces its own bounds (30 d past / 1 h future, broader
        // than the driver's 72 h history). For replay back through the
        // history-ring window the bus pause behaviour is what we want;
        // for further-past scrubs the bus still works (sat propagation
        // is valid), even though the indices fall back to the nearest
        // history sample (see _currentState).
        this._bus.setSimTime(ms, { reason: 'scrub' });
        this._bus.setRate(1);                   // scrub freezes the rate at 1
    }

    refreshNow() {
        return this._fetchF107Ap('all');
    }

    // ── Reads ──────────────────────────────────────────────────────────────

    getState() {
        return this._currentState();
    }

    getHistory() {
        return this.history;
    }

    isLive() {
        // Phase C: delegate to the bus, which carries the same
        // semantic (rate≈1 AND within 30 s of wall-clock).
        return this._bus.isLive();
    }

    // ── Internals ──────────────────────────────────────────────────────────

    async _fetchF107Ap(_which) {
        try {
            const live = await fetchLiveIndices();
            if (!live) return null;
            const now = Date.now();
            if (Number.isFinite(live.f107Sfu)) {
                this.f107Sfu = live.f107Sfu;
                this.f107At  = now;
            }
            if (Number.isFinite(live.ap)) {
                this.apSwpc = live.ap;
                this.apAt   = now;
            }
            if (Number.isFinite(live.kp)) this.kpSwpc = live.kp;
            this.source = live.source || 'noaa-direct';
            this._emitTick();
            return live;
        } catch (_) {
            return null;
        }
    }

    _onSwpcBus(d) {
        if (!d) return;
        const sw = d.solar_wind || {};
        const speed   = sw.speed   ?? d.speed   ?? null;
        const density = sw.density ?? d.density ?? null;
        const bz      = sw.bz      ?? d.bz      ?? null;
        if (Number.isFinite(speed))   this.vSw = speed;
        if (Number.isFinite(density)) this.nSw = density;
        if (Number.isFinite(bz))      this.bz  = bz;
        this.swAt = Date.now();

        // Also pick up F10.7 / Kp if the bus is broadcasting them.
        const sa = d.solar_activity || {};
        const gm = d.geomagnetic   || {};
        if (Number.isFinite(sa.f107_sfu)) this.f107Sfu = sa.f107_sfu;
        if (Number.isFinite(gm.kp))       { this.kpSwpc = gm.kp; this.apSwpc = kpToAp(gm.kp); }

        // The bus is 1-min cadence; snap one Burton step so the proxy
        // catches up immediately rather than waiting for the next tick.
        this._stepIntegrator();
    }

    _stepIntegrator() {
        // Burton driver:
        //   Ey  = (v[km/s] · −Bz[nT]) / 1000   when Bz<0; else 0
        //   F   = a · max(0, Ey − Ec)          [nT/hr]
        //   dDst_star/dt = F - Dst_star/tau
        const Bs    = Math.max(-this.bz, 0);                // nT
        const VBs   = this.vSw * Bs;                        // km/s · nT
        const Ey    = VBs / 1000;                           // mV/m
        const drive = Ey > BURTON.Ec
            ? BURTON.a * (Ey - BURTON.Ec)
            : 0;                                            // nT/hr
        const dt_hr = INTEGRATOR_MS / 3_600_000;
        // Backward-Euler-like: stable for any τ > 0.
        const decay = Math.exp(-dt_hr / BURTON.tau);
        this.dstStar = this.dstStar * decay + drive * BURTON.tau * (1 - decay);

        // Pressure correction (ram pressure raises Dst*).
        const pdyn = 1.67e-6 * this.nSw * this.vSw * this.vSw; // nPa
        this.dst = this.dstStar + BURTON.b * Math.sqrt(Math.max(0, pdyn)) - BURTON.c;

        // Heuristic Dst → Ap surrogate. Stays at the SWPC Ap floor in
        // quiet conditions and only takes over when the integrator has
        // pulled Dst negative.
        const dstNeg = Math.max(0, -this.dst);
        const apFromDst = 15 + 0.85 * Math.pow(dstNeg, 1.2);
        this.apProxy = Math.max(this.apSwpc, apFromDst);

        // Push a sample into the ring at most once per HISTORY_STEP_MS.
        const now = Date.now();
        if (now - this._lastHistoryAt >= HISTORY_STEP_MS) {
            this._lastHistoryAt = now;
            this._pushHistory(now);
        }

        this._emitTick();
    }

    // _stepClock() was the driver's own clock advancement. Phase C
    // removed it — the shared TimeBus advances itself in the globe's
    // RAF loop (one canonical advance per page). The 10 Hz emit timer
    // in start() just reads + dispatches; bus.onJump (constructor)
    // covers the immediate-feedback case for explicit setRate / scrub.

    _pushHistory(t) {
        this.history.push({
            t,
            f107: this.f107Sfu,
            ap:   this.apProxy,
            apSwpc: this.apSwpc,
            kp:   this.kpSwpc,
            dst:  this.dst,
            bz:   this.bz,
            v:    this.vSw,
            n:    this.nSw,
        });
        const cutoff = t - HISTORY_SPAN_MS;
        // Drop expired entries (rare — only one per 30 s).
        while (this.history.length && this.history[0].t < cutoff) {
            this.history.shift();
        }
        try {
            window.dispatchEvent(new CustomEvent('ua-realtime-history', {
                detail: { history: this.history, head: this.history[this.history.length - 1] }
            }));
        } catch (_) { /* SSR */ }
    }

    _currentState() {
        // Phase C: all clock state from the bus. The payload shape
        // is unchanged — downstream consumers (status pill, fleet
        // analyzer, drag forecast, etc.) keep reading the same
        // fields. Driver-owned fields (history, f107Sfu, apProxy,
        // SW indices, …) are still local.
        const wall      = Date.now();
        const simTimeMs = this._bus.getSimTime();
        const mode      = this._bus.getMode();        // 'live'|'paused'|'warp'|'replay'
        const rate      = this._bus.getRate();
        // If we're scrubbing (sim-time != now), return the nearest
        // history sample so density/temperature reflect the past state.
        let snap = null;
        if (mode !== 'live' && Math.abs(simTimeMs - wall) > 60_000 && this.history.length) {
            snap = _findNearest(this.history, simTimeMs);
        }
        const f107 = snap ? snap.f107 : this.f107Sfu;
        const ap   = snap ? snap.ap   : this.apProxy;
        const kp   = snap ? snap.kp   : this.kpSwpc;
        const dst  = snap ? snap.dst  : this.dst;
        const bz   = snap ? snap.bz   : this.bz;
        const v    = snap ? snap.v    : this.vSw;
        const n    = snap ? snap.n    : this.nSw;
        return {
            simTimeMs,
            wallMs:    wall,
            f107, ap, kp, dst, bz, v, n,
            apSwpc:    this.apSwpc,
            apProxy:   this.apProxy,
            source:    this.source,
            // The bus distinguishes 'replay' (rate<0) from 'warp'
            // (rate>1 forward), but downstream realtime-tick consumers
            // only know 'live'|'paused'|'warp'. Project replay→warp
            // for backward compat; signed `rate` still tells the full
            // story for callers that care.
            mode:      mode === 'replay' ? 'warp' : mode,
            rate,
            isLive:    this._bus.isLive(),
            scrubbing: snap !== null,
            historyStartMs: wall - HISTORY_SPAN_MS,
            historyEndMs:   wall,
            f107At: this.f107At,
            apAt:   this.apAt,
            swAt:   this.swAt,
        };
    }

    _emitTick() {
        try {
            window.dispatchEvent(new CustomEvent('ua-realtime-tick', {
                detail: this._currentState(),
            }));
        } catch (_) { /* SSR */ }
    }
}

function _findNearest(history, t) {
    // Binary search — history is monotone in t.
    let lo = 0, hi = history.length - 1;
    if (t <= history[0].t) return history[0];
    if (t >= history[hi].t) return history[hi];
    while (lo + 1 < hi) {
        const mid = (lo + hi) >> 1;
        if (history[mid].t <= t) lo = mid; else hi = mid;
    }
    return Math.abs(history[lo].t - t) < Math.abs(history[hi].t - t)
        ? history[lo] : history[hi];
}
