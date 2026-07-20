#!/usr/bin/env node
/**
 * ionosphere-descent.mjs — pure-Node validation of the Track C descent
 * kernel (js/ionosphere-descent.js, M3): the disclosed vertical
 * exaggeration transform and the D/E/F column profile.
 *
 * Pins:
 *   1. E(d): exactly 1 disengaged, EXAG_MAX fully engaged, monotone in
 *      between; engagement() spans 0..1.
 *   2. Radius remaps: identity at E=1; the field-line remap is CONTINUOUS
 *      and strictly monotone through the blend band (no kink, no fold) and
 *      exact at both ends; realAltitudeKm inverts remapRadius.
 *   3. Ground speed: 0.465 km/s at the equator, →0 at the poles.
 *   4. Column: D absent at night / present by day; E persists at night but
 *      weaker; F1 merges away at night; F2 persists, rises after sunset,
 *      and takes the negative-storm density hit at high Kp.
 *
 * Exits 0 on pass, non-zero on failure.
 */

import assert from 'node:assert/strict';
import {
    EXAG_MAX, ENGAGE_FAR, ENGAGE_NEAR, FL_BLEND_LO, FL_BLEND_HI, R_E_KM,
    exaggeration, engagement, remapRadius, fieldLineWeight,
    remapFieldLineRadius, realAltitudeKm, groundSpeedKmS,
    dayFactor, columnProfile,
} from '../js/ionosphere-descent.js';
import { SCALE } from '../js/sim-clock.js';

let passed = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); passed++; };
const approx = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

// ── 1. Exaggeration tween ────────────────────────────────────────────────────
{
    assert.equal(exaggeration(10), 1, 'far: no exaggeration');
    assert.equal(exaggeration(ENGAGE_FAR), 1, 'starts exactly at ENGAGE_FAR');
    assert.equal(exaggeration(ENGAGE_NEAR), EXAG_MAX, 'fully engaged at ENGAGE_NEAR');
    assert.equal(exaggeration(1.1), EXAG_MAX, 'stays engaged below');
    let prev = exaggeration(ENGAGE_FAR);
    for (let d = ENGAGE_FAR; d >= ENGAGE_NEAR; d -= 0.01) {
        const e = exaggeration(d);
        assert.ok(e >= prev - 1e-12, `monotone at d=${d}`);
        prev = e;
    }
    approx(engagement(1), 0, 1e-12, 'engagement at E=1');
    approx(engagement(EXAG_MAX), 1, 1e-12, 'engagement at max');
    assert.equal(exaggeration(NaN), 1, 'non-finite → disengaged');
    // The sim-clock SCALE registry entry mirrors this module's max factor
    // (sim-clock is a base module and cannot import us — change together).
    assert.equal(SCALE.ATMOSPHERE_VERTICAL.maxFactor, EXAG_MAX, 'SCALE registry mirror');
    ok(`E(d): 1 → ×${EXAG_MAX} across [${ENGAGE_FAR}, ${ENGAGE_NEAR}] Rᴇ, monotone; SCALE entry pinned`);
}

// ── 2. Radius remaps ─────────────────────────────────────────────────────────
{
    approx(remapRadius(1.05, 1), 1.05, 1e-12, 'identity at E=1');
    approx(remapRadius(1 + 250 / R_E_KM, EXAG_MAX), 1 + 250 / R_E_KM * EXAG_MAX, 1e-12,
        'airglow shell inflation');

    // Field-line remap: matches the shell remap's SLOPE at the footpoint
    // (curtain bases sit on their arcs), saturates by design near the
    // curtain tops, identity above the release band — and STRICTLY
    // MONOTONE everywhere at max E (the fold-free guarantee; a naive
    // full-remap-then-blend hairpins, which is why the lift saturates).
    const E = EXAG_MAX;
    const lowAlt = 1 + 40 / R_E_KM;   // 40 km up — deep in the linear zone
    approx(remapFieldLineRadius(lowAlt, E), remapRadius(lowAlt, E),
        (E - 1) * 0.0001, 'footpoint slope matches the shell remap');
    approx(remapFieldLineRadius(FL_BLEND_HI + 0.01, E),
        FL_BLEND_HI + 0.01, 1e-9, 'untouched above the release band');
    let prevR = remapFieldLineRadius(1.0, E);
    for (let r = 1.0; r <= 3.0; r += 0.002) {
        const m = remapFieldLineRadius(r, E);
        assert.ok(m > prevR - 1e-12, `monotone (no fold) at r=${r.toFixed(3)}`);
        assert.ok(m - prevR < 0.002 * (E + 1) + 1e-9, `continuous at r=${r.toFixed(3)}`);
        prevR = m;
    }
    // Curtain-top agreement: within ~30% of the shell remap at 280 km —
    // the disclosed compression that buys the fold-free cage.
    const rTop = 1 + 280 / R_E_KM;
    const shell = remapRadius(rTop, E) - 1, cage = remapFieldLineRadius(rTop, E) - 1;
    assert.ok(cage > shell * 0.68 && cage <= shell * 1.001,
        `curtain-top lift ${cage.toFixed(3)} vs shell ${shell.toFixed(3)}`);
    assert.equal(fieldLineWeight(1.0), 1, 'weight 1 at footpoint');
    assert.equal(fieldLineWeight(FL_BLEND_HI), 0, 'weight 0 in the cage');

    // realAltitudeKm inverts remapRadius: place a point at true altitude a,
    // draw it, read the HUD number back.
    const aKm = 124;
    const drawn = remapRadius(1 + aKm / R_E_KM, EXAG_MAX);
    approx(realAltitudeKm(drawn, EXAG_MAX), aKm, 1e-6, 'HUD altitude inversion');
    ok('remaps: identity/inflation exact, blend band kink-free, HUD altitude inverts');
}

// ── 3. Ground speed ──────────────────────────────────────────────────────────
{
    approx(groundSpeedKmS(0), 0.4651, 1e-4, 'equator');
    assert.ok(groundSpeedKmS(89.9) < 0.002, 'pole → 0');
    assert.ok(groundSpeedKmS(45) > 0.3 && groundSpeedKmS(45) < 0.34, 'mid-lat');
    ok('ground speed: 0.465·cos(lat) km/s');
}

// ── 4. Column profile ────────────────────────────────────────────────────────
{
    assert.ok(dayFactor(12) === 1 && dayFactor(0) === 0, 'day factor endpoints');
    const noon = columnProfile(12, 1);
    const night = columnProfile(1, 1);
    const by = (p, k) => p.find(l => l.key === k);

    assert.equal(by(night, 'D').density, 0, 'D layer gone at night');
    assert.ok(by(noon, 'D').density > 0.4, 'D layer present at noon');
    assert.ok(by(night, 'E').density > 0.05, 'E persists at night');
    assert.ok(by(noon, 'E').density > 3 * by(night, 'E').density, 'E much weaker at night');
    assert.equal(by(night, 'F1').density, 0, 'F1 merges away at night');
    assert.ok(by(night, 'F2').density > 0.4, 'F2 persists all night');
    assert.ok(by(night, 'F2').altKm > by(noon, 'F2').altKm, 'F2 rises after sunset');
    assert.ok(by(noon, 'F2').altKm >= 250 && by(night, 'F2').altKm <= 340, 'F2 in band');

    // Negative storm: high-Kp F2 density below quiet, with the note set.
    const storm = columnProfile(12, 8.5);
    assert.ok(by(storm, 'F2').density < by(noon, 'F2').density * 0.85, 'negative storm hit');
    assert.match(by(storm, 'F2').note, /negative storm/, 'storm note');
    // Layers are bottom-up and densities normalized.
    for (const p of [noon, night, storm]) {
        for (let i = 1; i < p.length; i++) assert.ok(p[i].altKm > p[i - 1].altKm, 'bottom-up');
        for (const l of p) assert.ok(l.density >= 0 && l.density <= 1, 'density in [0,1]');
    }
    ok('column: D day-only, E weak-night, F1 merges, F2 persists/rises/storm-depletes');
}

console.log(`\nionosphere-descent: ${passed}/4 groups passed`);
