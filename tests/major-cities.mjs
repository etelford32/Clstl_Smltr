/**
 * major-cities.mjs — dataset sanity for js/data/major-cities.js
 * ═══════════════════════════════════════════════════════════════
 * The city-marker layer renders this file blind — a malformed row would
 * produce NaN vertex positions (invisible dots that still hit-test) or a
 * mislabelled selection. Checks:
 *
 *   1. shape: every row has n / c / lat / lon / p with sane types+ranges
 *   2. identity: no duplicate name+country pairs
 *   3. geometry: no two cities within 0.15° (accidental double-entry;
 *      deliberately close pairs like Shenzhen↔Hong Kong sit ~0.25° apart)
 *   4. coverage: overall count + every continent bucket is populated
 *
 * Run: node tests/major-cities.mjs
 */

import { MAJOR_CITIES } from '../js/data/major-cities.js';

let checks = 0;
function assert(cond, msg) {
    checks++;
    if (!cond) {
        console.error(`  ✗ ${msg}`);
        process.exitCode = 1;
        return false;
    }
    return true;
}

// 1. Shape
for (const c of MAJOR_CITIES) {
    const tag = `${c.n ?? '??'} (${c.c ?? '??'})`;
    assert(typeof c.n === 'string' && c.n.length >= 2, `${tag}: name`);
    assert(typeof c.c === 'string' && c.c.length >= 2, `${tag}: country`);
    assert(Number.isFinite(c.lat) && c.lat >= -90 && c.lat <= 90, `${tag}: lat ${c.lat}`);
    assert(Number.isFinite(c.lon) && c.lon >= -180 && c.lon <= 180, `${tag}: lon ${c.lon}`);
    assert(Number.isFinite(c.p) && c.p > 0 && c.p < 45, `${tag}: population ${c.p}`);
}
console.log(`  ✓ shape: all ${MAJOR_CITIES.length} rows well-formed`);

// 2. Identity dupes
const seen = new Set();
for (const c of MAJOR_CITIES) {
    const key = `${c.n}|${c.c}`;
    assert(!seen.has(key), `duplicate entry: ${key}`);
    seen.add(key);
}
console.log('  ✓ identity: no duplicate name+country pairs');

// 3. Geometry near-dupes (flat-angle approximation is fine at 0.15°)
const MIN_SEP_DEG = 0.15;
for (let i = 0; i < MAJOR_CITIES.length; i++) {
    for (let j = i + 1; j < MAJOR_CITIES.length; j++) {
        const a = MAJOR_CITIES[i], b = MAJOR_CITIES[j];
        const dLat = a.lat - b.lat;
        const dLon = (a.lon - b.lon) * Math.cos((a.lat + b.lat) / 2 * Math.PI / 180);
        const sep = Math.hypot(dLat, dLon);
        assert(sep >= MIN_SEP_DEG,
            `${a.n} and ${b.n} are ${sep.toFixed(3)}° apart (< ${MIN_SEP_DEG}°) — accidental duplicate?`);
    }
}
console.log('  ✓ geometry: no two cities within 0.15°');

// 4. Coverage
assert(MAJOR_CITIES.length >= 240, `expected ≥ 240 cities, got ${MAJOR_CITIES.length}`);
const buckets = {
    'North America':  c => c.lat > 12 && c.lon < -50,
    'South America':  c => c.lat <= 12 && c.lon < -34 && c.lon > -85,
    'Europe':         c => c.lat > 35 && c.lon >= -25 && c.lon < 45,
    'Africa':         c => c.lat < 35 && c.lat > -35 && c.lon >= -20 && c.lon < 52,
    'Asia':           c => c.lat > 0 && c.lon >= 45 && c.lon < 150,
    'Oceania':        c => c.lat < 0 && c.lon >= 110,
    'high latitude':  c => Math.abs(c.lat) > 60,      // aurora belt coverage
};
for (const [name, pred] of Object.entries(buckets)) {
    const n = MAJOR_CITIES.filter(pred).length;
    assert(n >= 5, `${name}: only ${n} cities`);
    console.log(`  ✓ coverage: ${name} — ${n} cities`);
}

if (process.exitCode) {
    console.error('\nmajor-cities: FAILED');
} else {
    console.log(`\nmajor-cities: ${checks} checks passed (${MAJOR_CITIES.length} cities)`);
}
