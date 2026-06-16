#!/usr/bin/env node
/**
 * weather-patch.mjs
 *
 * Tests the pure helpers behind the high-res focus window
 * (js/weather-patch.js) and the footprint geometry that drives it
 * (js/focus-footprint.js):
 *
 *   - patchGridFromFootprint: activation gate, step snapping, lattice
 *     alignment, footprint coverage
 *   - extractPatchCoarse: channel layout, meteorological U/V
 *     decomposition, clamped (non-periodic) NaN fill
 *   - packPatchTrio: normalisation in lockstep with weather-feed.js
 *     _decodeCoarse, clamping
 *   - FocusFootprint: sub-camera point in a rotated earth frame,
 *     horizon clamp far out, frustum-driven span when zoomed in
 *
 * Exits 0 on pass, non-zero on failure.
 */

import assert from 'node:assert/strict';

// ── Minimal DOM shim (module dispatches CustomEvents on document) ──────────
globalThis.document = {
    _listeners: new Map(),
    addEventListener(type, fn) {
        const set = this._listeners.get(type) ?? new Set();
        set.add(fn);
        this._listeners.set(type, set);
    },
    removeEventListener(type, fn) {
        this._listeners.get(type)?.delete(fn);
    },
    dispatchEvent(ev) {
        const set = this._listeners.get(ev.type);
        if (!set) return;
        for (const fn of set) fn(ev);
    },
    hidden: false,
};
globalThis.CustomEvent = class CustomEvent {
    constructor(type, init = {}) {
        this.type   = type;
        this.detail = init.detail ?? null;
    }
};

const { extractPatchCoarse, packPatchTrio, patchGridFromFootprint,
        ACTIVATE_SPAN_DEG, NUM_CHANNELS } =
    await import('../js/weather-patch.js');
const { MAX_WIND_MS } = await import('../js/weather-feed.js');
const { FocusFootprint } = await import('../js/focus-footprint.js');

let pass = 0, fail = 0;
function check(name, fn) {
    try { fn(); pass++; console.log('  ✓', name); }
    catch (e) { fail++; console.error('  ✗', name, '\n     ', e.message); }
}

console.log('weather-patch.mjs');
console.log('──────────────────────────────');

// ── patchGridFromFootprint ──────────────────────────────────────────────────

check('wide footprint (global view) → null', () => {
    assert.equal(patchGridFromFootprint({
        spanLatDeg: ACTIVATE_SPAN_DEG + 1, spanLonDeg: 60,
        latMin: -30, lonMin: -30,
    }), null);
    assert.equal(patchGridFromFootprint(null), null);
});

check('zoomed footprint → snapped grid covering the footprint', () => {
    const fp = { spanLatDeg: 16, spanLonDeg: 20, latMin: 37.3, lonMin: -109.7 };
    const g = patchGridFromFootprint(fp);
    assert.ok(g, 'grid expected');
    assert.ok([0.25, 0.5, 1.0].includes(g.step), `step ${g.step} not snapped`);
    assert.ok(g.w <= 64 && g.h <= 64, 'cell budget exceeded');
    // South-west corner sits on the step lattice
    assert.ok(Math.abs(g.latMin / g.step - Math.round(g.latMin / g.step)) < 1e-9);
    assert.ok(Math.abs(g.lonMin / g.step - Math.round(g.lonMin / g.step)) < 1e-9);
    // Spans cover at least the footprint (minus the snap-down of the corner)
    assert.ok(g.latSpan >= fp.spanLatDeg - g.step, 'lat coverage');
    assert.ok(g.lonSpan >= fp.spanLonDeg - g.step, 'lon coverage');
});

check('tight footprint reaches the 0.25° floor', () => {
    const g = patchGridFromFootprint({
        spanLatDeg: 4, spanLonDeg: 5, latMin: 40, lonMin: -105,
    });
    assert.equal(g.step, 0.25);
});

// ── extractPatchCoarse ──────────────────────────────────────────────────────

function mkRows(n, current) {
    return Array.from({ length: n }, (_, i) => ({ current: current(i) }));
}

check('channel layout + U/V decomposition (wind FROM north → V < 0)', () => {
    const w = 4, h = 3, N = w * h;
    const rows = mkRows(N, () => ({
        temperature_2m: 10, surface_pressure: 1000, relative_humidity_2m: 50,
        wind_speed_10m: 8, wind_direction_10m: 0,        // from due north
        cloud_cover_low: 20, cloud_cover_mid: 30, cloud_cover_high: 40,
        precipitation: 1.5,
    }));
    const c = extractPatchCoarse(rows, w, h);
    assert.equal(c.length, N * NUM_CHANNELS);
    assert.equal(c[0 * N], 10);          // T
    assert.equal(c[1 * N], 1000);        // P
    assert.equal(c[2 * N], 50);          // RH
    assert.ok(Math.abs(c[3 * N]) < 1e-6, 'U ≈ 0 for northerly');
    assert.ok(Math.abs(c[4 * N] + 8) < 1e-6, 'V = −8 for 8 m/s from north');
    assert.equal(c[5 * N], 20);
    assert.equal(c[8 * N], 1.5);
});

check('NaN gaps fill from nearest neighbour without longitude wrap', () => {
    const w = 4, h = 2, N = w * h;
    const rows = mkRows(N, (i) => ({
        // West edge cell (i=0) missing temperature; the wrap-free fill must
        // borrow from its EAST neighbour (25), not the far row end.
        temperature_2m: i === 0 ? null : (i === 1 ? 25 : 99),
        surface_pressure: 1000, relative_humidity_2m: 50,
        wind_speed_10m: 0, wind_direction_10m: 0,
    }));
    const c = extractPatchCoarse(rows, w, h);
    assert.equal(c[0], 25);
});

// ── packPatchTrio ───────────────────────────────────────────────────────────

check('normalisation matches the global decode pipeline', () => {
    const w = 2, h = 1, N = w * h;
    const coarse = new Float32Array(N * NUM_CHANNELS);
    coarse[0 * N] = -5;       // T °C
    coarse[1 * N] = 955;      // P hPa
    coarse[2 * N] = 80;       // RH %
    coarse[3 * N] = 3;        // U
    coarse[4 * N] = 4;        // V  → speed 5
    coarse[5 * N] = 50;       // cloud low %
    coarse[8 * N] = 2;        // precip mm/hr
    const { weatherRGBA, cloudRGBA } = packPatchTrio(coarse, w, h);
    assert.ok(Math.abs(weatherRGBA[0] - (-5 + 60) / 110) < 1e-6, 'T norm');
    assert.ok(Math.abs(weatherRGBA[1] - (955 - 850) / 210) < 1e-6, 'P norm');
    assert.ok(Math.abs(weatherRGBA[2] - 0.8) < 1e-6, 'RH norm');
    assert.ok(Math.abs(weatherRGBA[3] - 5 / MAX_WIND_MS) < 1e-6, 'wind norm');
    assert.ok(Math.abs(cloudRGBA[0] - 0.5) < 1e-6, 'cloud norm');
    assert.ok(Math.abs(cloudRGBA[3] - 0.2) < 1e-6, 'precip norm (/10)');
});

check('out-of-range values clamp to [0,1]', () => {
    const N = 1;
    const coarse = new Float32Array(N * NUM_CHANNELS);
    coarse[0] = 200;     // absurd T
    coarse[8 * N] = 99;  // 99 mm/hr
    const { weatherRGBA, cloudRGBA } = packPatchTrio(coarse, 1, 1);
    assert.equal(weatherRGBA[0], 1);
    assert.equal(cloudRGBA[3], 1);
});

// ── FocusFootprint ──────────────────────────────────────────────────────────
// Minimal Vector3 / camera / earth stand-ins. worldToLocal applies the
// inverse of a rotation about Y, mimicking earthMesh GMST spin.

class V3 {
    constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
    clone() { return new V3(this.x, this.y, this.z); }
    copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
    length() { return Math.hypot(this.x, this.y, this.z); }
}
function mkEarth(rotY = 0) {
    return {
        worldToLocal(v) {
            // Inverse rotation about Y by rotY (world → local)
            const c = Math.cos(-rotY), s = Math.sin(-rotY);
            const x = v.x * c + v.z * s;
            const z = -v.x * s + v.z * c;
            v.x = x; v.z = z;
            return v;
        },
    };
}
function mkCamera(pos, fov = 40, aspect = 1.6) {
    return { position: pos, fov, aspect };
}

check('sub-camera point honours earth rotation', () => {
    // Camera on the +X axis; earth rotated +90° about Y. In earth-local
    // space the camera then sits over lon −90° (the canonical frame maps
    // +X → lon 0, −Z → lon +90 per latLonToNormal in js/geo/coords.glsl.js).
    const fp = new FocusFootprint({
        camera: mkCamera(new V3(3, 0, 0)),
        earthObject: mkEarth(Math.PI / 2),
    });
    const f = fp._compute();
    assert.ok(Math.abs(f.centerLat) < 1e-6, 'lat 0');
    assert.ok(Math.abs(Math.abs(f.centerLon) - 90) < 1e-6, '|lon| = 90');
});

check('far camera → horizon-clamped span; near camera → narrow frustum span', () => {
    const earth = mkEarth(0);
    const far  = new FocusFootprint({ camera: mkCamera(new V3(10, 0, 0)), earthObject: earth });
    const near = new FocusFootprint({ camera: mkCamera(new V3(1.15, 0, 0)), earthObject: earth });
    const fFar  = far._compute();
    const fNear = near._compute();
    // Horizon at d=10: acos(1/10) ≈ 84.3°, ×2×1.25 margin, capped at 180.
    assert.ok(fFar.spanLatDeg > 90, `far span ${fFar.spanLatDeg}`);
    // d=1.15: frustum (0.15·tan20°/1 rad ≈ 3.1°) → span ≈ 7.8°, well under
    // the activation threshold — this is the zoom the patch exists for.
    assert.ok(fNear.spanLatDeg < ACTIVATE_SPAN_DEG, `near span ${fNear.spanLatDeg}`);
    assert.ok(fNear.spanLonDeg >= fNear.spanLatDeg, 'aspect widens lon');
});

check('throttled change events fire on material moves only', () => {
    const earth = mkEarth(0);
    const cam   = mkCamera(new V3(1.2, 0, 0));
    const fp    = new FocusFootprint({ camera: cam, earthObject: earth, minIntervalMs: 0 });
    const seen  = [];
    document.addEventListener('focus-footprint-change', (ev) => seen.push(ev.detail));
    fp.tick(1000);
    assert.equal(seen.length, 1, 'first tick publishes');
    fp.tick(2000);
    assert.equal(seen.length, 1, 'unmoved camera stays quiet');
    cam.position.z = 0.4;          // sizeable pan
    fp.tick(3000);
    assert.equal(seen.length, 2, 'material move re-publishes');
});

console.log('──────────────────────────────');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
