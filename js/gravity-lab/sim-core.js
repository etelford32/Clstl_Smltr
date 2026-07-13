/**
 * sim-core.js — pure simulation core for the Gravity Lab.
 *
 * Owns per-frame stepping, the wall-clock physics budget, sim-time debt
 * accounting, and the warp throttle. Deliberately free of THREE, DOM, and
 * ambient time (the clock is injected) so it can run unchanged on the main
 * thread, inside a Web Worker (P0.5), and under the Node test harness.
 *
 * Budget model (P0.1, fixes D1 — the unbounded substep loop):
 *   Each frame the caller requests `dtReal × warp` seconds of simulated
 *   time. The requested time is divided into equal Yoshida-4 substeps of
 *   at most `targetStep` seconds — but the loop stops when the wall-clock
 *   budget is spent. The shortfall is carried as `debtSec` into subsequent
 *   frames. Sim time is never skipped: every simulated second is
 *   integrated. If the debt keeps growing for more than THROTTLE_AFTER_MS,
 *   the sustainable rate becomes a warp cap (`warpCap`) and the readout
 *   goes amber — the honest alternative to freezing the tab or silently
 *   teleporting the trajectory.
 *
 *   The cap recovers by probing upward a few percent per frame whenever a
 *   frame completes inside budget, so transient stalls (GC, tab switch,
 *   busy render) don't permanently degrade the warp.
 */

import { yoshida4Step } from './physics.js';

export const PHYSICS_BUDGET_MS_DESKTOP = 6;
export const PHYSICS_BUDGET_MS_MOBILE  = 4;

const THROTTLE_AFTER_MS  = 2000;  // sustained over-budget time before capping
const BUDGET_CHECK_EVERY = 16;    // substeps between wall-clock reads
const CAP_SAFETY         = 0.9;   // cap at 90% of the measured sustainable rate
const CAP_RECOVERY       = 1.02;  // per-in-budget-frame upward probe

/**
 * Create a simulation-core state object.
 * `bodies` is the live array the integrator mutates ({m, r, v, name, …}).
 */
export function createSim({ bodies, targetStep, j2Opts = null, j2Enabled = false }) {
    return {
        bodies,
        targetStep,
        j2Opts,
        j2Enabled,
        elapsedSec: 0,        // signed simulated seconds since epoch
        debtSec: 0,           // requested-but-not-yet-integrated sim time (signed)
        warpCap: Infinity,    // sustainable warp estimate; Infinity = uncapped
        throttled: false,
        _overBudgetSinceMs: null,
    };
}

/**
 * Advance the simulation by one frame's worth of physics, bounded by the
 * wall-clock budget.
 *
 * @param {object} sim        From createSim().
 * @param {object} frame      { dtRealSec, warp, direction, budgetMs }
 * @param {function} [nowMs]  Clock injection (defaults to performance.now).
 * @param {function} [onStep] Optional per-substep hook: onStep(bodies, subDt)
 *                            invoked after every completed substep (used by
 *                            sim-time trail sampling).
 * @returns {{advancedSec, stepsDone, stepsWanted, effWarp, throttled}}
 */
export function advanceFrame(sim, frame, nowMs, onStep) {
    const now = nowMs || (() => performance.now());
    const { dtRealSec, warp, direction, budgetMs } = frame;

    const effWarp = Math.min(warp, sim.warpCap);
    const requested = dtRealSec * effWarp * direction;
    const total = sim.debtSec + requested;

    const stepsWanted = Math.max(1, Math.ceil(Math.abs(total) / sim.targetStep));
    const sub = total / stepsWanted;
    const opts = (sim.j2Enabled && sim.j2Opts) ? { J2: sim.j2Opts } : undefined;

    const deadline = now() + budgetMs;
    let stepsDone = 0;
    if (total !== 0) {
        for (let k = 0; k < stepsWanted; k++) {
            yoshida4Step(sim.bodies, sub, opts);
            stepsDone++;
            if (onStep) onStep(sim.bodies, sub);
            if ((stepsDone % BUDGET_CHECK_EVERY === 0) && now() > deadline) break;
        }
    }

    const advancedSec = sub * stepsDone;
    sim.debtSec = total - advancedSec;
    sim.elapsedSec += advancedSec;

    // ── Throttle bookkeeping ────────────────────────────────────────────
    const t = now();
    if (stepsDone < stepsWanted) {
        // Budget exhausted this frame — debt is growing.
        if (sim._overBudgetSinceMs === null) sim._overBudgetSinceMs = t;
        if (t - sim._overBudgetSinceMs > THROTTLE_AFTER_MS) {
            // Cap at the rate we actually sustained this frame. Forgive the
            // outstanding debt: the cap redefines the request — the
            // trajectory stays continuous, we just advance it slower.
            const sustained = Math.abs(advancedSec) / Math.max(dtRealSec, 1e-6);
            sim.warpCap = Math.max(1, sustained * CAP_SAFETY);
            sim.throttled = true;
            sim.debtSec = 0;
            sim._overBudgetSinceMs = t;   // re-arm so the cap keeps adapting
        }
    } else {
        sim._overBudgetSinceMs = null;
        if (sim.throttled) {
            // Probe upward; once the cap clears the requested warp the
            // throttle disengages entirely.
            sim.warpCap *= CAP_RECOVERY;
            if (sim.warpCap >= warp) {
                sim.warpCap = Infinity;
                sim.throttled = false;
            }
        }
    }

    return {
        advancedSec,
        stepsDone,
        stepsWanted,
        effWarp,
        throttled: sim.throttled,
    };
}

/** Zero the sim-time debt (call on direction flip / warp edits / reloads). */
export function clearDebt(sim) {
    sim.debtSec = 0;
    sim._overBudgetSinceMs = null;
}
