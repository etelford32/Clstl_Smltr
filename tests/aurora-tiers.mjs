// aurora-tiers.mjs — fixture gate for the pure tier logic behind the
// per-subscriber aurora sender (api/_lib/aurora-tiers.js — the Phase 4
// alert-sender fix).
//
//   node tests/aurora-tiers.mjs

import assert from 'node:assert/strict';
import {
    kpFromMinBz, evaluateTier, shouldSend, tierEmail, TIER_RANK,
} from '../api/_lib/aurora-tiers.js';

let n = 0;
const ok = (msg) => { n++; console.log(`  ✓ ${msg}`); };
const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 6, 20, 12, 0, 0);

// ── kpFromMinBz anchors ──────────────────────────────────────────────────────
{
    assert.equal(kpFromMinBz(-25), 9);
    assert.equal(kpFromMinBz(-40), 9, 'clamped at 9');
    assert.equal(kpFromMinBz(-10), 6);
    assert.equal(kpFromMinBz(-5), 4);
    const mid = kpFromMinBz(-12.5);
    assert.ok(mid > 6 && mid < 7, `interpolates between anchors (${mid})`);
    assert.equal(kpFromMinBz(NaN), null);
    ok('kpFromMinBz: anchors, interpolation, clamps');
}

// ── Tier evaluation ──────────────────────────────────────────────────────────
const fluxRope = (o = {}) => ({
    pHit: 0.7, p10: 0.5, p20: 0.2,
    arrivalP10Ms: NOW + 30 * HOUR, arrivalP50Ms: NOW + 38 * HOUR,
    arrivalP90Ms: NOW + 46 * HOUR, minBzP50: -16, ...o,
});

{
    // Nowcast beats everything.
    const e = evaluateTier({ nowMs: NOW, observedKp: 6.3, kpForecast: [], fluxRope: null, kpThreshold: 5 });
    assert.equal(e.tier, 'nowcast');
    assert.match(e.detail, /observed now/);
    ok('nowcast: observed Kp at threshold');

    // SWPC 3-day inside 24 h → warning; beyond → watch.
    const fc24 = [{ tMs: NOW + 10 * HOUR, kp: 6 }];
    assert.equal(evaluateTier({ nowMs: NOW, observedKp: 2, kpForecast: fc24, fluxRope: null, kpThreshold: 5 }).tier, 'warning');
    const fc72 = [{ tMs: NOW + 50 * HOUR, kp: 6 }];
    assert.equal(evaluateTier({ nowMs: NOW, observedKp: 2, kpForecast: fc72, fluxRope: null, kpThreshold: 5 }).tier, 'watch');
    ok('SWPC horizons: <24 h warning, 1–3 d watch');

    // Flux-rope layers: window beyond 24 h → watch; sliding inside → warning.
    const w = evaluateTier({ nowMs: NOW, observedKp: 2, kpForecast: [], fluxRope: fluxRope(), kpThreshold: 5 });
    assert.equal(w.tier, 'watch');
    assert.equal(w.via, 'flux-rope');
    assert.match(w.detail, /P\(hit\) 70%/);
    const warn = evaluateTier({
        nowMs: NOW, observedKp: 2, kpForecast: [],
        fluxRope: fluxRope({ arrivalP10Ms: NOW + 6 * HOUR, arrivalP50Ms: NOW + 12 * HOUR, arrivalP90Ms: NOW + 20 * HOUR }),
        kpThreshold: 5,
    });
    assert.equal(warn.tier, 'warning');
    ok('flux-rope: arrival window drives watch → warning');

    // A weak rope (Kp estimate below threshold) or a likely miss fires nothing.
    assert.equal(evaluateTier({
        nowMs: NOW, observedKp: 2, kpForecast: [],
        fluxRope: fluxRope({ minBzP50: -4 }), kpThreshold: 6,
    }).tier, null);
    assert.equal(evaluateTier({
        nowMs: NOW, observedKp: 2, kpForecast: [],
        fluxRope: fluxRope({ pHit: 0.2 }), kpThreshold: 5,
    }).tier, null);
    ok('quiet paths: weak rope / likely miss / calm NOAA → no tier');

    // Threshold honors the SUBSCRIBER (the whole point of the fix).
    const hi = evaluateTier({ nowMs: NOW, observedKp: 5.5, kpForecast: [], fluxRope: null, kpThreshold: 7 });
    assert.equal(hi.tier, null, 'Kp 5.5 must NOT alert a Kp-7 subscriber');
    const lo = evaluateTier({ nowMs: NOW, observedKp: 5.5, kpForecast: [], fluxRope: null, kpThreshold: 3.5 });
    assert.equal(lo.tier, 'nowcast');
    ok('per-subscriber thresholds respected (the write-only-columns fix)');
}

// ── Debounce / escalation ────────────────────────────────────────────────────
{
    assert.equal(TIER_RANK.nowcast > TIER_RANK.warning && TIER_RANK.warning > TIER_RANK.watch, true);
    // First contact fires; same tier within cooldown does not; escalation does.
    assert.equal(shouldSend({ tier: 'watch', lastTier: null, lastAtMs: NaN, nowMs: NOW }), true);
    assert.equal(shouldSend({ tier: 'watch', lastTier: 'watch', lastAtMs: NOW - 2 * HOUR, nowMs: NOW }), false);
    assert.equal(shouldSend({ tier: 'warning', lastTier: 'watch', lastAtMs: NOW - 2 * HOUR, nowMs: NOW }), true);
    assert.equal(shouldSend({ tier: 'watch', lastTier: 'watch', lastAtMs: NOW - 25 * HOUR, nowMs: NOW }), true);
    // De-escalation never re-fires inside the cooldown.
    assert.equal(shouldSend({ tier: 'watch', lastTier: 'nowcast', lastAtMs: NOW - 2 * HOUR, nowMs: NOW }), false);
    assert.equal(shouldSend({ tier: null, lastTier: 'watch', lastAtMs: NOW - 90 * HOUR, nowMs: NOW }), false);
    ok('shouldSend: escalation immediate, same-tier cooldown, no de-escalation spam');
}

// ── Email content ────────────────────────────────────────────────────────────
{
    const m = tierEmail({
        tier: 'warning', detail: 'CME inbound — est. Kp 7.0', city: 'Tromsø',
        siteUrl: 'https://parkersphysics.com', unsubUrl: 'https://parkersphysics.com/api/subscribe/unsubscribe?token=x',
    });
    assert.match(m.subject, /warning/i);
    assert.match(m.html, /AURORA WARNING/);
    assert.match(m.html, /CME inbound/);
    assert.match(m.html, /unsubscribe\?token=x/);
    const now = tierEmail({ tier: 'nowcast', detail: 'Kp 6.1 observed now', city: null, siteUrl: 's', unsubUrl: 'u' });
    assert.match(now.subject, /now/);
    ok('tierEmail: tiered subjects, detail + unsubscribe link embedded');
}

console.log(`\naurora-tiers: ${n} checks passed`);
