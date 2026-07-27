#!/usr/bin/env node
/**
 * geomag-diffusion.mjs — gate for the two kernels behind the 3D core view:
 * js/geomag/diffusion.js and js/geomag/field-lines.js.
 *
 * Run: node tests/geomag-diffusion.mjs
 *
 * ── THE CENTRAL CHECK ────────────────────────────────────────────────────
 * The diffusion solver is a genuine numerical solve of ∂B/∂t = η∇²B, and the
 * problem it solves has a CLOSED-FORM answer: the free-decay eigenvalues
 * τ_n = μ₀σa²/k_n² with k_n the first zero of j_n. So the solver can be held
 * to the analytic value rather than to a stored number, and a regression shows
 * up as physics being wrong rather than as a diff.
 *
 * The two sides are computed independently on purpose. diffusion.js carries
 * its own spherical-Bessel implementation instead of importing core-model.js's,
 * so a bug in the special function would NOT cancel on both sides of the
 * comparison and leave the gate green.
 */

import assert from 'node:assert/strict';
import {
    RadialDiffusion, freeDecayEnsemble, advanceEnsemble, diffusivity,
    insulatingDecayTime, _sphericalJnIndependent,
} from '../js/geomag/diffusion.js';
import {
    freeDecayTime, jnFirstZero, sphericalJn, YEAR_S, CORE,
} from '../js/geomag/core-model.js';
import { coeffsAt, dipole, NMAX } from '../js/geomag/igrf.js';
import {
    radialFieldSphere, seedFieldLines, traceFieldLine, fieldAtCartesian,
    continuationGain, R_CMB_KM,
} from '../js/geomag/field-lines.js';

let passed = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); passed++; };
const near = (a, b, tol, msg) =>
    assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);

// ── 1. The two Bessel implementations are genuinely independent ──────────────
{
    let worst = 0;
    for (const n of [0, 1, 3, 8, 13, 20]) {
        for (const x of [0.7, 2.5, 7.7, 13.2, 19.3, 28.0]) {
            worst = Math.max(worst, Math.abs(_sphericalJnIndependent(n, x) - sphericalJn(n, x)));
        }
    }
    assert.ok(worst < 1e-9, `the two spherical-Bessel routines disagree by ${worst}`);
    ok(`diffusion.js and core-model.js agree on j_n to ${worst.toExponential(1)} (independent implementations)`);
}

// ── 2. THE SOLVER REPRODUCES THE ANALYTIC EIGENVALUES ────────────────────────
{
    // Seed the exact eigenmode, take one step, measure the decay. If the
    // discretisation is right this must return τ_n.
    let worstPct = 0;
    for (const n of [1, 2, 3, 5, 8, 13]) {
        const analytic = freeDecayTime(n);
        const solver = new RadialDiffusion({ degree: n, nr: 400 }).seedEigenmode();
        const measured = solver.measureDecayTime(analytic / 2000);
        const pct = Math.abs(measured / analytic - 1) * 100;
        worstPct = Math.max(worstPct, pct);
        assert.ok(pct < 0.5,
            `degree ${n}: solver decay ${(measured / YEAR_S).toFixed(0)} yr vs analytic `
            + `${(analytic / YEAR_S).toFixed(0)} yr — ${pct.toFixed(2)}% off`);
    }
    ok(`diffusion solver matches the analytic τ_n at every degree (worst ${worstPct.toFixed(3)}%)`);
}

// ── 3. Convergence with radial resolution ────────────────────────────────────
{
    const analytic = freeDecayTime(1);
    const err = (nr) => {
        const s = new RadialDiffusion({ degree: 1, nr }).seedEigenmode();
        return Math.abs(s.measureDecayTime(analytic / 2000) / analytic - 1);
    };
    const coarse = err(40);
    const fine = err(320);
    assert.ok(fine < coarse,
        `refining the radial grid must reduce the error: nr=40 → ${(coarse * 100).toFixed(3)}%, `
        + `nr=320 → ${(fine * 100).toFixed(3)}%`);
    ok(`radial convergence: ${(coarse * 100).toFixed(3)}% at nr=40 → ${(fine * 100).toFixed(3)}% at nr=320`);
}

// ── 4. ANY initial condition relaxes onto the slowest mode ───────────────────
{
    // This is why the dipole ends up dominant, and it is a property of the
    // OPERATOR rather than of the initial condition — so it has to be checked
    // from a profile that is not already the answer.
    const analytic = freeDecayTime(1);
    const s = new RadialDiffusion({ degree: 1, nr: 200 })
        .seedProfile((u) => Math.sin(3 * Math.PI * u) + 0.4 * Math.sin(Math.PI * u));
    const dt = analytic / 400;
    const early = s.measureDecayTime(dt);
    for (let i = 0; i < 600; i++) s.step(dt);
    const late = s.measureDecayTime(dt);
    assert.ok(late > early,
        'a lumpy initial condition must relax TOWARD the slowest mode, so the measured '
        + `decay time should lengthen: ${(early / YEAR_S).toFixed(0)} → ${(late / YEAR_S).toFixed(0)} yr`);
    near(late / analytic, 1, 0.05, 'the relaxed state must decay at the fundamental rate');
    ok(`an arbitrary profile relaxes onto the fundamental (${(early / YEAR_S).toFixed(0)} → ${(late / YEAR_S).toFixed(0)} yr, analytic ${(analytic / YEAR_S).toFixed(0)})`);
}

// ── 5. THE RESULT: the dipole is what is left ────────────────────────────────
{
    const ens = freeDecayEnsemble({ degrees: [1, 2, 3, 5, 8, 13], nr: 120 });
    const after = advanceEnsemble(ens, 12000, 64);
    const byDegree = Object.fromEntries(after.map((r) => [r.degree, r.fraction]));

    // Monotone: every higher degree must be weaker than every lower one.
    for (let i = 1; i < after.length; i++) {
        assert.ok(after[i].fraction < after[i - 1].fraction,
            `degree ${after[i].degree} must decay faster than degree ${after[i - 1].degree}`);
    }
    assert.ok(byDegree[1] > 0.4, `the dipole should still be standing at 12 kyr, got ${byDegree[1]}`);
    assert.ok(byDegree[13] < 0.05, `degree 13 should be all but gone at 12 kyr, got ${byDegree[13]}`);
    ok(`after 12 kyr of pure diffusion: degree 1 at ${(byDegree[1] * 100).toFixed(1)}%, degree 13 at ${(byDegree[13] * 100).toFixed(2)}%`);
}

// ── 6. The boundary condition is a stated CHOICE, not an accident ────────────
{
    // The confined condition and the insulating one give materially different
    // dipole lifetimes, and quoting one without saying which is how the
    // "15,000 vs 50,000 year" spread in popular accounts happens.
    const confined = freeDecayTime(1);
    const insulating = insulatingDecayTime();
    assert.ok(insulating > confined * 1.8,
        'the insulating-exterior dipole must decay MORE slowly than the confined one');
    near(insulating / YEAR_S, 48861, 200, 'insulating dipole free-decay time, μ₀σa²/π²');
    near(diffusivity(CORE.sigma), 0.7958, 1e-3, 'η = 1/(μ₀σ)');
    ok(`boundary condition is explicit: confined ${(confined / YEAR_S).toFixed(0)} yr vs insulating ${(insulating / YEAR_S).toFixed(0)} yr`);
}

// ── 7. Downward continuation ─────────────────────────────────────────────────
{
    near(continuationGain(1), 6.14, 0.05, 'degree-1 gain from the surface to the CMB');
    assert.ok(continuationGain(13) > 8000, 'degree 13 must be amplified by thousands');
    // The gain must grow with degree — that IS the caution.
    for (let n = 1; n < 13; n++) {
        assert.ok(continuationGain(n + 1) > continuationGain(n), 'gain must increase with degree');
    }
    ok(`continuation gain: ${continuationGain(1).toFixed(1)}× at n=1, ${Math.round(continuationGain(13)).toLocaleString()}× at n=13`);
}

// ── 8. REVERSED FLUX IS DEFINED AGAINST THE DIPOLE ───────────────────────────
{
    const c = coeffsAt(2026.0);
    const surface = radialFieldSphere(c, { radiusKm: 6371.2, nLat: 61, nLon: 121 });
    const cmb = radialFieldSphere(c, { radiusKm: R_CMB_KM, nLat: 61, nLon: 121 });

    // At the surface the field is nearly dipolar, so reversed flux is a few
    // percent. At the CMB the small scales are amplified and it is far more.
    // An earlier version compared against the sign of the magnetic colatitude
    // and got the sense INVERTED, reporting ~80% of the planet as reversed —
    // which is the kind of wrong that looks like a real result.
    assert.ok(surface.reversedAreaFraction > 0.005 && surface.reversedAreaFraction < 0.12,
        `surface reversed-flux area should be a few percent, got ${(surface.reversedAreaFraction * 100).toFixed(1)}%`);
    assert.ok(cmb.reversedAreaFraction > surface.reversedAreaFraction,
        'continuation must reveal MORE reversed flux at the CMB, not less');
    assert.ok(cmb.reversedAreaFraction < 0.45,
        `CMB reversed-flux area of ${(cmb.reversedAreaFraction * 100).toFixed(1)}% is implausibly large — `
        + 'check the sign convention against the dipole rather than the hemisphere');

    // A PURE dipole must have NO reversed flux anywhere. This is the sharpest
    // form of the check: it cannot pass with an inverted sign.
    const pure = {
        g: c.g.map((r) => new Float64Array(r.length)),
        h: c.h.map((r) => new Float64Array(r.length)),
    };
    pure.g[1][0] = c.g[1][0]; pure.g[1][1] = c.g[1][1]; pure.h[1][1] = c.h[1][1];
    const dipoleOnly = radialFieldSphere(pure, { radiusKm: R_CMB_KM, nLat: 61, nLon: 121, nmax: 1 });
    assert.equal(dipoleOnly.reversedAreaFraction, 0,
        'a pure dipole field cannot contain reversed flux by definition');

    // Amplitude: the CMB field is roughly an order of magnitude stronger.
    const peakS = Math.max(Math.abs(surface.min), surface.max);
    const peakC = Math.max(Math.abs(cmb.min), cmb.max);
    assert.ok(peakC / peakS > 5 && peakC / peakS < 40, `CMB/surface peak ratio ${(peakC / peakS).toFixed(1)}`);
    ok(`reversed flux: ${(surface.reversedAreaFraction * 100).toFixed(1)}% at the surface, ${(cmb.reversedAreaFraction * 100).toFixed(1)}% at the CMB, exactly 0 for a pure dipole`);
}

// ── 9. Field-line tracing ────────────────────────────────────────────────────
{
    const c = coeffsAt(2026.0);
    // Tracing forward from a point and backward from the far end must retrace
    // the SAME line — the strongest available check that the integrator and
    // the field evaluation agree.
    const start = [0, 0, 6371.2 * 1.6];
    const fwd = traceFieldLine(c, { start, stepKm: 50, maxSteps: 300, direction: 1, outerKm: 1e6 });
    assert.ok(fwd.count > 20, 'the forward trace should run a while');
    const endIdx = (fwd.count - 1) * 3;
    const end = [fwd.points[endIdx], fwd.points[endIdx + 1], fwd.points[endIdx + 2]];
    // Exactly as many steps back as were taken forward. Running the default
    // budget instead just sails PAST the start point and measures nothing —
    // the forward trace terminates on a boundary, not on the step count.
    const back = traceFieldLine(c, {
        start: end, stepKm: 50, maxSteps: fwd.count, direction: -1, outerKm: 1e6,
    });
    const bIdx = (back.count - 1) * 3;
    const closed = Math.hypot(
        back.points[bIdx] - start[0], back.points[bIdx + 1] - start[1], back.points[bIdx + 2] - start[2]);
    assert.ok(closed < 120,
        `retracing a field line backwards must return to the start, off by ${closed.toFixed(0)} km`);

    // The traced direction really is parallel to B.
    const b = fieldAtCartesian(c, NMAX, start[0], start[1], start[2]);
    const step = [fwd.points[3] - start[0], fwd.points[4] - start[1], fwd.points[5] - start[2]];
    const bm = Math.hypot(...b), sm = Math.hypot(...step);
    const cosang = (b[0] * step[0] + b[1] * step[1] + b[2] * step[2]) / (bm * sm);
    assert.ok(cosang > 0.999, `the first step must be along B, cos = ${cosang.toFixed(5)}`);

    // L-SHELL STRUCTURE, which is physics rather than a rendering parameter:
    // low-latitude seeds close inside the core, high-latitude ones escape.
    const low = seedFieldLines(c, { count: 6, seedLatDeg: 30, stepKm: 120, maxSteps: 400 });
    const high = seedFieldLines(c, { count: 6, seedLatDeg: 68, stepKm: 120, maxSteps: 400 });
    const escFrac = (L) => L.filter((l) => l.escapes).length / Math.max(L.length, 1);
    assert.ok(escFrac(low) < escFrac(high),
        `a 30° seed band must escape less than a 68° one (${escFrac(low).toFixed(2)} vs ${escFrac(high).toFixed(2)})`);
    assert.ok(escFrac(low) < 0.35, 'most low-latitude core field lines close inside the core');
    ok(`field lines: reverse-trace closes to ${closed.toFixed(0)} km, first step along B, L-shell split ${(escFrac(low) * 100).toFixed(0)}% vs ${(escFrac(high) * 100).toFixed(0)}% escaping`);
}

// ── 10. Determinism ──────────────────────────────────────────────────────────
{
    const c = coeffsAt(2026.0);
    const a = seedFieldLines(c, { count: 4, stepKm: 150, maxSteps: 200 });
    const b = seedFieldLines(c, { count: 4, stepKm: 150, maxSteps: 200 });
    assert.deepEqual(a.map((l) => l.count), b.map((l) => l.count), 'tracing must be deterministic');
    const s1 = new RadialDiffusion({ degree: 1, nr: 60 }).seedEigenmode();
    const s2 = new RadialDiffusion({ degree: 1, nr: 60 }).seedEigenmode();
    for (let i = 0; i < 20; i++) { s1.step(1e10); s2.step(1e10); }
    near(s1.amplitude(), s2.amplitude(), 0, 'the diffusion solver must be deterministic');
    ok('field-line tracing and the diffusion solver are both deterministic');
}

console.log(`\n✅ geomag-diffusion — ${passed} checks passed`);
