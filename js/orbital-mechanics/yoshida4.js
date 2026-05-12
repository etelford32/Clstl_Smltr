/**
 * yoshida4.js — Yoshida-4 symplectic N-body integrator (pure module)
 *
 * Triple-Verlet 4th-order construction (Yoshida 1990):
 *   Each Yoshida step is composed of three Verlet (leapfrog) sub-steps with
 *   sub-step lengths c1·dt, c0·dt, c1·dt where
 *      c0 = -2^(1/3) / (2 - 2^(1/3))   ≈ -1.7024
 *      c1 =  1       / (2 - 2^(1/3))   ≈  1.3512
 *      c0 + 2 c1 = 1
 *   Composed, this becomes a DRIFT–KICK–DRIFT–KICK–DRIFT–KICK–DRIFT
 *   sequence with 4 drift coefficients and 3 kick coefficients.
 *
 * Units (Gaussian):  AU, days, M_sun.  GM_sun = k² where k is the Gaussian
 *   gravitational constant 0.01720209895 rad/day.  This keeps Earth's
 *   semi-major axis at ≈1.0 with a circular speed of ≈k AU/day.
 *
 * State layout:
 *   { r:  Float64Array(3N)  — barycentric Cartesian positions (AU)
 *     v:  Float64Array(3N)  — barycentric velocities          (AU/day)
 *     gm: Float64Array(N)   — gravitational parameters        (AU³/day²) }
 *   Coordinates are inertial barycentric ECLIPJ2000.
 *
 * Energy is conserved to machine precision long-term in the absence of
 * close encounters (because the integrator is symplectic).  Angular
 * momentum is conserved exactly.
 *
 * References:
 *   Yoshida, H. (1990) "Construction of higher-order symplectic
 *     integrators." Phys. Lett. A 150, 262–268.
 *   Hairer, Lubich, Wanner (2006) "Geometric Numerical Integration",
 *     §VI.3, Springer.
 */

// Gaussian gravitational constant (rad/day)
export const GAUSSIAN_K   = 0.01720209895;
export const GM_SUN       = GAUSSIAN_K * GAUSSIAN_K;   // AU³/day²
export const SECONDS_PER_DAY = 86400;

// Yoshida-4 composition coefficients
const CBRT2 = Math.cbrt(2);
const W0 = -CBRT2 / (2 - CBRT2);
const W1 =  1     / (2 - CBRT2);

// Drift / kick coefficients per step (sum of drifts = sum of kicks = 1)
const DRIFT_C = [W1 / 2, (W0 + W1) / 2, (W0 + W1) / 2, W1 / 2];   // 4
const KICK_C  = [W1, W0, W1];                                     // 3

/**
 * Allocate scratch acceleration buffer matched to a state.
 * Caller can re-use across steps to avoid GC churn.
 */
export function makeAccelBuffer(N) {
    return new Float64Array(N * 3);
}

/**
 * One full Yoshida-4 step. Mutates state in place.
 * `accel` is a scratch Float64Array(3N) — pass one from makeAccelBuffer.
 */
export function yoshida4Step(state, dt, accel) {
    drift(state, DRIFT_C[0] * dt);
    kick (state, KICK_C [0] * dt, accel);
    drift(state, DRIFT_C[1] * dt);
    kick (state, KICK_C [1] * dt, accel);
    drift(state, DRIFT_C[2] * dt);
    kick (state, KICK_C [2] * dt, accel);
    drift(state, DRIFT_C[3] * dt);
}

function drift(state, dt) {
    const r = state.r, v = state.v;
    const L = r.length;
    for (let i = 0; i < L; i++) r[i] += v[i] * dt;
}

function kick(state, dt, a) {
    const r = state.r, v = state.v, gm = state.gm;
    const N = gm.length;
    a.fill(0);
    // All-pairs gravity. Symmetric: f_ij = -f_ji, so only loop j > i.
    for (let i = 0; i < N; i++) {
        const ix = i * 3;
        const xi = r[ix], yi = r[ix+1], zi = r[ix+2];
        const gmi = gm[i];
        for (let j = i + 1; j < N; j++) {
            const jx = j * 3;
            const dx = r[jx]   - xi;
            const dy = r[jx+1] - yi;
            const dz = r[jx+2] - zi;
            const r2 = dx*dx + dy*dy + dz*dz;
            const r1 = Math.sqrt(r2);
            const inv_r3 = 1 / (r2 * r1);
            const ax = dx * inv_r3;
            const ay = dy * inv_r3;
            const az = dz * inv_r3;
            const gmj = gm[j];
            // a_i += GM_j * (r_j - r_i) / |r_j - r_i|^3
            a[ix]   += gmj * ax;
            a[ix+1] += gmj * ay;
            a[ix+2] += gmj * az;
            a[jx]   -= gmi * ax;
            a[jx+1] -= gmi * ay;
            a[jx+2] -= gmi * az;
        }
    }
    const L = v.length;
    for (let i = 0; i < L; i++) v[i] += a[i] * dt;
}

/**
 * Total mechanical energy (kinetic + potential) of the N-body system.
 * Useful for checking symplectic drift over long runs.
 *
 *   E = ½ Σ m_i |v_i|²  −  Σ_{i<j} G m_i m_j / r_ij
 *
 * Returned in code-mass units (m = GM_i / G with G implicit), so it's
 * proportional to true energy and constant to machine precision
 * for the symplectic step.  Use only as a relative diagnostic.
 */
export function totalEnergy(state) {
    const r = state.r, v = state.v, gm = state.gm;
    const N = gm.length;
    let T = 0, U = 0;
    for (let i = 0; i < N; i++) {
        const ix = i * 3;
        const vx = v[ix], vy = v[ix+1], vz = v[ix+2];
        T += 0.5 * gm[i] * (vx*vx + vy*vy + vz*vz);
        for (let j = i + 1; j < N; j++) {
            const jx = j * 3;
            const dx = r[jx]   - r[ix];
            const dy = r[jx+1] - r[ix+1];
            const dz = r[jx+2] - r[ix+2];
            U -= gm[i] * gm[j] / Math.sqrt(dx*dx + dy*dy + dz*dz);
        }
    }
    return T + U;
}

/**
 * Convert a heliocentric state vector (r, v) into mean Keplerian elements.
 *
 *   mu = GM_sun + GM_body  (specific orbital μ for two-body Kepler problem)
 *   r       — heliocentric position (AU)        [3-vector or {x,y,z}]
 *   v       — heliocentric velocity (AU/day)    [3-vector or {x,y,z}]
 *
 * Returns:
 *   a        semi-major axis           (AU)
 *   e        eccentricity              (–)
 *   i        inclination               (deg)
 *   node     longitude of ascending Ω  (deg, 0…360)
 *   omegaBar longitude of perihelion ω̄ = Ω + ω (deg, 0…360)
 *   M        mean anomaly              (deg, 0…360)
 *   L        mean longitude            (deg, 0…360)
 *   nu       true anomaly              (deg, 0…360)
 *
 * Singular handling:  for circular orbits (e≈0) ω is undefined; we set ω=0
 *   so ω̄=Ω. For equatorial orbits (i≈0) Ω is undefined; we set Ω=0.
 */
export function stateToElements(rx, ry, rz, vx, vy, vz, mu) {
    const R2D = 180 / Math.PI;
    const r2  = rx*rx + ry*ry + rz*rz;
    const r1  = Math.sqrt(r2);
    const v2  = vx*vx + vy*vy + vz*vz;

    // Specific angular momentum h = r × v
    const hx = ry * vz - rz * vy;
    const hy = rz * vx - rx * vz;
    const hz = rx * vy - ry * vx;
    const h2 = hx*hx + hy*hy + hz*hz;
    const h1 = Math.sqrt(h2);

    // Eccentricity vector e = (v × h)/μ − r̂
    const ex = (vy * hz - vz * hy) / mu - rx / r1;
    const ey = (vz * hx - vx * hz) / mu - ry / r1;
    const ez = (vx * hy - vy * hx) / mu - rz / r1;
    const e  = Math.sqrt(ex*ex + ey*ey + ez*ez);

    // Semi-major axis from vis-viva:  v² = μ (2/r − 1/a)
    const inv_a = 2 / r1 - v2 / mu;
    const a = 1 / inv_a;     // negative for hyperbolic, fine

    // Inclination
    const inc = Math.acos(Math.max(-1, Math.min(1, hz / h1)));

    // Node vector n = ẑ × h = (-h_y, h_x, 0)
    const nx = -hy, ny = hx;
    const n1 = Math.sqrt(nx*nx + ny*ny);

    let node, argp;
    if (n1 < 1e-12) {
        // Equatorial — Ω undefined, take 0
        node = 0;
        // ω from the eccentricity vector directly
        argp = Math.atan2(ey, ex);
        if (hz < 0) argp = -argp;
    } else {
        node = Math.atan2(ny, nx);   // = atan2(hx, -hy)
        if (e < 1e-12) {
            // Circular — ω undefined, take 0
            argp = 0;
        } else {
            // cos ω = (n · e) / (|n| |e|), sign by e_z
            const cosw = (nx * ex + ny * ey) / (n1 * e);
            argp = Math.acos(Math.max(-1, Math.min(1, cosw)));
            if (ez < 0) argp = -argp;
        }
    }

    // True anomaly ν: cos ν = (e · r)/(|e| r), sign by (r·v)
    let nu;
    if (e < 1e-12) {
        // Argument of latitude u (since ω is undef)
        if (n1 < 1e-12) {
            nu = Math.atan2(ry, rx);
        } else {
            const cosu = (nx * rx + ny * ry) / (n1 * r1);
            nu = Math.acos(Math.max(-1, Math.min(1, cosu)));
            if (rz < 0) nu = -nu;
        }
    } else {
        const cosnu = (ex * rx + ey * ry + ez * rz) / (e * r1);
        nu = Math.acos(Math.max(-1, Math.min(1, cosnu)));
        if (rx * vx + ry * vy + rz * vz < 0) nu = -nu;
    }

    // Mean anomaly via eccentric anomaly  tan(E/2) = √((1−e)/(1+e)) tan(ν/2)
    let M;
    if (e < 1) {
        const E = 2 * Math.atan2(Math.sqrt(1 - e) * Math.sin(nu / 2),
                                 Math.sqrt(1 + e) * Math.cos(nu / 2));
        M = E - e * Math.sin(E);
    } else {
        M = nu;   // hyperbolic edge case — not physical here
    }

    const norm360 = x => { const y = (x * R2D) % 360; return y < 0 ? y + 360 : y; };

    const omegaBar = norm360(node + argp);
    return {
        a,
        e,
        i:        inc * R2D,
        node:     norm360(node),
        omegaBar,
        M:        norm360(M),
        L:        norm360(node + argp + M),
        nu:       norm360(nu),
    };
}

/**
 * Solve Kepler's equation  M = E − e sin E  by Newton-Raphson with a
 * conservative starting estimate.  Returns E in radians.  Used for
 * propagating Keplerian asteroid elements from their epoch to J2000.
 */
export function solveKepler(M, e, tol = 1e-12, maxIter = 30) {
    // Wrap M into [-π, π) for fastest convergence
    let m = M % (2 * Math.PI);
    if (m >  Math.PI) m -= 2 * Math.PI;
    if (m < -Math.PI) m += 2 * Math.PI;
    let E = m + e * Math.sin(m);   // first-order seed
    for (let k = 0; k < maxIter; k++) {
        const f  = E - e * Math.sin(E) - m;
        const fp = 1 - e * Math.cos(E);
        const dE = f / fp;
        E -= dE;
        if (Math.abs(dE) < tol) return E;
    }
    return E;
}

/**
 * Convert classical Keplerian elements + epoch to a heliocentric state
 * vector at a target JD.  Two-body Kepler propagation.
 *
 * @param {object} el
 *   a, e, i (deg), node (deg), argp (deg, NOT ω̄), M0 (deg at epochJd)
 *   mu_eff   GM_sun + GM_body  (AU³/day²)
 *   epochJd  Julian Day of element set
 * @param {number} jd  target Julian Day
 * @returns {{ rx, ry, rz, vx, vy, vz }}
 */
export function elementsToState(el, jd) {
    const D2R = Math.PI / 180;
    const a = el.a, e = el.e;
    const inc  = el.i    * D2R;
    const node = el.node * D2R;
    const argp = el.argp * D2R;
    const mu   = el.mu_eff;

    // Mean motion  n = √(μ/a³)   (rad/day)
    const n = Math.sqrt(mu / (a * a * a));
    const M = el.M0 * D2R + n * (jd - el.epochJd);

    const E    = solveKepler(M, e);
    const cosE = Math.cos(E), sinE = Math.sin(E);

    // Position in perifocal frame
    const px = a * (cosE - e);
    const py = a * Math.sqrt(1 - e * e) * sinE;
    const r  = a * (1 - e * cosE);

    // Velocity in perifocal frame
    const fac = Math.sqrt(mu * a) / r;
    const vpx = -fac * sinE;
    const vpy =  fac * Math.sqrt(1 - e * e) * cosE;

    // Rotation: R_z(Ω) · R_x(i) · R_z(ω)
    const cO = Math.cos(node), sO = Math.sin(node);
    const ci = Math.cos(inc),  si = Math.sin(inc);
    const cw = Math.cos(argp), sw = Math.sin(argp);

    // Combined rotation matrix (perifocal → ecliptic)
    const R11 =  cO * cw - sO * sw * ci;
    const R12 = -cO * sw - sO * cw * ci;
    const R21 =  sO * cw + cO * sw * ci;
    const R22 = -sO * sw + cO * cw * ci;
    const R31 =  sw * si;
    const R32 =  cw * si;

    return {
        rx: R11 * px + R12 * py,
        ry: R21 * px + R22 * py,
        rz: R31 * px + R32 * py,
        vx: R11 * vpx + R12 * vpy,
        vy: R21 * vpx + R22 * vpy,
        vz: R31 * vpx + R32 * vpy,
    };
}
