#!/usr/bin/env node
/**
 * temp-volume-feed.mjs
 *
 * Pure-Node smoke test for js/temp-volume-feed.js:
 *   1. pivotLevelResponses turns per-location hourly arrays into per-hour
 *      6-channel frames (T850/T500/U850/V850/U500/V500) with correct
 *      timestamps, cell order, and met-convention wind decompose.
 *   2. sample() lerps between bracketing hours and clamps at ring ends.
 *   3. Encoding matches the shader contract: value = (T°C + 60) / 110.
 *   4. NaN upstream gaps encode as 0 rather than poisoning the texture.
 *   5. levelWindSnapshot() returns the newest frame ≤ t with per-hour
 *      tendencies from its predecessor.
 *   6. Model ring precedence: inside the model span sample() paints the
 *      model, crossfades across the 4 h seam, and NWP owns past/beyond.
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

const { TempVolumeFeed, pivotLevelResponses, LVL } = await import('../js/temp-volume-feed.js');

const GRID_N = 72 * 36;
const HOUR = 3_600_000;

let pass = 0, fail = 0;
function check(name, fn) {
    try { fn(); pass++; console.log('  ✓', name); }
    catch (e) { fail++; console.error('  ✗', name, '\n     ', e.message); }
}

// Synthetic merged response: T850 = cellIndex mod 50 − 20 at hour 0, +2 °C
// at hour 1; T500 = T850 − 25. Winds: 10 m/s from the west (dir=270°) at
// 850; 20 m/s from the south (dir=180°) at 500.
const T0 = '2026-07-03T00:00';
const T1 = '2026-07-03T01:00';
const mkMerged = () => Array.from({ length: GRID_N }, (_, k) => ({
    hourly: {
        time: [T0, T1],
        temperature_850hPa: [(k % 50) - 20, (k % 50) - 18],
        temperature_500hPa: [(k % 50) - 45, (k % 50) - 43],
        wind_speed_850hPa:     [10, 12],
        wind_direction_850hPa: [270, 270],
        wind_speed_500hPa:     [20, 20],
        wind_direction_500hPa: [180, 180],
        cape:                  [800, 1200],
        freezing_level_height: [3500, 3700],
    },
}));

console.log('temp-volume-feed.mjs');
console.log('─────────────────────');

check('pivot: 8-channel frames with correct t, layout, wind decompose', () => {
    const frames = pivotLevelResponses(mkMerged());
    assert.equal(frames.length, 2);
    assert.equal(frames[0].t, Date.parse(T0 + 'Z'));
    assert.equal(frames[0].data.length, GRID_N * 8);
    assert.equal(frames[0].data[LVL.CAPE * GRID_N + 7], 800);
    assert.equal(frames[1].data[LVL.FLH * GRID_N + 7], 3700);
    // cell 7: T850 = -13, T500 = -38 at hour 0
    assert.equal(frames[0].data[LVL.T850 * GRID_N + 7], -13);
    assert.equal(frames[0].data[LVL.T500 * GRID_N + 7], -38);
    // dir 270° ("from the west") → eastward U = +10, V ≈ 0
    assert.ok(Math.abs(frames[0].data[LVL.U850 * GRID_N + 7] - 10) < 1e-4);
    assert.ok(Math.abs(frames[0].data[LVL.V850 * GRID_N + 7]) < 1e-4);
    // dir 180° ("from the south") → northward V = +20, U ≈ 0
    assert.ok(Math.abs(frames[0].data[LVL.V500 * GRID_N + 7] - 20) < 1e-4);
    assert.ok(Math.abs(frames[0].data[LVL.U500 * GRID_N + 7]) < 1e-4);
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

check('sample: empty rings return false; NaN cells encode as 0', () => {
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

check('levelWindSnapshot: newest ≤ t, per-hour tendencies from predecessor', () => {
    const feed = new TempVolumeFeed();
    feed._frames = pivotLevelResponses(mkMerged());
    const t1 = Date.parse(T1 + 'Z');
    const snap = feed.levelWindSnapshot(t1 + 10 * 60_000);   // 10 min past hour 1
    assert.equal(snap.t, t1, 'snapshot anchors on the newest frame ≤ t');
    assert.equal(snap.gridW * snap.gridH, GRID_N);
    assert.ok(Math.abs(snap.u850[7] - 12) < 1e-4, 'hour-1 850 wind');
    // tendency: (12 − 10) m/s over 1 h = 2
    assert.ok(Math.abs(snap.tendU850[7] - 2) < 1e-4, `tendency got ${snap.tendU850[7]}`);
    // Oldest frame → no predecessor → null tendencies
    const snap0 = feed.levelWindSnapshot(Date.parse(T0 + 'Z'));
    assert.equal(snap0.tendU850, null);
});

check('sampleAux: CAPE/FLH lerp + normalisation; empty ring false; NaN → 0', () => {
    const feed = new TempVolumeFeed();
    const out = new Float32Array(GRID_N * 4);
    assert.equal(feed.sampleAux(Date.now(), out), false, 'empty ring');

    const merged = mkMerged();
    merged[3].hourly.cape = [NaN, NaN];
    feed._frames = pivotLevelResponses(merged);
    const tMid = Date.parse(T0 + 'Z') + HOUR / 2;
    assert.equal(feed.sampleAux(tMid, out), true);
    // cell 7 midpoint: CAPE 1000 → 1000/4000; FLH 3600 → 3600/10000
    assert.ok(Math.abs(out[7 * 4] - 1000 / 4000) < 1e-6, `cape got ${out[7 * 4]}`);
    assert.ok(Math.abs(out[7 * 4 + 1] - 3600 / 10000) < 1e-6, `flh got ${out[7 * 4 + 1]}`);
    assert.equal(out[3 * 4], 0, 'NaN CAPE encodes as 0 (no paint)');
});

check('model ring owns near term, seam-blends into NWP, NWP owns past/beyond', () => {
    const feed = new TempVolumeFeed();
    feed._frames = pivotLevelResponses(mkMerged());
    const issued = Date.parse(T0 + 'Z');
    // 8-hour model ring: constant +10 °C at both levels everywhere — far
    // from the NWP's cell-7 values so the blend weight is measurable.
    const mk = (v) => { const a = new Float32Array(GRID_N); a.fill(v); return a; };
    feed.setModelRing({
        issued_ms: issued,
        frames: Array.from({ length: 9 }, (_, h) => ({
            h, target_ms: issued + h * HOUR, t850: mk(10), t500: mk(10),
        })),
    });
    const out = new Float32Array(GRID_N * 4);
    const enc = (c) => (c + 60) / 110;

    // Inside the model-owned span (issued+1h, seam starts at +4h): pure model.
    feed.sample(issued + 1 * HOUR, out);
    assert.ok(Math.abs(out[7 * 4] - enc(10)) < 1e-6, `model-owned, got ${out[7 * 4]}`);

    // Mid-seam (+6h of an 8h ring, seam 4..8h): 50/50 model/NWP. NWP at +6h
    // clamps to hour-1 frame: cell 7 T850 = −11 → blend = (10 + −11)/2.
    feed.sample(issued + 6 * HOUR, out);
    assert.ok(Math.abs(out[7 * 4] - enc((10 + -11) / 2)) < 1e-3, `seam blend, got ${out[7 * 4]}`);

    // Beyond the ring end: pure NWP (clamped to newest frame).
    feed.sample(issued + 20 * HOUR, out);
    assert.ok(Math.abs(out[7 * 4] - enc(-11)) < 1e-6, 'beyond ring → NWP');

    // Past (before issue): pure NWP.
    feed.sample(issued - 1, out);
    assert.ok(Math.abs(out[7 * 4] - enc(-13)) < 1e-3, 'past → NWP');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
