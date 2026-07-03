#!/usr/bin/env node
/**
 * weather-diffusion-smoke.mjs
 *
 * Pure-Node smoke test for the horizontal eddy-diffusion operator
 * (applyHorizontalDiffusion in js/weather-flow.js) and its integration
 * into rk2BuildHorizons.
 *
 * Coverage
 *   1. Disabled config is a strict no-op (byte-identical frame).
 *   2. rk2BuildHorizons without the param produces byte-identical output
 *      to an explicit {enabled:false} — backwards compatibility for
 *      wind-advection-rk2-v1.
 *   3. Flux form conserves the cos(lat)-weighted global mean.
 *   4. A hot-spot peak decays monotonically; total variance decreases.
 *   5. Scale selectivity: 2Δx checkerboard noise decays much faster than
 *      a planetary-scale smooth wave (the operator is a noise damper).
 *   6. Polar stability: huge κ + many steps stays finite and bounded
 *      (the per-row rMax clamp holds).
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

const {
    applyHorizontalDiffusion, DEFAULT_HORIZONTAL_DIFFUSION,
    rk2BuildHorizons, latOfRow,
} = await import('../js/weather-flow.js');

const GRID_W = 72, GRID_H = 36, N = GRID_W * GRID_H, NUM_CH = 9;
const CH_T = 0;

let pass = 0, fail = 0;
function check(name, fn) {
    try { fn(); pass++; console.log('  ✓', name); }
    catch (e) { fail++; console.error('  ✗', name, '\n     ', e.message); }
}
const histOf = (...frames) => ({ all: () => frames });

// cos(lat)-weighted global mean of one channel — the invariant the
// flux-form operator must preserve.
function weightedMean(frame, ch) {
    let sum = 0, wsum = 0;
    for (let j = 0; j < GRID_H; j++) {
        const w = Math.cos(latOfRow(j, GRID_H) * Math.PI / 180);
        for (let i = 0; i < GRID_W; i++) {
            sum += w * frame[ch * N + j * GRID_W + i];
            wsum += w;
        }
    }
    return sum / wsum;
}

function variance(frame, ch) {
    let m = 0;
    for (let k = 0; k < N; k++) m += frame[ch * N + k];
    m /= N;
    let v = 0;
    for (let k = 0; k < N; k++) { const d = frame[ch * N + k] - m; v += d * d; }
    return v / N;
}

const mkFrame = (fill) => {
    const f = new Float32Array(N * NUM_CH);
    if (fill) fill(f);
    return f;
};

const ENABLED = { ...DEFAULT_HORIZONTAL_DIFFUSION, enabled: true };

console.log('weather-diffusion-smoke.mjs');
console.log('────────────────────────────');

check('disabled config is a strict no-op', () => {
    const f = mkFrame(fr => { for (let k = 0; k < N * NUM_CH; k++) fr[k] = Math.sin(k * 0.7) * 10; });
    const before = new Float32Array(f);
    applyHorizontalDiffusion(f, N, GRID_W, GRID_H, 6, 1, DEFAULT_HORIZONTAL_DIFFUSION);
    assert.deepEqual(f, before, 'frame mutated despite enabled:false');
});

check('rk2BuildHorizons default === explicit {enabled:false} (back-compat)', () => {
    const coarse = mkFrame(fr => {
        for (let k = 0; k < N; k++) {
            fr[CH_T * N + k] = 10 + 15 * Math.sin(k * 0.13);
            fr[3 * N + k] = 8;          // uniform eastward wind
        }
    });
    const now = 1_750_000_000_000;
    const frame = { t: now, gridW: GRID_W, gridH: GRID_H, coarse };
    const a = rk2BuildHorizons({ history: histOf(frame), modelId: 'a', horizonsH: [6] });
    const b = rk2BuildHorizons({
        history: histOf(frame), modelId: 'b', horizonsH: [6],
        horizontalDiffusion: { ...DEFAULT_HORIZONTAL_DIFFUSION, enabled: false },
    });
    assert.deepEqual(a.frames[6], b.frames[6], 'default param changed rk2 output');
});

check('flux form conserves the weighted global mean', () => {
    const f = mkFrame(fr => {
        for (let j = 0; j < GRID_H; j++)
            for (let i = 0; i < GRID_W; i++)
                fr[CH_T * N + j * GRID_W + i] = 20 * Math.exp(-((i - 30) ** 2 + (j - 18) ** 2) / 12);
    });
    const m0 = weightedMean(f, CH_T);
    applyHorizontalDiffusion(f, N, GRID_W, GRID_H, 24, 1, ENABLED);
    const m1 = weightedMean(f, CH_T);
    assert.ok(Math.abs(m1 - m0) < 1e-3 * Math.max(1, Math.abs(m0)),
        `mean drifted ${m0} → ${m1}`);
});

check('hot spot decays monotonically; variance decreases', () => {
    const f = mkFrame(fr => { fr[CH_T * N + 18 * GRID_W + 30] = 40; });
    let lastPeak = 40, lastVar = variance(f, CH_T);
    for (let s = 0; s < 5; s++) {
        applyHorizontalDiffusion(f, N, GRID_W, GRID_H, 4, 1, ENABLED);
        const peak = f[CH_T * N + 18 * GRID_W + 30];
        const v = variance(f, CH_T);
        assert.ok(peak < lastPeak, `peak did not decay at pass ${s}: ${peak} >= ${lastPeak}`);
        assert.ok(v < lastVar, `variance did not decrease at pass ${s}`);
        assert.ok(peak > 0, 'peak overshot below zero (instability)');
        lastPeak = peak; lastVar = v;
    }
});

check('2Δx checkerboard damps much faster than a planetary wave', () => {
    const noise = mkFrame(fr => {
        for (let j = 0; j < GRID_H; j++)
            for (let i = 0; i < GRID_W; i++)
                fr[CH_T * N + j * GRID_W + i] = ((i + j) % 2 ? 1 : -1) * 5;
    });
    const wave = mkFrame(fr => {
        for (let j = 0; j < GRID_H; j++)
            for (let i = 0; i < GRID_W; i++)
                fr[CH_T * N + j * GRID_W + i] = 5 * Math.sin(2 * Math.PI * i / GRID_W);
    });
    const v0n = variance(noise, CH_T), v0w = variance(wave, CH_T);
    applyHorizontalDiffusion(noise, N, GRID_W, GRID_H, 24, 1, ENABLED);
    applyHorizontalDiffusion(wave, N, GRID_W, GRID_H, 24, 1, ENABLED);
    const rNoise = variance(noise, CH_T) / v0n;
    const rWave = variance(wave, CH_T) / v0w;
    assert.ok(rNoise < 0.5 * rWave,
        `noise retention ${rNoise.toFixed(3)} not ≪ wave retention ${rWave.toFixed(3)}`);
    assert.ok(rWave > 0.9, `planetary wave lost too much energy: ${rWave.toFixed(3)}`);
});

check('polar stability under huge κ (rMax clamp holds)', () => {
    const f = mkFrame(fr => {
        for (let i = 0; i < GRID_W; i++) {
            fr[CH_T * N + i] = (i % 2 ? 30 : -30);                        // south polar row
            fr[CH_T * N + (GRID_H - 1) * GRID_W + i] = (i % 2 ? 30 : -30); // north polar row
        }
    });
    const wild = { enabled: true, rMax: 0.20, kappa: new Array(NUM_CH).fill(1e9) };
    applyHorizontalDiffusion(f, N, GRID_W, GRID_H, 48, 1, wild);
    for (let k = 0; k < N; k++) {
        const v = f[CH_T * N + k];
        assert.ok(Number.isFinite(v), `non-finite value at ${k}`);
        assert.ok(Math.abs(v) <= 30.0001, `value blew past initial bounds: ${v}`);
    }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
