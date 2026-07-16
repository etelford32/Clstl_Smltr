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
