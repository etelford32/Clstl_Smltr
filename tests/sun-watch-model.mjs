#!/usr/bin/env node
/**
 * Gate for js/sun-watch-model.js — the pure analysis kernel behind the
 * Sun Watch dock on sun.html.
 *
 * Pins the behaviours that failed silently elsewhere in this repo:
 *   · probability scale detected over the WHOLE region set (whole-percent
 *     SWPC rows must not read `1` as certainty)
 *   · a dead/malformed feed degrades to an empty section, never a throw
 *   · flares arriving from both DONKI and SWPC dedupe by class + hour
 *   · coronal holes without a Stonyhurst longitude are dropped, not guessed
 *
 * Run: node tests/sun-watch-model.mjs
 */
import assert from 'node:assert/strict';
import {
    buildTimeline, enrichRegions, regionProbIndex, cmeSummary,
    cycleSummary, holeMarkers, parseStonyhurst, classSeverity,
    fmtAge, freshnessLabel,
} from '../js/sun-watch-model.js';

let checks = 0;
const ok = (label, fn) => { fn(); checks++; void label; };

const NOW = Date.parse('2026-08-25T12:00:00Z');

// ── parseStonyhurst / classSeverity ─────────────────────────────────────────
ok('stonyhurst parse, W positive (sun.html parseLoc frame)', () => {
    assert.deepEqual(parseStonyhurst('N18W22'), { lat: 18, lon: 22 });
    assert.deepEqual(parseStonyhurst('s05e110'), { lat: -5, lon: -110 });
    assert.equal(parseStonyhurst('garbage'), null);
    assert.equal(parseStonyhurst(null), null);
});
ok('class severity ranks A..X', () => {
    assert.equal(classSeverity('X9.3'), 4);
    assert.equal(classSeverity('m1'), 3);
    assert.equal(classSeverity('C2.2'), 2);
    assert.equal(classSeverity(undefined), 0);
});

// ── Timeline ────────────────────────────────────────────────────────────────
const donkiFlares = [
    { peak_time: '2026-08-25T10:30:00Z', flare_class: 'M2.5', location: 'N12W30', active_region: 4321, linked_cme: 'CME-1' },
    { peak_time: '2026-08-24T02:00:00Z', flare_class: 'C5.0', location: 'S08E15', active_region: 4322 },
    { peak_time: '2026-07-01T00:00:00Z', flare_class: 'X1.0', location: 'N01W01' },   // outside window
];
const swpcFlares = [
    { time: '2026-08-25T10:45:00', cls: 'M2.5', loc: 'N12W30', reg: '4321' },  // dup of DONKI (same class+hour)
    { time: '2026-08-25T06:00:00', cls: 'C1.2', loc: 'N05E40', reg: '—' },     // unique
];
const cmes = [
    { time: '2026-08-25T11:00:00Z', cme_id: 'a', speed_km_s: 950, half_angle_deg: 38,
      latitude_deg: 5, longitude_deg: -10, earth_directed: true,
      enlil: { shock_arrival: '2026-08-27T04:00:00Z', kp_90: 5, kp_180: 7 } },
    { time: '2026-08-23T00:00:00Z', cme_id: 'b', speed_km_s: 420, earth_directed: false },
];
const seps = [{ event_time: '2026-08-25T11:30:00Z', instruments: ['GOES-16: >10 MeV'], linked_flare: 'f1' }];
const gsts = [{ start_time: '2026-08-24T18:00:00Z', max_kp: 6.33, g_scale: 2, linked_cme: 'CME-0' }];
const notes = [
    { type: 'Report', issue_time: '2026-08-25T08:00:00Z', body: 'weekly summary' },
    { type: 'CME', issue_time: '2026-08-25T09:00:00Z', body: 'cme note (typed events cover this)' },
];

ok('timeline merges all kinds, newest first, window enforced', () => {
    const tl = buildTimeline({ donkiFlares, swpcFlares, cmes, seps, gsts, notes, nowMs: NOW });
    assert.ok(tl.length >= 7);
    for (let i = 1; i < tl.length; i++) assert.ok(tl[i - 1].t >= tl[i].t, 'sorted desc');
    assert.ok(!tl.some(e => e.cls === 'X1.0'), 'outside-window flare dropped');
    assert.ok(!tl.some(e => e.kind === 'note' && /cme note/.test(e.detail)), 'non-Report notifications dropped');
});
ok('DONKI + SWPC flare dedupe by class + hour', () => {
    const tl = buildTimeline({ donkiFlares, swpcFlares, nowMs: NOW });
    const m25 = tl.filter(e => e.cls === 'M2.5');
    assert.equal(m25.length, 1, 'duplicate M2.5 collapsed');
    assert.match(m25[0].title, /AR 4321/, 'DONKI (richer) record wins');
    assert.ok(tl.some(e => e.cls === 'C1.2'), 'unique SWPC flare kept');
});
ok('flare rows carry fly-to coordinates', () => {
    const tl = buildTimeline({ donkiFlares, nowMs: NOW });
    const f = tl.find(e => e.cls === 'M2.5');
    assert.equal(f.lat, 12);
    assert.equal(f.lon, 30);
    assert.equal(f.earth, true, 'linked CME flags Earth-relevance');
});
ok('timeline survives null/garbage feeds', () => {
    assert.deepEqual(buildTimeline({ nowMs: NOW }), []);
    const tl = buildTimeline({
        donkiFlares: [{}, null, { flare_class: 'M1', peak_time: 'not-a-date' }],
        cmes: 'nope', seps: null, gsts: undefined, notes: 42, nowMs: NOW,
    });
    assert.deepEqual(tl, []);
});

// ── Regions ─────────────────────────────────────────────────────────────────
ok('whole-percent SWPC rows: 1 means 1%, never certainty', () => {
    const { rows, scale } = enrichRegions([
        { region: 4321, location: 'N12W30', latitude_deg: 12, stonyhurst_lon_deg: 30,
          mag_class: 'BGD', area: 500, num_spots: 22,
          c_flare_probability: 90, m_flare_probability: 40, x_flare_probability: 10 },
        { region: 4322, location: 'S08E15', latitude_deg: -8, stonyhurst_lon_deg: -15,
          mag_class: 'A', area: 30, num_spots: 3,
          c_flare_probability: 1, m_flare_probability: 1, x_flare_probability: 1 },
    ]);
    assert.equal(scale, 'percent');
    const small = rows.find(r => r.region === '4322');
    assert.ok(Math.abs(small.pM - 0.01) < 1e-9, 'quiet region reads 1% not 100%');
    assert.equal(rows[0].region, '4321', 'flare-capable region sorts first');
});
ok('region prob index keyed by region string', () => {
    const { rows } = enrichRegions([{ region: 4321, m_flare_probability: 40 }]);
    const idx = regionProbIndex(rows);
    assert.ok(idx.get('4321'));
    assert.equal(idx.get('9999'), undefined);
});
ok('regions survive a dead feed', () => {
    assert.deepEqual(enrichRegions(null).rows, []);
    assert.deepEqual(enrichRegions([{ no: 'fields' }]).rows, []);
});

// ── CME summary ─────────────────────────────────────────────────────────────
ok('cme summary counts, fastest, next future arrival', () => {
    const s = cmeSummary(cmes, NOW);
    assert.equal(s.count, 2);
    assert.equal(s.earthCount, 1);
    assert.equal(s.fastest, 950);
    assert.equal(s.nextArrival, Date.parse('2026-08-27T04:00:00Z'));
});
ok('past arrivals are not "next"', () => {
    const s = cmeSummary([{ enlil: { shock_arrival: '2026-08-20T00:00:00Z' } }], NOW);
    assert.equal(s.nextArrival, null);
});

// ── Cycle summary ───────────────────────────────────────────────────────────
ok('cycle summary: means, trend, observed/predicted split', () => {
    const rows = [];
    for (let d = 100; d >= 1; d--) {
        rows.push({
            date: new Date(NOW - d * 86400e3).toISOString().slice(0, 10),
            flux_sfu: 120 + (100 - d) * 0.5,        // steadily rising
            kind: 'observed',
        });
    }
    for (let d = 1; d <= 10; d++) {
        rows.push({ date: new Date(NOW + d * 86400e3).toISOString().slice(0, 10), flux_sfu: 172, kind: 'predicted' });
    }
    const c = cycleSummary(rows, NOW);
    assert.ok(c.current > 165);
    assert.ok(c.mean27 > c.mean81, 'rising series: shorter mean higher');
    assert.equal(c.trend, 'rising');
    assert.ok(/activity/i.test(c.label));
    assert.ok(c.series.some(p => p.kind === 'predicted'));
});
ok('cycle summary null on empty', () => {
    assert.equal(cycleSummary([], NOW), null);
    assert.equal(cycleSummary(null, NOW), null);
});

// ── Coronal holes ───────────────────────────────────────────────────────────
ok('hole markers use Stonyhurst lon, drop rows without one', () => {
    const holes = holeMarkers([
        { lat_deg: 45, lon_helio_deg: -20, lon_carrington_deg: 210, frm_name: 'SPoCA' },
        { lat_deg: -60, lon_carrington_deg: 100 },                    // no Stonyhurst lon → dropped
        { lat_deg: 10, lon_helio_deg: 200 },                          // beyond the visible disc → dropped
        { lat_deg: 'x', lon_helio_deg: 0 },                           // garbage → dropped
    ]);
    assert.equal(holes.length, 1);
    assert.equal(holes[0].lon, -20);
    assert.equal(holes[0].source, 'SPoCA');
});
ok('hole markers cap at 12', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ lat_deg: i - 15, lon_helio_deg: 0 }));
    assert.equal(holeMarkers(many).length, 12);
});

// ── Small helpers ───────────────────────────────────────────────────────────
ok('fmtAge bands', () => {
    assert.equal(fmtAge(NOW - 30e3, NOW), '30s');
    assert.equal(fmtAge(NOW - 20 * 60e3, NOW), '20m');
    assert.equal(fmtAge(NOW - 3 * 86400e3, NOW), '3.0d');
    assert.equal(fmtAge(NaN, NOW), '—');
});
ok('freshness bands', () => {
    assert.equal(freshnessLabel(5 * 60e3), 'live');
    assert.equal(freshnessLabel(60 * 60e3), 'recent');
    assert.equal(freshnessLabel(5 * 3600e3), 'stale');
    assert.equal(freshnessLabel(NaN), 'down');
});

console.log(`✅ sun-watch-model: ${checks} checks passed`);
