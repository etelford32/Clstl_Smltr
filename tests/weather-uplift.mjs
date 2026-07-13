#!/usr/bin/env node
/**
 * weather-uplift.mjs
 *
 * Tests computeUpliftField — the wind-convergence / uplift diagnostic that
 * surfaces (in the Earth weather UI) the same ∇·V signal the forecaster
 * grows precipitation from.
 *
 *   - uniform wind → no convergence anywhere
 *   - a meridional convergence line → positive (uplift) signal on the line
 *   - the same field reversed (divergence line) → negative (subsidence)
 *   - strong forcing clamps the normalised output to ±1 / magnitude 1
 *   - sign/magnitude packing: out.A == |out.R|
 *   - out buffer is reused when supplied; null wind is a safe no-throw
 *
 * Exits 0 on pass, non-zero on failure.
 */

import assert from 'node:assert/strict';
import {
    computeUpliftField, UPLIFT_FULL_SCALE,
    computeVorticityField, VORT_FULL_SCALE,
} from '../js/weather-uplift.js';

let pass = 0, fail = 0;
function check(name, fn) {
    try { fn(); pass++; console.log('  ✓', name); }
    catch (e) { fail++; console.error('  ✗', name, '\n     ', e.message); }
}

console.log('weather-uplift.mjs');
console.log('──────────────────────────────');

const W = 8, H = 8, MAXW = 60, yc = (H - 1) / 2;

// Wind buffer [U/max, V/max, speed/max, 1], row 0 = 90°S. A meridional step:
// south rows blow north (+V·sign) and north rows blow south, so the flow
// piles up at the centre row → convergence line. sign<0 reverses it.
function meridionalWind({ vNorm = 0.8, sign = +1, maxw = MAXW } = {}) {
    const buf = new Float32Array(W * H * 4);
    for (let y = 0; y < H; y++) {
        const v = sign * (y < yc ? +vNorm : -vNorm);   // inflow toward centre
        for (let x = 0; x < W; x++) {
            buf[(y * W + x) * 4 + 1] = v;               // V channel
            buf[(y * W + x) * 4 + 2] = Math.abs(v);     // speed (unused here)
        }
    }
    return buf;
}
const rowMid = 3;                       // interior row straddling the convergence line
const kMid   = (rowMid * W + 4) * 4;    // an interior cell

check('uniform wind produces no convergence', () => {
    const buf = new Float32Array(W * H * 4);
    for (let i = 0; i < W * H; i++) { buf[i * 4] = 0.5; }   // U uniform, V=0
    const out = computeUpliftField(buf, W, H, MAXW);
    let maxMag = 0;
    for (let k = 0; k < W * H; k++) maxMag = Math.max(maxMag, Math.abs(out[k * 4]));
    assert.ok(maxMag < 1e-6, `flat wind → zero convergence, got ${maxMag}`);
});

check('a convergence line reads as positive uplift', () => {
    const out = computeUpliftField(meridionalWind({ sign: +1 }), W, H, MAXW);
    assert.ok(out[kMid] > 0.1, `convergence should be clearly positive, got ${out[kMid].toFixed(3)}`);
});

check('the reversed field reads as negative subsidence', () => {
    const out = computeUpliftField(meridionalWind({ sign: -1 }), W, H, MAXW);
    assert.ok(out[kMid] < -0.1, `divergence should be clearly negative, got ${out[kMid].toFixed(3)}`);
});

check('strong forcing clamps to ±1 and magnitude 1', () => {
    const out = computeUpliftField(meridionalWind({ vNorm: 1.0, maxw: 600 }), W, H, 600);
    assert.ok(Math.abs(out[kMid] - 1) < 1e-6, `R clamps to +1, got ${out[kMid].toFixed(4)}`);
    assert.ok(Math.abs(out[kMid + 3] - 1) < 1e-6, `A clamps to 1, got ${out[kMid + 3].toFixed(4)}`);
});

check('out.A equals |out.R| everywhere (magnitude packing)', () => {
    const out = computeUpliftField(meridionalWind({ sign: +1 }), W, H, MAXW);
    for (let k = 0; k < W * H; k++) {
        assert.ok(Math.abs(out[k * 4 + 3] - Math.abs(out[k * 4])) < 1e-9, `cell ${k} A == |R|`);
    }
});

check('the hover decode (R × UPLIFT_FULL_SCALE) recovers a sane s⁻¹ rate', () => {
    const out = computeUpliftField(meridionalWind({ sign: +1 }), W, H, MAXW);
    const convPerS = out[kMid] * UPLIFT_FULL_SCALE;
    assert.ok(convPerS > 0 && convPerS < 1e-3, `plausible convergence rate, got ${convPerS.toExponential(2)}`);
});

check('supplied out buffer is reused; null wind is a safe no-op', () => {
    const scratch = new Float32Array(W * H * 4);
    const ret = computeUpliftField(meridionalWind({ sign: +1 }), W, H, MAXW, scratch);
    assert.equal(ret, scratch, 'returns the same buffer instance');
    const z = computeUpliftField(null, W, H, MAXW);
    assert.ok(z instanceof Float32Array && z.length === W * H * 4, 'null wind → zeroed buffer, no throw');
});

// ── computeVorticityField (Phase 4.2) ───────────────────────────────────────
// Coarse m/s grids, lat ascending, cell-centred. Shear flow ∂U/∂y < 0 in the
// NH gives ζ = −∂U/∂y > 0 → cyclonic-positive after the hemisphere fold.

// U increases northward (∂U/∂y > 0) everywhere: NH ζ raw = −∂U/∂y < 0.
function shearU(gridW, gridH, dUdyMsPerRow = 5) {
    const u = new Float32Array(gridW * gridH);
    const v = new Float32Array(gridW * gridH);
    for (let j = 0; j < gridH; j++) {
        for (let i = 0; i < gridW; i++) u[j * gridW + i] = j * dUdyMsPerRow;
    }
    return { u, v };
}

check('vorticity: uniform flow spins nothing', () => {
    const u = new Float32Array(W * H).fill(12);
    const v = new Float32Array(W * H).fill(-4);
    const out = computeVorticityField(u, v, W, H);
    let maxMag = 0;
    for (let k = 0; k < W * H; k++) maxMag = Math.max(maxMag, Math.abs(out[k * 4]));
    assert.ok(maxMag < 1e-6, `uniform flow → ζ 0, got ${maxMag}`);
});

check('vorticity: anticyclonic shear reads negative in BOTH hemispheres (cyclonic fold)', () => {
    // 30 m/s per 22.5° row ≈ ∂U/∂y 1.2e-5 s⁻¹ — a strong but synoptic shear.
    const { u, v } = shearU(W, H, 30);
    const out = computeVorticityField(u, v, W, H);
    // Raw ζ = −∂U/∂y < 0 (NH anticyclonic). In the SH the same raw ζ is
    // CYCLONIC — the fold flips it, so the stored value is negative in the
    // NH rows and positive in the SH rows... which for THIS flow means:
    const nh = out[(6 * W + 3) * 4];   // row 6 → +56° lat
    const sh = out[(1 * W + 3) * 4];   // row 1 → −56° lat
    assert.ok(nh < -0.05, `NH: anticyclonic shear negative, got ${nh.toFixed(3)}`);
    assert.ok(sh > 0.05,  `SH: same raw shear is cyclonic there, got ${sh.toFixed(3)}`);
});

check('vorticity: clamps to ±1, A = |R|, NaN gaps read as calm not poison', () => {
    const { u, v } = shearU(W, H, 500);           // absurd shear → clamp
    u[2 * W + 2] = NaN;
    const out = computeVorticityField(u, v, W, H);
    let ok = true;
    for (let k = 0; k < W * H; k++) {
        const r = out[k * 4], a = out[k * 4 + 3];
        if (!Number.isFinite(r) || Math.abs(r) > 1 + 1e-9) ok = false;
        if (Math.abs(a - Math.abs(r)) > 1e-9) ok = false;
    }
    assert.ok(ok, 'all cells finite, clamped, A == |R|');
    assert.ok(Math.abs(out[(6 * W + 3) * 4] + 1) < 1e-9, 'strong shear clamps to −1 in the NH');
});

check('vorticity: decode (R × VORT_FULL_SCALE) is a plausible synoptic rate', () => {
    const { u, v } = shearU(W, H, 3);
    const out = computeVorticityField(u, v, W, H);
    const zeta = Math.abs(out[(6 * W + 3) * 4]) * VORT_FULL_SCALE;
    assert.ok(zeta > 1e-8 && zeta < 1e-3, `plausible ζ, got ${zeta.toExponential(2)}`);
});

console.log('──────────────────────────────');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
