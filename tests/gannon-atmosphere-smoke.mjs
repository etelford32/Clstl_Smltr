#!/usr/bin/env node
/**
 * gannon-atmosphere-smoke.mjs
 *
 * Pure-Node smoke test for the math half of
 * js/gannon-superstorm-atmosphere.js (the "atmosphere thickening"
 * panel on gannon-superstorm.html):
 *   1. Profiles are monotone: ρ decreases with altitude, quiet and storm.
 *   2. Storm heating thickens the atmosphere: ρ(400 km) at the Gannon
 *      Ap*-MHD peak (~300–400) is well above quiet, and the whole
 *      profile lifts (ρ_storm ≥ ρ_quiet at every altitude ≥ 200 km).
 *   3. isoAltitudeFor inverts the profile: the quiet-day 400 km density
 *      sits at ~400 km on the quiet profile, and climbs meaningfully
 *      (> +40 km) on the storm profile — the panel's headline line.
 *   4. Temperature colouring input is sane: local T rises with Ap.
 *
 * Exits 0 on pass, non-zero on failure.
 */

import assert from 'node:assert/strict';

const {
    computeProfile, isoAltitudeFor, AP_QUIET, SAT_ALT_KM, ALT_MAX_KM,
} = await import('../js/gannon-superstorm-atmosphere.js');
const { density, GANNON_F107_SFU } = await import('../js/gannon-superstorm-engine.js');

let pass = 0, fail = 0;
function check(name, fn) {
    try { fn(); pass++; console.log('  ✓', name); }
    catch (e) { fail++; console.error('  ✗', name, '\n     ', e.message); }
}

console.log('gannon-atmosphere-smoke.mjs');
console.log('───────────────────────────');

const AP_STORM = 350;   // Gannon Ap*-MHD main-phase territory
const quiet = computeProfile(AP_QUIET);
const storm = computeProfile(AP_STORM);

check('profiles are monotone decreasing in ρ', () => {
    for (const prof of [quiet, storm]) {
        for (let i = 1; i < prof.length; i++) {
            assert.ok(prof[i].rho < prof[i - 1].rho,
                `ρ not decreasing at ${prof[i].altKm} km`);
        }
    }
});

check('storm lifts the whole diffusive profile (ρ_storm ≥ ρ_quiet above 200 km)', () => {
    for (let i = 0; i < quiet.length; i++) {
        if (quiet[i].altKm < 200) continue;
        assert.ok(storm[i].rho >= quiet[i].rho,
            `storm ρ below quiet at ${quiet[i].altKm} km`);
    }
});

check('ρ(400 km) storm/quiet ratio is a real puff-up (×2 … ×50)', () => {
    const rq = density({ altitudeKm: SAT_ALT_KM, f107Sfu: GANNON_F107_SFU, ap: AP_QUIET }).rho;
    const rs = density({ altitudeKm: SAT_ALT_KM, f107Sfu: GANNON_F107_SFU, ap: AP_STORM }).rho;
    const ratio = rs / rq;
    assert.ok(ratio > 2 && ratio < 50, `ratio ${ratio.toFixed(2)} out of band`);
});

check('isoAltitudeFor recovers ~400 km on the quiet profile', () => {
    const rq400 = density({ altitudeKm: SAT_ALT_KM, f107Sfu: GANNON_F107_SFU, ap: AP_QUIET }).rho;
    const alt = isoAltitudeFor(quiet, rq400);
    assert.ok(Math.abs(alt - SAT_ALT_KM) < 8, `quiet iso at ${alt.toFixed(1)} km`);
});

check('quiet-day 400 km iso-line climbs > +40 km under storm heating', () => {
    const rq400 = density({ altitudeKm: SAT_ALT_KM, f107Sfu: GANNON_F107_SFU, ap: AP_QUIET }).rho;
    const alt = isoAltitudeFor(storm, rq400);
    assert.ok(alt > SAT_ALT_KM + 40, `storm iso only reached ${alt.toFixed(1)} km`);
    assert.ok(alt <= ALT_MAX_KM, 'iso altitude escaped the grid');
});

check('local temperature rises with Ap at every altitude', () => {
    for (let i = 0; i < quiet.length; i++) {
        assert.ok(storm[i].T >= quiet[i].T,
            `storm T below quiet at ${quiet[i].altKm} km`);
    }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
