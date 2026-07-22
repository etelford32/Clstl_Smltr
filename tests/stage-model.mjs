#!/usr/bin/env node
/**
 * stage-model.mjs — fixture gate for the Stage scene model
 * (js/stage/model.js), including the KERNEL-ORACLE PIN: the model builds
 * rope geometry only through the view.js mirrors, and this gate proves
 * those mirrors still agree with the committed WASM's effective-dynamics
 * probes (fr_apex_km_at / fr_sigma_apex_km_at) on the St. Patrick's v1.4
 * validated fit. If rope.rs kinematics change, THIS fails until the
 * mirrors are re-synced — same contract as the flux-rope view.
 *
 *   node tests/stage-model.mjs
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadFluxRopeKernel } from '../js/flux-rope-kernel.js';
import { ST_PATRICK_FIT } from '../js/flux-rope-presets.js';
import { ropeFrame } from '../js/flux-rope/view.js';
import {
    ropeSurfacePoint, ropeSurfaceGrid, ropeAxisPoints, ropeSpecAt,
    ghostMembers, quantileWeighted, wavefrontRadiiAu,
    shueSurfaceGrid, parkerSpiralPoints, stationDefs, easeInOutCubic,
    flightPose, D0_KM_DEFAULT, dynamicPressure,
} from '../js/stage/model.js';
import { shueStandoffRe, shueAlpha } from '../js/ring-current-model.js';
import { AU_KM } from '../js/stage/scale.js';

let n = 0;
const test = (name, fn) => { fn(); n++; console.log(`  ✓ ${name}`); };
const H = 3600;

const kernel = await loadFluxRopeKernel(await readFile(fileURLToPath(
    new URL('../js/flux-rope-wasm/flux_rope_core.wasm', import.meta.url))));

/* ── THE kernel-oracle pin ──────────────────────────────────────────── */

test('JS mirror apex/σ ≡ WASM effective probes on the St. Patrick fit', () => {
    const fit = ST_PATRICK_FIT.standoffFit.rope;
    kernel.reset();
    kernel.setRope(fit);
    for (const tH of [6, 24, 48, 90]) {
        const spec = ropeSpecAt(fit, fit.wKms, tH * H);
        const apexKm = kernel.apexKmAt(0, tH * H);
        const sigKm = kernel.sigmaApexKmAt(0, tH * H);
        const relD = Math.abs(spec.dAu * AU_KM - apexKm) / apexKm;
        const relS = Math.abs(spec.sigApexAu * AU_KM - sigKm) / sigKm;
        assert.ok(relD < 1e-6, `apex t=${tH}h rel ${relD.toExponential(2)}`);
        assert.ok(relS < 1e-6, `sigma t=${tH}h rel ${relS.toExponential(2)}`);
    }
});

/* ── Rope surface geometry (the SDF zero level) ─────────────────────── */

const SPEC = { frame: ropeFrame(0, 0, 0), dAu: 1, sigApexAu: 0.1 };

test('apex cross-section: known exact points', () => {
    // ψ=π, θ=0: outward along ê_dir → [d + σ_apex, 0, 0].
    const p = ropeSurfacePoint(SPEC, Math.PI, 0);
    assert.ok(Math.hypot(p[0] - 1.1, p[1], p[2]) < 1e-12);
    // θ=π: inward → [d − σ_apex, 0, 0].
    const q = ropeSurfacePoint(SPEC, Math.PI, Math.PI);
    assert.ok(Math.hypot(q[0] - 0.9, q[1], q[2]) < 1e-12);
    // θ=π/2: out of plane along n̂ (z for an untilted rope).
    const z = ropeSurfacePoint(SPEC, Math.PI, Math.PI / 2);
    assert.ok(Math.abs(z[2] - 0.1) < 1e-12 && Math.abs(z[0] - 1) < 1e-12);
});

test('footpoints pinch to the Sun (σ→0, axis→origin)', () => {
    const p = ropeSurfacePoint(SPEC, 0.05, 1.3);
    assert.ok(Math.hypot(...p) < 0.03, `|p| ${Math.hypot(...p)}`);
});

test('surface grid: shapes, finite, indices in range', () => {
    const g = ropeSurfaceGrid(SPEC, 32, 16);
    assert.equal(g.positions.length, 33 * 17 * 3);
    assert.ok(g.positions.every(Number.isFinite));
    assert.equal(g.indices.length, 32 * 16 * 6);
    assert.ok(Math.max(...g.indices) < 33 * 17);
});

test('axis polyline is the d/2 circle through the Sun', () => {
    const pts = ropeAxisPoints(SPEC, 48);
    for (let i = 0; i <= 48; i++) {
        const x = pts[i * 3], y = pts[i * 3 + 1], z = pts[i * 3 + 2];
        assert.ok(Math.abs(Math.hypot(x - 0.5, y) - 0.5) < 1e-6, `on-circle at ${i}`);
        assert.ok(Math.abs(z) < 1e-12, 'untilted rope stays in the ecliptic');
    }
});

/* ── Ghost members + wavefronts ─────────────────────────────────────── */

test('ghostMembers unpacks the wrapper layout and fades by weight', () => {
    const members = 10, stride = 7;
    const mp = new Float32Array(members * stride);
    for (let m = 0; m < members; m++) {
        mp[m * stride] = m;            // lonDeg = member index (marker)
        mp[m * stride + 3] = 500 + m;  // v0
        mp[m * stride + 5] = 0.1;      // sigma
        mp[m * stride + 6] = 1;
    }
    const ens = { members, memberStride: stride, ropesPerMember: 1, memberParams: mp };
    const g = ghostMembers(ens, null, 4);
    assert.equal(g.length, 4);
    assert.deepEqual(g.map((x) => x.lonDeg), [0, 2, 5, 7]);
    assert.ok(g.every((x) => x.weight === 1));
    const weights = new Float32Array(members).fill(0.02);
    weights[0] = 0.2;
    const gw = ghostMembers(ens, weights, 4);
    assert.equal(gw[0].weight, 1);
    assert.ok(Math.abs(gw[1].weight - 0.1) < 1e-6, 'faded relative to the max weight');
});

test('quantileWeighted: unweighted median + weighted skew', () => {
    assert.equal(quantileWeighted([5, 1, 3, 2, 4], null, 0.5), 3);
    assert.equal(quantileWeighted([1, 2, 3], [0.98, 0.01, 0.01], 0.5), 1);
    assert.equal(quantileWeighted([NaN, 2], null, 0.5), 2);
    assert.equal(quantileWeighted([], null, 0.5), null);
});

test('wavefronts: ordered quantiles, advancing with τ, null before launch', () => {
    const members = Array.from({ length: 100 }, (_, i) => ({
        v0Kms: 450 + 6 * i, gammaPerKm: 0.2e-7,
    }));
    const w40 = wavefrontRadiiAu(members, 400, 40 * H);
    assert.ok(w40.p10 < w40.p50 && w40.p50 < w40.p90, 'spread ordering');
    const w50 = wavefrontRadiiAu(members, 400, 50 * H);
    assert.ok(w50.p50 > w40.p50, 'the front advances');
    assert.equal(wavefrontRadiiAu(members, 400, 0), null);
});

/* ── Magnetopause + context dressing ────────────────────────────────── */

test('Shue grid relays the ring-current oracle and breathes with Pdyn', () => {
    const quiet = shueSurfaceGrid(2, 0);
    assert.ok(Math.abs(quiet.r0 - shueStandoffRe(2, 0)) < 1e-12);
    assert.ok(Math.abs(quiet.alpha - shueAlpha(2, 0)) < 1e-12);
    // Nose points at the Sun: first lattice row is (−r0, 0, 0).
    assert.ok(Math.abs(quiet.positions[0] + quiet.r0) < 1e-5);
    assert.ok(Math.abs(quiet.positions[1]) < 1e-6 && Math.abs(quiet.positions[2]) < 1e-6);
    const storm = shueSurfaceGrid(30, -20);
    assert.ok(storm.r0 < quiet.r0, 'storm compresses the nose');
    assert.ok(storm.r0 < 6.6, 'the 30 nPa / −20 nT case bites inside GEO');
    // Tail cap honored.
    for (let i = 0; i < quiet.positions.length; i += 3) {
        const r = Math.hypot(quiet.positions[i], quiet.positions[i + 1], quiet.positions[i + 2]);
        assert.ok(r <= 28 * 1.01, `tail capped (r=${r})`);
    }
    assert.ok(Math.abs(dynamicPressure(5, 450) - 1.67e-6 * 5 * 450 * 450) < 1e-9);
});

test('Parker spiral curls with distance (context only)', () => {
    const pts = parkerSpiralPoints(400, 0, 60, 1.1);
    assert.equal(pts.length, 180);
    const phi = (i) => Math.atan2(pts[i * 3 + 1], pts[i * 3]);
    // Unwrapped azimuth strictly decreases (trailing spiral for Ω > 0).
    let prev = phi(0), unwrapped = prev;
    for (let i = 1; i < 60; i++) {
        let d = phi(i) - prev;
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        assert.ok(d < 0, `spiral trails at ${i}`);
        unwrapped += d; prev = phi(i);
    }
    assert.ok(unwrapped < -1, 'a 1 AU line winds substantially');
});

/* ── Stations & flights ─────────────────────────────────────────────── */

test('four stations in narrative order with sane frames', () => {
    const s = stationDefs();
    assert.deepEqual(s.map((x) => x.id),
        ['solar-watch', 'corridor', 'l1-approach', 'magnetosphere']);
    for (const st of s) {
        assert.ok([...st.pos, ...st.target].every(Number.isFinite));
        assert.ok(st.minD > 0 && st.maxD > st.minD);
    }
    const l1 = s[2];
    assert.ok(l1.target[0] < l1.pos[0], 'L1 Approach looks sunward');
});

test('flight easing: endpoints exact, midpoint eased', () => {
    assert.equal(easeInOutCubic(0), 0);
    assert.equal(easeInOutCubic(1), 1);
    assert.equal(easeInOutCubic(0.5), 0.5);
    const [a, b] = stationDefs();
    assert.deepEqual(flightPose(a, b, 0).pos, a.pos);
    assert.deepEqual(flightPose(a, b, 1).target, b.target);
});

console.log(`stage-model: ALL PASS (${n} tests)`);
