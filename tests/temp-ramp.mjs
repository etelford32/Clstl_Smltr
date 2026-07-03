#!/usr/bin/env node
/**
 * temp-ramp.mjs
 *
 * Pure-Node smoke test for js/temp-ramp.js — the single byte-source behind
 * the surface tint, the 3-D volume, and the wx-panel °C legend:
 *   1. Shape: 256×4 RGBA, opaque.
 *   2. Endpoints reproduce the first/last ramp stops exactly.
 *   3. The 0 °C pivot lands on the pale-cyan freezing stop.
 *   4. Diverging structure: lightness rises monotonically toward the pivot
 *      on the cold arm and falls away from it on the warm arm (the property
 *      that makes equal lightness ≈ equal |T − 0 °C| on the globe).
 *   5. tempToRampFrac maps °C → legend fraction with clamping.
 *   6. Deterministic: repeated builds are byte-identical.
 *
 * Exits 0 on pass, non-zero on failure.
 */

import assert from 'node:assert/strict';

const {
    buildTempLUTPixels, tempToRampFrac, TEMP_RAMP_STOPS, TEMP_LUT_SIZE,
} = await import('../js/temp-ramp.js');

let pass = 0, fail = 0;
function check(name, fn) {
    try { fn(); pass++; console.log('  ✓', name); }
    catch (e) { fail++; console.error('  ✗', name, '\n     ', e.message); }
}
const luma = (px, i) => 0.2126 * px[i * 4] + 0.7152 * px[i * 4 + 1] + 0.0722 * px[i * 4 + 2];

console.log('temp-ramp.mjs');
console.log('──────────────');

const px = buildTempLUTPixels();

check('shape: 256×4 RGBA, fully opaque', () => {
    assert.equal(px.length, TEMP_LUT_SIZE * 4);
    for (let i = 0; i < TEMP_LUT_SIZE; i++) assert.equal(px[i * 4 + 3], 255);
});

check('endpoints reproduce the terminal stops exactly', () => {
    const first = TEMP_RAMP_STOPS[0], last = TEMP_RAMP_STOPS[TEMP_RAMP_STOPS.length - 1];
    assert.deepEqual([px[0], px[1], px[2]], [first[1], first[2], first[3]]);
    const e = (TEMP_LUT_SIZE - 1) * 4;
    assert.deepEqual([px[e], px[e + 1], px[e + 2]], [last[1], last[2], last[3]]);
});

check('0 °C pivot lands on the pale-cyan freezing stop', () => {
    const i0 = Math.round(tempToRampFrac(0) * (TEMP_LUT_SIZE - 1));
    const stop0 = TEMP_RAMP_STOPS.find(s => s[0] === 0);
    for (let c = 0; c < 3; c++) {
        assert.ok(Math.abs(px[i0 * 4 + c] - stop0[1 + c]) <= 3,
            `channel ${c}: ${px[i0 * 4 + c]} vs stop ${stop0[1 + c]}`);
    }
});

check('diverging lightness: rises to the pivot, falls after it', () => {
    const i0 = Math.round(tempToRampFrac(0) * (TEMP_LUT_SIZE - 1));
    const STRIDE = 8;   // coarse monotonicity — rounding makes ±1 jitter normal
    for (let i = 0; i + STRIDE <= i0; i += STRIDE) {
        assert.ok(luma(px, i + STRIDE) > luma(px, i) - 0.5,
            `cold arm not rising at i=${i} (${luma(px, i).toFixed(1)} → ${luma(px, i + STRIDE).toFixed(1)})`);
    }
    // Warm arm: skip the pale-yellow shoulder right at the pivot (the two
    // near-white stops straddle it), then require monotone descent.
    const warmStart = Math.round(tempToRampFrac(10) * (TEMP_LUT_SIZE - 1));
    for (let i = warmStart; i + STRIDE < TEMP_LUT_SIZE; i += STRIDE) {
        assert.ok(luma(px, i + STRIDE) < luma(px, i) + 0.5,
            `warm arm not falling at i=${i}`);
    }
});

check('tempToRampFrac: anchors + clamping', () => {
    assert.equal(tempToRampFrac(-60), 0);
    assert.equal(tempToRampFrac(50), 1);
    assert.ok(Math.abs(tempToRampFrac(0) - 60 / 110) < 1e-9);
    assert.equal(tempToRampFrac(-999), 0);
    assert.equal(tempToRampFrac(999), 1);
});

check('deterministic: repeated builds are byte-identical', () => {
    assert.deepEqual(buildTempLUTPixels(), px);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
