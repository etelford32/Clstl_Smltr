#!/usr/bin/env node
/**
 * bootes-void-model.mjs — gate for js/bootes-void-model.js.
 *
 * Run: node tests/bootes-void-model.mjs
 *
 * WHAT THIS GATE IS FOR. There is no observed matter-density profile for the
 * Boötes Void to score against — that observation is the thing the page is
 * arguing for. So this file cannot check the model against nature, and it does
 * not pretend to. What it CAN do, and does, is check the model against its own
 * mathematics, which is where every bug in this kernel has actually lived:
 *
 *   • ∮v·dA = ∫∇·v dV        linear continuity, in integral form, to 0.05 %
 *   • tr T_ij = δ             Poisson, to 1e-12
 *   • δ⁻ + δ⁺ = δ             the counterfactual split, to 1e-12
 *   • g = −dΦ/dr_phys         the two independently-written (1+z) chains agree
 *
 * Those four are IDENTITIES. They cannot be satisfied by a broken integration,
 * a wrong redshift power or a sign slip, and each one caught a real bug during
 * development. Everything else here pins a physical SIGN or an order of
 * magnitude, both of which are cheap to state and were each wrong once:
 *
 *   • the void is UNDER-compensated, so Φ > 0 everywhere and the ISW imprint
 *     is a COLD spot whose depth is maximal on the central sightline;
 *   • ΔΣ < 0, so the tangential shear is negative — void lensing stretches
 *     background galaxies radially, the opposite of a cluster;
 *   • the redshift-space void is ELONGATED along the line of sight, not
 *     squashed.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
    G_SI, C_KMS, MPC_M, MSUN_KG, GYR_S, COSMOLOGY,
    hubbleKmsMpc, hubbleSI, omegaMatterAt, growthRate, growthFactor,
    comovingDistanceMpc, angularDiameterDistanceMpc, angularDiameterDistanceBetweenMpc,
    criticalDensityMsunMpc3, meanMatterDensityMsunMpc3, fourPiGRhoM,
    matterContrastFromGalaxy, galaxyContrastFromMatter,
    hswDensityContrast, createVoidProfile, buildProfile, splitProfile,
    compensationFraction, wallMassMsun,
    radialVelocityKms, velocityDivergence,
    enclosedMassExcessMsun, gravityRadialSI, gravityKmsPerGyr,
    tidalEigenvalues, tidalEigenvaluesSI, voidTidalTensor, voidGravityVector,
    pointGravityVector, pointTidalTensor, symmetricEigen,
    toRedshiftSpace, apparentEllipticity, rsdQuadrupoleRatio,
    surfaceDensityExcess, deltaSigma, criticalSurfaceDensityMsunMpc2,
    tangentialShear, lensingSNR, iswTemperatureShiftK,
    influenceProfile, alignmentStatistic,
} from '../js/bootes-void-model.js';

let passed = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); passed++; };
const near = (a, b, tol, msg) =>
    assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);
const withinPercent = (a, b, pct, msg) =>
    assert.ok(Math.abs(a / b - 1) * 100 <= pct,
        `${msg}: ${a} vs ${b} (${((a / b - 1) * 100).toFixed(2)}%, allowed ${pct}%)`);

const profile = createVoidProfile();
const Z = 15500 / C_KMS;                      // the void's redshift, from cz

// ── 1. Cosmology ────────────────────────────────────────────────────────────
{
    // ρ_crit = 2.775e11 h² M☉/Mpc³ is the textbook value; deriving it from
    // H₀ and G rather than typing it is what keeps a change of H₀ consistent.
    withinPercent(criticalDensityMsunMpc3(), 2.775e11 * COSMOLOGY.h ** 2, 0.1,
        'critical density matches 2.775e11 h²');
    withinPercent(meanMatterDensityMsunMpc3(),
        COSMOLOGY.omegaM * criticalDensityMsunMpc3(), 1e-9, 'mean matter density is Ωm ρ_c');

    // 4πGρ̄ = (3/2)Ωm H², evaluated two entirely different ways.
    const viaDensity = 4 * Math.PI * G_SI
        * (meanMatterDensityMsunMpc3() * MSUN_KG / MPC_M ** 3);
    withinPercent(fourPiGRhoM(0), viaDensity, 0.01, '4πGρ̄ identity at z=0');

    near(growthFactor(0), 1, 1e-12, 'D(0) = 1 by normalisation');
    assert.ok(growthFactor(1) < growthFactor(0), 'growth increases towards z=0');
    withinPercent(growthFactor(1), 0.61, 3, 'D(z=1) ≈ 0.61 in Planck ΛCDM');

    // The γ-approximation and the differentiated growth integral are written
    // independently and must agree. If the integral breaks, the approximation
    // cannot break with it, which is the point of keeping both.
    for (const z of [0, 0.25, 0.5, 1]) {
        withinPercent(growthRate(z), growthRate(z, COSMOLOGY, { exact: true }), 1,
            `f(${z}): γ-approximation vs differentiated growth integral`);
    }
    near(omegaMatterAt(0), COSMOLOGY.omegaM, 1e-12, 'Ωm(0) = Ωm');
    assert.ok(omegaMatterAt(1) > omegaMatterAt(0), 'Ωm rises with z');

    // The Hubble-distance sanity check: at low z, D_C → cz/H₀.
    withinPercent(comovingDistanceMpc(0.01), C_KMS * 0.01 / COSMOLOGY.H0_kms_Mpc, 1,
        'low-z comoving distance reduces to cz/H₀');
    withinPercent(comovingDistanceMpc(Z), 226, 1.5, 'distance to the void ≈ 226 Mpc');
    near(angularDiameterDistanceMpc(Z), comovingDistanceMpc(Z) / (1 + Z), 1e-9,
        'D_A = D_C/(1+z) in a flat universe');
    assert.equal(angularDiameterDistanceBetweenMpc(0.9, 0.05), 0,
        'D_ls is zero when the "source" is in front of the lens');
    ok('cosmology: densities, growth and distances derive rather than assert');
}

// ── 2. The profile and its integral ─────────────────────────────────────────
{
    const p = profile.params;
    near(hswDensityContrast(0, p), p.deltaC, 1e-12, 'δ(0) = δ_c');
    near(hswDensityContrast(p.rsMpc, p), 0, 1e-12, 'δ(r_s) = 0 — the zero crossing');
    assert.ok(hswDensityContrast(p.rsMpc * 1.15, p) > 0,
        'the compensating wall is positive beyond r_s');
    near(profile.integratedAt(0), p.deltaC, 1e-12, 'Δ(0) = δ(0)');

    // Δ(<r) against a brute-force quadrature that shares no code with the
    // cached table — a straight Simpson sum, recomputed here.
    const brute = (r) => {
        const n = 4000;
        const h = r / n;
        let s = 0;
        for (let i = 0; i <= n; i++) {
            const x = i * h;
            const w = (i === 0 || i === n) ? 1 : (i % 2 ? 4 : 2);
            s += w * hswDensityContrast(x, p) * x * x;
        }
        return 3 * (s * h / 3) / (r * r * r);
    };
    for (const r of [20, 55, 87, 92, 130, 200]) {
        near(profile.integratedAt(r), brute(r), 2e-4,
            `Δ(<${r}) matches an independent quadrature`);
    }

    // Beyond the tabulated range the profile is continued analytically as
    // Δ ∝ r⁻³. Check that Δr³ really has gone constant there, which is what
    // makes the continuation exact rather than an extrapolation.
    const c1 = profile.integratedAt(profile.rMaxMpc * 0.95) * (profile.rMaxMpc * 0.95) ** 3;
    const c2 = profile.integratedAt(profile.rMaxMpc * 2) * (profile.rMaxMpc * 2) ** 3;
    withinPercent(c2, c1, 0.5, 'Δr³ is constant on the tail — the r⁻³ continuation is exact');
    ok('density profile: zero crossing, wall, Δ(<r) and the analytic tail');
}

// ── 3. UNDER-COMPENSATION, and everything that hangs off it ─────────────────
{
    const C = compensationFraction(profile);
    assert.ok(C > 0 && C < 1,
        `Boötes must come out UNDER-compensated (0 < C < 1); got C = ${C}. `
        + 'An over-compensated profile flips the sign of Φ in the outskirts and '
        + 'silently inverts the ISW prediction — see the compensationFraction header.');
    withinPercent(C, 0.90, 6, 'compensation ≈ 0.9 for a supervoid');

    assert.ok(profile.interiorIntegral < 0, 'the interior integral is a deficit');
    assert.ok(profile.wallIntegral > 0, 'the wall integral is an excess');
    assert.ok(profile.compensationIntegral < 0,
        'the residual monopole is negative — the deficit is not fully repaid');

    // Δ(<r) approaches zero FROM BELOW. This is the observable consequence of
    // under-compensation and the reason the outflow never reverses.
    for (const r of [150, 250, 400, 550]) {
        assert.ok(profile.integratedAt(r) < 0, `Δ(<${r}) is still negative`);
    }
    // Φ > 0 everywhere: the void is a potential hill.
    for (const r of [0, 50, 92, 160, 300, 500]) {
        assert.ok(profile.potentialAt(r, Z) > 0, `Φ(${r}) > 0 — the void is a potential hill`);
    }
    assert.ok(profile.potentialAt(0, Z) > profile.potentialAt(200, Z),
        'Φ decreases outward');
    ok('compensation: under-compensated, Δ → 0⁻, Φ > 0 everywhere');
}

// ── 4. IDENTITY — the counterfactual split is exact ─────────────────────────
{
    const { deficit, wall } = splitProfile(profile);
    let maxDelta = 0;
    let maxInt = 0;
    for (let r = 0; r <= profile.rMaxMpc; r += 0.7) {
        maxDelta = Math.max(maxDelta,
            Math.abs(deficit.deltaAt(r) + wall.deltaAt(r) - profile.deltaAt(r)));
        maxInt = Math.max(maxInt,
            Math.abs(deficit.integratedAt(r) + wall.integratedAt(r) - profile.integratedAt(r)));
    }
    near(maxDelta, 0, 1e-15, 'δ⁻ + δ⁺ = δ exactly');
    near(maxInt, 0, 1e-12, 'Δ⁻(<r) + Δ⁺(<r) = Δ(<r) exactly — the counterfactual is an identity');

    assert.ok(deficit.deltaAt(120) === 0, 'the deficit half is zero out in the wall');
    assert.ok(wall.deltaAt(40) === 0, 'the wall half is zero inside the void');
    assert.ok(wallMassMsun(profile) > 0, 'the wall carries positive mass');
    withinPercent(wallMassMsun(profile),
        4 * Math.PI * meanMatterDensityMsunMpc3() * profile.wallIntegral, 1e-9,
        'wall mass is 4πρ̄ ∫δ⁺r²dr');
    ok('counterfactual split: δ⁻ + δ⁺ = δ to machine precision');
}

// ── 5. IDENTITY — linear continuity, ∇·v = −aHf δ ───────────────────────────
{
    // TESTED AS THE DIVERGENCE THEOREM, NOT AS A DERIVATIVE. The obvious form
    // of this check differentiates the velocity field numerically and compares
    // against `velocityDivergence`. That does not work here and the reason is
    // worth recording: Δ(<r) is a linearly-interpolated table, so its
    // derivative is piecewise constant, and δ has a kink at the wall where it
    // crosses zero. A narrow stencil then measures the interpolation and a
    // wide one straddles the kink — the first attempt failed by 0.9 % at
    // r = 15 and, once widened, by 1 % at r = 92, in both cases reporting a
    // property of the stencil rather than of the physics.
    //
    // The integral form has neither problem:
    //
    //     ∮ v·dA = ∫∫∫ ∇·v dV
    //     4π r² v(r) = ∫₀^r (−aHf δ) 4π r'² dr'
    //     ⇒  r² v(r) = −aHf ∫₀^r δ r'² dr'
    //
    // The right-hand side is computed here by an independent Simpson sum over
    // the ANALYTIC δ, sharing no code with the kernel's cached table. So this
    // one assertion checks the continuity identity, the velocity prefactor and
    // the tabulated Δ all at once, and it is what the page's Test 2 claim —
    // that density and velocity are independent measurements of the same
    // gravity — actually rests on.
    const f = growthRate(Z);
    const a = 1 / (1 + Z);
    const H = hubbleKmsMpc(Z);
    const p = profile.params;
    const massIntegral = (r) => {
        const n = 8000;
        const h = r / n;
        let sum = 0;
        for (let i = 0; i <= n; i++) {
            const x = i * h;
            const w = (i === 0 || i === n) ? 1 : (i % 2 ? 4 : 2);
            sum += w * hswDensityContrast(x, p) * x * x;
        }
        return sum * h / 3;
    };
    for (const r of [15, 40, 70, 92, 130, 190, 300]) {
        const lhs = r * r * radialVelocityKms(r, profile, { z: Z, linear: true });
        const rhs = -a * H * f * massIntegral(r);
        withinPercent(lhs, rhs, 0.05,
            `divergence theorem: r²v(r) = −aHf ∫δr²dr at r = ${r}`);
    }

    // And the analytic divergence really is −aHf δ, exactly, by construction.
    for (const r of [15, 40, 70, 92, 130, 190]) {
        near(velocityDivergence(r, profile, { z: Z }), -a * H * f * profile.deltaAt(r),
            1e-12, `∇·v = −aHf δ at r = ${r}`);
    }
    ok('IDENTITY ∇·v = −aHf δ, verified in integral form (divergence theorem)');
}

// ── 6. Velocity: sign, magnitude and the quasi-linear correction ────────────
{
    for (const r of [10, 40, 80, 120, 200]) {
        assert.ok(radialVelocityKms(r, profile, { z: Z }) > 0,
            `outflow is OUTWARD (positive) at r = ${r} — a void does not push, `
            + 'it fails to pull');
    }
    near(radialVelocityKms(0, profile, { z: Z }), 0, 1e-9, 'v(0) = 0 by symmetry');

    // The peak is inside the wall, not at the wall: the outflow is driven by
    // Δ(<r), which is deepest well inside r_s.
    let peakR = 0;
    let peakV = 0;
    for (let r = 1; r < 200; r += 1) {
        const v = radialVelocityKms(r, profile, { z: Z });
        if (v > peakV) { peakV = v; peakR = r; }
    }
    assert.ok(peakR > 30 && peakR < profile.params.rsMpc,
        `outflow peaks inside r_s (got ${peakR} Mpc)`);
    assert.ok(peakV > 150 && peakV < 500,
        `peak outflow is a few hundred km/s (got ${peakV.toFixed(0)})`);

    // The quasi-linear correction is a BOOST for a void (Δ < 0 ⇒ (1+Δ)^(−1/6) > 1)
    // and it is not negligible — dropping it would bias a comparison against
    // measured peculiar velocities in one direction.
    const lin = radialVelocityKms(60, profile, { z: Z, linear: true });
    const qlin = radialVelocityKms(60, profile, { z: Z });
    assert.ok(qlin > lin, 'the quasi-linear correction boosts a void outflow');
    assert.ok((qlin / lin - 1) > 0.05 && (qlin / lin - 1) < 0.25,
        `the correction is 5–25 % (got ${((qlin / lin - 1) * 100).toFixed(1)} %)`);
    ok('velocity: outward, peaks inside r_s, quasi-linear boost is 5–25 %');
}

// ── 7. IDENTITY — tr T_ij = δ, and g = −dΦ/dr ───────────────────────────────
{
    for (const r of [5, 45, 87, 100, 160, 260]) {
        const e = tidalEigenvalues(r, profile);
        near(e.radial + 2 * e.tangential, profile.deltaAt(r), 1e-12,
            `Poisson: tr T = δ at r = ${r}`);
        near(e.trace, profile.deltaAt(r), 1e-12, `the reported trace is δ at r = ${r}`);
        near(e.radial, profile.deltaAt(r) - (2 / 3) * profile.integratedAt(r), 1e-12,
            `λ_radial = δ − (2/3)Δ at r = ${r}`);
        near(e.tangential, profile.integratedAt(r) / 3, 1e-12,
            `λ_tangential = Δ/3 at r = ${r}`);

        // The full Cartesian tensor must reduce to the same eigenvalues.
        const T = voidTidalTensor([r, 0, 0], [0, 0, 0], profile);
        const { values } = symmetricEigen(T);
        near(values[0] + values[1] + values[2], profile.deltaAt(r), 1e-12,
            `the Cartesian tensor's trace is δ at r = ${r}`);
    }
    // SI conversion is exactly the natural unit times 4πGρ̄.
    const eSI = tidalEigenvaluesSI(80, profile, { z: Z });
    near(eSI.radial, tidalEigenvalues(80, profile).radial * fourPiGRhoM(Z), 1e-30,
        'the SI eigenvalues are the natural ones × 4πGρ̄');

    // g = −dΦ/dr_phys. Φ and g are written through independent (1+z) chains —
    // this is the check that caught the (1+z)³ potential bug.
    for (const r of [30, 92, 150, 240]) {
        const h = 0.05;
        const dPhi = (profile.potentialAt(r + h, Z) - profile.potentialAt(r - h, Z)) / (2 * h);
        const dPhiPhys = dPhi * (1 + Z) / MPC_M;       // d/dr_com → d/dr_phys
        near(-dPhiPhys, gravityRadialSI(r, profile, { z: Z }),
            1e-3 * Math.abs(dPhiPhys), `g = −dΦ/dr_phys at r = ${r}`);
    }
    ok('IDENTITY tr T = δ (Poisson), and g = −dΦ/dr across two (1+z) chains');
}

// ── 8. Mass, gravity and the human-readable unit ────────────────────────────
{
    assert.ok(enclosedMassExcessMsun(92, profile) < 0, 'the void encloses a mass DEFICIT');
    const { deficit } = splitProfile(profile);
    const total = enclosedMassExcessMsun(profile.rMaxMpc, deficit);
    assert.ok(total < -1e16 && total > -1e17,
        `the deficit is of order 10¹⁶ M☉ (got ${total.toExponential(2)})`);

    for (const r of [20, 92, 200]) {
        assert.ok(gravityRadialSI(r, profile, { z: Z }) > 0,
            `peculiar gravity points OUTWARD at r = ${r}`);
    }
    near(gravityKmsPerGyr(92, profile, { z: Z }),
        gravityRadialSI(92, profile, { z: Z }) * GYR_S / 1000, 1e-12,
        'km/s/Gyr is the SI value × 1 Gyr');
    const gHuman = gravityKmsPerGyr(60, profile, { z: Z });
    assert.ok(gHuman > 3 && gHuman < 120,
        `the readable acceleration is tens of km/s per Gyr (got ${gHuman.toFixed(1)})`);

    // The vector form must agree with the radial form, and point outward.
    const gv = voidGravityVector([0, 0, 70], [0, 0, 0], profile, { z: Z });
    near(gv[2], gravityRadialSI(70, profile, { z: Z }), 1e-24, 'vector g matches radial g');
    near(gv[0], 0, 1e-30, 'vector g has no transverse part for a sphere');
    ok('mass deficit ~10¹⁶ M☉, gravity outward, km/s/Gyr conversion exact');
}

// ── 9. Point sources: the (1+z)² chain and the shell theorem ────────────────
{
    // A spherical shell of point masses must reproduce GM/r_phys² outside it,
    // through pointGravityVector — the check that caught the missing (1+z)².
    const M0 = 1e15;
    const R = 100;
    const N = 40000;
    const rng = (() => { let a = 12345; return () => {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }; })();
    let g = [0, 0, 0];
    const at = [200, 0, 0];
    for (let i = 0; i < N; i++) {
        const u = 2 * rng() - 1;
        const phi = 2 * Math.PI * rng();
        const s = Math.sqrt(1 - u * u);
        const src = [R * s * Math.cos(phi), R * s * Math.sin(phi), R * u];
        const gi = pointGravityVector(at, src, M0 / N, 0, Z);
        g = [g[0] + gi[0], g[1] + gi[1], g[2] + gi[2]];
    }
    const rPhys = 200 * MPC_M / (1 + Z);
    const expected = G_SI * M0 * MSUN_KG / (rPhys * rPhys);
    withinPercent(Math.hypot(...g), expected, 1.5,
        'a shell of point masses obeys the shell theorem at the right (1+z)²');

    // And the void's own gravity must agree with the same shell, since both
    // are "mass M inside radius r". This is the cross-check between the two
    // independent gravity implementations.
    const equivalent = buildProfile(
        (r) => (r < 50 ? 3 * M0 / (4 * Math.PI * 50 ** 3 * meanMatterDensityMsunMpc3()) : 0),
        { rvMpc: 91.6, rsMpc: 50 });
    withinPercent(Math.abs(gravityRadialSI(200, equivalent, { z: Z })), expected, 1.5,
        'the continuous and point-mass gravity paths agree on the same mass');

    // An UNSOFTENED point mass has a traceless tidal tensor — vacuum Poisson.
    const T0 = pointTidalTensor([50, 20, 10], [0, 0, 0], 1e15, 0);
    near(T0[0] + T0[4] + T0[8], 0, 1e-12, 'an unsoftened point mass is traceless');

    // A SOFTENED one is not, and must not be: Plummer softening replaces the
    // point with a finite-density sphere, and the trace is exactly that
    // sphere's density contrast — 3Mε²/(4πρ̄(d²+ε²)^{5/2}) in the natural unit.
    // This is the difference between "the softening is a numerical fudge" and
    // "the softening is a mass distribution", and only the second is safe to
    // sum into a tidal field the page draws eigenvectors from.
    const eps = 6;
    const d2 = 50 ** 2 + 20 ** 2 + 10 ** 2;
    const T1 = pointTidalTensor([50, 20, 10], [0, 0, 0], 1e15, eps);
    const expectedTrace = 3 * 1e15 * eps * eps
        / (4 * Math.PI * meanMatterDensityMsunMpc3() * Math.pow(d2 + eps * eps, 2.5));
    withinPercent(T1[0] + T1[4] + T1[8], expectedTrace, 1e-6,
        'a softened point mass carries exactly the Plummer density in its trace');
    assert.ok(T1[0] + T1[4] + T1[8] > 0, 'and that density is positive');

    // Symmetry, which the eigen-solver assumes.
    // Symmetric to floating-point round-off, not exactly: the off-diagonals
    // are computed as separate products, so they differ in the last ULP.
    const sym = (a, b) => Math.abs(a - b) <= 1e-14 * Math.abs(a);
    assert.ok(sym(T1[1], T1[3]), 'the tidal tensor is symmetric (xy)');
    assert.ok(sym(T1[2], T1[6]), 'the tidal tensor is symmetric (xz)');
    assert.ok(sym(T1[5], T1[7]), 'the tidal tensor is symmetric (yz)');
    ok('point sources: shell theorem at (1+z)², Plummer trace is a real density');
}

// ── 10. Eigen-decomposition ─────────────────────────────────────────────────
{
    const T = [2, 0, 0, 0, 5, 0, 0, 0, -1];
    const { values, vectors } = symmetricEigen(T);
    near(values[0], 5, 1e-9, 'eigenvalues come back sorted descending');
    near(values[1], 2, 1e-9, 'middle eigenvalue');
    near(values[2], -1, 1e-9, 'smallest eigenvalue');
    near(Math.abs(vectors[0][1]), 1, 1e-6, 'the top eigenvector is the y axis');

    // A non-diagonal case, checked by residual rather than by a remembered answer.
    const A = [4, 1, 2, 1, 3, -1, 2, -1, 6];
    const e = symmetricEigen(A);
    near(e.values[0] + e.values[1] + e.values[2], 4 + 3 + 6, 1e-9, 'trace is preserved');
    for (let k = 0; k < 3; k++) {
        const v = e.vectors[k];
        const Av = [
            A[0] * v[0] + A[1] * v[1] + A[2] * v[2],
            A[3] * v[0] + A[4] * v[1] + A[5] * v[2],
            A[6] * v[0] + A[7] * v[1] + A[8] * v[2],
        ];
        for (let i = 0; i < 3; i++) {
            near(Av[i], e.values[k] * v[i], 1e-6, `Av = λv for eigenpair ${k}`);
        }
    }
    ok('symmetric eigen-decomposition: sorted, trace-preserving, Av = λv');
}

// ── 11. Redshift space: the void is ELONGATED, not squashed ─────────────────
{
    for (const r of [30, 60, 92]) {
        const eps = apparentEllipticity(r, profile, { z: Z });
        assert.ok(eps > 1,
            `the void looks ELONGATED along the line of sight at r = ${r} (ε = ${eps.toFixed(3)}); `
            + 'a value below 1 means the outflow sign was inverted');
    }
    // The distortion dies at large radius where the outflow does.
    assert.ok(apparentEllipticity(30, profile, { z: Z })
        > apparentEllipticity(200, profile, { z: Z }),
        'the redshift-space distortion fades outward with the outflow');

    // A point exactly transverse to the line of sight is not displaced at all.
    const los = [0, 0, 1];
    const across = toRedshiftSpace([60, 0, 0], profile, los, { z: Z });
    near(across[2], 0, 1e-12, 'a transverse offset gets no line-of-sight shift');
    near(across[0], 60, 1e-12, 'a transverse offset is otherwise unchanged');

    // The quadrupole ratio is negative in the void interior and carries β.
    assert.ok(rsdQuadrupoleRatio(60, profile, { z: Z, bias: 1.5 }) < 0,
        'the void–galaxy quadrupole ratio is negative in the interior');
    const b1 = Math.abs(rsdQuadrupoleRatio(60, profile, { z: Z, bias: 1.0 }));
    const b2 = Math.abs(rsdQuadrupoleRatio(60, profile, { z: Z, bias: 2.0 }));
    withinPercent(b1 / b2, 2, 1, 'the quadrupole scales as β = f/b');
    ok('redshift space: elongated along the sightline, quadrupole scales as f/b');
}

// ── 12. Weak lensing: a void is a DIVERGING lens ────────────────────────────
{
    assert.ok(surfaceDensityExcess(0, profile) < 0,
        'the central sightline is under-dense in projection');
    for (const R of [20, 60, 92, 140]) {
        assert.ok(deltaSigma(R, profile) < 0,
            `ΔΣ(${R}) < 0 — void lensing stretches background galaxies RADIALLY`);
        assert.ok(tangentialShear(R, profile, { zLens: Z, zSource: 0.9 }) < 0,
            `γ_t(${R}) < 0, the opposite sign to a cluster`);
    }
    // Σ_cr diverges as the source approaches the lens — no lensing power there.
    assert.ok(criticalSurfaceDensityMsunMpc2(Z, Z + 1e-6)
        > criticalSurfaceDensityMsunMpc2(Z, 1.0),
        'Σ_crit is larger for a source just behind the lens');

    // THE HONEST NULL. Even for a supervoid this size, a deep survey gets
    // SNR of order unity per annulus. That is the correct answer and the
    // reason the literature stacks thousands of voids instead of measuring one.
    const snr = lensingSNR(90, profile, {
        zLens: Z, zSource: 0.9, annulusWidthMpc: 20, galaxiesPerArcmin2: 10,
    });
    assert.ok(snr > 0.3 && snr < 8,
        `single-void lensing SNR is of order unity, not a detection (got ${snr.toFixed(2)})`);
    ok('lensing: ΔΣ < 0, γ_t < 0, and a stated order-unity SNR null');
}

// ── 13. ISW: a COLD spot, deepest on the central sightline ──────────────────
{
    const central = iswTemperatureShiftK(0, profile, { z: Z });
    assert.ok(central < 0,
        `a void's ISW imprint is a COLD spot (got ${(central * 1e6).toFixed(2)} µK). `
        + 'A positive value means Φ went negative somewhere — check compensation.');
    const muK = Math.abs(central) * 1e6;
    assert.ok(muK > 0.2 && muK < 20,
        `the amplitude is a few µK, not a detection on its own (got ${muK.toFixed(2)})`);

    // Monotonic: deepest through the centre, shallower as the sightline moves
    // out. An over-compensated profile breaks exactly this, by putting the
    // extremum off-centre.
    let previous = -Infinity;
    for (const b of [0, 40, 92, 150, 250]) {
        const dt = iswTemperatureShiftK(b, profile, { z: Z });
        assert.ok(dt > previous, `|ΔT| decreases outward at impact parameter ${b}`);
        assert.ok(dt <= 0, `ΔT stays a cold spot at impact parameter ${b}`);
        previous = dt;
    }
    ok('ISW: cold spot, few µK, deepest on the central sightline');
}

// ── 14. Bias — the page's dominant systematic ───────────────────────────────
{
    near(matterContrastFromGalaxy(-0.87, 1.5), -0.58, 1e-9, 'δ_m = δ_g / b');
    near(galaxyContrastFromMatter(-0.58, 1.5), -0.87, 1e-9, 'the forward direction inverts it');
    // The clip is what stops a low bias producing a density below zero, which
    // would poison every integral downstream with a nonsensical value rather
    // than an inaccurate one.
    assert.ok(matterContrastFromGalaxy(-0.95, 0.5) > -1,
        'the clip keeps δ_m above −1 for a low bias');
    near(matterContrastFromGalaxy(-0.95, 0.5, { clip: false }), -1.9, 1e-9,
        'without the clip it is free to go unphysical, on request');
    assert.throws(() => matterContrastFromGalaxy(-0.8, 0), /positive/,
        'a zero bias is rejected rather than returning Infinity');

    // Downstream scaling: halving the bias doubles the matter contrast and so
    // roughly doubles every amplitude. This is the error budget, made explicit.
    const shallow = createVoidProfile({ deltaC: matterContrastFromGalaxy(-0.87, 2.0) });
    const deep = createVoidProfile({ deltaC: matterContrastFromGalaxy(-0.87, 1.2) });
    assert.ok(Math.abs(radialVelocityKms(60, deep, { z: Z }))
        > Math.abs(radialVelocityKms(60, shallow, { z: Z })) * 1.4,
        'a lower bias means a deeper void and a much faster outflow');
    ok('bias: δ_m = δ_g/b, clipped, and it scales the whole chain');
}

// ── 15. Influence: three well-posed measures, no fractional trap ────────────
{
    const { deficit } = splitProfile(profile);
    // With no external field at all, the void dominates everywhere and the
    // crossover must simply not exist — reported as fraction 0, not as a
    // silently-clamped radius.
    const alone = influenceProfile(deficit, () => [0, 0, 0], {
        z: Z, directions: 16, stepMpc: 20,
    });
    assert.equal(alone.crossover.fraction, 0,
        'with nothing else in the universe, the web never overtakes the void');
    assert.equal(alone.crossover.medianMpc, null,
        'and the crossover radius is null rather than a made-up number');
    assert.ok(alone.shareProfile.every(s => s.median === 1),
        'the void owns 100 % of the acceleration when it is the only thing there');

    assert.ok(alone.velocityHorizonMpc > profile.params.rvMpc,
        'the 50 km/s velocity horizon lies beyond R_v');
    assert.ok(alone.velocityHorizonMpc < 400, 'and well inside the tabulated range');

    // A stronger threshold must pull the horizon inward — monotonicity is the
    // only thing that makes the number interpretable.
    const strict = influenceProfile(deficit, () => [0, 0, 0], {
        z: Z, directions: 8, stepMpc: 5, velocityThresholdKms: 150,
    });
    assert.ok(strict.velocityHorizonMpc < alone.velocityHorizonMpc,
        'a larger velocity threshold gives a smaller horizon');
    ok('influence: velocity horizon monotonic, crossover honestly null when absent');
}

// ── 16. Alignment statistic ─────────────────────────────────────────────────
{
    // Perfectly aligned segments: mean |cos| = 1, hugely significant.
    const aligned = [1, 2, 3, 4, 5, 6, 7, 8].map(() => ({ direction: [0, 0, 1] }));
    const a = alignmentStatistic(aligned, () => [0, 0, 1]);
    near(a.meanAbsCos, 1, 1e-12, 'perfect alignment gives mean |cos| = 1');
    assert.ok(a.z > 4, 'and a large z-score');

    // Perpendicular segments: mean |cos| = 0, significant the other way.
    const perp = aligned.map(() => ({ direction: [1, 0, 0] }));
    const b = alignmentStatistic(perp, () => [0, 0, 1]);
    near(b.meanAbsCos, 0, 1e-12, 'perpendicular gives mean |cos| = 0');
    assert.ok(b.z < -4, 'and a large negative z-score');

    // The isotropic expectation is exactly 0.5 — which is why the null needs
    // no simulation. Verify it by Monte Carlo so the constant cannot rot.
    let seed = 7;
    const rand = () => {
        seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const iso = [];
    for (let i = 0; i < 20000; i++) {
        const u = 2 * rand() - 1;
        const phi = 2 * Math.PI * rand();
        const s = Math.sqrt(1 - u * u);
        iso.push({ direction: [s * Math.cos(phi), s * Math.sin(phi), u] });
    }
    const c = alignmentStatistic(iso, () => [0, 0, 1]);
    near(c.meanAbsCos, 0.5, 0.01, 'isotropic directions give mean |cos| = 0.5 exactly');
    assert.ok(Math.abs(c.z) < 3, 'and no significant alignment');
    assert.equal(alignmentStatistic([], () => [0, 0, 1]).n, 0, 'an empty set is handled');
    ok('alignment statistic: calibrated against aligned, perpendicular and isotropic');
}

// ── 17. Purity ──────────────────────────────────────────────────────────────
{
    const src = readFileSync(fileURLToPath(new URL('../js/bootes-void-model.js', import.meta.url)), 'utf8');
    const body = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const forbidden of ['document', 'window', 'fetch(', 'localStorage', 'three']) {
        assert.ok(!body.includes(forbidden),
            `the kernel must stay pure — found "${forbidden}"`);
    }
    assert.ok(!/Date\.now|new Date/.test(body), 'the kernel must not read ambient time');
    assert.ok(!/Math\.random/.test(body), 'the kernel must be deterministic');
    ok('purity: no DOM, no fetch, no ambient time, no Math.random');
}

console.log(`\n${passed} checks passed — js/bootes-void-model.js`);
