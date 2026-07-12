#!/usr/bin/env node
/**
 * sync-dataset-core.mjs — pure-Node validation of the synchronized
 * solar-wind ↔ geomagnetic minute dataset builder
 * (api/_lib/sync-dataset-core.js):
 *
 *   1. Parsers: kp 1-min (object rows), kp 3-h (product + object forms,
 *      fills dropped), GOES electrons (energy-channel filter, negatives
 *      dropped).
 *   2. Flag policy at the boundaries: ok inside the fresh window, held
 *      beyond it, gap past the hold limit — value null ONLY on gap, and
 *      *_t always exposes the hold distance.
 *   3. Gap rows are emitted explicitly: a minute with no data at all is
 *      still a row (absence recorded, never implied).
 *   4. sw_flag: ok / mag_only / gap from the merged L1 series.
 *   5. ap is DERIVED: kpToAp over the 3-h Kp, source string says so.
 *   6. gapSummary counts; CSV writer: header order, null → empty cell,
 *      quoting.
 *
 * Exits 0 on pass, non-zero on failure.
 */

import assert from 'node:assert/strict';
import { kpToAp } from '../js/ring-current-model.js';
import {
    MINUTE_MS, FRESH_WINDOWS_MIN, HOLD_LIMITS_MIN, SOURCES, DATASET_COLUMNS,
    parseKp1m, parseKp3h, parseGoesElectrons, latestAtOrBefore,
    buildMinuteRows, gapSummary, toCsv,
} from '../api/_lib/sync-dataset-core.js';

let n = 0;
const ok = (msg) => { n++; console.log(`  ✓ ${msg}`); };

const T0 = Date.parse('2026-07-12T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

// ── 1. Parsers ──────────────────────────────────────────────────────────────
{
    const kp1 = parseKp1m([
        { time_tag: '2026-07-12 12:00:00', estimated_kp: 3.33 },
        { time_tag: '2026-07-12 12:01:00', estimated_kp: 99 },       // out of range
        { time_tag: '2026-07-12 12:02:00', estimated_kp: 4.0 },
    ]);
    assert.equal(kp1.length, 2);
    assert.equal(kp1[1].kp, 4);

    const kp3 = parseKp3h([
        ['time_tag', 'Kp', 'a_running', 'station_count'],
        ['2026-07-12 09:00:00', '2.67', '12', '8'],
        ['2026-07-12 12:00:00', '4.00', '27', '8'],
        ['2026-07-12 15:00:00', '-1', '0', '0'],                     // fill
    ]);
    assert.equal(kp3.length, 2);
    assert.equal(kp3[1].kp, 4);
    const kp3obj = parseKp3h([{ time_tag: '2026-07-12T12:00:00Z', kp: 4 }]);
    assert.equal(kp3obj[0].kp, 4, 'object-row form accepted');

    const e2 = parseGoesElectrons([
        { time_tag: '2026-07-12T12:00:00Z', energy: '>=2 MeV', flux: 412.5 },
        { time_tag: '2026-07-12T12:00:00Z', energy: '>=10 MeV', flux: 3 },   // other channel
        { time_tag: '2026-07-12T12:05:00Z', energy: '>=2 MeV', flux: -1 },   // fill
        { time_tag: '2026-07-12T12:05:00Z', energy: '>=2.0 MeV', flux: 430 },
    ]);
    assert.equal(e2.length, 2);
    assert.equal(e2[1].flux, 430);

    assert.equal(latestAtOrBefore(kp3, T0 + 1).kp, 4);
    assert.equal(latestAtOrBefore(kp3, T0 - 2 * 3.6e6).kp, 2.67, 'inside the 09:00 block');
    assert.equal(latestAtOrBefore(kp3, T0 - 4 * 3.6e6), null, 'before the first block → null');
    ok('parsers: kp 1-min, kp 3-h (both forms, fills dropped), e2 channel filter');
}

// ── 2. Flag policy at the boundaries ────────────────────────────────────────
{
    // One Dst sample at 12:00. Fresh 60 min, hold 360 min.
    const src = { sw: [], dst: [{ t: T0, dst: -42 }], kp1m: [], kp3h: [], e2: [] };
    const at = (min) => buildMinuteRows(T0 + min * MINUTE_MS, T0 + (min + 1) * MINUTE_MS, src)[0];

    const fresh = at(FRESH_WINDOWS_MIN.dst - 1);
    assert.equal(fresh.dst_flag, 'ok');
    assert.equal(fresh.dst_nt, -42);
    assert.equal(fresh.dst_t, iso(T0), 'native timestamp travels with the value');

    const held = at(FRESH_WINDOWS_MIN.dst + 1);
    assert.equal(held.dst_flag, 'held', 'past the fresh window → held');
    assert.equal(held.dst_nt, -42, 'held still records the value');
    assert.equal(held.dst_t, iso(T0), 'hold distance is explicit via dst_t');

    const gap = at(HOLD_LIMITS_MIN.dst + 1);
    assert.equal(gap.dst_flag, 'gap', 'past the hold limit → gap');
    assert.equal(gap.dst_nt, null, 'gap ⇒ null value');
    assert.equal(gap.dst_t, null);

    const before = buildMinuteRows(T0 - MINUTE_MS, T0, src)[0];
    assert.equal(before.dst_flag, 'gap', 'nothing at-or-before → gap');
    ok('flag policy: ok ≤ fresh < held ≤ hold < gap, with *_t always explicit');
}

// ── 3. Gap rows are emitted explicitly ──────────────────────────────────────
{
    const rows = buildMinuteRows(T0, T0 + 5 * MINUTE_MS,
        { sw: [], dst: [], kp1m: [], kp3h: [], e2: [] });
    assert.equal(rows.length, 5, 'a row per minute even with zero data');
    for (const r of rows) {
        assert.equal(r.sw_flag, 'gap');
        assert.equal(r.kp_flag, 'gap');
        assert.equal(r.ap_flag, 'gap');
        assert.equal(r.dst_flag, 'gap');
        assert.equal(r.e2_flag, 'gap');
        assert.equal(r.sw_v_km_s, null);
        assert.equal(r.sw_source, null);
    }
    ok('absence is recorded: all-gap minutes still produce rows');
}

// ── 4. sw_flag: ok / mag_only / gap ─────────────────────────────────────────
{
    const sw = [
        { t: T0,                 v: 480, n: 5.2, temp: 1e5, bt: 6, bz: -3, bx: 1, by: 2 },
        { t: T0 + MINUTE_MS,     v: null, n: null, temp: null, bt: 6, bz: -4, bx: 1, by: 2 },
        // minute 2 missing entirely
    ];
    const rows = buildMinuteRows(T0, T0 + 3 * MINUTE_MS,
        { sw, swSource: 'rtsw', dst: [], kp1m: [], kp3h: [], e2: [] });
    assert.equal(rows[0].sw_flag, 'ok');
    assert.equal(rows[0].sw_v_km_s, 480);
    assert.equal(rows[0].sw_source, 'rtsw');
    assert.equal(rows[1].sw_flag, 'mag_only', 'IMF-only minute flagged, Bz kept');
    assert.equal(rows[1].sw_bz_nt, -4);
    assert.equal(rows[1].sw_v_km_s, null);
    assert.equal(rows[2].sw_flag, 'gap');
    assert.equal(rows[2].sw_source, null, 'gap rows carry no source claim');
    ok('sw_flag: ok / mag_only (Bz preserved) / gap');
}

// ── 5. ap is derived and labeled as derived ─────────────────────────────────
{
    const rows = buildMinuteRows(T0, T0 + MINUTE_MS, {
        sw: [], dst: [], e2: [],
        kp1m: [{ t: T0, kp: 4.33 }],
        kp3h: [{ t: T0, kp: 4.0 }],
    });
    const r = rows[0];
    assert.equal(r.ap, kpToAp(4.0), `ap ${r.ap} = kpToAp(3-h Kp), not the 1-min est`);
    assert.equal(r.ap_flag, 'ok');
    assert.ok(/derived/.test(r.ap_source), 'ap source declares the derivation');
    assert.ok(/kpToAp/.test(r.ap_source), 'and names the formula');
    assert.equal(r.kp, 4.33, 'kp column stays the native 1-min estimate');
    assert.equal(r.kp_source, SOURCES.kp);
    // 3-h block covers its own 180 minutes as 'ok'.
    const late = buildMinuteRows(T0 + 179 * MINUTE_MS, T0 + 180 * MINUTE_MS, {
        sw: [], dst: [], e2: [], kp1m: [], kp3h: [{ t: T0, kp: 4.0 }],
    })[0];
    assert.equal(late.ap_flag, 'ok', 'minute 179 of the block is still ok');
    ok('ap: derived from definitive 3-h Kp via kpToAp, provenance-labeled');
}

// ── 6. gapSummary + CSV ─────────────────────────────────────────────────────
{
    const rows = buildMinuteRows(T0, T0 + 3 * MINUTE_MS, {
        sw: [{ t: T0, v: 480, n: 5, temp: 1e5, bt: 6, bz: -3, bx: null, by: null }],
        swSource: 'rtsw',
        dst: [{ t: T0, dst: -42 }],
        kp1m: [{ t: T0, kp: 3 }],
        kp3h: [{ t: T0, kp: 3 }],
        e2: [{ t: T0, flux: 400 }],
    });
    const sum = gapSummary(rows);
    assert.equal(sum.minutes, 3);
    assert.equal(sum.sw.ok, 1);
    assert.equal(sum.sw.gap, 2);
    assert.equal(sum.dst.ok, 3);
    assert.equal(sum.kp.ok + sum.kp.held, 3);

    const csv = toCsv(rows);
    const lines = csv.trim().split('\n');
    assert.equal(lines[0], DATASET_COLUMNS.join(','), 'header is the canonical column order');
    assert.equal(lines.length, 4);
    const cells0 = lines[1].split(',');
    assert.equal(cells0[0], rows[0].t);
    assert.equal(cells0[1], '480', 'numeric cell');
    const gapCells = lines[3].split(',');
    assert.equal(gapCells[1], '', 'null → empty cell, never the string "null"');
    assert.ok(csv.includes('derived: kpToAp(noaa-swpc planetary-k-3h)'),
        'derivation provenance survives into the CSV');
    // Quoting: only cells carrying commas/quotes/newlines get quoted.
    const quoted = toCsv([{ ...rows[0], kp_source: 'a,b "c"' }]);
    assert.ok(quoted.includes('"a,b ""c"""'), 'comma+quote cells are RFC-quoted');
    ok('gapSummary counts; CSV: canonical header, empty-cell nulls, quoting');
}

console.log(`\nsync-dataset-core: all ${n} test groups passed`);
