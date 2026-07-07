// geodesic.js — null-geodesic integration in Kerr-Schild form: Kerr with
// arbitrary spin a ∈ [0, 1), and SUPERPOSED multi-hole metrics for the
// observatory's binary near-field lensing. This is the JS REFERENCE
// implementation of the math the ray-tracing fragment shaders run per
// pixel (ks-tracer.frag.js, render.js FS_NEARFIELD) — one algorithm, N
// backends, kept in lockstep exactly like nbody.js ↔ rust-abell85.
//
// Why Kerr-Schild and not Boyer-Lindquist (which js/ton618/ uses):
//   · Cartesian components — no polar coordinate singularity and no Δ = 0
//     blowup at the horizon, so rays terminate *inside* r₊ instead of
//     being pre-clipped outside it (shader-friendly);
//   · the metric is η_μν + Σᵢ fᵢ kᵢ_μ kᵢ_ν with an EXACT closed-form
//     inverse η^μν − Σᵢ fᵢ kᵢ^μ kᵢ^ν, so the Hamiltonian right-hand side
//     stays a handful of flops per hole;
//   · two holes superpose by adding their f k k terms — approximate (not
//     an exact Einstein solution), standard practice for binary
//     visualization, and exact in each hole's near zone and in the far
//     field. Documented on-page wherever it renders.
//
// Kerr in Kerr-Schild form (spin a along +z, geometrized units, mass M):
//   r is the Kerr radial coordinate:  r⁴ − (R²−a²) r² − a²z² = 0,
//     r² = ½[(R²−a²) + √((R²−a²)² + 4a²z²)],  R² = x²+y²+z²
//   f  = 2 M r³ / (r⁴ + a²z²)
//   k⃗  = ( (r x + a y)/(r²+a²), (r y − a x)/(r²+a²), z/r ),  k_μ = (1, k⃗)
//   k is null w.r.t. both η and g, and |k⃗| = 1. a = 0 reduces exactly to
//   the Schwarzschild form (r = R, k⃗ = x̂).
//
// Formulation: Hamiltonian on the covariant momentum, H = ½ g^{μν}p_μp_ν,
// signature (−+++). Staticity ⇒ p_t exactly conserved; the null-cone
// scale is fixed to E = −p_t = 1. State y = (x⃗, p⃗) ∈ ℝ⁶, κᵢ = 1 + k⃗ᵢ·p⃗:
//   ẋ  = p⃗ − Σᵢ fᵢ κᵢ k⃗ᵢ
//   ṗ  = Σᵢ [ ½ κᵢ² ∇fᵢ + fᵢ κᵢ (∇k⃗ᵢ)ᵀ p⃗ ]
// with analytic gradients (∂r derived from the defining quartic).
// Axisymmetry ⇒ L_z = x p_y − y p_x exactly conserved for a single hole;
// both drifts (H, L_z) are asserted in tests/observatory-geodesic.mjs
// against RK4 tolerances, and the capture boundaries against the
// Boyer-Lindquist radial-potential reference.
//
// Integrator: classical RK4, step h = clamp(K_H·r_min, hMin, hMax) where
// r_min is the distance to the nearest hole. DOM-free; Node-tested.

/** One lensing body: position c (same length unit as M), mass M, spin a. */
export function hole(c, M, a = 0) { return { c, M, a }; }

/**
 * Accumulate one hole's contribution to (dx, dp) at phase point (x, p).
 * Also returns f and κ for the Hamiltonian bookkeeping.
 */
function accum(x, p, h, dx, dp) {
    const xi0 = x[0] - h.c[0], xi1 = x[1] - h.c[1], xi2 = x[2] - h.c[2];
    const a = h.a, M = h.M;
    let r, g0, g1, g2, k0, k1, k2, f, df0, df1, df2;

    if (a === 0) {
        r = Math.hypot(xi0, xi1, xi2);
        const iv = 1 / r;
        f = 2 * M * iv;
        k0 = xi0 * iv; k1 = xi1 * iv; k2 = xi2 * iv;
        g0 = k0; g1 = k1; g2 = k2;                       // ∇r = x̂
        const c = -f * iv * iv;                          // ∂f = −(f/r²) x⃗
        df0 = c * xi0; df1 = c * xi1; df2 = c * xi2;
    } else {
        const R2 = xi0 * xi0 + xi1 * xi1 + xi2 * xi2;
        const a2 = a * a;
        const q = R2 - a2;
        const r2 = 0.5 * (q + Math.sqrt(q * q + 4 * a2 * xi2 * xi2));
        r = Math.sqrt(r2);
        const rho2 = r2 * r2 + a2 * xi2 * xi2;           // r⁴ + a²z²
        const iRho2 = 1 / rho2;
        f = 2 * M * r2 * r * iRho2;
        // ∇r from the defining quartic
        g0 = r2 * r * xi0 * iRho2;
        g1 = r2 * r * xi1 * iRho2;
        g2 = r * (r2 + a2) * xi2 * iRho2;
        // ∇f = (2Mr²/ρ⁴)[(3a²z² − r⁴)∇r − 2a²z r ẑ]
        const cf = 2 * M * r2 * iRho2 * iRho2;
        const t = 3 * a2 * xi2 * xi2 - r2 * r2;
        df0 = cf * t * g0;
        df1 = cf * t * g1;
        df2 = cf * (t * g2 - 2 * a2 * xi2 * r);
        const iD = 1 / (r2 + a2);
        k0 = (r * xi0 + a * xi1) * iD;
        k1 = (r * xi1 - a * xi0) * iD;
        k2 = xi2 / r;
    }

    const s = k0 * p[0] + k1 * p[1] + k2 * p[2];
    const kp = 1 + s;                                    // κ, p_t = −1 gauge
    const fk = f * kp;

    dx[0] -= fk * k0; dx[1] -= fk * k1; dx[2] -= fk * k2;

    const half = 0.5 * kp * kp;
    if (a === 0) {
        // fκ (∇k⃗)ᵀp with ∇x̂ = (I − x̂x̂ᵀ)/r  →  fκ(p − s x̂)/r
        const iv = 1 / r;
        dp[0] += half * df0 + fk * iv * (p[0] - s * k0);
        dp[1] += half * df1 + fk * iv * (p[1] - s * k1);
        dp[2] += half * df2 + fk * iv * (p[2] - s * k2);
    } else {
        const a2 = a * a, r2 = r * r;
        const iD = 1 / (r2 + a2), ir = 1 / r;
        const twoRD = 2 * r * iD;
        // ∂_j kx = [ξx g_j + r δ_jx + a δ_jy]/D − 2r kx g_j/D, etc.
        const dkx = [
            (xi0 * g0 + r) * iD - twoRD * k0 * g0,
            (xi0 * g1 + a) * iD - twoRD * k0 * g1,
            (xi0 * g2) * iD - twoRD * k0 * g2,
        ];
        const dky = [
            (xi1 * g0 - a) * iD - twoRD * k1 * g0,
            (xi1 * g1 + r) * iD - twoRD * k1 * g1,
            (xi1 * g2) * iD - twoRD * k1 * g2,
        ];
        const dkz = [
            -xi2 * g0 * ir * ir,
            -xi2 * g1 * ir * ir,
            ir - xi2 * g2 * ir * ir,
        ];
        dp[0] += half * df0 + fk * (dkx[0] * p[0] + dky[0] * p[1] + dkz[0] * p[2]);
        dp[1] += half * df1 + fk * (dkx[1] * p[0] + dky[1] * p[1] + dkz[1] * p[2]);
        dp[2] += half * df2 + fk * (dkx[2] * p[0] + dky[2] * p[1] + dkz[2] * p[2]);
    }
    return { f, s, r };
}

/** RHS of the 6-D system for a set of superposed holes. */
export function ksRHS(y, holes, out) {
    const x = [y[0], y[1], y[2]], p = [y[3], y[4], y[5]];
    const dx = [p[0], p[1], p[2]];
    const dp = [0, 0, 0];
    for (const h of holes) accum(x, p, h, dx, dp);
    out[0] = dx[0]; out[1] = dx[1]; out[2] = dx[2];
    out[3] = dp[0]; out[4] = dp[1]; out[5] = dp[2];
}

/** f and s = k⃗·p⃗ of one hole without gradient work (for H and init). */
function fkOf(x, p, h) {
    const xi0 = x[0] - h.c[0], xi1 = x[1] - h.c[1], xi2 = x[2] - h.c[2];
    const a = h.a;
    if (a === 0) {
        const r = Math.hypot(xi0, xi1, xi2);
        const iv = 1 / r;
        return {
            f: 2 * h.M * iv, r,
            s: (xi0 * p[0] + xi1 * p[1] + xi2 * p[2]) * iv,
        };
    }
    const R2 = xi0 * xi0 + xi1 * xi1 + xi2 * xi2;
    const a2 = a * a, q = R2 - a2;
    const r2 = 0.5 * (q + Math.sqrt(q * q + 4 * a2 * xi2 * xi2));
    const r = Math.sqrt(r2);
    const iD = 1 / (r2 + a2);
    const k0 = (r * xi0 + a * xi1) * iD;
    const k1 = (r * xi1 - a * xi0) * iD;
    const k2 = xi2 / r;
    return {
        f: 2 * h.M * r2 * r / (r2 * r2 + a2 * xi2 * xi2), r,
        s: k0 * p[0] + k1 * p[1] + k2 * p[2],
    };
}

/**
 * Null momentum in the p_t = −1 gauge for a photon at x with spatial
 * direction dir, in the superposed metric. Same quadratic as the single-
 * hole case with Σfᵢ, Σfᵢsᵢ, Σfᵢsᵢ².
 */
export function nullMomentumKS(x, dir, holes) {
    let F = 0, Fs = 0, Fss = 0;
    for (const h of holes) {
        const { f, s } = fkOf(x, dir, h);
        F += f; Fs += f * s; Fss += f * s * s;
    }
    const P2 = dir[0] ** 2 + dir[1] ** 2 + dir[2] ** 2;
    const disc = Math.sqrt(Fs * Fs + (1 + F) * (P2 - Fss));
    const pt = (Fs - disc) / (1 + F);
    const inv = 1 / (-pt);
    return [dir[0] * inv, dir[1] * inv, dir[2] * inv];
}

/** Hamiltonian ½ g^{μν}p_μp_ν in the p_t = −1 gauge (0 on a null ray). */
export function hamiltonianKS(x, p, holes) {
    let acc = 0;
    for (const h of holes) {
        const { f, s } = fkOf(x, p, h);
        const kp = 1 + s;
        acc += f * kp * kp;
    }
    return 0.5 * (-1 + p[0] ** 2 + p[1] ** 2 + p[2] ** 2 - acc);
}

/** Outer horizon radius r₊ = M + √(M² − a²) (Kerr radial coordinate). */
export const horizonR = (h) => h.M + Math.sqrt(Math.max(h.M * h.M - h.a * h.a, 0));

/**
 * Trace one photon through a set of superposed Kerr-Schild holes.
 * Terminates on capture (Kerr r < r₊ of any hole — KS is horizon-
 * penetrating so the crossing is regular), escape (|x| > rFar moving
 * outward), or step budget.
 *
 * @returns { status: 'captured'|'escaped'|'maxsteps', x, p, dir, steps,
 *            maxH, maxLzDrift } — dir is the asymptotic coordinate
 *            direction ẋ̂; maxH / maxLzDrift are conserved-quantity
 *            drifts (L_z about the first hole; exact only for one hole).
 */
export function traceRayKS(x0, dir0, holes, opts = {}) {
    const M0 = holes[0].M;
    const hK = opts.hK ?? 0.03;
    const hMin = opts.hMin ?? 0.02 * M0;
    const hMax = opts.hMax ?? 25 * M0;
    const rFar = opts.rFar ?? 2e4 * M0;
    const maxSteps = opts.maxSteps ?? 200000;
    const rPlus = holes.map(horizonR);

    const p0 = nullMomentumKS(x0, dir0, holes);
    const y = [x0[0], x0[1], x0[2], p0[0], p0[1], p0[2]];
    const lz = (yy) => (yy[0] - holes[0].c[0]) * yy[4] - (yy[1] - holes[0].c[1]) * yy[3];
    const Lz0 = lz(y);
    const k1 = new Float64Array(6), k2 = new Float64Array(6),
        k3 = new Float64Array(6), k4 = new Float64Array(6),
        yt = new Float64Array(6);
    let maxH = 0, maxLzDrift = 0, steps = 0, status = 'maxsteps';

    for (; steps < maxSteps; steps++) {
        let rMin = Infinity, captured = false;
        for (let i = 0; i < holes.length; i++) {
            const { r } = fkOf([y[0], y[1], y[2]], [0, 0, 0], holes[i]);
            if (r < rPlus[i]) captured = true;
            rMin = Math.min(rMin, r);
        }
        if (captured) { status = 'captured'; break; }
        const R = Math.hypot(y[0], y[1], y[2]);
        const out = (y[0] * y[3] + y[1] * y[4] + y[2] * y[5]) > 0;
        if (R > rFar && out) { status = 'escaped'; break; }

        const h = Math.min(Math.max(hK * rMin, hMin), hMax);
        ksRHS(y, holes, k1);
        for (let i = 0; i < 6; i++) yt[i] = y[i] + 0.5 * h * k1[i];
        ksRHS(yt, holes, k2);
        for (let i = 0; i < 6; i++) yt[i] = y[i] + 0.5 * h * k2[i];
        ksRHS(yt, holes, k3);
        for (let i = 0; i < 6; i++) yt[i] = y[i] + h * k3[i];
        ksRHS(yt, holes, k4);
        for (let i = 0; i < 6; i++) {
            y[i] += (h / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]);
        }

        maxH = Math.max(maxH, Math.abs(
            hamiltonianKS([y[0], y[1], y[2]], [y[3], y[4], y[5]], holes)));
        maxLzDrift = Math.max(maxLzDrift, Math.abs(lz(y) - Lz0) / (Math.abs(Lz0) || 1));
    }

    const x = [y[0], y[1], y[2]], p = [y[3], y[4], y[5]];
    ksRHS(y, holes, k1);
    const dl = Math.hypot(k1[0], k1[1], k1[2]) || 1;
    return {
        status, x, p, dir: [k1[0] / dl, k1[1] / dl, k1[2] / dl],
        steps, maxH, maxLzDrift,
    };
}

// ═══ single-hole wrappers (back-compat with session-2 API and tests) ═════════

export function geodesicRHS(y, M, out) { ksRHS(y, [hole([0, 0, 0], M)], out); }

export function nullMomentum(x, dir, M, a = 0) {
    return nullMomentumKS(x, dir, [hole([0, 0, 0], M, a)]);
}

export function hamiltonian(x, p, M, a = 0) {
    return hamiltonianKS(x, p, [hole([0, 0, 0], M, a)]);
}

export function traceRay(x0, dir0, M, opts = {}) {
    const res = traceRayKS(x0, dir0, [hole([0, 0, 0], M, opts.a ?? 0)], opts);
    return { ...res, maxLdrift: res.maxLzDrift };   // legacy field name
}

/** Invariant impact parameter b = |x⃗ × p⃗| / E (E = 1 gauge). */
export function impactParam(x, p) {
    const lx = x[1] * p[2] - x[2] * p[1];
    const ly = x[2] * p[0] - x[0] * p[2];
    const lz = x[0] * p[1] - x[1] * p[0];
    return Math.hypot(lx, ly, lz);
}

export const B_CRIT = Math.sqrt(27);     // Schwarzschild critical b, / M

/**
 * Screen angle (from the view axis) of the a = 0 shadow edge for a
 * coordinate-pinhole camera at distance D: the θ whose ray carries the
 * critical impact parameter b = √27 M.
 */
export function shadowScreenAngle(D, M) {
    const bOf = (th) => {
        const x = [D, 0, 0];
        const n = [-Math.cos(th), Math.sin(th), 0];
        return impactParam(x, nullMomentum(x, n, M));
    };
    let lo = 1e-4, hi = Math.PI / 3;
    for (let i = 0; i < 60; i++) {
        const mid = 0.5 * (lo + hi);
        if (bOf(mid) < B_CRIT * M) lo = mid; else hi = mid;
    }
    return 0.5 * (lo + hi);
}

/**
 * Signed equatorial shadow edges for a spinning hole seen from the
 * equatorial plane (camera at (D,0,0), spin along +z): screen angles of
 * the capture boundary on each side of the view axis, found by bisecting
 * traced rays IN the equatorial plane. Positive θ is toward +y — the
 * prograde side (L_z = D·p_y > 0). Fully numeric.
 * @returns { pro, retro }  (both positive magnitudes, radians)
 */
export function equatorialShadowEdges(D, M, a, opts = {}) {
    const holes = [hole([0, 0, 0], M, a)];
    const captured = (th) =>
        traceRayKS([D, 0, 0], [-Math.cos(th), Math.sin(th), 0], holes, opts)
            .status === 'captured';
    const edge = (sign) => {
        let lo = 1e-4, hi = 1.0;
        for (let i = 0; i < 42; i++) {
            const mid = 0.5 * (lo + hi);
            if (captured(sign * mid)) lo = mid; else hi = mid;
        }
        return 0.5 * (lo + hi);
    };
    return { pro: edge(1), retro: edge(-1) };
}

/**
 * Screen angle of the primary (n = 0) Einstein ring (a = 0) for a source
 * at the antipodal background direction, by tracing.
 */
export function einsteinRingAngle(D, M, opts = {}) {
    const miss = (th) => {
        const res = traceRay([D, 0, 0], [-Math.cos(th), Math.sin(th), 0], M, opts);
        if (res.status !== 'escaped') return NaN;
        return Math.atan2(res.dir[1], -res.dir[0]);
    };
    let prev = null, lo = null, hi = null;
    const start = shadowScreenAngle(D, M) + 5e-3;
    for (let th = Math.PI / 3; th >= start; th -= 5e-3) {
        const m = miss(th);
        if (!Number.isFinite(m)) break;
        if (prev && Math.sign(m) !== Math.sign(prev.m) && Math.abs(m - prev.m) < 1) {
            lo = th; hi = prev.th; break;
        }
        prev = { th, m };
    }
    if (lo === null) return NaN;
    for (let i = 0; i < 40; i++) {
        const mid = 0.5 * (lo + hi);
        const m = miss(mid);
        if (Math.sign(m) === Math.sign(miss(lo))) lo = mid; else hi = mid;
    }
    return 0.5 * (lo + hi);
}
