#!/usr/bin/env node
/**
 * ring-current-model.mjs — pure-Node validation of js/ring-current-model.js
 * against closed-form and literature anchors:
 *
 *   1. DPS constant: W_m ≈ 8.3×10¹⁷ J, W_RC ≈ 4.0×10¹³ J per nT of |Dst*|.
 *   2. O'Brien–McPherron τ(VBs): ≈19.1 h quiet, monotonically decreasing,
 *      ≈7.4 h at 4 mV/m; Q gated at Ec = 0.49 mV/m.
 *   3. Steady state: constant driver ⇒ Dst* → Q·τ (analytic fixed point).
 *   4. Pressure correction round-trip and sign (compression ⇒ Dst* < Dst).
 *   5. Integration: stability under long gaps, quiet-time exponential decay
 *      matches e^(−t/τ) to <1%, storm-driver produces a main phase.
 *   6. Ballistic L1 propagation: ~62.5 min at 400 km/s, arrival-sorted.
 *   7. Drift kinematics: 100 keV ion at L=3 ≈ 2.4 h period, ions westward /
 *      electrons eastward, period ∝ 1/(L·E).
 *   8. Morphology: peak L moves earthward with storm depth; asymmetry grows
 *      with VBs and peaks at 19 MLT; plasmapause matches C&A 1992.
 *   9. Storm classification mirrors api/noaa/dst.js thresholds.
 *  10. Skill: zero for identical series; pairing tolerance respected.
 *
 * Exits 0 on pass, non-zero on failure.
 */

import assert from 'node:assert/strict';
import {
    PHYS, W_MAGNETOSPHERE_J, DPS_J_PER_NT, OBM,
    dynamicPressure, couplingVBs, toDstStar, toDst,
    obmQ, obmTau, burtonQ, stepDstStar, integrateDst,
    propagateToEarth, dpsEnergyJ, ringPeakL, radialProfile,
    asymmetry, azimuthalWeight, driftPeriodHours, driftRateRadPerHour,
    plasmapauseL, stormClass, skill, newellCoupling,
} from '../js/ring-current-model.js';

let n = 0;
const ok = (msg) => { n++; console.log(`  ✓ ${msg}`); };

// ── 1. DPS energy relation ───────────────────────────────────────────────────
{
    assert.ok(W_MAGNETOSPHERE_J > 8.0e17 && W_MAGNETOSPHERE_J < 8.7e17,
        `W_m = ${W_MAGNETOSPHERE_J}`);
    assert.ok(DPS_J_PER_NT > 3.8e13 && DPS_J_PER_NT < 4.2e13,
        `DPS = ${DPS_J_PER_NT}`);
    // −100 nT storm ⇒ ~4×10¹⁵ J
    const w = dpsEnergyJ(-100);
    assert.ok(w > 3.8e15 && w < 4.2e15, `W_RC(−100) = ${w}`);
    assert.equal(dpsEnergyJ(5), 0);       // positive Dst* carries no RC energy
    assert.equal(dpsEnergyJ(null), 0);
    ok('DPS: W_m ≈ 8.3e17 J, ≈4.0e13 J/nT, −100 nT ⇒ ~4e15 J');
}

// ── 2. OBM τ and Q ───────────────────────────────────────────────────────────
{
    const tau0 = obmTau(0);
    assert.ok(Math.abs(tau0 - 2.40 * Math.exp(9.74 / 4.69)) < 1e-9);
    assert.ok(tau0 > 18 && tau0 < 20, `τ(0) = ${tau0}`);
    const tau4 = obmTau(4);
    assert.ok(tau4 > 7 && tau4 < 8, `τ(4) = ${tau4}`);
    let prev = Infinity;
    for (let e = 0; e <= 12; e += 0.5) {
        const t = obmTau(e);
        assert.ok(t < prev, 'τ must decrease monotonically with VBs');
        prev = t;
    }
    assert.equal(obmQ(0.49), 0);           // exactly at cutoff → no injection
    assert.equal(obmQ(0.2), 0);
    assert.ok(Math.abs(obmQ(1.49) - (-4.4)) < 1e-12, 'Q(Ec+1) = a');
    assert.equal(burtonQ(0.3), 0);
    assert.ok(burtonQ(1.5) < 0);
    ok('OBM: τ(0)≈19.1 h → τ(4)≈7.4 h monotone; Q gated at Ec');
}

// ── 3. Steady state = Q·τ ────────────────────────────────────────────────────
{
    const vbs = 3.0;                       // strong steady driving
    const qt  = obmQ(vbs) * obmTau(vbs);   // analytic fixed point
    let d = 0;
    for (let i = 0; i < 4000; i++) ({ dstStar: d } = stepDstStar(d, vbs, 1 / 60));
    assert.ok(Math.abs(d - qt) / Math.abs(qt) < 0.01,
        `steady state ${d} vs analytic ${qt}`);
    assert.ok(qt < -80, 'VBs=3 sustained should be a strong storm');
    ok(`steady state Dst* → Q·τ = ${qt.toFixed(1)} nT under VBs = 3 mV/m`);
}

// ── 4. Pressure correction ───────────────────────────────────────────────────
{
    const pd = dynamicPressure(5, 400);    // ≈1.34 nPa quiet
    assert.ok(Math.abs(pd - 1.67e-6 * 5 * 400 * 400) < 1e-12);
    const star = toDstStar(-40, pd);
    assert.ok(Math.abs(toDst(star, pd) - (-40)) < 1e-9, 'round trip');
    // Higher pressure with same measured Dst ⇒ MORE ring current (deeper Dst*)
    assert.ok(toDstStar(-40, 10) < toDstStar(-40, 1));
    assert.equal(toDstStar(-40, null), -40);   // null-safe passthrough
    assert.equal(dynamicPressure(-1, 400), null);
    ok('pressure correction: round-trip exact, compression deepens Dst*');
}

// ── 5. Integration ───────────────────────────────────────────────────────────
{
    // Quiet decay: no driving, Dst0 = −60 ⇒ pure exponential with τ(0).
    const t0 = 1_700_000_000_000;
    const HOURS = 12;
    const quiet = [];
    for (let m = 0; m <= HOURS * 60; m += 1) {
        quiet.push({ t: t0 + m * 60_000, v: 400, n: 5, bz: 2 });   // northward
    }
    const run = integrateDst(quiet, -60);
    assert.equal(run.length, quiet.length);
    const tau = obmTau(0);
    const want = toDstStar(-60, dynamicPressure(5, 400)) * Math.exp(-HOURS / tau);
    const got  = run[run.length - 1].dstStar;
    assert.ok(Math.abs(got - want) / Math.abs(want) < 0.01,
        `quiet decay ${got} vs analytic ${want}`);
    assert.ok(run.every(r => Number.isFinite(r.dst) && Number.isFinite(r.tau)));

    // Storm: 6 h of v=600, Bz=−15 (VBs = 9 mV/m) must drive a main phase.
    const storm = [];
    for (let m = 0; m <= 6 * 60; m += 1) {
        storm.push({ t: t0 + m * 60_000, v: 600, n: 15, bz: -15 });
    }
    const srun = integrateDst(storm, -10);
    const deepest = Math.min(...srun.map(r => r.dst));
    assert.ok(deepest < -100, `main phase should exceed −100 nT, got ${deepest}`);

    // Long-gap stability: a 4-hour hole must not blow up (semi-implicit).
    const gappy = [
        { t: t0,               v: 500, n: 8, bz: -10 },
        { t: t0 + 4 * 3.6e6,   v: 500, n: 8, bz: -10 },
        { t: t0 + 4 * 3.6e6 + 60_000, v: 400, n: 5, bz: 1 },
    ];
    const grun = integrateDst(gappy, -20);
    assert.ok(grun.every(r => Number.isFinite(r.dstStar) && r.dstStar > -500 && r.dstStar < 100));

    // Degenerate inputs
    assert.deepEqual(integrateDst([], -20), []);
    assert.deepEqual(integrateDst(quiet, NaN), []);
    ok('integration: quiet decay <1% of analytic, storm main phase, gap-stable');
}

// ── 6. L1 ballistic propagation ──────────────────────────────────────────────
{
    const t0 = 1_700_000_000_000;
    const p = propagateToEarth([{ t: t0, v: 400, n: 5, bz: 0 }]);
    const delayMin = (p[0].tArrive - t0) / 60_000;
    assert.ok(Math.abs(delayMin - 62.5) < 0.1, `delay = ${delayMin} min`);
    // Faster wind arrives sooner; output sorted by arrival.
    const two = propagateToEarth([
        { t: t0,          v: 300, n: 5, bz: 0 },
        { t: t0 + 60_000, v: 800, n: 5, bz: 0 },
    ]);
    assert.ok(two[0].v === 800 && two[0].tArrive < two[1].tArrive);
    // Invalid speed falls back to 400 km/s rather than exploding.
    const bad = propagateToEarth([{ t: t0, v: null, n: 5, bz: 0 }]);
    assert.ok(Math.abs((bad[0].tArrive - t0) / 60_000 - 62.5) < 0.1);
    ok('ballistic: 62.5 min at 400 km/s, arrival-sorted, null-speed fallback');
}

// ── 7. Drift kinematics ──────────────────────────────────────────────────────
{
    const T = driftPeriodHours(100, 3);
    assert.ok(T > 2.2 && T < 2.7, `T_d(100 keV, L=3) = ${T} h`);
    // T ∝ 1/(L·E)
    assert.ok(Math.abs(driftPeriodHours(200, 3) - T / 2) < 1e-9);
    assert.ok(Math.abs(driftPeriodHours(100, 6) - T / 2) < 1e-9);
    assert.ok(driftRateRadPerHour(100, 3, 'ion') < 0, 'ions westward');
    assert.ok(driftRateRadPerHour(100, 3, 'electron') > 0, 'electrons eastward');
    assert.equal(driftPeriodHours(0, 3), null);
    ok('drift: ~2.4 h for 100 keV @ L=3, ∝1/(L·E), ions W / electrons E');
}

// ── 8. Morphology ────────────────────────────────────────────────────────────
{
    assert.ok(Math.abs(ringPeakL(0) - 4.0) < 1e-9);
    assert.ok(ringPeakL(-100) < ringPeakL(-30));
    assert.ok(ringPeakL(-300) > 2.4 && ringPeakL(-300) < 2.7);
    // Profile peaks where it should and vanishes at the atmosphere.
    const dst = -80;
    const pk = ringPeakL(dst);
    assert.ok(radialProfile(pk, dst) > radialProfile(pk + 1.5, dst));
    assert.ok(radialProfile(pk, dst) > radialProfile(pk - 1.0, dst));
    assert.equal(radialProfile(1.0, dst), 0);
    assert.ok(radialProfile(8.5, dst) < 0.01);

    const quiet = asymmetry(0), storm = asymmetry(8);
    assert.equal(quiet.amplitude, 0);
    assert.ok(storm.amplitude > 0.6 && storm.amplitude <= 0.85);
    assert.ok(azimuthalWeight(19, storm) > azimuthalWeight(7, storm),
        'dusk-side weight exceeds dawn during driving');
    assert.ok(Math.abs(azimuthalWeight(19, storm) - (1 + storm.amplitude)) < 1e-9);

    assert.ok(Math.abs(plasmapauseL(2) - (5.6 - 0.92)) < 1e-9);
    assert.equal(plasmapauseL(9), 1.8);   // clamped
    ok('morphology: peak L earthward with depth, dusk asymmetry, C&A Lpp');
}

// ── 9. Storm classification (mirrors api/noaa/dst.js) ────────────────────────
{
    assert.equal(stormClass(-10).level, 0);
    assert.equal(stormClass(-30).level, 1);
    assert.equal(stormClass(-50).level, 2);
    assert.equal(stormClass(-100).level, 3);
    assert.equal(stormClass(-200).level, 4);
    assert.equal(stormClass(-350).level, 5);
    assert.equal(stormClass(null).label, 'None');
    ok('classification thresholds mirror api/noaa/dst.js');
}

// ── 10. Skill ────────────────────────────────────────────────────────────────
{
    const t0 = 1_700_000_000_000;
    const m  = Array.from({ length: 25 }, (_, i) => ({ t: t0 + i * 3.6e6, dst: -20 - i }));
    const o  = m.map(r => ({ t: r.t, dst: r.dst }));
    const s1 = skill(m, o);
    assert.equal(s1.n, 25);
    assert.ok(Math.abs(s1.rmse) < 1e-9 && Math.abs(s1.bias) < 1e-9);
    // Constant +5 model offset ⇒ rmse = 5, bias = +5.
    const s2 = skill(m.map(r => ({ t: r.t, dst: r.dst + 5 })), o);
    assert.ok(Math.abs(s2.rmse - 5) < 1e-9 && Math.abs(s2.bias - 5) < 1e-9);
    // Out-of-tolerance observations are skipped, not mispaired.
    const far = skill(m, [{ t: t0 + 200 * 3.6e6, dst: -30 }]);
    assert.equal(far.n, 0);
    ok('skill: exact zero on identity, offset recovered, tolerance respected');
}

// ── VBs coupling sanity ──────────────────────────────────────────────────────
{
    assert.equal(couplingVBs(400, 5), 0);            // northward ⇒ no coupling
    assert.ok(Math.abs(couplingVBs(500, -10) - 5) < 1e-12);  // 500·10·1e-3
    assert.equal(couplingVBs(null, -5), null);
    ok('VBs: northward gated to 0; 500 km/s × −10 nT = 5 mV/m');
}

// ── Newell (2007) coupling ───────────────────────────────────────────────────
{
    assert.equal(newellCoupling(400, 0, 8), 0);      // due north ⇒ zero
    // Due south: dΦ/dt = v^(4/3)·|Bz|^(2/3) exactly (sin(π/2) = 1).
    const south = newellCoupling(400, 0, -10);
    assert.ok(Math.abs(south - Math.pow(400, 4 / 3) * Math.pow(10, 2 / 3)) < 1e-6);
    // Monotonic in southward |Bz| and in v.
    assert.ok(newellCoupling(400, 0, -20) > south);
    assert.ok(newellCoupling(800, 0, -10) > south);
    // Pure By still couples (θc = π/2): factor sin(π/4)^(8/3) ≈ 0.397.
    const byOnly = newellCoupling(400, 10, 0);
    assert.ok(byOnly > 0 && byOnly < south);
    assert.ok(Math.abs(byOnly / (Math.pow(400, 4 / 3) * Math.pow(10, 2 / 3)) -
        Math.pow(Math.SQRT1_2, 8 / 3)) < 1e-9);
    // Null-safe: missing By treated as 0, missing v/Bz → null.
    assert.equal(newellCoupling(400, null, 8), 0);
    assert.equal(newellCoupling(null, 0, -5), null);
    ok('Newell: north-gated, exact due-south form, By quadrature, monotone');
}

console.log(`\nring-current-model: all ${n} test groups passed`);
