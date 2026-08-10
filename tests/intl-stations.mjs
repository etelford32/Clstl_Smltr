/**
 * intl-stations.mjs — gates the pure exports of the two observation-side
 * EarthView layers:
 *
 *   js/intl-stations-layer.js  stationColor   (per-species marker ramps)
 *   js/residual-layer.js       residualColor + residualStrength
 *                              (diverging obs − model ramp)
 *
 * Pinned on purpose:
 *   - station particulates reuse the SHARED EPA stops and station gases
 *     reuse the heatmap's WHO-shaped ramps — a monitor and the model field
 *     behind it are colored on the same scale, so color disagreement on the
 *     globe means SOURCE disagreement, never scale drift
 *   - black carbon (the one species with no CAMS twin) has its own ramp,
 *     green near 1 µg/m³ and red by 8
 *   - the residual ramp is symmetric and diverging: blue when the model
 *     overestimates, red when it underestimates, DIM at zero — agreement is
 *     deliberately quiet so disagreement is the picture — and NaN-safe
 *
 * Run: node tests/intl-stations.mjs
 */

import { stationColor } from '../js/intl-stations-layer.js';
import { residualColor, residualStrength } from '../js/residual-layer.js';
import { heatColor } from '../js/aqi-heatmap-layer.js';
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
const same = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

// ── Station ramps ───────────────────────────────────────────────────────────
{
    assert(same(stationColor('pm25', 40), airQualityMetricColor('pm25', 40)),
        'station PM2.5 reuses the shared EPA stops');
    assert(same(stationColor('pm10', 120), airQualityMetricColor('pm10', 120)),
        'station PM10 reuses the shared EPA stops');
    for (const sp of ['o3', 'no2', 'so2', 'co']) {
        assert(same(stationColor(sp, 55), heatColor(sp, 55)),
            `station ${sp} reuses the heatmap's WHO-shaped ramp`);
    }
    const bcClean = stationColor('bc', 0.8), bcBad = stationColor('bc', 9);
    assert(bcClean[1] > 0.7 && bcClean[0] < 0.3, 'black carbon is green near 1 µg/m³');
    assert(bcBad[0] > 0.9 && bcBad[1] < 0.3, 'black carbon is red by 8–9 µg/m³');
    assert(stationColor('bc', NaN).every(Number.isFinite), 'BC NaN → finite fallback');
    assert(same(stationColor('nonsense', 40), airQualityMetricColor('pm25', 40)),
        'unknown species falls back to the PM2.5 ramp');
}

// ── Residual diverging ramp ─────────────────────────────────────────────────
{
    const under = residualColor(15);    // obs > model — model missed pollution
    const over = residualColor(-15);    // obs < model — model over-predicted
    const zero = residualColor(0);
    assert(under[0] > 0.8 && under[2] < 0.4, 'underestimate is warm/red');
    assert(over[2] > 0.8 && over[0] < 0.4, 'overestimate is cool/blue');
    assert(Math.abs(zero[0] - zero[2]) < 0.15, 'zero residual is near-neutral');
    // Symmetry: +x and −x sit equally far from neutral.
    const dPlus = Math.abs(residualColor(10)[0] - zero[0]);
    const dMinus = Math.abs(residualColor(-10)[2] - zero[2]);
    assert(Math.abs(dPlus - dMinus) < 0.12, 'ramp is symmetric about zero');
    assert(same(residualColor(100), residualColor(20)), 'ramp clamps at saturation');
    assert(residualColor(NaN).every(Number.isFinite), 'NaN residual → finite fallback');

    assert(residualStrength(0) === 0, 'zero residual → zero strength (quiet agreement)');
    assert(residualStrength(10) === 0.5 && residualStrength(-10) === 0.5, 'strength is |residual|/saturation');
    assert(residualStrength(50) === 1, 'strength clamps at 1');
    assert(residualStrength(NaN) === 0, 'NaN residual → zero strength');
}

if (process.exitCode) {
    console.error(`intl-stations: FAILED (${checks} checks)`);
} else {
    console.log(`intl-stations: ${checks} checks passed — station ramps + diverging residual ramp`);
}
