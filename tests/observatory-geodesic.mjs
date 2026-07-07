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
    traceRay, traceRayKS, hole, nullMomentum, impactParam,
    shadowScreenAngle, B_CRIT,
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

// ── 6. Kerr: equatorial capture boundaries vs the BL radial potential ────────
// Independent reference: in Boyer-Lindquist, an equatorial photon from
// infinity with ξ = L_z/E is captured iff the radial potential
//   R(r; ξ) = (r² + a² − aξ)² − Δ (ξ − a)²,  Δ = r² − 2r + a²   [M = 1]
// stays positive for all r > r₊. The critical ξ (each rotation sense) is
// where min R crosses zero. ξ is coordinate-invariant (E, L_z), so the
// Kerr-Schild trace must reproduce it exactly.
function criticalXiBL(a, sign) {
    const rPlus = 1 + Math.sqrt(1 - a * a);
    const minR = (xi) => {
        let m = Infinity;
        for (let r = rPlus + 1e-4; r < 30; r += 1e-3) {
            const D = r * r - 2 * r + a * a;
            const v = (r * r + a * a - a * xi) ** 2 - D * (xi - a) ** 2;
            m = Math.min(m, v);
        }
        return m;
    };
    let lo = 0.1 * sign, hi = 9 * sign;    // capture at small |ξ|, escape large
    for (let i = 0; i < 45; i++) {
        const mid = 0.5 * (lo + hi);
        if (minR(mid) > 0) lo = mid; else hi = mid;
    }
    return 0.5 * (lo + hi);
}

for (const a of [0.7, 0.9]) {
    const R0 = 1000;
    // traced boundary per rotation sense: y-offset −y0 gives L_z = +y0·p_x
    // (prograde for spin +z), +y0 gives retrograde
    const tracedXi = (sense) => {
        const captured = (y0) =>
            traceRay([-R0, -sense * y0, 0], [1, 0, 0], 1, { a }).status === 'captured';
        let lo = 1, hi = 9;
        for (let i = 0; i < 45; i++) {
            const mid = 0.5 * (lo + hi);
            if (captured(mid)) lo = mid; else hi = mid;
        }
        const y0 = 0.5 * (lo + hi);
        const p = nullMomentum([-R0, -sense * y0, 0], [1, 0, 0], 1, a);
        return (-R0) * p[1] - (-sense * y0) * p[0];     // exact L_z/E of the ray
    };
    for (const [sense, name] of [[1, 'prograde'], [-1, 'retrograde']]) {
        const xiT = tracedXi(sense);
        const xiRef = criticalXiBL(a, sense);
        const err = Math.abs(xiT - xiRef) / Math.abs(xiRef);
        check(`Kerr a=${a}: ${name} capture boundary matches BL potential`,
            err < 1.5e-3,
            `ξ = ${xiT.toFixed(4)} traced vs ${xiRef.toFixed(4)} BL (err ${(err * 100).toFixed(3)}%)`);
    }
    // frame dragging: retrograde photons are captured from farther out
    const pro = Math.abs(criticalXiBL(a, 1)), ret = Math.abs(criticalXiBL(a, -1));
    check(`Kerr a=${a}: frame dragging asymmetry (|ξ_retro| > |ξ_pro|)`,
        ret > pro + 0.5, `${ret.toFixed(2)} vs ${pro.toFixed(2)}`);
}

// ── 7. Kerr conservation (H, L_z) along a near-critical ray ──────────────────
// The a=0.9 prograde photon orbit sits at r_ph ≈ 1.56 M where curvature
// gradients are ~5× Schwarzschild's photon sphere; hK = 0.01 here asserts
// the integrator CONVERGES at the tight tolerance (RK4: 3× finer step →
// ~80× smaller drift), rather than loosening the bar to the default step.
{
    const res = traceRay([-1000, -3, 0], [1, 0, 0], 1, { a: 0.9, hK: 0.01 });
    check('Kerr a=0.9: Hamiltonian stays null along near-critical ray',
        res.maxH < 1e-6, `max |H| = ${res.maxH.toExponential(1)}`);
    check('Kerr a=0.9: L_z conserved (axisymmetry)',
        res.maxLzDrift < 1e-6, `max |ΔL_z/L_z| = ${res.maxLzDrift.toExponential(1)}`);
}

// ── 8. superposed two-hole metric: weak-field additivity ─────────────────────
{
    // two 0.5 M holes 10 M apart ⊥ to the ray plane offset; a distant ray
    // must deflect like a single 1 M hole at their barycenter to O((d/b)²)
    const holes = [hole([0, 0, 5], 0.5), hole([0, 0, -5], 0.5)];
    const b = 200, R0 = 1e4;
    const res = traceRayKS([-R0, b, 0], [1, 0, 0], holes, { rFar: 4e4 });
    const alpha = Math.atan2(Math.abs(res.dir[1]), res.dir[0]);
    const single = 4 / b + (15 * Math.PI / 4) / (b * b);
    const err = Math.abs(alpha - single) / single;
    check('superposed binary: far-field deflection = combined point mass',
        res.status === 'escaped' && err < 2e-3,
        `α = ${alpha.toExponential(4)} vs ${single.toExponential(4)} (err ${(err * 100).toFixed(3)}%)`);
    // and the superposed Hamiltonian stays null through the encounter
    check('superposed binary: Hamiltonian drift bounded',
        res.maxH < 1e-6, `max |H| = ${res.maxH.toExponential(1)}`);
}

console.log(failed
    ? `observatory-geodesic: ${failed} CHECK(S) FAILED`
    : 'observatory-geodesic: all checks passed');
process.exit(failed ? 1 : 0);
