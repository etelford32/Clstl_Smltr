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
    observedDstAt, computeState,
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
    const st = computeState(drivers, observed, 3, nowMs);
    assert.ok(st, 'state computed');

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

console.log(`\nring-current-feed-parsers: all ${n} test groups passed`);
