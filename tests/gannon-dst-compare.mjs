// gannon-dst-compare.mjs — fixture gate for the Gannon three-way Dst
// validation (js/gannon-dst-compare.js): the SAME integrateDst pipeline
// driven by observed L1 drivers and by the v1.4 flux-rope train, pinned
// offline against the committed WASM + baked bundle. The published Kyoto
// Dst minimum for this storm (−412 nT — the value on the page's G5 badge)
// is the truth anchor.
//
//   node tests/gannon-dst-compare.mjs

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadFluxRopeKernel } from '../js/flux-rope-kernel.js';
import { computeGannonDstComparison, trackMin, mhdDstFromBundle } from '../js/gannon-dst-compare.js';

let n = 0;
const ok = (msg) => { n++; console.log(`  ✓ ${msg}`); };
const PUBLISHED_DST_MIN = -412;

const kernel = await loadFluxRopeKernel(
    await readFile(fileURLToPath(new URL('../js/flux-rope-wasm/flux_rope_core.wasm', import.meta.url))));
const bundle = JSON.parse(await readFile(
    fileURLToPath(new URL('../data/hindcast/gannon_may_2024_l1_replay.json', import.meta.url)), 'utf8'));

const t0 = Date.now();
const cmp = computeGannonDstComparison({ kernel, bundle, symH: null, dst0: 0 });
const ms = Date.now() - t0;

// ── Shapes + grid ────────────────────────────────────────────────────────────
{
    assert.equal(cmp.tracks.ceiling.length, bundle.series.bz_nt.length);
    assert.equal(cmp.tracks.rope.length, cmp.tracks.ceiling.length);
    assert.equal(cmp.tracks.ceiling[0].t, Date.parse(bundle.window.start));
    assert.ok(ms < 10_000, `compute ${ms} ms`);
    ok(`both legs on the bundle grid (${cmp.n} pts, ${ms} ms)`);
}

// ── The pipeline-ceiling finding: the G5 saturation miss, pinned ─────────────
{
    const m = trackMin(cmp.tracks.ceiling);
    const frac = Math.abs(m.min / PUBLISHED_DST_MIN);
    assert.ok(frac > 0.60 && frac < 0.80,
        `ceiling min ${m.min?.toFixed(0)} should sit 60–80% of published −412 (got ${(100 * frac).toFixed(0)}%)`);
    ok(`pipeline ceiling: observed drivers reach ${m.min.toFixed(0)} nT — the documented ` +
        `~${(100 * (1 - frac)).toFixed(0)}% empirical-integrator miss at G5 (why the MHD leg matters)`);
}

// ── The rope leg: driver error measured against the ceiling ──────────────────
{
    const mr = trackMin(cmp.tracks.rope);
    const mc = trackMin(cmp.tracks.ceiling);
    assert.ok(mr.min > -430 && mr.min < -320, `rope det min ${mr.min?.toFixed(0)}`);
    const dtH = Math.abs(mr.tMin - mc.tMin) / 3.6e6;
    assert.ok(dtH < 3, `min-Dst timing rope vs ceiling Δ${dtH.toFixed(1)} h`);
    let s = 0, c = 0;
    for (let i = 0; i < cmp.n; i++) {
        const a = cmp.tracks.rope[i].dst, b = cmp.tracks.ceiling[i].dst;
        if (Number.isFinite(a) && Number.isFinite(b)) { s += (a - b) ** 2; c++; }
    }
    const rmse = Math.sqrt(s / c);
    assert.ok(rmse < 50, `rope-vs-ceiling RMSE ${rmse.toFixed(1)} nT`);
    ok(`rope leg: min ${mr.min.toFixed(0)} nT at Δ${dtH.toFixed(1)} h, RMSE ${rmse.toFixed(1)} nT vs the ceiling ` +
        '(driver error — launch-time knowledge through the same pipeline)');
}

// ── Ensemble band ordering through the pipeline ──────────────────────────────
{
    const p5 = trackMin(cmp.tracks.ropeP5).min;
    const p50 = trackMin(cmp.tracks.ropeP50).min;
    const p95 = trackMin(cmp.tracks.ropeP95).min;
    assert.ok(p5 < p50 && p50 < p95, `band ordering p5 ${p5?.toFixed(0)} < p50 ${p50?.toFixed(0)} < p95 ${p95?.toFixed(0)}`);
    assert.ok(p5 < trackMin(cmp.tracks.rope).min, 'p5 leg must bound the deterministic leg from below');
    ok('ensemble p5/p50/p95 Bz tracks integrate to an ordered Dst band');
}

// ── Anchoring + determinism ──────────────────────────────────────────────────
{
    assert.ok(Math.abs(cmp.tracks.ceiling[0].dst) < 12, `dst0 anchoring (first pt ${cmp.tracks.ceiling[0].dst.toFixed(1)})`);
    const cmp2 = computeGannonDstComparison({ kernel, bundle, symH: null, dst0: 0 });
    assert.deepEqual(
        cmp2.tracks.ropeP50.map((p) => p.dst),
        cmp.tracks.ropeP50.map((p) => p.dst),
    );
    ok('dst0 anchoring + seeded determinism of the ensemble leg');
}

// ── The BATS-R-US slot stays honest ──────────────────────────────────────────
{
    // The existing GM/IE product (St. Patrick's) carries pseudo-Ap, NOT Dst —
    // the slot must stay dark rather than faking a trace.
    const gmIe = JSON.parse(await readFile(
        fileURLToPath(new URL('../data/hindcast/st_patrick_mar_2015_hindcast.gm_ie.json', import.meta.url)), 'utf8'));
    assert.equal(mhdDstFromBundle(gmIe), null);
    // And it lights up the moment a bundle carries dst_nt per sample.
    const lit = mhdDstFromBundle({
        samples: [{ t: '2024-05-11T00:00:00Z', dst_nt: -350 }, { t: '2024-05-11T01:00:00Z', dst_nt: -370 }],
    });
    assert.equal(lit.length, 2);
    assert.equal(lit[1].dst, -370);
    ok('BATS-R-US slot: dark without a Dst field, auto-lights when the GM/IE re-run lands one');
}

console.log(`\ngannon-dst-compare: ${n} checks passed`);
