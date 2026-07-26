#!/usr/bin/env node
/**
 * geomag-dynamo.mjs — gate for js/geomag/dynamo.js.
 *
 * Run: node tests/geomag-dynamo.mjs   (~40 s — it solves the αΩ problem)
 *
 * ── WHAT IS PINNED, AND WHAT DELIBERATELY IS NOT ─────────────────────────
 *
 * The αΩ growth rates ARE pinned, against the dense SciPy eigensolver the
 * research code used (N = 400): 1.619432, 6.753903, 16.749749 at
 * D = −200, −600, −1500, with the parity flipping between the second and the
 * third. This module reaches those by a completely different route — parity
 * decomposition plus explicit time integration — so agreement to four
 * significant figures is a real cross-check of two independent methods, not a
 * tautology.
 *
 * The Rikitake REVERSAL COUNT is deliberately NOT pinned. That system is
 * chaotic: trajectories from different integrators, or the same integrator at
 * a different tolerance, separate exponentially, so a count over t = 500 is a
 * property of the solver rather than of the dynamo. Pinning it would be
 * pinning an artefact. What is pinned is the statistics — that reversals
 * happen unforced, and that chron lengths are wildly irregular — which is the
 * actual result.
 */

import assert from 'node:assert/strict';
import {
    runRikitake, rikitakeStep, familyGrowth, alphaOmegaParity, parityOf,
    dipoleWindow, DIPOLE_PARITY_THRESHOLD,
} from '../js/geomag/dynamo.js';

let passed = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); passed++; };
const near = (a, b, tol, msg) =>
    assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);

// ── 1. Rikitake: reversals with no trigger ───────────────────────────────────
{
    const r = runRikitake({ T: 500, dt: 0.0025, sample: 20 });

    assert.ok(r.reversals > 20,
        `the dynamo must reverse many times over t = 500 with NO forcing, got ${r.reversals}`);
    assert.ok(r.chrons.length > 10, 'need enough chrons to speak about their distribution');
    assert.ok(r.irregularity > 3,
        `chron lengths must be wildly irregular (max/min > 3), got ${r.irregularity.toFixed(1)} — `
        + 'a regular period would mean the integrator has fallen onto a limit cycle');
    assert.ok(r.minChron > 0.5 && r.maxChron < 100, 'chron lengths must be physically sane');

    // No periodicity: the chron sequence must not be even approximately
    // constant. Coefficient of variation is the cheap, robust test.
    const mean = r.meanChron;
    const sd = Math.sqrt(r.chrons.reduce((a, c) => a + (c - mean) ** 2, 0) / r.chrons.length);
    assert.ok(sd / mean > 0.35,
        `chron lengths must have a large coefficient of variation, got ${(sd / mean).toFixed(2)}`);

    // Deterministic: same input, same output. No Math.random anywhere.
    const again = runRikitake({ T: 500, dt: 0.0025, sample: 20 });
    assert.equal(again.reversals, r.reversals, 'runRikitake must be deterministic');

    // The integrator itself: with no coupling (z ≡ 0 initially and a = 0) the
    // x,y equations decay at exactly −μ, which is a closed-form check on RK4.
    const s = rikitakeStep([1, 0, 0], 1, 0, 0.01);
    near(s[0], Math.exp(-0.01), 1e-8, 'RK4 must reproduce pure exponential decay');
    ok(`Rikitake: ${r.reversals} unforced reversals, chrons ${r.minChron.toFixed(1)}–${r.maxChron.toFixed(1)} (${r.irregularity.toFixed(1)}× spread), CV ${(sd / mean).toFixed(2)}`);
}

// ── 2. Parity measurement is phase-invariant ─────────────────────────────────
{
    // A pure dipole-family mode has an ANTISYMMETRIC toroidal field, so parity
    // must be exactly −1 for any basis of the subspace; a quadrupole-family one
    // exactly +1. Constructed vectors, no solver involved.
    const N = 8;
    const anti = new Float64Array(2 * N);
    const sym = new Float64Array(2 * N);
    for (let i = 0; i < N; i++) {
        const v = Math.sin(((i + 1) * Math.PI) / (N + 1));
        anti[N + i] = i < N / 2 ? v : -v;      // antisymmetric about the equator
        sym[N + i] = v;                        // symmetric
    }
    near(parityOf([anti], N), -1, 1e-12, 'antisymmetric toroidal field ⇒ parity −1');
    near(parityOf([sym], N), 1, 1e-12, 'symmetric toroidal field ⇒ parity +1');
    // A 50/50 mix lands at 0, and scaling either basis vector must not move it.
    const mix = Float64Array.from(anti, (v, i) => v + sym[i]);
    near(parityOf([mix], N), 0, 1e-9, 'an even mix reads 0');
    near(parityOf([Float64Array.from(anti, (v) => v * 1e6)], N), -1, 1e-12,
        'parity must be scale-invariant');
    ok('parity is an energy fraction: ±1 for pure families, 0 for a mix, invariant under scaling');
}

// ── 3. αΩ growth rates vs the SciPy eigensolver ──────────────────────────────
{
    // Reference (dense eigensolver at N = 400, leading mode by real part):
    //   D = −200   σ = 1.619432   ω = 10.669632   DIPOLE
    //   D = −600   σ = 6.753903   ω = 22.942928   DIPOLE
    //   D = −1500  σ = 16.749749  ω = 45.637451   QUADRUPOLE
    const REF = [
        { D: -200, growth: 1.619432, freq: 10.669632, preferred: 'DIPOLE' },
        { D: -600, growth: 6.753903, freq: 22.942928, preferred: 'DIPOLE' },
        { D: -1500, growth: 16.749749, freq: 45.637451, preferred: 'QUADRUPOLE' },
    ];
    for (const ref of REF) {
        const r = alphaOmegaParity(ref.D, { N: 160, alphaSym: 'antisymmetric' });
        assert.ok(r.converged, `D = ${ref.D} did not converge`);
        assert.equal(r.preferred, ref.preferred, `D = ${ref.D} preferred the wrong family`);
        // 0.3% — the residual gap is grid resolution (N = 160 here vs 400 there),
        // and it shrinks like 1/N².
        near(r.growth, ref.growth, 0.003 * Math.abs(ref.growth), `growth rate at D = ${ref.D}`);
        near(r.frequency, ref.freq, 0.01 * ref.freq, `oscillation frequency at D = ${ref.D}`);
        // Parity must be CLEAN for antisymmetric α — the reference returns
        // ±1.0000 and never anything between.
        near(Math.abs(r.parity), 1, 1e-6, `parity at D = ${ref.D} must be clean`);
    }
    ok('αΩ growth rates match the SciPy eigensolver to 0.3% at D = −200, −600, −1500, with the parity flip in the right place');
}

// ── 4. Grid convergence ──────────────────────────────────────────────────────
{
    // Successive refinement must converge, and toward the reference. If it
    // drifted away with N the discretisation would be wrong.
    const a = alphaOmegaParity(-600, { N: 80, alphaSym: 'antisymmetric' });
    const b = alphaOmegaParity(-600, { N: 160, alphaSym: 'antisymmetric' });
    const REF = 6.753903;
    assert.ok(Math.abs(b.growth - REF) < Math.abs(a.growth - REF),
        `refining N must move toward the reference: N=80 ${a.growth.toFixed(4)}, N=160 ${b.growth.toFixed(4)}, ref ${REF}`);
    assert.ok(Math.abs(b.growth - a.growth) < 0.05, 'successive resolutions must agree closely');
    ok(`grid convergence: N=80 → ${a.growth.toFixed(4)}, N=160 → ${b.growth.toFixed(4)}, reference ${REF}`);
}

// ── 5. THE CONTROL: symmetric α never gives a clean dipole ───────────────────
{
    // Reference growth rates for α = |cos θ| (unprojected leading mode):
    //   D = −200 → 2.33, −600 → 6.49, −1500 → 16.83, all quadrupolar or mixed.
    const REF = [[-200, 2.33], [-600, 6.49], [-1500, 16.83]];
    for (const [D, growth] of REF) {
        const r = alphaOmegaParity(D, { N: 160, alphaSym: 'symmetric' });
        near(r.growth, growth, 0.05 * Math.abs(growth), `symmetric-α growth at D = ${D}`);
        assert.equal(r.mixed, true, 'the symmetric case must be reported as mixed-parity');
        assert.ok(r.parity > DIPOLE_PARITY_THRESHOLD,
            `symmetric α must NEVER produce a clean dipole; parity at D = ${D} was ${r.parity.toFixed(3)}`);
        assert.equal(r.preferred, 'QUADRUPOLE', `symmetric α at D = ${D} must not prefer the dipole`);
    }
    // And the projected path must NOT be used for the symmetric case — the
    // families do not decouple there, and projecting annihilates the solution.
    // (That failure showed up as a growth rate of exactly 0.)
    ok('control: symmetric α gives growth rates matching the reference but NEVER a clean dipole');
}

// ── 6. The window — one decade, and it converges ─────────────────────────────
{
    // Reference (SciPy, N = 400): |D| = 115.574 … 1166.609.
    // The LOWER edge is essentially resolution-independent; the UPPER edge
    // converges from above like 1/N², so it is gated with an N-aware tolerance
    // rather than pretending a coarse grid resolves it.
    const w = dipoleWindow({ N: 120, tolerance: 0.5 });
    near(w.lower, 115.57, 1.0, 'lower edge of the dipole window');
    assert.ok(w.upper > 1150 && w.upper < 1200,
        `upper edge at N = 120 should sit just above the N = 400 value of 1166.6, got ${w.upper.toFixed(1)}`);

    // THE RESULT: one decade. Not "a wide range", not "most values".
    const decades = Math.log10(w.upper / w.lower);
    near(decades, 1.0, 0.06, 'the dipole window spans one decade');

    // Which means both ENDS must genuinely prefer the quadrupole — a dipole is
    // not inevitable, it needs the right symmetry AND the right strength.
    assert.equal(alphaOmegaParity(-60, { N: 120 }).preferred, 'QUADRUPOLE',
        'below the window, weak driving must give a quadrupole');
    assert.equal(alphaOmegaParity(-2100, { N: 120 }).preferred, 'QUADRUPOLE',
        'above the window, strong driving must give a quadrupole');
    assert.equal(alphaOmegaParity(-320, { N: 120 }).preferred, 'DIPOLE',
        'inside the window, the dipole must win');
    ok(`dipole window |D| = ${w.lower.toFixed(1)} … ${w.upper.toFixed(1)} — ${decades.toFixed(2)} decades, quadrupolar on both sides`);
}

// ── 7. The margin has no spurious sign changes ───────────────────────────────
{
    // This is a REGRESSION gate. With a fixed settle budget, the quadrupole
    // family failed to converge near |D| ≈ 220 — where two of its real
    // eigenvalues collide into a complex pair and their separation vanishes —
    // and returned +3.76 where the converged value is about −0.5. That single
    // bad sample inverted the comparison and put a phantom window edge at
    // |D| ≈ 185, ten times too narrow. The convergence loop is the fix; this
    // asserts the symptom cannot come back.
    const Ds = [60, 90, 116, 150, 180, 220, 260, 320, 460, 660, 900, 1166, 1500, 2100];
    const margins = Ds.map((D) => {
        const r = alphaOmegaParity(-D, { N: 96, alphaSym: 'antisymmetric' });
        assert.ok(r.converged, `|D| = ${D} reported a non-converged growth rate`);
        return r.margin;
    });
    let flips = 0;
    for (let i = 1; i < margins.length; i++) if (margins[i - 1] * margins[i] < 0) flips++;
    assert.equal(flips, 2,
        `the dipole-preference margin must change sign EXACTLY twice across the sweep, got ${flips}: `
        + margins.map((m, i) => `${Ds[i]}:${m.toFixed(2)}`).join(' '));
    ok(`margin sign changes exactly twice across |D| = 60…2100 — no phantom window edge (${flips} flips)`);
}

console.log(`\n✅ geomag-dynamo — ${passed} checks passed`);
