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
    HEAT_SPECIES, buildHeatSamples, heatColor, heatAlpha, availableSpecies, supportFade, SUPPORT_FULL_KM, SUPPORT_NONE_KM,
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
    { name: 'Delhi', lat: 28.61, lon: 77.21, aqi: 172, pm25: 96, pm10: 180, no2: 44, so2: 12, co: 850, co2: 468, ch4: 1350, dust: 22, ozone: 30, aod: 0.85 },
    { name: 'New York', lat: 40.71, lon: -74.01, aqi: 42, pm25: 9, pm10: 18, no2: 18, so2: 3, co: 250, co2: 432, ch4: 1290, dust: 2, ozone: 60, aod: 0.1 },
    { name: 'NoSpecies', lat: 51.51, lon: -0.13, aqi: 46, pm25: 11, no2: null, co2: null },
    { name: 'BadCoords', lat: NaN, lon: 10, aqi: 80, no2: 30, co2: 450 },
];
const GRID = [
    { lat: 0, lon: -140, aqi: 18, pm25: 4, pm10: 8, aod: 0.04 },
    { lat: 30, lon: 100, aqi: 55, pm25: 16, pm10: 30, aod: 0.2 },
    { lat: -30, lon: 20, aqi: null, pm25: 6 },   // no aqi → dropped from aggregate
];

// ── Species registry shape ──────────────────────────────────────────────────
{
    const ALL = ['aggregate', 'pm25', 'pm10', 'dust', 'aod', 'o3', 'no2', 'so2', 'co', 'co2', 'ch4'];
    assert(Object.keys(HEAT_SPECIES).length === ALL.length, `registry has ${ALL.length} species`);
    for (const key of ALL) {
        const s = HEAT_SPECIES[key];
        assert(s && s.label && s.unit != null, `${key}: registered with label + unit`);
        assert(Array.isArray(s.scale) && s.scale[1] > s.scale[0], `${key}: scale is a rising [lo, hi]`);
        assert(Number.isFinite(s.background), `${key}: has a background value`);
    }
    // Well-mixed greenhouse gases start at their ambient baselines — the
    // signal is urban EXCESS; a zero-based scale would paint the planet.
    assert(HEAT_SPECIES.co2.scale[0] >= 400, 'CO₂ scale starts at the ambient baseline, not zero');
    assert(HEAT_SPECIES.ch4.scale[0] >= 1200, 'CH₄ scale starts at the ambient baseline, not zero');
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

    // Grid-served species merge both feeds; gas species stay city-only.
    const pm = buildHeatSamples(CITIES, GRID, 'pm25');
    assert(pm.length === 6, `PM2.5 merges 3 city + 3 grid samples (got ${pm.length})`);
    const aodS = buildHeatSamples(CITIES, GRID, 'aod');
    assert(aodS.length === 4, `AOD merges 2 city + 2 grid samples (got ${aodS.length})`);
    assert(buildHeatSamples(CITIES, GRID, 'so2').length === 2, 'SO₂ is city-only');
    assert(buildHeatSamples(CITIES, GRID, 'ch4').length === 2, 'CH₄ is city-only');

    // Availability map: served species true, an all-null one false.
    const avail = availableSpecies(CITIES, GRID);
    assert(avail.aggregate && avail.pm25 && avail.so2 && avail.ch4, 'served species read available');
    const noGas = availableSpecies([{ name: 'X', lat: 0, lon: 0, aqi: 40, pm25: 8 }], GRID);
    assert(noGas.aggregate && noGas.pm25 && !noGas.co2 && !noGas.so2, 'all-null species read unavailable');
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

    // PM2.5/PM10/AOD reuse the SHARED EPA stops (not private ramps).
    for (const [sp, v] of [['pm25', 40], ['pm10', 120], ['aod', 0.6]]) {
        const a = heatColor(sp, v), b = airQualityMetricColor(sp, v);
        assert(a[0] === b[0] && a[1] === b[1] && a[2] === b[2], `${sp} reuses the shared EPA stops`);
    }
    // New gas ramps: green at the WHO knee's clean side, red when heavy.
    assert(heatColor('o3', 40)[1] > 0.7 && heatColor('o3', 210)[0] > 0.9, 'O₃ ramp green→red');
    assert(heatColor('so2', 5)[1] > 0.7 && heatColor('so2', 160)[0] > 0.9, 'SO₂ ramp green→red');
    assert(heatColor('co', 200)[1] > 0.7 && heatColor('co', 3200)[0] > 0.9, 'CO ramp green→red');
    assert(heatColor('ch4', 1260)[1] > 0.5 && heatColor('ch4', 1600)[0] > 0.9, 'CH₄ ramp baseline→red');
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


// ── Support fade: the picture must show where it is guessing ───────────────
// The drape is interpolated from ~145 scattered points across the whole
// planet. At uniform opacity a cell on Delhi and a cell 1,800 km out in the
// Pacific look equally authoritative. Opacity now follows support.
{
    assert(supportFade(0) === 1, 'on a sample the field draws at full strength');
    assert(supportFade(SUPPORT_FULL_KM) === 1, 'full strength holds to the support radius');
    assert(supportFade(SUPPORT_NONE_KM) === 0, 'and reaches zero at the cutoff');
    assert(supportFade(Infinity) === 0, 'no sample in range draws nothing at all');
    assert(supportFade(1e9) === 0, 'an absurd distance draws nothing');
    let prev = 1.0001, mono = true;
    for (let d = 0; d <= SUPPORT_NONE_KM + 200; d += 50) {
        const f = supportFade(d);
        if (f > prev + 1e-9 || f < 0 || f > 1) mono = false;
        prev = f;
    }
    assert(mono, 'fade is monotonic and stays within [0, 1]');
    // Linear: opacity is proportional to remaining support, so the midpoint
    // is exactly half. Pinned because an eased curve held ~0.98 out to 850 km
    // and made the fade cosmetic instead of informative.
    const mid = supportFade((SUPPORT_FULL_KM + SUPPORT_NONE_KM) / 2);
    assert(Math.abs(mid - 0.5) < 1e-9, `midpoint fades to half (got ${mid.toFixed(3)})`);
    const quarter = supportFade(SUPPORT_FULL_KM + (SUPPORT_NONE_KM - SUPPORT_FULL_KM) / 4);
    assert(Math.abs(quarter - 0.75) < 1e-9, 'and a quarter of the way out, to 0.75');
    // Just past full support the reduction must already be perceptible.
    assert(supportFade(1000) < 0.8, 'a cell 1,000 km from any sample is clearly faded');
    assert(supportFade(null) === 1, 'absent support data leaves opacity untouched');
    assert(supportFade(undefined) === 1, 'undefined support leaves opacity untouched');
    assert(SUPPORT_FULL_KM < SUPPORT_NONE_KM, 'the two radii are ordered');
}


if (process.exitCode) {
    console.error(`aqi-heatmap: FAILED (${checks} checks)`);
} else {
    console.log(`aqi-heatmap: ${checks} checks passed — species extraction, ramps, density floor`);
}
