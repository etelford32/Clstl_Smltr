// cme-calendar.mjs — node gate for the PURE parts of js/cme-calendar.js:
// calendarEvents (feed rows → arrival events; WSA-ENLIL preferred over
// the DBM oracle, honest source labels) and calendarModel (the rolling
// −7 d … +30 d UTC grid, observed/today flags, launch-vs-arrival
// placement, ensemble P10–P90 span marking). Run: node tests/cme-calendar.mjs

import { strict as assert } from 'node:assert';
import { calendarEvents, calendarModel, utcMidnight } from '../js/cme-calendar.js';
import { CmeEvent } from '../js/cme-propagation.js';

const DAY = 86_400e3;
// Fixed clock: 2026-07-22 15:00 UTC (explicit — the model takes nowMs).
const NOW = Date.parse('2026-07-22T15:00:00Z');

let n = 0;
function test(name, fn) { fn(); n++; console.log(`  ✓ ${name}`); }

console.log('cme-calendar node gate');

/* ── calendarEvents ───────────────────────────────────────────────── */

test('DBM fallback: arrival matches the CmeEvent oracle, source=dbm', () => {
    const row = { time: '2026-07-21T06:00Z', speed: 800, halfAngle: 40,
                  earthDirected: true, latitude: 5, longitude: -10, note: 'x' };
    const [ev] = calendarEvents([row], { vSw: 420 });
    const oracle = new CmeEvent({ time: row.time, speed: 800, halfAngle: 40,
        earthDirected: true, latitude: 5, longitude: -10, note: 'x' }, 420);
    assert.equal(ev.source, 'dbm');
    assert.equal(ev.arrivalMs, oracle.arrival_ms);
    assert.equal(ev.launchMs, Date.parse('2026-07-21T06:00Z'));
    assert.equal(ev.earthDirected, true);
    assert.equal(ev.gScale, oracle.impact.g_scale);
});

test('ENLIL preferred: shock arrival + kp override the DBM numbers', () => {
    const row = { time: '2026-07-20T12:00Z', speed: 900, halfAngle: 45,
                  earthDirected: true,
                  enlil: { shock_arrival: '2026-07-23T04:30Z', kp_90: 6,
                           kp_135: 5, kp_180: 4 } };
    const [ev] = calendarEvents([row]);
    assert.equal(ev.source, 'enlil');
    assert.equal(ev.arrivalMs, Date.parse('2026-07-23T04:30Z'));
    assert.equal(ev.kpMax, 6);
    assert.equal(ev.gScale, 2);       // Kp 6 → G2
});

test('rows without a valid launch time are dropped', () => {
    assert.equal(calendarEvents([{ speed: 500 }, { time: 'garbage' }]).length, 0);
});

/* ── calendarModel ────────────────────────────────────────────────── */

test('window: 38 days, −7 d start, today flagged, past band correct', () => {
    const m = calendarModel({ events: [], nowMs: NOW });
    assert.equal(m.days.length, 38);
    assert.equal(m.days[0].dayMs, utcMidnight(NOW) - 7 * DAY);
    assert.equal(m.days.at(-1).dayMs, utcMidnight(NOW) + 30 * DAY);
    assert.equal(m.days.filter((d) => d.past).length, 7);
    const today = m.days[7];
    assert.equal(today.today, true);
    assert.equal(today.iso, '2026-07-22');
    assert.equal(m.lead, new Date(m.days[0].dayMs).getUTCDay());
});

test('placement: launch dot on launch day, ⊕ arrival chip on arrival day', () => {
    const ev = { id: 'a', launchMs: Date.parse('2026-07-21T06:00Z'),
                 arrivalMs: Date.parse('2026-07-24T19:45Z'),
                 earthDirected: true, gScale: 2, speedKms: 800 };
    const m = calendarModel({ events: [ev], nowMs: NOW });
    const launchDay = m.days.find((d) => d.iso === '2026-07-21');
    const arriveDay = m.days.find((d) => d.iso === '2026-07-24');
    assert.equal(launchDay.launches.length, 1);
    assert.equal(launchDay.arrivals.length, 0);
    assert.equal(arriveDay.arrivals.length, 1);
    assert.equal(arriveDay.arrivals[0].hhmm, '19:45');
});

test('non-Earth-directed CMEs get a launch dot but never an arrival chip', () => {
    const ev = { id: 'b', launchMs: NOW - 2 * DAY, arrivalMs: NOW + DAY,
                 earthDirected: false, gScale: 0 };
    const m = calendarModel({ events: [ev], nowMs: NOW });
    assert.equal(m.days.reduce((s, d) => s + d.launches.length, 0), 1);
    assert.equal(m.days.reduce((s, d) => s + d.arrivals.length, 0), 0);
});

test('ensemble span: P10–P90 days marked, P50 day flagged once', () => {
    const span = { p10Ms: NOW + 1.2 * DAY, p50Ms: NOW + 2.5 * DAY,
                   p90Ms: NOW + 3.8 * DAY };
    const m = calendarModel({ events: [], nowMs: NOW, span });
    // 15:00Z + 1.2 d → Jul 23; + 3.8 d → Jul 26: four marked days.
    const inSpan = m.days.filter((d) => d.inSpan);
    assert.equal(inSpan.length, 4);
    assert.equal(inSpan[0].dayMs, utcMidnight(span.p10Ms));
    assert.equal(inSpan.at(-1).dayMs, utcMidnight(span.p90Ms));
    assert.equal(m.days.filter((d) => d.isP50).length, 1);
    assert.equal(m.days.find((d) => d.isP50).dayMs, utcMidnight(span.p50Ms));
});

test('no span: nothing marked', () => {
    const m = calendarModel({ events: [], nowMs: NOW, span: null });
    assert.equal(m.days.some((d) => d.inSpan || d.isP50), false);
});

console.log(`${n} passed`);
