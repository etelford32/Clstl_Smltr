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
    dipoleFieldLinePoint, dipoleFieldRatio, mirrorLatitude, lossConeAngle,
    integrateDstEnsemble, findThresholdCrossing, kpToAp, oxygenFraction,
    bouncePeriodSeconds, subsolarPoint, dipoleTiltRad,
    geocoronalDensity, chargeExchangeCrossSection, chargeExchangeLifetimeHours,
    earthOrbit, shueStandoffRe, shueAlpha, shueRadiusRe, bowShockStandoffRe,
    SOLAR, sunDepartureMs, parkerSpiralDeg, sourceRotationDeg,
    carringtonL0, attributeWindSource,
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

// ── Dipole trapped motion ────────────────────────────────────────────────────
{
    // Field line: equator (λ=0) → r = ρ = L, y = 0; footpoint where r = 1.
    const eq = dipoleFieldLinePoint(4, 0);
    assert.ok(Math.abs(eq.r - 4) < 1e-12 && Math.abs(eq.rho - 4) < 1e-12 && eq.y === 0);
    const lamFoot = Math.acos(Math.sqrt(1 / 4));            // r = 1 at cos²λ = 1/L
    assert.ok(Math.abs(dipoleFieldLinePoint(4, lamFoot).r - 1) < 1e-12);
    // Field ratio: 1 at the equator, exactly 2·√4/... : B(60°)/B_eq for the
    // classic check — √(1+3·0.75)/0.5⁶ = √3.25/0.015625.
    assert.ok(Math.abs(dipoleFieldRatio(0) - 1) < 1e-12);
    const lam60 = Math.PI / 3;
    assert.ok(Math.abs(dipoleFieldRatio(lam60) - Math.sqrt(3.25) / 0.5 ** 6) < 1e-9);

    // Mirror latitude: 90° pitch ⇒ equatorially mirroring (λm = 0);
    // smaller α_eq ⇒ deeper mirror; consistency: B(λm)/B_eq = 1/sin²α.
    assert.equal(mirrorLatitude(Math.PI / 2), 0);
    const a45 = mirrorLatitude(Math.PI / 4), a30 = mirrorLatitude(Math.PI / 6);
    assert.ok(a30 > a45 && a45 > 0);
    assert.ok(Math.abs(dipoleFieldRatio(a45) - 2) < 1e-6, 'sin²45° = 1/2 ⇒ B ratio 2');

    // Loss cone shrinks with L and stays in (0, 90°).
    const lc3 = lossConeAngle(3), lc6 = lossConeAngle(6);
    assert.ok(lc3 > lc6 && lc6 > 0 && lc3 < Math.PI / 2);
    // L=3: sin²α = 1/√(4·729 − 3·243) = 1/√2187
    assert.ok(Math.abs(Math.sin(lc3) ** 2 - 1 / Math.sqrt(2187)) < 1e-12);
    ok('dipole: field line geometry, B ratio, mirror latitude, loss cone');
}

// ── Ensemble band, threshold crossing, Kp→ap ─────────────────────────────────
{
    const t0 = 1_700_000_000_000;
    const storm = [];
    for (let m = 0; m <= 6 * 60; m += 1) {
        storm.push({ t: t0 + m * 60_000, v: 600, n: 15, bz: -15 });
    }
    const { central, band } = integrateDstEnsemble(storm, -10);
    assert.equal(band.length, central.length);
    // Band brackets the central track everywhere and widens under driving.
    assert.ok(central.every((p, i) => band[i].lo <= p.dst + 1e-9 && band[i].hi >= p.dst - 1e-9));
    const w0 = band[10].hi - band[10].lo;
    const wEnd = band[band.length - 1].hi - band[band.length - 1].lo;
    assert.ok(wEnd > w0 && wEnd > 10, `band widens: ${w0} → ${wEnd}`);
    // Central run identical to plain integrateDst (scales default to 1).
    const plain = integrateDst(storm, -10);
    assert.ok(Math.abs(plain[plain.length - 1].dst - central[central.length - 1].dst) < 1e-12);
    assert.deepEqual(integrateDstEnsemble([], -10).band, []);

    // Threshold crossing: next threshold below −40 is −50.
    const fc = [
        { t: t0 + 1, dst: -45 }, { t: t0 + 2, dst: -52 }, { t: t0 + 3, dst: -80 },
    ];
    const x = findThresholdCrossing(-40, fc);
    assert.equal(x.threshold, -50);
    assert.equal(x.t, t0 + 2);
    assert.equal(findThresholdCrossing(-40, [{ t: t0, dst: -45 }]), null);  // no crossing
    assert.equal(findThresholdCrossing(-400, fc), null);                    // below all thresholds
    assert.equal(findThresholdCrossing(null, fc), null);

    // Kp→ap: exact NOAA table anchors.
    assert.equal(kpToAp(0), 0);
    assert.equal(kpToAp(4), 27);
    assert.equal(kpToAp(9), 400);
    assert.equal(kpToAp(6.33), 94);   // 6+ → ap 94
    assert.equal(kpToAp(5.67), 67);   // 6− → ap 67
    assert.equal(kpToAp(12), 400);    // clamped
    assert.equal(kpToAp(null), null);
    ok('ensemble band, threshold crossing, Kp→ap');
}

// ── O⁺/H⁺ composition (Phase 2b) ─────────────────────────────────────────────
{
    // Literature anchors (Hamilton 1988; Daglis 1999): quiet ≲10%,
    // moderate ~20–30%, intense ≥45%, never above the 0.64 asymptote.
    assert.ok(Math.abs(oxygenFraction(0) - 0.06) < 1e-12, 'quiet ≈ 6%');
    const f100 = oxygenFraction(-100), f200 = oxygenFraction(-200);
    assert.ok(f100 > 0.25 && f100 < 0.40, `f_O(−100) = ${f100}`);
    assert.ok(f200 > 0.40 && f200 < 0.55, `f_O(−200) = ${f200}`);
    // Monotone in storm depth, bounded.
    let prev = 0;
    for (let d = 0; d >= -600; d -= 20) {
        const f = oxygenFraction(d);
        assert.ok(f >= prev - 1e-12, 'f_O grows with storm depth');
        assert.ok(f >= 0.06 && f < 0.64, `bounded: f_O(${d}) = ${f}`);
        prev = f;
    }
    // Positive Dst* clamps to quiet; null-safe.
    assert.equal(oxygenFraction(25), oxygenFraction(0));
    assert.equal(oxygenFraction(null), oxygenFraction(0));
    ok('composition: quiet 6% → storm ≥45% O⁺, monotone, bounded < 0.64');
}

// ── Physical bounce periods ──────────────────────────────────────────────────
{
    // Anchor: 100 keV H⁺, L=3, equatorial mirror → ≈13 s (Lenchek/Schulz).
    const tH = bouncePeriodSeconds(100, 3, Math.PI / 2, 'ion');
    assert.ok(tH > 11 && tH < 15, `T_b(H⁺ 100 keV, L3) = ${tH}`);
    // O⁺ is √16 = 4× slower at the same energy (relativistic correction ~0).
    const tO = bouncePeriodSeconds(100, 3, Math.PI / 2, 'oxygen');
    assert.ok(Math.abs(tO / tH - 4) < 0.05, `O⁺/H⁺ ratio = ${tO / tH}`);
    // 100 keV electron is RELATIVISTIC (v = 0.548c, not the 0.626c a
    // classical v would give): ≈0.34 s.
    const tE = bouncePeriodSeconds(100, 3, Math.PI / 2, 'electron');
    assert.ok(tE > 0.25 && tE < 0.45, `T_b(e⁻ 100 keV, L3) = ${tE}`);
    // Deeper mirrors bounce slower; period grows with L; null-safe.
    assert.ok(bouncePeriodSeconds(100, 3, 20 * Math.PI / 180, 'ion') > tH);
    assert.ok(Math.abs(bouncePeriodSeconds(100, 6, Math.PI / 2, 'ion') / tH - 2) < 0.01);
    assert.equal(bouncePeriodSeconds(0, 3), null);
    assert.equal(bouncePeriodSeconds(100, -1), null);
    ok('bounce: H⁺ ≈13 s, O⁺ 4×, e⁻ relativistic ≈0.34 s, ∝L, slower off-equator');
}

// ── Subsolar point (accurate Earth) ──────────────────────────────────────────
{
    // Solstices: declination ±23.44°; equinox ≈ 0.
    const jun = subsolarPoint(Date.UTC(2026, 5, 21, 12));
    assert.ok(Math.abs(jun.latDeg - 23.44) < 0.3, `June lat = ${jun.latDeg}`);
    const dec = subsolarPoint(Date.UTC(2026, 11, 21, 12));
    assert.ok(Math.abs(dec.latDeg + 23.44) < 0.3, `Dec lat = ${dec.latDeg}`);
    assert.ok(Math.abs(subsolarPoint(Date.UTC(2026, 2, 20, 12)).latDeg) < 1);
    // Longitude: near 0 at 12 UT (± equation of time ≲ 4°), −90 at 18 UT,
    // wrapped to (−180, 180].
    assert.ok(Math.abs(jun.lonDeg) < 4, `noon lon = ${jun.lonDeg}`);
    const lon18 = subsolarPoint(Date.UTC(2026, 5, 21, 18)).lonDeg;
    assert.ok(Math.abs(lon18 + 90) < 4, `18 UT lon = ${lon18}`);
    for (let h = 0; h < 24; h += 3) {
        const p = subsolarPoint(Date.UTC(2026, 6, 11, h));
        assert.ok(p.lonDeg > -180 && p.lonDeg <= 180 && Math.abs(p.latDeg) < 23.5);
    }
    assert.equal(subsolarPoint(NaN), null);
    ok('subsolar: solstice/equinox declination, EoT-corrected longitude, wrapped');
}

// ── GSM dipole tilt ψ ────────────────────────────────────────────────────────
{
    const deg = ms => dipoleTiltRad(ms) * 180 / Math.PI;
    // Northern-summer solstice: daily max ≈ +33° near ~17 UT (pole meridian
    // 72.7°W faces the Sun); December mirror. Loose bands — the ephemeris
    // and pole position are low-precision by design.
    let mx = -99, mxH = 0, mn = 99;
    for (let h = 0; h < 24; h += 0.25) {
        const v = deg(Date.UTC(2026, 5, 21, 0) + h * 3.6e6);
        if (v > mx) { mx = v; mxH = h; }
    }
    assert.ok(mx > 30 && mx < 37, `June max ψ = ${mx}`);
    assert.ok(Math.abs(mxH - 17) < 2, `June max at ${mxH} UT`);
    for (let h = 0; h < 24; h += 0.25) {
        mn = Math.min(mn, deg(Date.UTC(2026, 11, 21, 0) + h * 3.6e6));
    }
    assert.ok(mn < -30 && mn > -37, `Dec min ψ = ${mn}`);
    // Equinox: |ψ| bounded by the ~11° diurnal wobble and sign flips in a day.
    let eqMax = -99, eqMin = 99;
    for (let h = 0; h < 24; h += 0.25) {
        const v = deg(Date.UTC(2026, 2, 20, 0) + h * 3.6e6);
        eqMax = Math.max(eqMax, v); eqMin = Math.min(eqMin, v);
    }
    assert.ok(eqMax < 16 && eqMin > -16 && eqMax > 0 && eqMin < 0,
        `equinox ψ ∈ [${eqMin}, ${eqMax}]`);
    // ~24 h periodicity.
    const t0 = Date.UTC(2026, 6, 11, 3);
    assert.ok(Math.abs(deg(t0) - deg(t0 + 86400e3)) < 1.5);
    assert.equal(dipoleTiltRad(null), null);
    ok('dipole tilt: ±33° solstice extremes near 17/05 UT, ±11° equinox wobble');
}

// ── Particle lifetimes (loss channels — Sun→surface journey) ─────────────────
{
    // Geocorona: Rairden-ish anchors, monotone thinning outward.
    const n3 = geocoronalDensity(3);
    assert.ok(n3 > 500 && n3 < 1500, `n_H(3) = ${n3}`);
    assert.ok(geocoronalDensity(2) > n3 && n3 > geocoronalDensity(5));
    // σ(E): H⁺ collapses above tens of keV; O⁺ nearly flat through
    // ring-current energies; electrons don't charge-exchange.
    assert.ok(chargeExchangeCrossSection(10, 'ion') >
              5 * chargeExchangeCrossSection(50, 'ion'));
    const oFlat = chargeExchangeCrossSection(100, 'oxygen') /
                  chargeExchangeCrossSection(20, 'oxygen');
    assert.ok(oFlat > 0.7 && oFlat <= 1, `O⁺ flatness = ${oFlat}`);
    assert.equal(chargeExchangeCrossSection(50, 'electron'), null);
    // Lifetime anchors + the two-phase-decay ordering.
    const h50  = chargeExchangeLifetimeHours(50, 3, 'ion');
    const h100 = chargeExchangeLifetimeHours(100, 3, 'ion');
    const o100 = chargeExchangeLifetimeHours(100, 3, 'oxygen');
    assert.ok(h50 > 5 && h50 < 25, `τ_ce(H⁺ 50 keV, L3) = ${h50} h`);
    assert.ok(h100 > 24, `τ_ce(H⁺ 100 keV, L3) = ${h100} h`);
    assert.ok(h100 / o100 > 3, `two-phase decay: H⁺/O⁺ ratio = ${h100 / o100}`);
    // τ ∝ L^3.5 (geocorona power law; σ·v fixed at fixed E).
    const lRatio = chargeExchangeLifetimeHours(50, 5, 'ion') / h50;
    assert.ok(Math.abs(lRatio - Math.pow(5 / 3, 3.5)) < 0.05, `L-scaling ${lRatio}`);
    assert.equal(chargeExchangeLifetimeHours(50, 3, 'electron'), null);
    assert.equal(chargeExchangeLifetimeHours(NaN, 3), null);
    ok('lifetimes: σ(E) shapes, H⁺50@L3 ≈ 12 h, O⁺ ~10× faster, τ ∝ L^3.5');
}

// ── Earth orbit ──────────────────────────────────────────────────────────────
{
    // Perihelion ~Jan 3 (r → 0.9833), aphelion ~Jul 4 (r → 1.0167).
    const peri = earthOrbit(Date.UTC(2026, 0, 3, 12));
    const aph  = earthOrbit(Date.UTC(2026, 6, 4, 12));
    assert.ok(peri.rAU < 0.9835, `perihelion r = ${peri.rAU}`);
    assert.ok(aph.rAU > 1.0165, `aphelion r = ${aph.rAU}`);
    // Equinoxes: heliocentric Earth longitude 180° (Mar) / 0° (Sep).
    const mar = earthOrbit(Date.UTC(2026, 2, 20, 12)).lonDeg;
    assert.ok(Math.abs(mar - 180) < 1.2, `March equinox λ = ${mar}`);
    const sep = earthOrbit(Date.UTC(2026, 8, 23, 12)).lonDeg;
    assert.ok(Math.min(sep, 360 - sep) < 1.2, `Sept equinox λ = ${sep}`);
    // Kepler's second law: true angular motion is SLOWER than the 0.9856°/day
    // mean near aphelion (July) and FASTER near perihelion (January).
    const adv = (m, d) => {
        const p = earthOrbit(Date.UTC(2026, m, d)), q = earthOrbit(Date.UTC(2026, m, d + 10));
        return ((q.lonDeg - p.lonDeg + 360) % 360) / 10;
    };
    const julRate = adv(6, 11), janRate = adv(0, 5);
    assert.ok(julRate < 0.9856 && julRate > 0.94, `aphelion rate = ${julRate}°/d`);
    assert.ok(janRate > 0.9856 && janRate < 1.03, `perihelion rate = ${janRate}°/d`);
    assert.equal(earthOrbit(Date.UTC(2026, 6, 11)).dayOfYear, 192);
    assert.equal(earthOrbit(NaN), null);
    ok('earth orbit: perihelion/aphelion r, equinox longitudes, mean motion');
}

// ── Shue (1998) magnetopause + bow shock ─────────────────────────────────────
{
    // Nominal wind ⇒ ~10.3 R_E nose; classic anchors from the paper's regime.
    const r0n = shueStandoffRe(2, 0);
    assert.ok(r0n > 9.8 && r0n < 10.8, `nominal r₀ = ${r0n}`);
    // Pressure compresses: r₀ ∝ Pdyn^(−1/6.6) exactly.
    assert.ok(Math.abs(shueStandoffRe(20, 0) / r0n - Math.pow(10, -1 / 6.6)) < 1e-9);
    // Southward Bz erodes the dayside further at fixed pressure.
    assert.ok(shueStandoffRe(2, -15) < shueStandoffRe(2, 0));
    assert.ok(shueStandoffRe(2, +10) > shueStandoffRe(2, 0));
    // Extreme storm drives the nose INSIDE geosynchronous orbit (6.6 R_E).
    assert.ok(shueStandoffRe(30, -20) < 6.6, `storm r₀ = ${shueStandoffRe(30, -20)}`);
    // Flaring: α > 0.5 nominally, grows with southward Bz and pressure.
    const aN = shueAlpha(2, 0);
    assert.ok(aN > 0.5 && aN < 0.72, `α = ${aN}`);
    assert.ok(shueAlpha(2, -10) > aN && shueAlpha(10, 0) > aN);
    // Surface shape: r(0) = r₀; monotonically opens toward the flanks.
    assert.equal(shueRadiusRe(0, 10, 0.6), 10);
    assert.ok(shueRadiusRe(1.2, 10, 0.6) > shueRadiusRe(0.6, 10, 0.6));
    // Bow shock sits upstream of the magnetopause by the F&R ratio.
    assert.ok(Math.abs(bowShockStandoffRe(2, 0) / r0n - 1.29) < 1e-9);
    // Null-safety: defaults, no throws.
    assert.ok(Number.isFinite(shueStandoffRe(null, null)));
    ok('Shue: nominal ~10.3 Rᴇ, Pdyn^-1/6.6, Bz erosion, sub-GEO extremes, flaring');
}

// ── 22. Sun→Earth timing: ballistic back-mapping + Parker spiral ────────────
{
    // Photon lag ≈ 8.32 min (1 AU / c).
    assert.ok(Math.abs(SOLAR.LIGHT_LAG_MIN - 8.317) < 0.01, `light lag ${SOLAR.LIGHT_LAG_MIN}`);
    // 400 km/s wind: (AU − L1)/v ≈ 4.28 days before its L1 measurement.
    const t0 = 1.7e12;
    const dep400 = sunDepartureMs(t0, 400);
    const days400 = (t0 - dep400) / 86.4e6;
    assert.ok(Math.abs(days400 - 4.28) < 0.05, `400 km/s → ${days400} d`);
    // Fast wind arrives sooner — the dispersion that smears one solar
    // "moment" over days of reception (the paper question).
    const days620 = (t0 - sunDepartureMs(t0, 620)) / 86.4e6;
    assert.ok(days620 < days400 && Math.abs(days620 - 2.76) < 0.05, `620 → ${days620} d`);
    // Reception window between the two speeds is a MEASURABLE ~1.5 days.
    assert.ok(days400 - days620 > 1.4 && days400 - days620 < 1.7);
    // Parker garden-hose angle: ≈45° near 430 km/s, tighter for fast wind.
    assert.ok(Math.abs(parkerSpiralDeg(429) - 45) < 1.0, `spiral ${parkerSpiralDeg(429)}`);
    assert.ok(parkerSpiralDeg(700) < parkerSpiralDeg(350));
    // Source-longitude sweep: Ω·AU/v — ~61° at 400 km/s, less when fast;
    // consistency: tan(spiral) = rotation (radians) by construction.
    const rot = sourceRotationDeg(400);
    assert.ok(Math.abs(rot - 61.4) < 1.0, `rotation ${rot}`);
    assert.ok(Math.abs(Math.tan(parkerSpiralDeg(400) * Math.PI / 180) - rot * Math.PI / 180) < 1e-9);
    // Null-safety: garbage in ⇒ null out, no throws.
    assert.equal(sunDepartureMs(t0, NaN), null);
    assert.equal(parkerSpiralDeg(0), null);
    assert.equal(sourceRotationDeg(undefined), null);
    ok('Sun→Earth ledger: 8.3 light-min, 4.3 d @ 400 km/s, ~1.5 d dispersion, 45° spiral');
}

// ── 23. Carrington coordinates + coronal-hole attribution ───────────────────
{
    const DAY = 86.4e6;
    const t0 = Date.UTC(2026, 6, 11);   // 2026-07-11
    const { L0, B0 } = carringtonL0(t0);
    assert.ok(L0 >= 0 && L0 < 360 && Number.isFinite(B0));
    // Synodic retrograde rate ≈ 13.2°/day (varies slightly with Earth's
    // orbital speed): check over 10 days.
    const dL = ((L0 - carringtonL0(t0 + 10 * DAY).L0) % 360 + 360) % 360;
    assert.ok(Math.abs(dL / 10 - 13.2) < 0.5, `synodic rate ${(dL / 10).toFixed(2)}°/d`);
    // One Carrington rotation (27.2753 d synodic) returns L0 to ~itself.
    const dRot = ((L0 - carringtonL0(t0 + 27.2753 * DAY).L0) % 360 + 360) % 360;
    assert.ok(dRot < 4 || dRot > 356, `CR period residual ${dRot.toFixed(1)}°`);
    // B0 bounded by the 7.25° solar-equator tilt; known seasonal anchors:
    // ~0° in early June, max ≈ +7.2° early September, min ≈ −7.2° early March.
    for (let k = 0; k < 12; k++) assert.ok(Math.abs(carringtonL0(t0 + k * 30 * DAY).B0) < 7.26);
    assert.ok(Math.abs(carringtonL0(Date.UTC(2026, 5, 6)).B0) < 0.6, 'B0 ≈ 0 near Jun 6');
    assert.ok(carringtonL0(Date.UTC(2026, 8, 8)).B0 > 6.9, 'B0 max near Sep 8');
    assert.ok(carringtonL0(Date.UTC(2026, 2, 5)).B0 < -6.9, 'B0 min near Mar 5');
    // Attribution: fast wind matches a CH within 20° (with wraparound)…
    const holes = [
        { lat_deg: 15, lon_carrington_deg: 358, frm_name: 'SPoCA-CH' },
        { lat_deg: -72, lon_carrington_deg: 3, frm_name: 'SPoCA-CH' },   // polar
    ];
    const hit = attributeWindSource(holes, 2, 600);
    assert.ok(hit.matched && hit.kind === 'coronal-hole');
    // …and the latitude penalty prefers the mid-lat hole over the closer
    // polar one (polar-hole wind mostly misses the ecliptic).
    assert.equal(hit.hole.lat_deg, 15);
    assert.ok(Math.abs(hit.dLonDeg - 4) < 1e-9, `wrap dLon ${hit.dLonDeg}`);
    // Slow wind far from any hole = streamer belt; fast unmatched flagged.
    assert.equal(attributeWindSource(holes, 120, 380).kind, 'streamer-belt');
    assert.equal(attributeWindSource(holes, 120, 650).kind, 'unattributed-fast');
    // Null-safety.
    assert.equal(attributeWindSource([], 10, 500), null);
    assert.equal(attributeWindSource(holes, NaN, 500), null);
    ok('Carrington L0/B0: 13.2°/d synodic, 27.28 d period, B0 seasonal anchors; CH attribution');
}

console.log(`\nring-current-model: all ${n} test groups passed`);
