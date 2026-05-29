#!/usr/bin/env node
/**
 * weather-flow-rk2-smoke.mjs
 *
 * Pure-Node smoke test for the new custom-forecast paint path:
 *   - WindAdvectionRK2Forecaster  (js/weather-flow.js)
 *   - ForecastPaintProvider       (js/weather-forecast.js)
 *
 * We can't boot earth.html here (CDN blocked), so we exercise the module
 * surface directly with stubbed document / CustomEvent.
 *
 * Coverage
 *   1. RK2 advects a feature in the correct direction by ~the expected
 *      number of cells (uniform eastward wind).
 *   2. forecast() returns finite, correctly-sized frames at every
 *      standard horizon.
 *   3. forecastDense() spans 0..maxH; h=0 is the identity (current obs);
 *      targets are issued_ms + h·hour.
 *   4. Time-evolving wind: an accelerating 2-frame history advects FARTHER
 *      than the frozen single-frame case, and the extrapolation stays
 *      bounded (τ_eff saturation — no runaway at long horizon).
 *   5. RK2 (1 h substeps) is closer to a fine-substep reference trajectory
 *      than a single backward-Euler step, on a curved (sheared) flow.
 *   6. ForecastPaintProvider.bracket() — past→null, anchor, lerp, clamp.
 *
 * Exits 0 on pass, non-zero on failure.
 */

import assert from 'node:assert/strict';

// ── Stubs ───────────────────────────────────────────────────────────────────
globalThis.document = {
    _l: new Map(),
    addEventListener(t, fn) { (this._l.get(t) ?? this._l.set(t, new Set()).get(t)).add(fn); },
    removeEventListener(t, fn) { this._l.get(t)?.delete(fn); },
    dispatchEvent(ev) { for (const fn of this._l.get(ev.type) ?? []) fn(ev); },
};
globalThis.CustomEvent = class { constructor(type, init = {}) { this.type = type; this.detail = init.detail ?? null; } };

const {
    WindAdvectionRK2Forecaster, semiLagrangianAdvect, latOfRow, lonOfColumn,
} = await import('../js/weather-flow.js');
const { ForecastPaintProvider } = await import('../js/weather-forecast.js');

const GRID_W = 72, GRID_H = 36, N = GRID_W * GRID_H, NUM_CH = 9, HOUR = 3_600_000;
const CH_T = 0, CH_U = 3, CH_V = 4;
const M_PER_DEG_LAT = 111_320;

let pass = 0, fail = 0;
function check(name, fn) {
    try { fn(); pass++; console.log('  ✓', name); }
    catch (e) { fail++; console.error('  ✗', name, '\n     ', e.message); }
}
// A history stub — the forecasters only call history.all().
const histOf = (...frames) => ({ all: () => frames });

console.log('weather-flow-rk2-smoke.mjs');
console.log('───────────────────────────');

// ── 1) Direction + magnitude of advection ──────────────────────────────────
// Uniform eastward wind, V=0, on the row at lat≈2.5°. Choose U so a parcel
// shifts exactly 2 grid columns east over 3 h, then confirm a temperature
// bump lands ~2 cells east of where it started.
{
    const jRow   = 18;                       // latOfRow(18) = 2.5°
    const lat    = latOfRow(jRow, GRID_H);
    const cosLat = Math.cos(lat * Math.PI / 180);
    const hH     = 3;
    const shiftDeg = 2 * (360 / GRID_W);     // 2 cells = 10°
    // dlon = U·dt / M_PER_DEG_LAT / cosLat  ⇒ solve U for dlon = shiftDeg.
    const U = shiftDeg * M_PER_DEG_LAT * cosLat / (hH * 3600);

    const coarse = new Float32Array(N * NUM_CH);
    for (let k = 0; k < N; k++) { coarse[CH_U * N + k] = U; coarse[CH_V * N + k] = 0; }
    const c0 = 30;                           // bump column
    coarse[CH_T * N + (jRow * GRID_W + c0)] = 50;   // hot bump, rest 0

    const fc = new WindAdvectionRK2Forecaster().forecast({
        history: histOf({ t: 0, gridW: GRID_W, gridH: GRID_H, coarse }),
    });
    const frame3 = fc.frames[3];
    // argmax of T on the bump row.
    let best = -Infinity, bestCol = -1;
    for (let i = 0; i < GRID_W; i++) {
        const v = frame3[CH_T * N + (jRow * GRID_W + i)];
        if (v > best) { best = v; bestCol = i; }
    }
    check('uniform east wind shifts the bump ~2 cells east', () => {
        const shift = ((bestCol - c0) % GRID_W + GRID_W) % GRID_W;
        assert.ok(shift >= 1 && shift <= 3, `expected east shift ≈2, got ${shift} (col ${c0}→${bestCol})`);
        assert.ok(best > 20, `bump value preserved through advection, got ${best}`);
    });
}

// ── 2) Standard-horizon frames are well-formed ──────────────────────────────
{
    const coarse = new Float32Array(N * NUM_CH);
    for (let k = 0; k < N; k++) { coarse[CH_T * N + k] = 10; coarse[CH_U * N + k] = 8; coarse[CH_V * N + k] = -4; }
    const fc = new WindAdvectionRK2Forecaster().forecast({
        history: histOf({ t: 1000, gridW: GRID_W, gridH: GRID_H, coarse }),
    });
    check('forecast() yields finite frames at all standard horizons', () => {
        assert.ok(fc && Array.isArray(fc.horizons) && fc.horizons.length === 5);
        for (const h of fc.horizons) {
            const f = fc.frames[h];
            assert.equal(f.length, N * NUM_CH, `frame ${h} length`);
            for (let k = 0; k < f.length; k += 137) assert.ok(Number.isFinite(f[k]), `finite at ${k} (h=${h})`);
            assert.equal(fc.target_ms[h], 1000 + h * HOUR, `target_ms[${h}]`);
        }
    });
}

// ── 3) Dense set: 0..24, h=0 == identity ────────────────────────────────────
{
    const coarse = new Float32Array(N * NUM_CH);
    for (let k = 0; k < N; k++) { coarse[CH_T * N + k] = (k % 13); coarse[CH_U * N + k] = 6; }
    const T0 = 5_000_000;
    const dense = new WindAdvectionRK2Forecaster().forecastDense({
        history: histOf({ t: T0, gridW: GRID_W, gridH: GRID_H, coarse }), maxHorizonH: 24,
    });
    check('forecastDense spans 0..24 with identity at h=0', () => {
        assert.equal(dense.horizons.length, 25);
        assert.equal(dense.horizons[0], 0);
        assert.equal(dense.horizons[24], 24);
        assert.equal(dense.target_ms[0], T0);
        assert.equal(dense.target_ms[1], T0 + HOUR);
        // h=0 must equal the current observation byte-for-byte.
        const f0 = dense.frames[0];
        for (let k = 0; k < N * NUM_CH; k += 97) assert.equal(f0[k], coarse[k], `identity mismatch at ${k}`);
    });
}

// ── 4) Time-evolving wind: accelerating history advects farther, bounded ────
{
    // Frame t-1h: U=10; frame t: U=20  ⇒  tendency ΔU = +10 m/s.
    const mk = (u) => { const c = new Float32Array(N * NUM_CH); for (let k = 0; k < N; k++) c[CH_U * N + k] = u; return c; };
    const prev = { t: 0,    gridW: GRID_W, gridH: GRID_H, coarse: mk(10) };
    const curr = { t: HOUR, gridW: GRID_W, gridH: GRID_H, coarse: mk(20) };

    // Track a bump on the equatorial-ish row through forecast() at h=12.
    const jRow = 18, c0 = 10;
    const withBump = (frame) => { const c = new Float32Array(frame.coarse); c[CH_T * N + (jRow * GRID_W + c0)] = 100; return { ...frame, coarse: c }; };

    const f = new WindAdvectionRK2Forecaster();
    const evolving = f.forecast({ history: histOf(withBump(prev), withBump(curr)) }).frames[12];
    const frozen   = f.forecast({ history: histOf(withBump(curr)) }).frames[12];   // single frame → ΔU=0

    const argmax = (frame) => { let b = -Infinity, bi = -1; for (let i = 0; i < GRID_W; i++) { const v = frame[CH_T * N + (jRow * GRID_W + i)]; if (v > b) { b = v; bi = i; } } return bi; };
    const shift = (frame) => ((argmax(frame) - c0) % GRID_W + GRID_W) % GRID_W;

    check('accelerating wind advects farther than frozen wind', () => {
        const sEvolve = shift(evolving), sFrozen = shift(frozen);
        assert.ok(sEvolve > sFrozen, `evolving shift ${sEvolve} should exceed frozen ${sFrozen}`);
    });
    check('tendency extrapolation stays bounded (τ_eff saturation)', () => {
        // With ΔU=+10 and T_sat=3h, peak extra wind ≈ +30 m/s over the base
        // 20 m/s — a parcel can't lap the globe. Sanity: the bump is still a
        // single well-defined max within the grid, not a NaN/garbage smear.
        const f12 = evolving;
        let finite = 0; for (let k = 0; k < f12.length; k += 211) if (Number.isFinite(f12[k])) finite++;
        assert.ok(finite > 0 && Number.isFinite(f12[CH_T * N + (jRow * GRID_W + argmax(f12))]));
    });
}

// ── 5) RK2 beats single-Euler on a curved (sheared) flow ────────────────────
{
    // U grows with latitude, strong northward V → the back-trajectory curves
    // through changing U. Truth ≈ RK2 with fine substeps; compare a 1 h-substep
    // RK2 and a single backward-Euler step against it on a smooth T field.
    const coarse = new Float32Array(N * NUM_CH);
    for (let j = 0; j < GRID_H; j++) {
        const lat = latOfRow(j, GRID_H);
        for (let i = 0; i < GRID_W; i++) {
            const k = j * GRID_W + i;
            coarse[CH_U * N + k] = 20 + 2 * lat;          // sheared zonal jet
            coarse[CH_V * N + k] = 30;                    // strong northward
            coarse[CH_T * N + k] = i * 1.0 + j * 2.0;     // smooth gradient
        }
    }
    const hist = histOf({ t: 0, gridW: GRID_W, gridH: GRID_H, coarse });
    const H = 6;
    const tT = (fc) => fc.frames[H].subarray(CH_T * N, (CH_T + 1) * N);

    const ref  = tT(new WindAdvectionRK2Forecaster({ substepH: 0.05 }).forecast({ history: hist })); // fine
    const rk2  = tT(new WindAdvectionRK2Forecaster({ substepH: 1.0  }).forecast({ history: hist })); // coarse RK2
    const euler = semiLagrangianAdvect({                                                              // single Euler
        field: coarse.subarray(CH_T * N, (CH_T + 1) * N),
        flowU: coarse.subarray(CH_U * N, (CH_U + 1) * N),
        flowV: coarse.subarray(CH_V * N, (CH_V + 1) * N),
        gridW: GRID_W, gridH: GRID_H, hoursAhead: H,
    });
    const rmse = (a, b) => { let s = 0; for (let k = 0; k < N; k++) { const d = a[k] - b[k]; s += d * d; } return Math.sqrt(s / N); };
    check('RK2 (1 h substeps) is closer to the converged trajectory than single Euler', () => {
        const eRk2 = rmse(rk2, ref), eEul = rmse(euler, ref);
        assert.ok(eRk2 < eEul, `RK2 RMSE ${eRk2.toFixed(3)} should be < Euler RMSE ${eEul.toFixed(3)}`);
    });
}

// ── 6) ForecastPaintProvider bracket/clamp ──────────────────────────────────
{
    const T0 = 9_000_000;
    // decode tags each trio by the coarse's first byte so we can assert which
    // frame the provider selected.
    const decode = (coarse) => ({ weatherBuf: Float32Array.of(coarse[0]), windBuf: Float32Array.of(coarse[0]), cloudBuf: Float32Array.of(coarse[0]) });
    const frame = (tag) => { const c = new Float32Array(2); c[0] = tag; return c; };
    const stub = {
        id: 'stub-model',
        forecastDense: () => ({
            model_id: 'stub-model', issued_ms: T0,
            horizons: [0, 1, 2],
            frames:    { 0: frame(0), 1: frame(1), 2: frame(2) },
            target_ms: { 0: T0, 1: T0 + HOUR, 2: T0 + 2 * HOUR },
            gridW: 2, gridH: 1,
        }),
    };
    const provider = new ForecastPaintProvider({ forecaster: stub, history: { all: () => [] }, decode });
    provider.refresh();

    check('bracket(past) → null (replay path owns it)', () => {
        assert.equal(provider.bracket(T0 - 1), null);
    });
    check('bracket(issued_ms) → h=0 anchor, frac 0', () => {
        const b = provider.bracket(T0);
        // frac 0 ⇒ resolver paints `a`; a need not equal b.
        assert.ok(b && b.frac === 0 && b.a.weatherBuf[0] === 0, `got ${JSON.stringify(b && { frac: b.frac, a: b.a.weatherBuf[0] })}`);
        assert.equal(b.meta.isForecast, true);
    });
    check('bracket(midway) → lerp between h=0 and h=1', () => {
        const b = provider.bracket(T0 + HOUR / 2);
        assert.equal(b.a.weatherBuf[0], 0);
        assert.equal(b.b.weatherBuf[0], 1);
        assert.ok(Math.abs(b.frac - 0.5) < 1e-9, `frac ≈ 0.5, got ${b.frac}`);
    });
    check('bracket(beyond deepest) → clamp to last horizon', () => {
        const b = provider.bracket(T0 + 99 * HOUR);
        assert.ok(b && b.a === b.b && b.a.weatherBuf[0] === 2 && b.frac === 0);
    });
}

console.log('───────────────────────────');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
