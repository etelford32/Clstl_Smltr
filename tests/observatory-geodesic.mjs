// observatory-geodesic.mjs — validation contract for the Kerr-Schild null-
// geodesic integrator (js/observatory3d/geodesic.js), the math behind the
// observatory's ray-traced lensing prototype. Every check is against an
// INDEPENDENT analytic reference, not against the implementation itself:
//
//   1. photon capture boundary  b_c = √27 M            (exact, Schwarzschild)
//   2. weak-field deflection    α(b) = 4M/b + 15π/4 (M/b)² + 128/3 (M/b)³
//                                       + 3465π/64 (M/b)⁴   (Keeton & Petters 2005)
//   3. conserved quantities     H = 0 and L = |x⃗×p⃗| along the ray (RK4 drift)
//   4. horizon penetration      a sub-critical ray crosses r = 2M regularly
//                               (the property BL coordinates cannot deliver)
//
// Run: node tests/observatory-geodesic.mjs

import {
    traceRay, nullMomentum, impactParam, shadowScreenAngle, B_CRIT,
} from '../js/observatory3d/geodesic.js';

let failed = 0;
function check(name, ok, detail) {
    console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
    if (!ok) failed++;
}

const M = 1;

// ── 1. capture boundary ──────────────────────────────────────────────────────
{
    const R0 = 1000;
    const captured = (b) =>
        traceRay([-R0, b, 0], [1, 0, 0], M).status === 'captured';
    let lo = 4.8, hi = 5.6;
    for (let i = 0; i < 45; i++) {
        const mid = 0.5 * (lo + hi);
        if (captured(mid)) lo = mid; else hi = mid;
    }
    // report the INVARIANT impact parameter at the boundary, not the y-offset
    const bEdge = 0.5 * (lo + hi);
    const bTrue = impactParam([-R0, bEdge, 0], nullMomentum([-R0, bEdge, 0], [1, 0, 0], M));
    const err = Math.abs(bTrue - B_CRIT * M) / (B_CRIT * M);
    check('photon capture boundary = √27 M',
        err < 1e-3, `b_c = ${bTrue.toFixed(5)} vs ${(B_CRIT * M).toFixed(5)} (err ${(err * 100).toFixed(3)}%)`);
}

// ── 2. weak-field deflection ─────────────────────────────────────────────────
for (const bGoal of [50, 100]) {
    const R0 = 1e4;
    const res = traceRay([-R0, bGoal, 0], [1, 0, 0], M, { rFar: 4e4 });
    const b = impactParam([-R0, bGoal, 0], nullMomentum([-R0, bGoal, 0], [1, 0, 0], M));
    const alpha = Math.atan2(Math.abs(res.dir[1]), res.dir[0]);
    const series = 4 * M / b + (15 * Math.PI / 4) * (M / b) ** 2
        + (128 / 3) * (M / b) ** 3 + (3465 * Math.PI / 64) * (M / b) ** 4;
    const err = Math.abs(alpha - series);
    check(`deflection at b ≈ ${bGoal} M matches PPN series`,
        res.status === 'escaped' && err < 2e-5,
        `α = ${alpha.toExponential(5)} vs ${series.toExponential(5)} (Δ ${err.toExponential(1)})`);
}

// ── 3. conservation along a near-critical ray ────────────────────────────────
{
    const res = traceRay([-1000, 5.4, 0], [1, 0, 0], M);
    check('Hamiltonian stays null along near-critical ray',
        res.maxH < 1e-6, `max |H| = ${res.maxH.toExponential(1)}`);
    check('angular momentum conserved along near-critical ray',
        res.maxLdrift < 1e-6, `max |ΔL/L| = ${res.maxLdrift.toExponential(1)}`);
}

// ── 4. horizon penetration (Kerr-Schild regularity) ──────────────────────────
{
    const res = traceRay([-1000, 3, 0], [1, 0, 0], M);
    const rEnd = Math.hypot(...res.x);
    const finite = res.x.every(Number.isFinite) && res.p.every(Number.isFinite);
    check('sub-critical ray crosses the horizon without singularity',
        res.status === 'captured' && finite && rEnd <= 2 * M + 1e-9,
        `terminated at r = ${rEnd.toFixed(4)} M, all state finite`);
}

// ── 5. shadow screen-angle helper is self-consistent with tracing ────────────
{
    const D = 30;
    const thPred = shadowScreenAngle(D, M);
    const capturedAt = (th) =>
        traceRay([D, 0, 0], [-Math.cos(th), Math.sin(th), 0], M).status === 'captured';
    let lo = 1e-3, hi = 1.0;
    for (let i = 0; i < 40; i++) {
        const mid = 0.5 * (lo + hi);
        if (capturedAt(mid)) lo = mid; else hi = mid;
    }
    const thTraced = 0.5 * (lo + hi);
    const err = Math.abs(thTraced - thPred) / thPred;
    check('shadow edge on screen: traced capture boundary matches b=√27 M mapping',
        err < 2e-3,
        `θ = ${(thTraced * 180 / Math.PI).toFixed(3)}° traced vs ${(thPred * 180 / Math.PI).toFixed(3)}° predicted`);
}

console.log(failed
    ? `observatory-geodesic: ${failed} CHECK(S) FAILED`
    : 'observatory-geodesic: all checks passed');
process.exit(failed ? 1 : 0);
