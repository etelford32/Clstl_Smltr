#!/usr/bin/env node
/**
 * abell85-physics.mjs — pure-Node validation of the semi-analytic SMBH binary
 * engine in js/abell85/physics.js against closed-form / literature anchors:
 *
 *   1. Hard-binary separation a_h = G m2 / 4σ² matches hand calculation.
 *   2. Peters (1964) ODE integration reproduces the closed-form circular
 *      coalescence time t_c = a⁴/(4β) to <2%.
 *   3. Remnant fits: q=1 non-spinning → E_rad ≈ 4.5–5.2%, a_f ≈ 0.686,
 *      kick = 0; q≈0.36 kick within 120–250 km/s (González+ 2007 fit peak).
 *   4. Holm 15A history: reverse-engineered progenitor total exceeds the
 *      measured remnant mass; history coalesces (with default triaxial
 *      refill), a(t) is monotonically non-increasing to merger, expected
 *      scouring deficit lands in the literature band 0.3–1.2 M_bin.
 *   5. B2 0402+379 control: with a depleted loss cone the model must STALL
 *      (no merger within the Hubble cap) — the final-parsec problem.
 *   6. GW frequency at plunge for a 4×10¹⁰ M☉ binary lands near 110 nHz
 *      (PTA band), per f_ISCO ≈ 4.4 kHz · (M☉/M).
 *
 * Exits 0 on pass, non-zero on failure.
 */

import assert from 'node:assert/strict';
import {
    makeScenario, buildHistory, sampleAt, STAGE,
    petersBeta, petersDaDt, petersDeDt, petersTcMyr,
    radiatedFraction, remnantSpin, recoilKick,
} from '../js/abell85/physics.js';
import { G, KMS_MYR, fGwHz } from '../js/abell85/units.js';

let n = 0;
const ok = (msg) => { n++; console.log(`  ✓ ${msg}`); };

// ── 1. hard-binary separation ────────────────────────────────────────────────
{
    const sc = makeScenario('holm15a', { massModel: 'mehrgan2019' });
    const aHandExpected = G * sc.m2 / (4 * sc.sigma * sc.sigma);
    assert.ok(Math.abs(sc.aHard - aHandExpected) / aHandExpected < 1e-12);
    // Mehrgan mass model: m2 ≈ 2.1e10 → a_h ≈ 180 pc at σ = 346
    assert.ok(sc.aHard > 120 && sc.aHard < 260, `a_h = ${sc.aHard}`);
    ok(`a_h = ${sc.aHard.toFixed(0)} pc for Holm 15A (2019 mass model)`);
}

// ── 2. Peters ODE vs closed form ─────────────────────────────────────────────
{
    const m1 = 2e10, m2 = 2e10;
    const beta = petersBeta(m1, m2);
    const a0 = 0.5;                       // pc, circular
    const tcClosed = petersTcMyr(a0, m1, m2);
    let a = a0, t = 0;
    while (a > 1e-4 * a0) {
        const da = petersDaDt(a, 0, beta);
        const dt = Math.min(Math.abs(0.002 * a / da), tcClosed / 100);
        a += da * dt; t += dt;
    }
    const err = Math.abs(t - tcClosed) / tcClosed;
    assert.ok(err < 0.02, `Peters ODE vs closed form err=${(err * 100).toFixed(2)}%`);
    ok(`Peters ODE reproduces t_c = ${tcClosed.toFixed(1)} Myr within ${(err * 100).toFixed(2)}%`);

    // eccentricity must decay (circularization)
    const de = petersDeDt(0.5, 0.6, m1, m2);
    assert.ok(de < 0);
    ok('eccentricity decays under GW emission (circularization)');
}

// ── 3. remnant fits ──────────────────────────────────────────────────────────
{
    const etaEq = 0.25;
    const eRad = radiatedFraction(etaEq);
    assert.ok(eRad > 0.043 && eRad < 0.052, `E_rad = ${eRad}`);
    const af = remnantSpin(etaEq);
    assert.ok(Math.abs(af - 0.686) < 0.01, `a_f = ${af}`);
    assert.equal(recoilKick(etaEq, 'nonspinning'), 0);
    const q = 0.36, etaQ = q / ((1 + q) * (1 + q));
    const vk = recoilKick(etaQ, 'nonspinning');
    assert.ok(vk > 120 && vk < 250, `kick(q=0.36) = ${vk}`);
    ok(`remnant: E_rad=${(eRad * 100).toFixed(1)}%, a_f=${af.toFixed(3)}, ` +
        `kick(q=1)=0, kick(q=0.36)=${vk.toFixed(0)} km/s`);
}

// ── 4. Holm 15A reconstructed history ────────────────────────────────────────
{
    const sc = makeScenario('holm15a');
    assert.ok(sc.mTot > sc.mRemnantObs, 'progenitor total > measured remnant');
    const hist = buildHistory(sc);
    assert.ok(!hist.events.stalled, 'default Holm 15A history must coalesce');
    assert.ok(hist.events.merger !== undefined);
    assert.ok(hist.events.merger < 0, 'merger happened before the present');

    // monotonic non-increasing separation up to merger
    let prev = Infinity, monotone = true;
    for (const s of hist.samples) {
        if (s.t > hist.events.merger) break;
        if (s.a > prev + 1e-9) { monotone = false; break; }
        prev = s.a;
    }
    assert.ok(monotone, 'a(t) monotonically non-increasing to merger');

    // expected scouring deficit in the literature band (Merritt 2006: ~0.5 M_bin)
    const atMerge = sampleAt(hist, hist.events.merger);
    const frac = atMerge.mej / sc.mTot;
    assert.ok(frac > 0.3 && frac < 1.2, `M_ej/M_bin = ${frac.toFixed(2)}`);

    // remnant mass equals the observed (measured) mass by construction
    const rel = Math.abs(hist.events.remnant.mass - sc.mRemnantObs) / sc.mRemnantObs;
    assert.ok(rel < 1e-6, `remnant mass reproduces observation (rel=${rel})`);
    ok(`Holm 15A: binary ${(sc.mTot / 1e10).toFixed(2)}e10 → merger at ` +
        `${(hist.events.merger / 1000).toFixed(2)} Gyr, M_ej/M_bin=${frac.toFixed(2)}, ` +
        `remnant=${(hist.events.remnant.mass / 1e10).toFixed(2)}e10 M☉`);
}

// ── 5. B2 0402+379 stall control ─────────────────────────────────────────────
{
    const sc = makeScenario('b20402');
    const hist = buildHistory(sc);
    assert.ok(hist.events.stalled, 'depleted loss cone must stall (final-parsec problem)');
    // rebased: t=0 is "today" at a0 = 7.3 pc
    const now = sampleAt(hist, 0);
    assert.ok(Math.abs(now.a - 7.3) / 7.3 < 0.25, `a(today) = ${now.a.toFixed(1)} pc`);
    ok(`B2 0402+379 control stalls at a = ${hist.events.stalledAt.a.toFixed(1)} pc (no merger in 14 Gyr)`);
}

// ── 6. plunge GW frequency in the PTA band ───────────────────────────────────
{
    const sc = makeScenario('holm15a', { massModel: 'mehrgan2019' });
    const f = fGwHz(sc.aPlunge, sc.mTot);
    // f_ISCO ≈ 4.4 kHz/(M/M☉) ≈ 105 nHz for 4.2×10¹⁰ M☉ — accept the band
    assert.ok(f > 3e-8 && f < 4e-7, `f_gw(plunge) = ${f}`);
    ok(`f_gw at plunge = ${(f * 1e9).toFixed(0)} nHz — inside the PTA band, below LISA`);
}

// ── 7. Abell 402 forward run reaches merger in a plausible future ────────────
{
    const sc = makeScenario('a402');
    const hist = buildHistory(sc);
    assert.ok(!hist.events.stalled, 'triaxial refill drives A402 pair to coalescence');
    assert.ok(hist.events.merger > 0, 'merger lies in the future');
    assert.ok(hist.events.merger < 14000, `merger at +${(hist.events.merger / 1000).toFixed(1)} Gyr`);
    const now = sampleAt(hist, 0);
    assert.ok(Math.abs(now.a - sc.a0) / sc.a0 < 0.25, `a(today) = ${now.a.toFixed(0)} pc`);
    ok(`A402 pair: today a≈${now.a.toFixed(0)} pc → merger at +${(hist.events.merger / 1000).toFixed(2)} Gyr`);
}

// ══ Phase 2: live post-Newtonian endgame — validation contract ══════════════
const { PNBinary, gwPowerSpecific } = await import('../js/abell85/pn.js');
const { StarCluster } = await import('../js/abell85/nbody.js');
const { rGrav, keplerPeriodMyr } = await import('../js/abell85/units.js');

// ── 8. integrator: pure-Kepler energy conservation ───────────────────────────
{
    const sc = makeScenario('holm15a', { massModel: 'mehrgan2019' });
    const rg = rGrav(sc.mTot);
    const pn = new PNBinary(sc, { a: 400 * rg, e: 0.4, phase: 0.3, peri: 0.1, incl: 0.4 },
        { pn1: false, rr: false });
    const e0 = pn.energy();
    pn.step(40 * keplerPeriodMyr(400 * rg, sc.mTot), 1e9);
    const drift = Math.abs((pn.energy() - e0) / e0);
    assert.ok(drift < 1e-6, `Kepler energy drift ${drift}`);
    assert.ok(pn.orbits >= 39, `completed ${pn.orbits} orbits`);
    ok(`RK4 integrator: |ΔE/E| = ${drift.toExponential(1)} over ${pn.orbits} Kepler orbits`);
}

// ── 9. 1PN periapsis advance vs Δϖ = 6πGM/(c²a(1−e²)) ──────────────────────
{
    const sc = makeScenario('holm15a', { massModel: 'mehrgan2019' });
    const rg = rGrav(sc.mTot);
    const a = 300 * rg;
    const pn = new PNBinary(sc, { a, e: 0.3, phase: 0, peri: 0, incl: 0.3 },
        { pn1: true, rr: false });
    pn.step(12 * keplerPeriodMyr(a, sc.mTot), 1e9);
    assert.ok(pn.orbits >= 8, `orbits = ${pn.orbits}`);
    assert.ok(pn.measuredAdvance !== null, 'apsidal advance measured');
    const theory = pn.theoryAdvance();
    const err = Math.abs(pn.measuredAdvance - theory) / theory;
    assert.ok(pn.measuredAdvance > 0, 'prograde precession');
    assert.ok(err < 0.03, `1PN advance err ${(err * 100).toFixed(2)}%`);
    ok(`1PN apsidal advance: measured ${(pn.measuredAdvance * 180 / Math.PI).toFixed(3)}° ` +
        `vs theory ${(theory * 180 / Math.PI).toFixed(3)}° per orbit (err ${(err * 100).toFixed(1)}%)`);
}

// ── 10. 2.5PN radiation reaction vs Peters orbit-averaged decay ─────────────
{
    const sc = makeScenario('holm15a', { massModel: 'mehrgan2019' });
    const rg = rGrav(sc.mTot);
    const a0 = 60 * rg, e0 = 0.2;
    // pn1 off: 1PN makes the *Newtonian osculating* a wobble at the (v/c)²
    // ≈ 1.7% level, which would contaminate the ~2% decay signal — the RR
    // term must be validated in isolation.
    const pn = new PNBinary(sc, { a: a0, e: e0, phase: 0, peri: 0, incl: 0 },
        { pn1: false, rr: true });
    const span = 30 * keplerPeriodMyr(a0, sc.mTot);
    pn.step(span, 1e9);
    const aPn = pn.elements().a;
    // Peters reference over the same span
    const beta = petersBeta(sc.m1, sc.m2);
    let aP = a0, eP = e0, t = 0;
    while (t < span) {
        const dt = span / 4000;
        aP += petersDaDt(aP, eP, beta) * dt;
        eP = Math.max(0, eP + petersDeDt(aP, eP, sc.m1, sc.m2) * dt);
        t += dt;
    }
    const dPn = a0 - aPn, dPe = a0 - aP;
    const err = Math.abs(dPn - dPe) / dPe;
    assert.ok(dPn > 0, 'RR shrinks the orbit');
    assert.ok(err < 0.12, `RR vs Peters decay err ${(err * 100).toFixed(1)}%`);
    ok(`2.5PN decay over ${pn.orbits} orbits: Δa(PN)=${(dPn / rg).toFixed(2)} r_g ` +
        `vs Peters ${(dPe / rg).toFixed(2)} r_g (err ${(err * 100).toFixed(1)}%)`);
    // GW power bookkeeping is negative (energy loss)
    assert.ok(gwPowerSpecific(sc.m1, sc.m2, a0, e0) < 0);
}

// ── 11. loss-cone classification ─────────────────────────────────────────────
{
    const sc = makeScenario('holm15a');
    const cl = new StarCluster(sc, 2048, 7);
    const { nCone, lLc } = cl.classify(sc.mTot, 100);
    assert.ok(lLc > 0, 'L_lc positive');
    assert.ok(nCone > 0 && nCone < cl.n, `nCone = ${nCone}`);
    const hist = cl.lHistogram(lLc);
    assert.ok(hist.nTotal > 0, 'histogram populated');
    // shrinking a shrinks the cone
    const tighter = cl.classify(sc.mTot, 1);
    assert.ok(tighter.nCone <= nCone, 'cone drains as a decreases');
    // merged → cone cleared
    const cleared = cl.classify(0, 0);
    assert.equal(cleared.nCone, 0);
    ok(`loss cone: ${nCone}/${cl.n} stars inside L_lc at a=100 pc; ` +
        `${tighter.nCone} at a=1 pc; cleared on merge`);
}

// ══ Phase 3: observables layer ═══════════════════════════════════════════════
const {
    surfaceDensity, initialSurfaceDensity, cuspRadius,
    losKinematics, sigmaLosProfile, ptaSensitivity,
} = await import('../js/abell85/observables.js');

// ── 12. photometry: core carving grows the measured cusp radius ─────────────
{
    const sc = makeScenario('holm15a');
    const cl = new StarCluster(sc, 8192, 21);
    const prof0 = surfaceDensity(cl);
    const rg0 = cuspRadius(prof0);
    // carve a 1.0 M_bin deficit and re-measure
    cl.reset(1.0 * sc.mTot, true);
    const rg1 = cuspRadius(surfaceDensity(cl));
    assert.ok(Number.isFinite(rg1), 'carved r_γ measurable');
    assert.ok(!Number.isFinite(rg0) || rg1 > rg0,
        `carving grows r_γ (${rg0} → ${rg1})`);
    // initial analytic curve exists and is monotonically falling overall
    const init = initialSurfaceDensity(sc, cl.rMax);
    const first = init.find(p => p.sigma > 0), last = [...init].reverse().find(p => p.sigma > 0);
    assert.ok(first.sigma > last.sigma, 'Σ falls outward');
    ok(`photometry: r_γ ${Number.isFinite(rg0) ? (rg0).toFixed(0) + ' pc' : 'n/a'} → ` +
        `${rg1.toFixed(0)} pc after 1 M_bin scouring`);
}

// ── 13. kinematics: isotropic cluster → near-zero mean LOS field, sane σ ────
{
    const sc = makeScenario('holm15a');
    const cl = new StarCluster(sc, 8192, 33);
    const kin = losKinematics(cl, 2 * sc.rInfl);
    let sumV = 0, nPix = 0;
    for (let k = 0; k < kin.v.length; k++) {
        if (Number.isFinite(kin.v[k])) { sumV += kin.v[k]; nPix++; }
    }
    assert.ok(nPix > 40, `populated pixels ${nPix}`);
    assert.ok(Math.abs(sumV / nPix) < 120, `net LOS motion ~0 (got ${(sumV / nPix).toFixed(1)})`);
    const { central } = sigmaLosProfile(cl);
    assert.ok(central > sc.sigma * 0.3 && central < sc.sigma * 2.5,
        `σ_LOS central ${central.toFixed(0)} vs host σ ${sc.sigma}`);
    ok(`kinematics: ${nPix} IFU pixels, ⟨v_LOS⟩ ≈ ${(sumV / nPix).toFixed(0)} km/s, ` +
        `σ_LOS(0) = ${central.toFixed(0)} km/s (host σ = ${sc.sigma})`);
}

// ── 14. PTA sensitivity curve shape ──────────────────────────────────────────
{
    assert.ok(ptaSensitivity(4e-9) < ptaSensitivity(4e-10), 'low-f degrades');
    assert.ok(ptaSensitivity(4e-9) < ptaSensitivity(1e-7), 'high-f degrades');
    assert.ok(ptaSensitivity(4e-9) > 1e-15 && ptaSensitivity(4e-9) < 5e-15, 'anchored ~2e-15');
    ok('PTA sensitivity curve: minimum near 4 nHz at ~2e-15, degrading both ways');
}

// ══ Merger Twins: τ-sync (merger-relative time) ══════════════════════════════
const { tauOf, tAt, buildTauAxis, eventsTau, indexOfTau } =
    await import('../js/abell85/twinsync.js');

// ── 15. τ-sync maps coalescences together and "today" apart ─────────────────
{
    const hA = buildHistory(makeScenario('a402'));
    const hH = buildHistory(makeScenario('holm15a'));
    // τ = 0 is each system's own merger
    assert.ok(Math.abs(tauOf(hA, hA.events.merger)) < 1e-9);
    assert.ok(Math.abs(tauOf(hH, hH.events.merger)) < 1e-9);
    assert.ok(Math.abs(tAt(hA, 0) - hA.events.merger) < 1e-6);
    // merged axis is strictly increasing and spans both systems
    const axis = buildTauAxis([hA, hH]);
    assert.ok(axis.length > hA.samples.length * 0.5 + hH.samples.length * 0.5);
    for (let i = 1; i < axis.length; i++) assert.ok(axis[i] > axis[i - 1]);
    // each system's "today" marker: A402's lies before coalescence (its merger
    // is in the future), Holm 15A's after (its merger is in the past)
    const todayA = eventsTau(hA).find(e => e.today).tau;
    const todayH = eventsTau(hH).find(e => e.today).tau;
    assert.ok(todayA < 0 && Math.abs(todayA + hA.events.merger) < 1e-9, `A402 today τ=${todayA}`);
    assert.ok(todayH > 0 && Math.abs(todayH - (-hH.events.merger)) < 1e-9, `Holm today τ=${todayH}`);
    // index lookup round-trips
    const i0 = indexOfTau(axis, 0);
    assert.ok(Math.abs(axis[i0]) < 50, `axis has a point near τ=0 (got ${axis[i0]})`);
    // clamping: far-future τ clamps to each history's end
    const tEndA = hA.samples[hA.samples.length - 1].t;
    assert.equal(tAt(hA, 1e7), tEndA);
    ok(`τ-sync: A402 today at τ=${(todayA / 1000).toFixed(2)} Gyr, ` +
        `Holm 15A today at τ=+${(todayH / 1000).toFixed(2)} Gyr, ` +
        `merged axis ${axis.length} samples`);
}

console.log(`\nabell85-physics: all ${n} checks passed`);
