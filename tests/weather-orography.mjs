#!/usr/bin/env node
/**
 * weather-orography.mjs
 *
 * Tests the terrain-forced (orographic) uplift path:
 *   A. buildTerrainGradient — turns a height sampler into per-cell ∇h, with an
 *      ocean mask (sea-level cells get zero slope).
 *   B. makeHeightSamplerFromImageData — equirect pixel → (lat,lon) sampler.
 *   C. WindAdvectionRK2Forecaster + setTerrain — wind blowing UPSLOPE grows
 *      precip + cloud on the windward side; the lee (downslope) side does not,
 *      and a no-terrain control stays dry. microphysicsStatus flips to ON.
 *
 * Exits 0 on pass, non-zero on failure.
 */

import assert from 'node:assert/strict';
import { buildTerrainGradient, makeHeightSamplerFromImageData } from '../js/weather-orography.js';
import { WindAdvectionRK2Forecaster, DEFAULT_CONVERGENCE_GROWTH } from '../js/weather-flow.js';
import { latOfRow, lonOfColumn } from '../js/weather-flow.js';

const NUM_CH = 9, CH_RH = 2, CH_U = 3, CH_V = 4, CH_LOW = 5, CH_PRECIP = 8;

let pass = 0, fail = 0;
function check(name, fn) {
    try { fn(); pass++; console.log('  ✓', name); }
    catch (e) { fail++; console.error('  ✗', name, '\n     ', e.message); }
}

console.log('weather-orography.mjs');
console.log('──────────────────────────────');

const GW = 36, GH = 18;

// A meridional ridge: elevation is a Gaussian in LONGITUDE centred at lon0,
// uniform in latitude — so ∂h/∂x is the only gradient. Land everywhere above
// sea level near the ridge; far flanks fall below sea level (ocean).
const lon0 = 0;
function ridgeSampler(lat, lon) {
    let d = lon - lon0;
    d = ((d + 180) % 360 + 360) % 360 - 180;   // wrap to [-180,180)
    return Math.exp(-(d * d) / (2 * 25 * 25));  // peak 1.0 at lon0, σ=25°
}

check('buildTerrainGradient: windward/lee slope signs are correct', () => {
    const t = buildTerrainGradient({ heightSampler: ridgeSampler, gridW: GW, gridH: GH, seaLevel: 0.05 });
    assert.equal(t.gridW, GW); assert.equal(t.dhdx.length, GW * GH);
    // Column just WEST of the peak → uphill toward east → ∂h/∂x > 0.
    // Column just EAST of the peak → downhill toward east → ∂h/∂x < 0.
    const row = Math.floor(GH / 2);
    const colOf = (lon) => Math.round((lon + 180) / (360 / GW) - 0.5);
    const west = t.dhdx[row * GW + ((colOf(-12) % GW) + GW) % GW];
    const east = t.dhdx[row * GW + ((colOf(+12) % GW) + GW) % GW];
    assert.ok(west > 0, `west flank slopes up to the east, got ${west.toExponential(2)}`);
    assert.ok(east < 0, `east flank slopes down to the east, got ${east.toExponential(2)}`);
});

check('buildTerrainGradient: ocean (below sea level) is masked to zero slope', () => {
    const flatOcean = () => 0.0;
    const t = buildTerrainGradient({ heightSampler: flatOcean, gridW: GW, gridH: GH, seaLevel: 0.18 });
    let maxAbs = 0;
    for (let k = 0; k < GW * GH; k++) maxAbs = Math.max(maxAbs, Math.abs(t.dhdx[k]), Math.abs(t.dhdy[k]));
    assert.equal(maxAbs, 0, 'no slope where everything is at/below sea level');
});

check('buildTerrainGradient: missing sampler returns a zeroed field, no throw', () => {
    const t = buildTerrainGradient({ heightSampler: null, gridW: GW, gridH: GH });
    assert.ok(t.dhdx instanceof Float32Array && t.dhdx.length === GW * GH);
});

check('makeHeightSamplerFromImageData maps lat/lon to the right pixel', () => {
    const W = 4, H = 2;
    const data = new Uint8ClampedArray(W * H * 4);
    // Mark the top-left pixel (90°N, 180°W) red=255 and bottom-right (90°S,~180°E) red=128.
    data[(0 * W + 0) * 4] = 255;
    data[((H - 1) * W + (W - 1)) * 4] = 128;
    const s = makeHeightSamplerFromImageData(data, W, H);
    assert.ok(Math.abs(s(89, -179) - 1.0) < 1e-6, 'NW corner → 255/255');
    assert.ok(Math.abs(s(-89, 179) - 128 / 255) < 1e-6, 'SE corner → 128/255');
});

// ── C. Integration: orographic precip on the windward side ───────────────────
const Nb = GW * GH;
function upslopeFrame(tMs, { uMs = 12, rhPct = 90 } = {}) {
    const c = new Float32Array(Nb * NUM_CH);
    for (let k = 0; k < Nb; k++) { c[CH_U * Nb + k] = uMs; c[CH_RH * Nb + k] = rhPct; }  // moist eastward flow
    return { t: tMs, fetchedAt: tMs, source: 'test', gridW: GW, gridH: GH, coarse: c };
}
const HOUR = 3_600_000;
const frames = [upslopeFrame(-HOUR), upslopeFrame(0)];
const history = { all: () => frames };
const terrain = buildTerrainGradient({ heightSampler: ridgeSampler, gridW: GW, gridH: GH, seaLevel: 0.05 });

const fcNoTerr = new WindAdvectionRK2Forecaster();
const fcTerr   = new WindAdvectionRK2Forecaster();
fcTerr.setTerrain(terrain);
const dNo = fcNoTerr.forecastDense({ history, maxHorizonH: 12 });
const dTe = fcTerr.forecastDense({   history, maxHorizonH: 12 });

const row = Math.floor(GH / 2);
const colOf = (lon) => (((Math.round((lon + 180) / (360 / GW) - 0.5)) % GW) + GW) % GW;
const windwardK = row * GW + colOf(-12);   // west of peak: eastward wind climbs the slope
const leeK      = row * GW + colOf(+12);    // east of peak: eastward wind descends

check('eastward moist flow rains on the windward slope (terrain vs no-terrain)', () => {
    const onW  = dTe.frames[12][CH_PRECIP * Nb + windwardK];
    const offW = dNo.frames[12][CH_PRECIP * Nb + windwardK];
    assert.ok(offW < 1e-6, `flat control makes no orographic rain, got ${offW.toFixed(4)}`);
    assert.ok(onW > 0.05, `windward slope should rain, got ${onW.toFixed(3)}`);
    assert.ok(dTe.frames[12][CH_LOW * Nb + windwardK] > 0.5, 'windward cloud deck also grows');
});

check('the lee (downslope) side stays dry — rain shadow, growth-only', () => {
    const onLee = dTe.frames[12][CH_PRECIP * Nb + leeK];
    assert.ok(onLee < 1e-6, `lee side should not rain from descent, got ${onLee.toFixed(4)}`);
});

check('microphysicsStatus.orographicUplift flips ON once terrain is set', () => {
    assert.equal(fcNoTerr.microphysicsStatus().orographicUplift, false);
    assert.equal(fcTerr.microphysicsStatus().orographicUplift,   true);
});

console.log('──────────────────────────────');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
