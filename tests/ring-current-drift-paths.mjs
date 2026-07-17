/**
 * Pins for js/ring-current-drift-paths.js — the drift-path / Alfvén-layer
 * module. Run: node tests/ring-current-drift-paths.mjs
 */
import {
    driftVelocity, stagnationL, stagnationLZeroEnergy,
    traceDriftPath, alfvenLayer, driftPathBundle, convectionAmplitude,
} from '../js/ring-current-drift-paths.js';

let failures = 0;
const check = (name, ok, detail = '') => {
    console.log(`${ok ? '  ✓' : '  ✗ FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
    if (!ok) failures++;
};

console.log('ring-current-drift-paths');

// ── Stagnation point ─────────────────────────────────────────────────────────
{
    const A3 = convectionAmplitude(3);
    const zero = stagnationL(0, A3);
    const analytic = stagnationLZeroEnergy(A3);
    check('zero-energy stagnation matches analytic (Kp 3)',
        !!zero && Math.abs(zero.L - analytic) < 0.01,
        `num ${zero?.L.toFixed(3)} vs ${analytic?.toFixed(3)}`);
    check('zero-energy stagnation is at dusk', zero?.az === 1.5 * Math.PI);

    // Convection grows with Kp ⇒ the stagnation point moves INWARD.
    const q = stagnationL(0, convectionAmplitude(1));
    const s = stagnationL(0, convectionAmplitude(7));
    check('stagnation moves inward with Kp', q.L > s.L,
        `Kp1 ${q.L.toFixed(2)} > Kp7 ${s.L.toFixed(2)}`);

    // Ring-current-energy ions are westward-dominated at every L in range:
    // NO interior stagnation — their boundary is drift-shell shadowing.
    check('150 keV ion has no interior stagnation (fully westward)',
        stagnationL(150, A3, 'ion') === null);

    // LOW-energy ion keeps the classic dusk X-point.
    const A5 = convectionAmplitude(5);
    const ion5 = stagnationL(5, A5, 'ion');
    check('5 keV ion stagnation at dusk (Kp 5)',
        !!ion5 && ion5.az === 1.5 * Math.PI, `L ${ion5?.L.toFixed(2)}`);
    // Eastward electron grad–curv pushes ITS dusk layer OUTSIDE the
    // zero-energy layer (the eastward terms add).
    const zero5 = stagnationL(0, A5);
    const ele5 = stagnationL(20, A5, 'electron');
    check('20 keV electron stagnation at dusk, outside zero-energy (Kp 5)',
        !!ele5 && ele5.az === 1.5 * Math.PI && ele5.L > zero5.L,
        `${ele5?.L.toFixed(2)} > ${zero5.L.toFixed(2)}`);

    check('convA=0 has no stagnation (corotation never loses)',
        stagnationL(0, 0) === null && stagnationLZeroEnergy(0) === null);
}

// ── Drift velocity sanity ────────────────────────────────────────────────────
{
    const A = convectionAmplitude(2);
    // Deep + LOW energy: corotation dominates → eastward for both species.
    const iIn = driftVelocity(2, 0, 5, A, 'ion');
    const eIn = driftVelocity(2, 0, 5, A, 'electron');
    check('deep L=2, 5 keV: both species drift eastward (corotation)',
        iIn.dAzdt > 0 && eIn.dAzdt > 0);
    // Electron azimuthal rate exceeds the ion's at the same (L, E): the
    // grad–curv term flips from opposing to aiding the eastward flow.
    check('electron dAzdt > ion dAzdt at same (L,E)', eIn.dAzdt > iIn.dAzdt);
    // Radial E×B is identical for both charges.
    check('radial E×B is charge-blind',
        Math.abs(iIn.dLdt - eIn.dLdt) < 1e-15);
    // High-energy ion far out: westward despite corotation.
    const iOut = driftVelocity(6.5, 0, 300, A, 'ion');
    check('300 keV ion at L=6.5 drifts westward', iOut.dAzdt < 0,
        `${(iOut.dAzdt * 3600).toFixed(4)} rad/h`);
}

// ── Path tracing ─────────────────────────────────────────────────────────────
{
    const A2 = convectionAmplitude(2);
    const inner = traceDriftPath(3, 0, 50, A2, 'ion');
    check('L=3 50 keV ion path closes (trapped)', inner.closed);
    const outer = traceDriftPath(9, 0.5 * Math.PI, 50, convectionAmplitude(7), 'ion');
    check('L=9 dawn path at Kp7 is open', !outer.closed);
    // Closed path stays within a sane annulus.
    let ok = true;
    for (let i = 0; i < inner.n; i++) {
        const L = inner.pts[2 * i];
        if (L < 1.5 || L > 6) { ok = false; break; }
    }
    check('closed path bounded (1.5 < L < 6)', ok);
}

// ── Alfvén layer + bundle ────────────────────────────────────────────────────
{
    // Energetic-ion regime → shadowing boundary at the magnetopause grazing.
    const layer = alfvenLayer(100, convectionAmplitude(4), 'ion');
    check('100 keV ion boundary exists at Kp 4 (shadowing regime)',
        !!layer && layer.n > 10 && layer.mode === 'shadowing', `mode ${layer?.mode}`);
    check('shadowing boundary path closes', !!layer?.closed);
    // Low-energy regime → X-point Alfvén layer.
    const xl = alfvenLayer(5, convectionAmplitude(5), 'ion');
    check('5 keV ion boundary is an X-point layer', xl?.mode === 'xpoint',
        `mode ${xl?.mode}, Ls ${xl?.Ls.toFixed(2)}`);
    check('X-point layer path closes', !!xl?.closed);

    const bundle = driftPathBundle(100, 4, 'ion');
    check('bundle scan has both regimes',
        bundle.paths.some(p => p.kind === 'closed') &&
        bundle.paths.some(p => p.kind === 'open'),
        bundle.paths.map(p => `${p.L0.toFixed(1)}:${p.kind[0]}`).join(' '));
    // Topology is radially ordered on the scan: no closed path OUTSIDE the
    // outermost closed one sits beyond an open one below it… i.e. once the
    // scan goes open it stays open.
    let seenOpen = false, ordered = true;
    for (const p of bundle.paths) {
        if (p.kind === 'open') seenOpen = true;
        else if (seenOpen) { ordered = false; break; }
    }
    check('scan is closed-inside / open-outside ordered', ordered);
    // The transition brackets the Alfvén layer radius at midnight.
    const lastClosed = [...bundle.paths].reverse().find(p => p.kind === 'closed');
    check('Alfvén layer radius is plausible vs scan',
        !!bundle.Ls && !!lastClosed && bundle.Ls > lastClosed.L0 - 1.8,
        `Ls ${bundle.Ls?.toFixed(2)}, last closed seed ${lastClosed?.L0.toFixed(2)}`);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall pins hold');
process.exit(failures ? 1 : 0);
