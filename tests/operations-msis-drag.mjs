#!/usr/bin/env node
/**
 * operations-msis-drag.mjs — validation of the Operations console's
 * NRLMSISE-00 decay path (js/operations/msis-drag.js).
 *
 * Part A (pure, no WASM): pins the pieces that would otherwise drift
 * silently —
 *   1. TLE B* parsing (packed scientific format, sign/zero/garbage cases)
 *      and the B* → C_D·A/m conversion constant (12.741621).
 *   2. The fallback ladder in ballisticFromTle (unusable B* → DEFAULT_BC
 *      with the wider σ fraction).
 *   3. Log-linear profile interpolation incl. off-grid extrapolation.
 *   4. The orbit-averaged Gauss rates: ȧ < 0 under drag, ė ≈ 0 for a
 *      circular orbit.
 *   5. The decay integrator: lifetime ∝ 1/B exactly under a fixed
 *      profile (this is what makes the σ_B* term analytic), monotone in
 *      altitude and density, eccentric-perigee dominance, drag
 *      circularization (e shrinks), and the stable-orbit early exit.
 *   6. msisDecayWithSigma contract: null without a provider; with one,
 *      { model:'msis', σ > 0 } and consistency with the injected
 *      atmosphere.
 *
 * Part B (real WASM): loads the committed js/sgp4-wasm build from disk
 * and pins physical sanity of the full path — quiet-time ρ(400 km) in
 * the literature band, ρ monotone in altitude, storm indices shorten an
 * ISS-class lifetime, higher orbits outlive lower ones. These are the
 * bands an operator would notice breaking first.
 *
 * Exits 0 on pass, non-zero on failure.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
    parseBstar, bstarToBallistic, ballisticFromTle,
    BSTAR_TO_BC, DEFAULT_BC,
    makeRhoInterp, orbitAverageRates, integrateDecay,
    setDensityProvider, hasMsisProvider,
    msisDecayWithSigma, msisDeltaAPerDay, msisRhoAt,
    PROFILE_MIN_KM, PROFILE_MAX_KM, PROFILE_NPOINTS,
} from '../js/operations/msis-drag.js';

let passed = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); passed++; };
const approx = (a, b, rel, msg) =>
    assert.ok(Math.abs(a - b) <= rel * Math.max(Math.abs(a), Math.abs(b)),
        `${msg}: ${a} vs ${b}`);

// Fixed clock — msis-drag caches profiles in 3-h date buckets.
const FIXED_MS = Date.UTC(2026, 6, 1, 6, 0, 0);

// The canonical ISS TLE line from the TLE format spec — B* = −0.11606e-4.
const ISS_LINE1_NEG =
    '1 25544U 98067A   08264.51782528 -.00002182  00000-0 -11606-4 0  2927';
// Same line with the B* field (cols 54–61) swapped for a positive,
// ISS-typical value: 0.30777e-3 R_E⁻¹.
const bstarField = (line1, field) => line1.slice(0, 53) + field + line1.slice(61);
const ISS_LINE1 = bstarField(ISS_LINE1_NEG, ' 30777-3');

/* ═══ Part A — pure ═══════════════════════════════════════════════ */
console.log('Part A — pure integrator + parsing');

// ── 1. B* parsing ──
{
    approx(parseBstar(ISS_LINE1), 0.30777e-3, 1e-9, 'positive B*');
    approx(parseBstar(ISS_LINE1_NEG), -0.11606e-4, 1e-9, 'negative B*');
    assert.equal(parseBstar(bstarField(ISS_LINE1, ' 00000-0')), 0, 'zero B* parses to 0');
    assert.equal(parseBstar(bstarField(ISS_LINE1, ' 00000+0')), 0, 'zero B* (plus exp) parses to 0');
    assert.equal(parseBstar('1 25544U'), null, 'short line → null');
    assert.equal(parseBstar(bstarField(ISS_LINE1, 'garbage!')), null, 'garbage field → null');
    assert.equal(parseBstar(null), null, 'null input → null');
    approx(bstarToBallistic(1e-4), BSTAR_TO_BC * 1e-4, 1e-12, 'B*→B conversion');
    ok('parseBstar handles the packed format, signs, zeros, and garbage');
}

// ── 2. Ballistic fallback ladder ──
{
    const fromTle = ballisticFromTle({ line1: ISS_LINE1 });
    assert.equal(fromTle.source, 'tle-bstar');
    approx(fromTle.bc, BSTAR_TO_BC * 0.30777e-3, 1e-9, 'bc from TLE B*');

    const neg = ballisticFromTle({ line1: ISS_LINE1_NEG });
    assert.equal(neg.source, 'default', 'negative B* falls back');
    assert.equal(neg.bc, DEFAULT_BC);

    const zero = ballisticFromTle({ line1: bstarField(ISS_LINE1, ' 00000-0') });
    assert.equal(zero.source, 'default', 'zero B* falls back');

    const noLine = ballisticFromTle({});
    assert.equal(noLine.source, 'default', 'missing line1 falls back');

    const fromOmm = ballisticFromTle({ bstar: 0.30777e-3, source_format: 'omm-json' });
    assert.equal(fromOmm.source, 'omm-bstar');
    approx(fromOmm.bc, BSTAR_TO_BC * 0.30777e-3, 1e-9, 'bc from OMM B*');

    assert.ok(neg.sigmaFrac > fromTle.sigmaFrac, 'fallback carries wider σ');
    ok('ballisticFromTle prefers usable TLE B*, falls back with wider σ');
}

// Analytic exponential test atmosphere: ρ(200 km) = 1e-11, H = 60 km.
const RHO0 = 1e-11, H_KM = 60;
const analyticRho = alt => RHO0 * Math.exp(-(alt - 200) / H_KM);

// ── 3. Profile interpolation ──
{
    const n = 151, alt0 = 90, step = 10;
    const rho = new Float64Array(n);
    for (let i = 0; i < n; i++) rho[i] = analyticRho(alt0 + i * step);
    const interp = makeRhoInterp({ alt0, step, rho });
    approx(interp(405), analyticRho(405), 1e-3, 'in-grid log-linear');
    approx(interp(90), analyticRho(90), 1e-9, 'grid edge exact');
    approx(interp(70), analyticRho(70), 0.05, 'below-grid extrapolation');
    // This H=60 test atmosphere is unrealistically steep above the grid
    // (real MSIS top-side scale heights are hundreds of km), so the
    // extrapolation there correctly lands on the 1e-19 kg/m³ floor.
    assert.equal(interp(1650), 1e-19, 'off-grid density floors at 1e-19');
    // Shallow top-side (H = 300 km, exosphere-like): extrapolation
    // follows the edge log-slope faithfully.
    const shallow = alt => 1e-14 * Math.exp(-(alt - 800) / 300);
    const rho2 = new Float64Array(n);
    for (let i = 0; i < n; i++) rho2[i] = shallow(alt0 + i * step);
    const interp2 = makeRhoInterp({ alt0, step, rho: rho2 });
    approx(interp2(1700), shallow(1700), 0.05, 'above-grid extrapolation (shallow)');
    ok('makeRhoInterp is log-linear in-grid, extrapolates on edge slopes, floors off-grid');
}

// ── 4. Orbit-averaged rates ──
{
    const circ = orbitAverageRates(6378.135 + 400, 0, 0.01, analyticRho);
    assert.ok(circ.adotKmDay < 0, 'circular ȧ < 0 under drag');
    assert.ok(Math.abs(circ.edotPerDay) < 1e-12, `circular ė ≈ 0 (got ${circ.edotPerDay})`);

    const ecc = orbitAverageRates(6378.135 + 600, 0.03, 0.01, analyticRho);
    assert.ok(ecc.adotKmDay < 0, 'eccentric ȧ < 0');
    assert.ok(ecc.edotPerDay < 0, 'drag circularizes: ė < 0');
    ok('Gauss rates: ȧ < 0 always, ė < 0 only when eccentric');
}

// ── 5. Decay integration ──
{
    const base = { perigeeKm: 400, apogeeKm: 410, rhoAt: analyticRho };

    const r1 = integrateDecay({ ...base, bc: 0.01 });
    assert.ok(r1.reentered, '400 km orbit reenters');
    assert.ok(Number.isFinite(r1.lifetimeDays) && r1.lifetimeDays > 0);
    assert.ok(r1.dadtKmDay < 0, 'initial ȧ < 0');

    // Lifetime ∝ 1/B under a fixed profile (the analytic σ_B* premise).
    const r2 = integrateDecay({ ...base, bc: 0.02 });
    approx(r1.lifetimeDays / r2.lifetimeDays, 2, 0.02, 'lifetime ∝ 1/B');

    // Monotone in altitude and in density scale.
    const rHigh = integrateDecay({ perigeeKm: 500, apogeeKm: 510, bc: 0.01, rhoAt: analyticRho });
    assert.ok(rHigh.lifetimeDays > r1.lifetimeDays, 'higher orbit lives longer');
    const rDense = integrateDecay({ ...base, bc: 0.01, rhoAt: alt => 3 * analyticRho(alt) });
    assert.ok(rDense.lifetimeDays < r1.lifetimeDays, 'denser atmosphere is deadlier');

    // A 200×1000 eccentric orbit's perigee drag beats a 600-circular's.
    const rEcc  = integrateDecay({ perigeeKm: 200, apogeeKm: 1000, bc: 0.01, rhoAt: analyticRho });
    const rCirc = integrateDecay({ perigeeKm: 600, apogeeKm: 600,  bc: 0.01, rhoAt: analyticRho });
    assert.ok(rEcc.lifetimeDays < rCirc.lifetimeDays, 'perigee drag dominates');

    // Circularization en route.
    const e0 = (1000 - 200) / (2 * (6378.135 + 600));
    assert.ok(rEcc.finalE < e0, `e shrinks under drag (${rEcc.finalE} < ${e0})`);

    // Stable early-exit: 1500 km in this atmosphere decays ~nothing.
    const rStable = integrateDecay({ perigeeKm: 1500, apogeeKm: 1500, bc: 0.01, rhoAt: analyticRho });
    assert.equal(rStable.lifetimeDays, Infinity, 'quiet high orbit → Infinity');
    ok('integrateDecay: 1/B scaling, monotonicity, perigee dominance, circularization, stable exit');
}

// ── 6. msisDecayWithSigma contract ──
{
    const tle = { perigee_km: 400, apogee_km: 410, line1: ISS_LINE1 };
    assert.equal(hasMsisProvider(), false);
    assert.equal(msisDecayWithSigma(tle, 150, 12, 15, 6), null, 'null without provider');
    assert.equal(msisDeltaAPerDay(tle, 150, 15), null);
    assert.equal(msisRhoAt(400, 150, 15), null);

    // Inject the analytic atmosphere as a provider (index-independent —
    // this test pins the CONTRACT, not the atmosphere response).
    const step = (PROFILE_MAX_KM - PROFILE_MIN_KM) / (PROFILE_NPOINTS - 1);
    setDensityProvider(() => {
        const rho = new Float64Array(PROFILE_NPOINTS);
        for (let i = 0; i < PROFILE_NPOINTS; i++) rho[i] = analyticRho(PROFILE_MIN_KM + i * step);
        return { alt0: PROFILE_MIN_KM, step, rho };
    }, { getDateMs: () => FIXED_MS });

    const r = msisDecayWithSigma(tle, 150, 12, 15, 6);
    assert.ok(r && r.model === 'msis', 'model tag');
    assert.equal(r.bcSource, 'tle-bstar');
    assert.ok(Number.isFinite(r.lifetime_days) && r.lifetime_days > 0);
    assert.ok(r.sigma_days > 0, 'σ > 0');
    assert.ok(r.dadt_km_day < 0, 'ȧ < 0');
    approx(r.bstar, 0.30777e-3, 1e-9, 'B* echoed');

    const dadt = msisDeltaAPerDay(tle, 150, 15);
    assert.ok(dadt < 0, 'msisDeltaAPerDay < 0');
    approx(msisRhoAt(400, 150, 15), analyticRho(400), 1e-3, 'msisRhoAt reads the profile');

    // High perigee shortcuts to stable without a provider round-trip.
    const geoish = msisDecayWithSigma({ perigee_km: 35786, apogee_km: 35786 }, 150, 12, 15, 6);
    assert.equal(geoish.lifetime_days, Infinity, 'high perigee → stable');
    ok('msisDecayWithSigma: null → provider → tagged result with σ and ȧ');
}

/* ═══ Part B — real NRLMSISE-00 WASM ══════════════════════════════ */
console.log('Part B — committed NRLMSISE-00 WASM');

const { default: initWasm, nrlmsise00_density_profile, nrlmsise00_profile_stride } =
    await import('../js/sgp4-wasm/sgp4_wasm.js');
const wasmBytes = await readFile(new URL('../js/sgp4-wasm/sgp4_wasm_bg.wasm', import.meta.url));
await initWasm({ module_or_path: wasmBytes });

function doyOf(d) {
    return Math.floor((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 0)) / 86400000);
}

// Equatorial day/night-averaged provider — the same shape the browser
// glue in startMsisDecay builds, minus the bridge's f107a/ap-history
// refinements (scalar fills here; node has no feed endpoints).
setDensityProvider(({ f107, ap, dateMs }) => {
    const date  = new Date(dateMs);
    const doy   = doyOf(date);
    const sec   = date.getUTCHours() * 3600 + date.getUTCMinutes() * 60;
    const utHr  = sec / 3600;
    const step  = (PROFILE_MAX_KM - PROFILE_MIN_KM) / (PROFILE_NPOINTS - 1);
    const alts  = new Float64Array(PROFILE_NPOINTS);
    for (let i = 0; i < PROFILE_NPOINTS; i++) alts[i] = PROFILE_MIN_KM + i * step;
    const apArr = new Float64Array(7).fill(ap);
    const stride = nrlmsise00_profile_stride();
    const rho = new Float64Array(PROFILE_NPOINTS);
    for (const lst of [0, 12]) {
        const lon  = ((lst - utHr) * 15 + 540) % 360 - 180;
        const flat = nrlmsise00_density_profile(
            date.getUTCFullYear(), doy, sec, 0, lon, lst, f107, f107, apArr, alts);
        for (let i = 0; i < PROFILE_NPOINTS; i++) rho[i] += 0.5 * flat[i * stride + 6];
    }
    return { alt0: PROFILE_MIN_KM, step, rho };
}, { getDateMs: () => FIXED_MS });

// ── 7. Physical density sanity ──
{
    const rho400 = msisRhoAt(400, 150, 15);
    assert.ok(rho400 > 1e-13 && rho400 < 2e-11,
        `quiet ρ(400 km) in the literature band (got ${rho400})`);
    assert.ok(msisRhoAt(500, 150, 15) < rho400, 'ρ falls with altitude');
    assert.ok(msisRhoAt(300, 150, 15) > rho400, 'ρ rises coming down');
    const rhoStorm = msisRhoAt(400, 230, 300);
    assert.ok(rhoStorm > 1.5 * rho400,
        `storm inflates ρ(400 km) (${rhoStorm} vs ${rho400})`);
    ok('MSIS ρ: quiet-time band, altitude monotonicity, storm inflation');
}

// ── 8. ISS-class decay under MSIS ──
{
    const iss = { perigee_km: 415, apogee_km: 425, line1: ISS_LINE1 };
    const quiet = msisDecayWithSigma(iss, 150, 12, 15, 6);
    assert.ok(quiet.model === 'msis' && quiet.bcSource === 'tle-bstar');
    assert.ok(Number.isFinite(quiet.lifetime_days), 'ISS-class lifetime finite');
    assert.ok(quiet.lifetime_days > 100 && quiet.lifetime_days < 15000,
        `ISS-class lifetime plausible (got ${quiet.lifetime_days} d)`);
    assert.ok(quiet.dadt_km_day < -0.001 && quiet.dadt_km_day > -1,
        `ISS-class ȧ plausible (got ${quiet.dadt_km_day} km/day)`);
    assert.ok(quiet.sigma_days > 0.3 * quiet.lifetime_days,
        'σ carries the B* doubt (≥ the ±35 % floor)');

    const storm = msisDecayWithSigma(iss, 230, 12, 300, 50);
    assert.ok(storm.lifetime_days < 0.6 * quiet.lifetime_days,
        `G5-class indices slash the lifetime (${storm.lifetime_days} vs ${quiet.lifetime_days})`);

    const starlink = msisDecayWithSigma(
        { perigee_km: 545, apogee_km: 555, line1: ISS_LINE1 }, 150, 12, 15, 6);
    assert.ok(!Number.isFinite(starlink.lifetime_days)
        || starlink.lifetime_days > quiet.lifetime_days,
        '550 km outlives 420 km');

    const high = msisDecayWithSigma(
        { perigee_km: 800, apogee_km: 810, line1: ISS_LINE1 }, 150, 12, 15, 6);
    assert.ok(!Number.isFinite(high.lifetime_days) || high.lifetime_days > 3650,
        `800 km survives a decade+ (got ${high.lifetime_days})`);
    ok('MSIS decay: ISS-class bands, storm response, altitude ordering');
}

console.log(`\nAll ${passed} checks passed.`);
