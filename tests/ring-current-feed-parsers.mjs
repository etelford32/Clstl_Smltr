#!/usr/bin/env node
/**
 * ring-current-feed-parsers.mjs — pure-Node tests for the parse/assemble layer
 * of js/ring-current-feed.js against synthetic NOAA payloads:
 *
 *   1. noaaNum: fill sentinels (-9999, 1e21, '', null) → null; strings parse.
 *   2. noaaTimeMs: "YYYY-MM-DD HH:MM:SS.ms" (space, no tz) → UTC epoch ms.
 *   3. mergeDriverSeries: plasma+mag join on UTC minute; plasma-only minutes
 *      keep bz null; fill-speed rows dropped; output ascending.
 *   4. parseKyotoDst: object rows AND 2-D header-row array; |dst|>1000 fill
 *      dropped (mirrors api/noaa/dst.js).
 *   5. parseLatestKp: walks backwards past fills; range-guarded.
 *   6. observedDstAt: interpolation, clamped ends.
 *   7. computeState: end-to-end synthetic storm — forecast window exists
 *      (~62 min at 400 km/s), energy positive, skill computed, anchored once.
 *
 * Exits 0 on pass, non-zero on failure.
 */

import assert from 'node:assert/strict';
import {
    noaaNum, noaaTimeMs, mergeDriverSeries, parseKyotoDst, parseLatestKp,
    observedDstAt, computeState, omniToReplay, computeReplayState,
    parseGoesMag, goesCrossCheck,
} from '../js/ring-current-feed.js';

let n = 0;
const ok = (msg) => { n++; console.log(`  ✓ ${msg}`); };

const T0 = Date.parse('2026-07-10T00:00:00Z');
const tag = ms => new Date(ms).toISOString().replace('T', ' ').replace('Z', '');

// ── 1–2. scalar parsing ──────────────────────────────────────────────────────
{
    assert.equal(noaaNum(-9999), null);
    assert.equal(noaaNum(1e21), null);
    assert.equal(noaaNum(''), null);
    assert.equal(noaaNum(null), null);
    assert.equal(noaaNum('421.7'), 421.7);
    assert.equal(noaaNum(0), 0);
    assert.equal(noaaTimeMs('2026-07-10 12:34:00.000'), Date.parse('2026-07-10T12:34:00.000Z'));
    assert.equal(noaaTimeMs('2026-07-10T12:34:00Z'), Date.parse('2026-07-10T12:34:00Z'));
    assert.equal(noaaTimeMs('garbage'), null);
    assert.equal(noaaTimeMs(null), null);
    ok('noaaNum fills + noaaTimeMs space-separated UTC tags');
}

// ── 3. mergeDriverSeries ─────────────────────────────────────────────────────
{
    const wind = [
        { time_tag: tag(T0),           proton_speed: 400, proton_density: 5 },
        { time_tag: tag(T0 + 60_000),  proton_speed: -9999, proton_density: 5 },  // fill → dropped
        { time_tag: tag(T0 + 120_000), speed: 450, density: 8 },                  // plain names
        { time_tag: tag(T0 + 180_000), proton_speed: 500, proton_density: 10 },   // no mag minute
    ];
    const mag = [
        { time_tag: tag(T0),           bz_gsm: -5, bt: 8, by_gsm: 4, bx_gsm: 1 },
        { time_tag: tag(T0 + 120_000), bz: -12, bt: 15, by: -3 },   // plain-name fallbacks
        { time_tag: tag(T0 + 240_000), bz_gsm: 3, bt: 5 },    // no plasma minute → ignored
    ];
    const s = mergeDriverSeries(wind, mag);
    assert.equal(s.length, 3);                      // fill row gone
    assert.deepEqual(s.map(r => r.v), [400, 450, 500]);
    assert.equal(s[0].bz, -5);
    assert.equal(s[0].by, 4);                       // By carried for Newell coupling
    assert.equal(s[1].bz, -12);
    assert.equal(s[1].by, -3);
    assert.equal(s[2].bz, null);                    // plasma-only minute
    assert.ok(s[0].t < s[1].t && s[1].t < s[2].t);
    assert.deepEqual(mergeDriverSeries(null, null), []);
    ok('mergeDriverSeries: minute join, fills dropped, plasma-only bz=null');
}

// ── 4. parseKyotoDst both shapes ─────────────────────────────────────────────
{
    const objForm = [
        { time_tag: tag(T0), dst: -25 },
        { time_tag: tag(T0 + 3.6e6), dst: 99999 },          // fill
        { time_tag: tag(T0 + 7.2e6), dst_index: -42 },      // alt field
    ];
    const o = parseKyotoDst(objForm);
    assert.equal(o.length, 2);
    assert.equal(o[1].dst, -42);

    const arrForm = [
        ['time_tag', 'dst'],
        [tag(T0), '-30'],
        [tag(T0 + 3.6e6), '-55'],
    ];
    const a = parseKyotoDst(arrForm);
    assert.equal(a.length, 2);
    assert.equal(a[1].dst, -55);
    assert.deepEqual(parseKyotoDst([]), []);
    ok('parseKyotoDst: object rows + 2-D header form, fills dropped');
}

// ── 5. parseLatestKp ─────────────────────────────────────────────────────────
{
    const kp = parseLatestKp([
        { time_tag: tag(T0), estimated_kp: 2.33 },
        { time_tag: tag(T0 + 60_000), estimated_kp: 5.67 },
        { time_tag: tag(T0 + 120_000), estimated_kp: -9999 },   // trailing fill
    ]);
    assert.equal(kp, 5.67);
    assert.equal(parseLatestKp([{ kp_index: 99 }]), null);      // out of range
    assert.equal(parseLatestKp(null), null);
    ok('parseLatestKp: walks past trailing fill, range-guarded');
}

// ── 6. observedDstAt ─────────────────────────────────────────────────────────
{
    const s = [{ t: T0, dst: -10 }, { t: T0 + 3.6e6, dst: -30 }];
    assert.equal(observedDstAt(s, T0 - 1000), -10);            // clamp left
    assert.equal(observedDstAt(s, T0 + 3.6e6 + 1000), -30);    // clamp right
    assert.ok(Math.abs(observedDstAt(s, T0 + 1.8e6) - (-20)) < 1e-9);
    assert.equal(observedDstAt([], T0), null);
    ok('observedDstAt: midpoint interpolation, end clamps');
}

// ── 7. computeState end-to-end ───────────────────────────────────────────────
{
    // 24 h of drivers at L1: quiet for 18 h, then southward storm onset.
    const drivers = [];
    for (let m = 0; m <= 24 * 60; m++) {
        const t = T0 + m * 60_000;
        const stormy = m > 18 * 60;
        drivers.push({
            t, v: 400, n: stormy ? 15 : 5,
            bz: stormy ? -14 : 1, bt: stormy ? 16 : 5,
        });
    }
    // Observed Dst: quiet-ish, hourly.
    const observed = [];
    for (let h = 0; h <= 25; h++) observed.push({ t: T0 + h * 3.6e6, dst: -15 });

    const nowMs = T0 + 24 * 60 * 60_000;   // "now" = last L1 sample time
    const st = computeState(drivers, observed, 3, nowMs, 145);
    assert.ok(st, 'state computed');

    // Research-driven additions: Kp→ap + F10.7 surfaced for the density
    // panel; parameter band present, bracketing the forecast, and widening.
    assert.equal(st.now.apNow, 15);        // Kp 3o → ap 15 (NOAA table)
    assert.equal(st.now.f107, 145);
    assert.ok(st.series.band.length > 10);
    const bandByT = new Map(st.series.band.map(b => [b.t, b]));
    for (const p of st.series.forecast) {
        const b = bandByT.get(p.t);
        assert.ok(b && b.lo <= p.dst + 1e-9 && b.hi >= p.dst - 1e-9, 'band brackets forecast');
    }
    const bw = st.series.band;
    assert.ok((bw[bw.length - 1].hi - bw[bw.length - 1].lo) > (bw[0].hi - bw[0].lo),
        'band widens toward the horizon');
    // Fixture reaches ≈−66 nT with forecast to ≈−77: next threshold (−100)
    // is NOT crossed → no alert. (Crossing logic itself is model-tested.)
    assert.equal(st.alert, null);

    // At 400 km/s the L1→Earth delay is ~62.5 min: the trailing samples
    // haven't arrived — that IS the forecast window.
    assert.ok(st.series.forecast.length > 30, `forecast pts = ${st.series.forecast.length}`);
    assert.ok(st.forecastLeadMin > 45 && st.forecastLeadMin < 75,
        `lead = ${st.forecastLeadMin} min`);

    // 6 h of VBs = 5.6 mV/m has been driving injection → deep model Dst,
    // positive trapped energy, earthward-shifted peak, dusk asymmetry.
    assert.ok(st.now.dstModel < -60, `model Dst = ${st.now.dstModel}`);
    assert.ok(st.now.energyJ > 1e15, `W_RC = ${st.now.energyJ}`);
    assert.ok(st.now.peakL < 4.0);
    assert.ok(st.now.asymmetry.amplitude > 0.5);
    assert.ok(Number.isFinite(st.skill.rmse) && st.skill.n > 10);
    assert.equal(st.now.plasmapauseL, 5.6 - 0.46 * 3);

    // Forecast continues to deepen while southward driving is in transit.
    const lastFc = st.series.forecast[st.series.forecast.length - 1];
    assert.ok(lastFc.dst < st.now.dstModel, 'in-transit southward IMF keeps injecting');

    // The Sun→Earth bridge: in-transit parcels are exposed, arrival-sorted,
    // and the strongest upcoming parcel carries the storm driver
    // (fixture: v=400, Bz=−14 ⇒ VBs = 5.6 mV/m exactly).
    const tr = st.transit;
    assert.ok(tr.parcels.length > 30, `parcels in transit = ${tr.parcels.length}`);
    assert.ok(tr.parcels.every(p => p.tArrive > nowMs));
    assert.ok(tr.parcels.every((p, i) => i === 0 || p.tArrive >= tr.parcels[i - 1].tArrive));
    assert.ok(Math.abs(tr.strongest.vbs - 5.6) < 1e-9, `strongest VBs = ${tr.strongest.vbs}`);
    assert.ok(tr.strongest.etaMin > 0 && tr.strongest.etaMin <= st.forecastLeadMin);

    // Insufficient inputs → null, not a throw.
    assert.equal(computeState([], observed, 3, nowMs), null);
    assert.equal(computeState(drivers, [], 3, nowMs), null);
    ok('computeState: forecast window ≈ L1 lead, storm state, skill, null-safe');
}

// ── 8. omniToReplay (Gannon-style hindcast ingredients) ──────────────────────
{
    const iso = ms => new Date(ms).toISOString();
    const payload = { data: {
        t:      [iso(T0), iso(T0 + 300_000), iso(T0 + 600_000), 'garbage'],
        v:      [450, null, 700, 500],           // null → driver row dropped
        np:     [5, 8, 12, 1],
        bz_gsm: [-2, -20, -30, -1],
        sym_h:  [-15, -80, 9999, -120],          // 9999 fill → observed dropped
    } };
    const r = omniToReplay(payload);
    assert.equal(r.drivers.length, 2);           // t[0] and t[2]
    assert.equal(r.drivers[1].bz, -30);
    assert.equal(r.observed.length, 2);          // fills and bad times dropped
    assert.equal(r.observed[1].dst, -80);
    assert.equal(omniToReplay({ data: { t: [] } }), null);
    assert.equal(omniToReplay(null), null);

    // End-to-end hindcast: replay does NOT re-propagate (OMNI is already
    // bow-shock-shifted) — model tracks span exactly the driver window.
    const drivers = [], observed = [];
    for (let m = 0; m <= 12 * 60; m++) {
        const t = T0 + m * 60_000;
        drivers.push({ t, v: 700, n: 20, bz: m > 4 * 60 ? -25 : 0 });
        if (m % 60 === 0) observed.push({ t, dst: m > 5 * 60 ? -150 : -20 });
    }
    const replay = computeReplayState(drivers, observed, 'test-storm');
    assert.equal(replay.window.startMs, drivers[0].t);
    assert.equal(replay.window.endMs, drivers[drivers.length - 1].t);
    assert.ok(replay.peak.model.dst < -150, `Gannon-class drivers ⇒ deep Dst, got ${replay.peak.model.dst}`);
    assert.equal(replay.peak.observed.dst, -150);
    assert.ok(Number.isFinite(replay.skill.rmse) && replay.skill.n >= 12);
    assert.ok(replay.series.band.length === replay.series.model.length);
    assert.equal(computeReplayState([], observed), null);
    ok('omniToReplay + computeReplayState: hindcast without double propagation');
}

// ── 9. GOES magnetometer parsing + GEO cross-check ───────────────────────────
{
    const rows = [
        { time_tag: '2026-07-10T00:02:00Z', satellite: 19, Hp: 96.1 },   // out of order
        { time_tag: '2026-07-10T00:00:00Z', satellite: 19, Hp: 97.4 },
        { time_tag: '2026-07-10T00:01:00Z', satellite: 19, Hp: 95.0, arcjet_flag: true },  // thruster → dropped
        { time_tag: '2026-07-10T00:03:00Z', satellite: 19, Hp: -9999 },  // fill → dropped
        { time_tag: '2026-07-10T00:04:00Z', satellite: 19, hp: 94.2 },   // lowercase drift tolerated
        { time_tag: 'garbage',              satellite: 19, Hp: 90 },     // bad time → dropped
    ];
    const s = parseGoesMag(rows);
    assert.equal(s.length, 3);
    assert.deepEqual(s.map(r => r.hp), [97.4, 96.1, 94.2]);   // re-sorted ascending
    assert.equal(s[0].sat, 19);
    assert.deepEqual(parseGoesMag(null), []);

    // Cross-check needs ≥120 samples (2 h) — below that, null.
    assert.equal(goesCrossCheck(s, -50, Date.parse('2026-07-10T00:05:00Z')), null);

    // Storm + depressed field ⇒ consistent-storm. Baseline 100 nT, last 80.
    const mk = (lastHp) => {
        const arr = [];
        for (let m = 0; m < 200; m++) {
            arr.push({ t: T0 + m * 60_000, hp: 100, sat: 19 });
        }
        arr.push({ t: T0 + 200 * 60_000, hp: lastHp, sat: 19 });
        return arr;
    };
    const nowMs = T0 + 205 * 60_000;
    const storm = goesCrossCheck(mk(80), -60, nowMs);
    assert.equal(storm.verdict, 'consistent-storm');
    assert.ok(Math.abs(storm.dHp - (-20)) < 1e-9);
    assert.equal(storm.medianHp, 100);
    assert.equal(storm.ageMin, 5);

    // Quiet model + field near baseline ⇒ consistent-quiet.
    assert.equal(goesCrossCheck(mk(102), -10, nowMs).verdict, 'consistent-quiet');
    // Storm model but GEO near baseline (dayside compression can mask) ⇒ mixed.
    assert.equal(goesCrossCheck(mk(101), -80, nowMs).verdict, 'mixed');
    // Quiet model but depressed GEO field ⇒ mixed.
    assert.equal(goesCrossCheck(mk(70), -5, nowMs).verdict, 'mixed');
    // Unknown model Dst: never claims storm consistency.
    assert.equal(goesCrossCheck(mk(80), null, nowMs).verdict, 'mixed');
    ok('GOES: arcjet/fill dropped, case drift tolerated, verdict matrix');
}

// ── 10. computeState exposes the composition split ───────────────────────────
{
    const drivers = [], observed = [];
    for (let m = 0; m <= 6 * 60; m++) {
        drivers.push({ t: T0 + m * 60_000, v: 600, n: 15, bz: -15 });
    }
    for (let h = 0; h <= 7; h++) observed.push({ t: T0 + h * 3.6e6, dst: -20 });
    const st = computeState(drivers, observed, 4, T0 + 6 * 60 * 60_000);
    assert.ok(Number.isFinite(st.now.oxygenFraction));
    assert.ok(st.now.oxygenFraction > 0.2, 'storm drives the O⁺ share up');
    assert.ok(st.now.oxygenFraction < 0.64);
    ok('computeState: storm-time oxygenFraction surfaced for HUD + globe');
}

console.log(`\nring-current-feed-parsers: all ${n} test groups passed`);
