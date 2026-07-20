/**
 * sim-clock.js — the ONE simulation clock for the Ring Current twin
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Pure functions + one tiny class: no DOM, no THREE, no fetch.
 * tests/sim-clock.mjs runs this exact module under node — keep it
 * dependency-free.
 *
 * ── Guiding invariant (RING_CURRENT_VISUAL_PLAN.md) ─────────────────────────
 * Every particle population stores a TRUE physical velocity in km/s. The
 * scene applies a single global time-compression factor τ:
 *
 *   apparent screen speed = physical velocity × τ ÷ local spatial scale
 *
 * No population is ever animated at a "looks nice" speed. If something needs
 * to look more alive we change rendering cues (pulses, trails, flashes) —
 * never the velocity. The old failure mode this kills: the incoming L1
 * stream pinned to wall-clock (visually frozen) while the ring drifted at an
 * arbitrary aesthetic rate — two populations on two incompatible clocks.
 *
 * ── Clock semantics ─────────────────────────────────────────────────────────
 * simTime = anchorSim + (wall − anchorWall) · τ
 *
 *   τ = 1     REAL mode. simTime ≡ wall time exactly, never wraps. Parcels
 *             crawl at true speed — stillness reads as integrity, not a bug.
 *   τ > 1     COMPRESSED. simTime runs ahead of wall time, sweeping the
 *             genuine L1 forecast window (the not-yet-arrived parcels) as a
 *             fast-forward. When the sweep passes the window end it wraps
 *             back to the live present and replays with the latest data —
 *             an honest repeating fast-forward of the actual next ~hour,
 *             never a synthetic loop.
 *
 * setTau() re-anchors simTime to the wall present (the sweep restarts from
 * "now"), so Real mode is always exactly real and speed changes are legible.
 *
 * ── Transport (pause / scrub / reset) ───────────────────────────────────────
 * pause() freezes simTime; dSim() returns 0 so integrators hold still.
 * resume() continues from the frozen instant — while paused, the frozen
 * moment honestly falls behind the advancing wall clock (offsetMs() goes
 * negative), which is what pausing a live-data twin means. setOffset(ms)
 * scrubs simTime to wall-now + ms within [0, windowMs] — the same forecast
 * window the τ>1 sweep covers — and bumps `wraps` so subscribers reset
 * per-sweep bookkeeping instead of firing every skipped arrival as one
 * burst. reset() drops the pause and any offset: back to the live present.
 *
 * ── Spatial scale registry ──────────────────────────────────────────────────
 * The scene is spatially dishonest by necessity — the L1→Earth leg is far
 * more compressed than the near-Earth region. SCALE makes that explicit:
 * each particle system converts km/s → scene units/s through ITS OWN
 * region's kmPerUnit, so one τ works everywhere and the compression enters
 * the mapping openly instead of being smuggled in as two animation speeds.
 */

import { PHYS } from './ring-current-model.js';

/** τ presets exposed in the UI. ×1 is a credibility feature — keep it. */
export const TAU_PRESETS = Object.freeze([1, 60, 300, 1000]);
export const TAU_DEFAULT = 300;

// Scene unit = 1 R_E near Earth (honest, linear). The Sun corridor squeezes
// the remaining L1 distance into (X_SUN − X_MP) scene units.
const CORRIDOR_X_MP  = 11;   // corridor end ≈ subsolar magnetopause (R_E)
const CORRIDOR_X_SUN = 52;   // corridor start, toward the Sun sprite
const CORRIDOR_REAL_KM = PHYS.L1_KM - CORRIDOR_X_MP * (PHYS.R_E_M / 1000);

export const SCALE = Object.freeze({
    /** Inside ~8 R_E: 1 scene unit = 1 R_E. Linear, uncompressed. */
    NEAR_EARTH: Object.freeze({ kmPerUnit: PHYS.R_E_M / 1000 }),
    /** Heliospheric leg (L1 → magnetopause), compressed ≈5.5× vs near-Earth. */
    CORRIDOR: Object.freeze({
        X_MP:      CORRIDOR_X_MP,
        X_SUN:     CORRIDOR_X_SUN,
        SPAN:      CORRIDOR_X_SUN - CORRIDOR_X_MP,
        kmPerUnit: CORRIDOR_REAL_KM / (CORRIDOR_X_SUN - CORRIDOR_X_MP),
    }),
    /** Ring-current descent camera (Track C, js/ionosphere-descent.js):
     *  below ~3 R_E camera distance the ATMOSPHERE's radial axis renders
     *  with a DISCLOSED vertical exaggeration tweening 1 → maxFactor —
     *  kmPerUnit here is the fully engaged vertical scale; the page HUD
     *  discloses the live factor while it tweens. Rendering-only: no
     *  physics state ever sees it (horizontal scale stays NEAR_EARTH). */
    ATMOSPHERE_VERTICAL: Object.freeze({
        maxFactor: 18,
        kmPerUnit: (PHYS.R_E_M / 1000) / 18,
    }),
});

/**
 * The invariant, as a function: physical km/s → apparent scene units/s.
 * (units/s, not px/s — px follows from the camera, but ratios are preserved.)
 */
export function apparentUnitsPerSec(vKmS, kmPerUnit, tau) {
    if (!Number.isFinite(vKmS) || !Number.isFinite(kmPerUnit) || kmPerUnit <= 0) return 0;
    return (vKmS * Math.max(1, tau)) / kmPerUnit;
}

/** Real-minutes ETA → seconds of viewing at compression τ ("~5 s at ×300"). */
export function simSecondsForRealMinutes(realMinutes, tau) {
    if (!Number.isFinite(realMinutes)) return null;
    return (realMinutes * 60) / Math.max(1, tau);
}

export class SimClock {
    /**
     * @param {object} [opts]
     * @param {number} [opts.tau=300]       time-compression factor (≥ 1)
     * @param {number} [opts.windowMs]      forecast sweep length before wrap
     *                                      (default 75 min — the corridor's
     *                                      full lead-time span)
     * @param {() => number} [opts.timeSource]  injectable wall clock (tests)
     */
    constructor(opts = {}) {
        this._timeSource = opts.timeSource ?? (() => Date.now());
        this._windowMs = Number.isFinite(opts.windowMs) ? opts.windowMs : 75 * 60_000;
        this._tau = 1;
        this._paused = false;
        this._pausedSim = 0;
        this.wraps = 0;   // bumped on every wrap AND setTau/setOffset —
                          // subscribers use it to reset per-sweep
                          // bookkeeping (arrival flashes)
        this.setTau(opts.tau ?? TAU_DEFAULT);
    }

    get tau() { return this._tau; }

    get paused() { return this._paused; }

    /** UI label, e.g. "×300". */
    get label() { return `×${this._tau}`; }

    /** Sweep window length (ms) — the page shows live sweep progress so
     *  the wrap reads as "replaying the same real window", not a glitch. */
    get windowMs() { return this._windowMs; }

    /** Change τ and restart the sweep from the wall present. A paused clock
     *  stays paused, re-anchored to the present (speed changes are legible). */
    setTau(tau) {
        const t = Number.isFinite(tau) ? Math.max(1, tau) : 1;
        const wall = this._timeSource();
        this._tau = t;
        this._anchorWall = wall;
        this._anchorSim = wall;
        if (this._paused) this._pausedSim = wall;
        this.wraps++;
    }

    /** Freeze simTime at its current value. Idempotent. */
    pause() {
        if (this._paused) return;
        this._pausedSim = this.now();   // via now() so a pending wrap resolves
        this._paused = true;
    }

    /** Continue from the frozen instant. Idempotent. Does NOT bump wraps —
     *  sim time is continuous through a pause, nothing needs resetting. */
    resume() {
        if (!this._paused) return;
        this._anchorWall = this._timeSource();
        this._anchorSim = this._pausedSim;
        this._paused = false;
    }

    /**
     * Scrub: place simTime at wall-now + offsetMs, clamped to the sweep
     * window [0, windowMs]. Works paused or playing; bumps `wraps` so
     * subscribers treat the jump like a sweep restart (no arrival bursts).
     * @returns {number} the applied (clamped) offset in ms
     */
    setOffset(offsetMs) {
        const off = Math.max(0, Math.min(this._windowMs,
            Number.isFinite(offsetMs) ? offsetMs : 0));
        const wall = this._timeSource();
        this._anchorWall = wall;
        this._anchorSim = wall + off;
        if (this._paused) this._pausedSim = wall + off;
        this.wraps++;
        return off;
    }

    /** simTime − wall (ms). Positive = ahead of live (forecast window);
     *  negative only after a pause let live time move on. */
    offsetMs(wall = this._timeSource()) {
        return this.now(wall) - wall;
    }

    /** Back to the live present: drop any pause and any scrub offset.
     *  τ is kept — reset is a time action, not a speed action. */
    reset() {
        this._paused = false;
        this.setTau(this._tau);
    }

    /**
     * Absolute simulation time (ms). Evaluate EVERY FRAME — positions are
     * f(simTime), never cached at data-fetch time (that was the freeze bug).
     */
    now(wall = this._timeSource()) {
        if (this._paused) return this._pausedSim;
        let sim = this._anchorSim + (wall - this._anchorWall) * this._tau;
        if (this._tau > 1 && sim > wall + this._windowMs) {
            this._anchorWall = wall;
            this._anchorSim = wall;
            this.wraps++;
            sim = wall;
        }
        return sim;
    }

    /** Wall-time delta (ms) → simulation delta (ms), for integrators.
     *  0 while paused — integrators hold still with the clock. */
    dSim(dtWallMs) {
        if (this._paused) return 0;
        return (Number.isFinite(dtWallMs) ? dtWallMs : 0) * this._tau;
    }
}
