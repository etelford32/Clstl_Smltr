/**
 * time-bus.js — Single source of truth for simulation time on the
 * Operations console.
 *
 * One rAF loop drives simTimeMs forward according to the active mode:
 *   live   — simTimeMs = Date.now()              (auto-advancing)
 *   scrub  — simTimeMs frozen at user position   (drag / arrow keys)
 *   replay — simTimeMs = anchorSim + (wall - anchorWall) * speed
 *            (paused = same as scrub)
 *
 * Subscribers receive a throttled (≤ 10 Hz) state snapshot via
 * subscribe(fn). Renderers that need 60 Hz (the globe, step 10+)
 * call getState() inline from their own rAF — the 10 Hz emit is for
 * subscribers doing real work (satellite propagation, decision-deck
 * recomputes) where 60 Hz would burn CPU for no perceptible gain.
 *
 * Range is a moving asymmetric window around real-now (−1d / +14d),
 * recomputed each tick so the cursor's relative position stays
 * meaningful as wall time advances. The console is predictions-first,
 * hence the long forward horizon. Replay auto-pauses when it walks
 * past the +14d edge (per design: noticeable beats wrap-around).
 */

// Asymmetric window: −7 days of past observations / +14 days of forecast.
// The past window is wide enough to cover the Earth-page replay slider's
// −1w drag (it shares this bus); the long forward horizon stays because
// Operations is a predictions-first console and the Earth page now also
// scrubs forecast-grid frames forward.
const PAST_MS     = 7 * 24 * 60 * 60 * 1000;
const FUTURE_MS   = 14 * 24 * 60 * 60 * 1000;
const RANGE_MS    = PAST_MS + FUTURE_MS;
const EMIT_HZ     = 10;
const EMIT_PERIOD = 1000 / EMIT_HZ;
// 60× added so the Earth-page time-controls (which expose 1×/60×/600×/3600×)
// can drive the bus without a custom mapping. 10× and 100× stay for the
// Operations console's finer steppers.
const SPEEDS      = Object.freeze([1, 10, 60, 100, 600, 3600]);

const state = {
    mode:       'live',
    simTimeMs:  Date.now(),
    speed:      1,
    paused:     false,
    rangeMs:    { start: 0, end: 0 },
    anchorWall: 0,
    anchorSim:  0,
};

const subscribers = new Set();
let rafId    = null;
let lastEmit = 0;
let started  = false;

function recomputeRange() {
    const now = Date.now();
    state.rangeMs.start = now - PAST_MS;
    state.rangeMs.end   = now + FUTURE_MS;
}

// Seed the range so subscribers that mount before start() (the normal
// order in operations.html) get a sensible initial snapshot — otherwise
// the cursor's percent-of-range math goes to ±∞ on first paint.
recomputeRange();

function clamp(ms) {
    return Math.max(state.rangeMs.start, Math.min(state.rangeMs.end, ms));
}

function setAnchors() {
    state.anchorWall = performance.now();
    state.anchorSim  = state.simTimeMs;
}

function snapshot() {
    return {
        mode:      state.mode,
        simTimeMs: state.simTimeMs,
        speed:     state.speed,
        paused:    state.paused,
        rangeMs:   { start: state.rangeMs.start, end: state.rangeMs.end },
        nowMs:     Date.now(),
    };
}

function emit(force = false) {
    const wall = performance.now();
    if (!force && (wall - lastEmit) < EMIT_PERIOD) return;
    lastEmit = wall;
    const snap = snapshot();
    for (const fn of subscribers) {
        try { fn(snap); }
        catch (err) { console.warn('[timeBus] subscriber threw', err); }
    }
}

function tick() {
    recomputeRange();

    if (state.mode === 'live') {
        state.simTimeMs = Date.now();
    } else if (state.mode === 'replay' && !state.paused) {
        const wall     = performance.now();
        const advanced = state.anchorSim + (wall - state.anchorWall) * state.speed;
        if (advanced >= state.rangeMs.end) {
            state.simTimeMs  = state.rangeMs.end;
            state.paused     = true;
            setAnchors();
            emit(true);
        } else if (advanced <= state.rangeMs.start) {
            state.simTimeMs  = state.rangeMs.start;
            state.paused     = true;
            setAnchors();
            emit(true);
        } else {
            state.simTimeMs = advanced;
        }
    }
    // 'scrub' / paused replay: simTimeMs is whatever was last set.

    emit();
    rafId = requestAnimationFrame(tick);
}

export const timeBus = {
    /** Kick the rAF loop. Idempotent. */
    start() {
        if (started) return;
        recomputeRange();
        setAnchors();
        started = true;
        rafId = requestAnimationFrame(tick);
        emit(true);
    },

    /** Halt the rAF loop. Subscribers stay registered. */
    stop() {
        if (rafId !== null) cancelAnimationFrame(rafId);
        rafId   = null;
        started = false;
    },

    /** Sync read of the current state. Cheap; copy-on-read. */
    getState: snapshot,

    /**
     * Subscribe to state snapshots. Fires immediately with the current
     * state so subscribers can paint without waiting for the next emit.
     * Returns an unsubscribe function.
     */
    subscribe(fn) {
        subscribers.add(fn);
        try { fn(snapshot()); } catch (_) {}
        return () => { subscribers.delete(fn); };
    },

    setMode(mode) {
        if (mode !== 'live' && mode !== 'scrub' && mode !== 'replay') return;
        if (state.mode === mode) return;
        state.mode = mode;
        if (mode === 'live')   state.paused = false;
        if (mode === 'replay') state.paused = false;
        setAnchors();
        emit(true);
    },

    /**
     * Jump simTimeMs.
     *
     *   { fromUser: true }    — drag/arrow input. If we're in Live, flip
     *                           to Scrub so the bus doesn't yank the
     *                           cursor back on the next tick.
     *   { mode: 'scrub' }     — atomically switch mode at the same time
     *                           (used by step 5 permalinks so the bus
     *                           arrives in a frozen state without a
     *                           Live → Scrub flicker).
     */
    setSimTime(ms, opts = {}) {
        recomputeRange();
        state.simTimeMs = clamp(Number(ms));
        if (opts.mode && opts.mode !== state.mode) {
            state.mode = opts.mode;
            if (state.mode === 'replay') state.paused = false;
        } else if (state.mode === 'live' && opts.fromUser) {
            state.mode = 'scrub';
        }
        setAnchors();
        emit(true);
    },

    setSpeed(speed) {
        if (!SPEEDS.includes(speed)) return;
        state.speed = speed;
        setAnchors();   // re-anchor so the cursor doesn't jump on speed flip
        emit(true);
    },

    /** Toggle play/pause; from non-replay modes, enters replay playing. */
    togglePlay() {
        if (state.mode !== 'replay') {
            state.mode   = 'replay';
            state.paused = false;
            setAnchors();
            emit(true);
            return;
        }
        state.paused = !state.paused;
        setAnchors();
        emit(true);
    },

    /** Step ±N ms relative to the current simTimeMs. */
    step(deltaMs) {
        this.setSimTime(state.simTimeMs + Number(deltaMs || 0), { fromUser: true });
    },

    SPEEDS,
    RANGE_MS,
    PAST_MS,
    FUTURE_MS,
};
