#!/usr/bin/env node
/**
 * ring-current-efield.mjs — pure-Node validation of the M-I coupling field
 * core (js/ring-current-efield.js, Track 0 of IONOSPHERE_EXPLORATION_PLAN.md).
 *
 * Pins the physics the ionosphere tracks depend on:
 *   1. Maynard–Chen A(Kp) mirrors ring-current-transport.js exactly (kV↔V).
 *   2. Stagnation L matches the analytic (C/2A)^(1/3) and the teardrop's
 *      dusk apex lands ON the stagnation point.
 *   3. Teardrop shape: dusk bulge (dusk > dawn radius), boundary closed and
 *      monotone with driving, within ~1 R_E of Carpenter–Anderson Lpp(Kp)
 *      across the storm range (validation overlay agreement).
 *   4. Shielding ODE: 63% step response after exactly τ, exponential exactness
 *      at giant τ-compressed steps, equilibrium ⇒ zero penetration.
 *   5. Penetration sign convention on a southward→northward Bz square wave:
 *      southward turning ⇒ ΔA > 0 (undershielding), northward ⇒ ΔA < 0.
 *
 * Exits 0 on pass, non-zero on failure.
 */

import assert from 'node:assert/strict';
import {
    COROTATION_KV, TAU_SHIELD_S, maynardChenA, vbsAmplitude, driverAmplitude,
    mltToPhi, potentialKv, stagnationL, boundaryL, teardropPoints,
    ConvectionEField,
} from '../js/ring-current-efield.js';
import { convectionAmplitude } from '../js/ring-current-transport.js';
import { plasmapauseL } from '../js/ring-current-model.js';

let passed = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); passed++; };
const approx = (a, b, rel = 1e-6, msg = '') =>
    assert.ok(Math.abs(a - b) <= rel * Math.max(1, Math.abs(b)), `${msg} ${a} vs ${b}`);

// ── 1. Maynard–Chen mirror ───────────────────────────────────────────────────
{
    for (const kp of [0, 1, 2.3, 3, 4.7, 5, 6.5, 7, 8, 9]) {
        approx(maynardChenA(kp) * 1e3, convectionAmplitude(kp), 1e-12,
            `A(Kp ${kp}) mirror`);
    }
    assert.ok(maynardChenA(7) > maynardChenA(3) && maynardChenA(3) > maynardChenA(0),
        'A(Kp) monotone');
    assert.equal(maynardChenA(NaN), null, 'non-finite Kp → null');
    ok('Maynard–Chen A(Kp) mirrors transport-core convectionAmplitude (kV ↔ V)');
}

// ── 2. Stagnation point & dusk apex ──────────────────────────────────────────
{
    for (const A of [0.05, 0.2, 0.54, 1.12]) {
        approx(stagnationL(A), Math.cbrt(COROTATION_KV / (2 * A)), 1e-12, 'L_s analytic');
        // Teardrop apex at dusk (φ = π/2) IS the stagnation point.
        approx(boundaryL(Math.PI / 2, A), stagnationL(A), 1e-3, 'dusk apex = L_s');
        // Every boundary point sits on the separatrix equipotential.
        const Ls = stagnationL(A);
        const K = A * Ls * Ls + COROTATION_KV / Ls;
        for (const phi of [0, 1, 2.5, Math.PI, 4, 5.5]) {
            const L = boundaryL(phi, A);
            approx(A * L * L * Math.sin(phi) + COROTATION_KV / L, K, 1e-6,
                `on-separatrix at φ=${phi}`);
        }
    }
    // Quiet numbers land where they should: A(Kp 3) ≈ 0.20 → L_s ≈ 6.1.
    approx(stagnationL(maynardChenA(3)), 6.1, 0.02, 'L_s at Kp 3');
    ok('stagnation L analytic; teardrop apex on the dusk stagnation point');
}

// ── 3. Teardrop shape & Carpenter–Anderson agreement ─────────────────────────
{
    const A = maynardChenA(5);
    const dusk = boundaryL(mltToPhi(18), A);
    const dawn = boundaryL(mltToPhi(6), A);
    const noon = boundaryL(mltToPhi(12), A);
    assert.ok(dusk > dawn * 1.3, `dusk bulge: ${dusk} vs dawn ${dawn}`);
    assert.ok(noon > dawn && noon < dusk, 'noon between dawn and dusk');

    // Boundary shrinks monotonically with driving at every azimuth.
    for (const phi of [0, Math.PI / 2, Math.PI, 3 * Math.PI / 2]) {
        assert.ok(boundaryL(phi, maynardChenA(7)) < boundaryL(phi, maynardChenA(3)),
            `storm boundary inside quiet boundary at φ=${phi}`);
    }

    // MLT-average within ~1 R_E of Carpenter–Anderson across Kp 1–8 — the
    // circular Lpp(Kp) overlay should visibly hug the teardrop.
    for (const kp of [1, 3, 5, 7, 8]) {
        const pts = teardropPoints(maynardChenA(kp), 96);
        const mean = pts.reduce((s, p) => s + p.L, 0) / pts.length;
        assert.ok(Math.abs(mean - plasmapauseL(kp)) < 1.0,
            `Kp ${kp}: teardrop mean ${mean.toFixed(2)} vs CA ${plasmapauseL(kp)}`);
    }
    ok('teardrop: dusk bulge, shrinks with Kp, mean tracks Carpenter–Anderson');
}

// ── 4. Shielding ODE step response ───────────────────────────────────────────
{
    const ef = new ConvectionEField({ kp: 1, vbs: 0 });
    const a0 = ef.state().A_sh;
    approx(ef.state().dA, 0, 1e-12, 'equilibrium start ⇒ no penetration');

    ef.setDriver({ kp: 7, vbs: 5 });
    const target = ef.state().A_drv;
    assert.ok(target > a0, 'driver amplitude rose');
    ef.step(TAU_SHIELD_S);
    const frac = (ef.state().A_sh - a0) / (target - a0);
    approx(frac, 1 - Math.exp(-1), 1e-9, '63% response after exactly τ');

    // Exponential exactness: one giant compressed step ≡ many small ones.
    const ef2 = new ConvectionEField({ kp: 1, vbs: 0 });
    ef2.setDriver({ kp: 7, vbs: 5 });
    ef2.step(10 * TAU_SHIELD_S);
    approx(ef2.state().A_sh, target, 1e-4, 'big step lands on the asymptote');

    // Potential is the shielded one: at dusk, deeper (more negative) under
    // storm amplitude at large L.
    assert.ok(ef2.potentialKv(6, mltToPhi(18)) < potentialKv(6, mltToPhi(18), a0),
        'shielded potential deepens with driving');
    ok(`shielding ODE: 63% at τ (${TAU_SHIELD_S / 60} sim-min), exact at any step`);
}

// ── 5. Penetration sign on a Bz square wave ──────────────────────────────────
{
    const ef = new ConvectionEField({ kp: 2, vbs: 0 });
    // Southward turning: VBs switches on (Kp, 3-h cadence, hasn't moved yet).
    ef.setDriver({ vbs: 4 });
    assert.ok(ef.state().dA > 0.05, 'southward turning ⇒ ΔA > 0 (undershielding)');
    // Shielding catches up — penetration decays toward zero.
    ef.step(6 * TAU_SHIELD_S);
    assert.ok(Math.abs(ef.state().dA) < 0.01, 'shielding catches up');
    // Northward turning: driver collapses, shield still configured.
    ef.setDriver({ vbs: 0 });
    assert.ok(ef.state().dA < -0.05, 'northward turning ⇒ ΔA < 0 (overshielding)');
    ef.step(6 * TAU_SHIELD_S);
    assert.ok(Math.abs(ef.state().dA) < 0.01, 'overshielding decays');

    // Driver fallbacks: VBs-only and Kp-only both finite; clamped range.
    assert.ok(driverAmplitude(null, 3) > 0 && driverAmplitude(4, null) > 0,
        'single-input fallbacks');
    assert.ok(driverAmplitude(99, 99) <= 2.0 && driverAmplitude(-5, -5) >= 0.03,
        'clamps');
    assert.ok(vbsAmplitude(10) < 0.28 * 10, 'VBs soft saturation engages');

    // Boot priming: a DEFAULT-constructed instance snaps its shield to the
    // first live driver (page opening mid-storm ⇒ no fake penetration);
    // the second driver change is a real transient. Explicit initial opts
    // (as above) count as priming — that path is what this group stepped.
    const cold = new ConvectionEField();
    cold.setDriver({ kp: 7, vbs: 6 });
    assert.ok(Math.abs(cold.state().dA) < 1e-12, 'first live driver primes, no transient');
    cold.setDriver({ vbs: 0 });
    assert.ok(cold.state().dA < -0.1, 'second change is a real (overshielding) transient');
    ok('penetration sign convention on southward→northward square wave; boot priming');
}

console.log(`\nring-current-efield: ${passed}/5 groups passed`);
