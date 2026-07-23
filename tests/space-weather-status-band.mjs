#!/usr/bin/env node
/**
 * space-weather-status-band.mjs — fixture gate for the pure model behind
 * the space-weather status band (js/space-weather-status-band.js).
 * The band computes nothing itself — these tests pin that it FAITHFULLY
 * RELAYS the verdict-engine oracles (stormOutlook tiering, auroraVerdict's
 * margin ≤ 5° GO, the no-dark-window override) into the five-step status
 * grammar, and that every degraded input degrades to an honest cell
 * instead of a broken one.
 *
 *   node tests/space-weather-status-band.mjs
 */

import assert from 'node:assert/strict';
import { statusBandModel, kpStatus, deepestSunAltitude, STATUS_RANK }
    from '../js/space-weather-status-band.js';

let n = 0;
const test = (name, fn) => { fn(); n++; console.log(`  ✓ ${name}`); };
const HOUR = 3.6e6;
const T0 = Date.parse('2026-12-21T12:00:00Z');   // fixed winter epoch
const cell = (m, id) => m.cells.find((c) => c.id === id);

/* ── Kp → status grammar ────────────────────────────────────────────── */

test('kpStatus steps at the G-scale boundaries', () => {
    assert.equal(kpStatus(null).cls, 'quiet');
    assert.equal(kpStatus(2).cls, 'quiet');
    assert.equal(kpStatus(4).cls, 'elevated');
    assert.equal(kpStatus(5).cls, 'watch');
    assert.equal(kpStatus(6).cls, 'warning');
    assert.equal(kpStatus(7).cls, 'severe');
    assert.equal(kpStatus(9).cls, 'severe');
});

/* ── Shape + degraded inputs ────────────────────────────────────────── */

test('always four cells in band order, every cls in the grammar', () => {
    for (const summary of [undefined, null]) {
        const m = statusBandModel({ summary, kp: null, loc: null, nowMs: T0 });
        assert.deepEqual(m.cells.map((c) => c.id), ['outlook', 'arrival', 'kp', 'tonight']);
        for (const c of m.cells) {
            assert.ok(STATUS_RANK.includes(c.cls), `${c.id}: cls ${c.cls}`);
            assert.ok(c.label && c.value && c.detail, `${c.id}: complete cell`);
        }
    }
});

test('pending vs idle are distinct honest states', () => {
    const pending = statusBandModel({ summary: undefined, kp: null, loc: null, nowMs: T0 });
    assert.equal(cell(pending, 'outlook').value, '…');
    const idle = statusBandModel({ summary: null, kp: null, loc: null, nowMs: T0 });
    assert.equal(cell(idle, 'outlook').value, 'Quiet');
    assert.match(cell(idle, 'outlook').detail, /DONKI/);
    assert.equal(cell(idle, 'arrival').value, '—');
});

/* ── Outlook + countdown relay stormOutlook's tiers ─────────────────── */

const mkSummary = (p50h, over = {}) => ({
    pHit: 0.7, p10: 0.5, p20: 0.2,
    arrivalP10Ms: T0 + (p50h - 10) * HOUR,
    arrivalP50Ms: T0 + p50h * HOUR,
    arrivalP90Ms: T0 + (p50h + 15) * HOUR,
    ...over,
});

test('>24 h out → Watch; countdown carries the tier urgency', () => {
    const m = statusBandModel({ summary: mkSummary(40), kp: 3, loc: null, nowMs: T0 });
    assert.equal(cell(m, 'outlook').value, 'Watch');
    assert.equal(cell(m, 'outlook').cls, 'watch');
    assert.equal(cell(m, 'arrival').value, 'T−40 h');
    assert.equal(cell(m, 'arrival').cls, 'watch');
    assert.match(cell(m, 'arrival').detail, /window/);
});

test('≤24 h out → Warning', () => {
    const m = statusBandModel({ summary: mkSummary(18), kp: 3, loc: null, nowMs: T0 });
    assert.equal(cell(m, 'outlook').value, 'Warning');
    assert.equal(cell(m, 'outlook').cls, 'warning');
});

test('P50 in the past → Arriving/severe (p10 ≥ 0.3), countdown reads now', () => {
    const m = statusBandModel({ summary: mkSummary(-1), kp: 3, loc: null, nowMs: T0 });
    assert.equal(cell(m, 'outlook').value, 'Arriving');
    assert.equal(cell(m, 'outlook').cls, 'severe');
    assert.equal(cell(m, 'arrival').value, 'now');
});

test('deep miss (P(hit) < 15%) reads Quiet, not a scare', () => {
    const m = statusBandModel({
        summary: mkSummary(40, { pHit: 0.05 }), kp: 3, loc: null, nowMs: T0 });
    assert.equal(cell(m, 'outlook').value, 'Quiet');
    // But the countdown still shows the (unlikely) window honestly.
    assert.equal(cell(m, 'arrival').value, 'T−40 h');
});

/* ── Tonight at the pin relays auroraVerdict ────────────────────────── */

const FAIRBANKS = { lat: 64.84, lon: -147.72, city: 'Fairbanks' };
const MIAMI = { lat: 25.76, lon: -80.19, city: 'Miami' };

test('no location → honest placeholder', () => {
    const m = statusBandModel({ summary: null, kp: 6, loc: null, nowMs: T0 });
    assert.equal(cell(m, 'tonight').value, '—');
    assert.match(cell(m, 'tonight').detail, /location/);
});

test('Fairbanks, Kp 6, winter dark → GO', () => {
    const m = statusBandModel({ summary: null, kp: 6, loc: FAIRBANKS, nowMs: T0 });
    assert.equal(cell(m, 'tonight').value, 'GO');
    assert.equal(cell(m, 'tonight').cls, 'warning');
    assert.match(cell(m, 'tonight').detail, /Fairbanks/);
});

test('Miami, Kp 2 → No (quiet)', () => {
    const m = statusBandModel({ summary: null, kp: 2, loc: MIAMI, nowMs: T0 });
    assert.equal(cell(m, 'tonight').value, 'No');
    assert.equal(cell(m, 'tonight').cls, 'quiet');
});

test('midnight sun beats any Kp: Fairbanks in June, Kp 9 → No', () => {
    const june = Date.parse('2026-06-21T12:00:00Z');
    const deepest = deepestSunAltitude(FAIRBANKS.lat, FAIRBANKS.lon, june);
    assert.ok(deepest > -12, `no astronomical dark at solstice (deepest ${deepest.toFixed(1)}°)`);
    const m = statusBandModel({ summary: null, kp: 9, loc: FAIRBANKS, nowMs: june });
    assert.equal(cell(m, 'tonight').value, 'No');
});

/* ── D2: the §8 threshold line escalates the Kp cell ────────────────── */

test('Kp at/above YOUR line escalates to warning and says so', () => {
    const profile = { kp: 5, minBzNt: -10, dstNt: -50, leoAltKm: 550 };
    const m = statusBandModel({ summary: null, kp: 5, loc: null, profile, nowMs: T0 });
    assert.equal(cell(m, 'kp').cls, 'warning', 'watch (G1) escalates at the line');
    assert.match(cell(m, 'kp').detail, /your line \(Kp 5\)/);
});

test('Kp below the line stays calm but shows where the line is', () => {
    const profile = { kp: 5, minBzNt: -10, dstNt: -50, leoAltKm: 550 };
    const m = statusBandModel({ summary: null, kp: 3, loc: null, profile, nowMs: T0 });
    assert.equal(cell(m, 'kp').cls, 'quiet');
    assert.match(cell(m, 'kp').detail, /your line Kp 5/);
});

test('escalation never DOWNGRADES an already-severe cell', () => {
    const profile = { kp: 5, minBzNt: -10, dstNt: -50, leoAltKm: 550 };
    const m = statusBandModel({ summary: null, kp: 8, loc: null, profile, nowMs: T0 });
    assert.equal(cell(m, 'kp').cls, 'severe');
    assert.match(cell(m, 'kp').detail, /≥ your line/);
    // And without a profile the D1 behavior is bit-identical.
    const bare = statusBandModel({ summary: null, kp: 8, loc: null, nowMs: T0 });
    assert.equal(bare.cells[2].detail, 'G3+ storm');
});

test('deepestSunAltitude is pure and deterministic', () => {
    assert.equal(
        deepestSunAltitude(FAIRBANKS.lat, FAIRBANKS.lon, T0),
        deepestSunAltitude(FAIRBANKS.lat, FAIRBANKS.lon, T0));
    assert.ok(deepestSunAltitude(FAIRBANKS.lat, FAIRBANKS.lon, T0) < -12,
        'winter Fairbanks has true dark');
});

test('calendar replay labels the outlook + arrival cells, never as the live watch', () => {
    // A replayed past event: P50 arrival 2 days AGO.
    const summary = { pHit: 0.8, p10: 0.6, p20: 0.3,
        arrivalP10Ms: T0 - 60 * HOUR, arrivalP50Ms: T0 - 48 * HOUR,
        arrivalP90Ms: T0 - 40 * HOUR, minBzP50: -12 };
    const m = statusBandModel({ summary, kp: 3, loc: null, nowMs: T0,
        replay: 'CME 07-18 12:36Z · 900 km/s' });
    const o = cell(m, 'outlook');
    assert.equal(o.label, 'Outlook · REPLAY');
    assert.ok(o.detail.startsWith('⟲ CME 07-18'), o.detail);
    const a = cell(m, 'arrival');
    assert.equal(a.label, 'Arrival · REPLAY');
    assert.equal(a.value, 'arrived');            // past P50 says arrived, not "now"
    // No replay → labels untouched (the live grammar is unchanged).
    const live = statusBandModel({ summary, kp: 3, loc: null, nowMs: T0 });
    assert.equal(cell(live, 'outlook').label, 'Storm outlook');
});

console.log(`space-weather-status-band: ALL PASS (${n} tests)`);
