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
    rtEventId, needsNewIssue, resolveEventTruth,
    hssHoleId, resolveHssTruth, HSS_SCORE, hssArrivalWindow,
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

// ── 4. Forecast locking + truth resolution (live-loop Phases 2–3) ───────────
{
    const H = 3.6e6;
    // Deterministic event id, sanitized.
    assert.equal(rtEventId('2026-07-20T12:36:00-CME-001'),
        'PP-RT-2026-07-20T12:36:00-CME-001');
    assert.equal(rtEventId('weird id/../;'), 'PP-RT-weirdid');

    // Issue discipline: first sight → issue; jitter under 1 h → hold;
    // real kinematics revision → NEW row.
    const t0 = Date.parse('2026-07-20T00:00Z');
    assert.equal(needsNewIssue(null, t0), true);
    assert.equal(needsNewIssue(t0, t0 + 0.5 * H), false);
    assert.equal(needsNewIssue(t0, t0 + 3 * H), true);
    assert.equal(needsNewIssue(t0, NaN), false);
    ok('rtEventId deterministic; needsNewIssue: first-sight, jitter-hold, revision');

    // Truth resolution: arrived / pending / no_arrival, with the
    // data-coverage guard (a gap must NEVER become a false alarm).
    const pred = Date.parse('2026-07-22T06:00Z');
    const base = { predictedMsList: [pred], seriesStartMs: pred - 10 * 24 * H,
                   seriesEndMs: pred + 3 * 24 * H };
    // Shock 5 h after prediction → arrived, matched to that shock.
    let r = resolveEventTruth({ ...base, shocks: [pred + 5 * H], nowMs: pred + 24 * H });
    assert.equal(r.status, 'arrived');
    assert.equal(r.shockMs, pred + 5 * H);
    // Too early to judge (before predicted + RESOLVE_LAG_H) → pending.
    r = resolveEventTruth({ ...base, shocks: [], nowMs: pred + 6 * H });
    assert.equal(r.status, 'pending');
    // Window passed, series covered, no shock → false alarm.
    r = resolveEventTruth({ ...base, shocks: [], nowMs: pred + 48 * H });
    assert.equal(r.status, 'no_arrival');
    // Same, but the series ENDED before the alarm window closed → pending.
    r = resolveEventTruth({ ...base, seriesEndMs: pred + 20 * H,
                            shocks: [], nowMs: pred + 48 * H });
    assert.equal(r.status, 'pending');
    // Shock outside the ±MATCH_H window does not count as this event.
    r = resolveEventTruth({ ...base, shocks: [pred + 30 * H], nowMs: pred + 48 * H });
    assert.equal(r.status, 'no_arrival');
    // No locked predictions → nothing to resolve.
    assert.equal(resolveEventTruth({ predictedMsList: [], shocks: [],
        nowMs: 0, seriesStartMs: 0, seriesEndMs: 0 }).status, 'pending');
    ok('resolveEventTruth: arrived/pending/false-alarm + coverage guard');
}

// ── 6. HSS truth: speed rise, quiet window, coverage + timing guards ────────
{
    const T = Date.parse('2026-07-10T00:00Z');
    const startMs = T, endMs = T + 48 * H;
    const mk = (fn) => {   // 15-min series over [start−30h, end]
        const s = [];
        for (let t = startMs - 30 * H; t <= endMs; t += 0.25 * H) s.push({ t, v: fn(t) });
        return s;
    };
    const nowMs = endMs + 24 * H;
    // Clean stream: 380 baseline, ramps to 620 six hours into the window.
    const rise = mk((t) => t < startMs + 6 * H ? 380
        : Math.min(620, 380 + (t - startMs - 6 * H) / H * 40));
    const r = resolveHssTruth({ series: rise, startMs, endMs, nowMs });
    assert.equal(r.status, 'arrived');
    assert.ok(Math.abs(r.vBefore - 380) < 1);
    assert.ok(r.vPeak > 600);
    // Arrival stamps the ONSET (baseline + 50), inside the window.
    assert.ok(r.arrivalMs > startMs + 6 * H && r.arrivalMs < startMs + 10 * H);
    // Quiet window: no rise → no_arrival (the false-alarm ledger).
    const quiet = resolveHssTruth({ series: mk(() => 390), startMs, endMs, nowMs });
    assert.equal(quiet.status, 'no_arrival');
    // Too early to call, even with data.
    assert.equal(resolveHssTruth({ series: rise, startMs, endMs,
        nowMs: endMs + 1 * H }).status, 'pending');
    // Coverage guard: a data gap must NEVER read as "no stream came".
    const gappy = rise.filter((s) => s.t < startMs - 26 * H || s.t > startMs - 2 * H);
    assert.equal(resolveHssTruth({ series: gappy, startMs, endMs, nowMs }).status,
        'pending', 'missing baseline → pending');
    assert.equal(resolveHssTruth({ series: [], startMs, endMs, nowMs }).status, 'pending');
    // Ids are deterministic + binned; the corotation oracle is the ONE
    // re-exported stage oracle (spot-check it is callable from here).
    assert.equal(hssHoleId('2026-07-10T03:00Z', 22), 'HSS-2026-07-10-E20');
    assert.equal(hssHoleId('2026-07-10', -37), 'HSS-2026-07-10-W35');
    assert.ok(hssArrivalWindow(30, T).etaMs > T);
    assert.ok(HSS_SCORE.RISE_KMS > HSS_SCORE.ONSET_KMS);
    ok('HSS truth: rise/quiet/pending + coverage guard + ids + oracle');
}

console.log(`\nvalidation-scoring: all ${n} test groups passed`);
