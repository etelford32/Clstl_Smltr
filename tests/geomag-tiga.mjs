#!/usr/bin/env node
/**
 * geomag-tiga.mjs — gate for the estimator (js/geomag/tiga.js) and the
 * centred-dipole geometry it runs on (js/geomag/dipole.js).
 *
 * Run: node tests/geomag-tiga.mjs
 *
 * The identities pinned here are the load-bearing ones. In particular T3 —
 * that the classical index IS the one-parameter least-squares estimator — is
 * the claim the whole product argument rests on. If it ever stops holding to
 * 1e-10, either the forward model or the Legendre recursion has drifted, and
 * every downstream number becomes meaningless.
 *
 * The structure mirrors the original T1–T5 suite, including its most useful
 * feature: T1b isolates the coordinate TRANSFORM against analytic anchors, so
 * that when T1 (a DATA comparison) fails you can tell within one run whether
 * the fault is in the math or in the reference table. That distinction cost
 * real time to learn — a correct transform fed the wrong column of a
 * published table looked exactly like a model error.
 */

import assert from 'node:assert/strict';
import {
    designRow, designRowFrom, precomputeDP, classicalIndex, aliasAmplitude,
    TIGA, coeffCount, assimilateEpoch,
} from '../js/geomag/tiga.js';
import {
    toDipole, dipoleBasisForYear, smLongitude, smLongitudeAt, mltFromSmLongitude,
    subsolarPointGeo, dipoleTiltDay, dipoleTilt,
} from '../js/geomag/dipole.js';
import {
    KYOTO_TABLE1, SYMH6_TYPICAL, SYMH6_BALANCED, DST4, longitudeClustering,
} from '../js/geomag/observatories.js';

const DEG = Math.PI / 180;
let passed = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); passed++; };
const near = (a, b, tol, msg) =>
    assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);

const POOL = Object.keys(KYOTO_TABLE1);
const dipLat = (keys) => keys.map((k) => KYOTO_TABLE1[k].gmLatDeg);
const dipLon = (keys) => keys.map((k) => KYOTO_TABLE1[k].gmLonDeg);

// ── T1b. The transform, isolated against analytic anchors ────────────────────
{
    const b = dipoleBasisForYear(2026.0);
    near(toDipole(b.pole.poleLatDeg, b.pole.poleLonDeg, b).latDeg, 90, 1e-9,
        'the dipole pole must map to +90° dipole latitude');
    near(toDipole(-b.pole.poleLatDeg, b.pole.poleLonDeg + 180, b).latDeg, -90, 1e-9,
        'the antipode must map to −90° — the centred dipole is antipodal BY CONSTRUCTION');
    near(toDipole(b.pole.poleLatDeg - 90, b.pole.poleLonDeg, b).latDeg, 0, 1e-9,
        '90° from the pole must map to the dipole equator');
    ok('T1b — the transform is exact against analytic anchors (< 1e-9°)');
}

// ── T1. The transform vs the AUTHORITATIVE Kyoto column ──────────────────────
{
    // Against the correct `G.M. LAT.` column, agreement is pure secular drift.
    // Against the INVARIANT column it would be up to 9.5° out — a different
    // physical quantity, not a worse measurement of the same one.
    const b = dipoleBasisForYear(2026.0);
    let worst = 0, sum = 0, n = 0;
    for (const [code, v] of Object.entries(KYOTO_TABLE1)) {
        const d = toDipole(v.latDeg, v.lonDeg, b).latDeg - v.gmLatDeg;
        worst = Math.max(worst, Math.abs(d));
        sum += d; n++;
        assert.ok(Math.abs(d) < 2.5, `${code}: computed dipole latitude off by ${d.toFixed(2)}°`);
    }
    near(worst, 0.83, 0.1, 'max disagreement with Kyoto Table 1');
    near(sum / n, -0.02, 0.1, 'mean disagreement with Kyoto Table 1');

    // The diagnostic signature of the WRONG column, kept as a live check that
    // the two columns are still distinguishable in the committed table.
    near(KYOTO_TABLE1.HER.invariantLatDeg - Math.abs(KYOTO_TABLE1.HER.gmLatDeg), 9.52, 0.05,
        'Hermanus: invariant − dipole latitude (the +9.5° SAA signature)');
    assert.ok(KYOTO_TABLE1.CLF.invariantLatDeg - KYOTO_TABLE1.CLF.gmLatDeg < 0,
        'Chambon-la-Forêt: invariant − dipole must be NEGATIVE over strong-field Europe — '
        + 'the sign tracks the field-strength anomaly, which is what made the diagnosis possible');
    ok(`T1 — vs Kyoto Table 1: max ${worst.toFixed(2)}°, mean ${(sum / n).toFixed(2)}° (pure secular drift)`);
}

// ── The forward model IS paper Eq. (1) ───────────────────────────────────────
{
    // X = −q₁⁰ cos λ + (q₁¹ cos φ + s₁¹ sin φ) sin λ
    // This is not a tautology: it checks that the Schmidt recursion in igrf.js
    // yields −cos λ and sin λ exactly where Eq. (1) says it should.
    let worst = 0;
    for (const lat of [-70, -33.3, -0.0001, 17.5, 44, 88]) {
        for (const lon of [0, 37, 123, 271, 359.9]) {
            const r = designRow(lat, lon, 1);
            const e = [
                -Math.cos(lat * DEG),
                Math.sin(lat * DEG) * Math.cos(lon * DEG),
                Math.sin(lat * DEG) * Math.sin(lon * DEG),
            ];
            for (let i = 0; i < 3; i++) worst = Math.max(worst, Math.abs(r[i] - e[i]));
        }
    }
    assert.ok(worst < 1e-12, `designRow vs Eq. (1): ${worst}`);

    // The cached path must be IDENTICAL, not merely close — it is the one the
    // assimilation loop actually runs.
    let cw = 0;
    for (const lat of [-44, 0, 23.7, 49]) {
        const dP = precomputeDP(lat, 3);
        for (const lon of [0, 91, 266]) {
            const a = designRow(lat, lon, 3), c = designRowFrom(dP, lon, 3);
            assert.equal(a.length, c.length);
            for (let i = 0; i < a.length; i++) cw = Math.max(cw, Math.abs(a[i] - c[i]));
        }
    }
    assert.equal(cw, 0, `cached design row differs from the direct one by ${cw}`);
    assert.equal(coeffCount(1), 3);
    assert.equal(coeffCount(3), 15);
    ok(`forward model ≡ Eq. (1) to ${worst.toExponential(1)}; cached path bit-identical`);
}

// ── T2. Exact degree-1 recovery from a noiseless network ─────────────────────
{
    const truth = [87.3, -12.6, 31.9];
    const f = new TIGA();
    const lat = dipLat(POOL), lon = dipLon(POOL);
    for (let m = 0; m < 600; m++) {
        const present = POOL.map((k, i) => {
            const row = designRow(lat[i], smLongitude(lon[i], m), 1);
            return {
                dipLatDeg: lat[i], dipLonDeg: lon[i],
                xNt: row[0] * truth[0] + row[1] * truth[1] + row[2] * truth[2],
                varNt2: 4,
            };
        });
        // assimilateEpoch rebuilds H from scratch each minute — that IS the
        // dropout mechanism, exercised here in its no-dropout limit.
        assimilateEpoch(f, present, m, 1);
    }
    for (let i = 0; i < 3; i++) near(f.coeffs[i], truth[i], 1e-3, `T2 coefficient ${i}`);
    assert.ok(f.zonalSigmaNt > 0 && f.zonalSigmaNt < 5, `posterior σ implausible: ${f.zonalSigmaNt}`);
    near(f.zonalNt, -truth[0], 1e-3, 'zonal value on the index sign convention');
    // The fitted asymmetry peaks where the input put it.
    near(f.asymmetryNt, Math.hypot(truth[1], truth[2]), 1e-3, 'asymmetry amplitude');
    ok('T2 — exact degree-1 recovery, and the posterior is finite and small');
}

// ── T3. THE IDENTITY: the classical index is the one-parameter estimator ─────
{
    // With zonal-only truth, mean(X)/mean(cos λ) = −q₁⁰ EXACTLY, for every
    // station subset. Dst is a one-parameter fit written as arithmetic.
    const q10 = 87.3;
    let worst = 0;
    const sets = { 'Dst 4': DST4, 'SYM-H 6': SYMH6_TYPICAL, 'balanced 6': SYMH6_BALANCED, 'pool 11': POOL };
    for (const [name, keys] of Object.entries(sets)) {
        const lat = dipLat(keys);
        const X = lat.map((l) => -q10 * Math.cos(l * DEG));
        const diff = Math.abs(classicalIndex(lat, X) - (-q10));
        assert.ok(diff < 1e-10, `T3 identity broken for ${name}: ${diff}`);
        worst = Math.max(worst, diff);
    }
    // And on an ARBITRARY subset, not just the canonical ones — the identity is
    // algebraic, so it cannot depend on which stations were chosen.
    for (let trial = 0; trial < 20; trial++) {
        const keys = POOL.filter((_, i) => (i * 7 + trial * 3) % 11 < 6);
        if (keys.length < 2) continue;
        const lat = dipLat(keys);
        const X = lat.map((l) => -q10 * Math.cos(l * DEG));
        assert.ok(Math.abs(classicalIndex(lat, X) + q10) < 1e-10, `T3 broken on subset ${keys}`);
    }
    ok(`T3 — classical average ≡ −q₁⁰ for every subset (max ${worst.toExponential(1)} nT, gate 1e-10)`);
}

// ── T4. Order-1 aliasing: a 24-hour SINUSOID, driven by hemispheric balance ──
{
    const amp = (keys) => aliasAmplitude(dipLat(keys), dipLon(keys)).perUnitAsymmetry * 100;
    const a4 = amp(DST4), a6n = amp(SYMH6_TYPICAL), a6b = amp(SYMH6_BALANCED), a11 = amp(POOL);
    near(a4, 15, 1.5, 'Dst 4-station aliasing for a 100 nT ASY-H');
    near(a6n, 50, 2.5, 'all-northern SYM-H 6 aliasing');
    near(a6b, 30, 2.5, 'hemispherically balanced SYM-H 6 aliasing');
    near(a11, 26, 2.5, 'full 11-station pool aliasing');

    // The MECHANISM, not just the numbers: the all-northern six is 6N/0S and
    // the balanced six is 4N/2S at the SAME station count, and the balanced one
    // aliases far less. Station count is not the driver; hemispheric balance is.
    assert.equal(SYMH6_TYPICAL.length, SYMH6_BALANCED.length, 'the two sixes must be the same size');
    assert.ok(a6b < a6n * 0.75,
        `balancing the hemispheres must cut aliasing sharply: ${a6b.toFixed(1)} vs ${a6n.toFixed(1)} nT`);
    assert.equal(dipLat(SYMH6_TYPICAL).filter((v) => v < 0).length, 0, 'the typical six is all-northern');
    assert.ok(dipLat(SYMH6_BALANCED).filter((v) => v < 0).length >= 2, 'the balanced six has southern stations');

    // A monthly reselection moves the PHASE as well as the amplitude, which is
    // the mechanism for a month-interface residual in the published index.
    const p1 = aliasAmplitude(dipLat(SYMH6_TYPICAL), dipLon(SYMH6_TYPICAL)).phaseDeg;
    const p2 = aliasAmplitude(dipLat(SYMH6_BALANCED), dipLon(SYMH6_BALANCED)).phaseDeg;
    assert.ok(Math.abs(((p1 - p2 + 540) % 360) - 180) > 20,
        'reselecting the six must shift the UT phase, not only the amplitude');
    ok(`T4 — aliasing per 100 nT ASY-H: Dst4 ±${a4.toFixed(0)}, 6N ±${a6n.toFixed(0)}, balanced ±${a6b.toFixed(0)}, pool ±${a11.toFixed(0)} nT`);
}

// ── T5. Negative control: scrambled geometry must destroy the fit ────────────
{
    // If a model scored well on scrambled coordinates it would be exploiting
    // something other than the physics.
    const truth = [87.3, -12.6, 31.9];
    const lat = dipLat(POOL), lon = dipLon(POOL);
    const rows = POOL.map((_, i) => designRow(lat[i], lon[i], 1));
    const d = rows.map((r) => r[0] * truth[0] + r[1] * truth[1] + r[2] * truth[2]);

    const fit = (H) => {
        const f = new TIGA({ memoryless: true });
        for (let k = 0; k < 40; k++) { f.predict(); f.update(H, d, H.map(() => 1), 0); }
        return f.coeffs;
    };
    const good = fit(rows);
    // Deterministic scramble: reverse the latitudes against the longitudes.
    const scrambled = POOL.map((_, i) => designRow(lat[POOL.length - 1 - i], lon[i], 1));
    const bad = fit(scrambled);

    const errGood = Math.max(...good.map((v, i) => Math.abs(v - truth[i])));
    const errBad = Math.max(...bad.map((v, i) => Math.abs(v - truth[i])));
    assert.ok(errGood < 1e-6, `true geometry must recover the truth: ${errGood}`);
    assert.ok(errBad > 1, `scrambled geometry must NOT recover the truth: ${errBad}`);
    ok(`T5 — negative control: true geometry ${errGood.toExponential(1)} nT, scrambled ${errBad.toFixed(1)} nT`);
}

// ── The rank-1 common-mode term must WIDEN the posterior ─────────────────────
{
    // This is the fix for a 25× overconfidence, so its effect has a direction
    // and the gate checks the direction rather than a magic number. Removing
    // the term must make the posterior narrower — that is the failure mode.
    const lat = dipLat(POOL), lon = dipLon(POOL);
    const H = POOL.map((_, i) => designRow(lat[i], lon[i], 1));
    const d = H.map((r) => r[0] * 100);
    const run = (commonVar) => {
        const f = new TIGA();
        for (let k = 0; k < 200; k++) { f.predict(); f.update(H, d, H.map(() => 54), commonVar); }
        return f.zonalSigmaNt;
    };
    const diagonal = run(0);
    const rank1 = run(54);
    assert.ok(rank1 > diagonal * 1.2,
        `the rank-1 common-mode term must widen the posterior (diagonal ${diagonal.toFixed(3)}, `
        + `rank-1 ${rank1.toFixed(3)}) — with a diagonal R the filter believes it averages `
        + 'correlated representativeness error down by √k, and it does not');
    ok(`common-mode R widens σ from ${diagonal.toFixed(2)} to ${rank1.toFixed(2)} nT (correlated error is not averaged away)`);
}

// ── Robustness: a spike must be down-weighted, not chased ────────────────────
{
    const lat = dipLat(POOL), lon = dipLon(POOL);
    const H = POOL.map((_, i) => designRow(lat[i], lon[i], 1));
    const clean = H.map((r) => r[0] * 100);
    const spiked = clean.slice();
    spiked[3] += 400;                       // one station throws a 400 nT spike
    const run = (obs) => {
        const f = new TIGA();
        for (let k = 0; k < 300; k++) { f.predict(); f.update(H, obs, H.map(() => 4), 0); }
        return f.coeffs[0];
    };
    const shift = Math.abs(run(spiked) - run(clean));
    assert.ok(shift < 25,
        `a single 400 nT spike moved q₁⁰ by ${shift.toFixed(1)} nT — the Huber pass is not down-weighting it`);
    ok(`Huber robustness: a 400 nT spike moves q₁⁰ by only ${shift.toFixed(1)} nT`);
}

// ── Dropout is architectural: fewer stations widens σ, never breaks ──────────
{
    const lat = dipLat(POOL), lon = dipLon(POOL);
    const sigmaFor = (nStations) => {
        const f = new TIGA();
        for (let m = 0; m < 400; m++) {
            const H = [], d = [], r = [];
            for (let i = 0; i < nStations; i++) {
                const row = designRow(lat[i], smLongitude(lon[i], m), 1);
                H.push(row); d.push(row[0] * 100); r.push(54);
            }
            f.predict();
            f.update(H, d, r, 54);
        }
        return f.zonalSigmaNt;
    };
    const s11 = sigmaFor(11), s3 = sigmaFor(3);
    assert.ok(Number.isFinite(s3) && s3 > 0, 'three stations must still produce a finite posterior');
    assert.ok(s3 > s11, `dropping to three stations must WIDEN σ (${s11.toFixed(2)} → ${s3.toFixed(2)})`);

    // Below the parameter count the filter must COAST on the prior rather than
    // throw — that is the whole point of carrying state.
    const f = new TIGA();
    for (let m = 0; m < 200; m++) {
        f.predict();
        const row = designRow(lat[0], smLongitude(lon[0], m), 1);
        f.update([row], [row[0] * 100], [54], 54);
    }
    assert.ok(Number.isFinite(f.zonalNt), 'a single station must not break the filter');
    // And a completely empty epoch is a no-op update, not an error.
    assert.equal(f.update([], [], [], 0), 0, 'an empty epoch must return 0 stations used');
    ok(`dropout: σ widens 11 → 3 stations (${s11.toFixed(2)} → ${s3.toFixed(2)} nT), 1 station and 0 stations both survive`);
}

// ── The memoryless control must actually be memoryless ───────────────────────
{
    // The control is not scaffolding — it is what showed that a decaying
    // sector-loss penalty was the storm decaying, not the filter remembering.
    // If it quietly retained a prior, that comparison would be worthless.
    const lat = dipLat(POOL), lon = dipLon(POOL);
    const H = POOL.map((_, i) => designRow(lat[i], lon[i], 1));
    const step = (f, level) => {
        f.predict();
        f.update(H, H.map((r) => r[0] * level), H.map(() => 4), 0);
        return f.coeffs[0];
    };
    const mem = new TIGA({ memoryless: true });
    const tig = new TIGA();
    for (let k = 0; k < 50; k++) { step(mem, 50); step(tig, 50); }
    // Jump the truth. The memoryless filter should snap; TIGA should lag.
    const memJump = Math.abs(step(mem, 200) - 200);
    const tigJump = Math.abs(step(tig, 200) - 200);
    assert.ok(memJump < tigJump,
        `the memoryless control must track a jump FASTER than TIGA (${memJump.toFixed(1)} vs ${tigJump.toFixed(1)})`);
    ok(`memoryless control snaps to a step (residual ${memJump.toFixed(1)} nT) where TIGA lags (${tigJump.toFixed(1)} nT)`);
}

// ── The SM frame ─────────────────────────────────────────────────────────────
{
    // SM longitude in DEGREES = magnetic local time in HOURS × 15, so 0° is
    // magnetic midnight, 180° is noon and 270° is DUSK — where the partial ring
    // current actually peaks, and where the OSSE truth field puts it.
    near(mltFromSmLongitude(270), 18, 1e-9, '270° SM must be 18 MLT (dusk)');
    near(mltFromSmLongitude(180), 12, 1e-9, '180° SM must be magnetic noon');

    // The sub-solar point at a June solstice noon must be near the Tropic of
    // Cancer and near the prime meridian.
    const ss = subsolarPointGeo(new Date(Date.UTC(2026, 5, 21, 12, 0, 0)));
    near(ss.latDeg, 23.4, 0.3, 'sub-solar latitude at the June solstice');
    assert.ok(Math.abs(ss.lonDeg) < 5, `sub-solar longitude at 12 UT should be near 0°, got ${ss.lonDeg}`);
    near(subsolarPointGeo(new Date(Date.UTC(2026, 2, 20, 12, 0, 0))).latDeg, 0, 0.5,
        'sub-solar latitude at the March equinox');

    // MLT must close over a full UT day — but it does NOT advance uniformly,
    // and that is real geometry rather than a bug. MLT here is referenced to
    // the sub-solar point's DIPOLE longitude, and because the dipole axis sits
    // 9.2° off the spin axis, the geographic→dipole longitude mapping is
    // non-uniform. So the sub-solar point sweeps dipole longitude at ±9% of the
    // mean rate through the day: six hours of UT advances MLT by 5.71 h, not
    // 6.00 h. (An earlier version of this test asserted 6.00 ± 0.2 and failed.)
    const b = dipoleBasisForYear(2026.0);
    const bou = toDipole(40.137, -105.237, b);
    const t0 = Date.UTC(2026, 5, 21);
    const mltAt = (h) => mltFromSmLongitude(smLongitudeAt(bou.lonDeg, new Date(t0 + h * 3600000)));

    let total = 0, minRate = Infinity, maxRate = -Infinity, prev = mltAt(0);
    for (let h = 0.5; h <= 24.0001; h += 0.5) {
        const v = mltAt(h);
        const step = ((v - prev) + 24) % 24;
        total += step;
        minRate = Math.min(minRate, step * 2);
        maxRate = Math.max(maxRate, step * 2);
        prev = v;
    }
    near(total, 24, 0.05, 'MLT must close over one UT day');
    assert.ok(minRate > 0.85 && maxRate < 1.15,
        `the MLT rate should modulate by roughly ±10% about 1 h/h, got ${minRate.toFixed(3)}–${maxRate.toFixed(3)}`);
    assert.ok(maxRate - minRate > 0.05,
        'the rate MUST be non-uniform — a perfectly uniform rate would mean the '
        + 'dipole tilt has been dropped from the sub-solar transform');

    // The non-uniformity lives entirely in the sub-solar point, so every
    // station sees the same modulation — which is a check on WHERE it comes from.
    const other = toDipole(-20, 130, b);
    const otherAdvance = ((mltFromSmLongitude(smLongitudeAt(other.lonDeg, new Date(t0 + 6 * 3600000)))
        - mltFromSmLongitude(smLongitudeAt(other.lonDeg, new Date(t0)))) + 24) % 24;
    const bouAdvance = ((mltAt(6) - mltAt(0)) + 24) % 24;
    near(otherAdvance, bouAdvance, 1e-6,
        'the MLT modulation must be identical for every station — it is a property of the Sun, not the site');

    // Boulder sits ~7 h behind UT, so 00 UT is late afternoon there.
    const d0 = mltAt(0);
    assert.ok(d0 > 15 && d0 < 19, `Boulder MLT at 00 UT should be late afternoon, got ${d0.toFixed(2)}`);
    ok(`SM frame: 270° ≡ dusk, MLT closes at ${total.toFixed(3)} h/day with a ${minRate.toFixed(2)}–${maxRate.toFixed(2)} h/h dipole-tilt modulation (Boulder 00 UT → ${d0.toFixed(1)} MLT)`);
}

// ── Dipole tilt: the daily swing is TWICE the axis offset, phased at 17 UT ───
{
    const b = dipoleBasisForYear(2026.0);
    const equinox = dipoleTiltDay(new Date(Date.UTC(2026, 2, 20)));
    const solstice = dipoleTiltDay(new Date(Date.UTC(2026, 5, 21)));

    near(equinox.rangeDeg, 2 * b.pole.tiltDeg, 0.35,
        'the daily tilt range must be twice the dipole axis offset');
    near(equinox.utOfMax, 17, 0.6,
        'the phase must lock near 17 UT — local noon at the geomagnetic pole (~73°W)');
    near(solstice.utOfMax, 17, 0.6, 'the phase is set by geometry, so it holds at solstice too');
    near(solstice.maxDeg, 32.6, 1.0, 'the annual envelope reaches ~±33° (axial tilt + dipole offset)');

    // Continuity: dipoleTilt() and the day sampler must agree at a sample point.
    const t = new Date(Date.UTC(2026, 2, 20, 6, 0, 0));
    near(dipoleTilt(t), equinox.tiltDeg[24], 1e-9, 'dipoleTilt agrees with the day sampler');
    ok(`dipole tilt: daily range ${equinox.rangeDeg.toFixed(1)}° = 2×${b.pole.tiltDeg.toFixed(2)}°, peak ${equinox.utOfMax.toFixed(2)} UT`);
}

// ── Longitudinal clustering is the variable that matters ─────────────────────
{
    // Station COUNT is the wrong variable; longitudinal spread is the right one.
    // The metric must reflect that: a clustered set scores near 1 however many
    // stations it has, an evenly spread one near 0.
    const clustered = longitudeClustering([10, 12, 14, 16, 18, 20, 22, 24]);
    const spread = longitudeClustering([0, 45, 90, 135, 180, 225, 270, 315]);
    assert.ok(clustered > 0.95, `eight stations in a 14° band must score clustered, got ${clustered}`);
    assert.ok(spread < 1e-9, `eight evenly spread stations must score ~0, got ${spread}`);
    assert.ok(longitudeClustering([0, 180]) < 1e-9, 'antipodal pair is maximally spread');
    assert.equal(longitudeClustering([]), 1, 'an empty set is maximally clustered by convention');
    ok(`longitudinal clustering: ${clustered.toFixed(3)} clustered vs ${spread.toFixed(3)} spread`);
}

console.log(`\n✅ geomag-tiga — ${passed} checks passed`);
