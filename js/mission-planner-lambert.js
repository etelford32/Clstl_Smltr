/**
 * mission-planner-lambert.js — Izzo's Lambert solver, ported from
 * "Revisiting Lambert's problem" (Izzo, 2014).
 *
 * Solves: given two position vectors r1, r2 and a time of flight tof, find
 * the velocity vectors v1 (at r1) and v2 (at r2) on the connecting Kepler
 * orbit around a body of gravitational parameter μ.
 *
 * This is the workhorse for non-Hohmann (Type I/II/III/IV) transfers,
 * pork-chop scans, and any trajectory where the burn isn't tangential.
 *
 * Algorithm (Izzo 2014, §III–VI):
 *   1. Reduce to 1D root-finding on the dimensionless x parameter.
 *   2. Householder iteration (3rd order) on T(x) − T_target = 0.
 *   3. Battin's hypergeometric series near the parabolic singularity x≈1.
 *   4. Reconstruct v1, v2 from x, λ, and the radial/tangential basis.
 *
 * Convergence: typically 3–6 iterations to 1e-12 relative tolerance.
 *
 * Multi-revolution: not implemented yet (single-rev only). This is enough
 * for inner-solar-system transfers where Type I and Type II dominate the
 * minimum-Δv pork-chop.
 */

// ── Vector helpers (plain Float arrays of length 3) ─────────────────────────
const vAdd   = (a, b) => [a[0]+b[0], a[1]+b[1], a[2]+b[2]];
const vSub   = (a, b) => [a[0]-b[0], a[1]-b[1], a[2]-b[2]];
const vScale = (a, s) => [a[0]*s, a[1]*s, a[2]*s];
const vNeg   = (a)    => [-a[0], -a[1], -a[2]];
const vDot   = (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
const vCross = (a, b) => [
    a[1]*b[2] - a[2]*b[1],
    a[2]*b[0] - a[0]*b[2],
    a[0]*b[1] - a[1]*b[0],
];
const vNorm  = (a) => Math.sqrt(a[0]*a[0] + a[1]*a[1] + a[2]*a[2]);

export { vAdd, vSub, vScale, vNeg, vDot, vCross, vNorm };

// ── Battin's hypergeometric helper (2F1(3, 1; 5/2; z)) ───────────────────────
// Used only in the small interval x ∈ (√0.6, √1.4) to avoid the singularity
// in the closed-form TOF expression at the parabolic point x = 1.
function hyp2f1b(z) {
    if (z >= 1) return Infinity;
    let res = 1.0, term = 1.0;
    for (let i = 0; i < 1000; i++) {
        term = term * (3 + i) * (1 + i) / (5/2 + i) * z / (i + 1);
        const next = res + term;
        if (next === res) return res;
        res = next;
    }
    return res;
}

// ── Time-of-flight machinery (dimensionless) ─────────────────────────────────
function _y(x, lambda) { return Math.sqrt(1 - lambda*lambda * (1 - x*x)); }

function _psi(x, y, lambda) {
    if (-1 <= x && x < 1) {
        // Elliptic
        return Math.acos(Math.max(-1, Math.min(1, x*y + lambda*(1 - x*x))));
    } else if (x > 1) {
        // Hyperbolic
        return Math.asinh((y - x*lambda) * Math.sqrt(x*x - 1));
    }
    return 0; // Parabolic limit
}

function _tofY(x, y, T0, lambda, M) {
    let T_;
    if (M === 0 && x > Math.sqrt(0.6) && x < Math.sqrt(1.4)) {
        const eta = y - lambda * x;
        const S1  = 0.5 * (1 - lambda - x * eta);
        const Q   = (4/3) * hyp2f1b(S1);
        T_ = 0.5 * (eta*eta*eta * Q + 4 * lambda * eta);
    } else {
        const psi  = _psi(x, y, lambda);
        const omx2 = 1 - x*x;
        T_ = ((psi + M*Math.PI) / Math.sqrt(Math.abs(omx2)) - x + lambda*y) / omx2;
    }
    return T_ - T0;
}

function _dTdx (x, y, T, lambda)            { return (3*T*x - 2 + 2*Math.pow(lambda,3)*x/y) / (1 - x*x); }
function _d2Tdx(x, y, T, dT, lambda)        { return (3*T + 5*x*dT + 2*(1 - lambda*lambda)*Math.pow(lambda,3)/Math.pow(y,3)) / (1 - x*x); }
function _d3Tdx(x, y, T, dT, ddT, lambda)   { return (7*x*ddT + 8*dT - 6*(1 - lambda*lambda)*Math.pow(lambda,5)*x/Math.pow(y,5)) / (1 - x*x); }

function householder(x0, T0, lambda, M, tol = 1e-12, maxIter = 35) {
    let x = x0;
    for (let i = 0; i < maxIter; i++) {
        const y    = _y(x, lambda);
        const fval = _tofY(x, y, T0, lambda, M);
        const T    = fval + T0;
        const f1   = _dTdx (x, y, T, lambda);
        const f2   = _d2Tdx(x, y, T, f1, lambda);
        const f3   = _d3Tdx(x, y, T, f1, f2, lambda);
        const num  = f1*f1 - 0.5*fval*f2;
        const den  = f1*(f1*f1 - fval*f2) + (f3*fval*fval)/6;
        const dx   = fval * (num / den);
        const xNew = x - dx;
        if (Math.abs(xNew - x) < tol) return { x: xNew, iter: i + 1 };
        x = xNew;
    }
    throw new Error('Lambert: Householder did not converge');
}

function initialGuess(T, lambda, M = 0) {
    if (M !== 0) throw new Error('Lambert: multi-rev not implemented');
    const T0 = Math.acos(lambda) + lambda * Math.sqrt(1 - lambda*lambda);
    const T1 = (2/3) * (1 - Math.pow(lambda, 3));
    if (T >= T0) {
        // Long flights: hyperbolic-ish
        return Math.pow(T0/T, 2/3) - 1;
    } else if (T <= T1) {
        // Short flights: highly elliptical
        return 5/2 * T1/T * (T1 - T) / (1 - Math.pow(lambda, 5)) + 1;
    } else {
        // In-between: power-law interpolation
        return Math.exp(Math.log(2) * Math.log(T/T0) / Math.log(T1/T0)) - 1;
    }
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Solve Lambert's problem.
 *
 * @param {number[3]} r1Vec   Position at departure (km, inertial frame).
 * @param {number[3]} r2Vec   Position at arrival   (km, inertial frame).
 * @param {number}    tof     Time of flight (seconds, > 0).
 * @param {number}    mu      Gravitational parameter of the central body (km³/s²).
 * @param {object}    options
 * @param {boolean}   options.prograde  If true (default), pick the prograde
 *                                      branch (h_z > 0); else retrograde.
 * @param {number}    options.M         Number of complete revolutions
 *                                      (0 default; multi-rev not yet supported).
 * @returns {{ v1:[x,y,z], v2:[x,y,z], iter:number, x:number, lambda:number }}
 */
export function lambert(r1Vec, r2Vec, tof, mu, options = {}) {
    const prograde = options.prograde !== false;
    const M = options.M || 0;

    const r1 = vNorm(r1Vec);
    const r2 = vNorm(r2Vec);
    const cVec = vSub(r2Vec, r1Vec);
    const c = vNorm(cVec);
    const s = 0.5 * (r1 + r2 + c);

    const ir1 = vScale(r1Vec, 1/r1);
    const ir2 = vScale(r2Vec, 1/r2);
    let ih = vCross(ir1, ir2);
    const ihMag = vNorm(ih);
    if (ihMag < 1e-12) {
        throw new Error('Lambert: r1 and r2 are colinear (degenerate transfer)');
    }
    ih = vScale(ih, 1/ihMag);

    let lambda = Math.sqrt(Math.max(0, 1 - c/s));
    let it1 = vCross(ih, ir1);
    let it2 = vCross(ih, ir2);

    // Branch selection by transfer direction.
    if (prograde) {
        if (ih[2] < 0) {
            lambda = -lambda;
            it1 = vNeg(it1);
            it2 = vNeg(it2);
        }
    } else {
        if (ih[2] >= 0) {
            lambda = -lambda;
            it1 = vNeg(it1);
            it2 = vNeg(it2);
        }
    }

    const T = Math.sqrt(2 * mu / (s*s*s)) * tof;

    const x0 = initialGuess(T, lambda, M);
    const { x, iter } = householder(x0, T, lambda, M);

    const y     = _y(x, lambda);
    const gamma = Math.sqrt(mu * s / 2);
    const rho   = (r1 - r2) / c;
    const sigma = Math.sqrt(1 - rho*rho);

    const Vr1 =  gamma * ((lambda*y - x) - rho*(lambda*y + x)) / r1;
    const Vr2 = -gamma * ((lambda*y - x) + rho*(lambda*y + x)) / r2;
    const Vt1 =  gamma * sigma * (y + lambda*x) / r1;
    const Vt2 =  gamma * sigma * (y + lambda*x) / r2;

    const v1 = vAdd(vScale(ir1, Vr1), vScale(it1, Vt1));
    const v2 = vAdd(vScale(ir2, Vr2), vScale(it2, Vt2));

    return { v1, v2, iter, x, lambda };
}

/**
 * Sample positions along the Kepler orbit defined by a Lambert solution.
 * Useful for rendering the actual transfer arc in the heliocentric scene
 * without re-running the solver.
 *
 * Uses Lagrange f/g coefficients propagated by Newton iteration on the
 * universal Kepler equation. Numerically robust for ellipse + hyperbola.
 *
 * @param {number[3]} r1   Initial position (km).
 * @param {number[3]} v1   Initial velocity (km/s).
 * @param {number}    tof  Total time of flight (s).
 * @param {number}    mu   Central body μ (km³/s²).
 * @param {number}    n    Number of samples (≥ 2).
 * @returns {Array<[x,y,z]>}  n samples from t=0 to t=tof.
 */
export function sampleKeplerArc(r1, v1, tof, mu, n = 64) {
    const out = new Array(n);
    out[0] = [...r1];
    for (let i = 1; i < n; i++) {
        const t = tof * (i / (n - 1));
        const r = propagateKepler(r1, v1, t, mu);
        out[i] = r;
    }
    return out;
}

// ── Universal-variable Kepler propagator ────────────────────────────────────
// Returns position only (we don't need velocity for the line render).
function propagateKepler(r0, v0, dt, mu) {
    const r0m = vNorm(r0);
    const v0m = vNorm(v0);
    const vr0 = vDot(r0, v0) / r0m;
    const alpha = 2 / r0m - (v0m * v0m) / mu;        // 1/a (sign tells conic type)

    // Initial guess for universal anomaly χ
    let chi;
    if (alpha > 1e-10) {                              // Ellipse
        chi = Math.sqrt(mu) * dt * alpha;
    } else if (Math.abs(alpha) < 1e-10) {             // Parabola
        const h = vNorm(vCross(r0, v0));
        const p = h*h / mu;
        const s = 0.5 * Math.atan(1 / (3 * Math.sqrt(mu/(p*p*p)) * dt));
        const w = Math.atan(Math.pow(Math.tan(s), 1/3));
        chi = Math.sqrt(p) * 2 / Math.tan(2*w);
    } else {                                          // Hyperbola
        const a = 1 / alpha;
        chi = Math.sign(dt) * Math.sqrt(-a) *
            Math.log(-2*mu*alpha*dt / (vDot(r0, v0) + Math.sign(dt) * Math.sqrt(-mu*a) * (1 - r0m*alpha)));
        if (!Number.isFinite(chi)) chi = Math.sqrt(mu) * dt * alpha;
    }

    // Newton iteration on universal Kepler equation
    for (let i = 0; i < 50; i++) {
        const psi = chi*chi * alpha;
        const c2 = stumpffC(psi);
        const c3 = stumpffS(psi);
        const r  = chi*chi * c2 + (vr0/Math.sqrt(mu)) * chi * (1 - psi*c3) + r0m * (1 - psi*c2);
        const F  = chi*chi*chi * c3 + (vr0/Math.sqrt(mu)) * chi*chi * c2 + r0m * chi * (1 - psi*c3) - Math.sqrt(mu)*dt;
        const dchi = F / r;
        chi -= dchi;
        if (Math.abs(dchi) < 1e-10) break;
    }

    const psi = chi*chi * alpha;
    const c2 = stumpffC(psi);
    const c3 = stumpffS(psi);
    const f  = 1 - (chi*chi/r0m) * c2;
    const g  = dt - (1/Math.sqrt(mu)) * chi*chi*chi * c3;
    return vAdd(vScale(r0, f), vScale(v0, g));
}

function stumpffC(z) {
    if (z > 1e-6)  return (1 - Math.cos(Math.sqrt(z))) / z;
    if (z < -1e-6) return (Math.cosh(Math.sqrt(-z)) - 1) / (-z);
    return 0.5 - z/24 + z*z/720;
}
function stumpffS(z) {
    if (z > 1e-6)  { const s = Math.sqrt(z);  return (s - Math.sin(s)) / Math.pow(s, 3); }
    if (z < -1e-6) { const s = Math.sqrt(-z); return (Math.sinh(s) - s) / Math.pow(s, 3); }
    return 1/6 - z/120 + z*z/5040;
}
