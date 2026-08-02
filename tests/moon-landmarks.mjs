#!/usr/bin/env node
/**
 * moon-landmarks.mjs — gate for js/moon-landmarks-data.js.
 *
 * Run: node tests/moon-landmarks.mjs
 *
 * The load-bearing pins:
 *   • Every landmark has valid coordinates, a known category, a positive
 *     diameter, and a non-empty note; names are unique.
 *   • The far side is genuinely represented (≥ 5 features with |lon| > 90°)
 *     — half the Moon is not an afterthought.
 *   • Reiner Gamma matches CRUSTAL_ANOMALIES in the interior kernel
 *     exactly — the surface swirl and the interior anomaly are the same
 *     physical place, marked by two views.
 *   • South Pole–Aitken is the largest feature; a couple of named spot
 *     checks against IAU values so a fat-fingered coordinate edit trips.
 */

import assert from 'node:assert/strict';
import { LANDMARKS, LANDMARK_CATEGORIES } from '../js/moon-landmarks-data.js';
import { CRUSTAL_ANOMALIES } from '../js/moon-interior-model.js';

let passed = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); passed++; };
const near = (a, b, tol, msg) =>
    assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);

// ── 1. Structural validity ───────────────────────────────────────────────────
{
    const names = new Set();
    for (const l of LANDMARKS) {
        assert.ok(typeof l.name === 'string' && l.name.length > 0, 'name present');
        assert.ok(!names.has(l.name), `duplicate name: ${l.name}`);
        names.add(l.name);
        assert.ok(l.latDeg >= -90 && l.latDeg <= 90, `${l.name} lat in range`);
        assert.ok(l.lonDeg > -180 && l.lonDeg <= 180, `${l.name} lon in range`);
        assert.ok(LANDMARK_CATEGORIES[l.category], `${l.name} category known (${l.category})`);
        assert.ok(l.diameterKm > 0, `${l.name} diameter positive`);
        assert.ok(typeof l.note === 'string' && l.note.length > 10, `${l.name} note tells a story`);
    }
    assert.ok(LANDMARKS.length >= 35, `a real landmark map (${LANDMARKS.length} features)`);
    ok(`${LANDMARKS.length} landmarks, unique names, valid coords/categories/notes`);
}

// ── 2. Category coverage ─────────────────────────────────────────────────────
{
    for (const key of Object.keys(LANDMARK_CATEGORIES)) {
        const n = LANDMARKS.filter(l => l.category === key).length;
        assert.ok(n >= 1, `category ${key} non-empty`);
        assert.ok(typeof LANDMARK_CATEGORIES[key].label === 'string', `${key} has a label`);
        assert.ok(Number.isInteger(LANDMARK_CATEGORIES[key].color), `${key} has a color`);
    }
    assert.ok(LANDMARKS.filter(l => l.category === 'crater').length >= 15, 'a proper crater census');
    assert.ok(LANDMARKS.filter(l => l.category === 'mare').length >= 10, 'the classic maria are all there');
    ok('every category populated; craters and maria in force');
}

// ── 3. The far side is half the Moon ─────────────────────────────────────────
{
    const farside = LANDMARKS.filter(l => Math.abs(l.lonDeg) > 90);
    assert.ok(farside.length >= 5, `farside represented (${farside.length} features)`);
    assert.ok(farside.some(l => l.name === 'Von Kármán'), 'Chang’e-4 site present');
    assert.ok(farside.some(l => l.name === 'South Pole–Aitken basin'), 'SPA present');
    ok(`farside represented: ${farside.map(l => l.name).join(', ')}`);
}

// ── 4. Cross-module pin: Reiner Gamma is ONE place ───────────────────────────
{
    const swirl = LANDMARKS.find(l => l.name === 'Reiner Gamma');
    const anomaly = CRUSTAL_ANOMALIES.find(a => a.name === 'Reiner Gamma');
    assert.ok(swirl && anomaly, 'Reiner Gamma in both modules');
    near(swirl.latDeg, anomaly.latDeg, 1e-9, 'swirl lat = anomaly lat');
    near(swirl.lonDeg, anomaly.lonDeg, 1e-9, 'swirl lon = anomaly lon');
    ok('Reiner Gamma: surface swirl and interior anomaly agree exactly');
}

// ── 5. Spot checks against IAU values ────────────────────────────────────────
{
    // SPA is the largest IMPACT structure (Oceanus Procellarum is a larger
    // surface expanse but not an impact basin — its origin is still debated).
    const spa = LANDMARKS.find(l => l.name === 'South Pole–Aitken basin');
    for (const l of LANDMARKS.filter(l => l.category === 'crater' || l.category === 'basin')) {
        assert.ok(l.diameterKm <= spa.diameterKm, `${l.name} not larger than SPA`);
    }
    const tycho = LANDMARKS.find(l => l.name === 'Tycho');
    near(tycho.latDeg, -43.31, 0.1, 'Tycho lat');
    near(tycho.diameterKm, 85, 3, 'Tycho diameter');
    const cop = LANDMARKS.find(l => l.name === 'Copernicus');
    near(cop.latDeg, 9.62, 0.1, 'Copernicus lat');
    near(cop.lonDeg, -20.08, 0.1, 'Copernicus lon (west-negative)');
    const shack = LANDMARKS.find(l => l.name === 'Shackleton');
    assert.ok(shack.latDeg < -89, 'Shackleton at the south pole');
    ok('IAU spot checks: SPA is king; Tycho/Copernicus/Shackleton where they belong');
}

console.log(`\nmoon-landmarks: ${passed} groups passed`);
