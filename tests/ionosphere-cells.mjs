#!/usr/bin/env node
/**
 * ionosphere-cells.mjs — pure-Node validation of the WFC regional cell
 * engine prototype (js/ionosphere-cells.js, Track B M2 starter) PLUS the
 * perf probe that answers IONOSPHERE_EXPLORATION_PLAN.md open question 1
 * ("is the 864-cell collapse + 288×192 bake cheap enough per epoch on a
 * phone?" — 2026-07-20 decision: experiment first).
 *
 * Pins:
 *   1. Priors: oval center parameterization; bubble/crest/trough windows.
 *   2. Kp 5 collapse: the oval forms a CLOSED ring (arc/diffuse in every
 *      MLT column near the parameterized latitude, both hemispheres).
 *   3. Bubbles never collapse outside |maglat| ≤ 22 / MLT 19–02 — even
 *      against an adversarial all-longitudes bubble field.
 *   4. Trough sits equatorward of the oval; arc never touches trough
 *      directly (the diffuse buffer, enforced by adjacency).
 *   5. Determinism: same fields + epoch ⇒ identical map; zero structural
 *      contradictions across a quiet→storm→recovery sweep; incremental
 *      epochs keep churn low when fields barely move.
 *   6. PERF PROBE (reported, loosely asserted): full epoch, incremental
 *      epoch, and bake timings.
 *
 * Exits 0 on pass, non-zero on failure.
 */

import assert from 'node:assert/strict';
import {
    N_LAT, N_MLT, N_GRID, STATES, S, latCenter, mltCenter,
    ovalCenterMaglat, priorWeights, compatible, IonosphereCells,
    BAKE_W, BAKE_H,
} from '../js/ionosphere-cells.js';

let passed = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); passed++; };

const quietCrest = new Float32Array(72).fill(0.35);
const noBubbles = new Float32Array(72);
const FIELDS = (kp, extra = {}) => ({
    kp, utH: 3.0, crest: quietCrest, bubbleExtent: noBubbles, ...extra,
});

// ── 1. Priors ────────────────────────────────────────────────────────────────
{
    assert.ok(ovalCenterMaglat(0, 1) > 63 && ovalCenterMaglat(0, 1) < 67, 'quiet oval ~65');
    assert.ok(ovalCenterMaglat(0, 5) > 56 && ovalCenterMaglat(0, 5) < 60, 'Kp5 midnight ~58');
    assert.ok(ovalCenterMaglat(12, 5) > ovalCenterMaglat(0, 5) + 4, 'noon poleward of midnight');

    // Bubble prior: only inside the extent and the 19–02 window.
    const ext = new Float32Array(72).fill(15);
    const w1 = priorWeights(19, 21, FIELDS(3, { bubbleExtent: ext }));  // ~+7.5°, 21.5 MLT
    assert.ok(w1[S.BUBBLE] > 0, 'bubble prior inside window');
    const w2 = priorWeights(19, 11, FIELDS(3, { bubbleExtent: ext }));  // 11.5 MLT
    assert.equal(w2[S.BUBBLE], 0, 'no bubble prior at noon');
    const w3 = priorWeights(30, 21, FIELDS(3, { bubbleExtent: ext }));  // 62.5° lat
    assert.equal(w3[S.BUBBLE], 0, 'no bubble prior at auroral lat');

    // Adjacency: trough may NOT sit directly equatorward of arc.
    assert.equal(compatible(S.ARC, 1, S.TROUGH), false, 'arc–trough forbidden');
    assert.equal(compatible(S.ARC, 1, S.DIFFUSE), true, 'arc–diffuse allowed');
    assert.equal(compatible(S.BUBBLE, 0, S.CREST), true, 'crest poleward of bubble');
    for (let d = 0; d < 4; d++) {
        for (let s = 0; s < STATES.length; s++) {
            assert.ok(compatible(S.QUIET, d, s) && compatible(s, d, S.QUIET), 'quiet universal');
        }
    }
    ok('priors: oval parameterization, bubble windows, adjacency table');
}

// ── 2. Kp 5: the oval closes ─────────────────────────────────────────────────
{
    const eng = new IonosphereCells();
    eng.epoch(FIELDS(5), 1);
    for (const hemi of [+1, -1]) {
        for (let j = 0; j < N_MLT; j++) {
            const center = ovalCenterMaglat(mltCenter(j), 5);
            let hit = false;
            for (let i = 0; i < N_LAT; i++) {
                const lat = latCenter(i);
                if (Math.sign(lat) !== hemi) continue;
                const s = eng.state[i * N_MLT + j];
                if ((s === S.ARC || s === S.DIFFUSE) && Math.abs(Math.abs(lat) - center) < 8) {
                    hit = true;
                }
            }
            assert.ok(hit, `oval present at MLT ${mltCenter(j)} hemi ${hemi}`);
        }
    }
    ok('Kp 5: arc/diffuse ring closes in every MLT column, both hemispheres');
}

// ── 3. Bubbles stay in their window (adversarial field) ──────────────────────
{
    const eng = new IonosphereCells();
    const everywhere = new Float32Array(72).fill(18);   // bubbles claim every lon
    eng.epoch(FIELDS(4, { bubbleExtent: everywhere }), 7);
    let nBub = 0;
    for (let c = 0; c < N_GRID; c++) {
        if (eng.state[c] !== S.BUBBLE) continue;
        nBub++;
        const lat = Math.abs(latCenter(Math.floor(c / N_MLT)));
        const mlt = mltCenter(c % N_MLT);
        assert.ok(lat <= 22, `bubble at |maglat| ${lat}`);
        const inWindow = mlt >= 18.5 || mlt <= 2.5;
        assert.ok(inWindow, `bubble at MLT ${mlt}`);
    }
    assert.ok(nBub > 4, `bubble cells collapsed (${nBub})`);
    ok(`bubbles never leave the R-T window (${nBub} cells, all legal)`);
}

// ── 4. Trough equatorward of the oval; diffuse buffers arc ───────────────────
{
    const eng = new IonosphereCells();
    eng.epoch(FIELDS(6), 3);
    let nTrough = 0;
    for (let c = 0; c < N_GRID; c++) {
        if (eng.state[c] !== S.TROUGH) continue;
        nTrough++;
        const i = Math.floor(c / N_MLT), j = c % N_MLT;
        const alat = Math.abs(latCenter(i));
        assert.ok(alat < ovalCenterMaglat(mltCenter(j), 6) - 3,
            `trough ${alat}° equatorward of oval center`);
        // No arc directly poleward-adjacent (diffuse must buffer).
        const north = latCenter(i) > 0;
        const pole = north ? i + 1 : i - 1;
        if (pole >= 0 && pole < N_LAT) {
            assert.notEqual(eng.state[pole * N_MLT + j], S.ARC, 'arc touching trough');
        }
    }
    assert.ok(nTrough > 3, `trough present at Kp 6 (${nTrough})`);
    ok(`trough: ${nTrough} cells, all subauroral, none touching arc`);
}

// ── 5. Determinism, zero contradictions, incremental churn ───────────────────
{
    const a = new IonosphereCells(), b = new IonosphereCells();
    a.epoch(FIELDS(5), 42);
    b.epoch(FIELDS(5), 42);
    assert.deepEqual([...a.state], [...b.state], 'same fields+epoch ⇒ identical map');
    const c2 = new IonosphereCells();
    c2.epoch(FIELDS(5), 43);
    assert.notDeepEqual([...a.state], [...c2.state], 'different epoch seed ⇒ different draw');

    // Quiet → storm → recovery sweep: no structural contradictions ever;
    // forcedQuiet (constraint-eliminated favorites) stays a small minority.
    const eng = new IonosphereCells();
    const kpArc = [1, 1, 2, 3, 5, 7, 8, 8, 7, 6, 5, 4, 3, 2, 2, 1];
    kpArc.forEach((kp, e) => eng.epoch(FIELDS(kp, { utH: (e * 1.5) % 24 }), e));
    assert.equal(eng.stats.contradictions, 0, 'zero contradictions across the sweep');
    assert.ok(eng.stats.forcedQuiet < eng.stats.collapsed * 0.1,
        `forcedQuiet minority (${eng.stats.forcedQuiet}/${eng.stats.collapsed})`);

    // Incremental: a hair of Kp movement re-opens few cells.
    const before = [...eng.state];
    const opened = eng.epoch(FIELDS(1.05, { utH: ((kpArc.length - 1) * 1.5) % 24 }), 99);
    let changed = 0;
    for (let c = 0; c < N_GRID; c++) if (eng.state[c] !== before[c]) changed++;
    assert.ok(opened < N_GRID * 0.5, `hysteresis holds most cells (${opened} opened)`);
    assert.ok(changed <= opened, 'only opened cells changed');
    ok(`determinism + 0 contradictions + incremental (${opened} opened, ${changed} changed on ΔKp 0.05)`);
}

// ── 6. Perf probe — the open-question-1 experiment ───────────────────────────
{
    const eng = new IonosphereCells();
    const t0 = performance.now();
    eng.epoch(FIELDS(5), 1);
    const tFull = performance.now() - t0;

    const t1 = performance.now();
    eng.epoch(FIELDS(5.4, { utH: 3.2 }), 2);   // typical inter-epoch drift
    const tIncr = performance.now() - t1;

    const t2 = performance.now();
    const tex = eng.bake(3.2);
    const tBake0 = performance.now() - t2;      // includes static-table build
    const t3 = performance.now();
    eng.bake(3.4, tex);
    const tBake = performance.now() - t3;       // steady-state bake

    assert.equal(tex.length, BAKE_W * BAKE_H * 4, 'bake buffer size');
    let painted = 0;
    for (let i = 3; i < tex.length; i += 4) if (tex[i] > 40) painted++;
    assert.ok(painted > 500, `bake painted non-quiet texels (${painted})`);

    console.log(`  · perf @ node: full epoch ${tFull.toFixed(1)} ms · ` +
        `incremental ${tIncr.toFixed(1)} ms · bake first ${tBake0.toFixed(1)} ms / ` +
        `steady ${tBake.toFixed(2)} ms (${N_GRID} cells, ${BAKE_W}×${BAKE_H})`);
    // Loose ceilings — desktop node. Phone budget ≈ 5× these; the epoch
    // cadence is 10 sim-min, so even ×5 leaves headroom at 60 fps.
    assert.ok(tFull < 100, `full epoch under 100 ms (${tFull.toFixed(1)})`);
    assert.ok(tBake < 25, `steady bake under 25 ms (${tBake.toFixed(2)})`);
    ok('perf probe within budget — see timings above');
}

console.log(`\nionosphere-cells: ${passed}/6 groups passed`);
