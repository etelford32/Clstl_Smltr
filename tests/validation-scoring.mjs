#!/usr/bin/env node
/**
 * validation-scoring.mjs — node tests for the shared scoring engine's
 * CME-arrival verification (js/validation-scoring.js). The back-mapping
 * and recurrence engines are covered by the CLI scripts' selftests
 * (scripts/backmap-validation.mjs --selftest, scripts/recurrence-
 * validation.mjs --selftest); this file covers the third loop.
 */

import assert from 'node:assert/strict';
import {
    detectShockArrivals, scoreCmeArrivals, CME_SCORE,
} from '../js/validation-scoring.js';

let n = 0;
const ok = (msg) => { n++; console.log(`  ✓ ${msg}`); };
const H = 3.6e6;

// ── 1. Shock detection: clean step, collapse, quiet series ──────────────────
{
    const t0 = Date.UTC(2026, 6, 8);
    const series = [];
    for (let m = 0; m < 24 * 60; m += 15) {
        // Quiet 1.5 nPa, stepping to 6 nPa at t0+10 h (a real shock), with a
        // secondary spike 2 h later (same event — must collapse).
        const t = t0 + m * 60000;
        let pdyn = 1.5;
        if (m >= 10 * 60) pdyn = 6;
        if (m >= 12 * 60 && m < 12 * 60 + 15) pdyn = 14;
        series.push({ t, pdyn });
    }
    const shocks = detectShockArrivals(series);
    assert.equal(shocks.length, 1, `collapse: got ${shocks.length}`);
    assert.ok(Math.abs(shocks[0] - (t0 + 10 * H)) <= 15 * 60000, 'shock at the step');
    // Quiet series: nothing.
    assert.deepEqual(detectShockArrivals(series.map(p => ({ t: p.t, pdyn: 1.5 }))), []);
    // A 2× step that stays under the 2.5 nPa floor is NOT a shock (0.8 → 1.8).
    const weak = series.map((p, i) => ({ t: p.t, pdyn: i < 40 ? 0.8 : 1.8 }));
    assert.deepEqual(detectShockArrivals(weak), []);
    assert.deepEqual(detectShockArrivals(null), []);
    ok('detectShockArrivals: step found once, spikes collapse, floors respected');
}

// ── 2. Arrival scoring: hits, misses, basis split, cross-check ──────────────
{
    const t0 = Date.UTC(2026, 6, 8);
    const shock = t0 + 30 * H;
    const shocks = [shock];
    const preds = [
        // ENLIL-based, 4 h early → matched, hit; ballistic pair was 9 h early
        // → ENLIL closer (the cross-check).
        { id: 'a', basis: 'enlil', etaMs: shock - 4 * H, enlilEtaMs: shock - 4 * H, ballisticEtaMs: shock - 9 * H },
        // Ballistic-only, 14 h late → matched (≤18) but not a hit (>12).
        { id: 'b', basis: 'ballistic', etaMs: shock + 14 * H, ballisticEtaMs: shock + 14 * H },
        // Prediction with no shock anywhere near → unmatched.
        { id: 'c', basis: 'ballistic', etaMs: shock + 60 * H, ballisticEtaMs: shock + 60 * H },
    ];
    const s = scoreCmeArrivals(preds, shocks);
    assert.equal(s.n, 3);
    assert.equal(s.matched, 2);
    assert.equal(s.hits, 1);
    assert.ok(Math.abs(s.maeHours - 9) < 0.01, `MAE ${s.maeHours}`);   // (4 + 14) / 2
    assert.equal(s.byBasis.enlil.n, 1);
    assert.ok(Math.abs(s.byBasis.enlil.maeHours - 4) < 0.01);
    assert.equal(s.byBasis.ballistic.n, 1);
    assert.equal(s.crossCheck.n, 1);
    assert.equal(s.crossCheck.enlilCloser, 1);
    // Empty inputs are safe.
    assert.equal(scoreCmeArrivals([], shocks).n, 0);
    assert.equal(scoreCmeArrivals(preds, []).matched, 0);
    ok('scoreCmeArrivals: hit/late/unmatched, per-basis MAE, ENLIL-vs-ballistic cross-check');
}

// ── 3. Constants sanity (they define the published method) ──────────────────
{
    assert.equal(CME_SCORE.HIT_H, 12);
    assert.equal(CME_SCORE.MATCH_H, 18);
    assert.equal(CME_SCORE.SHOCK_RATIO, 2);
    ok('CME_SCORE constants pinned (±12 h hit, ±18 h match, 2× shock)');
}

console.log(`\nvalidation-scoring: all ${n} test groups passed`);
