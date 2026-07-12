#!/usr/bin/env node
/**
 * ring-current-inspector.mjs — pure-Node validation of the Phase-1 particle
 * inspector (js/ring-current-inspector.js) against the model functions and
 * the particlePose reference:
 *
 *   1. MLT convention: θ=0 noon, θ=π midnight, θ=−π/2 dusk, θ=+π/2 dawn.
 *   2. inspectParticle agrees with the stored kinematics AND the closed
 *      forms they were built from (drift period, bounce period, τ_CE).
 *   3. predictParticle position forecast is exactly particlePose at the
 *      target sim-hours; verifyPrediction scores it ✓ with ΔMLT ≈ 0.
 *   4. Survival: prediction past the drawn lifetime says dead, and the
 *      verifier confirms; P(survive) = exp(−Δt/τ_CE).
 *   5. verifyPrediction stays null (pending) before the target.
 *   6. renderInspectorHtml carries the load-bearing numbers.
 *
 * Exits 0 on pass, non-zero on failure.
 */

import assert from 'node:assert/strict';
import { buildPopulation, particlePose, DEATH_WINDOW } from '../js/ring-current-particles.js';
import {
    driftPeriodHours, bouncePeriodSeconds, chargeExchangeLifetimeHours,
} from '../js/ring-current-model.js';
import {
    mltFromTheta, inspectParticle, predictParticle, verifyPrediction,
    renderInspectorHtml,
} from '../js/ring-current-inspector.js';

let n = 0;
const ok = (msg) => { n++; console.log(`  ✓ ${msg}`); };

// Deterministic rng (mulberry32) so every run inspects the same particles.
function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const ions = buildPopulation(64, 'ion', rng(7));
const oxy  = buildPopulation(64, 'oxygen', rng(11));
const elec = buildPopulation(64, 'electron', rng(13));

// ── 1. MLT convention ────────────────────────────────────────────────────────
{
    assert.equal(mltFromTheta(0), 12, 'θ=0 (sunward) = noon');
    assert.equal(mltFromTheta(Math.PI), 0, 'θ=π = midnight');
    assert.equal(mltFromTheta(-Math.PI / 2), 18, 'θ=−π/2 = dusk');
    assert.equal(mltFromTheta(Math.PI / 2), 6, 'θ=+π/2 = dawn');
    // Westward drift (ion θ increasing from midnight) sweeps toward dusk —
    // the partial-ring direction.
    const later = mltFromTheta(Math.PI + 0.5);
    assert.ok(later > 18 || later < 0.1, `midnight + westward drift heads duskward (${later.toFixed(1)} MLT)`);
    ok('MLT: noon/midnight/dusk/dawn mapping + westward sweep');
}

// ── 2. Inspection agrees with kinematics AND closed forms ──────────────────
{
    const i = 5, simH = 3.2, bSec = 41.7;
    const d = inspectParticle(ions, 'ionsH', i, simH, bSec);
    assert.ok(Math.abs(d.driftPeriodH - driftPeriodHours(d.eKev, d.L)) / d.driftPeriodH < 1e-6,
        'drift period from stored kin ≡ closed form (float32 attribute precision)');
    assert.ok(d.bouncePeriodS > 1 && d.bouncePeriodS < 600, `bounce period sane (${d.bouncePeriodS.toFixed(1)} s)`);
    const tau = chargeExchangeLifetimeHours(d.eKev, d.L, 'ion');
    assert.ok(Math.abs(d.tauCEH - tau) / tau < 1e-9, 'τ_CE matches the model at (E, L)');
    assert.ok(d.ageH >= 0 && d.ageH <= d.lifetimeH, 'age within lifetime');
    assert.equal(inspectParticle(elec, 'electrons', 3, simH, bSec).tauCEH, null,
        'electrons carry no τ_CE (nominal scattering, labeled)');
    assert.equal(inspectParticle(elec, 'electrons', 3, simH, bSec).driftDir, 'eastward');
    // O⁺ dies faster than H⁺ at the same (E, L) — the two-phase decay.
    assert.ok(chargeExchangeLifetimeHours(100, 3.5, 'oxygen') <
              chargeExchangeLifetimeHours(100, 3.5, 'ion'),
        'O⁺ τ_CE < H⁺ τ_CE at 100 keV');
    ok('inspection: stored kinematics ≡ closed forms; species semantics right');
}

// ── 3. Position forecast is the reference pose; verifier scores ✓ ───────────
{
    // Pick a particle with plenty of life left so the +1 h forecast survives.
    const simH = 1.0, bSec = 10;
    let i = -1;
    for (let c = 0; c < ions.count; c++) {
        const d = inspectParticle(ions, 'ionsH', c, simH, bSec);
        if (d.remainH > 3) { i = c; break; }
    }
    assert.ok(i >= 0, 'found a long-lived test particle');
    const pred = predictParticle(ions, 'ionsH', i, simH, bSec, 1.0);
    assert.ok(pred.survives, 'predicts survival with >3 h remaining');
    const q = particlePose(ions, i, simH + 1.0, bSec);
    assert.ok(Math.abs(pred.pose.x - q.x) < 1e-12 && Math.abs(pred.pose.z - q.z) < 1e-12,
        'position forecast ≡ particlePose at target — the shader will draw it there');
    assert.ok(Math.abs(pred.mlt - mltFromTheta(q.theta)) < 1e-12, 'MLT forecast consistent');
    assert.equal(verifyPrediction(pred, ions, simH + 0.5, bSec), null, 'pending before target');
    const v = verifyPrediction(pred, ions, simH + 1.0, bSec);
    assert.ok(v.ok && v.aliveAtTarget, 'verifier scores the forecast ✓');
    assert.ok(v.dMltH < 1e-9, `ΔMLT ≈ 0 (${v.dMltH})`);
    ok('forecast: pose ≡ reference at +Δt; verifier ✓ with ΔMLT ≈ 0');
}

// ── 4. Survival forecast + ensemble probability ─────────────────────────────
{
    const simH = 2.0, bSec = 5;
    const d0 = inspectParticle(oxy, 'ionsO', 9, simH, bSec);
    // Far beyond its remaining life: must predict death, and verify as such.
    const dtH = d0.remainH + d0.lifetimeH * DEATH_WINDOW + 0.2;
    const pred = predictParticle(oxy, 'ionsO', 9, simH, bSec, dtH);
    assert.equal(pred.survives, false, 'predicts death past the drawn lifetime');
    assert.equal(pred.mlt, null, 'no position forecast for a dead particle');
    const v = verifyPrediction(pred, oxy, simH + dtH, bSec);
    assert.ok(v.ok && !v.aliveAtTarget, 'verifier confirms the death call');
    // Ensemble probability is exp(−Δt/τ_CE) at its (E, L).
    const p1 = predictParticle(oxy, 'ionsO', 9, simH, bSec, d0.tauCEH);
    assert.ok(Math.abs(p1.pSurvive - Math.exp(-1)) < 1e-12, 'P(survive τ) = 1/e');
    assert.equal(predictParticle(elec, 'electrons', 2, simH, bSec, 1).pSurvive, null,
        'no ensemble P for electrons (no closed form — never invented)');
    ok('survival: death predicted & verified; P(survive Δt) = exp(−Δt/τ_CE)');
}

// ── 5. Cross-cycle honesty: a reborn slot is NOT the same particle ──────────
{
    const simH = 4.0, bSec = 5;
    const d0 = inspectParticle(ions, 'ionsH', 12, simH, bSec);
    const dtH = (1 - d0.ph) * d0.lifetimeH + 0.01;   // just past rebirth
    const pred = predictParticle(ions, 'ionsH', 12, simH, bSec, dtH);
    assert.equal(pred.survives, false, 'a prediction across rebirth is a death call');
    const q = particlePose(ions, 12, simH + dtH, bSec);
    assert.ok(q.cycle > d0.cycle, 'the slot really has recycled at target');
    const v = verifyPrediction(pred, ions, simH + dtH, bSec);
    assert.ok(v.ok, 'verifier treats the recycled slot as the predicted death');
    ok('rebirth: slot recycling scored as death, never as a survivor');
}

// ── 6. Card HTML carries the load-bearing numbers ────────────────────────────
{
    const simH = 1.0, bSec = 10;
    const d = inspectParticle(ions, 'ionsH', 5, simH, bSec);
    const pred = predictParticle(ions, 'ionsH', 5, simH, bSec, 0.5);
    let html = renderInspectorHtml(d, pred, null);
    assert.ok(html.includes(`${d.eKev.toFixed(0)} keV`), 'energy shown');
    assert.ok(html.includes('MLT'), 'MLT shown');
    assert.ok(html.includes('awaiting sim'), 'pending prediction marked');
    const v = verifyPrediction(pred, ions, simH + 0.5, bSec);
    html = renderInspectorHtml(d, pred, v);
    assert.ok(html.includes('✓ verified'), 'verified badge rendered');
    ok('card HTML: energy, MLT, pending → verified lifecycle');
}

console.log(`\nring-current-inspector: all ${n} test groups passed`);
