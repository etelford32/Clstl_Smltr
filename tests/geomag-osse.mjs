#!/usr/bin/env node
/**
 * geomag-osse.mjs — gate for js/geomag/osse.js: the observing-system
 * experiment, and the ingest path that feeds the live version.
 *
 * Run: node tests/geomag-osse.mjs
 *
 * ── THE ONE EXACT NUMBER ─────────────────────────────────────────────────
 * The INDEX DEFINITION FLOOR (11.36 nT) is fully deterministic — it depends
 * only on the six canonical stations' real coordinates and a truth field with
 * no randomness in it — so it is pinned to two decimal places against the
 * Python reference. It is also the most important number on the page: it says
 * the index's own definition error is 2.6× LARGER than the estimator's error.
 *
 * ── AND WHAT IS NOT PINNED TO A DIGIT ────────────────────────────────────
 * Everything downstream of the synthetic network draw and the observation
 * noise. This module uses its own PRNG (mulberry32); the reference used
 * numpy's PCG64. Those cannot agree sample-for-sample, so pinning an RMSE to
 * two decimals here would be pinning a random seed. What is gated instead is
 * every STRUCTURAL claim — flat dropout, the E2 gap, bias-not-variance, and
 * the calibration shortfall — each of which is a property of the method.
 *
 * The calibration shortfall is gated ON PURPOSE. It is a known open problem
 * (68% nominal covers ~45%), and a gate that fails if it silently "improves"
 * is what stops someone widening the error bars until the metric looks good.
 */

import assert from 'node:assert/strict';
import {
    makeNetwork, stormTruth, observe, trueSymH, zonalTruth, definitionFloor,
    runOsse, makeRng, assignLags, CANONICAL, TRUTH_NMAX, LAG_BUCKETS,
} from '../js/geomag/osse.js';
import { SYMH6_TYPICAL, SYMH6_BALANCED } from '../js/geomag/observatories.js';
import {
    removeBaseline, prepareStations, buildEpochs, runNowcast, coverageDiagnostics,
    fetchObservatories, STATION_VAR_NT2, COMMON_MODE_VAR,
} from '../js/geomag/ingest.js';

let passed = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); passed++; };
const near = (a, b, tol, msg) =>
    assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);

// Shared setup — two days at 1-minute cadence, exactly as the reference ran it.
const stations = makeNetwork(75, makeRng(20260726));
const minutes = Float64Array.from({ length: 2880 }, (_, i) => i);
const truth = stormTruth(minutes);
const target = trueSymH(stations, minutes, truth);
const zonal = zonalTruth(truth, minutes.length);
const { obs, sigma } = observe(stations, minutes, truth, { rng: makeRng(11) });
const permitted = stations.map((s) => !s.canonical);

// ── 1. The network ───────────────────────────────────────────────────────────
{
    assert.equal(stations.length, 75,
        'the network must be the requested size — a loop bound of `nTotal - st.length` '
        + 'shrinks as the array fills and silently builds 43 stations');
    assert.equal(stations.filter((s) => s.canonical).length, 11, 'eleven canonical stations');
    assert.equal(CANONICAL.length, 11);
    // The canonical eleven are REAL coordinates from the primary source, so
    // they must not have been perturbed by the draw.
    for (const c of CANONICAL) {
        const s = stations.find((x) => x.code === c.code);
        assert.equal(s.lat, c.lat, `${c.code} latitude must come from Kyoto Table 1 untouched`);
        assert.equal(s.lon, c.lon, `${c.code} longitude must come from Kyoto Table 1 untouched`);
    }
    // The measured distribution: mid-latitude, mostly northern, equatorward of 50°.
    const lats = stations.map((s) => s.lat);
    assert.ok(Math.max(...lats.map(Math.abs)) < 50, 'every station must be equatorward of 50° dipole latitude');
    const north = lats.filter((v) => v > 0).length;
    assert.ok(north / stations.length > 0.5 && north / stations.length < 0.8,
        `the network should be ~65% northern, got ${(100 * north / stations.length).toFixed(0)}%`);
    // Determinism.
    const again = makeNetwork(75, makeRng(20260726));
    assert.deepEqual(again.map((s) => [s.code, s.lat, s.lon]), stations.map((s) => [s.code, s.lat, s.lon]),
        'makeNetwork must be deterministic for a given seed');
    ok(`network: 75 stations (11 canonical, real coordinates), ${north}N/${stations.length - north}S, all equatorward of 50°`);
}

// ── 2. The truth field is degree 3 and deterministic ─────────────────────────
{
    assert.equal(TRUTH_NMAX, 3, 'the truth field must exceed the filter degree — no inverse crime');
    // Degree ≥ 2 structure must actually be present, or the representativeness
    // error vanishes and the whole experiment becomes a solver test.
    let hiPower = 0;
    for (let i = 0; i < minutes.length; i++) {
        for (let k = 3; k < 15; k++) hiPower += truth[i * 15 + k] ** 2;
    }
    assert.ok(hiPower > 0, 'the truth field must carry degree-2/3 structure');

    // The storm shape: quiet, then a main phase, then recovery.
    const q10 = Array.from({ length: minutes.length }, (_, i) => truth[i * 15]);
    const peakIdx = q10.indexOf(Math.max(...q10));
    assert.ok(minutes[peakIdx] > 240 && minutes[peakIdx] < 600,
        `the storm must peak in the first several hours, got t = ${minutes[peakIdx]}`);
    assert.ok(q10[peakIdx] > 100, 'the storm must be a real storm');
    assert.ok(q10[q10.length - 1] < q10[peakIdx] * 0.35, 'the storm must recover');

    // The partial ring current peaks at DUSK, and decays faster than the zonal ring.
    const asy = (i) => Math.hypot(truth[i * 15 + 1], truth[i * 15 + 2]);
    const asyPeak = Array.from({ length: minutes.length }, (_, i) => asy(i));
    const ai = asyPeak.indexOf(Math.max(...asyPeak));
    const mlt = ((Math.atan2(truth[ai * 15 + 2], truth[ai * 15 + 1]) * 180 / Math.PI + 360) % 360) / 15;
    near(mlt, 18, 0.1, 'the partial ring current must peak at dusk (18 MLT)');
    assert.ok(minutes[ai] < minutes[peakIdx], 'the asymmetry must develop FASTER than the symmetric ring');

    assert.deepEqual(Array.from(stormTruth(minutes)), Array.from(truth), 'stormTruth must be deterministic');
    ok(`truth field: degree 3, storm peaks at t = ${minutes[peakIdx]} min, asymmetry peaks at ${mlt.toFixed(1)} MLT and earlier`);
}

// ── 3. THE INDEX DEFINITION FLOOR — pinned exactly ───────────────────────────
{
    const floor = definitionFloor(stations, minutes, truth);
    near(floor.rmsNt, 11.36, 0.01, 'RMS(Kyoto recipe − pure zonal), the index definition floor');
    near(floor.maxAbsNt, 42.54, 0.02, 'worst-case index definition error');

    // It really is the index's own error, not an estimator error: both curves
    // come from the SAME truth field with no filter involved.
    assert.equal(target.length, zonal.length);
    assert.ok(Math.min(...target) < Math.min(...zonal),
        'the six-station recipe must overshoot the pure zonal minimum — that overshoot IS the aliasing');

    // Hemispheric balance reduces it, exactly as the closed-form aliasing says.
    const balanced = definitionFloor(stations, minutes, truth, SYMH6_BALANCED);
    assert.ok(balanced.rmsNt < floor.rmsNt,
        `a hemispherically balanced six must alias less: ${balanced.rmsNt.toFixed(2)} vs ${floor.rmsNt.toFixed(2)} nT`);
    assert.equal(SYMH6_TYPICAL.length, SYMH6_BALANCED.length, 'same station count, different balance');
    ok(`definition floor: RMS ${floor.rmsNt.toFixed(2)} nT, max ${floor.maxAbsNt.toFixed(2)} nT (balanced six: ${balanced.rmsNt.toFixed(2)} nT)`);
}

// ── 4. The estimator beats the definition it is scored against ───────────────
const base = runOsse({ stations, minutes, C: truth, target, obs, sigma, permitted, rng: makeRng(1) });
{
    const floor = definitionFloor(stations, minutes, truth).rmsNt;
    assert.ok(base.rmseQ10Nt < floor / 2,
        `TIGA's error in q₁⁰ (${base.rmseQ10Nt.toFixed(2)} nT) must be at least 2× below the index's own `
        + `definition error (${floor.toFixed(2)} nT) — that separation is the entire commercial argument, `
        + 'and it is only measurable because the estimand is a physical coefficient rather than the index');
    // Scored against the INDEX, the error cannot fall below the floor. That is
    // what "floor" means, and it is worth asserting so nobody quotes the wrong
    // one as a headline.
    assert.ok(base.rmseIndexNt > floor * 0.8,
        `RMSE against the index (${base.rmseIndexNt.toFixed(2)}) cannot be far below the floor (${floor.toFixed(2)})`);
    assert.ok(base.rmseIndexNt > base.rmseQ10Nt * 2, 'the two RMSEs must be reported separately for a reason');
    ok(`estimation error ${base.rmseQ10Nt.toFixed(2)} nT in q₁⁰ vs an ${floor.toFixed(2)} nT definition floor — the index costs ${(floor / base.rmseQ10Nt).toFixed(1)}× more`);
}

// ── 5. Prediction 2, FALSIFIED: excluding the canonical eleven barely matters ─
{
    const all = runOsse({ stations, minutes, C: truth, target, obs, sigma, rng: makeRng(1) });
    const gap = base.rmseQ10Nt - all.rmseQ10Nt;
    assert.ok(Math.abs(gap) < 1.0,
        `excluding all eleven canonical stations was PREDICTED to hurt badly and does not — `
        + `gap ${gap.toFixed(2)} nT. Three parameters are already over-determined by 64 stations. `
        + 'This prediction is falsified and stays in the record.');
    ok(`prediction 2 falsified: excluding the canonical eleven changes RMSE by ${gap >= 0 ? '+' : ''}${gap.toFixed(2)} nT`);
}

// ── 6. Prediction 3, CONFIRMED: the dropout curve is flat ────────────────────
{
    // The calibration is FROZEN from the reference run. Refitting per level
    // lets it absorb dropout-induced bias — on the first pass that produced a
    // curve which IMPROVED as stations were removed.
    const curve = [0, 0.5, 0.8, 0.9, 0.95].map((p) => runOsse({
        stations, minutes, C: truth, target, obs, sigma, permitted, dropProbability: p,
        calib: base.calib, calibQ: base.calibQ, rng: makeRng(100 + Math.round(p * 100)),
    }));
    const first = curve[0], last = curve[curve.length - 1];
    assert.ok(first.meanStations > 50, 'the full configuration should report ~64 stations');
    assert.ok(last.meanStations < 5, 'the 95% dropout configuration should report a handful');

    const reduction = first.meanStations / last.meanStations;
    assert.ok(reduction > 15, `the sweep must span at least a 15× reduction, got ${reduction.toFixed(1)}×`);
    // FLAT. Not "degrades gracefully" — flat. The knee sits at the fitted
    // parameter count, and there are three parameters.
    for (const r of curve) {
        assert.ok(r.rmseQ10Nt < first.rmseQ10Nt * 1.6,
            `RMSE must stay flat across the dropout sweep: ${r.rmseQ10Nt.toFixed(2)} at `
            + `${r.meanStations.toFixed(1)} stations vs ${first.rmseQ10Nt.toFixed(2)} at ${first.meanStations.toFixed(0)}`);
        assert.ok(Number.isFinite(r.rmseQ10Nt), 'the estimator must never break, only widen');
    }
    ok(`prediction 3 confirmed: ${first.meanStations.toFixed(0)} → ${last.meanStations.toFixed(1)} stations (${reduction.toFixed(0)}×) moves RMSE ${first.rmseQ10Nt.toFixed(2)} → ${last.rmseQ10Nt.toFixed(2)} nT`);
}

// ── 7. Bias, not variance, is the dropout signature ──────────────────────────
{
    const full = runOsse({
        stations, minutes, C: truth, target, obs, sigma, permitted,
        calib: base.calib, calibQ: base.calibQ, rng: makeRng(100),
    });
    const thin = runOsse({
        stations, minutes, C: truth, target, obs, sigma, permitted, dropProbability: 0.9,
        calib: base.calib, calibQ: base.calibQ, rng: makeRng(190),
    });
    // The RMSE barely moves while the bias moves measurably — which is only
    // visible BECAUSE the calibration was frozen.
    const dBias = Math.abs(thin.biasQ10Nt - full.biasQ10Nt);
    const dRmse = Math.abs(thin.rmseQ10Nt - full.rmseQ10Nt);
    assert.ok(dBias > 0.2, `the bias must respond to dropout, moved only ${dBias.toFixed(2)} nT`);
    assert.ok(dBias > dRmse * 0.5,
        `bias must be the dominant dropout signature (Δbias ${dBias.toFixed(2)} vs ΔRMSE ${dRmse.toFixed(2)})`);
    ok(`bias is the dropout signature: Δbias ${dBias.toFixed(2)} nT against ΔRMSE ${dRmse.toFixed(2)} nT`);
}

// ── 8. The frozen-calibration protocol ───────────────────────────────────────
{
    // Passing the frozen calibration through must actually change the answer —
    // if it did not, the protocol would be decorative.
    const frozen = runOsse({
        stations, minutes, C: truth, target, obs, sigma, permitted, dropProbability: 0.9,
        calib: base.calib, calibQ: base.calibQ, rng: makeRng(190),
    });
    const refitted = runOsse({
        stations, minutes, C: truth, target, obs, sigma, permitted, dropProbability: 0.9,
        rng: makeRng(190),
    });
    assert.ok(Math.abs(frozen.biasQ10Nt - refitted.biasQ10Nt) > 0.1,
        'refitting the calibration must visibly change the bias — that is exactly why it is frozen');
    assert.ok(Math.abs(refitted.biasQ10Nt) < Math.abs(frozen.biasQ10Nt),
        `a refitted calibration ABSORBS the dropout bias (refit ${refitted.biasQ10Nt.toFixed(2)} vs `
        + `frozen ${frozen.biasQ10Nt.toFixed(2)}) — which is how a degradation curve was made to look flat`);
    ok(`frozen calibration: refitting hides ${(Math.abs(frozen.biasQ10Nt) - Math.abs(refitted.biasQ10Nt)).toFixed(2)} nT of dropout bias`);
}

// ── 9. THE OPEN PROBLEM: the posterior is optimistic, and stays measured ─────
{
    // Gated deliberately. If a future change makes this pass silently by
    // widening the bars, that is a metric being fitted rather than a problem
    // being solved — and the page publishes this number, so it must be real.
    assert.ok(base.coverage68 > 0.25 && base.coverage68 < 0.68,
        `nominal 68% coverage is a KNOWN open problem and should land near 45%, got `
        + `${(base.coverage68 * 100).toFixed(1)}%. If this has genuinely improved, update the page copy `
        + 'and this gate together — do not just widen the interval.');
    assert.ok(base.coverage95 > base.coverage68, '95% must cover more than 68%');

    // Coverage MUST be judged against q₁⁰, not against the index. Judging it
    // against the index charges the filter for the index's own definition error.
    assert.ok(base.coverage68AgainstIndex < base.coverage68,
        'coverage against the index must look worse than against q₁⁰ — that difference is '
        + 'the definition error, and conflating the two is the trap this whole module is built around');
    ok(`calibration (open): nominal 68% covers ${(base.coverage68 * 100).toFixed(1)}%, 95% covers ${(base.coverage95 * 100).toFixed(1)}% — against the index it would read ${(base.coverage68AgainstIndex * 100).toFixed(1)}%`);
}

// ── 10. TIGA vs the memoryless control on the zonal term ─────────────────────
{
    const memoryless = runOsse({
        stations, minutes, C: truth, target, obs, sigma, permitted,
        calib: base.calib, calibQ: base.calibQ, memoryless: true, rng: makeRng(1),
    });
    assert.ok(Number.isFinite(memoryless.rmseQ10Nt), 'the control must run');
    assert.ok(base.rmseQ10Nt <= memoryless.rmseQ10Nt * 1.02,
        `TIGA must not LOSE to a memoryless filter on the zonal term — that is the term SYM-H is. `
        + `TIGA ${base.rmseQ10Nt.toFixed(2)} vs control ${memoryless.rmseQ10Nt.toFixed(2)}`);
    ok(`vs memoryless control on q₁⁰: ${base.rmseQ10Nt.toFixed(2)} vs ${memoryless.rmseQ10Nt.toFixed(2)} nT`);
}

// ── 11. Latency is delivery-limited ──────────────────────────────────────────
{
    const lags = assignLags(stations, makeRng(4242));
    assert.equal(lags.length, stations.length);
    const slow = lags.filter((v) => v > 1000).length;
    assert.ok(slow > 0,
        'the lag distribution must contain multi-day stations — the canonical index is slow '
        + 'because two of its stations are slow, which makes latency and dropout ONE trade-off surface');
    const tight = runOsse({
        stations, minutes, C: truth, target, obs, sigma, permitted, cutoffMin: 5, lags,
        calib: base.calib, calibQ: base.calibQ, rng: makeRng(7),
    });
    const loose = runOsse({
        stations, minutes, C: truth, target, obs, sigma, permitted, cutoffMin: 4320, lags,
        calib: base.calib, calibQ: base.calibQ, rng: makeRng(7),
    });
    assert.ok(tight.meanStations < loose.meanStations, 'a tighter cut-off must admit fewer stations');
    assert.ok(Number.isFinite(tight.rmseQ10Nt) && tight.rmseQ10Nt < loose.rmseQ10Nt * 1.8,
        `a 5-minute cut-off must remain usable: ${tight.rmseQ10Nt.toFixed(2)} nT on `
        + `${tight.meanStations.toFixed(1)} stations vs ${loose.rmseQ10Nt.toFixed(2)} on ${loose.meanStations.toFixed(1)}`);
    assert.equal(LAG_BUCKETS.length, 6);
    ok(`latency: a 5-min cut-off keeps ${tight.meanStations.toFixed(1)} of ${loose.meanStations.toFixed(1)} stations at ${tight.rmseQ10Nt.toFixed(2)} nT`);
}

// ── 12. The ingest path ──────────────────────────────────────────────────────
{
    // Baseline removal must preserve gaps rather than interpolate them: a
    // missing observation has to be ABSENT from H, which is the dropout story.
    const withGaps = [100, null, 102, 104, null, 106];
    const r = removeBaseline(withGaps);
    assert.equal(r.disturbance[1], null, 'a gap must stay a gap — never interpolate a missing sample');
    assert.equal(r.disturbance[4], null, 'a gap must stay a gap');
    near(r.baseline, 103, 1e-9, 'the baseline is the median of the finite samples');
    // Too few samples to form a baseline ⇒ nothing usable, not a wrong answer.
    assert.deepEqual(removeBaseline([null, null, 5]).disturbance, [null, null, null],
        'fewer than three finite samples must yield no disturbance rather than a fake one');

    // A synthetic USGS-shaped payload, with an auroral station that must be cut
    // on a COMPUTED dipole latitude and a station that reports nothing.
    const t0 = Date.UTC(2026, 6, 26, 12, 0, 0);
    const times = Array.from({ length: 90 }, (_, i) => new Date(t0 + i * 60000).toISOString());
    const mk = (iaga, lat, lon, dead = false) => ({
        iaga, name: iaga, geodeticLatitude: lat, geodeticLongitude: lon, times,
        x: times.map((_, i) => (dead ? null
            : 21000 + (i > 30 ? -90 * (1 - Math.exp(-(i - 30) / 10)) * Math.exp(-(i - 30) / 200) : 0))),
    });
    const payload = {
        data: {
            updated: new Date(t0 + 90 * 60000).toISOString(),
            endTime: new Date(t0 + 90 * 60000).toISOString(),
            stations: [
                mk('BOU', 40.137, 254.763), mk('FRD', 38.205, 282.633),
                mk('TUC', 32.174, 249.267), mk('HON', 21.316, 202.0),
                mk('SJG', 18.113, 293.849), mk('GUA', 13.588, 144.867),
                mk('BRW', 71.322, 203.378),          // auroral — must be cut
                mk('CMO', 64.874, 212.140),          // auroral — must be cut
                mk('NEW', 48.265, 242.878, true),    // reports nothing
            ],
        },
    };
    const prep = prepareStations(payload);
    const kept = prep.stations.map((s) => s.code);
    assert.ok(kept.includes('BOU') && kept.includes('HON'), 'mid-latitude stations must be kept');
    assert.ok(!kept.includes('BRW') && !kept.includes('CMO'),
        'auroral stations must be cut — poleward of 50° dipole latitude the electrojets take over '
        + 'and the station stops measuring the ring current');
    assert.ok(!kept.includes('NEW'), 'a station with no data must not be admitted');
    for (const s of prep.excluded) {
        assert.ok(['auroral', 'no-data'].includes(s.reason), `unexplained exclusion: ${s.reason}`);
    }
    // The cut is on a COMPUTED value, not a stored annotation.
    assert.ok(Math.abs(prep.excluded.find((s) => s.code === 'BRW').dipLatDeg) > 50,
        'the auroral cut must be justified by a computed dipole latitude');

    const epochs = buildEpochs(prep.stations);
    assert.equal(epochs.length, times.length, 'every timestamp must produce an epoch');
    assert.ok(epochs.every((e) => e.timeMs === Math.floor(e.timeMs)), 'epoch times must be real timestamps');
    for (let i = 1; i < epochs.length; i++) {
        assert.ok(epochs[i].timeMs > epochs[i - 1].timeMs, 'epochs must be time-ordered');
    }

    const nc = runNowcast(epochs);
    assert.equal(nc.series.length, epochs.length);
    assert.ok(nc.final && Number.isFinite(nc.final.zonalNt), 'the nowcast must produce a value');
    assert.ok(nc.final.sigmaNt > 0, 'and it must publish a posterior — that IS the product');
    assert.ok(nc.series.every((s) => Number.isFinite(s.sigmaNt) && s.sigmaNt > 0),
        'every sample must carry its own uncertainty');
    assert.equal(nc.stationsSeen.length, 6, 'six stations should have contributed');

    // The storm in the synthetic feed must show up as a negative excursion.
    const quiet = nc.series[5].zonalNt;
    const stormy = Math.min(...nc.series.slice(45).map((s) => s.zonalNt));
    assert.ok(stormy < quiet, `the injected depression must appear in the estimate (${quiet.toFixed(1)} → ${stormy.toFixed(1)})`);

    // Coverage diagnostics must surface the USGS network's real weakness.
    const cov = coverageDiagnostics(prep.stations, prep.epoch);
    assert.equal(cov.count, 6);
    assert.ok(cov.largestGapHours > 6,
        `a USGS-only network must show a large MLT gap — that is the binding constraint and it is `
        + `stated rather than hidden, got ${cov.largestGapHours.toFixed(1)} h`);
    assert.ok(cov.clustering > 0 && cov.clustering <= 1, 'clustering must be a fraction');

    assert.equal(STATION_VAR_NT2, 54);
    assert.equal(COMMON_MODE_VAR, 54);
    ok(`ingest: gaps preserved, auroral stations cut on computed dipole latitude, ${cov.count} stations, ${cov.largestGapHours.toFixed(1)} h MLT gap, posterior on every sample`);
}

// ── 13. A dead feed is a dropout, not an exception ───────────────────────────
{
    // The page must degrade to the offline experiment rather than break, so the
    // failure has to arrive as a rejected promise the caller can catch.
    const fail = async (impl) => {
        try { await fetchObservatories({ fetchImpl: impl }); return null; }
        catch (e) { return e.message; }
    };
    assert.ok(await fail(async () => ({ ok: false, status: 503 })), 'an HTTP error must reject');
    assert.ok(await fail(async () => ({ ok: true, json: async () => ({ data: { stations: [] } }) })),
        'an empty station set must reject rather than return nothing usable');
    // And the happy path returns the payload untouched.
    const good = await fetchObservatories({
        fetchImpl: async () => ({ ok: true, json: async () => ({ data: { stations: [{ iaga: 'BOU' }] } }) }),
    });
    assert.equal(good.data.stations[0].iaga, 'BOU');
    ok('ingest failures reject cleanly so the page can fall back to the offline experiment');
}

console.log(`\n✅ geomag-osse — ${passed} checks passed`);
