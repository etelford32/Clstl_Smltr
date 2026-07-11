#!/usr/bin/env node
/**
 * sim-clock.mjs — pure-Node validation of js/sim-clock.js against the
 * guiding invariant of RING_CURRENT_VISUAL_PLAN.md:
 *
 *   apparent speed = physical velocity × τ ÷ local spatial scale
 *
 *   1. τ=1 identity: simTime ≡ wall time, never wraps.
 *   2. Compression: simTime advances at exactly τ× wall rate.
 *   3. Wrap: the sweep folds back to the live present after windowMs,
 *      bumping `wraps` (subscribers reset per-sweep bookkeeping on it).
 *   4. setTau re-anchors to the wall present and bumps `wraps`.
 *   5. dSim scales wall deltas by τ.
 *   6. SCALE registry: near-Earth 1 Rᴇ/unit; corridor ≈34,900 km/unit
 *      (≈5.5× compression), consistent with corridor span × kmPerUnit
 *      recovering the L1→magnetopause distance.
 *   7. The plan's sanity-check table at τ=300: a 500 km/s parcel ≈4.3
 *      units/s (streams); a ~4.2 km/s ring-ion drift ≈0.8 units/s
 *      (stately); on-screen ratio ≈5–6:1.
 *   8. ETA mapping: 26 real minutes ≈ 5.2 s of viewing at ×300.
 *
 * Exits 0 on pass, non-zero on failure.
 */

import assert from 'node:assert/strict';
import {
    SimClock, SCALE, TAU_PRESETS, TAU_DEFAULT,
    apparentUnitsPerSec, simSecondsForRealMinutes,
} from '../js/sim-clock.js';
import { PHYS, driftPeriodHours } from '../js/ring-current-model.js';

let n = 0;
const ok = (msg) => { n++; console.log(`  ✓ ${msg}`); };

// Injectable wall clock.
function fakeTime(startMs = 1_700_000_000_000) {
    let t = startMs;
    const src = () => t;
    src.advance = (ms) => { t += ms; };
    src.now = () => t;
    return src;
}

// ── 1. τ=1 identity ─────────────────────────────────────────────────────────
{
    const time = fakeTime();
    const c = new SimClock({ tau: 1, timeSource: time });
    const w0 = c.wraps;
    for (const step of [16, 1000, 60_000, 3.6e6, 24 * 3.6e6]) {
        time.advance(step);
        assert.equal(c.now(), time.now(), `τ=1 sim ≡ wall after +${step} ms`);
    }
    assert.equal(c.wraps, w0, 'τ=1 never wraps');
    assert.equal(c.tau, 1);
    assert.equal(c.label, '×1');
    ok('τ=1: simTime ≡ wall time exactly, no wraps');
}

// ── 2. Compression rate ─────────────────────────────────────────────────────
{
    const time = fakeTime();
    const c = new SimClock({ tau: 300, timeSource: time });
    const wall0 = time.now();
    time.advance(1000);                       // +1 wall second
    assert.equal(c.now() - wall0, 300_000, '1 wall s ⇒ 300 sim s at ×300');
    ok('compression: simTime advances at τ× wall rate');
}

// ── 3. Wrap within the forecast window ──────────────────────────────────────
{
    const time = fakeTime();
    const windowMs = 75 * 60_000;
    const c = new SimClock({ tau: 300, windowMs, timeSource: time });
    const w0 = c.wraps;
    // Sweep the full window: needs windowMs/τ of wall time (~15 s + ε).
    time.advance(Math.ceil(windowMs / 300) + 1000);
    const sim = c.now();
    assert.equal(c.wraps, w0 + 1, 'sweep past window end wraps once');
    assert.equal(sim, time.now(), 'wrap re-anchors sim to the live present');
    // Just before the boundary: no wrap.
    const c2 = new SimClock({ tau: 300, windowMs, timeSource: time });
    const w2 = c2.wraps;
    time.advance(Math.floor(windowMs / 300) - 1000);
    c2.now();
    assert.equal(c2.wraps, w2, 'no wrap before the window end');
    ok('wrap: honest fast-forward folds back to now after the window');
}

// ── 4. setTau re-anchors ────────────────────────────────────────────────────
{
    const time = fakeTime();
    const c = new SimClock({ tau: 300, timeSource: time });
    time.advance(5000);                       // sim is now 25 min ahead
    assert.ok(c.now() > time.now(), 'compressed sim runs ahead of wall');
    const w0 = c.wraps;
    c.setTau(1);
    assert.equal(c.wraps, w0 + 1, 'setTau bumps wraps (sweep restarted)');
    assert.equal(c.now(), time.now(), 'setTau(1) snaps sim back to wall — Real mode is exactly real');
    c.setTau(0.25);                            // clamped: τ ≥ 1
    assert.equal(c.tau, 1);
    c.setTau(NaN);
    assert.equal(c.tau, 1);
    ok('setTau: re-anchors to the present, clamps τ ≥ 1');
}

// ── 5. dSim ─────────────────────────────────────────────────────────────────
{
    const c = new SimClock({ tau: 60, timeSource: fakeTime() });
    assert.equal(c.dSim(1000), 60_000);
    assert.equal(c.dSim(NaN), 0);
    assert.deepEqual(TAU_PRESETS, [1, 60, 300, 1000]);
    assert.ok(TAU_PRESETS.includes(TAU_DEFAULT), 'default τ is a preset');
    ok('dSim scales wall deltas by τ; presets include the default');
}

// ── 6. SCALE registry ───────────────────────────────────────────────────────
{
    assert.equal(SCALE.NEAR_EARTH.kmPerUnit, PHYS.R_E_M / 1000);   // 1 unit = 1 R_E
    const corr = SCALE.CORRIDOR;
    assert.equal(corr.SPAN, corr.X_SUN - corr.X_MP);
    // Corridor span × kmPerUnit recovers the real L1→magnetopause distance.
    const realKm = corr.SPAN * corr.kmPerUnit;
    assert.ok(Math.abs(realKm - (PHYS.L1_KM - corr.X_MP * 6371)) < 1,
        `corridor covers L1 distance (${realKm} km)`);
    const compression = corr.kmPerUnit / SCALE.NEAR_EARTH.kmPerUnit;
    assert.ok(compression > 5.3 && compression < 5.7,
        `corridor ≈5.5× more compressed (got ${compression.toFixed(2)}×)`);
    ok('SCALE: near-Earth 1 Rᴇ/unit, corridor ≈5.5× compressed, spans L1');
}

// ── 7. The plan's sanity-check table (τ = 300) ──────────────────────────────
{
    const circKm = (L) => 2 * Math.PI * L * (PHYS.R_E_M / 1000);
    const vDriftKmS = (eKev, L) => circKm(L) / (driftPeriodHours(eKev, L) * 3600);

    // Solar wind parcel: 500 km/s through the corridor scale.
    const stream = apparentUnitsPerSec(500, SCALE.CORRIDOR.kmPerUnit, 300);
    assert.ok(stream > 3.8 && stream < 4.8, `stream ${stream.toFixed(2)} u/s — streams`);

    // Cold end of the population (20 keV, L=4): the plan's "stately ~5 km/s"
    // anchor — drift period ≈ 9 h.
    const vCold = vDriftKmS(20, 4);
    assert.ok(vCold > 3.5 && vCold < 6, `20 keV ion drifts ${vCold.toFixed(1)} km/s (~5 km/s)`);
    assert.ok(driftPeriodHours(20, 4) > 7 && driftPeriodHours(20, 4) < 12,
        'cold-ion drift period in the 5–10+ h band');

    // Population median (~70 keV log-uniform 20–250): the visually typical ion.
    const vMed = vDriftKmS(70, 4);
    assert.ok(vMed > 12 && vMed < 22, `70 keV ion drifts ${vMed.toFixed(1)} km/s`);
    const ring = apparentUnitsPerSec(vMed, SCALE.NEAR_EARTH.kmPerUnit, 300);
    assert.ok(ring > 0.5 && ring < 1.2, `ring ${ring.toFixed(2)} u/s — stately`);

    // On-screen ratio ≈4–7:1 (vs physical ~30:1 for the median ion, ~100:1
    // for the cold end) because the corridor is more spatially compressed —
    // the disclosed trade.
    const ratio = stream / ring;
    assert.ok(ratio > 4 && ratio < 8, `stream:ring on screen ${ratio.toFixed(1)}:1`);
    const physRatioCold = 500 / vCold;
    assert.ok(physRatioCold > 80 && physRatioCold < 150,
        `physical ratio (cold end) ${physRatioCold.toFixed(0)}:1`);

    // Energy shear: drift speed ∝ energy — hot particles lap cold ones.
    assert.ok(vDriftKmS(250, 4) / vDriftKmS(20, 4) > 10, 'ring visibly shears with energy');

    // Zero/invalid guards.
    assert.equal(apparentUnitsPerSec(NaN, 6371, 300), 0);
    assert.equal(apparentUnitsPerSec(500, 0, 300), 0);
    ok(`invariant table: stream ${stream.toFixed(1)} u/s vs ring ${ring.toFixed(2)} u/s (≈${ratio.toFixed(0)}:1 on screen; cold-end physical ${physRatioCold.toFixed(0)}:1)`);
}

// ── 8. ETA mapping ──────────────────────────────────────────────────────────
{
    const s = simSecondsForRealMinutes(26, 300);
    assert.ok(Math.abs(s - 5.2) < 0.01, `26 min at ×300 ⇒ ${s} s`);
    assert.equal(simSecondsForRealMinutes(26, 1), 26 * 60);
    assert.equal(simSecondsForRealMinutes(NaN, 300), null);
    ok('ETA: 26 real minutes ≈ 5.2 s of viewing at ×300');
}

console.log(`\nsim-clock: all ${n} test groups passed`);
