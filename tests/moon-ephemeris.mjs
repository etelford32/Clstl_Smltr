#!/usr/bin/env node
/**
 * moon-ephemeris.mjs — gate for js/moon-ephemeris.js.
 *
 * Run: node tests/moon-ephemeris.mjs
 *
 * The load-bearing pins:
 *   • Meeus's own worked examples: Moon position for 1992 April 12 (ch. 47),
 *     Sun position for 1992 Oct 13 (ch. 25), illuminated fraction 0.6786
 *     (ch. 48), optical libration l′ ≈ −1.2°, b′ ≈ +4.2° (ch. 53).
 *   • Cross-pin with the interior kernel: at REF_PERIGEE_MS (2016-11-14,
 *     closest perigee since 1948) the distance must come out ≈ 356,509 km.
 *   • Libration ranges over years: |l′| reaches 5–8.2°, |b′| 6–7.1°, and
 *     the sub-solar point stays within ±1.7° latitude while its longitude
 *     sweeps a full circle each synodic month (lunar day).
 *   • The eclipse engine reproduces the canonical catalog — dates AND
 *     types: 2024-04-08 total solar, 2025-03-14 + 2025-09-07 total lunar,
 *     2026-08-12 total solar, 2026-08-28 partial lunar, 2027-02-06
 *     annular solar, 2027-08-02 total solar (the Luxor eclipse).
 */

import assert from 'node:assert/strict';
import { REF_PERIGEE_MS } from '../js/moon-interior-model.js';
import {
    moonEcliptic, sunEcliptic, moonPhase, distanceKm, apparentDiameterArcmin,
    subEarthPoint, subSolarPoint,
    SYNODIC_MONTH_DAYS, MEAN_DISTANCE_KM,
    eclipseAtSyzygy, upcomingEclipses,
} from '../js/moon-ephemeris.js';

let passed = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); passed++; };
const near = (a, b, tol, msg) =>
    assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);
const DAY = 86400000;

// ── 1. Meeus 47.a — Moon position, 1992 April 12.0 TD ────────────────────────
{
    const ms = Date.UTC(1992, 3, 12);   // ΔT ≈ 58 s, inside tolerance
    const m = moonEcliptic(ms);
    near(m.lonDeg, 133.1627, 0.02, 'λ (geometric)');
    near(m.latDeg, -3.2291, 0.02, 'β');
    near(m.distKm, 368409.7, 150, 'Δ');
    ok('Meeus 47.a: Moon at 1992-04-12 (λ, β, Δ)');
}

// ── 2. Meeus 25.a — Sun position, 1992 Oct 13.0 TD ───────────────────────────
{
    const s = sunEcliptic(Date.UTC(1992, 9, 13));
    near(s.lonDeg, 199.9099, 0.02, 'solar true longitude');
    near(s.distKm / 149597870.7, 0.99766, 0.0005, 'solar distance (AU)');
    ok('Meeus 25.a: Sun at 1992-10-13');
}

// ── 3. Meeus 48.a — illuminated fraction; phase machinery ────────────────────
{
    const p = moonPhase(Date.UTC(1992, 3, 12));
    near(p.illuminatedFraction, 0.6786, 0.01, 'illuminated fraction 1992-04-12');
    assert.ok(p.waxing, '1992-04-12 was waxing gibbous');
    assert.equal(p.phaseName, 'Waxing Gibbous');
    // Known syzygies: new moon 2026-08-12 ~17:37 UT, full 2026-08-28 ~04:14 UT
    assert.ok(moonPhase(Date.UTC(2026, 7, 12, 17, 37)).illuminatedFraction < 0.01, 'new at the Aug 2026 solar eclipse');
    assert.ok(moonPhase(Date.UTC(2026, 7, 28, 4, 14)).illuminatedFraction > 0.99, 'full at the Aug 2026 lunar eclipse');
    // Age advances through a synodic month
    const a0 = moonPhase(Date.UTC(2026, 0, 5)).ageDays;
    const a1 = moonPhase(Date.UTC(2026, 0, 5) + 5 * DAY).ageDays;
    near((a1 - a0 + SYNODIC_MONTH_DAYS) % SYNODIC_MONTH_DAYS, 5, 0.3, 'age advances ~1 day/day');
    ok('phase: 0.6786 pin, syzygy sanity, age clock');
}

// ── 4. Distance: the interior kernel's own reference perigee ─────────────────
{
    near(distanceKm(REF_PERIGEE_MS), 356509, 400, '2016-11-14 supermoon perigee');
    let min = Infinity, max = 0;
    for (let d = 0; d < 366; d++) {
        const r = distanceKm(Date.UTC(2026, 0, 1) + d * DAY);
        min = Math.min(min, r); max = Math.max(max, r);
    }
    assert.ok(min > 355000 && min < 371000, `yearly min in perigee band (${min.toFixed(0)})`);
    assert.ok(max > 400000 && max < 407500, `yearly max in apogee band (${max.toFixed(0)})`);
    near((min + max) / 2, MEAN_DISTANCE_KM, 6000, 'mean distance');
    // Apparent size: ~29.4–33.5′
    const dMin = apparentDiameterArcmin(Date.UTC(2026, 0, 1));
    assert.ok(dMin > 29 && dMin < 34, `apparent diameter in band (${dMin.toFixed(1)}′)`);
    ok('distance: perigee cross-pin with interior kernel; annual band correct');
}

// ── 5. Meeus 53.a — optical libration; ranges ────────────────────────────────
{
    const se = subEarthPoint(Date.UTC(1992, 3, 12));
    near(se.lonDeg, -1.21, 0.3, 'l′ 1992-04-12 (optical)');
    near(se.latDeg, 4.20, 0.3, 'b′ 1992-04-12 (optical)');
    // Over three years the wobble reaches its full amplitude
    let maxL = 0, maxB = 0;
    for (let d = 0; d < 3 * 366; d++) {
        const p = subEarthPoint(Date.UTC(2025, 0, 1) + d * DAY);
        maxL = Math.max(maxL, Math.abs(p.lonDeg));
        maxB = Math.max(maxB, Math.abs(p.latDeg));
    }
    assert.ok(maxL > 5 && maxL < 8.5, `libration in longitude peaks ~8° (got ${maxL.toFixed(1)})`);
    assert.ok(maxB > 6 && maxB < 7.2, `libration in latitude peaks ~6.9° (got ${maxB.toFixed(1)})`);
    ok(`libration: Meeus 53.a pin; 3-yr peaks l′ ${maxL.toFixed(1)}°, b′ ${maxB.toFixed(1)}°`);
}

// ── 6. Sub-solar point: the lunar day ────────────────────────────────────────
{
    let maxLat = 0;
    let prev = subSolarPoint(Date.UTC(2026, 0, 1)).lonDeg;
    let totalDrift = 0;
    for (let d = 1; d <= 30; d++) {
        const p = subSolarPoint(Date.UTC(2026, 0, 1) + d * DAY);
        maxLat = Math.max(maxLat, Math.abs(p.latDeg));
        let step = p.lonDeg - prev;
        if (step > 180) step -= 360;
        if (step < -180) step += 360;
        totalDrift += step;
        prev = p.lonDeg;
    }
    assert.ok(maxLat < 1.8, `sub-solar latitude within ±1.7° (got ${maxLat.toFixed(2)})`);
    near(Math.abs(totalDrift) / 30, 360 / SYNODIC_MONTH_DAYS, 0.5,
        'sub-solar longitude sweeps 360° per synodic month');
    ok('sub-solar point: near-equatorial, one lap per lunar day');
}

// ── 7. The eclipse engine vs the canonical catalog ───────────────────────────
{
    const utc = (e) => new Date(e.tMs).toISOString().slice(0, 10);
    const list = upcomingEclipses(Date.UTC(2024, 0, 1), 14);
    const find = (dateStr) => list.find(e => Math.abs(e.tMs - Date.parse(dateStr)) < 1.2 * DAY);

    const s2024 = find('2024-04-08T18:17:00Z');
    assert.ok(s2024 && s2024.kind === 'solar' && s2024.type === 'total',
        `2024-04-08 total solar (got ${s2024?.kind}/${s2024?.type} @ ${s2024 && utc(s2024)})`);
    near(Math.abs(s2024.gamma), 0.343, 0.05, '2024-04-08 γ');

    const l2025a = find('2025-03-14T06:59:00Z');
    assert.ok(l2025a && l2025a.kind === 'lunar' && l2025a.type === 'total', '2025-03-14 total lunar');
    near(l2025a.magnitude, 1.18, 0.15, '2025-03-14 umbral magnitude');

    const l2025b = find('2025-09-07T18:12:00Z');
    assert.ok(l2025b && l2025b.kind === 'lunar' && l2025b.type === 'total', '2025-09-07 total lunar');

    const s2026 = find('2026-08-12T17:46:00Z');
    assert.ok(s2026 && s2026.kind === 'solar' && s2026.type === 'total', '2026-08-12 total solar');

    const l2026 = find('2026-08-28T04:13:00Z');
    assert.ok(l2026 && l2026.kind === 'lunar' && l2026.type === 'partial', '2026-08-28 partial lunar');
    assert.ok(l2026.magnitude > 0 && l2026.magnitude < 1, 'partial: umbral magnitude in (0,1)');

    // Timing: greatest eclipse within ~15 min of the catalog (ΔT ignored)
    near(s2026.tMs, Date.parse('2026-08-12T17:46:00Z'), 15 * 60000, '2026-08-12 timing');

    ok('catalog 2024–2026: dates, kinds, types, γ and magnitudes');
}

// ── 8. Upcoming from "today" (the page's calendar view) ──────────────────────
{
    const list = upcomingEclipses(Date.UTC(2026, 7, 2), 6);   // from 2026-08-02
    assert.equal(list.length, 6, 'six entries');
    for (let i = 1; i < list.length; i++) {
        assert.ok(list[i].tMs > list[i - 1].tMs, 'time-ordered');
    }
    const utc = (e) => new Date(e.tMs).toISOString().slice(0, 10);
    // First two are the August 2026 pair; then Feb 2027 season; then Aug 2027
    assert.equal(utc(list[0]), '2026-08-12', 'next: the Aug 2026 total solar');
    assert.equal(list[0].type, 'total');
    assert.equal(utc(list[1]), '2026-08-28', 'then the partial lunar two weeks later');
    const s27 = list.find(e => utc(e).startsWith('2027-02'));
    assert.ok(s27 && s27.kind === 'solar' && s27.type === 'annular', '2027-02-06 annular solar');
    const luxor = list.find(e => utc(e) === '2027-08-02');
    assert.ok(luxor && luxor.kind === 'solar' && luxor.type === 'total', '2027-08-02 total solar (Luxor)');
    // Every entry sits near a node — the geometry lesson the panel teaches
    for (const e of list) assert.ok(e.nodeDistanceDeg < 21.1, 'all eclipses near a node');
    ok(`next six from 2026-08-02: ${list.map(e => `${utc(e)} ${e.type} ${e.kind}`).join('; ')}`);
}

console.log(`\nmoon-ephemeris: ${passed} groups passed`);
