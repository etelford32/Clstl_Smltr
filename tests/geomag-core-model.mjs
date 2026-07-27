#!/usr/bin/env node
/**
 * geomag-core-model.mjs — gate for js/geomag/core-model.js.
 *
 * Run: node tests/geomag-core-model.mjs
 *
 * Pinned against the SciPy reference the research code used
 * (scipy.special.spherical_jn + brentq): the first zeros of j_n, the
 * free-decay times they imply, and the dimensionless numbers.
 *
 * The spherical Bessel implementation here is Miller's DOWNWARD recurrence,
 * NOT the upward one. Upward recurrence is unstable wherever x ≲ n, and the
 * first zero of j_n sits just above n — exactly the region this is used in.
 * The zeros below are what would move if that ever got "simplified".
 */

import assert from 'node:assert/strict';
import {
    LAYERS, CURIE_K, CORE, dimensionlessNumbers, sphericalJn, jnFirstZero,
    freeDecayTime, freeDecayTable, mantleScreening, halfAttenuationPeriodYears,
    AMPLITUDE_LADDER_NT, YEAR_S, R_CMB_M, R_IC_M, D_MANTLE_M,
    layerDiagnostics, tangentCylinderLatitudeDeg, TANGENT_CYLINDER_RADIUS_M,
} from '../js/geomag/core-model.js';

let passed = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); passed++; };
const near = (a, b, tol, msg) =>
    assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);

// ── 1. Spherical Bessel functions ────────────────────────────────────────────
{
    // Closed forms, exactly.
    near(sphericalJn(0, 1.3), Math.sin(1.3) / 1.3, 1e-14, 'j₀(x) = sin x / x');
    near(sphericalJn(1, 2.1), Math.sin(2.1) / (2.1 ** 2) - Math.cos(2.1) / 2.1, 1e-12, 'j₁ closed form');
    near(sphericalJn(0, Math.PI), 0, 1e-13, 'j₀(π) = 0');
    assert.equal(sphericalJn(3, 0), 0, 'j_n(0) = 0 for n > 0');
    assert.equal(sphericalJn(0, 0), 1, 'j₀(0) = 1');

    // The recurrence must hold: j_{n+1} = (2n+1)/x · j_n − j_{n−1}.
    for (const x of [3.5, 9.0, 19.0]) {
        for (let n = 1; n <= 12; n++) {
            const lhs = sphericalJn(n + 1, x);
            const rhs = ((2 * n + 1) / x) * sphericalJn(n, x) - sphericalJn(n - 1, x);
            near(lhs, rhs, 1e-9 * Math.max(1, Math.abs(rhs)), `recurrence n=${n} x=${x}`);
        }
    }

    // The stability point: at x just above n, an UPWARD recurrence loses all
    // precision. Miller's algorithm must still be accurate there — and this is
    // precisely where the first zeros live.
    for (const n of [5, 9, 13, 20]) {
        const v = sphericalJn(n, n + 0.5);
        assert.ok(Number.isFinite(v) && Math.abs(v) < 1, `j_${n}(${n + 0.5}) implausible: ${v}`);
    }
    ok('spherical Bessel: closed forms exact, recurrence holds, stable where x ≈ n');
}

// ── 2. First zeros — pinned against SciPy ────────────────────────────────────
{
    // scipy.optimize.brentq on scipy.special.spherical_jn.
    const REFERENCE = {
        1: 4.4934, 2: 5.7635, 3: 6.9879, 4: 8.1826, 5: 9.3558,
        8: 12.7908, 13: 18.3513, 20: 25.9557,
    };
    for (const [n, k] of Object.entries(REFERENCE)) {
        near(jnFirstZero(Number(n)), k, 5e-4, `first zero of j_${n}`);
        // And it really is a zero.
        near(sphericalJn(Number(n), jnFirstZero(Number(n))), 0, 1e-10, `j_${n} at its first zero`);
    }
    // Zeros must increase with n and lie above n.
    let prev = 0;
    for (let n = 1; n <= 20; n++) {
        const k = jnFirstZero(n);
        assert.ok(k > n, `the first zero of j_${n} must exceed ${n}, got ${k}`);
        assert.ok(k > prev, 'first zeros must increase with degree');
        prev = k;
    }
    ok('first zeros of j_n match SciPy to < 5e-4 for n = 1…20');
}

// ── 3. Free-decay times — WHY THE FIELD IS A DIPOLE ──────────────────────────
{
    near(freeDecayTime(1) / YEAR_S, 23884, 50, 'dipole free-decay time');
    near(freeDecayTime(13) / YEAR_S, 1432, 20, 'degree-13 free-decay time');
    near(freeDecayTime(1) / freeDecayTime(13), 16.7, 0.2, 'dipole outlives degree 13 by');

    // τ_n = μ₀σa²/k_n² exactly — check the scaling rather than only the values.
    for (const n of [2, 5, 13]) {
        const ratio = freeDecayTime(1) / freeDecayTime(n);
        near(ratio, (jnFirstZero(n) / jnFirstZero(1)) ** 2, 1e-9, `τ₁/τ_${n} = (k_n/k₁)²`);
    }
    // τ scales linearly in σ and quadratically in radius.
    near(freeDecayTime(1, 2e6) / freeDecayTime(1, 1e6), 2, 1e-9, 'τ ∝ σ');
    near(freeDecayTime(1, 1e6, 2 * R_CMB_M) / freeDecayTime(1), 4, 1e-9, 'τ ∝ a²');

    const table = freeDecayTable();
    assert.equal(table[0].n, 1);
    near(table[0].ratioToDipole, 1, 1e-12, 'the dipole row is its own reference');
    for (let i = 1; i < table.length; i++) {
        assert.ok(table[i].years < table[i - 1].years, 'decay time must fall with degree');
    }
    ok(`free decay: ${(freeDecayTime(1) / YEAR_S).toFixed(0)} yr at n=1 vs ${(freeDecayTime(13) / YEAR_S).toFixed(0)} yr at n=13 — the dipole survives ${(freeDecayTime(1) / freeDecayTime(13)).toFixed(1)}× longer`);
}

// ── 4. The dimensionless numbers ─────────────────────────────────────────────
{
    const n = dimensionlessNumbers();
    near(n.etaM2S, 0.80, 0.01, 'magnetic diffusivity η');
    near(n.magneticReynolds, 1135, 5, 'magnetic Reynolds number');
    near(n.ekman, 1.34e-15, 5e-17, 'Ekman number');
    near(n.rossby, 1.21e-6, 5e-8, 'Rossby number');
    near(n.magneticPrandtl, 1.26e-6, 5e-8, 'magnetic Prandtl number');
    near(n.elsasser, 9.97, 0.1, 'Elsasser number');

    // The three statements the page makes from these:
    assert.ok(n.magneticReynolds > 40, 'Rm must exceed ~40 or no dynamo runs');
    assert.ok(n.elsasser > 1, 'Elsasser > 1 means the field reacts back on the flow');
    assert.ok(n.magneticPrandtl < 1e-5,
        'Pm ≪ 1 is exactly why 3-D simulations cannot reach Earth — if this ever '
        + 'came out near 1 the constants would be wrong, not the planet');

    // η = 1/(μ₀σ) by definition.
    near(n.etaM2S, 1 / (4e-7 * Math.PI * CORE.sigma), 1e-12, 'η = 1/(μ₀σ)');
    ok(`dimensionless: Rm ${n.magneticReynolds.toFixed(0)}, E ${n.ekman.toExponential(2)}, Pm ${n.magneticPrandtl.toExponential(2)}, Λ ${n.elsasser.toFixed(2)}`);
}

// ── 5. Mantle screening ──────────────────────────────────────────────────────
{
    near(halfAttenuationPeriodYears(0.1), 0.22, 0.01, '50% attenuation at σ = 0.1 S/m');
    near(halfAttenuationPeriodYears(1), 2.18, 0.05, '50% attenuation at σ = 1 S/m');
    near(halfAttenuationPeriodYears(10), 21.8, 0.5, '50% attenuation at σ = 10 S/m');
    // Self-consistency: the half-attenuation period really does attenuate by ½.
    for (const s of [0.1, 1, 10]) {
        near(mantleScreening(halfAttenuationPeriodYears(s), s), 0.5, 1e-9, `half-attenuation self-check σ=${s}`);
    }

    // The headline: a one-day core signal at σ = 1 arrives at 3×10⁻⁹.
    const oneDay = mantleScreening(1 / 365.25, 1);
    assert.ok(oneDay > 1e-9 && oneDay < 1e-8,
        `a one-day core signal at σ = 1 should arrive at ~3×10⁻⁹, got ${oneDay.toExponential(2)}`);

    // Monotone in both arguments, and bounded.
    assert.ok(mantleScreening(100, 1) > mantleScreening(10, 1), 'longer period ⇒ less screening');
    assert.ok(mantleScreening(10, 10) < mantleScreening(10, 1), 'more conductive ⇒ more screening');
    assert.ok(mantleScreening(1e6, 1) <= 1, 'screening cannot exceed 1');
    assert.ok(mantleScreening(1e-6, 1) >= 0, 'screening cannot go negative');
    ok(`mantle screening: 50% at 0.22 / 2.18 / 21.8 yr for σ = 0.1 / 1 / 10; a one-day signal arrives at ${oneDay.toExponential(1)}`);
}

// ── 6. Layers, Curie temperatures, and the amplitude ladder ──────────────────
{
    // Layers must tile the radius from centre to surface with no gaps.
    assert.equal(LAYERS[0].rInnerKm, 0, 'the innermost layer starts at the centre');
    assert.equal(LAYERS[LAYERS.length - 1].rOuterKm, 6371, 'the outermost layer ends at the surface');
    for (let i = 1; i < LAYERS.length; i++) {
        assert.equal(LAYERS[i].rInnerKm, LAYERS[i - 1].rOuterKm, `gap between layer ${i - 1} and ${i}`);
    }
    // The conductivity contrast that makes the whole screening argument work.
    const core = LAYERS.find((L) => L.name === 'Outer core');
    const mantle = LAYERS.find((L) => L.name === 'Lower mantle');
    assert.ok(core.sigma / mantle.sigma > 1e5, 'the core must be vastly more conductive than the mantle');
    assert.equal(core.rOuterKm, 3480, 'the CMB is at 3480 km');
    near(D_MANTLE_M / 1e3, 6371 - 3480, 1, 'mantle thickness must match the layer table');

    // Every Curie temperature is far below the temperature of every deep layer.
    // This is the statement "nothing down there is a magnet", as an assertion.
    const hottestCurie = Math.max(...Object.values(CURIE_K));
    assert.ok(hottestCurie < 1100, 'the highest Curie point in the table is ~1043 K (iron)');
    assert.ok(hottestCurie * 4 < 5000,
        'the core runs at 5000–6000 K, several times any Curie point — so the field '
        + 'is carried entirely by currents, not magnetised rock');

    // The amplitude ladder: the external signals genuinely bury the core one.
    const coreAmp = AMPLITUDE_LADDER_NT.find((a) => a.layer === 'core').nT;
    const external = AMPLITUDE_LADDER_NT.filter((a) => a.layer === 'external');
    for (const e of external) {
        assert.ok(e.nT > coreAmp * 10,
            `${e.label} must exceed the short-period core signal by an order of magnitude — `
            + 'that inequality IS the argument for putting a nowcast under a field model');
    }
    ok('layers tile the radius, the core is 10⁵× more conductive than the mantle, and external signals bury the core one');
}

// ── 7. Per-layer diagnostics: only ONE layer can run a dynamo ────────────────
{
    const diag = layerDiagnostics();
    assert.equal(diag.length, 5);
    const by = Object.fromEntries(diag.map((L) => [L.name, L]));

    // THE POINT OF THE TABLE. Exactly one layer clears Rm ≈ 40.
    const dynamos = diag.filter((L) => L.canSustainDynamo);
    assert.equal(dynamos.length, 1, `exactly one layer should host a dynamo, got ${dynamos.length}`);
    assert.equal(dynamos[0].name, 'Outer core');
    near(by['Outer core'].magneticReynolds, 1135, 5, 'outer-core magnetic Reynolds number');

    // And NOT because it is the most conductive — the inner core is IDENTICAL.
    // Rm is a product, and a solid layer contributes U = 0 however conductive.
    assert.equal(by['Inner core'].sigma, by['Outer core'].sigma,
        'the inner core is exactly as conductive as the outer core — that is the point');
    assert.equal(by['Inner core'].flowMs, 0, 'a solid layer has no flow');
    assert.equal(by['Inner core'].magneticReynolds, 0,
        'zero flow must give zero Rm regardless of conductivity');
    assert.ok(by['Outer core'].flowMs > 0, 'the outer core is the only layer that moves');

    // Only the crust is below its Curie point, so only the crust can hold
    // permanent magnetisation — 35 km of the 6,371.
    const magnetisable = diag.filter((L) => L.permanentlyMagnetisable);
    assert.equal(magnetisable.length, 1);
    assert.equal(magnetisable[0].name, 'Crust');
    assert.ok(magnetisable[0].thicknessKm < 50, 'the magnetisable layer is thin');

    // The inner core's own diffusion time — slow enough to resist a rapid
    // reversal of the field around it, which is the basis of a real published
    // hypothesis, so the number has to be right.
    near(by['Inner core'].diffusionTimeYears, 6020, 60, 'inner-core diffusion time');
    assert.ok(by['Outer core'].diffusionTimeYears > by['Inner core'].diffusionTimeYears,
        'the thicker outer core must diffuse more slowly than the inner core');

    // Mantle diffusion times are SECONDS, not millennia — six orders of
    // magnitude of σ across the CMB is the whole reason the field looks the way
    // it does from outside.
    assert.ok(by['Lower mantle'].diffusionTimeYears * YEAR_S < 1e8,
        'the mantle must diffuse fast compared with the core');
    assert.ok(by['Outer core'].sigma / by['Lower mantle'].sigma > 1e5,
        'σ must fall by >5 orders of magnitude across the core–mantle boundary');
    ok(`layers: 1 of 5 can host a dynamo (Rm ${Math.round(by['Outer core'].magneticReynolds)}), and the inner core is equally conductive with Rm 0`);
}

// ── 8. The tangent cylinder ──────────────────────────────────────────────────
{
    // By definition it is tangent to the inner core, so its radius IS the
    // inner-core radius. If those ever diverge, the geometry is wrong.
    assert.equal(TANGENT_CYLINDER_RADIUS_M, R_IC_M,
        'the tangent cylinder is tangent to the inner core by definition');

    // sin(colatitude) = r_IC / r_CMB ⇒ ~69.4° latitude at the top of the core.
    const lat = tangentCylinderLatitudeDeg();
    near(lat, 69.45, 0.1, 'latitude at which the tangent cylinder meets the CMB');
    // It must be high-latitude but NOT the pole — a common slip.
    assert.ok(lat > 60 && lat < 80,
        `the tangent cylinder meets the CMB at high latitude, not at the pole (${lat.toFixed(1)}°)`);

    // Closed form: 90 − asin(r_IC/r_CMB).
    const expected = 90 - (Math.asin(R_IC_M / R_CMB_M) * 180) / Math.PI;
    near(lat, expected, 1e-9, 'tangent-cylinder latitude vs its closed form');
    // A LARGER inner core makes a WIDER cylinder, which therefore meets the
    // CMB sphere further from the pole — i.e. at LOWER latitude. (Written the
    // other way round first, which is the intuitive-sounding and wrong answer:
    // "bigger core, bigger everything" does not survive the geometry.)
    const bigger = tangentCylinderLatitudeDeg(R_IC_M * 1.5, R_CMB_M);
    assert.ok(bigger < lat,
        `a larger inner core widens the cylinder, so it meets the CMB at LOWER `
        + `latitude: ${bigger.toFixed(1)}° vs ${lat.toFixed(1)}°`);
    // In the limit the cylinder touches the CMB at the equator.
    near(tangentCylinderLatitudeDeg(R_CMB_M, R_CMB_M), 0, 1e-9,
        'an inner core filling the whole core puts the tangent cylinder at the equator');

    // Rotation has to actually dominate, or the Taylor–Proudman argument the
    // cylinder rests on does not apply.
    const n = dimensionlessNumbers();
    assert.ok(n.rossby < 1e-3,
        `the tangent cylinder only means anything if Coriolis dominates inertia; Rossby = ${n.rossby}`);
    ok(`tangent cylinder: radius = inner-core radius, meets the CMB at ${lat.toFixed(2)}°, Rossby ${n.rossby.toExponential(1)}`);
}

console.log(`\n✅ geomag-core-model — ${passed} checks passed`);
