#!/usr/bin/env node
/**
 * earth-forecast-integration.mjs
 *
 * End-to-end wiring test for the custom-forecast paint path, using the
 * REAL modules (not stubs) for everything the globe's data path touches:
 *
 *   WeatherHistory → WindAdvectionRK2Forecaster → ForecastPaintProvider
 *                  → WeatherFrameResolver → 'weather-update' event
 *
 * We can't boot earth.html's WebGL globe here (CDN blocked), but the globe
 * only ever consumes the 'weather-update' event's weather/wind/cloud
 * buffers — so dispatching a correct forecast frame through the real
 * resolver is the meaningful integration check short of a visual scrub.
 *
 * Asserts
 *   1. Ticking the resolver at a FUTURE time dispatches a weather-update
 *      flagged isForecast, sourced from the RK2 model (not the ring).
 *   2. The painted buffers are finite and spatially non-trivial.
 *   3. The forecast ADVECTS: a later horizon paints a different field
 *      (the feature has moved) — i.e. it's not a frozen persistence frame.
 *   4. Provider precedence: an Open-Meteo frame sitting in the history
 *      forecast ring does NOT win the future paint (RK2 does).
 *   5. Past/live ticks still use the normal replay/live path (provider
 *      returns null there), so we didn't break replay.
 *
 * Exits 0 on pass, non-zero on failure.
 */

import assert from 'node:assert/strict';

const ROOT = '/home/user/ParkersPhysics';

// ── Stubs: a working event bus + no-IDB so WeatherHistory uses memory ───────
globalThis.indexedDB = {
    open() { const r = {}; queueMicrotask(() => r.onerror?.({ target: { error: new Error('no IDB in node') } })); return r; },
};
globalThis.document = {
    _l: new Map(),
    addEventListener(t, fn) { (this._l.get(t) ?? this._l.set(t, new Set()).get(t)).add(fn); },
    removeEventListener(t, fn) { this._l.get(t)?.delete(fn); },
    dispatchEvent(ev) { for (const fn of [...(this._l.get(ev.type) ?? [])]) fn(ev); return true; },
    hidden: false,
};
globalThis.CustomEvent = class { constructor(type, init = {}) { this.type = type; this.detail = init.detail ?? null; } };

const { WeatherHistory }          = await import(ROOT + '/js/weather-history.js');
const { WeatherFeed }             = await import(ROOT + '/js/weather-feed.js');
const { WeatherFrameResolver }    = await import(ROOT + '/js/weather-frame-resolver.js');
const { WindAdvectionRK2Forecaster } = await import(ROOT + '/js/weather-flow.js');
const { ForecastPaintProvider }   = await import(ROOT + '/js/weather-forecast.js');

const GRID_W = 72, GRID_H = 36, N = GRID_W * GRID_H, NUM_CH = 9, HOUR = 3_600_000;
const CH_T = 0, CH_U = 3, CH_V = 4;

let pass = 0, fail = 0;
function check(name, fn) {
    try { fn(); pass++; console.log('  ✓', name); }
    catch (e) { fail++; console.error('  ✗', name, '\n     ', e.message); }
}

console.log('earth-forecast-integration.mjs');
console.log('──────────────────────────────');

// Build an observation frame: strong eastward wind on a mid-lat row + a hot
// bump, so advection visibly moves the feature east over the horizon.
const jRow = 18, c0 = 20;
function obsFrame(tMs, uMs) {
    const c = new Float32Array(N * NUM_CH);
    for (let k = 0; k < N; k++) {
        c[CH_U * N + k] = uMs;     // eastward
        c[CH_V * N + k] = 0;
        c[CH_T * N + k] = 5;       // background temperature
    }
    c[CH_T * N + (jRow * GRID_W + c0)] = 55;   // hot bump
    return { t: tMs, fetchedAt: tMs, source: 'test:obs', gridW: GRID_W, gridH: GRID_H, coarse: c };
}

const history = new WeatherHistory();
await history.open();
const feed = new WeatherFeed();

// Two observations on the hour grid so the model has a tendency and the
// newest obs ≈ now (inside the resolver's live window, future scrub beyond).
const nowHour = Math.floor(Date.now() / HOUR) * HOUR;
history.ingest(obsFrame(nowHour - HOUR, 90));
history.ingest(obsFrame(nowHour,        90));

// Drop an Open-Meteo-style frame into the forecast ring at +2h with a
// constant, distinctive field — if the provider precedence is wrong, THIS
// is what the resolver would paint instead of the RK2 forecast.
const ringFrame = new Float32Array(N * NUM_CH);
ringFrame.fill(0.123);
history.ingestForecast({ t: nowHour + 2 * HOUR, fetchedAt: Date.now(), source: 'open-meteo:test', gridW: GRID_W, gridH: GRID_H, coarse: ringFrame });

const resolver = new WeatherFrameResolver({ feed, history });
const rk2 = new WindAdvectionRK2Forecaster();
const provider = new ForecastPaintProvider({
    forecaster: rk2, history,
    decode: (coarse, w, h) => feed._decodeCoarse(coarse, w, h),
    maxHorizonH: 24,
});
resolver.setForecastProvider(provider);
provider.refresh();

// Capture dispatched weather-update events (copy buffers — resolver mutates
// scratch in place across ticks).
const updates = [];
document.addEventListener('weather-update', (ev) => {
    const d = ev.detail;
    if (d?.replay === undefined) return;   // ignore non-resolver dispatches
    updates.push({
        meta: d.meta,
        replay: d.replay,
        weather: Float32Array.from(d.weatherBuffer),
    });
});

// 1+2+4) Tick at +2h (well past the 30-min live bypass) → forecast paint.
updates.length = 0;
resolver.tick(nowHour + 2 * HOUR);
check('future tick dispatches a forecast weather-update', () => {
    assert.equal(updates.length, 1, `expected 1 dispatch, got ${updates.length}`);
    assert.equal(updates[0].meta.isForecast, true, 'meta.isForecast');
    assert.equal(updates[0].replay, true, 'detail.replay marker');
});
check('forecast is sourced from the RK2 model, not the Open-Meteo ring frame', () => {
    assert.match(updates[0].meta.source, /wind-advection-rk2-v1/,
        `source should name the model, got "${updates[0].meta.source}"`);
});
check('painted buffer is finite and spatially non-trivial', () => {
    const w = updates[0].weather;
    let min = Infinity, max = -Infinity, allFinite = true;
    for (let k = 0; k < w.length; k += 4) {           // channel 0 (temperature)
        if (!Number.isFinite(w[k])) { allFinite = false; break; }
        if (w[k] < min) min = w[k];
        if (w[k] > max) max = w[k];
    }
    assert.ok(allFinite, 'all temperature samples finite');
    assert.ok(max - min > 0.01, `field has spatial variation (min ${min.toFixed(3)} max ${max.toFixed(3)})`);
    // The constant 0.123 ring frame would decode to a flat field → max-min≈0.
    // A real spread proves we painted the advected RK2 field, not the ring.
});

// 3) Advection: a deeper horizon paints a different field (feature moved).
updates.length = 0;
resolver.invalidate();
resolver.tick(nowHour + 2 * HOUR);
const at2h = updates[updates.length - 1].weather;
resolver.invalidate();
resolver.tick(nowHour + 12 * HOUR);
const at12h = updates[updates.length - 1].weather;
check('forecast advects over the horizon (+2h field ≠ +12h field)', () => {
    let diff = 0;
    for (let k = 0; k < at2h.length; k += 4) diff += Math.abs(at2h[k] - at12h[k]);
    assert.ok(diff > 1.0, `fields should differ as the feature advects, summed Δ=${diff.toFixed(3)}`);
});

// 5) Past/live ticks bypass the provider (replay/live path intact).
updates.length = 0;
resolver.invalidate();
resolver.tick(nowHour - 12 * HOUR);   // 12 h in the past → replay
check('past tick does NOT paint a forecast (provider returns null)', () => {
    assert.ok(updates.length >= 1, 'a dispatch happened');
    const last = updates[updates.length - 1];
    assert.notEqual(last.meta.isForecast, true, 'past frame is not flagged forecast');
});

console.log('──────────────────────────────');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
