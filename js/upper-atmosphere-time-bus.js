/**
 * upper-atmosphere-time-bus.js — unified sim-clock for the upper-atmosphere page
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Phase A of the scrubber/replay infrastructure. This module is the
 * **foundation only**: it provides one canonical simTimeMs that every
 * time-sensitive subsystem (sat propagation, realtime driver, fleet
 * analyzer, conjunction screener, backtest, anomaly detector) will
 * eventually read from. It currently has zero consumers — Phase B / C
 * wire those up.
 *
 * Why introduce this even before consumers exist:
 * 1. It's small + testable in isolation. Easy to validate the API
 *    surface before the refactor risks compound.
 * 2. It lets us write Phase B + C against a stable interface instead
 *    of building both the consumer and the producer at once.
 * 3. The realtime driver already maintains its own simTimeMs; sharing
 *    a single bus means the existing logic can be drained into here
 *    without a rewrite (Phase C).
 *
 * ── Time model ──────────────────────────────────────────────────────────
 *
 *   simTimeMs   canonical sim-clock (Unix ms). The "now" the rest of
 *               the page should read.
 *   rate        signed multiplier applied to wall-clock advance.
 *                  rate=  1  →  live (real-time)
 *                  rate=  0  →  paused (no advance)
 *                  rate= 60  →  forward warp (e.g. 60s sim per 1s wall)
 *                  rate=-10  →  REPLAY (sim-clock runs BACKWARD)
 *   mode        derived: 'live' | 'paused' | 'warp' | 'replay'.
 *
 * Bounds: simTimeMs is clamped to [now − pastHorizonMs, now + futureHorizonMs].
 * Defaults are 30 days past, 1 hour future. The past horizon matches
 * the SWPC daily-cadence indices (Phase 7/10 fetch ~50 days of F10.7
 * and ~30 days of Ap, so 30 days is a safe replay budget). The future
 * horizon is small because SGP4 accuracy degrades with TLE age and
 * the operator's interest in future replay is mostly "what will this
 * conjunction look like in 45 minutes?".
 *
 * ── Advance ────────────────────────────────────────────────────────────
 *
 * The bus does NOT auto-tick. The host must call step() once per
 * animate frame (typically from the renderer's RAF loop). step() reads
 * Date.now() internally, computes the wall-clock delta since the last
 * step, scales by rate, advances simTimeMs.
 *
 * This pull-based model means the bus stays paused when the page is
 * hidden (tab background) — no Date.now() drift accumulating while no
 * one is watching.
 *
 * ── Subscriptions ──────────────────────────────────────────────────────
 *
 *   onTick(fn)    fn({ simTimeMs, rate, mode, dtSimMs, isLive }) every step
 *   onJump(fn)    fn({ simTimeMs, reason }) for explicit setSimTime() calls
 *                                            (vs. continuous advance)
 *
 * Both return unsubscribe functions.
 *
 * ── Public API ─────────────────────────────────────────────────────────
 *
 *   getTimeBus()           singleton accessor
 *   bus.getSimTime()       simTimeMs as number
 *   bus.getRate()          signed multiplier
 *   bus.getMode()          'live' | 'paused' | 'warp' | 'replay'
 *   bus.isLive()           true iff rate=1 AND within 30 s of wall-clock
 *   bus.setSimTime(ms, opts) jump (clamped to bounds) + emit 'jump'
 *   bus.setRate(r)         change advance multiplier
 *   bus.pause()            rate→0 (remembers prior rate for resume)
 *   bus.resume()           rate→last non-zero
 *   bus.snapToNow()        simTimeMs=Date.now(), rate=1
 *   bus.step()             advance using wall-clock delta (host calls this)
 *   bus.onTick(fn)         subscribe
 *   bus.onJump(fn)         subscribe
 *   bus.getBounds()        { pastMs, futureMs, nowMs }   for UI scales
 *
 * The bus is deliberately framework-agnostic — no DOM, no THREE, no
 * fetch. Pure state machine. Tests can run in Node with no shims.
 */

const PAST_HORIZON_MS_DEFAULT   = 30 * 24 * 3600 * 1000;   // 30 days
const FUTURE_HORIZON_MS_DEFAULT = 1  * 3600 * 1000;        // 1 hour
const LIVE_TOLERANCE_MS         = 30 * 1000;               // 30 s

let _instance = null;

/** Module-level singleton accessor. Pattern matches realtime driver. */
export function getTimeBus() {
    if (!_instance) _instance = new TimeBus();
    return _instance;
}

/** Reset the singleton — testing only; don't call from production code. */
export function _resetTimeBusForTests() { _instance = null; }

export class TimeBus {
    constructor({
        pastHorizonMs   = PAST_HORIZON_MS_DEFAULT,
        futureHorizonMs = FUTURE_HORIZON_MS_DEFAULT,
        // Injectable wall-clock for tests. Production passes nothing
        // and the bus uses Date.now() directly.
        now = () => Date.now(),
    } = {}) {
        this._now             = now;
        this._pastHorizonMs   = pastHorizonMs;
        this._futureHorizonMs = futureHorizonMs;

        // Anchor simTimeMs to wall-clock at construction. Rate=1 means
        // first step() advances normally; consumers see "real time"
        // until the operator changes anything.
        this._simTimeMs       = this._now();
        this._rate            = 1;
        this._rateBeforePause = 1;        // restore target for resume()
        this._lastStepWallMs  = this._now();

        // Pub-sub. Two channels: continuous tick + discrete jump. UI
        // for the scrubber renders fast paths off tick + heavy re-
        // computes off jump, so subscribers can pick their cost level.
        this._tickSubs = new Set();
        this._jumpSubs = new Set();
    }

    // ── Reads ───────────────────────────────────────────────────────────

    getSimTime()   { return this._simTimeMs; }
    getRate()      { return this._rate; }
    getMode() {
        if (this._rate === 0) return 'paused';
        if (this._rate <  0)  return 'replay';
        if (this.isLive())    return 'live';
        return 'warp';
    }
    /**
     * True iff the bus is plausibly tracking wall-clock right now —
     * rate ≈ 1 AND simTimeMs within tolerance of Date.now(). The
     * realtime driver uses a similar test today; we mirror its
     * semantics so consumers can ask "should I draw the LIVE pill?"
     * without caring whether they're on the old clock or the new one.
     */
    isLive() {
        return Math.abs(this._rate - 1) < 1e-9
            && Math.abs(this._now() - this._simTimeMs) < LIVE_TOLERANCE_MS;
    }
    getBounds() {
        const nowMs = this._now();
        return {
            nowMs,
            pastMs:   nowMs - this._pastHorizonMs,
            futureMs: nowMs + this._futureHorizonMs,
        };
    }

    // ── Writes ──────────────────────────────────────────────────────────

    /**
     * Jump to a specific time. Clamped to [pastMs, futureMs]. Emits a
     * 'jump' event (separate from 'tick' so subscribers can distinguish
     * continuous advance from operator-initiated repositioning).
     *
     * @param {number} ms       target simTimeMs in Unix ms
     * @param {object} [opts]
     * @param {string} [opts.reason='manual']  surfaced to onJump subs
     */
    setSimTime(ms, { reason = 'manual' } = {}) {
        if (!Number.isFinite(ms)) return;
        const b = this.getBounds();
        const clamped = Math.max(b.pastMs, Math.min(b.futureMs, ms));
        this._simTimeMs = clamped;
        // Re-anchor the wall-clock reference so the NEXT step()
        // doesn't apply a giant rate × (gap-since-last-step) jump on
        // top of the value we just set.
        this._lastStepWallMs = this._now();
        this._emitJump({ reason });
    }

    /**
     * Change the advance multiplier. Signed; 0 pauses.
     * Pause path also remembers the prior rate so resume() returns to it.
     */
    setRate(rate) {
        if (!Number.isFinite(rate)) return;
        if (rate === 0) {
            if (this._rate !== 0) this._rateBeforePause = this._rate;
            this._rate = 0;
        } else {
            this._rate = rate;
            this._rateBeforePause = rate;
        }
        // Re-anchor wall ref so the rate change applies cleanly to
        // future steps (no retroactive scaling of any pending delta).
        this._lastStepWallMs = this._now();
    }

    pause()  { this.setRate(0); }
    resume() { this.setRate(this._rateBeforePause || 1); }

    /** Convenience: jump to wall-clock-now + rate=1 + emit jump. */
    snapToNow() {
        this._simTimeMs = this._now();
        this._rate = 1;
        this._rateBeforePause = 1;
        this._lastStepWallMs = this._now();
        this._emitJump({ reason: 'snap-to-now' });
    }

    // ── Advance ─────────────────────────────────────────────────────────

    /**
     * Advance simTimeMs based on the wall-clock delta since the last
     * step. Host should call this once per animate frame. Returns the
     * simulated delta in milliseconds (useful for callers that want to
     * piggyback their own time-aware updates without subscribing).
     *
     * Bounds are enforced on advance: hitting either edge clamps the
     * value AND zeroes the rate so the operator doesn't have to
     * manually pause to escape the boundary. (They can rate-up out of
     * it again if they want.)
     */
    step() {
        const wallNow = this._now();
        const dtWall  = wallNow - this._lastStepWallMs;
        this._lastStepWallMs = wallNow;

        let dtSimMs = 0;
        if (this._rate !== 0 && dtWall > 0) {
            dtSimMs = dtWall * this._rate;
            this._simTimeMs += dtSimMs;

            const b = this.getBounds();
            if (this._simTimeMs > b.futureMs) {
                this._simTimeMs = b.futureMs;
                this._rate = 0;       // pin at edge instead of stalling silently
            } else if (this._simTimeMs < b.pastMs) {
                this._simTimeMs = b.pastMs;
                this._rate = 0;
            }
        }
        this._emitTick({ dtSimMs });
        return dtSimMs;
    }

    // ── Pub-sub ─────────────────────────────────────────────────────────

    onTick(fn) {
        if (typeof fn !== 'function') return () => {};
        this._tickSubs.add(fn);
        return () => this._tickSubs.delete(fn);
    }
    onJump(fn) {
        if (typeof fn !== 'function') return () => {};
        this._jumpSubs.add(fn);
        return () => this._jumpSubs.delete(fn);
    }

    _emitTick({ dtSimMs }) {
        // Snapshot the current state once; emit to every subscriber
        // synchronously. A throwing subscriber doesn't break siblings.
        const payload = Object.freeze({
            simTimeMs: this._simTimeMs,
            rate:      this._rate,
            mode:      this.getMode(),
            isLive:    this.isLive(),
            dtSimMs,
        });
        for (const fn of this._tickSubs) {
            try { fn(payload); } catch (_) { /* isolate */ }
        }
    }
    _emitJump({ reason }) {
        const payload = Object.freeze({
            simTimeMs: this._simTimeMs,
            rate:      this._rate,
            mode:      this.getMode(),
            reason,
        });
        for (const fn of this._jumpSubs) {
            try { fn(payload); } catch (_) { /* isolate */ }
        }
    }
}
