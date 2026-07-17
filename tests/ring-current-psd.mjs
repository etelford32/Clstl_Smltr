/**
 * Pins for js/ring-current-psd.js — PSD radial profiles off the transport
 * core's public per-channel state. Run: node tests/ring-current-psd.mjs
 */
import { RingCurrentTransport } from '../js/ring-current-transport.js';
import { psdCapable, psdProfile, psdShape, muForEnergyAtL, bEqNt } from '../js/ring-current-psd.js';

let failures = 0;
const check = (name, ok, detail = '') => {
    console.log(`${ok ? '  ✓' : '  ✗ FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
    if (!ok) failures++;
};

console.log('ring-current-psd');

// ── Capability + units ───────────────────────────────────────────────────────
{
    const t = new RingCurrentTransport();
    check('JS transport is psdCapable', psdCapable(t));
    check('WASM-shaped stub is NOT capable (summed maps only)',
        !psdCapable({ pressureMap: () => {}, equatorialMap: () => {} }));
    check('B_eq(4) = B0/64', Math.abs(bEqNt(4) - 31100 / 64) < 1e-9);
    const mu = muForEnergyAtL(100, 3.5);
    check('muForEnergyAtL round-trips', Math.abs(mu * bEqNt(3.5) - 100) < 1e-9);
}

// ── Storm-driven profile ─────────────────────────────────────────────────────
{
    const t = new RingCurrentTransport();
    t.setDriver({ kp: 6, vbs: 3 });
    t.step(8 * 3600);                           // 8 h of strong driving
    const mu = muForEnergyAtL(80, 4.5);         // lands mid-ladder mid-shell
    const p = psdProfile(t, mu);
    let valid = 0, positive = 0;
    for (let i = 0; i < p.f.length; i++) {
        if (Number.isFinite(p.f[i])) { valid++; if (p.f[i] > 0) positive++; }
    }
    check('profile has a valid L window', valid >= 6, `${valid} bins`);
    check('driven ring has positive PSD in window', positive >= 5, `${positive}`);
    // Outer-boundary (plasma-sheet) source + inward diffusion ⇒ f grows
    // outward toward the source at fixed μ.
    const shape = psdShape(p);
    check('driven profile reads as inward diffusion (source outside)',
        shape === 'inward-diffusion', shape);
    // Energy mapping is monotone: E_μ falls with L (B falls as L⁻³).
    let mono = true;
    for (let i = 1; i < p.eKevAt.length; i++) if (p.eKevAt[i] >= p.eKevAt[i - 1]) mono = false;
    check('E_μ(L) strictly decreasing', mono);
    // NaN outside the channel span: the innermost shells (E_μ > 300 keV).
    check('inner shells (E_μ above ladder) are NaN-masked',
        !Number.isFinite(p.f[0]), `E_μ(L=${p.L[0].toFixed(1)}) = ${p.eKevAt[0].toFixed(0)} keV`);
}

// ── Quiet ring is small but well-defined ─────────────────────────────────────
{
    const t = new RingCurrentTransport();
    t.setDriver({ kp: 1, vbs: 0 });
    t.step(4 * 3600);
    const p = psdProfile(t, muForEnergyAtL(80, 4.5));
    const q = [];
    for (let i = 0; i < p.f.length; i++) if (Number.isFinite(p.f[i])) q.push(p.f[i]);
    check('quiet profile exists', q.length >= 6);

    const t2 = new RingCurrentTransport();
    t2.setDriver({ kp: 6, vbs: 3 });
    t2.step(4 * 3600);
    const p2 = psdProfile(t2, muForEnergyAtL(80, 4.5));
    let sumQ = 0, sumS = 0, n = 0;
    for (let i = 0; i < p.f.length; i++) {
        if (Number.isFinite(p.f[i]) && Number.isFinite(p2.f[i])) { sumQ += p.f[i]; sumS += p2.f[i]; n++; }
    }
    check('storm PSD ≫ quiet PSD at same μ', n > 4 && sumS > 3 * sumQ,
        `ratio ${(sumS / (sumQ || 1)).toFixed(1)}×`);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall pins hold');
process.exit(failures ? 1 : 0);
