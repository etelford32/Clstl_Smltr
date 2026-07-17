/**
 * Pins for js/radiation-belt-electrons.js — the drift-averaged MeV-electron
 * belt with magnetopause-shadowing and EMIC dropouts.
 * Run: node tests/radiation-belt-electrons.mjs
 */
import { RadiationBeltElectrons, dllPerSec, waveGateProfile } from '../js/radiation-belt-electrons.js';

let failures = 0;
const check = (name, ok, detail = '') => {
    console.log(`${ok ? '  ✓' : '  ✗ FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
    if (!ok) failures++;
};

console.log('radiation-belt-electrons');

// ── D_LL formula pin (Brautigam & Albert 2000) ───────────────────────────────
{
    const expect = Math.pow(10, 0.506 * 6 - 9.325) * Math.pow(6.6, 10) / 86400;
    check('D_LL(Kp6, L6.6) matches BA2000', Math.abs(dllPerSec(6, 6.6) - expect) < 1e-18,
        `${(dllPerSec(6, 6.6) * 86400).toFixed(2)}/day`);
    check('D_LL grows with Kp and L',
        dllPerSec(7, 5) > dllPerSec(3, 5) && dllPerSec(3, 6) > dllPerSec(3, 4));
}

// ── Quiet build-up: diffusion fills the belt inward from the seed ────────────
{
    const b = new RadiationBeltElectrons();
    for (let h = 0; h < 72; h++) b.step(3600, { kp: 2, vbs: 0.5, mpR0: 10.5 });
    const F = b.profile();
    check('belt built up (finite, non-negative)', F.every(v => Number.isFinite(v) && v >= 0));
    check('GEO flux populated', b.geoFlux() > 0.1, b.geoFlux().toFixed(3));
    // Profile decreases inward (source outside, losses inside).
    const iMid = 12, iOut = 21;
    check('profile decreases inward of the seed', F[iOut] > F[iMid] && F[iMid] >= 0,
        `F(${b.L[iOut].toFixed(1)})=${F[iOut].toFixed(3)} > F(${b.L[iMid].toFixed(1)})=${F[iMid].toFixed(3)}`);
}

// ── Dropout #1: magnetopause shadowing ───────────────────────────────────────
{
    const b = new RadiationBeltElectrons();
    for (let h = 0; h < 72; h++) b.step(3600, { kp: 2, vbs: 0.5, mpR0: 10.5 });
    const geo0 = b.geoFlux();
    for (let h = 0; h < 4; h++) b.step(3600, { kp: 6, vbs: 4, mpR0: 6.2 });
    const geo1 = b.geoFlux();
    check('compressed magnetopause guts GEO flux', geo1 < 0.3 * geo0,
        `${geo0.toFixed(3)} → ${geo1.toFixed(3)}`);
    // Recovery: quiet refill from the boundary seed.
    for (let h = 0; h < 96; h++) b.step(3600, { kp: 2, vbs: 0.5, mpR0: 10.5 });
    check('belt refills after the storm', b.geoFlux() > 0.5 * geo0,
        `recovered to ${b.geoFlux().toFixed(3)}`);
}

// ── Dropout #2: EMIC bite inside the belt ────────────────────────────────────
// Twin runs (with/without the wave gate) isolate the EMIC term from the
// concurrent diffusion supply — the honest control experiment.
{
    const mk = () => {
        const b = new RadiationBeltElectrons();
        for (let h = 0; h < 72; h++) b.step(3600, { kp: 4, vbs: 1, mpR0: 10.5 });
        return b;
    };
    const gated = mk(), control = mk();
    // Synthetic gate: waves localized around L ≈ 4.2 (a storm plume band).
    const gate = new Float64Array(gated.nL);
    for (let i = 0; i < gated.nL; i++) gate[i] = Math.exp(-((gated.L[i] - 4.2) ** 2) / (2 * 0.4 ** 2)) * 0.8;
    for (let h = 0; h < 6; h++) {
        gated.step(3600, { kp: 3, vbs: 1, mpR0: 10.5 }, gate);
        control.step(3600, { kp: 3, vbs: 1, mpR0: 10.5 });
    }
    const fG = gated.profile(), fC = control.profile();
    const i42 = gated.L.findIndex(L => L >= 4.2);
    const iRef = gated.L.findIndex(L => L >= 5.8);   // outside the wave band
    const bite = fG[i42] / (fC[i42] || 1);
    const ref  = fG[iRef] / (fC[iRef] || 1);
    check('EMIC bites at the wave band (vs control)', bite < 0.35, `kept ${(bite * 100).toFixed(0)}%`);
    check('bite is LOCAL (reference L barely moves)', ref > 0.9, `ref kept ${(ref * 100).toFixed(0)}%`);
    // The loss ratio (gated/control) minimizes AT the wave band — the
    // localized-loss signature a PSD analysis would flag (the absolute
    // profile still falls inward, so the ratio is the right observable).
    let iMinRatio = 0, minRatio = Infinity;
    for (let i = 0; i < fG.length; i++) {
        if (fC[i] > 1e-9 && fG[i] / fC[i] < minRatio) { minRatio = fG[i] / fC[i]; iMinRatio = i; }
    }
    check('loss ratio minimizes at the wave band', Math.abs(iMinRatio - i42) <= 1,
        `min at L=${gated.L[iMinRatio].toFixed(2)} (band L=${gated.L[i42].toFixed(2)})`);
}

// ── waveGateProfile MLT-averages a transport-shaped source ───────────────────
{
    const fake = {
        nL: 4, nMlt: 3,
        emicWaveGateMap: () => Float64Array.from([0, 0, 0,  0.3, 0.6, 0,  0, 0, 0,  1, 1, 1]),
    };
    const g = waveGateProfile(fake);
    check('MLT average per L row', Math.abs(g[1] - 0.3) < 1e-12 && g[0] === 0 && Math.abs(g[3] - 1) < 1e-12);
    check('null when the kernel lacks the map', waveGateProfile({}) === null);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall pins hold');
process.exit(failures ? 1 : 0);
