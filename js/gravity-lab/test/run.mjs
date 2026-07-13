/**
 * run.mjs — Gravity Lab regression & validation harness (P0.0).
 *
 * Node-runnable, browser-free: physics.js and systems.js are pure ES
 * modules. Run with:
 *
 *     node js/gravity-lab/test/run.mjs            # full suite
 *     node js/gravity-lab/test/run.mjs --fast     # skip the slowest cases
 *
 * Exit code is non-zero on any hard failure. Tests marked `xfail` report
 * as XFAIL (documented shortcoming of the current code, tracked in
 * README.md) and do not fail the run — but an xfail that unexpectedly
 * PASSES is reported so the marker can be removed.
 *
 * This harness is the release gate for every Phase-0..3 change: any edit
 * to the stepping, trail, worker, or system code must keep it green.
 */

import {
    yoshida4Step,
    totalEnergy,
    totalAngularMomentum,
    totalJ2PotentialEnergy,
    elementsToState,
    stateToElements,
    shiftToBarycenter,
    G_SI,
} from '../physics.js';
import { SYSTEMS, SYSTEM_ORDER } from '../systems.js';
import {
    createSim, advanceFrame, clearDebt, rewind, currentEnergy,
    configureTrails,
} from '../sim-core.js';

const FAST = process.argv.includes('--fast');

// ─────────────────────────────────────────────────────────────────────────────
// Tiny test framework
// ─────────────────────────────────────────────────────────────────────────────

const tests = [];
function test(name, fn, opts = {}) { tests.push({ name, fn, ...opts }); }

function fmt(x) {
    if (typeof x !== 'number' || !isFinite(x)) return String(x);
    return x.toExponential(3);
}

async function runAll() {
    let failed = 0, passed = 0, xfailed = 0, surprises = 0;
    for (const t of tests) {
        if (FAST && t.slow) { console.log(`SKIP  ${t.name} (--fast)`); continue; }
        const t0 = performance.now();
        let err = null;
        try { await t.fn(); } catch (e) { err = e; }
        const ms = (performance.now() - t0).toFixed(0);
        if (err && t.xfail) {
            xfailed++;
            console.log(`XFAIL ${t.name} (${ms} ms) — known: ${t.xfail}`);
            console.log(`      ${err.message}`);
        } else if (err) {
            failed++;
            console.error(`FAIL  ${t.name} (${ms} ms)`);
            console.error(`      ${err.message}`);
        } else if (t.xfail) {
            surprises++;
            console.log(`XPASS ${t.name} (${ms} ms) — expected failure PASSED; remove the xfail marker`);
        } else {
            passed++;
            console.log(`PASS  ${t.name} (${ms} ms)`);
        }
    }
    console.log(`\n${passed} passed, ${failed} failed, ${xfailed} xfail, ${surprises} xpass`);
    if (failed > 0) process.exit(1);
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }
function assertBelow(value, limit, label) {
    assert(value < limit, `${label} = ${fmt(value)} exceeds limit ${fmt(limit)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function cloneBodies(bodies) {
    return bodies.map(b => ({ m: b.m, r: [...b.r], v: [...b.v], name: b.name }));
}

function systemBodies(id) {
    return cloneBodies(SYSTEMS[id].bodies);
}

/** Max relative position/velocity deviation between two body sets. */
function maxStateDeviation(a, b) {
    let rScale = 0, vScale = 0;
    for (const x of a) {
        rScale = Math.max(rScale, Math.hypot(...x.r));
        vScale = Math.max(vScale, Math.hypot(...x.v));
    }
    let dR = 0, dV = 0;
    for (let i = 0; i < a.length; i++) {
        dR = Math.max(dR, Math.hypot(
            a[i].r[0] - b[i].r[0], a[i].r[1] - b[i].r[1], a[i].r[2] - b[i].r[2]));
        dV = Math.max(dV, Math.hypot(
            a[i].v[0] - b[i].v[0], a[i].v[1] - b[i].v[1], a[i].v[2] - b[i].v[2]));
    }
    return { dR: dR / rScale, dV: dV / vScale };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Two-body analytic tests — circular and e = 0.3 Kepler orbits.
//    100 periods at dt = P/1000; position error vs the analytic solution
//    < 1e-6 relative (normalized by a); |ΔE/E₀| < 1e-10.
// ─────────────────────────────────────────────────────────────────────────────

function twoBodyCase(e, stepsPerPeriod = 1000) {
    // Earth-Moon-scale masses so the reduced two-body problem is exercised
    // with a non-trivial mass ratio (both bodies move).
    const M1 = 5.972e24, M2 = 7.342e22;
    const a  = 3.844e8;                       // m
    const mu = G_SI * (M1 + M2);
    const elements = { a, e, i_deg: 12.0, raan_deg: 40.0, argp_deg: 70.0, M_deg: 10.0, mu };
    const P = 2 * Math.PI * Math.sqrt(a * a * a / mu);
    const n = 2 * Math.PI / P;

    const { r, v } = elementsToState(elements);
    const f2 = M1 / (M1 + M2);   // body-2 share of the relative vector
    const f1 = M2 / (M1 + M2);
    const bodies = [
        { m: M1, r: [-f1 * r[0], -f1 * r[1], -f1 * r[2]], v: [-f1 * v[0], -f1 * v[1], -f1 * v[2]] },
        { m: M2, r: [ f2 * r[0],  f2 * r[1],  f2 * r[2]], v: [ f2 * v[0],  f2 * v[1],  f2 * v[2]] },
    ];

    const dt = P / stepsPerPeriod;
    const E0 = totalEnergy(bodies).total;

    const periods = 100;
    let maxPosErr = 0;
    let t = 0;
    for (let p = 0; p < periods; p++) {
        for (let k = 0; k < stepsPerPeriod; k++) {
            yoshida4Step(bodies, dt);
            t += dt;
        }
        // Compare the relative vector against the analytic Kepler solution
        // at this exact t (checks phase error, not just orbit shape).
        const analytic = elementsToState({
            ...elements,
            M_deg: elements.M_deg + (n * t) * 180 / Math.PI,
        });
        const rel = [
            bodies[1].r[0] - bodies[0].r[0],
            bodies[1].r[1] - bodies[0].r[1],
            bodies[1].r[2] - bodies[0].r[2],
        ];
        const err = Math.hypot(
            rel[0] - analytic.r[0], rel[1] - analytic.r[1], rel[2] - analytic.r[2]) / a;
        maxPosErr = Math.max(maxPosErr, err);
    }

    const E1 = totalEnergy(bodies).total;
    const dE = Math.abs((E1 - E0) / E0);
    return { maxPosErr, dE };
}

test('two-body analytic · circular (e=0) · 100 periods', () => {
    const { maxPosErr, dE } = twoBodyCase(0.0);
    assertBelow(maxPosErr, 1e-6, 'relative position error');
    assertBelow(dE, 1e-10, '|ΔE/E₀|');
});

test('two-body analytic · e=0.3 · 100 periods + 4th-order convergence', () => {
    // Measured truncation of Yoshida-4 at dt = P/1000 for e = 0.3 is
    // 2.7e-6 relative after 100 periods (phase error grows linearly in t
    // and the error constant grows with eccentricity). That is the
    // integrator performing at its theoretical order, not a defect — the
    // convergence-order assertion below is the actual correctness proof:
    // halving dt must shrink the error ~16× (4th order; measured 15.7×).
    const coarse = twoBodyCase(0.3, 1000);
    assertBelow(coarse.maxPosErr, 4e-6, 'relative position error @ P/1000');
    assertBelow(coarse.dE, 1e-10, '|ΔE/E₀| @ P/1000');

    const fine = twoBodyCase(0.3, 2000);
    assertBelow(fine.maxPosErr, 1e-6, 'relative position error @ P/2000');
    assertBelow(fine.dE, 1e-10, '|ΔE/E₀| @ P/2000');

    const ratio = coarse.maxPosErr / fine.maxPosErr;
    assert(ratio > 12 && ratio < 20,
        `convergence ratio ${ratio.toFixed(1)} outside 4th-order band [12, 20]`);
}, { slow: true });

// ─────────────────────────────────────────────────────────────────────────────
// 2. Energy / angular-momentum conservation per curated system.
//    1e5 steps at suggested_dt_s; |ΔE/E₀| < 1e-8, |ΔL/L₀| < 1e-10.
//    Point-mass only (J2 off) — the J2 Hamiltonian is checked separately.
// ─────────────────────────────────────────────────────────────────────────────

for (const id of SYSTEM_ORDER) {
    test(`energy conservation · ${id} · 1e5 steps @ suggested dt`, () => {
        const sys = SYSTEMS[id];
        const bodies = systemBodies(id);
        const dt = sys.suggested_dt_s;
        const E0 = totalEnergy(bodies).total;
        const L0v = totalAngularMomentum(bodies);
        const L0 = Math.hypot(...L0v) || 1;

        let maxdE = 0;
        const steps = 1e5;
        for (let k = 0; k < steps; k++) {
            yoshida4Step(bodies, dt);
            // Sampling every step doubles runtime for no gain — every 500
            // steps still catches the oscillation envelope.
            if (k % 500 === 499) {
                const E = totalEnergy(bodies).total;
                maxdE = Math.max(maxdE, Math.abs((E - E0) / E0));
            }
        }
        const L1v = totalAngularMomentum(bodies);
        const dL = Math.abs(Math.hypot(...L1v) - L0) / L0;
        for (const b of bodies) {
            assert(b.r.every(Number.isFinite) && b.v.every(Number.isFinite),
                `non-finite state on ${b.name}`);
        }
        assertBelow(maxdE, 1e-8, '|ΔE/E₀|');
        assertBelow(dL, 1e-10, '|ΔL/L₀|');
    }, { slow: true });
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. J2 validation — Phobos nodal regression.
//    Mars J2 drives dΩ/dt = −(3/2) n J2 (R_eq/p)² cos i ≈ −159°/yr for
//    Phobos (the figure quoted in the UI). Integrate 60 sim-days with J2
//    on and require the measured secular rate within 5%.
// ─────────────────────────────────────────────────────────────────────────────

test('J2 · Phobos nodal regression ≈ −159°/yr within 5%', () => {
    const sys = SYSTEMS['mars-system'];
    const bodies = systemBodies('mars-system');
    const j2 = {
        centerIdx: 0,
        J2:   sys.oblateness.J2,
        R_eq: sys.oblateness.R_eq_m,
        mu:   sys.mu_parent,
    };
    const opts = { J2: j2 };
    const dt = 60;
    const days = 60;
    const steps = Math.round(days * 86400 / dt);

    // Analytic secular rate from Phobos's J2000 elements.
    const el0 = sys.bodies.find(b => b.name === 'phobos').elements_j2000;
    const muP = sys.mu_parent + G_SI * bodies.find(b => b.name === 'phobos').m;
    const n = Math.sqrt(muP / (el0.a ** 3));
    const p = el0.a * (1 - el0.e * el0.e);
    const analyticRate = -1.5 * n * j2.J2 * (j2.R_eq / p) ** 2
        * Math.cos(el0.i_deg * Math.PI / 180);              // rad/s
    const analyticDegYr = analyticRate * 3.15576e7 * 180 / Math.PI;

    // Hamiltonian drift with J2 active must also stay bounded.
    const E0 = totalEnergy(bodies).total + totalJ2PotentialEnergy(bodies, j2);

    const pIdx = bodies.findIndex(b => b.name === 'mars');
    const sIdx = bodies.findIndex(b => b.name === 'phobos');
    const samples = [];   // [t_s, raan_deg unwrapped]
    let prevRaan = null, unwrapOffset = 0;
    for (let k = 0; k < steps; k++) {
        yoshida4Step(bodies, dt, opts);
        if (k % 720 === 719) {   // every 12 hours
            const P0 = bodies[pIdx], S = bodies[sIdx];
            const el = stateToElements(
                [S.r[0]-P0.r[0], S.r[1]-P0.r[1], S.r[2]-P0.r[2]],
                [S.v[0]-P0.v[0], S.v[1]-P0.v[1], S.v[2]-P0.v[2]],
                muP);
            let raan = el.raan_deg;
            if (prevRaan !== null) {
                let d = raan + unwrapOffset - prevRaan;
                while (d >  180) { unwrapOffset -= 360; d -= 360; }
                while (d < -180) { unwrapOffset += 360; d += 360; }
            }
            raan += unwrapOffset;
            prevRaan = raan;
            samples.push([(k + 1) * dt, raan]);
        }
    }

    // Least-squares slope (deg/s) → deg/yr.
    const nS = samples.length;
    const mT = samples.reduce((s, x) => s + x[0], 0) / nS;
    const mR = samples.reduce((s, x) => s + x[1], 0) / nS;
    let num = 0, den = 0;
    for (const [t, r] of samples) { num += (t - mT) * (r - mR); den += (t - mT) ** 2; }
    const measuredDegYr = (num / den) * 3.15576e7;

    const E1 = totalEnergy(bodies).total + totalJ2PotentialEnergy(bodies, j2);
    const dE = Math.abs((E1 - E0) / E0);

    assert(measuredDegYr < 0, `node should regress (westward); got ${measuredDegYr.toFixed(2)}°/yr`);
    const relErr = Math.abs((measuredDegYr - analyticDegYr) / analyticDegYr);
    assert(relErr < 0.05,
        `Phobos dΩ/dt = ${measuredDegYr.toFixed(2)}°/yr vs analytic ${analyticDegYr.toFixed(2)}°/yr ` +
        `(rel err ${(relErr * 100).toFixed(2)}%)`);
    assertBelow(dE, 1e-8, 'J2 Hamiltonian drift |ΔE/E₀|');
}, { slow: true });

// ─────────────────────────────────────────────────────────────────────────────
// 4. Time-reversal — symplectic + time-symmetric ⇒ forward 1e4 steps then
//    backward 1e4 steps returns to the initial state to roundoff.
// ─────────────────────────────────────────────────────────────────────────────

for (const id of SYSTEM_ORDER) {
    test(`time reversal · ${id} · 1e4 steps out and back`, () => {
        const sys = SYSTEMS[id];
        const initial = systemBodies(id);
        const bodies = cloneBodies(initial);
        const dt = sys.suggested_dt_s;
        for (let k = 0; k < 1e4; k++) yoshida4Step(bodies,  dt);
        for (let k = 0; k < 1e4; k++) yoshida4Step(bodies, -dt);
        const { dR, dV } = maxStateDeviation(initial, bodies);
        assertBelow(dR, 1e-9, 'relative position deviation');
        assertBelow(dV, 1e-9, 'relative velocity deviation');
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Element round-trip sanity — elementsToState ∘ stateToElements = id.
//    Cheap invariant that guards the editor work in Phase 2.
// ─────────────────────────────────────────────────────────────────────────────

test('elements round-trip · a/e/i/raan/argp/M recovered', () => {
    const mu = 3.986004418e14;
    for (const el of [
        { a: 7.0e6,  e: 0.001, i_deg: 51.6,  raan_deg: 120.0, argp_deg: 45.0,  M_deg: 200.0, mu },
        { a: 4.2e7,  e: 0.3,   i_deg: 5.0,   raan_deg: 300.0, argp_deg: 270.0, M_deg: 10.0,  mu },
        { a: 3.84e8, e: 0.0549,i_deg: 5.145, raan_deg: 125.08,argp_deg: 318.15,M_deg: 135.27,mu },
    ]) {
        const { r, v } = elementsToState(el);
        const out = stateToElements(r, v, mu);
        assertBelow(Math.abs(out.a - el.a) / el.a, 1e-10, `a round-trip (${el.a})`);
        assertBelow(Math.abs(out.e - el.e), 1e-10, 'e round-trip');
        assertBelow(Math.abs(out.i_deg - el.i_deg), 1e-9, 'i round-trip');
        assertBelow(Math.abs(out.raan_deg - el.raan_deg), 1e-8, 'raan round-trip');
        assertBelow(Math.abs(out.argp_deg - el.argp_deg), 1e-7, 'argp round-trip');
        assertBelow(Math.abs(out.M_deg - el.M_deg), 1e-7, 'M round-trip');
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Barycenter integrity — shiftToBarycenter zeroes COM and momentum, and
//    the COM stays pinned through integration (momentum conservation).
// ─────────────────────────────────────────────────────────────────────────────

test('barycenter stays pinned through 1e4 steps (all systems)', () => {
    for (const id of SYSTEM_ORDER) {
        const sys = SYSTEMS[id];
        const bodies = systemBodies(id);
        let M = 0, extent = 0;
        for (const b of bodies) { M += b.m; extent = Math.max(extent, Math.hypot(...b.r)); }
        for (let k = 0; k < 1e4; k++) yoshida4Step(bodies, sys.suggested_dt_s);
        const com = [0, 0, 0];
        for (const b of bodies) {
            com[0] += b.m * b.r[0]; com[1] += b.m * b.r[1]; com[2] += b.m * b.r[2];
        }
        const drift = Math.hypot(...com) / M / extent;
        assertBelow(drift, 1e-10, `${id} COM drift (fraction of extent)`);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. sim-core frame budget (P0.1) — the substep loop is bounded by the
//    wall-clock budget, the shortfall carries as debt (sim time is never
//    skipped), sustained over-budget engages the warp throttle, and the
//    cap recovers once frames fit the budget again.
// ─────────────────────────────────────────────────────────────────────────────

test('sim-core · budget bounds the substep loop; debt carries exactly', () => {
    const bodies = systemBodies('saturn-major');
    const sim = createSim({ bodies, targetStep: 1200 });

    // Deterministic fake clock: each substep "costs" 0.5 ms via the onStep
    // hook, so a 6 ms budget admits ~16-32 steps per frame (the core reads
    // the clock every 16 steps).
    let fakeMs = 0;
    const now = () => fakeMs;
    const onStep = () => { fakeMs += 0.5; };

    const frame = { dtRealSec: 1 / 60, warp: 1e8, direction: +1, budgetMs: 6 };
    const requested = frame.dtRealSec * frame.warp;   // 1.67e6 sim-s
    const res = advanceFrame(sim, frame, now, onStep);

    assert(res.stepsDone < res.stepsWanted,
        `budget should truncate the loop (did ${res.stepsDone}/${res.stepsWanted})`);
    assert(res.stepsDone <= 32, `stepsDone ${res.stepsDone} should be bounded by the budget`);
    // Conservation of requested time: advanced + debt === requested.
    const total = res.advancedSec + sim.debtSec;
    assertBelow(Math.abs(total - requested) / requested, 1e-12, 'advanced+debt vs requested');
    assert(sim.elapsedSec === res.advancedSec, 'elapsedSec must equal integrated time only');
});

test('sim-core · sustained over-budget engages throttle, cap recovers', () => {
    const bodies = systemBodies('earth-moon');
    const sim = createSim({ bodies, targetStep: 600 });

    let fakeMs = 0;
    const now = () => fakeMs;
    const onStep = () => { fakeMs += 0.5; };

    // Phase 1: hammer with an unsustainable warp. Each frame advances the
    // fake clock ~16 ms of frame time + step costs; after >2 s of fake
    // wall time the throttle must engage.
    const hot = { dtRealSec: 1 / 60, warp: 1e8, direction: +1, budgetMs: 6 };
    let throttledAt = -1;
    for (let f = 0; f < 400; f++) {
        fakeMs += 16.7;
        const res = advanceFrame(sim, hot, now, onStep);
        if (res.throttled) { throttledAt = f; break; }
    }
    assert(throttledAt >= 0, 'throttle never engaged under sustained overload');
    assert(isFinite(sim.warpCap) && sim.warpCap >= 1, `warpCap should be finite, got ${sim.warpCap}`);
    assert(sim.debtSec === 0, 'debt should be forgiven when the cap engages');
    const capWhenHot = sim.warpCap;

    // Phase 2: drop the requested warp below the cap — frames now fit the
    // budget, the cap probes upward and eventually disengages.
    const cool = { dtRealSec: 1 / 60, warp: 100, direction: +1, budgetMs: 6 };
    let recovered = false;
    for (let f = 0; f < 2000; f++) {
        fakeMs += 16.7;
        const res = advanceFrame(sim, cool, now, onStep);
        if (!res.throttled) { recovered = true; break; }
    }
    assert(recovered, `throttle never recovered (cap stuck at ${sim.warpCap}, was ${capWhenHot})`);
    assert(sim.warpCap === Infinity, 'cap should clear to Infinity after recovery');
});

test('sim-core · unpressured frame advances exactly the requested time', () => {
    const bodies = systemBodies('pluto-charon');
    const sim = createSim({ bodies, targetStep: 1800 });
    const frame = { dtRealSec: 1 / 60, warp: 86400 * 1.5, direction: +1, budgetMs: 1e9 };
    const requested = frame.dtRealSec * frame.warp;
    const res = advanceFrame(sim, frame, () => 0);
    assert(res.stepsDone === res.stepsWanted, 'all substeps should complete');
    assertBelow(Math.abs(res.advancedSec - requested) / requested, 1e-12, 'advanced vs requested');
    assert(sim.debtSec === 0, 'no debt without budget pressure');
    // Reversal bookkeeping: clearDebt zeroes the carry.
    sim.debtSec = 123;
    clearDebt(sim);
    assert(sim.debtSec === 0, 'clearDebt must zero the carry');
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Blow-up guards + checkpoint ring (P0.2).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Deliberately hot three-body config: two 1e26 kg bodies falling into a
 * deep flyby (pericenter ~1e4 km — survivable with a resolved integrator,
 * hopeless at a fixed 600 s step) plus a loosely bound spectator. Shared
 * with the P0.4 hybrid-stepping acceptance test.
 */
function hotTriple() {
    const m = 1e26;
    return [
        { name: 'alpha', m, r: [-5e8, 0, 0], v: [0, -260, 0] },
        { name: 'beta',  m, r: [ 5e8, 0, 0], v: [0,  260, 0] },
        { name: 'gamma', m: 1e22, r: [0, 4e9, 0], v: [1500, 0, 0] },
    ];
}

function runToFault(sim, { warp = 2e6, maxFrames = 5000 } = {}) {
    let fakeMs = 0;
    const now = () => fakeMs;
    for (let f = 0; f < maxFrames; f++) {
        fakeMs += 16.7;
        const res = advanceFrame(sim,
            { dtRealSec: 1 / 60, warp, direction: +1, budgetMs: 1e9 }, now);
        if (res.fault) return res.fault;
    }
    return null;
}

test('sim-core · hot three-body faults cleanly and rewinds (no NaN escapes)', () => {
    const sim = createSim({ bodies: hotTriple(), targetStep: 600 });
    const fault = runToFault(sim);
    assert(fault, 'expected an integration fault from the unresolved encounter');
    assert(fault.kind === 'energy' || fault.kind === 'nonfinite',
        `unexpected fault kind ${fault.kind}`);
    const pair = [fault.bodyA, fault.bodyB].sort().join('+');
    assert(pair === 'alpha+beta', `fault should name the encounter pair, got ${pair}`);
    assert(fault.rewoundSec > 0, 'fault must rewind, not stay on the bad state');
    // Restored state is healthy: finite everywhere, energy back near E₀.
    for (const b of sim.bodies) {
        assert(b.r.every(Number.isFinite) && b.v.every(Number.isFinite),
            `restored state has non-finite values on ${b.name}`);
    }
    const dE = Math.abs(currentEnergy(sim) - sim.energy0) / sim.energyScale;
    assertBelow(dE, 1e-3, 'restored-state energy deviation');

    // Rewind walks strictly backward and bottoms out at the initial state.
    let prevT = sim.elapsedSec;
    for (let k = 0; k < 200; k++) {
        const { t } = rewind(sim);
        assert(t <= prevT, `rewind went forward: ${t} > ${prevT}`);
        prevT = t;
    }
    assert(prevT === 0, `rewind floor should be the initial state (t=0), got ${prevT}`);
    const fresh = hotTriple();
    for (let i = 0; i < fresh.length; i++) {
        for (let k = 0; k < 3; k++) {
            assert(sim.bodies[i].r[k] === fresh[i].r[k], 'initial checkpoint must be bit-exact');
            assert(sim.bodies[i].v[k] === fresh[i].v[k], 'initial checkpoint must be bit-exact');
        }
    }
});

test('sim-core · injected NaN trips the nonfinite guard and restores', () => {
    const bodies = systemBodies('earth-moon');
    const sim = createSim({ bodies, targetStep: 600 });
    let fakeMs = 0;
    const now = () => fakeMs;
    // Advance a few healthy frames so checkpoints exist beyond the seed.
    for (let f = 0; f < 5; f++) {
        fakeMs += 600;   // > checkpoint interval → one checkpoint per frame
        advanceFrame(sim, { dtRealSec: 1 / 60, warp: 86400, direction: +1, budgetMs: 1e9 }, now);
    }
    sim.bodies[1].r[0] = NaN;
    fakeMs += 600;
    const res = advanceFrame(sim,
        { dtRealSec: 1 / 60, warp: 86400, direction: +1, budgetMs: 1e9 }, now);
    assert(res.fault && res.fault.kind === 'nonfinite',
        `expected nonfinite fault, got ${JSON.stringify(res.fault)}`);
    for (const b of sim.bodies) {
        assert(b.r.every(Number.isFinite) && b.v.every(Number.isFinite),
            'restore after NaN left non-finite state');
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. Sim-time trail sampling (P0.3) — trail geometry is a function of the
//    trajectory, never of warp/frame rate. Kills the hairball by
//    construction.
// ─────────────────────────────────────────────────────────────────────────────

function sampleTrailRun({ warp, simSeconds }) {
    const sys = SYSTEMS['earth-moon'];
    const bodies = systemBodies('earth-moon');
    const sim = createSim({ bodies, targetStep: sys.suggested_dt_s });
    const moon = bodies.findIndex(b => b.name === 'moon');
    const mu = sys.mu_parent + bodies[moon].m * 6.6743e-11;
    const periodS = 2 * Math.PI * Math.sqrt(sys.bodies[moon].elements_j2000.a ** 3 / mu);
    const interval = periodS / 256;
    configureTrails(sim,
        bodies.map((b, i) => i === moon ? { interval, scale: 1e-3 / sys.scale_km_per_unit } : null),
        256 * 3);
    let fakeMs = 0;
    const now = () => fakeMs;
    // Advance EXACTLY simSeconds: the last frame is shortened so both warp
    // settings integrate the same total sim time (otherwise the high-warp
    // run overshoots by up to one frame's worth and the comparison is
    // apples-to-oranges).
    let remaining = simSeconds;
    while (remaining > 1e-6) {
        const dtReal = Math.min(1 / 60, remaining / warp);
        fakeMs += 16.7;
        advanceFrame(sim, { dtRealSec: dtReal, warp, direction: +1, budgetMs: 1e9 }, now);
        remaining = simSeconds - sim.elapsedSec;
    }
    return { trail: sim.trails[moon], periodS };
}

test('trails · sampling cadence: ~256 points per orbital period at any warp', () => {
    const lo = sampleTrailRun({ warp: 3e5, simSeconds: 2.36e6 });   // ≈1 moon period
    const hi = sampleTrailRun({ warp: 3e7, simSeconds: 2.36e6 });
    for (const [label, run] of [['low warp', lo], ['high warp', hi]]) {
        const perOrbit = run.trail.total / (2.36e6 / run.periodS);
        assert(Math.abs(perOrbit - 256) <= 3,
            `${label}: ${perOrbit.toFixed(1)} points/orbit, expected ~256`);
    }
    assert(Math.abs(lo.trail.total - hi.trail.total) <= 2,
        `point counts diverge with warp: ${lo.trail.total} vs ${hi.trail.total}`);
});

test('trails · geometry is warp-independent (same points, same places)', () => {
    // Two full periods at 100× different warps → point k of each run sits
    // at the same orbital phase. Emission timing is quantized by substep
    // boundaries (≤ targetStep of arc ≈ 0.03% of the orbit), so the match
    // tolerance is a small fraction of the semi-major axis.
    const a_scene = 3.844e8 * 1e-3 / SYSTEMS['earth-moon'].scale_km_per_unit;
    const lo = sampleTrailRun({ warp: 3e5, simSeconds: 4.7e6 });
    const hi = sampleTrailRun({ warp: 3e7, simSeconds: 4.7e6 });
    const n = Math.min(lo.trail.total, hi.trail.total, lo.trail.cap);
    let maxDev = 0;
    for (let k = 0; k < n; k++) {
        // Ring slot of point (total-1-k) counting back from the newest.
        const sl = (((lo.trail.head - k) % lo.trail.cap) + lo.trail.cap) % lo.trail.cap;
        const sh = (((hi.trail.head - k) % hi.trail.cap) + hi.trail.cap) % hi.trail.cap;
        const d = Math.hypot(
            lo.trail.buf[sl*3]   - hi.trail.buf[sh*3],
            lo.trail.buf[sl*3+1] - hi.trail.buf[sh*3+1],
            lo.trail.buf[sl*3+2] - hi.trail.buf[sh*3+2]);
        maxDev = Math.max(maxDev, d);
    }
    // Counts can differ by ±2 (boundary quantization) which offsets the
    // newest-first alignment by up to 2 points — allow one point-spacing
    // (2πa/256) plus the substep quantization above.
    const tol = (2 * Math.PI * a_scene / 256) * 2.5;
    assertBelow(maxDev / a_scene, tol / a_scene,
        `trail deviation between warps (fraction of a, tol ${(tol / a_scene).toFixed(4)})`);
});

test('trails · ring respects capacity and ages out old orbits', () => {
    const { trail } = sampleTrailRun({ warp: 3e7, simSeconds: 2.36e6 * 5 });  // ~5 orbits
    assert(trail.count === trail.cap,
        `ring should be full (${trail.count}/${trail.cap})`);
    assert(trail.total > trail.cap, 'total must keep counting past capacity');
    for (let k = 0; k < trail.cap * 3; k++) {
        assert(Number.isFinite(trail.buf[k]), 'trail buffer has non-finite entries');
    }
});

await runAll();
