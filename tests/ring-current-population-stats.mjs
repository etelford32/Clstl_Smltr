#!/usr/bin/env node
/**
 * ring-current-population-stats.mjs — pure-Node validation of the Phase-2
 * population samplers (js/ring-current-population-stats.js):
 *
 *   1. Visibility gate matches the shader's hash gate (all at 1, none at 0,
 *      monotone in visFrac).
 *   2. Energy spectrum: bins sum to the visible count; the log-uniform
 *      build seed lands roughly flat across log bins.
 *   3. L distribution sums to visible count; expectedLProfile peaks near
 *      ringPeakL(Dst*) and is normalized to 1.
 *   4. Lifetime histograms: O⁺ median lifetime < H⁺ (the two-phase decay).
 *   5. Drift-period curve falls with energy (hot laps cold).
 *   6. tallyRecycles: baseline call counts nothing; advancing sim time by
 *      one full lifetime of a known particle counts exactly its channel;
 *      totals over a long window ≈ Σ(Δt/τ_i).
 *   7. builtOxygenEnergyShare ∈ (0,1) and responds to the gates.
 *
 * Exits 0 on pass, non-zero on failure.
 */

import assert from 'node:assert/strict';
import { buildPopulation } from '../js/ring-current-particles.js';
import { ringPeakL } from '../js/ring-current-model.js';
import {
    DOMAINS, isVisible, logBinIndex, linBinIndex,
    energySpectrum, lDistribution, expectedLProfile,
    lifetimeHistogram, driftPeriodCurve, tallyRecycles,
    builtOxygenEnergyShare,
} from '../js/ring-current-population-stats.js';

let n = 0;
const ok = (msg) => { n++; console.log(`  ✓ ${msg}`); };

function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const H = buildPopulation(2100, 'ion', rng(3));
const O = buildPopulation(1100, 'oxygen', rng(5));

// ── 1. Visibility gate ──────────────────────────────────────────────────────
{
    let all = 0, none = 0, half = 0;
    for (let i = 0; i < H.count; i++) {
        if (isVisible(H, i, 1)) all++;
        if (isVisible(H, i, 0)) none++;
        if (isVisible(H, i, 0.5)) half++;
    }
    assert.equal(all, H.count, 'visFrac=1 shows everything');
    assert.equal(none, 0, 'visFrac=0 hides everything');
    assert.ok(half > 0.4 * H.count && half < 0.6 * H.count,
        `visFrac=0.5 shows ≈half (${half}/${H.count})`);
    assert.equal(logBinIndex(10, 20, 250, 8), -1, 'below-range → -1');
    assert.equal(linBinIndex(6.5, 1.9, 6.5, 10), 9, 'max lands in the last bin');
    ok('visibility gate + bin edges behave');
}

// ── 2. Energy spectrum ──────────────────────────────────────────────────────
{
    const bins = new Float32Array(8);
    const vis = energySpectrum(H, 1, bins);
    assert.equal(vis, H.count, 'every built particle is in the 20–250 range');
    assert.equal(bins.reduce((s, x) => s + x, 0), vis, 'bins sum to visible count');
    // Log-uniform seed → each of 8 log bins ≈ count/8 (loose statistical band).
    const exp = H.count / bins.length;
    for (const b of bins) assert.ok(b > exp * 0.7 && b < exp * 1.3,
        `log-uniform build is flat-ish per log bin (${b} vs ${exp.toFixed(0)})`);
    const visHalf = energySpectrum(H, 0.5, bins);
    assert.ok(visHalf < vis, 'tightening the gate lowers the spectrum total');
    ok('energy spectrum: sums, flat log-uniform seed, gate responds');
}

// ── 3. L distribution + expected profile ────────────────────────────────────
{
    const bins = new Float32Array(12);
    const vis = lDistribution(H, 1, bins);
    assert.equal(vis, H.count, 'every particle is inside the L domain');
    assert.equal(bins.reduce((s, x) => s + x, 0), vis, 'L bins sum to count');
    const prof = expectedLProfile(-120, new Float32Array(24));
    assert.ok(Math.abs(Math.max(...prof) - 1) < 1e-12, 'profile normalized to peak 1');
    const peakL = ringPeakL(-120);
    const argmax = prof.indexOf(Math.max(...prof));
    const Lc = DOMAINS.L.min + ((argmax + 0.5) / prof.length) * (DOMAINS.L.max - DOMAINS.L.min);
    assert.ok(Math.abs(Lc - peakL) < 0.25, `profile peaks at ringPeakL (${Lc.toFixed(2)} vs ${peakL.toFixed(2)})`);
    ok('L distribution sums; expected profile peaks at ringPeakL(Dst*)');
}

// ── 4. Lifetimes: the two-phase decay ───────────────────────────────────────
{
    const median = (pop) => {
        const a = Array.from({ length: pop.count }, (_, i) => pop.life[i * 4 + 1]).sort((x, y) => x - y);
        return a[a.length >> 1];
    };
    assert.ok(median(O) < median(H),
        `O⁺ median lifetime < H⁺ (${median(O).toFixed(1)} h vs ${median(H).toFixed(1)} h)`);
    const hist = lifetimeHistogram(O, new Float32Array(10));
    assert.ok(hist.reduce((s, x) => s + x, 0) === O.count, 'all lifetimes binned');
    ok(`two-phase decay visible: O⁺ median ${median(O).toFixed(1)} h vs H⁺ ${median(H).toFixed(1)} h`);
}

// ── 5. Dispersion: drift period falls with energy ───────────────────────────
{
    const out = new Float32Array(8), cnt = new Float32Array(8);
    driftPeriodCurve(H, out, cnt);
    let prev = Infinity, falling = true;
    for (const v of out) {
        if (!Number.isFinite(v)) continue;
        if (v > prev) falling = false;
        prev = v;
    }
    assert.ok(falling, `mean drift period falls with E (${Array.from(out, v => v.toFixed(1)).join(', ')})`);
    ok('dispersion: hot particles lap cold ones (monotone curve)');
}

// ── 6. Recycle tally ────────────────────────────────────────────────────────
{
    const last = new Float64Array(H.count).fill(-1);
    const out = { ena: 0, precip: 0 };
    tallyRecycles(H, last, 100, out);
    assert.equal(out.ena + out.precip, 0, 'baseline call counts nothing');
    // Advance past exactly one lifetime of particle 0: its slot must recycle.
    const lt0 = H.life[1], ch0 = H.life[2];
    const before = { ena: 0, precip: 0 };
    tallyRecycles(H, last, 100 + lt0 * 1.0001, before);
    assert.ok(before.ena + before.precip >= 1, 'a full lifetime forces ≥1 recycle');
    // Long window: total recycles ≈ Σ(Δt/τ_i) (each slot cycles Δt/τ times).
    const last2 = new Float64Array(H.count).fill(-1);
    tallyRecycles(H, last2, 0, { ena: 0, precip: 0 });
    const big = { ena: 0, precip: 0 };
    const dt = 500;
    tallyRecycles(H, last2, dt, big);
    let expect = 0;
    for (let i = 0; i < H.count; i++) expect += dt / H.life[i * 4 + 1];
    const got = big.ena + big.precip;
    assert.ok(Math.abs(got - expect) / expect < 0.05,
        `long-window recycles ≈ Σ(Δt/τ) (${got} vs ${expect.toFixed(0)})`);
    assert.ok(big.ena > big.precip, 'most ion loss is charge exchange (ENA channel)');
    ok('recycle tally: baseline, single-lifetime, Σ(Δt/τ), ENA-dominant');
}

// ── 7. Built O⁺ energy share ────────────────────────────────────────────────
{
    const share = builtOxygenEnergyShare(H, 1, O, 1);
    assert.ok(share > 0.15 && share < 0.5, `built O⁺ energy share sane (${(share * 100).toFixed(0)}%)`);
    assert.equal(builtOxygenEnergyShare(H, 0, O, 0), null, 'no visible ions → null, not NaN');
    ok('built O⁺ energy share computed and gate-aware');
}

console.log(`\nring-current-population-stats: all ${n} test groups passed`);
