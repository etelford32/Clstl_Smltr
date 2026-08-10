/**
 * aqi-heatmap.mjs — gates the pure half of js/aqi-heatmap-layer.js (the
 * EarthView pollution-density heatmap): species sample extraction, color
 * ramps, and the density-floor alpha curve. Rendering (canvas/shader) is
 * covered by the browser gate tests/earth-aqi-heatmap.spec.js.
 *
 * Pinned on purpose:
 *   - the AGGREGATE view reuses the shared EPA stops (airQualityMetricColor)
 *     so the heatmap can never disagree with the numeric AQI layer, the
 *     pollution rings, or the Pollution Lab about what "unhealthy" looks like
 *   - CO₂/NO₂ are CITY-ONLY species (the sparse CAMS grid frame carries no
 *     greenhouse-gas fields) and an unserved species yields ZERO samples —
 *     that emptiness is the layer's honest "not available" signal
 *   - the alpha curve is exactly zero at/below the floor (the density-floor
 *     slider must actually cut, not merely dim) and saturates at the ceiling
 *
 * Run: node tests/aqi-heatmap.mjs
 */

import {
    HEAT_SPECIES, buildHeatSamples, heatColor, heatAlpha,
} from '../js/aqi-heatmap-layer.js';
import { airQualityMetricColor } from '../js/air-quality-frame.js';

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
const near = (a, b, tol, msg) => assert(Math.abs(a - b) <= tol, `${msg} (got ${a}, want ${b}±${tol})`);

const CITIES = [
    { name: 'Delhi', lat: 28.61, lon: 77.21, aqi: 172, pm25: 96, no2: 44, co2: 468 },
    { name: 'New York', lat: 40.71, lon: -74.01, aqi: 42, pm25: 9, no2: 18, co2: 432 },
    { name: 'NoSpecies', lat: 51.51, lon: -0.13, aqi: 46, pm25: 11, no2: null, co2: null },
    { name: 'BadCoords', lat: NaN, lon: 10, aqi: 80, no2: 30, co2: 450 },
];
const GRID = [
    { lat: 0, lon: -140, aqi: 18, pm25: 4 },
    { lat: 30, lon: 100, aqi: 55, pm25: 16 },
    { lat: -30, lon: 20, aqi: null, pm25: 6 },   // no aqi → dropped from aggregate
];

// ── Species registry shape ──────────────────────────────────────────────────
{
    for (const key of ['aggregate', 'co2', 'no2']) {
        const s = HEAT_SPECIES[key];
        assert(s && s.label && s.unit != null, `${key}: registered with label + unit`);
        assert(Array.isArray(s.scale) && s.scale[1] > s.scale[0], `${key}: scale is a rising [lo, hi]`);
        assert(Number.isFinite(s.background), `${key}: has a background value`);
    }
    // CO₂'s floor starts at the well-mixed ambient baseline — its signal is
    // the urban EXCESS, so a zero-based scale would paint the whole planet.
    assert(HEAT_SPECIES.co2.scale[0] >= 400, 'CO₂ scale starts at the ambient baseline, not zero');
}

// ── Sample extraction ───────────────────────────────────────────────────────
{
    const agg = buildHeatSamples(CITIES, GRID, 'aggregate');
    assert(agg.length === 5, `aggregate = 3 valid cities + 2 valid grid cells (got ${agg.length})`);
    assert(agg.some(s => s.value === 172) && agg.some(s => s.value === 18), 'aggregate merges city AQI and grid AQI');

    const co2 = buildHeatSamples(CITIES, GRID, 'co2');
    assert(co2.length === 2, `CO₂ is city-only and skips null rows (got ${co2.length})`);
    assert(co2.every(s => s.value >= 400), 'CO₂ samples carry ppm values');

    const no2 = buildHeatSamples(CITIES, GRID, 'no2');
    assert(no2.length === 2, `NO₂ is city-only and skips null rows (got ${no2.length})`);

    assert(buildHeatSamples([], [], 'co2').length === 0, 'no cities → no CO₂ samples (honest emptiness)');
    assert(buildHeatSamples(CITIES, GRID, 'nonsense').length === 5, 'unknown species falls back to aggregate');
}

// ── Color ramps ─────────────────────────────────────────────────────────────
{
    // Aggregate must be EXACTLY the shared EPA stops.
    for (const v of [30, 80, 130, 180, 250, 400]) {
        const a = heatColor('aggregate', v);
        const b = airQualityMetricColor('aqi', v);
        assert(a[0] === b[0] && a[1] === b[1] && a[2] === b[2],
            `aggregate ramp matches shared EPA stops at AQI ${v}`);
    }
    // CO₂: cool→warm across the working range, then into purple at the top
    // (blue rises) — same "beyond red" convention as the EPA stops.
    const c1 = heatColor('co2', 425), c2 = heatColor('co2', 460), c3 = heatColor('co2', 512);
    assert(c1[0] < c2[0], 'CO₂ ramp warms with concentration (red rises)');
    assert(c1[1] > c3[1], 'CO₂ ramp warms with concentration (green falls)');
    assert(c3[2] > c2[2], 'CO₂ ramp tops out toward purple (blue rises past red)');
    // NO₂: green at the WHO annual guideline, red well above the daily one.
    const n1 = heatColor('no2', 5), n2 = heatColor('no2', 120);
    assert(n1[1] > 0.7 && n1[0] < 0.3, 'NO₂ is green at the WHO annual guideline');
    assert(n2[0] > 0.9 && n2[1] < 0.3, 'NO₂ is red at heavy pollution');
    // NaN → the shared no-data gray, never NaN channels.
    const nan = heatColor('co2', NaN);
    assert(nan.every(Number.isFinite), 'NaN value → finite fallback color');
}

// ── Density-floor alpha ─────────────────────────────────────────────────────
{
    near(heatAlpha(50, 50, 300), 0, 1e-12, 'alpha is exactly zero AT the floor');
    near(heatAlpha(20, 50, 300), 0, 1e-12, 'alpha is exactly zero below the floor');
    near(heatAlpha(300, 50, 300), 1, 1e-12, 'alpha saturates at the ceiling');
    near(heatAlpha(1000, 50, 300), 1, 1e-12, 'alpha clamps above the ceiling');
    const a1 = heatAlpha(100, 50, 300), a2 = heatAlpha(200, 50, 300);
    assert(a1 > 0 && a2 > a1, 'alpha is monotone between floor and ceiling');
    near(heatAlpha(NaN, 50, 300), 0, 1e-12, 'NaN value → transparent');
    near(heatAlpha(100, 300, 300), 0, 1e-12, 'degenerate floor≥ceil → transparent');
}

if (process.exitCode) {
    console.error(`aqi-heatmap: FAILED (${checks} checks)`);
} else {
    console.log(`aqi-heatmap: ${checks} checks passed — species extraction, ramps, density floor`);
}
