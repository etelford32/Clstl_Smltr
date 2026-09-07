/**
 * tests/sun-post.mjs — pins the pure half of js/sun-post.js (Phase 2)
 *
 *   node tests/sun-post.mjs
 *
 *   • ExposureController: locks L_calib from the first frames (EV stays 0),
 *     then tracks log2(L_calib / L) with the ASYMMETRIC time constants
 *     (brighten τ 1.2 s, darken τ 0.5 s), clamps to [evMin, evMax], ignores
 *     non-finite input, and recalibrates on demand
 *   • bloomMipSizes halves down to the floor and never returns an empty chain
 *   • flareBloomBoost keeps the old tight pass's 0.15 knee
 *
 * The GLSL half is gated by tests/sun-smoke.spec.js (shader-compile errors
 * surface as console errors there) and by the @gpu visual baseline.
 */
import assert from 'node:assert/strict';
import { ExposureController, EXPOSURE_DEFAULTS, bloomMipSizes, flareBloomBoost } from '../js/sun-post.js';

let passed = 0;
function ok(name, fn) { fn(); passed++; console.log(`  ✓ ${name}`); }
console.log('sun-post.mjs');

const LN = Math.log;

ok('calibration: EV is 0 for the first calibFrames samples, then L_calib is the geometric mean of them', () => {
    const c = new ExposureController({ calibFrames: 4 });
    for (const L of [0.10, 0.20, 0.10, 0.20]) { c.step(LN(L), 1 / 60); assert.equal(c.ev, 0); }
    assert.ok(c.calibrated);
    assert.ok(Math.abs(c.calibLum - Math.sqrt(0.10 * 0.20)) < 1e-12, 'geometric mean');
    // Same luminance after calibration → target EV 0, no drift.
    for (let i = 0; i < 100; i++) c.step(LN(c.calibLum), 1 / 60);
    assert.ok(Math.abs(c.ev) < 1e-9);
});

ok('a dark scene brightens toward log2(L_calib/L) with τ = 1.2 s; a bright one darkens with τ = 0.5 s', () => {
    const mk = () => { const c = new ExposureController({ calibFrames: 1 }); c.step(LN(0.2), 1 / 60); return c; };
    // Darker by 4× → target EV +2. After exactly one τ (1.2 s) a first-order system reaches 63.2 %.
    let c = mk();
    for (let t = 0; t < 1.2 - 1e-9; t += 1 / 120) c.step(LN(0.05), 1 / 120);
    assert.ok(Math.abs(c.evTarget - 2) < 1e-9, 'target +2 EV');
    assert.ok(c.ev > 2 * 0.60 && c.ev < 2 * 0.66, `63 % of the way after one τ (got ${(c.ev / 2 * 100).toFixed(1)} %)`);
    // Brighter by 4× → target −2; after 0.5 s (its τ) also ~63 %.
    c = mk();
    for (let t = 0; t < 0.5 - 1e-9; t += 1 / 120) c.step(LN(0.8), 1 / 120);
    assert.ok(Math.abs(c.evTarget + 2) < 1e-9, 'target −2 EV');
    assert.ok(c.ev < -2 * 0.60 && c.ev > -2 * 0.66, `63 % darkened after one τ (got ${(c.ev / -2 * 100).toFixed(1)} %)`);
    // Darkening is faster than brightening for the same elapsed time.
    const a = mk(); const b = mk();
    for (let i = 0; i < 30; i++) { a.step(LN(0.05), 1 / 60); b.step(LN(0.8), 1 / 60); }
    assert.ok(Math.abs(b.ev) > Math.abs(a.ev), 'asymmetric: darken beats brighten');
});

ok('EV clamps to [evMin, evMax] however extreme the scene', () => {
    const c = new ExposureController({ calibFrames: 1 });
    c.step(LN(0.2), 1 / 60);
    for (let i = 0; i < 2000; i++) c.step(LN(1e-6), 1 / 60);
    assert.ok(Math.abs(c.ev - EXPOSURE_DEFAULTS.evMax) < 1e-6, `pinned at evMax (${c.ev})`);
    for (let i = 0; i < 2000; i++) c.step(LN(50), 1 / 60);
    assert.ok(Math.abs(c.ev - EXPOSURE_DEFAULTS.evMin) < 1e-6, `pinned at evMin (${c.ev})`);
    assert.ok(Math.abs(c.exposure - Math.pow(2, EXPOSURE_DEFAULTS.evMin)) < 1e-9);
});

ok('non-finite input is ignored; recalibrate() re-locks and resets EV', () => {
    const c = new ExposureController({ calibFrames: 1 });
    c.step(LN(0.2), 1 / 60);
    for (let i = 0; i < 60; i++) c.step(LN(0.05), 1 / 60);
    const before = c.ev;
    c.step(NaN, 1 / 60); c.step(LN(0.05), NaN);
    assert.equal(c.ev, before);
    c.recalibrate();
    assert.equal(c.ev, 0); assert.equal(c.calibrated, false);
    c.step(LN(0.05), 1 / 60);
    assert.ok(c.calibrated && Math.abs(c.calibLum - 0.05) < 1e-12, 're-locked at the new luminance');
});

ok('bloomMipSizes: halves to the floor, honours maxMips, never empty', () => {
    const s = bloomMipSizes(1280, 720);
    assert.deepEqual(s[0], [640, 360]);
    assert.deepEqual(s[s.length - 1], [20, 11]);
    assert.equal(s.length, 6);
    assert.equal(bloomMipSizes(1280, 720, { maxMips: 3 }).length, 3);
    assert.equal(bloomMipSizes(2560, 1440).length, 6);
    assert.deepEqual(bloomMipSizes(10, 10), [[5, 5]], 'tiny canvas still gets one mip');
});

ok('flareBloomBoost: 0 below the 0.15 knee, linear above', () => {
    assert.equal(flareBloomBoost(0), 0);
    assert.equal(flareBloomBoost(0.1), 0);
    assert.ok(Math.abs(flareBloomBoost(0.15) - 0) < 1e-12);
    assert.ok(Math.abs(flareBloomBoost(1.0) - 0.85 * 1.2) < 1e-12);
    assert.equal(flareBloomBoost(NaN), 0);
});

console.log(`\n${passed} checks passed`);
