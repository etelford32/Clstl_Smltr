#!/usr/bin/env node
/**
 * multilevel-advection-smoke.mjs
 *
 * Pure-Node smoke test for the multi-level advection stack in
 * js/weather-flow.js:
 *   1. thermalWindShear: NH cold-poleward gradient → westerly shear aloft;
 *      SH mirror; equatorial taper → zero; magnitude cap holds.
 *   2. MultiLevelAdvectionForecaster: low cloud rides the 850 flow, mid/high
 *      ride the 500 flow, precip rides the 850/500 mean — with three
 *      orthogonal winds, each feature lands where its own flow carried it.
 *   3. Warming-up honesty: no level provider → null; stale snapshot → null.
 *   4. NaN gap-fill: a hole in the 500 wind is reconstructed via thermal
 *      wind instead of freezing the feature.
 *   5. multilevelLevelsDense: h=0 identity; a T850 blob advects with the
 *      850 wind while T500 stays put under a calm 500 flow.
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
    thermalWindShear, MultiLevelAdvectionForecaster, multilevelLevelsDense,
    fillNaNZonal, latOfRow,
} = await import('../js/weather-flow.js');

const GRID_W = 72, GRID_H = 36, N = GRID_W * GRID_H, NUM_CH = 9, HOUR = 3_600_000;
const CH_T = 0, CH_U = 3, CH_V = 4, CH_LOW = 5, CH_MID = 6, CH_HIGH = 7, CH_PRECIP = 8;
const M_PER_DEG_LAT = 111_320;

let pass = 0, fail = 0;
function check(name, fn) {
    try { fn(); pass++; console.log('  ✓', name); }
    catch (e) { fail++; console.error('  ✗', name, '\n     ', e.message); }
}
const histOf = (...frames) => ({ all: () => frames });
const cellOf = (j, i) => j * GRID_W + i;

// Peak-cell finder for one channel of a frame.
function argmax(frame, ch) {
    let best = -Infinity, bestK = -1;
    for (let k = 0; k < N; k++) {
        const v = frame[ch * N + k];
        if (v > best) { best = v; bestK = k; }
    }
    return { k: bestK, j: Math.floor(bestK / GRID_W), i: bestK % GRID_W, v: best };
}

console.log('multilevel-advection-smoke.mjs');
console.log('────────────────────────────────');

check('thermalWindShear: NH westerly shear, SH mirror, equator tapered, capped', () => {
    // T̄ decreasing poleward in both hemispheres (realistic): T = 30 − 0.5·|lat|
    const t850 = new Float32Array(N), t500 = new Float32Array(N);
    for (let j = 0; j < GRID_H; j++) {
        const lat = latOfRow(j, GRID_H);
        for (let i = 0; i < GRID_W; i++) {
            t850[cellOf(j, i)] = 30 - 0.5 * Math.abs(lat);
            t500[cellOf(j, i)] = 5 - 0.5 * Math.abs(lat);
        }
    }
    const { du, dv } = thermalWindShear(t850, t500, GRID_W, GRID_H);
    // NH mid-latitude (45°N ≈ row 27): ∂T/∂y < 0 → du > 0 (westerly aloft).
    const nh = cellOf(27, 30);
    assert.ok(du[nh] > 0.5, `NH westerly shear expected, got ${du[nh]}`);
    // SH mid-latitude (45°S ≈ row 8): ∂T/∂y > 0, f < 0 → du > 0 as well
    // (westerlies aloft in BOTH hemispheres — the famous symmetry).
    const sh = cellOf(8, 30);
    assert.ok(du[sh] > 0.5, `SH westerly shear expected, got ${du[sh]}`);
    // Equatorial band (row 17/18, |lat| < 5°): tapered to zero.
    assert.equal(du[cellOf(17, 10)], 0);
    // Cap: everything within ±60 m/s.
    for (let k = 0; k < N; k++) assert.ok(Math.abs(du[k]) <= 60 && Math.abs(dv[k]) <= 60);
});

// ── Shared fixture: three orthogonal flows ──────────────────────────────────
// Surface wind: 8 m/s eastward. 850 wind: 16 m/s northward. 500 wind: 16 m/s
// westward (strong enough that 12 h of drift exceeds one 5° cell, so argmax
// moves unambiguously). Blobs for low/mid/high cloud + precip all start at
// the same cell; after 12 h each should have moved with ITS flow, not the
// others'. The direction check runs with the microphysics source terms
// DISABLED — the cloud→precip reconcile intentionally drags rain toward the
// advected deck (verified in weather-precip-feedback.mjs), which would
// contaminate a pure-transport assertion.
const START_J = 14, START_I = 30;   // ~17.5°S — off the equator, away from poles
const mkObsFrame = (t) => {
    const c = new Float32Array(N * NUM_CH);
    for (let k = 0; k < N; k++) {
        c[CH_T * N + k] = 10;
        c[1 * N + k]    = 1013;
        c[2 * N + k]    = 50;
        c[CH_U * N + k] = 8;        // surface: eastward
        c[CH_V * N + k] = 0;
    }
    const k0 = cellOf(START_J, START_I);
    c[CH_LOW    * N + k0] = 90;
    c[CH_MID    * N + k0] = 90;
    c[CH_HIGH   * N + k0] = 90;
    c[CH_PRECIP * N + k0] = 6;
    c[CH_T      * N + k0] = 25;     // surface-T blob rides the surface flow
    return { t, gridW: GRID_W, gridH: GRID_H, coarse: c };
};
const mkLevels = (t) => {
    const f = (v) => { const a = new Float32Array(N); a.fill(v); return a; };
    return {
        t, gridW: GRID_W, gridH: GRID_H,
        t850: f(5), t500: f(-20),
        u850: f(0), v850: f(16),     // 850: northward
        u500: f(-16), v500: f(0),    // 500: westward
        tendU850: null, tendV850: null, tendU500: null, tendV500: null,
    };
};
const NOW = 1_750_000_000_000;
const NO_MICROPHYSICS = {
    precipFeedback:    { enabled: false },
    convergenceGrowth: { enabled: false },
};

check('each channel rides its own steering flow (pure transport)', () => {
    const fc = new MultiLevelAdvectionForecaster({
        levelWinds: () => mkLevels(NOW), ...NO_MICROPHYSICS,
    });
    const res = fc.forecast({ history: histOf(mkObsFrame(NOW)) });
    assert.ok(res, 'forecast should produce with levels available');
    assert.equal(res.model_id, 'multilevel-advection-v1');
    const fr = res.frames[12];

    const low  = argmax(fr, CH_LOW);
    const mid  = argmax(fr, CH_MID);
    const high = argmax(fr, CH_HIGH);
    const pr   = argmax(fr, CH_PRECIP);
    const tsfc = argmax(fr, CH_T);

    // Low cloud (850 flow, 16 m/s north ≈ 1.24 cells/12 h): higher row, same column.
    assert.ok(low.j > START_J, `low cloud should move north (rows ${low.j} vs ${START_J})`);
    assert.equal(low.i, START_I, 'low cloud should not move zonally');
    // Mid + high cloud (500 flow, 16 m/s west ≈ 1.3 cells): lower column, same row.
    assert.ok(mid.i < START_I, `mid cloud should move west (cols ${mid.i} vs ${START_I})`);
    assert.equal(mid.j, START_J, 'mid cloud should not move meridionally');
    assert.equal(high.i, mid.i, 'high cloud rides the same 500 flow as mid');
    // Precip (850/500 mean = 8 m/s NW): both axes drift.
    assert.ok(pr.i < START_I && pr.j > START_J,
        `precip should move NW (got ${pr.i},${pr.j} from ${START_I},${START_J})`);
    // Surface T blob (surface flow, 8 m/s east): higher column, same row.
    assert.ok(tsfc.i > START_I, `surface T should move east (cols ${tsfc.i} vs ${START_I})`);
    assert.equal(tsfc.j, START_J, 'surface T should not move meridionally');
});

check('warming-up honesty: no provider → null; stale levels → null', () => {
    const fcNone = new MultiLevelAdvectionForecaster({});
    assert.equal(fcNone.forecast({ history: histOf(mkObsFrame(NOW)) }), null);

    const fcStale = new MultiLevelAdvectionForecaster({
        levelWinds: () => mkLevels(NOW - 10 * HOUR),   // 10 h old > 6 h guard
    });
    assert.equal(fcStale.forecast({ history: histOf(mkObsFrame(NOW)) }), null);
});

check('NaN hole in the 500 wind gap-fills via thermal wind (finite output)', () => {
    const lv = mkLevels(NOW);
    // Put a realistic meridional T gradient in so the shear is non-trivial,
    // and knock a hole in the 500 wind over the blob.
    for (let j = 0; j < GRID_H; j++) {
        const lat = latOfRow(j, GRID_H);
        for (let i = 0; i < GRID_W; i++) {
            lv.t850[cellOf(j, i)] = 20 - 0.4 * Math.abs(lat);
            lv.t500[cellOf(j, i)] = -5 - 0.4 * Math.abs(lat);
        }
    }
    for (let dj = -2; dj <= 2; dj++) {
        for (let di = -2; di <= 2; di++) {
            const k = cellOf(START_J + dj, START_I + di);
            lv.u500[k] = NaN; lv.v500[k] = NaN;
        }
    }
    const fc = new MultiLevelAdvectionForecaster({ levelWinds: () => lv });
    const res = fc.forecast({ history: histOf(mkObsFrame(NOW)) });
    assert.ok(res, 'forecast should still produce');
    assert.ok(res._meta.level_gap_cells >= 25, 'gap cells should be reported');
    const fr = res.frames[6];
    for (let k = 0; k < N; k++) {
        assert.ok(Number.isFinite(fr[CH_MID * N + k]), `NaN leaked into mid cloud at ${k}`);
    }
    // The mid-cloud peak must still exist somewhere (mass not zeroed out).
    assert.ok(argmax(fr, CH_MID).v > 20, 'mid cloud feature should survive the gap');
});

check('multilevelLevelsDense: h=0 identity; T850 blob rides 850 wind only', () => {
    const t850 = new Float32Array(N); t850.fill(5);
    const t500 = new Float32Array(N); t500.fill(-20);
    const k0 = cellOf(START_J, START_I);
    t850[k0] = 30;                       // warm blob at 850 only
    t500[k0] = -5;                       // and a marker at 500
    const zero = new Float32Array(N);
    const east = new Float32Array(N); east.fill(10);   // 850 wind: eastward 10 m/s

    const dense = multilevelLevelsDense({
        issuedMs: NOW, gridW: GRID_W, gridH: GRID_H,
        t850, t500,
        u850: east, v850: zero,          // 850 flows east
        u500: zero, v500: zero,          // 500 calm
        maxHorizonH: 12,
    });
    assert.ok(dense && dense.frames.length === 13);
    assert.equal(dense.frames[0].target_ms, NOW);
    assert.equal(dense.frames[0].t850[k0], 30, 'h=0 is the identity');

    // 10 m/s × 12 h = 432 km ≈ 3.9° ≈ 0.78 cells at 17.5°S… the blob peak
    // moves east by ~1 cell (bilinear splits it — check drift direction).
    const f12 = dense.frames[12];
    let bestK = 0, best = -Infinity;
    for (let k = 0; k < N; k++) if (f12.t850[k] > best) { best = f12.t850[k]; bestK = k; }
    assert.ok((bestK % GRID_W) >= START_I, 't850 blob should drift east (or split toward east)');
    assert.ok(f12.t850[cellOf(START_J, START_I + 1)] > 6,
        'eastward neighbour should have gained warmth');
    // 500 marker under a calm flow: unchanged (modulo nothing — no diffusion).
    assert.equal(f12.t500[k0], -5, '500 level should not move under calm wind');
});

check('fillNaNZonal: row-mean fill, passthrough when finite', () => {
    const field = new Float32Array(N);
    for (let j = 0; j < GRID_H; j++) {
        for (let i = 0; i < GRID_W; i++) field[cellOf(j, i)] = j * 2;   // per-row constant
    }
    // Finite field passes through by reference (copy-on-write contract).
    assert.equal(fillNaNZonal(field, GRID_W, GRID_H), field);

    field[cellOf(10, 5)] = NaN;
    field[cellOf(10, 6)] = NaN;
    const filled = fillNaNZonal(field, GRID_W, GRID_H);
    assert.notEqual(filled, field, 'NaN input returns a copy');
    assert.equal(filled[cellOf(10, 5)], 20, 'hole gets the zonal mean');
    assert.ok(Number.isNaN(field[cellOf(10, 5)]), 'input untouched');
    for (let k = 0; k < N; k++) assert.ok(Number.isFinite(filled[k]));
});

check('multilevelLevelsDense: NaN temperature holes stay finite through advection', () => {
    const t850 = new Float32Array(N); t850.fill(5);
    const t500 = new Float32Array(N); t500.fill(-20);
    for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
            t850[cellOf(START_J + dj, START_I + di)] = NaN;   // 3×3 upstream gap
        }
    }
    const zero = new Float32Array(N);
    const east = new Float32Array(N); east.fill(10);
    const dense = multilevelLevelsDense({
        issuedMs: NOW, gridW: GRID_W, gridH: GRID_H,
        t850, t500, u850: east, v850: zero, u500: zero, v500: zero,
        maxHorizonH: 6,
    });
    for (const f of dense.frames) {
        for (let k = 0; k < N; k++) {
            assert.ok(Number.isFinite(f.t850[k]), `NaN leaked at h=${f.h} k=${k}`);
        }
    }
    // The hole should read as its surroundings (zonal mean = 5), not deep cold.
    assert.ok(Math.abs(dense.frames[0].t850[cellOf(START_J, START_I)] - 5) < 0.5,
        'gap fills toward the zonal mean, not −60 °C');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
