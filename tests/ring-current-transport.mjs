#!/usr/bin/env node
/**
 * ring-current-transport.mjs — pure-Node validation of the bounce-averaged
 * ring-current transport core (js/ring-current-transport.js).
 *
 * Pins the physics that would otherwise silently drift:
 *   1. Drift signs/magnitudes: corotation = +Ω_E eastward; grad-curv matches
 *      driftPeriodHours and is westward for ions; convection E×B is inward on
 *      the nightside, outward on the dayside; A(Kp) grows with Kp.
 *   2. Radial diffusion conserves total content (no-flux walls) and spreads.
 *   3. Charge-exchange loss decays as e^(−t/τ) and O⁺ dies faster than H⁺.
 *   4. Azimuthal (MLT-periodic) advection conserves content exactly.
 *   5. Storm response: a strong driver builds a main phase in the strong-storm
 *      Dst band, with the ring peaking near L≈4 in the dusk–midnight sector
 *      (emergent partial ring), an emergent O⁺ enhancement, then recovers.
 *   6. Determinism.
 *
 * Exits 0 on pass, non-zero on failure.
 */

import assert from 'node:assert/strict';
import {
    RingCurrentTransport, SPECIES, convectionAmplitude, driftAt,
} from '../js/ring-current-transport.js';
import { driftPeriodHours, chargeExchangeLifetimeHours } from '../js/ring-current-model.js';

const OMEGA_E = 7.2921159e-5;
let passed = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); passed++; };
const approx = (a, b, rel = 1e-6, msg = '') =>
    assert.ok(Math.abs(a - b) <= rel * Math.max(1, Math.abs(b)), `${msg} ${a} vs ${b}`);

// ── 1. Drift physics ─────────────────────────────────────────────────────────
{
    // Corotation only (convA=0, negligible-energy grad-curv): +Ω eastward, no radial.
    const d = driftAt(4, 1.0, 1e-3, 0);
    approx(d.dAzdt, OMEGA_E, 1e-3, 'corotation rate');
    assert.ok(Math.abs(d.dLdt) < 1e-15, 'no radial drift without convection');

    // Grad-curv component equals −2π/T_drift (driftPeriodHours), so subtracting
    // it recovers the corotation rate exactly.
    const T = driftPeriodHours(100, 4);
    const d2 = driftAt(4, 0, 100, 0);
    approx(d2.dAzdt + 2 * Math.PI / (T * 3600), OMEGA_E, 1e-9, 'grad-curv magnitude');
    assert.ok(d2.dAzdt < 0, 'energetic ion drifts net westward');

    // Convection: inward on the nightside (midnight az=0), outward at noon (az=π).
    const A6 = convectionAmplitude(6);
    assert.ok(driftAt(4, 0, 100, A6).dLdt < 0, 'nightside convection is inward');
    assert.ok(driftAt(4, Math.PI, 100, A6).dLdt > 0, 'dayside convection is outward');

    // A(Kp) strengthens with Kp across the storm range.
    assert.ok(convectionAmplitude(7) > convectionAmplitude(3), 'A(Kp) grows with Kp');
    assert.ok(convectionAmplitude(3) > convectionAmplitude(1), 'A(Kp) grows with Kp (low)');
    ok('drift: corotation +Ω, grad-curv = 2π/T westward, convection in/out, A(Kp)↑');
}

// ── 2. Radial diffusion: conservation + spreading ────────────────────────────
{
    const t = new RingCurrentTransport();
    // Seed a spike at one L cell (all MLT) in H⁺ channel 0.
    const iSpike = 12;
    for (let j = 0; j < t.nMlt; j++) t.C[0][0][t.idx(iSpike, j)] = 1;
    const sum0 = t.C[0][0].reduce((a, b) => a + b, 0);
    for (let n = 0; n < 200; n++) t._diffuse(300);
    const sum1 = t.C[0][0].reduce((a, b) => a + b, 0);
    approx(sum1, sum0, 1e-9, 'diffusion conserves total content');
    // Spread: neighbors of the spike now carry content.
    assert.ok(t.C[0][0][t.idx(iSpike + 2, 0)] > 0 && t.C[0][0][t.idx(iSpike - 2, 0)] > 0,
        'diffusion spreads the profile');
    ok('radial diffusion conserves content and spreads');
}

// ── 3. Charge-exchange decay: e^(−t/τ) and O⁺ faster than H⁺ ──────────────────
{
    const t = new RingCurrentTransport();
    t.setDriver({ kp: 5 });  // plasmapause inside L=4 → no Coulomb term, pure τ_cx
    const iL = t.L.findIndex(L => L >= 4) ;   // L≈4 cell
    const E = t.eKev[3];                       // 86 keV channel
    for (let j = 0; j < t.nMlt; j++) { t.C[0][3][t.idx(iL, j)] = 1; t.C[1][3][t.idx(iL, j)] = 1; }
    const h0 = t.C[0][3][t.idx(iL, 0)], o0 = t.C[1][3][t.idx(iL, 0)];
    const dt = 1800;
    for (let n = 0; n < 4; n++) t._loss(dt);   // 2 h total
    const L4 = t.L[iL];
    const tauH = chargeExchangeLifetimeHours(E, L4, 'ion') * 3600;
    const tauO = chargeExchangeLifetimeHours(E, L4, 'oxygen') * 3600;
    approx(t.C[0][3][t.idx(iL, 0)] / h0, Math.exp(-4 * dt / tauH), 1e-6, 'H+ decays as e^(-t/tau)');
    approx(t.C[1][3][t.idx(iL, 0)] / o0, Math.exp(-4 * dt / tauO), 1e-6, 'O+ decays as e^(-t/tau)');
    assert.ok(t.C[1][3][t.idx(iL, 0)] < t.C[0][3][t.idx(iL, 0)], 'O+ decays faster than H+ at 86 keV');
    ok('charge-exchange decay matches e^(-t/τ); O⁺ faster than H⁺');
}

// ── 3b. EMIC precipitation: anisotropy-gated, band-bound, self-limiting ──────
{
    const t = new RingCurrentTransport();
    t.setDriver({ kp: 7 });                      // sets the band via Lpp only
    const cf = t.cfg;
    const ppl = 5.6 - 0.46 * 7;
    const iL = t.L.findIndex(L => L >= ppl - 0.2);
    assert.ok(t.L[iL] <= ppl + cf.emicBandOut, 'test cell is inside the EMIC band');
    const iOut = t.L.findIndex(L => L >= ppl + cf.emicBandOut + 0.5);   // outside band
    const jA = 35, jB = 11;                      // two MLT cells — MLT no longer gates
    const kHi = 4, kLo = 2;                      // 176 keV (≥50) / 42 keV (<50)
    // Anisotropic protons at jA (A = aInject), ISOTROPIC protons at jB (A = 0);
    // plus low-E protons, O⁺, and an out-of-band anisotropic cell. SEED is
    // large enough that the cell's proton P⊥ keeps the β gate SATURATED
    // (≥ emicPRefNPa) through the whole drain, so the expected ratio below
    // needs only the anisotropy dynamics.
    const SEED = 6e26;
    t.C[0][kHi][t.idx(iL, jA)] = SEED; t.MH[kHi][t.idx(iL, jA)] = SEED * cf.aInject;
    t.C[0][kHi][t.idx(iL, jB)] = SEED;                         // MH = 0 (isotropic ref)
    t.C[0][kLo][t.idx(iL, jA)] = SEED; t.MH[kLo][t.idx(iL, jA)] = SEED * cf.aInject;
    t.C[0][kLo][t.idx(iL, jB)] = SEED;                         // within-channel ref
    t.C[1][kHi][t.idx(iL, jA)] = SEED;
    t.C[1][kHi][t.idx(iL, jB)] = SEED;                         // within-species ref
    // He⁺ riders: the proton-driven wave field at jA should scatter them; at
    // jB the protons are isotropic → no waves → untouched.
    t.C[2][kHi][t.idx(iL, jA)] = SEED;
    t.C[2][kHi][t.idx(iL, jB)] = SEED;
    t.C[2][kLo][t.idx(iL, jA)] = SEED;                         // sub-resonant He⁺
    t.C[2][kLo][t.idx(iL, jB)] = SEED;
    // Out-of-band probe at DAWN (jB): outside the all-MLT band AND outside
    // the dusk plume sector (a dusk cell at this L would now be plume!).
    t.C[0][kHi][t.idx(iOut, jB)] = SEED; t.MH[kHi][t.idx(iOut, jB)] = SEED * cf.aInject;
    const dt = 1800;
    // Expected drains over `steps` _loss calls, replicated from the model
    // formulas. The proton gate samples A AFTER the in-pass isotropization;
    // the collective WAVE gate (He⁺ consumer) samples the PASS-START state —
    // both sequences are tracked. cx/Coulomb factors cancel in the ratios.
    const expectDrains = (steps) => {
        let cP = 1, a = cf.aInject, cHe = 1;
        const paD = Math.exp(-dt / (cf.tauPaH * 3600));
        const aR = Math.exp(-dt / (cf.emicTauAH * 3600));
        for (let n = 0; n < steps; n++) {
            const gWave = Math.max(0, Math.min(1, (a - cf.emicACrit) / cf.emicAScale));
            cHe *= Math.exp(-gWave * dt / (cf.emicTauHeH * 3600));
            const aIn = a * paD;
            const g = Math.max(0, Math.min(1, (aIn - cf.emicACrit) / cf.emicAScale));
            cP *= Math.exp(-g * dt / (cf.emicTauH * 3600));
            a = cf.emicACrit + (aIn - cf.emicACrit) * aR;
        }
        return { h: cP, he: cHe };
    };
    const expectRatio = (steps) => expectDrains(steps).h;
    for (let n = 0; n < 4; n++) t._loss(dt);     // 2 h total
    // Within-channel jA/jB ratios: cx + Coulomb are identical across MLT, so
    // they cancel exactly and only the EMIC term remains.
    const r = (s, k) => t.C[s][k][t.idx(iL, jA)] / t.C[s][k][t.idx(iL, jB)];
    approx(r(0, kHi), expectRatio(4), 1e-9, 'anisotropic cell drains per model');
    assert.ok(r(0, kHi) < 0.75, 'drain is substantial over 2 h');
    approx(r(0, kLo), 1, 1e-12, 'sub-50 keV protons untouched');
    approx(r(1, kHi), 1, 1e-12, 'O⁺ untouched (H⁺-band waves)');
    // He⁺-band: the proton-driven wave field scatters He⁺ at jA exactly per
    // the collective-gate sequence; no waves at jB (isotropic protons) and
    // no resonance below 50 keV.
    approx(r(2, kHi), expectDrains(4).he, 1e-9, 'He⁺ drains with the wave field');
    assert.ok(r(2, kHi) < 0.9, 'He⁺ drain is visible over 2 h');
    approx(r(2, kLo), 1, 1e-12, 'sub-resonant He⁺ untouched');
    // Out-of-band cell keeps only cx decay — compare against the isotropic
    // in-band cell after removing the differing cx/Coulomb factors: instead
    // pin that its MH kept the pa-decay only (no EMIC relax toward A_crit).
    const aOutEnd = t.MH[kHi][t.idx(iOut, jB)] / t.C[0][kHi][t.idx(iOut, jB)];
    approx(aOutEnd, cf.aInject * Math.exp(-4 * dt / (cf.tauPaH * 3600)), 1e-9,
        'outside the band A only isotropizes');
    // Self-limiting: the drained cell's anisotropy relaxed toward A_crit.
    const aEnd = t.MH[kHi][t.idx(iL, jA)] / t.C[0][kHi][t.idx(iL, jA)];
    assert.ok(aEnd < cf.aInject && aEnd > 0.9 * cf.emicACrit * Math.exp(-4 * dt / (cf.tauPaH * 3600)),
        `A relaxed toward crit (${aEnd.toFixed(3)})`);
    ok('EMIC precipitation: anisotropy-gated, band-bound, self-limiting');
}

// ── 3c. Anisotropy is emergent: storms deliver it, quiet does not ────────────
{
    const storm = new RingCurrentTransport();
    storm.setDriver({ kp: 7, vbs: 8 });
    for (let h = 0; h < 12; h++) storm.step(3600);
    const pStorm = storm.emicPrecipitationMap();
    const totStorm = pStorm.reduce((a, b) => a + b, 0);
    assert.ok(totStorm > 0, 'storm drives EMIC precipitation');
    const quiet = new RingCurrentTransport();
    quiet.setDriver({ kp: 1, vbs: 0 });
    for (let h = 0; h < 12; h++) quiet.step(3600);
    const pQuiet = quiet.emicPrecipitationMap();
    const totQuiet = pQuiet.reduce((a, b) => a + b, 0);
    // Storm precipitates far more in ABSOLUTE terms (more content AND more
    // anisotropy delivered). Note the per-energy rate can invert: the quiet
    // band (Lpp≈5.1) sits next to the injection boundary — quiet-time
    // subauroral proton arcs are a real phenomenon, not a bug.
    assert.ok(totStorm > 3 * totQuiet,
        `storm precip ≫ quiet absolute (${totStorm.toExponential(1)} vs ${totQuiet.toExponential(1)})`);
    // The anisotropy field is populated where protons are.
    const aMap = storm.anisotropyMap();
    let aMax = 0;
    for (const v of aMap) if (v > aMax) aMax = v;
    assert.ok(aMax > 0.05 && aMax <= 1.5, `anisotropy field sane (max ${aMax.toFixed(2)})`);
    ok('EMIC storm/quiet contrast is emergent from anisotropy transport');
}

// ── 4. Azimuthal advection conserves content (MLT periodic) ──────────────────
{
    const t = new RingCurrentTransport();
    t.setDriver({ kp: 4 });
    // Seed an interior blob and kill the radial drift so only MLT transport runs.
    for (let j = 10; j < 16; j++) t.C[0][2][t.idx(12, j)] = 1;
    t._computeDrift();
    for (const arr of t._vLf) arr.fill(0);   // radial off → pure periodic azimuthal
    const sum0 = t.C[0][2].reduce((a, b) => a + b, 0);
    for (let n = 0; n < 500; n++) t._advect(15);
    const sum1 = t.C[0][2].reduce((a, b) => a + b, 0);
    approx(sum1, sum0, 1e-9, 'azimuthal advection conserves content');
    ok('azimuthal (MLT-periodic) advection conserves content');
}

// ── 5. Storm response: emergent main phase, partial ring, recovery ───────────
{
    const t = new RingCurrentTransport();
    t.setDriver({ kp: 7, vbs: 8 });
    for (let h = 0; h < 12; h++) t.step(3600);
    const m = t.metrics();
    assert.ok(m.dstStar < -40 && m.dstStar > -400, `main-phase Dst* in strong band (${m.dstStar.toFixed(1)})`);
    assert.ok(m.energyJ > 0, 'ring holds energy');
    assert.ok(m.oxygenFraction > 0.06, `O+ fraction enhanced (${m.oxygenFraction.toFixed(3)})`);
    assert.ok(m.asymmetry > 0.3, `partial-ring asymmetry emerged (${m.asymmetry.toFixed(2)})`);
    assert.ok(m.peakL > 3 && m.peakL < 5.5, `ring peaks near L~4 (${m.peakL.toFixed(2)})`);
    assert.ok(m.peakMlt >= 15 || m.peakMlt <= 4, `partial ring in dusk-midnight sector (${m.peakMlt.toFixed(1)} MLT)`);
    // Perpendicular pressure lands in a physical strong-storm band (nPa).
    const pk = t.peakPressureNPa('all');
    assert.ok(pk > 1 && pk < 80, `peak P⊥ physical (${pk.toFixed(1)} nPa)`);
    assert.equal(t.pressureMap('oxygen').length, t.nL * t.nMlt, 'pressureMap shape');
    // ENA source (ion × charge-exchange σ) is positive and peaks on the ring.
    const ena = t.enaEmissivityMap();
    assert.equal(ena.length, t.nL * t.nMlt, 'enaEmissivityMap shape');
    let emx = 0, emi = 0;
    for (let i = 0; i < t.nL; i++) { let row = 0; for (let j = 0; j < t.nMlt; j++) row += ena[t.idx(i, j)]; if (row > emx) { emx = row; emi = i; } }
    assert.ok(emx > 0, 'ENA source is nonzero during a storm');
    assert.ok(t.L[emi] > 2.5 && t.L[emi] < 6, `ENA source peaks on the ring (L${t.L[emi].toFixed(1)})`);
    // Recovery under quiet driving.
    t.setDriver({ kp: 1, vbs: 0 });
    for (let h = 0; h < 24; h++) t.step(3600);
    const r = t.metrics();
    assert.ok(r.dstStar > m.dstStar, `Dst* recovers toward zero (${m.dstStar.toFixed(1)} -> ${r.dstStar.toFixed(1)})`);
    ok(`storm: Dst* ${m.dstStar.toFixed(0)}nT, peak L${m.peakL.toFixed(1)} @ ${m.peakMlt.toFixed(0)}MLT, asym ${m.asymmetry.toFixed(2)}, recovers`);
}

// ── 6. Determinism + diagnostics shapes ──────────────────────────────────────
{
    const run = () => {
        const t = new RingCurrentTransport();
        t.setDriver({ kp: 6, vbs: 5 });
        for (let h = 0; h < 6; h++) t.step(3600);
        return t;
    };
    const a = run(), b = run();
    approx(a.dstStar(), b.dstStar(), 0, 'deterministic Dst*');
    assert.equal(a.equatorialMap('hydrogen').length, a.nL * a.nMlt, 'equatorialMap shape');
    assert.equal(a.spectrumAt(10, 20).length, a.nE, 'spectrumAt shape');
    assert.equal(SPECIES.length, 3, 'three species');
    const met = a.metrics();
    for (const key of ['dstStar', 'energyJ', 'oxygenFraction', 'asymmetry', 'peakL', 'peakMlt', 'perSpeciesJ'])
        assert.ok(key in met, `metrics has ${key}`);
    ok('deterministic; diagnostics shapes sound');
}

console.log(`\nring-current-transport: all ${passed} test groups passed`);
