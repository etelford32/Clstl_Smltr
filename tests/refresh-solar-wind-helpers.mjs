#!/usr/bin/env node
/**
 * refresh-solar-wind-helpers.mjs — pure-Node tests for the exported helpers
 * of api/cron/refresh-solar-wind.js (imported directly; the module has no
 * import-time side effects beyond reading env vars):
 *
 *   1. mergeMinuteSeries: plasma+mag joined on UTC minute; MAG-ONLY minutes
 *      kept with v=null (unlike the browser feed's merge — deliberate);
 *      fill sentinels dropped; ascending output.
 *   2. pickFreshMagOnly: newest usable IMF row within the freshness window;
 *      null when the tail is older than the window.
 *   3. parseKyotoHourly: minute-cadence product → one value per UTC hour
 *      (last wins), both payload shapes, |dst|>1000 fill dropped.
 *   4. interpDstAt: interpolation + end clamps.
 *
 * Exits 0 on pass, non-zero on failure.
 */

import assert from 'node:assert/strict';
import {
    mergeMinuteSeries, pickFreshMagOnly, parseKyotoHourly, interpDstAt,
} from '../api/cron/refresh-solar-wind.js';

let n = 0;
const ok = (msg) => { n++; console.log(`  ✓ ${msg}`); };

const T0 = Date.parse('2026-07-10T00:00:00Z');
const tag = ms => new Date(ms).toISOString().replace('T', ' ').replace('Z', '');

// ── 1. mergeMinuteSeries ─────────────────────────────────────────────────────
{
    const wind = [
        { time_tag: tag(T0),            proton_speed: 400,   proton_density: 5, proton_temperature: 9e4 },
        { time_tag: tag(T0 + 60_000),   proton_speed: -9999, proton_density: 5 },   // fill → plasma dropped
        { time_tag: tag(T0 + 120_000),  speed: 450, density: 8 },                   // plain field names
    ];
    const mag = [
        { time_tag: tag(T0),           bz_gsm: -5, bt: 8, bx_gsm: 1, by_gsm: 2 },
        { time_tag: tag(T0 + 60_000),  bz_gsm: -6, bt: 9 },     // MAG-ONLY minute (plasma was fill)
        { time_tag: tag(T0 + 180_000), bz: -7, bt: 10 },        // MAG-ONLY minute (no plasma row at all)
        { time_tag: tag(T0 + 240_000), bz_gsm: -9999, bt: -9999 },  // all-fill mag → dropped
    ];
    const s = mergeMinuteSeries(wind, mag);
    assert.equal(s.length, 4);
    assert.deepEqual(s.map(r => r.v),  [400, null, 450, null]);
    assert.deepEqual(s.map(r => r.bz), [-5, -6, null, -7]);
    assert.equal(s[0].by, 2);
    assert.ok(s.every((r, i) => i === 0 || r.t > s[i - 1].t), 'ascending');
    assert.deepEqual(mergeMinuteSeries(null, null), []);
    ok('mergeMinuteSeries: minute join, mag-only minutes kept with v=null');
}

// ── 2. pickFreshMagOnly ──────────────────────────────────────────────────────
{
    const now = T0 + 60 * 60_000;
    const series = [
        { t: T0,               v: 400,  bz: -5, bt: 8 },
        { t: now - 5 * 60_000, v: null, bz: -6, bt: 9 },   // fresh mag-only
    ];
    const hit = pickFreshMagOnly(series, now);
    assert.equal(hit.bz, -6);
    // Stale tail → null even though older rows have IMF.
    const stale = [{ t: now - 60 * 60_000, v: null, bz: -6, bt: 9 }];
    assert.equal(pickFreshMagOnly(stale, now), null);
    assert.equal(pickFreshMagOnly([], now), null);
    ok('pickFreshMagOnly: fresh IMF found, stale tail rejected');
}

// ── 3. parseKyotoHourly ──────────────────────────────────────────────────────
{
    // Minute-cadence rows repeating the provisional hourly value; last wins.
    const objForm = [
        { time_tag: tag(T0),             dst: -20 },
        { time_tag: tag(T0 + 30 * 60_000), dst: -22 },        // same hour, later → wins
        { time_tag: tag(T0 + 3.6e6),     dst: 99999 },        // fill → dropped
        { time_tag: tag(T0 + 2 * 3.6e6), dst_index: -35 },    // alt field name
    ];
    const o = parseKyotoHourly(objForm);
    assert.equal(o.length, 2);
    assert.equal(o[0].dst, -22);
    assert.equal(o[1].dst, -35);

    const arrForm = [['time_tag', 'dst'], [tag(T0), '-30'], [tag(T0 + 3.6e6), '-55']];
    const a = parseKyotoHourly(arrForm);
    assert.equal(a.length, 2);
    assert.equal(a[1].dst, -55);
    assert.deepEqual(parseKyotoHourly([]), []);
    ok('parseKyotoHourly: hourly dedup (last wins), both shapes, fills dropped');
}

// ── 4. interpDstAt ───────────────────────────────────────────────────────────
{
    const s = [{ t: T0, dst: -10 }, { t: T0 + 3.6e6, dst: -30 }];
    assert.equal(interpDstAt(s, T0 - 1), -10);
    assert.equal(interpDstAt(s, T0 + 2 * 3.6e6), -30);
    assert.ok(Math.abs(interpDstAt(s, T0 + 1.8e6) - (-20)) < 1e-9);
    assert.equal(interpDstAt([], T0), null);
    ok('interpDstAt: midpoint + end clamps');
}

console.log(`\nrefresh-solar-wind-helpers: all ${n} test groups passed`);
