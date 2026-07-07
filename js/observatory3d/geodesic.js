// geodesic.js — null-geodesic integration in Kerr-Schild form (a = 0 for
// now: Schwarzschild in horizon-penetrating Cartesian coordinates). This is
// the JS REFERENCE implementation of the math the observatory's ray-tracing
// fragment shader (ks-tracer.frag.js) runs per pixel — one algorithm, two
// backends, kept in lockstep exactly like nbody.js ↔ rust-abell85.
//
// Why Kerr-Schild and not Boyer-Lindquist (which js/ton618/ uses):
//   · Cartesian components — no coordinate singularity at the poles and no
//     Δ = 0 blowup at the horizon, so rays can be terminated *inside* r = 2M
//     instead of being pre-clipped outside it (shader-friendly: no guard
//     bands in an RK stage);
//   · the metric is η_μν + f k_μ k_ν with an EXACT closed-form inverse
//     η^μν − f k^μ k^ν, so the Hamiltonian right-hand side is ~20 flops;
//   · two holes superpose as η + f₁k₁k₁ + f₂k₂k₂ (approximate, standard for
//     visualization) — the binary case of the upgrade plan needs this form.
//
// Formulation: Hamiltonian on the covariant momentum, H = ½ g^{μν}p_μ p_ν,
// signature (−+++), geometrized units G = c = 1, mass M in the same length
// unit as x (so r_s = 2M). Staticity ⇒ p_t is exactly conserved; we fix the
// null-cone scale to E = −p_t = 1. State is y = (x⃗, p⃗) ∈ ℝ⁶ with
//
//   f = 2M/r,  x̂ = x⃗/r,  s = x̂·p⃗,  κ ≡ k^μp_μ = 1 + s
//   ẋ_i = p_i − f κ x̂_i
//   ṗ_i = −(f/2r²) κ² x_i + (f/r) κ p_i − (f/r²) κ s x_i
//
// Integrator: classical RK4, step h = clamp(K_H·r, hMin, hMax) — curvature
// scales as M/r³, so a radius-proportional step keeps local error roughly
// uniform (same reasoning as the shader). Conserved-quantity drift (H ≈ 0,
// L⃗ = x⃗×p⃗) is asserted in tests/observatory-geodesic.mjs.
//
// DOM-free; unit-tested in Node.

/** Right-hand side of the 6-D system. y = [x,y,z,px,py,pz], out likewise. */
export function geodesicRHS(y, M, out) {
    const x0 = y[0], x1 = y[1], x2 = y[2];
    const p0 = y[3], p1 = y[4], p2 = y[5];
    const r = Math.hypot(x0, x1, x2);
    const inv = 1 / r;
    const f = 2 * M * inv;
    const s = (x0 * p0 + x1 * p1 + x2 * p2) * inv;
    const kp = 1 + s;
    const fk = f * kp;
    out[0] = p0 - fk * x0 * inv;
    out[1] = p1 - fk * x1 * inv;
    out[2] = p2 - fk * x2 * inv;
    const cx = -0.5 * f * kp * kp * inv * inv - fk * s * inv * inv;
    const cp = fk * inv;
    out[3] = cx * x0 + cp * p0;
    out[4] = cx * x1 + cp * p1;
    out[5] = cx * x2 + cp * p2;
}

/**
 * Null momentum for a photon at position x with spatial direction dir
 * (need not be unit). Solves H = 0 for p_t given p⃗ ∝ dir, then rescales
 * to the E = −p_t = 1 gauge. Returns the spatial covariant momentum p⃗.
 */
export function nullMomentum(x, dir, M) {
    const r = Math.hypot(x[0], x[1], x[2]);
    const f = 2 * M / r;
    const P2 = dir[0] ** 2 + dir[1] ** 2 + dir[2] ** 2;
    const s = (x[0] * dir[0] + x[1] * dir[1] + x[2] * dir[2]) / r;
    // (1+f)p_t² − 2fs·p_t − (P² − fs²) = 0, future-directed root p_t < 0
    const disc = Math.sqrt(f * f * s * s + (1 + f) * (P2 - f * s * s));
    const pt = (f * s - disc) / (1 + f);
    const inv = 1 / (-pt);                       // rescale to p_t = −1
    return [dir[0] * inv, dir[1] * inv, dir[2] * inv];
}

/** Invariant impact parameter b = |x⃗ × p⃗| / E (E = 1 gauge). */
export function impactParam(x, p) {
    const lx = x[1] * p[2] - x[2] * p[1];
    const ly = x[2] * p[0] - x[0] * p[2];
    const lz = x[0] * p[1] - x[1] * p[0];
    return Math.hypot(lx, ly, lz);
}

/** Hamiltonian ½ g^{μν}p_μp_ν in the p_t = −1 gauge (0 on a null ray). */
export function hamiltonian(x, p, M) {
    const r = Math.hypot(x[0], x[1], x[2]);
    const f = 2 * M / r;
    const P2 = p[0] ** 2 + p[1] ** 2 + p[2] ** 2;
    const s = (x[0] * p[0] + x[1] * p[1] + x[2] * p[2]) / r;
    const kp = 1 + s;
    return 0.5 * (-1 + P2 - f * kp * kp);
}

/**
 * Trace one photon. Terminates on horizon capture (r < 2M — Kerr-Schild is
 * horizon-penetrating, so crossing is regular and 2M is a safe one-way
 * surface), escape (r > rFar moving outward), or step budget.
 *
 * @returns { status: 'captured'|'escaped'|'maxsteps', x, p, dir, steps,
 *            maxH, maxLdrift }  — dir is the asymptotic coordinate
 *            direction ẋ̂ at termination; maxH / maxLdrift are conserved-
 *            quantity drifts for the test contract.
 */
export function traceRay(x0, dir0, M, opts = {}) {
    const hK = opts.hK ?? 0.03;          // step = hK · r
    const hMin = opts.hMin ?? 0.02 * M;
    const hMax = opts.hMax ?? 25 * M;
    const rFar = opts.rFar ?? 2e4 * M;
    const maxSteps = opts.maxSteps ?? 200000;

    const p0 = nullMomentum(x0, dir0, M);
    const y = [x0[0], x0[1], x0[2], p0[0], p0[1], p0[2]];
    const L0 = impactParam(x0, p0);
    const k1 = new Float64Array(6), k2 = new Float64Array(6),
        k3 = new Float64Array(6), k4 = new Float64Array(6),
        yt = new Float64Array(6);
    let maxH = 0, maxLdrift = 0, steps = 0, status = 'maxsteps';

    for (; steps < maxSteps; steps++) {
        const r = Math.hypot(y[0], y[1], y[2]);
        if (r < 2 * M) { status = 'captured'; break; }
        const out = (y[0] * y[3] + y[1] * y[4] + y[2] * y[5]) > 0;
        if (r > rFar && out) { status = 'escaped'; break; }

        const h = Math.min(Math.max(hK * r, hMin), hMax);
        geodesicRHS(y, M, k1);
        for (let i = 0; i < 6; i++) yt[i] = y[i] + 0.5 * h * k1[i];
        geodesicRHS(yt, M, k2);
        for (let i = 0; i < 6; i++) yt[i] = y[i] + 0.5 * h * k2[i];
        geodesicRHS(yt, M, k3);
        for (let i = 0; i < 6; i++) yt[i] = y[i] + h * k3[i];
        geodesicRHS(yt, M, k4);
        for (let i = 0; i < 6; i++) {
            y[i] += (h / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]);
        }

        const xs = [y[0], y[1], y[2]], ps = [y[3], y[4], y[5]];
        maxH = Math.max(maxH, Math.abs(hamiltonian(xs, ps, M)));
        maxLdrift = Math.max(maxLdrift, Math.abs(impactParam(xs, ps) - L0) / (L0 || 1));
    }

    const x = [y[0], y[1], y[2]], p = [y[3], y[4], y[5]];
    // asymptotic direction: ẋ = p − fκx̂ → p as f → 0
    const d = new Float64Array(3);
    geodesicRHS(y, M, k1);
    const dl = Math.hypot(k1[0], k1[1], k1[2]) || 1;
    d[0] = k1[0] / dl; d[1] = k1[1] / dl; d[2] = k1[2] / dl;
    return { status, x, p, dir: [d[0], d[1], d[2]], steps, maxH, maxLdrift };
}

export const B_CRIT = Math.sqrt(27);     // critical impact parameter, / M

/**
 * Screen angle (from the view axis) of the shadow edge for a coordinate-
 * pinhole camera at distance D looking at the hole: the θ whose ray carries
 * the critical impact parameter b = √27·M. Both the prototype overlay and
 * the numeric test use this mapping, so the shader is validated against the
 * same camera model it renders with.
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
 * Screen angle of the primary (n = 0) Einstein ring for a source at the
 * antipodal background direction (−x̂ at infinity), found by tracing rays
 * outward from the shadow edge until the escape direction crosses −x̂.
 * Fully numeric — inherits the integrator's validation.
 */
export function einsteinRingAngle(D, M, opts = {}) {
    const miss = (th) => {
        const res = traceRay([D, 0, 0], [-Math.cos(th), Math.sin(th), 0], M, opts);
        if (res.status !== 'escaped') return NaN;
        // signed in-plane angle of escape dir relative to −x̂
        return Math.atan2(res.dir[1], -res.dir[0]);
    };
    // walk outward from just past the shadow edge to bracket the n=0 root
    // (skipping the wrapped n≥1 images that hug the critical curve)
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
