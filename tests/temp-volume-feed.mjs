#!/usr/bin/env node
/**
 * temp-volume-feed.mjs
 *
 * Pure-Node smoke test for js/temp-volume-feed.js:
 *   1. pivotLevelResponses turns per-location hourly arrays into per-hour
 *      2×N frames with correct timestamps and cell order.
 *   2. sample() lerps between bracketing hours and clamps at ring ends.
 *   3. Encoding matches the shader contract: value = (T°C + 60) / 110.
 *   4. NaN upstream gaps encode as 0 rather than poisoning the texture.
 *
 * Exits 0 on pass, non-zero on failure.
 */

import assert from 'node:assert/strict';

globalThis.document = {
    _l: new Map(),
    addEventListener(t, fn) { (this._l.get(t) ?? this._l.set(t, new Set()).get(t)).add(fn); },
    removeEventListener(t, fn) { this._l.get(t)?.delete(fn); },
    dispatchEvent(ev) { for (const fn of this._l.get(ev.type) ?? []) fn(ev); },
};
globalThis.CustomEvent = class { constructor(type, init = {}) { this.type = type; this.detail = init.detail ?? null; } };

const { TempVolumeFeed, pivotLevelResponses } = await import('../js/temp-volume-feed.js');

const GRID_N = 72 * 36;
const HOUR = 3_600_000;

let pass = 0, fail = 0;
function check(name, fn) {
    try { fn(); pass++; console.log('  ✓', name); }
    catch (e) { fail++; console.error('  ✗', name, '\n     ', e.message); }
}

// Synthetic merged response: every cell's T850 = cellIndex mod 50 − 20 at
// hour 0, +2 °C at hour 1. T500 = T850 − 25 (a plausible mid-tropo drop).
const T0 = '2026-07-03T00:00';
const T1 = '2026-07-03T01:00';
const mkMerged = () => Array.from({ length: GRID_N }, (_, k) => ({
    hourly: {
        time: [T0, T1],
        temperature_850hPa: [(k % 50) - 20, (k % 50) - 18],
        temperature_500hPa: [(k % 50) - 45, (k % 50) - 43],
    },
}));

console.log('temp-volume-feed.mjs');
console.log('─────────────────────');

check('pivot: per-hour frames with correct t and layout', () => {
    const frames = pivotLevelResponses(mkMerged());
    assert.equal(frames.length, 2);
    assert.equal(frames[0].t, Date.parse(T0 + 'Z'));
    assert.equal(frames[1].t, Date.parse(T1 + 'Z'));
    assert.equal(frames[0].data.length, GRID_N * 2);
    // cell 7: T850 = -13, T500 = -38 at hour 0
    assert.equal(frames[0].data[7], -13);
    assert.equal(frames[0].data[GRID_N + 7], -38);
});

check('sample: midpoint lerp + shader encoding', () => {
    const feed = new TempVolumeFeed();
    feed._frames = pivotLevelResponses(mkMerged());
    const out = new Float32Array(GRID_N * 4);
    const tMid = Date.parse(T0 + 'Z') + HOUR / 2;
    assert.equal(feed.sample(tMid, out), true);
    // cell 7 at midpoint: T850 = -12 → (−12+60)/110
    assert.ok(Math.abs(out[7 * 4] - (-12 + 60) / 110) < 1e-6, `got ${out[7 * 4]}`);
    assert.ok(Math.abs(out[7 * 4 + 1] - (-37 + 60) / 110) < 1e-6);
    assert.equal(out[7 * 4 + 3], 1);
});

check('sample: clamps beyond ring ends', () => {
    const feed = new TempVolumeFeed();
    feed._frames = pivotLevelResponses(mkMerged());
    const out = new Float32Array(GRID_N * 4);
    feed.sample(Date.parse(T1 + 'Z') + 40 * HOUR, out);        // deep future → last frame
    assert.ok(Math.abs(out[7 * 4] - (-11 + 60) / 110) < 1e-6);
    feed.sample(Date.parse(T0 + 'Z') - 40 * HOUR, out);        // deep past → first frame
    assert.ok(Math.abs(out[7 * 4] - (-13 + 60) / 110) < 1e-6);
});

check('sample: empty ring returns false; NaN cells encode as 0', () => {
    const feed = new TempVolumeFeed();
    const out = new Float32Array(GRID_N * 4);
    assert.equal(feed.sample(Date.now(), out), false);

    const merged = mkMerged();
    merged[3].hourly.temperature_850hPa = [NaN, NaN];
    feed._frames = pivotLevelResponses(merged);
    feed.sample(Date.parse(T0 + 'Z'), out);
    assert.equal(out[3 * 4], 0, 'NaN should encode as 0');
    assert.ok(Number.isFinite(out[3 * 4]));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
