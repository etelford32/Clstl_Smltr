#!/usr/bin/env node
/**
 * stage-scale.mjs — contract gate for the Stage's disclosed spatial
 * compression (js/stage/scale.js). The map may be dishonest about
 * distance ONLY in the documented, removable way: monotone, continuous,
 * Earth pinned exactly, invertible, and blending to the true-linear map
 * at mix=1.
 *
 *   node tests/stage-scale.mjs
 */

import assert from 'node:assert/strict';
import { stageRadius, stageRadiusInv, stagePoint, rulerTicks,
         R1, R2, A, B, EARTH_S, BODY, EARTH_LOCAL_RE, reToUnits }
    from '../js/stage/scale.js';

let n = 0;
const test = (name, fn) => { fn(); n++; console.log(`  ✓ ${name}`); };

test('Earth lands at EXACTLY EARTH_S stage units at every mix', () => {
    for (const mix of [0, 0.25, 0.5, 1]) {
        assert.ok(Math.abs(stageRadius(1, mix) - EARTH_S) < 1e-12, `mix ${mix}`);
    }
});

test('C0 continuity at both breakpoints', () => {
    for (const r of [R1, R2]) {
        const below = stageRadius(r - 1e-9), above = stageRadius(r + 1e-9);
        assert.ok(Math.abs(above - below) < 1e-6, `breakpoint ${r}`);
    }
});

test('strictly monotone for compressed, blended, and true maps', () => {
    for (const mix of [0, 0.5, 1]) {
        let prev = -1;
        for (let i = 0; i <= 500; i++) {
            const s = stageRadius(1.2 * i / 500, mix);
            assert.ok(s > prev - 1e-15, `mix ${mix} at i=${i}`);
            prev = s;
        }
    }
});

test('the compression is the documented shape: launch zone roomy, mid squeezed', () => {
    const slope = (r) => (stageRadius(r + 1e-6) - stageRadius(r - 1e-6)) / 2e-6;
    assert.ok(slope(0.05) > 3, 'near-Sun zone gets MORE room than linear');
    assert.ok(slope(0.85) < 3, 'mid corridor is compressed below linear');
    assert.ok(slope(0.95) > 3, 'near-Earth zone gets more room than linear');
    assert.ok(Math.abs(A * R1 + B * Math.log(R2 / R1) + A * (1 - R2) - EARTH_S) < 1e-12,
        'B is solved so the pieces sum to EARTH_S exactly');
});

test('closed-form inverse round-trips through all three zones', () => {
    for (const r of [0.02, R1, 0.3, 0.62, R2, 0.95, 1.0, 1.1]) {
        assert.ok(Math.abs(stageRadiusInv(stageRadius(r)) - r) < 1e-9, `r=${r}`);
    }
});

test('stagePoint compresses radially — direction preserved', () => {
    const p = stagePoint([0.3, 0.4, 0.1]);
    const r = Math.hypot(0.3, 0.4, 0.1);
    assert.ok(Math.abs(Math.hypot(...p) - stageRadius(r)) < 1e-12);
    const dot = (p[0] * 0.3 + p[1] * 0.4 + p[2] * 0.1) / (Math.hypot(...p) * r);
    assert.ok(Math.abs(dot - 1) < 1e-12, 'colinear with the input');
    assert.deepEqual(stagePoint([0, 0, 0]), [0, 0, 0]);
});

test('ruler ticks label true AU at current stage positions', () => {
    const t0 = rulerTicks(0), t1 = rulerTicks(1);
    assert.equal(t0.length, 5);
    assert.ok(t0.every((t, i) => i === 0 || t.s > t0[i - 1].s), 'ticks monotone');
    assert.ok(Math.abs(t0.at(-1).s - EARTH_S) < 1e-12, '1 AU tick at Earth (compressed)');
    assert.ok(Math.abs(t1.at(-1).s - EARTH_S) < 1e-12, '1 AU tick at Earth (true)');
    // At true scale ticks are proportional; compressed they are not.
    assert.ok(Math.abs(t1[0].s - EARTH_S * 0.1) < 1e-12);
    assert.ok(Math.abs(t0[0].s - EARTH_S * 0.1) > 0.01, 'compression is visible on the ruler');
});

test('disclosed exaggerations are finite and stated', () => {
    assert.ok(BODY.sunExaggeration > 1 && Number.isFinite(BODY.sunExaggeration));
    assert.ok(BODY.earthExaggeration > 1 && Number.isFinite(BODY.earthExaggeration));
    // The quiet magnetopause nose (~10 R_E) must clear the drawn Earth.
    assert.ok(reToUnits(10) > BODY.earthRadiusUnits, 'nose outside the drawn Earth');
    assert.ok(EARTH_LOCAL_RE > 0);
});

console.log(`stage-scale: ALL PASS (${n} tests)`);
