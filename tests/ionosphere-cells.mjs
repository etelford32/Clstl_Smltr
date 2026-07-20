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

    // Caller palette is honored (ring-current.html mutes crest/bubble so
    // the analytic airglow never gets double-painted).
    const muted = Uint8Array.from([
        0, 0, 0, 0,   0, 0, 0, 0,   0, 0, 0, 0,
        64, 255, 128, 77,   40, 160, 90, 77,   60, 120, 255, 77,
    ]);
    const tex2 = eng.bake(3.4, new Uint8Array(BAKE_W * BAKE_H * 4), muted);
    let a77 = 0, aOther = 0;
    for (let i = 3; i < tex2.length; i += 4) {
        if (tex2[i] === 77) a77++;
        else if (tex2[i] !== 0) aOther++;
    }
    assert.ok(a77 > 200, `custom palette painted (${a77})`);
    assert.equal(aOther, 0, 'no texel outside the custom palette alphas');

    console.log(`  · perf @ node: full epoch ${tFull.toFixed(1)} ms · ` +
        `incremental ${tIncr.toFixed(1)} ms · bake first ${tBake0.toFixed(1)} ms / ` +
        `steady ${tBake.toFixed(2)} ms (${N_GRID} cells, ${BAKE_W}×${BAKE_H})`);
    // Loose ceilings — desktop node. Phone budget ≈ 5× these; the epoch
    // cadence is 10 sim-min, so even ×5 leaves headroom at 60 fps.
    assert.ok(tFull < 100, `full epoch under 100 ms (${tFull.toFixed(1)})`);
    assert.ok(tBake < 25, `steady bake under 25 ms (${tBake.toFixed(2)})`);
    ok('perf probe within budget — see timings above');
}

// ── 7. M4 vocabulary: SAPS / patch / TOI / SED / depleted + precip priors ────
{
    const grid = (fields, epoch = 11) => {
        const eng = new IonosphereCells();
        eng.epoch(fields, epoch);
        return eng;
    };
    const cellsOf = (eng, s) => {
        const out = [];
        for (let c = 0; c < N_GRID; c++) {
            if (eng.state[c] === s) {
                out.push({ i: Math.floor(c / N_MLT), j: c % N_MLT,
                    alat: Math.abs(latCenter(Math.floor(c / N_MLT))), mlt: mltCenter(c % N_MLT) });
            }
        }
        return out;
    };

    // SAPS: overshielding gate, dusk-premidnight subauroral channel; the
    // recovery (dynamo) gate opens it too; undershielding alone does not.
    const over = grid(FIELDS(6, { dA: -0.4 }));
    const saps = cellsOf(over, S.SAPS);
    assert.ok(saps.length > 3, `SAPS present under overshielding (${saps.length})`);
    for (const c of saps) {
        assert.ok(c.mlt >= 15 && c.mlt <= 23, `SAPS MLT ${c.mlt}`);
        assert.ok(c.alat > 45 && c.alat < 68, `SAPS |maglat| ${c.alat}`);
        // SAPS may abut arc/diffuse poleward (5° bins put the stack in
        // adjacent rows) but must NEVER sit poleward of the trough's band —
        // i.e. its equatorward neighbor is trough/quiet/depleted, not arc.
        const north = latCenter(c.i) > 0;
        const eq = north ? c.i - 1 : c.i + 1;
        if (eq >= 0 && eq < N_LAT) {
            assert.notEqual(over.state[eq * N_MLT + c.j], S.ARC, 'arc equatorward of SAPS');
        }
    }
    assert.equal(cellsOf(grid(FIELDS(6, { dA: +0.4 })), S.SAPS).length, 0,
        'no SAPS under pure undershielding');
    assert.ok(cellsOf(grid(FIELDS(6, { dA: 0, dyn: 4 })), S.SAPS).length > 0,
        'recovery (dynamo) gate opens SAPS');

    // Patches: polar cap only, strong driving only.
    const stormCap = grid(FIELDS(7, { dA: 0.3 }));
    const patches = cellsOf(stormCap, S.PATCH);
    assert.ok(patches.length > 4, `patches under strong driving (${patches.length})`);
    for (const c of patches) {
        assert.ok(c.alat > ovalCenterMaglat(c.mlt, 7), `patch in the cap (${c.alat})`);
    }
    assert.equal(cellsOf(grid(FIELDS(1, { dA: 0 })), S.PATCH).length, 0, 'no quiet patches');

    // TOI: cap cells hugging the noon/midnight meridians under undershielding.
    const toi = cellsOf(stormCap, S.TOI);
    assert.ok(toi.length > 0, `TOI present (${toi.length})`);
    for (const c of toi) {
        const nearNoon = Math.abs(c.mlt - 12) <= 2.5;
        const nearMidnight = c.mlt >= 21.5 || c.mlt <= 2.5;
        assert.ok(nearNoon || nearMidnight, `TOI on the noon–midnight axis (${c.mlt})`);
    }

    // SED: afternoon mid-lat plume, undershielding storms only.
    const sed = cellsOf(stormCap, S.SED);
    assert.ok(sed.length > 2, `SED plume present (${sed.length})`);
    for (const c of sed) {
        assert.ok(c.mlt >= 11 && c.mlt <= 20, `SED MLT ${c.mlt}`);
        assert.ok(c.alat > 35 && c.alat < 62, `SED |maglat| ${c.alat}`);
    }
    assert.equal(cellsOf(grid(FIELDS(6, { dA: -0.4 })), S.SED).length, 0,
        'no SED under overshielding');

    // Depleted: needs the wound-up dynamo (hours of Joule heating).
    assert.ok(cellsOf(grid(FIELDS(5, { dyn: 5 })), S.DEPLETED).length > 4, 'O/N₂ damage');
    assert.equal(cellsOf(grid(FIELDS(5, { dyn: 0 })), S.DEPLETED).length, 0, 'fresh storm: none');

    // Precipitation binning seeds the aurora priors: a synthetic hotspot in
    // the diffuse band pulls that cell to DIFFUSE (weights are pure — check
    // both the prior and the collapsed map).
    const precip = new Float32Array(N_GRID);
    const hotJ = 2;   // 02:30 MLT
    const center = ovalCenterMaglat(mltCenter(hotJ), 3);
    const hotI = Math.floor(((center - 4) + 90) / 5);
    precip[hotI * N_MLT + hotJ] = 1;
    const w0 = priorWeights(hotI, hotJ, FIELDS(3));
    const w1 = priorWeights(hotI, hotJ, FIELDS(3, { precip }));
    assert.ok(w1[S.DIFFUSE] > 2.5 * w0[S.DIFFUSE], 'precip multiplies diffuse prior');
    assert.ok(w1[S.ARC] > w0[S.ARC], 'precip lifts arc prior too');
    const hot = grid(FIELDS(3, { precip }), 13);
    assert.equal(hot.state[hotI * N_MLT + hotJ], S.DIFFUSE,
        'death-channel hotspot collapses to diffuse aurora');

    // The full-vocabulary storm sweep stays contradiction-free.
    const eng = new IonosphereCells();
    const arc = [
        { kp: 1, dA: 0 }, { kp: 3, dA: 0.4 }, { kp: 6, dA: 0.6 }, { kp: 8, dA: 0.2, dyn: 1 },
        { kp: 8, dA: -0.3, dyn: 3 }, { kp: 6, dA: -0.1, dyn: 5 }, { kp: 4, dA: 0, dyn: 5 },
        { kp: 2, dA: 0, dyn: 3 }, { kp: 1, dA: 0, dyn: 1 },
    ];
    arc.forEach((f, e) => eng.epoch(FIELDS(f.kp, { ...f, utH: (e * 2.7) % 24 }), 100 + e));
    assert.equal(eng.stats.contradictions, 0, 'storm sweep contradiction-free');
    ok(`M4 vocabulary: SAPS ${saps.length} · patch ${patches.length} · TOI ${toi.length} · SED ${sed.length} · precip seeds aurora`);
}

console.log(`\nionosphere-cells: ${passed}/7 groups passed`);
