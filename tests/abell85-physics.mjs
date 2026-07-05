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

console.log(`\nabell85-physics: all ${n} checks passed`);
