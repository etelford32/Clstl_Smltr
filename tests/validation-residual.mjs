#!/usr/bin/env node
/**
 * validation-residual.mjs — the map-space residual event (Phase 4.3).
 *
 * Feeds WeatherForecastValidator a synthetic forecast fan-out (physics +
 * persistence) and a matching observation ingest, then asserts the
 * 'weather-validation-residual' event carries:
 *   1. the preferred physics model at its shortest verified horizon,
 *   2. correct precip-channel slices for forecast / truth / persistence,
 *   3. no event at all when only persistence verified (a persistence-only
 *      residual map would grade the baseline, not the physics).
 *
 * Runs without IndexedDB (node) — the validator's in-memory pending
 * fallback is the code path under test, same as a private-mode browser.
 *
 * Exits 0 on pass, non-zero on failure.
 */

import assert from 'node:assert/strict';

// ── DOM / storage shims ─────────────────────────────────────────────────────
globalThis.document = {
    _l: new Map(),
    addEventListener(t, fn) { (this._l.get(t) ?? this._l.set(t, new Set()).get(t)).add(fn); },
    removeEventListener(t, fn) { this._l.get(t)?.delete(fn); },
    dispatchEvent(ev) { for (const fn of [...(this._l.get(ev.type) ?? [])]) fn(ev); },
};
globalThis.CustomEvent = class { constructor(type, init = {}) { this.type = type; this.detail = init.detail ?? null; } };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
// No indexedDB → validator.start() falls back to the in-memory queue.

const { WeatherForecastValidator } = await import('../js/weather-forecast-validation.js');
const { NUM_CHANNELS } = await import('../js/weather-forecast.js');

let pass = 0, fail = 0;
function check(name, fn) {
    try { fn(); pass++; console.log('  ✓', name); }
    catch (e) { fail++; console.error('  ✗', name, '\n     ', e.message); }
}
const W = 6, H = 3, N = W * H, CH_PRECIP = 8;

function chwFrame(precipValue) {
    const f = new Float32Array(N * NUM_CHANNELS);
    for (let k = 0; k < N; k++) f[CH_PRECIP * N + k] = precipValue;
    return f;
}
function forecastResult(issued, targets, frames) {
    const horizons = Object.keys(frames).map(Number);
    return { issued_ms: issued, horizons, frames, target_ms: targets, gridW: W, gridH: H };
}
async function pump(validator, results, obsFrame) {
    await validator._onForecast({ detail: { results } });
    await validator._onIngest({ detail: { frame: obsFrame } });
}

console.log('validation-residual.mjs');
console.log('──────────────────────────────');

const T0 = Date.UTC(2026, 6, 13, 0, 0);
const T1 = T0 + 3_600_000;
const T3 = T0 + 3 * 3_600_000;

await (async () => {
    const v = new WeatherForecastValidator({ history: {} });
    await v.start();

    const events = [];
    document.addEventListener('weather-validation-residual', (ev) => events.push(ev.detail));

    // Physics verified at BOTH +1 h and +3 h against one ingest (targets
    // coincide inside the match window only for +1); persistence at +1 too.
    const results = {
        'wind-advection-rk2-v1': forecastResult(T0,
            { 1: T1, 3: T3 }, { 1: chwFrame(2.0), 3: chwFrame(9.0) }),
        'persistence-v1': forecastResult(T0,
            { 1: T1 }, { 1: chwFrame(0.5) }),
    };
    const obs = { t: T1, gridW: W, gridH: H, coarse: chwFrame(1.0) };
    await pump(v, results, obs);

    check('residual event fires once with the physics model at its shortest horizon', () => {
        assert.equal(events.length, 1);
        assert.equal(events[0].model_id, 'wind-advection-rk2-v1');
        assert.equal(events[0].horizon_h, 1);
        assert.equal(events[0].target_ms, T1);
        assert.equal(events[0].verified_ms, T1);
        assert.equal(events[0].gridW, W);
    });

    check('precip slices carry model / truth / persistence values', () => {
        const d = events[0];
        assert.equal(d.forecastPrecip.length, N);
        assert.ok(Math.abs(d.forecastPrecip[4] - 2.0) < 1e-6, 'model 2.0 mm/hr');
        assert.ok(Math.abs(d.truthPrecip[4] - 1.0) < 1e-6, 'observed 1.0 mm/hr');
        assert.ok(Math.abs(d.persistencePrecip[4] - 0.5) < 1e-6, 'persistence 0.5 mm/hr');
    });
})();

await (async () => {
    const v = new WeatherForecastValidator({ history: {} });
    await v.start();
    const events = [];
    document.addEventListener('weather-validation-residual', (ev) => events.push(ev.detail));

    // Persistence-only verification → summary updates but NO residual map.
    const results = {
        'persistence-v1': forecastResult(T0, { 1: T1 }, { 1: chwFrame(0.5) }),
    };
    await pump(v, results, { t: T1, gridW: W, gridH: H, coarse: chwFrame(1.0) });

    check('persistence-only match emits no residual event', () => {
        assert.equal(events.length, 0);
    });
})();

console.log('──────────────────────────────');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
