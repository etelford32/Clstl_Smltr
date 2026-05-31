#!/usr/bin/env node
/**
 * weather-convergence-growth.mjs
 *
 * Tests the convergence-driven microphysics added to the RK2 forecaster:
 * where the wind field converges (∇·V < 0), moist air is lifted and grows
 * new cloud + precipitation — a non-conserved dynamical source the
 * pure-advection transport was missing.
 *
 *   A. applyConvergenceGrowth (pure):
 *      - h ≤ 0 / disabled are no-ops (live frame untouched)
 *      - converging moist air grows precip AND the low/mid deck together
 *      - growth is one-directional: diverging air grows nothing
 *      - dry air doesn't rain even when converging (moisture gate)
 *      - non-divergent (uniform) wind grows nothing
 *      - growth increases with lead time and respects the caps
 *   B. WindAdvectionRK2Forecaster.forecastDense (integration):
 *      - a moist convergence band generates precip + cloud over the horizon,
 *        where a convergence-disabled run stays dry
 *
 * Exits 0 on pass, non-zero on failure.
 */

import assert from 'node:assert/strict';
import {
    applyConvergenceGrowth,
    DEFAULT_CONVERGENCE_GROWTH,
    WindAdvectionRK2Forecaster,
} from '../js/weather-flow.js';

const NUM_CH = 9, CH_RH = 2, CH_U = 3, CH_V = 4, CH_LOW = 5, CH_MID = 6, CH_PRECIP = 8;

let pass = 0, fail = 0;
function check(name, fn) {
    try { fn(); pass++; console.log('  ✓', name); }
    catch (e) { fail++; console.error('  ✗', name, '\n     ', e.message); }
}

console.log('weather-convergence-growth.mjs');
console.log('──────────────────────────────');

const GW = 8, GH = 8, N = GW * GH;
const ctr = (GH - 1) / 2;

// Build a frame with U=0 and a purely meridional wind V(j) so divergence is
// ∂V/∂y only — no longitude-wrap subtlety. sign>0 → V points inward toward the
// centre row (convergent); sign<0 → outward (divergent). rhPct sets moisture.
function meridionalFrame({ amp = 4, sign = +1, rhPct = 85, precip0 = 0, deck0 = 0 } = {}) {
    const f = new Float32Array(N * NUM_CH);
    for (let j = 0; j < GH; j++) {
        for (let i = 0; i < GW; i++) {
            const k = j * GW + i;
            f[CH_V * N + k]      = sign * amp * (ctr - j);   // inflow/outflow about centre
            f[CH_RH * N + k]     = rhPct;
            f[CH_PRECIP * N + k] = precip0;
            f[CH_LOW * N + k]    = deck0;
        }
    }
    return f;
}
const midCell = Math.round(ctr) * GW + GW / 2;   // an interior cell near the convergence axis

check('h ≤ 0 is a no-op', () => {
    const f = meridionalFrame();
    applyConvergenceGrowth(f, N, GW, GH, 0);
    assert.equal(f[CH_PRECIP * N + midCell], 0);
    assert.equal(f[CH_LOW * N + midCell], 0);
});

check('disabled params is a no-op', () => {
    const f = meridionalFrame();
    applyConvergenceGrowth(f, N, GW, GH, 24, { ...DEFAULT_CONVERGENCE_GROWTH, enabled: false });
    assert.equal(f[CH_PRECIP * N + midCell], 0);
});

check('converging moist air grows precip AND the low/mid deck together', () => {
    const f = meridionalFrame({ sign: +1 });
    applyConvergenceGrowth(f, N, GW, GH, 12, DEFAULT_CONVERGENCE_GROWTH);
    assert.ok(f[CH_PRECIP * N + midCell] > 0.1, `precip should grow, got ${f[CH_PRECIP * N + midCell].toFixed(3)}`);
    assert.ok(f[CH_LOW * N + midCell]   > 1,   `low deck should grow, got ${f[CH_LOW * N + midCell].toFixed(2)}`);
    assert.ok(f[CH_MID * N + midCell]   > 0,   `mid deck should grow, got ${f[CH_MID * N + midCell].toFixed(2)}`);
});

check('growth is one-directional: diverging air grows nothing', () => {
    const f = meridionalFrame({ sign: -1 });   // outflow → divergence
    applyConvergenceGrowth(f, N, GW, GH, 24, DEFAULT_CONVERGENCE_GROWTH);
    assert.equal(f[CH_PRECIP * N + midCell], 0, 'no precip from divergence');
    assert.equal(f[CH_LOW * N + midCell], 0,    'no cloud from divergence');
});

check('dry converging air does not rain (moisture gate)', () => {
    const f = meridionalFrame({ sign: +1, rhPct: 20 });   // below rhFloor (40%)
    applyConvergenceGrowth(f, N, GW, GH, 24, DEFAULT_CONVERGENCE_GROWTH);
    assert.equal(f[CH_PRECIP * N + midCell], 0, `dry air stays dry, got ${f[CH_PRECIP * N + midCell].toFixed(4)}`);
});

check('non-divergent (uniform) wind grows nothing', () => {
    const f = new Float32Array(N * NUM_CH);
    for (let k = 0; k < N; k++) { f[CH_U * N + k] = 7; f[CH_RH * N + k] = 90; }  // uniform → ∇·V = 0
    applyConvergenceGrowth(f, N, GW, GH, 24, DEFAULT_CONVERGENCE_GROWTH);
    assert.equal(f[CH_PRECIP * N + midCell], 0);
});

check('growth increases with lead time and respects the caps', () => {
    const near = meridionalFrame({ sign: +1 }); applyConvergenceGrowth(near, N, GW, GH, 2,  DEFAULT_CONVERGENCE_GROWTH);
    const far  = meridionalFrame({ sign: +1 }); applyConvergenceGrowth(far,  N, GW, GH, 24, DEFAULT_CONVERGENCE_GROWTH);
    assert.ok(far[CH_PRECIP * N + midCell] > near[CH_PRECIP * N + midCell], 'precip grows with lead time');
    // Crank the wind hard → the per-horizon caps must hold.
    const huge = meridionalFrame({ sign: +1, amp: 400 });
    applyConvergenceGrowth(huge, N, GW, GH, 24, DEFAULT_CONVERGENCE_GROWTH);
    assert.ok(huge[CH_PRECIP * N + midCell] <= DEFAULT_CONVERGENCE_GROWTH.precipMax + 1e-6,
        `added precip capped at precipMax, got ${huge[CH_PRECIP * N + midCell].toFixed(3)}`);
    assert.ok(huge[CH_LOW * N + midCell] <= 100 + 1e-6, 'cloud fraction stays ≤ 100%');
});

// ── B. Integration through forecastDense ─────────────────────────────────────

function bigFrame(tMs, { amp = 5, rhPct = 88 } = {}) {
    const GWb = 16, GHb = 8, Nb = GWb * GHb, cy = (GHb - 1) / 2;
    const c = new Float32Array(Nb * NUM_CH);
    for (let j = 0; j < GHb; j++) for (let i = 0; i < GWb; i++) {
        const k = j * GWb + i;
        c[CH_V * Nb + k]  = amp * (cy - j);   // meridional convergence toward the mid row
        c[CH_RH * Nb + k] = rhPct;
    }
    return { t: tMs, fetchedAt: tMs, source: 'test', gridW: GWb, gridH: GHb, coarse: c };
}
const HOUR = 3_600_000;
const frames = [bigFrame(-HOUR), bigFrame(0)];
const history = { all: () => frames };
const Nb = 16 * 8;

const fcOn  = new WindAdvectionRK2Forecaster();
const fcOff = new WindAdvectionRK2Forecaster({ convergenceGrowth: { ...DEFAULT_CONVERGENCE_GROWTH, enabled: false } });
const dOn  = fcOn.forecastDense({ history, maxHorizonH: 12 });
const dOff = fcOff.forecastDense({ history, maxHorizonH: 12 });

function sum(frame, ch) { let s = 0; for (let k = 0; k < Nb; k++) s += frame[ch * Nb + k]; return s; }

check('moist convergence band generates precip the disabled run never makes', () => {
    const onP  = sum(dOn.frames[12],  CH_PRECIP);
    const offP = sum(dOff.frames[12], CH_PRECIP);
    assert.ok(offP < 1e-6, `convergence-off stays dry (advecting zero precip), got ${offP.toFixed(4)}`);
    assert.ok(onP > 1.0,   `convergence-on rains over the band, got ${onP.toFixed(3)}`);
});

check('convergence also thickens the cloud deck (cloud+rain grow together)', () => {
    const onC  = sum(dOn.frames[12],  CH_LOW);
    const offC = sum(dOff.frames[12], CH_LOW);
    assert.ok(onC > offC + 1.0, `deck should grow under convergence (on ${onC.toFixed(2)} vs off ${offC.toFixed(2)})`);
});

console.log('──────────────────────────────');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
