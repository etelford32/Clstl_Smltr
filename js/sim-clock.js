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
        this.wraps = 0;   // bumped on every wrap AND setTau — subscribers use
                          // it to reset per-sweep bookkeeping (arrival flashes)
        this.setTau(opts.tau ?? TAU_DEFAULT);
    }

    get tau() { return this._tau; }

    /** UI label, e.g. "×300". */
    get label() { return `×${this._tau}`; }

    /** Change τ and restart the sweep from the wall present. */
    setTau(tau) {
        const t = Number.isFinite(tau) ? Math.max(1, tau) : 1;
        const wall = this._timeSource();
        this._tau = t;
        this._anchorWall = wall;
        this._anchorSim = wall;
        this.wraps++;
    }

    /**
     * Absolute simulation time (ms). Evaluate EVERY FRAME — positions are
     * f(simTime), never cached at data-fetch time (that was the freeze bug).
     */
    now(wall = this._timeSource()) {
        let sim = this._anchorSim + (wall - this._anchorWall) * this._tau;
        if (this._tau > 1 && sim > wall + this._windowMs) {
            this._anchorWall = wall;
            this._anchorSim = wall;
            this.wraps++;
            sim = wall;
        }
        return sim;
    }

    /** Wall-time delta (ms) → simulation delta (ms), for integrators. */
    dSim(dtWallMs) {
        return (Number.isFinite(dtWallMs) ? dtWallMs : 0) * this._tau;
    }
}
