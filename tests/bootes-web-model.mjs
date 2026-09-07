#!/usr/bin/env node
/**
 * bootes-web-model.mjs — gate for js/bootes-web-model.js and
 * js/bootes-void-data.js.
 *
 * Run: node tests/bootes-web-model.mjs
 *
 * The web is SYNTHETIC, so there is nothing here to compare against nature and
 * this file does not pretend otherwise. What it pins is the set of properties
 * that make the synthetic web usable as an experiment rather than as scenery:
 *
 *   1. MASS CONSERVATION. The discrete web carries exactly the profile's own
 *      compensating-wall mass. Nobody typed a mass in, and if a future edit
 *      lets one in, this fails.
 *   2. THE SHELL THEOREM. Far outside the wall the clumped web reproduces
 *      GM(<r)/r_phys². This is the check that caught the missing (1+z)² in
 *      pointGravityVector — a silent 10 % bias in favour of the void that
 *      every other quantity on the page happily accommodated.
 *   3. THE MONOPOLE IS PRESERVED UNDER CLUMPING. Turning `clumpiness` up
 *      rearranges the wall without moving mass in or out of a radius. That is
 *      what makes "void or web?" a question about geometry.
 *   4. DETERMINISM. Same seed ⇒ identical web, so the page's "re-roll" is a
 *      deliberate act and the R_influence figure is not jittering under the
 *      reader.
 *   5. THE CIRCULARITY IS REAL AND MEASURABLE. `filamentAlignment` with
 *      which:'web' is a positive control that MUST come out significant — the
 *      filaments were drawn between the particles whose field is being
 *      measured. A statistic that cannot detect a known alignment is broken.
 *   6. THE h⁻¹ CONVERSION happens exactly once (js/bootes-void-data.js).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
    G_SI, MPC_M, MSUN_KG, C_KMS, COSMOLOGY,
    createVoidProfile, splitProfile, wallMassMsun, meanMatterDensityMsunMpc3,
    influenceProfile, comovingDistanceMpc,
} from '../js/bootes-void-model.js';
import {
    createCosmicWeb, sampleTracers, counterfactualAt, filamentAlignment,
    monopoleFidelity, mulberry32,
} from '../js/bootes-web-model.js';
import {
    BOOTES_VOID, PROFILE_PRESETS, BIAS_RANGE, DEFAULT_BIAS, ANCHOR_ACCURACY,
    NEIGHBOUR_ANCHORS, voidRedshift, voidDistanceMpc, effectiveRadiusMpc,
    countBasedDeficit, equatorialToCartesianMpc, cartesianToEquatorial,
    voidCenterCartesian, losUnitFromVoid, resolvedAnchors,
} from '../js/bootes-void-data.js';

let passed = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); passed++; };
const near = (a, b, tol, msg) =>
    assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);
const withinPercent = (a, b, pct, msg) =>
    assert.ok(Math.abs(a / b - 1) * 100 <= pct,
        `${msg}: ${a} vs ${b} (${((a / b - 1) * 100).toFixed(2)}%, allowed ${pct}%)`);

const profile = createVoidProfile();
const Z = voidRedshift();
const anchors = resolvedAnchors();

// ── 1. The published inputs, and the h⁻¹ conversion ─────────────────────────
{
    withinPercent(Z, 0.0517, 0.5, 'the void redshift comes from cz = 15 500 km/s');
    near(Z, BOOTES_VOID.czKms / C_KMS, 1e-12, 'and is derived, not typed');
    withinPercent(voidDistanceMpc(), 226, 2, 'comoving distance ≈ 226 Mpc');

    // THE h⁻¹ TRAP. The literature's 62 h⁻¹ Mpc is 91.6 Mpc at Planck's h.
    // Reading it as 62 Mpc — which is what the popular figures do — shrinks
    // the void by a factor 1.48 and every amplitude on the page with it.
    near(effectiveRadiusMpc(), BOOTES_VOID.effectiveRadiusHinvMpc / COSMOLOGY.h, 1e-12,
        'R_eff converts h⁻¹ Mpc → Mpc exactly once');
    withinPercent(effectiveRadiusMpc(), 91.6, 0.5, 'R_eff ≈ 91.6 Mpc at Planck h');
    assert.ok(effectiveRadiusMpc() > BOOTES_VOID.effectiveRadiusHinvMpc,
        'the physical radius is LARGER than the h⁻¹ number, not equal to it');

    // The stated radius must be reproducible from the stated volume — that is
    // why both are recorded rather than just the radius.
    const fromVolume = Math.cbrt(3 * BOOTES_VOID.volumeHinv3Mpc3 / (4 * Math.PI));
    withinPercent(BOOTES_VOID.effectiveRadiusHinvMpc, fromVolume, 1,
        'the quoted radius is the cube root of the quoted volume');

    withinPercent(countBasedDeficit(), -0.97, 1, 'the raw count deficit is −0.97');
    assert.ok(countBasedDeficit() < profile.integratedAt(effectiveRadiusMpc()),
        'the count-based deficit is DEEPER than the profile average — the two are '
        + 'different measurements and the page must show both, not reconcile them');

    assert.ok(ANCHOR_ACCURACY.transcribed, 'anchor provenance is declared');
    assert.ok(ANCHOR_ACCURACY.refresher.startsWith('scripts/'),
        'and names the script that would refresh it from a catalogue');
    for (const a of NEIGHBOUR_ANCHORS) {
        assert.ok(a.source && a.note, `${a.id} carries a source and a note`);
        assert.ok(a.raDeg >= 0 && a.raDeg < 360, `${a.id} RA is in range`);
        assert.ok(a.decDeg > -90 && a.decDeg < 90, `${a.id} Dec is in range`);
        assert.ok(a.z > 0 && a.z < 0.2, `${a.id} redshift is plausible`);
    }
    ok('published inputs: derived redshift, the h⁻¹ conversion, declared provenance');
}

// ── 2. Coordinates round-trip ───────────────────────────────────────────────
{
    for (const [ra, dec, d] of [[0, 0, 100], [222.5, 46, 226], [359.9, -80, 50], [90, 0, 1]]) {
        const back = cartesianToEquatorial(equatorialToCartesianMpc(ra, dec, d));
        near(back.raDeg, ra, 1e-9, `RA round-trips at ${ra}`);
        near(back.decDeg, dec, 1e-9, `Dec round-trips at ${dec}`);
        near(back.distanceMpc, d, 1e-9, `distance round-trips at ${d}`);
    }
    const c = voidCenterCartesian();
    withinPercent(Math.hypot(...c), voidDistanceMpc(), 1e-9,
        'the void centre sits at the right distance');

    // The line of sight points from the void back to us — a unit vector, and
    // NOT a coordinate axis. The RSD figure is anisotropic about exactly this
    // direction, so a hard-coded axis would draw a plausible-looking figure
    // pointing the wrong way.
    const los = losUnitFromVoid();
    near(Math.hypot(...los), 1, 1e-12, 'the line of sight is a unit vector');
    const dot = (los[0] * c[0] + los[1] * c[1] + los[2] * c[2]) / Math.hypot(...c);
    near(dot, -1, 1e-12, 'and points back towards the observer');
    assert.ok(Math.max(...los.map(Math.abs)) < 0.99,
        'it is genuinely oblique — not accidentally a coordinate axis');

    // Anchors land in the wall zone, not on top of the void centre.
    for (const a of anchors) {
        assert.ok(a.radiusMpc > effectiveRadiusMpc(),
            `${a.id} lies outside R_eff (${a.radiusMpc.toFixed(0)} Mpc)`);
        near(Math.hypot(...a.directionFromVoid), 1, 1e-12, `${a.id} direction is a unit vector`);
    }
    ok('coordinates: equatorial round-trip, oblique line of sight, anchors outside R_eff');
}

// ── 3. Mass conservation ────────────────────────────────────────────────────
{
    for (const clumpiness of [0, 0.35, 0.65, 1]) {
        const web = createCosmicWeb({ voidProfile: profile, anchors, clumpiness, z: Z });
        withinPercent(web.totalMassMsun, wallMassMsun(profile), 1e-6,
            `the web carries exactly the wall mass at clumpiness ${clumpiness}`);
        assert.ok(web.particles.every(p => p.massMsun > 0),
            'every particle carries positive mass');
    }
    // And the wall mass itself is a derived quantity, not a constant.
    const deeper = createVoidProfile({ deltaC: -0.8 });
    assert.ok(wallMassMsun(deeper) > wallMassMsun(profile),
        'a deeper void has a heavier compensating wall — the budget is derived');
    ok('mass conservation: the web IS the profile’s wall, at every clumpiness');
}

// ── 4. THE SHELL THEOREM — the check that caught the (1+z)² bug ─────────────
{
    const web = createCosmicWeb({
        voidProfile: profile, anchors: [], clumpiness: 0,
        nodeCount: 180, filamentParticles: 3600, softeningMpc: 1, z: Z,
    });
    const enclosed = (r) => web.particles.reduce((s, p) =>
        s + (Math.hypot(p.offsetMpc[0], p.offsetMpc[1], p.offsetMpc[2]) <= r ? p.massMsun : 0), 0);

    for (const r of [140, 220, 300]) {
        const g = web.externalGravityAt([r, 0, 0]);
        const rPhys = r * MPC_M / (1 + Z);
        const expected = G_SI * enclosed(r) * MSUN_KG / (rPhys * rPhys);
        withinPercent(Math.hypot(g[0], g[1], g[2]), expected, 6,
            `a near-isotropic web obeys the shell theorem at r = ${r}, including (1+z)²`);
    }

    // Deep inside the wall the shell theorem says ~zero, and it must not be
    // masked by a residual monopole from a badly sampled radial distribution.
    const inner = web.externalGravityAt([25, 0, 0]);
    const wallScale = G_SI * web.totalMassMsun * MSUN_KG
        / Math.pow(100 * MPC_M / (1 + Z), 2);
    assert.ok(Math.hypot(...inner) < 0.15 * wallScale,
        'the web’s field nearly vanishes deep inside its own shell');
    ok('shell theorem: reproduced outside, cancels inside, at the right (1+z)²');
}

// ── 5. Clumping rearranges without redistributing ───────────────────────────
{
    // Same seed, different clumpiness: the enclosed mass profile must barely
    // move, because clumping is angular. If it moves, the counterfactual is
    // comparing two different mass distributions and not two arrangements.
    for (const clumpiness of [0, 0.5, 1]) {
        const web = createCosmicWeb({ voidProfile: profile, anchors, clumpiness, z: Z });
        const fid = monopoleFidelity(web, profile, [120, 160, 220, 300, 420]);
        for (const row of fid) {
            assert.notEqual(row.ratio, undefined, 'fidelity rows report a ratio or null');
            if (row.ratio === null) continue;
            withinPercent(row.ratio, 1, 12,
                `enclosed wall mass at ${row.radiusMpc} Mpc survives clumpiness ${clumpiness}`);
        }
    }
    // Inside r_s the smooth wall has no mass at all, and the fidelity ratio is
    // reported as null rather than as a passing "1" on a quantity never tested.
    const web = createCosmicWeb({ voidProfile: profile, anchors, z: Z });
    assert.equal(monopoleFidelity(web, profile, [40])[0].ratio, null,
        'fidelity inside r_s is null, not a fake pass');
    ok('clumping is angular: the enclosed-mass profile survives it');
}

// ── 6. Determinism ──────────────────────────────────────────────────────────
{
    const a = createCosmicWeb({ voidProfile: profile, anchors, seed: 4242, z: Z });
    const b = createCosmicWeb({ voidProfile: profile, anchors, seed: 4242, z: Z });
    const c = createCosmicWeb({ voidProfile: profile, anchors, seed: 4243, z: Z });
    assert.equal(a.particles.length, b.particles.length, 'same seed, same particle count');
    for (let i = 0; i < a.particles.length; i++) {
        for (let k = 0; k < 3; k++) {
            assert.equal(a.particles[i].offsetMpc[k], b.particles[i].offsetMpc[k],
                'same seed reproduces every particle position exactly');
        }
    }
    const moved = a.particles.some((p, i) => c.particles[i]
        && p.offsetMpc[0] !== c.particles[i].offsetMpc[0]);
    assert.ok(moved, 'a different seed gives a different web');

    // The PRNG itself: deterministic, in range, and not degenerate.
    const rng = mulberry32(1);
    const draws = Array.from({ length: 5000 }, rng);
    assert.ok(draws.every(v => v >= 0 && v < 1), 'the PRNG stays in [0,1)');
    withinPercent(draws.reduce((s, v) => s + v, 0) / draws.length, 0.5, 4,
        'the PRNG has the right mean');
    assert.equal(new Set(draws).size, draws.length, 'and does not repeat over 5000 draws');
    ok('determinism: same seed reproduces the web exactly, different seed does not');
}

// ── 7. The counterfactual ───────────────────────────────────────────────────
{
    const web = createCosmicWeb({ voidProfile: profile, anchors, clumpiness: 0.65, z: Z });
    const { deficit } = splitProfile(profile);
    for (const r of [40, 92, 160, 260]) {
        const cf = counterfactualAt([r, 0, 0], { voidProfile: profile, web, z: Z });
        // A − B = Δ, exactly, in every component. This is the identity the
        // whole Test 4 claim rests on, and it holds because the web term is
        // bit-identical in both universes rather than recomputed.
        // "Exactly" here means to floating-point round-off — a few ULP, not
        // the four-digit agreement a genuine difference of two independently
        // summed particle fields would give. That gap is the whole reason the
        // web term is shared rather than recomputed.
        const ulp = (a, b, scale) => Math.abs(a - b) <= 1e-14 * Math.max(scale, Math.abs(b));
        const gScale = Math.hypot(...cf.A.gravity);
        for (let k = 0; k < 3; k++) {
            assert.ok(ulp(cf.A.gravity[k] - cf.B.gravity[k], cf.delta.gravity[k], gScale),
                `Δg = g_A − g_B to round-off, component ${k}, at r = ${r}`);
        }
        const tScale = Math.max(...cf.A.tidal.map(Math.abs));
        for (let k = 0; k < 9; k++) {
            assert.ok(ulp(cf.A.tidal[k] - cf.B.tidal[k], cf.delta.tidal[k], tScale),
                `ΔT = T_A − T_B to round-off, component ${k}, at r = ${r}`);
        }
        // The void's own contribution points OUTWARD from the centre.
        assert.ok(cf.delta.gravity[0] > 0,
            `removing the void changes the field by an outward vector at r = ${r}`);
        assert.ok(cf.voidShare > 0 && cf.voidShare <= 1, 'voidShare is a fraction');
    }
    // Deep inside the void, essentially all of the local acceleration is the
    // void's — the web is a shell and the shell theorem empties it.
    const inner = counterfactualAt([30, 0, 0], { voidProfile: profile, web, z: Z });
    assert.ok(inner.voidShare > 0.7, 'the void dominates its own interior');
    ok('counterfactual: A − B = Δ exactly, and the void owns its interior');
}

// ── 8. Alignment: the positive control must fire ────────────────────────────
{
    const web = createCosmicWeb({ voidProfile: profile, anchors, clumpiness: 0.65, z: Z });

    // POSITIVE CONTROL. 'web' is circular by construction — the filaments were
    // drawn between the very particles whose tidal field is measured — so it
    // MUST come out hugely significant. If it does not, the statistic is
    // broken and nothing else in this section means anything.
    const control = filamentAlignment({ voidProfile: profile, web, which: 'web', axis: 1 });
    assert.ok(control.circular, 'the web alignment is flagged as circular');
    assert.ok(Math.abs(control.z) > 5,
        `the positive control must fire (|z| = ${Math.abs(control.z).toFixed(1)}); `
        + 'a statistic that cannot see a known alignment cannot see an unknown one');
    assert.ok(control.meanAbsCos < 0.5,
        'filaments lie perpendicular to their own most-compressive tidal axis');

    // The real measurement. No assertion on its VALUE — that is the result,
    // and pinning it would be pinning the answer. What is pinned is that it is
    // computed against a well-defined eigenvector and reported with its null.
    const real = filamentAlignment({ voidProfile: profile, web, which: 'void', axis: 1 });
    assert.equal(real.circular, false, 'the void alignment is not flagged circular');
    assert.equal(real.n, web.filaments.length, 'every filament is counted');
    assert.equal(real.isotropic, 0.5, 'the isotropic null is exactly 0.5');
    assert.ok(Number.isFinite(real.z), 'the z-score is finite');
    withinPercent(Math.abs(real.meanAbsCos - 0.5) / Math.abs(real.z),
        Math.sqrt((1 / 12) / real.n), 1e-6, 'the z-score uses the analytic σ = √(1/12n)');

    // THE DEGENERACY TRAP. For the void's spherically symmetric field the two
    // TANGENTIAL eigenvalues are equal, so e₂ and e₃ are not defined and any
    // alignment measured against them is an artefact of the eigen-solver. The
    // reported eigenGap is what makes that visible instead of silent.
    const degenerate = filamentAlignment({ voidProfile: profile, web, which: 'void', axis: 3 });
    assert.ok(degenerate.minEigenGap < 1e-6,
        'the void’s tangential eigenvectors are degenerate — axis 2/3 is meaningless there, '
        + 'and the reported eigenGap says so');
    ok('alignment: positive control fires, real measurement reported with its null');
}

// ── 9. Influence, with a real web behind it ─────────────────────────────────
{
    const { deficit } = splitProfile(profile);
    const smooth = createCosmicWeb({ voidProfile: profile, anchors, clumpiness: 0, z: Z });
    const clumped = createCosmicWeb({ voidProfile: profile, anchors, clumpiness: 1, z: Z });

    const opts = { z: Z, directions: 48, stepMpc: 8 };
    const iSmooth = influenceProfile(deficit, smooth.externalGravityAt, opts);
    const iClumped = influenceProfile(deficit, clumped.externalGravityAt, opts);

    // The velocity horizon depends only on the void, so clumping must not
    // move it. If it does, something has leaked between the two halves.
    assert.equal(iSmooth.velocityHorizonMpc, iClumped.velocityHorizonMpc,
        'the velocity horizon is a property of the void alone');
    assert.ok(iSmooth.velocityHorizonMpc > effectiveRadiusMpc(),
        'and lies beyond R_eff');

    // THE RESULT THE PAGE REPORTS: clumping widens the SPREAD of the void's
    // share across directions without moving the median much. That is the
    // anisotropy — the void reaches further into empty directions than it does
    // towards Corona Borealis — and it is the whole reason the page draws a
    // band rather than a number.
    const bandAt = (inf, r) => {
        const row = inf.shareProfile.reduce((best, s) =>
            Math.abs(s.radiusMpc - r) < Math.abs(best.radiusMpc - r) ? s : best);
        return row.p84 - row.p16;
    };
    assert.ok(bandAt(iClumped, 160) > bandAt(iSmooth, 160),
        'a clumpier web makes the void’s influence more direction-dependent');

    // The share falls outward, monotonically enough to be readable.
    const first = iClumped.shareProfile[1].median;
    const last = iClumped.shareProfile[iClumped.shareProfile.length - 1].median;
    assert.ok(first > last, 'the void’s share of the local acceleration falls outward');
    assert.ok(iClumped.crossover.fraction >= 0 && iClumped.crossover.fraction <= 1,
        'the crossover fraction is a fraction');
    ok('influence: horizon is the void’s alone, clumping widens the anisotropy band');
}

// ── 10. Tracers are visual and say so ───────────────────────────────────────
{
    const web = createCosmicWeb({ voidProfile: profile, anchors, z: Z });
    const tracers = sampleTracers({ voidProfile: profile, web, count: 800, bias: DEFAULT_BIAS });
    assert.ok(tracers.length > 800, 'the web-following share is added on top of the field share');
    assert.ok(tracers.every(t => t.massMsun === undefined),
        'tracers carry NO mass — they must not be able to enter a gravity sum');

    // They actually trace the void: the interior is emptier than the wall.
    const inner = tracers.filter(t => t.radiusMpc < 50).length;
    const wallBand = tracers.filter(t => t.radiusMpc > 90 && t.radiusMpc < 140).length;
    const innerVol = Math.pow(50, 3);
    const wallVol = Math.pow(140, 3) - Math.pow(90, 3);
    assert.ok((inner / innerVol) < 0.6 * (wallBand / wallVol),
        'tracer number density is far lower inside the void than in its wall');

    // Bias is honoured: a higher bias empties the interior further.
    const highBias = sampleTracers({ voidProfile: profile, web, count: 800, bias: 2.0 });
    const lowBias = sampleTracers({ voidProfile: profile, web, count: 800, bias: 1.1 });
    const frac = (list) => list.filter(t => t.radiusMpc < 60).length / list.length;
    assert.ok(frac(highBias) < frac(lowBias),
        'a higher tracer bias evacuates the modelled void further');
    ok('tracers: massless, void-tracing, and responsive to the bias knob');
}

// ── 11. Presets and the declared error budget ───────────────────────────────
{
    for (const [id, preset] of Object.entries(PROFILE_PRESETS)) {
        assert.ok(preset.label && preset.note, `${id} carries a label and a note`);
        assert.ok(preset.alpha > 0 && preset.beta > preset.alpha,
            `${id}: β > α, or the wall never turns over and Δ does not converge`);
        assert.ok(preset.rsFraction > 0.5 && preset.rsFraction <= 1.1,
            `${id}: the zero crossing is near R_v`);
        assert.ok(preset.centralGalaxyContrast > -1 && preset.centralGalaxyContrast < 0,
            `${id}: the central galaxy contrast is a contrast`);
    }
    assert.ok(PROFILE_PRESETS['deep-core'].centralGalaxyContrast
        < PROFILE_PRESETS['hsw-supervoid'].centralGalaxyContrast,
        'the deep-core preset really is deeper');

    assert.ok(BIAS_RANGE.min < DEFAULT_BIAS && DEFAULT_BIAS < BIAS_RANGE.max,
        'the default bias sits inside the declared range');
    // The declared range is the page's dominant systematic, so it has to be
    // wide enough to be honest: at least a factor 1.5 across.
    assert.ok(BIAS_RANGE.max / BIAS_RANGE.min > 1.5,
        'the bias range spans the real observational uncertainty');
    ok('presets and the declared bias range');
}

// ── 12. Purity ──────────────────────────────────────────────────────────────
{
    for (const file of ['bootes-web-model.js', 'bootes-void-data.js']) {
        const src = readFileSync(
            fileURLToPath(new URL(`../js/${file}`, import.meta.url)), 'utf8');
        const body = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        for (const forbidden of ['document', 'window', 'fetch(', 'localStorage']) {
            assert.ok(!body.includes(forbidden), `${file} must stay pure — found "${forbidden}"`);
        }
        assert.ok(!/Math\.random/.test(body),
            `${file} must be deterministic — no Math.random`);
        assert.ok(!/Date\.now|new Date/.test(body), `${file} must not read ambient time`);
        assert.ok(!/from ['"]three/.test(src), `${file} must not import three.js`);
    }
    ok('purity: both modules are DOM-free, fetch-free, three-free and deterministic');
}

console.log(`\n${passed} checks passed — js/bootes-web-model.js + js/bootes-void-data.js`);
