#!/usr/bin/env node
/**
 * weather-precip-feedback.mjs
 *
 * Tests the cloud → precipitation feedback added to the RK2 forecaster:
 * over the forecast horizon the precip channel is reconciled with the
 * co-located low/mid cloud deck so rain and cloud stay physically
 * consistent (no rain without a deck; a thick deck seeds light rain).
 *
 *   A. reconcilePrecipWithCloud (pure):
 *      - h ≤ 0 and disabled params are no-ops (live frame untouched)
 *      - suppression: rain under a vanished deck decays, monotonically
 *        deeper with lead time
 *      - heavy rain under a thick deck is preserved
 *      - generation: a thick, dry deck seeds light precip, bounded by genMax
 *   B. WindAdvectionRK2Forecaster.forecastDense (integration):
 *      - the h=0 anchor equals the observation (no feedback at τ=0)
 *      - feedback alters ONLY the precip channel; channels 0..7 are identical
 *        to a feedback-disabled run
 *      - uniform rain under clear sky is suppressed at long horizon
 *
 * Exits 0 on pass, non-zero on failure.
 */

import assert from 'node:assert/strict';
import {
    reconcilePrecipWithCloud,
    DEFAULT_PRECIP_FEEDBACK,
    WindAdvectionRK2Forecaster,
} from '../js/weather-flow.js';

const NUM_CH = 9, CH_LOW = 5, CH_MID = 6, CH_PRECIP = 8;

let pass = 0, fail = 0;
function check(name, fn) {
    try { fn(); pass++; console.log('  ✓', name); }
    catch (e) { fail++; console.error('  ✗', name, '\n     ', e.message); }
}

console.log('weather-precip-feedback.mjs');
console.log('──────────────────────────────');

// ── A. Pure reconcilePrecipWithCloud ────────────────────────────────────────

// One-cell frame helper: deck = max(low,mid)%, precip mm/hr.
function cell(deckPct, precipMm) {
    const f = new Float32Array(1 * NUM_CH);
    f[CH_LOW * 1]    = deckPct;
    f[CH_MID * 1]    = 0;
    f[CH_PRECIP * 1] = precipMm;
    return f;
}

check('h ≤ 0 is a no-op (live anchor untouched)', () => {
    const f = cell(0, 5);
    reconcilePrecipWithCloud(f, 1, 0);
    assert.equal(f[CH_PRECIP], 5);
});

check('disabled params is a no-op', () => {
    const f = cell(0, 5);
    reconcilePrecipWithCloud(f, 1, 24, { ...DEFAULT_PRECIP_FEEDBACK, enabled: false });
    assert.equal(f[CH_PRECIP], 5);
});

check('suppression: rain under a vanished deck decays, deeper with lead time', () => {
    const near = cell(0, 5); reconcilePrecipWithCloud(near, 1, 2,  DEFAULT_PRECIP_FEEDBACK);
    const far  = cell(0, 5); reconcilePrecipWithCloud(far,  1, 24, DEFAULT_PRECIP_FEEDBACK);
    assert.ok(near[CH_PRECIP] < 5,            `2h precip should drop below 5, got ${near[CH_PRECIP].toFixed(3)}`);
    assert.ok(far[CH_PRECIP]  < near[CH_PRECIP], `24h (${far[CH_PRECIP].toFixed(3)}) should be drier than 2h (${near[CH_PRECIP].toFixed(3)})`);
    assert.ok(far[CH_PRECIP]  < 0.3,          `24h precip should be nearly gone, got ${far[CH_PRECIP].toFixed(3)}`);
});

check('heavy rain under a thick deck is preserved', () => {
    const f = cell(90, 10);   // 90% deck, 10 mm/hr
    reconcilePrecipWithCloud(f, 1, 24, DEFAULT_PRECIP_FEEDBACK);
    assert.ok(Math.abs(f[CH_PRECIP] - 10) < 1e-6,
        `gate is fully open at 90% deck → rain intact, got ${f[CH_PRECIP].toFixed(4)}`);
});

check('generation: a thick, dry deck seeds light precip bounded by genMax', () => {
    const near = cell(95, 0); reconcilePrecipWithCloud(near, 1, 2,  DEFAULT_PRECIP_FEEDBACK);
    const far  = cell(95, 0); reconcilePrecipWithCloud(far,  1, 24, DEFAULT_PRECIP_FEEDBACK);
    assert.ok(far[CH_PRECIP] > near[CH_PRECIP], 'generation grows with lead time');
    assert.ok(far[CH_PRECIP] > 0.05,            `should seed some rain, got ${far[CH_PRECIP].toFixed(3)}`);
    assert.ok(far[CH_PRECIP] <= DEFAULT_PRECIP_FEEDBACK.genMax,
        `must never exceed genMax (${DEFAULT_PRECIP_FEEDBACK.genMax}), got ${far[CH_PRECIP].toFixed(3)}`);
});

check('thin deck (below cloudDry) does NOT generate rain', () => {
    const f = cell(15, 0);    // 15% deck — below cloudDry (25%) and genOn (65%)
    reconcilePrecipWithCloud(f, 1, 24, DEFAULT_PRECIP_FEEDBACK);
    assert.equal(f[CH_PRECIP], 0, `clear-ish sky stays dry, got ${f[CH_PRECIP].toFixed(4)}`);
});

// ── B. Integration through forecastDense ─────────────────────────────────────

const GRID_W = 12, GRID_H = 6, N = GRID_W * GRID_H;
function uniformFrame(tMs, { uMs = 40, deckPct = 0, precipMm = 0 } = {}) {
    const c = new Float32Array(N * NUM_CH);
    for (let k = 0; k < N; k++) {
        c[3 * N + k]        = uMs;        // eastward wind
        c[CH_LOW * N + k]   = deckPct;
        c[CH_PRECIP * N + k] = precipMm;
    }
    return { t: tMs, fetchedAt: tMs, source: 'test', gridW: GRID_W, gridH: GRID_H, coarse: c };
}
const HOUR = 3_600_000, now = 0;
// Uniform rain (5 mm/hr) under a clear sky (deck 0). Two frames for tendency.
const histFrames = [
    uniformFrame(now - HOUR, { precipMm: 5, deckPct: 0 }),
    uniformFrame(now,        { precipMm: 5, deckPct: 0 }),
];
const history = { all: () => histFrames };

const fcOn  = new WindAdvectionRK2Forecaster();   // feedback on (default)
const fcOff = new WindAdvectionRK2Forecaster({ precipFeedback: { ...DEFAULT_PRECIP_FEEDBACK, enabled: false } });
const denseOn  = fcOn.forecastDense({ history, maxHorizonH: 24 });
const denseOff = fcOff.forecastDense({ history, maxHorizonH: 24 });

check('h=0 anchor equals the observation (no feedback at τ=0)', () => {
    const f0 = denseOn.frames[0];
    for (let k = 0; k < N; k++) {
        assert.equal(f0[CH_PRECIP * N + k], 5, 'anchor precip is the raw observation');
    }
});

check('feedback alters ONLY the precip channel (0..7 identical to disabled run)', () => {
    const a = denseOn.frames[12], b = denseOff.frames[12];
    for (let ch = 0; ch < 8; ch++) {
        for (let k = 0; k < N; k++) {
            assert.equal(a[ch * N + k], b[ch * N + k], `channel ${ch} cell ${k} must be untouched by feedback`);
        }
    }
    let diff = 0;
    for (let k = 0; k < N; k++) diff += Math.abs(a[CH_PRECIP * N + k] - b[CH_PRECIP * N + k]);
    assert.ok(diff > 1.0, `precip channel must differ between on/off, summed Δ=${diff.toFixed(3)}`);
});

check('uniform rain under clear sky is suppressed at +24h', () => {
    const on  = denseOn.frames[24][CH_PRECIP * N + 0];
    const off = denseOff.frames[24][CH_PRECIP * N + 0];
    assert.ok(Math.abs(off - 5) < 0.5, `disabled keeps the advected 5 mm/hr, got ${off.toFixed(3)}`);
    assert.ok(on < 0.3, `feedback suppresses rain with no deck, got ${on.toFixed(3)}`);
});

console.log('──────────────────────────────');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
