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

import {
    yoshida4Step, yoshida4StepVar, rkf78Step,
    totalEnergy, totalJ2PotentialEnergy, G_SI,
    createVariational, variationalStep,
} from './physics.js';
import { writeBodies, readBodies } from './wasm/kernel.js';

export const PHYSICS_BUDGET_MS_DESKTOP = 6;
export const PHYSICS_BUDGET_MS_MOBILE  = 4;

const THROTTLE_AFTER_MS  = 2000;  // sustained over-budget time before capping
const BUDGET_CHECK_EVERY = 16;    // substeps between wall-clock reads
const CAP_SAFETY         = 0.9;   // cap at 90% of the measured sustainable rate
const CAP_RECOVERY       = 1.02;  // per-in-budget-frame upward probe

// Blow-up guard + checkpoint ring (P0.2, fixes D2 part 1).
const FAULT_ENERGY_REL   = 1e-3;  // |ΔE| beyond this fraction of the energy scale
const CKPT_CAPACITY      = 120;   // ~1 minute of history at one per 0.5 s
const CKPT_INTERVAL_MS   = 500;   // wall-clock spacing between checkpoints

// Hybrid close-encounter stepping (P0.4, fixes D2 part 2).
//
// Detection is per-pair, with different physics for the two pair classes:
//
//  A. TRUE satellite-satellite pairs — neither body is the primary and
//     BOTH are light (m ≤ HILL_MASS_MAX × m_primary; the Hill sphere is
//     only meaningful for m ≪ M — a stellar companion at 55% of the
//     primary's mass has R_Hill ≈ its whole orbit and would trigger
//     permanently, as Algol Ab demonstrated):
//     1. MERCURIUS-style Hill criterion (the plan's scheme):
//        d ≤ K · max(R_Hill) with R_Hill,i = d_i0 · (m_i/3 m_0)^(1/3), K = 3.
//     2. Pair-resolution backstop: τ_pair = sqrt(d³/G(m_i+m_j)) <
//        RESOLVE · targetStep — covers comparable-mass light pairs.
//
//  B. Pairs involving the primary OR a heavy secondary (Charon at 12% of
//     Pluto, the Algol stars). Hill radii are undefined here, and a bare
//     timescale test misclassifies REGULAR tight orbits (Mimas runs at
//     ~11 substeps per radian and is perfectly healthy — bounded
//     symplectic oscillation). What actually kills fixed-dt is a plunge,
//     so the criteria are:
//     1. Closing-time: the pair could close its separation within
//        CLOSE_STEPS substeps (d < |ṙ| · CLOSE_STEPS · dt while
//        approaching). Zero for circular orbits (ṙ ≈ e·v), large during
//        infall — and symmetric on the way out, so the outgoing leg stays
//        adaptive until the fixed step is comfortable again.
//     2. Hard τ backstop: τ_pair < TAU_HARD · targetStep — catches
//        tangential flybys whose radial rate crosses zero at pericenter.
//
// Exit applies 1.5× hysteresis to every threshold. Margins at defaults
// (harness-enforced): all six curated systems stay symplectic — tightest
// are Mimas (τ backstop margin ~2.7×, closing margin ~7×) and
// Pluto–Charon (τ margin ~12×).
const ENC_HILL_K      = 3;
const ENC_HILL_MASS_MAX = 0.05; // Hill only when m ≤ this fraction of primary
const ENC_RESOLVE     = 16;    // substeps per τ, satellite-satellite backstop
const ENC_CLOSE_STEPS = 48;    // class-B pairs: time-to-close window
const ENC_TAU_HARD    = 4;     // class-B pairs: hard under-resolution limit
const ENC_EXIT_FACTOR = 1.5;
const ADAPTIVE_TOL    = 1e-12; // per-step relative tolerance for RKF7(8)

/**
 * Create a simulation-core state object.
 * `bodies` is the live array the integrator mutates ({m, r, v, name, …}).
 */
export function createSim({ bodies, targetStep, j2Opts = null, j2Enabled = false, hybrid = true, softening = 0, kernel = null }) {
    const sim = {
        bodies,
        targetStep,
        j2Opts,
        j2Enabled,
        // Plummer softening ε² (m²). Sandbox-only; 0 for curated systems.
        soft2: softening * softening,
        elapsedSec: 0,        // signed simulated seconds since epoch
        debtSec: 0,           // requested-but-not-yet-integrated sim time (signed)
        warpCap: Infinity,    // sustainable warp estimate; Infinity = uncapped
        throttled: false,
        _overBudgetSinceMs: null,
        // Conserved-quantity baseline for the fault guard (and the HUD).
        energy0: 0,
        energyScale: 1,       // fault-guard denominator; robust when E₀ ≈ 0
        // Checkpoint ring: fixed-capacity circular buffer of full states.
        ckpt: { ring: new Array(CKPT_CAPACITY), head: -1, count: 0 },
        _lastCkptMs: null,
        // Sim-time trail sampling (P0.3) — configured via configureTrails().
        trails: null,
        // Massless test particles (P3.2) — configureParticles(). NOT part
        // of checkpoints: a rewind restores the massive bodies only (the
        // cloud is 20k×6 doubles; Reset regenerates it deterministically).
        particles: null,
        // WASM kernel (P3.1) — null runs the JS reference implementation.
        // Same physics either way; the harness parity-gates them at 1e-12.
        kernel,
        // MEGNO chaos indicator (P2.3) — null when off; see enableMegno().
        megno: null,
        // Hybrid stepping state (P0.4).
        hybridEnabled: hybrid,    // false = strict fixed-dt (tests, A/B runs)
        integrator: 'yoshida4',   // 'yoshida4' | 'rkf78'
        encounter: null,          // {bodyA, bodyB, separationM} while adaptive
        hAdaptive: null,          // persisted RK step size across frames
        rkCtrl: { errPrev: 1 },   // PI-controller memory
        _primaryIdx: 0,
        _stepFail: false,
        // Per-pair squared threshold radii, refreshed once per frame so the
        // per-substep encounter scan is multiply-compare only (no sqrt).
        _encPairI: null,
        _encPairJ: null,
        _encR2Enter: null,
        _encR2Exit: null,
    };
    let mMax = -Infinity;
    for (let i = 0; i < bodies.length; i++) {
        if (bodies[i].m > mMax) { mMax = bodies[i].m; sim._primaryIdx = i; }
    }
    const nPairs = bodies.length * (bodies.length - 1) / 2;
    sim._encPairI = new Int16Array(nPairs);
    sim._encPairJ = new Int16Array(nPairs);
    // Pair class: 1 = closing-time regime (involves the primary or any
    // body heavier than ENC_HILL_MASS_MAX of it); 0 = Hill-eligible.
    sim._encClassB = new Uint8Array(nPairs);
    sim._encR2Enter = new Float64Array(nPairs);
    sim._encR2Exit  = new Float64Array(nPairs);
    const mPrim = bodies[sim._primaryIdx].m;
    let p = 0;
    for (let i = 0; i < bodies.length; i++) {
        for (let j = i + 1; j < bodies.length; j++) {
            sim._encPairI[p] = i;
            sim._encPairJ[p] = j;
            sim._encClassB[p] = (
                i === sim._primaryIdx || j === sim._primaryIdx ||
                bodies[i].m > ENC_HILL_MASS_MAX * mPrim ||
                bodies[j].m > ENC_HILL_MASS_MAX * mPrim
            ) ? 1 : 0;
            p++;
        }
    }
    rebaselineEnergy(sim);
    _recordCheckpoint(sim);   // slot 0 = the initial state, always rewindable
    return sim;
}

/** Total energy including the J2 potential when the perturbation is active. */
export function currentEnergy(sim) {
    let E = totalEnergy(sim.bodies, sim.soft2).total;
    if (sim.j2Enabled && sim.j2Opts) {
        E += totalJ2PotentialEnergy(sim.bodies, sim.j2Opts);
    }
    return E;
}

/**
 * Re-anchor the conserved-quantity baseline (system load, J2 toggle,
 * sandbox edits). The guard denominator uses max(|E₀|, KE) so a sandbox
 * config with E₀ ≈ 0 (parabolic) cannot divide by zero or false-trip.
 */
export function rebaselineEnergy(sim) {
    const { KE, total } = totalEnergy(sim.bodies, sim.soft2);
    let E = total;
    if (sim.j2Enabled && sim.j2Opts) {
        E += totalJ2PotentialEnergy(sim.bodies, sim.j2Opts);
    }
    sim.energy0 = E;
    sim.energyScale = Math.max(Math.abs(E), KE, 1e-30);
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
    const useJ2 = sim.j2Enabled && sim.j2Opts;
    const opts = (useJ2 || sim.soft2)
        ? { J2: useJ2 ? sim.j2Opts : null, soft2: sim.soft2 }
        : undefined;

    const deadline = now() + budgetMs;
    let stepsDone = 0;
    let advancedSec = 0;
    if (total !== 0) {
        const hybrid = sim.hybridEnabled;
        if (hybrid) _refreshEncounterRadii(sim);

        if (sim.integrator === 'yoshida4') {
            const absSub = Math.abs(sub);
            for (let k = 0; k < stepsWanted; k++) {
                // With MEGNO on, step bodies + tangent vector through the
                // integrator's exact tangent map (see yoshida4StepVar) —
                // JS-only: the tangent map interleaves with the composition.
                if (sim.megno) {
                    if (sim.particles) _particlesPre(sim);
                    yoshida4StepVar(sim.bodies, sub, opts, sim.megno.vs);
                    if (sim.particles) _particlesPost(sim, sub);
                    _megnoAccumulate(sim, absSub);
                } else if (sim.kernel) {
                    // WASM kernel path (P3.1): copy in, step, copy out —
                    // ~1 µs round-trip for N ≤ 16, and trails/encounter
                    // scans below read sim.bodies as usual. Any resident
                    // particle cloud (P3.2) KDKs inside the same call, so
                    // no pre/post bracketing here.
                    writeBodies(sim.kernel, sim.bodies);
                    sim.kernel.stepSystem(sim.bodies.length,
                        sim.particles ? sim.particles.n : 0, 1, sub,
                        sim.soft2, opts ? opts.J2 : null);
                    readBodies(sim.kernel, sim.bodies);
                } else {
                    if (sim.particles) _particlesPre(sim);
                    yoshida4Step(sim.bodies, sub, opts);
                    if (sim.particles) _particlesPost(sim, sub);
                }
                stepsDone++;
                advancedSec += sub;
                // Sim-time trail sampling (P0.3) happens INSIDE the substep
                // loop so high warp produces the same trail geometry as low
                // warp — sampling density is a function of simulated time,
                // never of frame rate.
                if (sim.trails) _sampleTrails(sim, absSub);
                if (onStep) onStep(sim.bodies, sub);
                // Encounter entry scan runs EVERY substep: at high warp a
                // pair can close faster than any coarser cadence — checking
                // only every N steps can jump clean past the entry window.
                // The scan is multiply-compare per pair (radii precomputed
                // above), so its cost is a few % of the force pass.
                if (hybrid && _scanEncounterEnter(sim) >= 0) {
                    _enterAdaptive(sim);
                    break;   // remainder of the frame becomes debt; next
                             // frame (or the block below) continues adaptive
                }
                if ((stepsDone % BUDGET_CHECK_EVERY === 0) && now() > deadline) break;
            }
        }

        if (sim.integrator === 'rkf78') {
            // Close-encounter regime: adaptive RKF7(8) with PI control.
            // NOT symplectic — energy drift accrued here is expected and is
            // reported honestly against the original E₀ (never re-baselined).
            const rkOpts = { J2: opts ? opts.J2 : null, soft2: sim.soft2, ctrl: sim.rkCtrl };
            let remaining = total - advancedSec;
            let h = sim.hAdaptive;
            if (!h || (h < 0) !== (remaining < 0)) h = remaining / 8;
            while (Math.abs(remaining) > 1e-9) {
                const sgn = remaining < 0 ? -1 : 1;
                const hTry = sgn * Math.min(Math.abs(h), Math.abs(remaining), sim.targetStep);
                if (sim.particles) _particlesPre(sim);
                const r = rkf78Step(sim.bodies, hTry, ADAPTIVE_TOL, rkOpts);
                if (r.h === 0) { sim._stepFail = true; break; }
                // The cloud rides the ACCEPTED step size r.h (which may be
                // shorter than hTry); a rejected step leaves it untouched.
                if (sim.particles) _particlesPost(sim, r.h);
                stepsDone++;
                advancedSec += r.h;
                remaining = total - advancedSec;
                h = r.hNext;
                // Along adaptive segments the tangent rides a leapfrog
                // approximation (no discrete tangent map for RK here).
                if (sim.megno) {
                    variationalStep(sim.bodies, r.h, rkOpts, sim.megno.vs);
                    _megnoAccumulate(sim, Math.abs(r.h));
                }
                if (sim.trails) _sampleTrails(sim, Math.abs(r.h));
                if (onStep) onStep(sim.bodies, r.h);
                if (_scanEncounterExit(sim)) {
                    _exitAdaptive(sim);
                    break;   // remainder becomes debt; next frame is symplectic
                }
                if (now() > deadline) break;
            }
            sim.hAdaptive = h;
        }
    }

    sim.debtSec = total - advancedSec;
    sim.elapsedSec += advancedSec;

    // ── Throttle bookkeeping ────────────────────────────────────────────
    const t = now();
    const frameShort = Math.abs(sim.debtSec) > 1e-9 * Math.max(1, Math.abs(total));
    if (frameShort) {
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

    // ── Blow-up guard (P0.2) ────────────────────────────────────────────
    // Scan AFTER the frame's stepping: a NaN cannot heal and an energy
    // spike from an unresolved encounter does not self-cancel, so
    // per-frame granularity is enough — and it keeps the guard out of the
    // hot substep loop.
    let fault = null;
    if (stepsDone > 0 || sim._stepFail) {
        const kind = sim._stepFail ? 'unresolvable' : _guardKind(sim);
        sim._stepFail = false;
        if (kind) {
            const pair = _closestPair(sim.bodies);
            const atElapsedSec = sim.elapsedSec;
            // _restoreSlot also resets the integrator to symplectic so the
            // restored state re-detects encounters cleanly on resume.
            const cp = _restoreNewestCheckpoint(sim);
            fault = {
                kind,        // 'nonfinite' | 'energy' | 'unresolvable'
                bodyA: pair.a, bodyB: pair.b,
                separationM: pair.d,
                atElapsedSec,
                rewoundSec: atElapsedSec - sim.elapsedSec,
                checkpointElapsedSec: cp.t,
            };
        } else if (sim._lastCkptMs === null || t - sim._lastCkptMs >= CKPT_INTERVAL_MS) {
            _recordCheckpoint(sim);
            sim._lastCkptMs = t;
        }
    }

    return {
        advancedSec,
        stepsDone,
        stepsWanted,
        effWarp,
        throttled: sim.throttled,
        integrator: sim.integrator,
        encounter: sim.encounter,
        fault,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Close-encounter detection (P0.4) — see the criteria discussion at the
// ENC_* constants above.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Precompute, once per frame, each pair's squared distance thresholds so
 * the per-substep scans stay cheap. For satellite-satellite pairs the
 * threshold combines the Hill criterion (from the bodies' CURRENT
 * distances to the primary — slowly varying, safe to freeze per frame)
 * with the τ-resolution radius d = (τ²·G(mᵢ+mⱼ))^(1/3). For primary
 * pairs it is the hard-τ backstop radius; the closing-time criterion is
 * velocity-dependent and evaluated live in the scans.
 */
function _refreshEncounterRadii(sim) {
    const bodies = sim.bodies;
    const p = sim._primaryIdx;
    const rp = bodies[p].r;
    const mp = bodies[p].m;
    const nPairs = sim._encPairI.length;
    for (let k = 0; k < nPairs; k++) {
        const i = sim._encPairI[k], j = sim._encPairJ[k];
        const bi = bodies[i], bj = bodies[j];
        const gm = G_SI * (bi.m + bj.m);
        let rEnter, rExit;
        if (sim._encClassB[k]) {
            const tauEnter = ENC_TAU_HARD * sim.targetStep;
            const tauExit  = tauEnter * ENC_EXIT_FACTOR;
            rEnter = Math.cbrt(tauEnter * tauEnter * gm);
            rExit  = Math.cbrt(tauExit  * tauExit  * gm);
        } else {
            const tauEnter = ENC_RESOLVE * sim.targetStep;
            const tauExit  = tauEnter * ENC_EXIT_FACTOR;
            rEnter = Math.cbrt(tauEnter * tauEnter * gm);
            rExit  = Math.cbrt(tauExit  * tauExit  * gm);
            const di = Math.hypot(bi.r[0]-rp[0], bi.r[1]-rp[1], bi.r[2]-rp[2]);
            const dj = Math.hypot(bj.r[0]-rp[0], bj.r[1]-rp[1], bj.r[2]-rp[2]);
            const rHill = Math.max(
                di * Math.cbrt(bi.m / (3 * mp)),
                dj * Math.cbrt(bj.m / (3 * mp)));
            rEnter = Math.max(rEnter, ENC_HILL_K * rHill);
            rExit  = Math.max(rExit,  ENC_HILL_K * rHill * ENC_EXIT_FACTOR);
        }
        sim._encR2Enter[k] = rEnter * rEnter;
        sim._encR2Exit[k]  = rExit * rExit;
    }
}

/**
 * Does pair k trip its criteria at `window` seconds of closing time and
 * the given distance thresholds? Shared by the enter and exit scans.
 */
function _pairHot(sim, k, r2Limit, closeWindowSec) {
    const bi = sim.bodies[sim._encPairI[k]];
    const bj = sim.bodies[sim._encPairJ[k]];
    const dx = bj.r[0] - bi.r[0];
    const dy = bj.r[1] - bi.r[1];
    const dz = bj.r[2] - bi.r[2];
    const d2 = dx*dx + dy*dy + dz*dz;
    if (d2 <= r2Limit) return true;
    if (sim._encClassB[k]) {
        // Closing-time criterion, symmetric in |ṙ| so the outgoing leg of
        // a flyby stays adaptive until the fixed step is comfortable.
        const dvx = bj.v[0] - bi.v[0];
        const dvy = bj.v[1] - bi.v[1];
        const dvz = bj.v[2] - bi.v[2];
        const rdot = Math.abs(dx*dvx + dy*dvy + dz*dvz) / Math.sqrt(d2);
        if (d2 < (rdot * closeWindowSec) ** 2) return true;
    }
    return false;
}

/** Any pair hot at ENTRY thresholds? Returns the pair index or -1. */
function _scanEncounterEnter(sim) {
    const win = ENC_CLOSE_STEPS * sim.targetStep;
    for (let k = 0; k < sim._encPairI.length; k++) {
        if (_pairHot(sim, k, sim._encR2Enter[k], win)) return k;
    }
    return -1;
}

/** True when every pair has cleared the EXIT thresholds (1.5× hysteresis). */
function _scanEncounterExit(sim) {
    const win = ENC_CLOSE_STEPS * sim.targetStep * ENC_EXIT_FACTOR;
    for (let k = 0; k < sim._encPairI.length; k++) {
        if (_pairHot(sim, k, sim._encR2Exit[k], win)) return false;
    }
    return true;
}

function _enterAdaptive(sim) {
    const k = _scanEncounterEnter(sim);
    const i = k >= 0 ? sim._encPairI[k] : 0;
    const j = k >= 0 ? sim._encPairJ[k] : 1;
    const bi = sim.bodies[i], bj = sim.bodies[j];
    sim.integrator = 'rkf78';
    sim.hAdaptive = null;
    sim.rkCtrl.errPrev = 1;
    sim.encounter = {
        bodyA: bi.name ?? `body ${i}`,
        bodyB: bj.name ?? `body ${j}`,
        separationM: Math.hypot(
            bj.r[0]-bi.r[0], bj.r[1]-bi.r[1], bj.r[2]-bi.r[2]),
    };
}

function _exitAdaptive(sim) {
    sim.integrator = 'yoshida4';
    sim.encounter = null;
    sim.hAdaptive = null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fault guard + checkpoint ring (P0.2)
// ─────────────────────────────────────────────────────────────────────────────

function _guardKind(sim) {
    for (const b of sim.bodies) {
        if (!Number.isFinite(b.r[0]) || !Number.isFinite(b.r[1]) || !Number.isFinite(b.r[2]) ||
            !Number.isFinite(b.v[0]) || !Number.isFinite(b.v[1]) || !Number.isFinite(b.v[2])) {
            return 'nonfinite';
        }
    }
    const E = currentEnergy(sim);
    if (!Number.isFinite(E)) return 'nonfinite';
    if (Math.abs(E - sim.energy0) > FAULT_ENERGY_REL * sim.energyScale) return 'energy';
    return null;
}

function _closestPair(bodies) {
    let a = null, b = null, d = Infinity;
    for (let i = 0; i < bodies.length; i++) {
        for (let j = i + 1; j < bodies.length; j++) {
            const dx = bodies[j].r[0] - bodies[i].r[0];
            const dy = bodies[j].r[1] - bodies[i].r[1];
            const dz = bodies[j].r[2] - bodies[i].r[2];
            let dij = Math.sqrt(dx*dx + dy*dy + dz*dz);
            if (!Number.isFinite(dij)) dij = -1;   // NaN pair is the culprit — rank first
            if (dij < d) { d = dij; a = bodies[i].name ?? `body ${i}`; b = bodies[j].name ?? `body ${j}`; }
        }
    }
    return { a, b, d };
}

function _recordCheckpoint(sim) {
    const N = sim.bodies.length;
    const ck = sim.ckpt;
    ck.head = (ck.head + 1) % CKPT_CAPACITY;
    if (ck.count < CKPT_CAPACITY) ck.count++;
    let slot = ck.ring[ck.head];
    if (!slot || slot.buf.length !== N * 6) {
        slot = { t: 0, buf: new Float64Array(N * 6) };
        ck.ring[ck.head] = slot;
    }
    slot.t = sim.elapsedSec;
    const buf = slot.buf;
    for (let i = 0; i < N; i++) {
        const b = sim.bodies[i], o = i * 6;
        buf[o]     = b.r[0]; buf[o + 1] = b.r[1]; buf[o + 2] = b.r[2];
        buf[o + 3] = b.v[0]; buf[o + 4] = b.v[1]; buf[o + 5] = b.v[2];
    }
}

function _restoreSlot(sim, slot) {
    const buf = slot.buf;
    for (let i = 0; i < sim.bodies.length; i++) {
        const b = sim.bodies[i], o = i * 6;
        b.r[0] = buf[o];     b.r[1] = buf[o + 1]; b.r[2] = buf[o + 2];
        b.v[0] = buf[o + 3]; b.v[1] = buf[o + 4]; b.v[2] = buf[o + 5];
    }
    sim.elapsedSec = slot.t;
    sim.debtSec = 0;
    // Restored states re-detect encounters from scratch on resume.
    sim.integrator = 'yoshida4';
    sim.encounter = null;
    sim.hAdaptive = null;
    // Trail rings contain the now-discarded excursion — invalid data.
    clearTrailBuffers(sim);
    return slot;
}

function _restoreNewestCheckpoint(sim) {
    return _restoreSlot(sim, sim.ckpt.ring[sim.ckpt.head]);
}

/**
 * Step back one checkpoint (~0.5 s of wall-clock history per call; user
 * feature and fault recovery both ride this). The first call after normal
 * running restores the newest snapshot; subsequent calls walk older ones.
 * The initial state is the floor — rewinding never empties the ring.
 * Returns { t } of the restored checkpoint.
 */
function _stateMatchesSlot(sim, slot) {
    if (slot.t !== sim.elapsedSec) return false;
    const buf = slot.buf;
    for (let i = 0; i < sim.bodies.length; i++) {
        const b = sim.bodies[i], o = i * 6;
        if (b.r[0] !== buf[o]     || b.r[1] !== buf[o + 1] || b.r[2] !== buf[o + 2] ||
            b.v[0] !== buf[o + 3] || b.v[1] !== buf[o + 4] || b.v[2] !== buf[o + 5]) {
            return false;
        }
    }
    return true;
}

export function rewind(sim) {
    const ck = sim.ckpt;
    const newest = ck.ring[ck.head];
    // If the live state differs from the newest snapshot — the sim
    // advanced past it, OR a sandbox edit changed state at the same
    // elapsed time — the first press lands on that snapshot (this is what
    // makes Rewind double as edit-undo). Only when already sitting on it
    // bit-exactly do we walk older.
    if (!_stateMatchesSlot(sim, newest)) return _restoreSlot(sim, newest);
    if (ck.count > 1) {
        ck.head = (ck.head - 1 + CKPT_CAPACITY) % CKPT_CAPACITY;
        ck.count--;
    }
    return _restoreSlot(sim, ck.ring[ck.head]);
}

/** Zero the sim-time debt (call on direction flip / warp edits / reloads). */
export function clearDebt(sim) {
    sim.debtSec = 0;
    sim._overBudgetSinceMs = null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sandbox editing (P2.1)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Apply an edited state to one body (drag, velocity gizmo, element
 * editor). Records a checkpoint of the PRE-edit state first, so the
 * Rewind button doubles as undo. Re-baselines the conservation ledger —
 * an edit is a new experiment, not integrator drift — and wipes trails,
 * which now depict a trajectory that never happened.
 *
 * `pre` = {r, v} as they were BEFORE the edit gesture. It must be passed
 * explicitly because the caller may have already written preview values
 * into the live body (the inline driver aliases the main-thread array),
 * so "current state" is not trustworthy as the undo point.
 */
export function setBodyState(sim, idx, r, v, pre = null) {
    const b = sim.bodies[idx];
    if (!b) return;
    if (pre) {
        const sr = [b.r[0], b.r[1], b.r[2]];
        const sv = [b.v[0], b.v[1], b.v[2]];
        b.r[0] = pre.r[0]; b.r[1] = pre.r[1]; b.r[2] = pre.r[2];
        b.v[0] = pre.v[0]; b.v[1] = pre.v[1]; b.v[2] = pre.v[2];
        _recordCheckpoint(sim);
        b.r[0] = sr[0]; b.r[1] = sr[1]; b.r[2] = sr[2];
        b.v[0] = sv[0]; b.v[1] = sv[1]; b.v[2] = sv[2];
    } else {
        _recordCheckpoint(sim);
    }
    if (r) { b.r[0] = r[0]; b.r[1] = r[1]; b.r[2] = r[2]; }
    if (v) { b.v[0] = v[0]; b.v[1] = v[1]; b.v[2] = v[2]; }
    rebaselineEnergy(sim);
    clearTrailBuffers(sim);
    clearDebt(sim);
}

/** Set the Plummer softening length (m). Sandbox-only; re-baselines. */
export function setSoftening(sim, epsMeters) {
    sim.soft2 = epsMeters * epsMeters;
    rebaselineEnergy(sim);
}

// ─────────────────────────────────────────────────────────────────────────────
// MEGNO chaos indicator (P2.3) — Cincotta, Giordano & Simó.
//
//   Y(t)  = (2/t) ∫₀ᵗ (δ̇·δ)/(δ·δ) s ds        (phase-space dot products)
//   ⟨Y⟩(t) = (1/t) ∫₀ᵗ Y(s) ds
//
// ⟨Y⟩ → 2 for quasi-periodic motion; grows linearly (≈ λt/2) for chaos.
// The tangent vector rides the integrated trajectory (variationalStep);
// during adaptive close-encounter segments it follows the RK steps — a
// documented approximation that preserves the growth-rate signal. The
// MEGNO clock starts at enable time.
// ─────────────────────────────────────────────────────────────────────────────

export function enableMegno(sim, on) {
    sim.megno = on ? {
        vs: createVariational(sim.bodies.length),
        t: 0, s1: 0, s2: 0, Y: 0, meanY: 0,
    } : null;
}

function _megnoAccumulate(sim, dtAbs) {
    const m = sim.megno;
    m.t += dtAbs;
    const { dr, dv, da } = m.vs;
    let num = 0, den = 0;
    for (let k = 0; k < dr.length; k++) {
        num += dr[k] * dv[k] + dv[k] * da[k];
        den += dr[k] * dr[k] + dv[k] * dv[k];
    }
    if (den > 0) {
        m.s1 += dtAbs * m.t * (num / den);
        m.Y = 2 * m.s1 / m.t;
        m.s2 += m.Y * dtAbs;
        m.meanY = m.s2 / m.t;
    }
    // Renormalize before the exponential growth of a chaotic δ overflows;
    // MEGNO's integrands are scale-invariant, so this is loss-free.
    if (den > 1e100) {
        const inv = 1 / Math.sqrt(den);
        for (let k = 0; k < dr.length; k++) { dr[k] *= inv; dv[k] *= inv; }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Sim-time trail sampling (P0.3, fixes D3/D4)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Configure per-body trail sampling.
 *
 * @param {object} sim
 * @param {Array}  specs     One entry per body: null (no trail) or
 *                           { interval: seconds of SIM time between points,
 *                             scale: SI-meters → scene-units factor }.
 * @param {number} capacity  Ring size in points (points/orbit × visible
 *                           periods). Older points age out — an orbit
 *                           traced 50 times is noise, not information.
 */
export function configureTrails(sim, specs, capacity) {
    sim.trails = specs.map(s => s ? {
        interval: s.interval,
        scale:    s.scale,
        cap:      capacity,
        buf:      new Float32Array(capacity * 3),   // scene-unit positions
        head:     -1,       // ring slot of the newest point
        count:    0,        // valid points in the ring (≤ cap)
        total:    0,        // monotone point counter — consumers diff against it
        acc:      0,        // sim-time accumulator toward the next point
    } : null);
}

/** Reset all trail rings (system load, rewind, fault restore). */
export function clearTrailBuffers(sim) {
    if (!sim.trails) return;
    for (const tr of sim.trails) {
        if (!tr) continue;
        tr.head = -1;
        tr.count = 0;
        tr.total = 0;
        tr.acc = 0;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Massless test particles (P3.2) — feel gravity from every massive body,
// exert none, ignore each other. KDK leapfrog in the bodies' time-varying
// field: kick with the field at t, drift, kick with the field at t+dt.
// Kernel-backed when the WASM kernel is present (the cloud lives in
// kernel memory); pure-JS fallback otherwise, same math, same layout.
// ─────────────────────────────────────────────────────────────────────────────

export function configureParticles(sim, n, srcBuf) {
    if (!n || !srcBuf) {
        sim.particles = null;
        return;
    }
    if (sim.kernel) {
        const cap = Math.min(n, sim.kernel.maxParticles);
        sim.kernel.particlesView.set(srcBuf.subarray(0, cap * 6));
        sim.particles = {
            n: cap,
            buf: sim.kernel.particlesView.subarray(0, cap * 6),
            kernelBacked: true,
        };
    } else {
        sim.particles = {
            n,
            buf: srcBuf,
            kernelBacked: false,
            oldPos: new Float64Array(sim.bodies.length * 3),
        };
    }
}

/** Snapshot body positions (field at t) before the bodies step. */
function _particlesPre(sim) {
    if (sim.kernel) {
        writeBodies(sim.kernel, sim.bodies);
        sim.kernel.savePositions(sim.bodies.length);
    } else {
        const old = sim.particles.oldPos;
        for (let i = 0; i < sim.bodies.length; i++) {
            const r = sim.bodies[i].r;
            old[i * 3] = r[0]; old[i * 3 + 1] = r[1]; old[i * 3 + 2] = r[2];
        }
    }
}

/** KDK the cloud across the step the bodies just took. */
function _particlesPost(sim, dt) {
    if (sim.kernel) {
        writeBodies(sim.kernel, sim.bodies);
        sim.kernel.stepParticles(sim.bodies.length, sim.particles.n, dt, sim.soft2);
    } else {
        _jsStepParticles(sim, dt);
    }
}

function _jsKickParticles(sim, dt, useOld) {
    const P = sim.particles;
    const buf = P.buf, n = P.n, old = P.oldPos;
    const bodies = sim.bodies, nb = bodies.length;
    const soft2 = sim.soft2;
    for (let k = 0; k < n; k++) {
        const o = k * 6;
        const px = buf[o], py = buf[o + 1], pz = buf[o + 2];
        let ax = 0, ay = 0, az = 0;
        for (let i = 0; i < nb; i++) {
            let bx, by, bz;
            if (useOld) { bx = old[i * 3]; by = old[i * 3 + 1]; bz = old[i * 3 + 2]; }
            else { const r = bodies[i].r; bx = r[0]; by = r[1]; bz = r[2]; }
            const dx = bx - px, dy = by - py, dz = bz - pz;
            const r2 = dx * dx + dy * dy + dz * dz + soft2;
            const gm = G_SI * bodies[i].m / (r2 * Math.sqrt(r2));
            ax += gm * dx; ay += gm * dy; az += gm * dz;
        }
        buf[o + 3] += ax * dt;
        buf[o + 4] += ay * dt;
        buf[o + 5] += az * dt;
    }
}

function _jsStepParticles(sim, dt) {
    const P = sim.particles;
    _jsKickParticles(sim, dt * 0.5, true);
    const buf = P.buf, n = P.n;
    for (let k = 0; k < n; k++) {
        const o = k * 6;
        buf[o]     += buf[o + 3] * dt;
        buf[o + 1] += buf[o + 4] * dt;
        buf[o + 2] += buf[o + 5] * dt;
    }
    _jsKickParticles(sim, dt * 0.5, false);
}

function _sampleTrails(sim, absDt) {
    const trails = sim.trails;
    for (let i = 0; i < trails.length; i++) {
        const tr = trails[i];
        if (!tr) continue;
        tr.acc += absDt;
        if (tr.acc < tr.interval) continue;
        // A substep larger than the interval can cross several boundaries;
        // intermediate positions no longer exist, so emit one point and
        // carry the remainder (keeps long-run cadence exact).
        tr.acc %= tr.interval;
        const b = sim.bodies[i];
        tr.head = (tr.head + 1) % tr.cap;
        if (tr.count < tr.cap) tr.count++;
        tr.total++;
        const o = tr.head * 3;
        tr.buf[o]     = b.r[0] * tr.scale;
        tr.buf[o + 1] = b.r[1] * tr.scale;
        tr.buf[o + 2] = b.r[2] * tr.scale;
    }
}
