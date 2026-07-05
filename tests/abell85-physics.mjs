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

// ══ 3D merger geometry ═══════════════════════════════════════════════════════
const { orbitalBasis, binaryWorldPositions, kickDirection, remnantWorldPosition } =
    await import('../js/abell85/geometry.js');

// ── 17. oriented binary preserves separation, COM, and kick physics ─────────
{
    const sc = makeScenario('holm15a');
    const basis = orbitalBasis(0.5, 0.7);
    // basis orthonormality
    const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
    for (const [u, v] of [[basis.e1, basis.e2], [basis.e1, basis.n], [basis.e2, basis.n]]) {
        assert.ok(Math.abs(dot(u, v)) < 1e-12, 'basis orthogonal');
    }
    for (const u of [basis.e1, basis.e2, basis.n]) {
        assert.ok(Math.abs(Math.hypot(...u) - 1) < 1e-12, 'basis unit');
    }
    // separation and COM invariant under orientation
    const now = { a: 10, e: 0.3, peri: 0.4 };
    const seps = [];
    for (const [i2, n2] of [[0, 0], [0.5, 0.7], [1.2, -2.1]]) {
        const b = orbitalBasis(i2, n2);
        const [p1, p2] = binaryWorldPositions(sc, now, 1.1, b);
        const sep = Math.hypot(p1.p[0] - p2.p[0], p1.p[1] - p2.p[1], p1.p[2] - p2.p[2]);
        seps.push(sep);
        const com = [0, 1, 2].map(k => p1.p[k] * p1.m + p2.p[k] * p2.m);
        assert.ok(Math.hypot(...com) / (sc.mTot * sep) < 1e-12, 'COM at origin');
        assert.ok(sep > 0 && sep < 2 * now.a, `separation sane (${sep})`);
    }
    // Kepler r at fixed phase must not depend on orientation
    for (const s of seps) assert.ok(Math.abs(s - seps[0]) < 1e-9, 'separation orientation-invariant');
    // kick physics: superkick along ±L̂ (out of plane), mass-asymmetry in-plane
    const kSuper = kickDirection('superkick', basis);
    const kPlane = kickDirection('nonspinning', basis);
    assert.ok(Math.abs(dot(kSuper, basis.n)) > 0.999, 'superkick ∥ L̂');
    assert.ok(Math.abs(dot(kPlane, basis.n)) < 1e-12, 'mass-asymmetry kick in-plane');
    // superkicked remnant actually leaves the orbital plane
    const scK = makeScenario('holm15a', { kick: 'superkick', superkickKms: 1500 });
    const hK = buildHistory(scK);
    const rec = hK.samples.find(s => (s.remnantOffset ?? 0) > 1);
    assert.ok(rec, 'recoil samples carry an offset');
    const pos = remnantWorldPosition(scK, hK, { ...rec, t: rec.t + 0.31 / hK.events.recoil.omega * Math.PI / 2 }, basis);
    // offset direction parallel to n̂ (allow sign)
    const pl = Math.hypot(...pos[0].p);
    if (pl > 1e-6) {
        const along = Math.abs(dot(pos[0].p.map(x => x / pl), basis.n));
        assert.ok(along > 0.999, `superkicked remnant moves along L̂ (cos=${along})`);
    }
    ok('3D geometry: orthonormal oriented basis, separation/COM invariant, ' +
        'superkick ∥ L̂ (out of plane), mass-asymmetry kick in-plane');
}

// ══ Merger act: QNM ringdown fits + spin-orbit precession ═══════════════════
const { qnm220, MergerChoreo } = await import('../js/abell85/merger.js');

// ── 18. Berti–Cardoso–Will QNM fits hit the known Kerr values ───────────────
{
    // Schwarzschild ℓ=m=2: Mω ≈ 0.3737, Q ≈ 2.0
    const s = qnm220(0);
    assert.ok(Math.abs(s.Momega - 0.3737) / 0.3737 < 0.02, `Mω(j=0)=${s.Momega}`);
    assert.ok(s.Q > 1.9 && s.Q < 2.3, `Q(j=0)=${s.Q}`);
    // remnant spin ~0.69: Mω ≈ 0.53, Q ≈ 3.2
    const r = qnm220(0.69);
    assert.ok(Math.abs(r.Momega - 0.53) < 0.02, `Mω(0.69)=${r.Momega}`);
    assert.ok(Math.abs(r.Q - 3.2) < 0.3, `Q(0.69)=${r.Q}`);
    // monotone: faster spin → higher frequency, higher Q
    assert.ok(qnm220(0.9).Momega > r.Momega && qnm220(0.9).Q > r.Q);
    ok(`QNM ℓ=m=2 fits: Mω(0)=${s.Momega.toFixed(3)} Q=${s.Q.toFixed(2)}; ` +
        `Mω(0.69)=${r.Momega.toFixed(3)} Q=${r.Q.toFixed(2)}`);
}

// ── 19. spin-orbit simple precession: isometric, correct rate, fixed cone ───
{
    const sc = makeScenario('holm15a', { massModel: 'mehrgan2019' });
    const rg = rGrav(sc.mTot);
    const a = 80 * rg;
    const pn = new PNBinary(sc, { a, e: 0, phase: 0, peri: 0, incl: 0.4, node: 0.3 },
        { pn1: false, rr: false, precess: { chi: 0.7, lambda: 0.45 } });
    const e0 = pn.energy();
    const lHat = () => {
        const L = [
            pn.x[1] * pn.v[2] - pn.x[2] * pn.v[1],
            pn.x[2] * pn.v[0] - pn.x[0] * pn.v[2],
            pn.x[0] * pn.v[1] - pn.x[1] * pn.v[0]];
        const l = Math.hypot(...L);
        return L.map(c => c / l);
    };
    const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
    const j = pn.prec.jHat;
    const cone0 = dot(lHat(), j);
    // expected rate for the circular orbit (r = a, L = μ√(GMa) constant)
    const mu = sc.m1 * sc.m2 / sc.mTot;
    const L = mu * Math.sqrt(G * sc.mTot * a);
    const omegaP = pn.prec.pref * (G / (299792.458 ** 2)) *
        (L + pn.prec.S) / (a ** 3) * KMS_MYR;               // rad/Myr
    const T = 15 * keplerPeriodMyr(a, sc.mTot);
    const l0 = lHat();
    pn.step(T, 1e9);
    // rotation is an isometry → energy contract untouched
    const drift = Math.abs((pn.energy() - e0) / e0);
    assert.ok(drift < 1e-6, `precession energy drift ${drift}`);
    // cone angle L̂·Ĵ conserved
    assert.ok(Math.abs(dot(lHat(), j) - cone0) < 1e-3, 'cone angle fixed');
    // measured precession azimuth about Ĵ vs Ω_p·T
    const perp = (v) => {
        const par = dot(v, j);
        const p = [v[0] - par * j[0], v[1] - par * j[1], v[2] - par * j[2]];
        const l = Math.hypot(...p) || 1;
        return p.map(c => c / l);
    };
    const p0 = perp(l0), p1 = perp(lHat());
    const cross = [
        p0[1] * p1[2] - p0[2] * p1[1],
        p0[2] * p1[0] - p0[0] * p1[2],
        p0[0] * p1[1] - p0[1] * p1[0]];
    let meas = Math.atan2(dot(cross, j), dot(p0, p1));
    const expTot = omegaP * T;
    // unwrap: expected total may exceed π
    const wraps = Math.round((expTot - meas) / (2 * Math.PI));
    meas += wraps * 2 * Math.PI;
    const err = Math.abs(meas - expTot) / expTot;
    assert.ok(err < 0.05, `precession rate err ${(err * 100).toFixed(1)}% (meas ${meas.toFixed(3)} vs ${expTot.toFixed(3)})`);
    ok(`spin-orbit precession: isometric (ΔE/E=${drift.toExponential(1)}), cone fixed, ` +
        `rate matches Ω_p to ${(err * 100).toFixed(1)}% over 15 orbits`);
}

// ── 20. merger choreography state machine ───────────────────────────────────
{
    const sc = makeScenario('holm15a');
    const hist = buildHistory(sc);
    const basis = orbitalBasis(0.4, 0.3);
    const ch = new MergerChoreo(sc, hist);
    assert.equal(ch.state(1000, basis), null, 'idle before trigger');
    ch.trigger(1000);
    const early = ch.state(1200, basis, 0);
    assert.equal(early.phaseName, 'plunge');
    assert.equal(early.bhs.length, 2);
    const late = ch.state(2300, basis, 0);
    const sepE = Math.hypot(...early.bhs[0].p.map((c, k) => c - early.bhs[1].p[k]));
    const sepL = Math.hypot(...late.bhs[0].p.map((c, k) => c - late.bhs[1].p[k]));
    assert.ok(sepL < sepE, 'plunge separation shrinks');
    const ring = ch.state(1000 + 1400 + 800, basis, 0);
    assert.equal(ring.phaseName, 'ringdown');
    assert.equal(ring.bhs.length, 1);
    assert.ok(Math.abs((ring.bhs[0].shadowMod ?? 1) - 1) > 1e-4, 'shadow rings');
    assert.equal(ch.state(1000 + 1400 + 3300, basis, 0), null, 'choreo ends');
    assert.ok(/radiated/.test(ch.bookkeeping()), 'mass bookkeeping string');
    ok(`merger choreography: plunge (2 bodies, sep ↓) → ringdown (Q=${ch.qnm.Q.toFixed(1)} pulse) → done`);
}

console.log(`\nabell85-physics: all ${n} checks passed`);
