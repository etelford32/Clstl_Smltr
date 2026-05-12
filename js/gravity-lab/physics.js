/**
 * physics.js — Yoshida-4 symplectic N-body integrator + orbital-element helpers.
 *
 * Bodies carry SI units throughout: meters, m/s, kilograms, seconds.
 * The integrator uses pairwise Newtonian gravity. An optional central-body
 * J2 perturbation hook is included but disabled by default (Phase 1 ships
 * point-mass dynamics only — J2 lights up in Phase 2).
 *
 * Numerical scheme:
 *   Yoshida (1990), 4th-order symplectic 7-stage drift-kick-drift composition.
 *   Energy and angular momentum are bounded (no secular drift) for any step
 *   size that is small relative to the shortest dynamical period.
 *
 * References
 *   Yoshida, H. (1990). "Construction of higher order symplectic integrators."
 *     Phys. Lett. A 150, 262-268.
 *   Hairer, Lubich & Wanner (2006). "Geometric Numerical Integration."
 *   Vallado (2013). "Fundamentals of Astrodynamics and Applications", 4th ed.
 *     Element <-> state vector algorithms.
 */

export const G_SI = 6.67430e-11;   // CODATA 2018 (m^3 kg^-1 s^-2)

// Yoshida-4 composition coefficients
const _W1 = 1 / (2 - Math.cbrt(2));
const _W0 = -Math.cbrt(2) * _W1;
const C_COEF = [_W1 / 2, (_W0 + _W1) / 2, (_W0 + _W1) / 2, _W1 / 2];
const D_COEF = [_W1, _W0, _W1];

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

/**
 * Advance the system by one Yoshida-4 step.
 * Body shape: { m: kg, r: [x,y,z] m, v: [vx,vy,vz] m/s }
 *
 * @param {Array} bodies   Mutated in place.
 * @param {number} dt      Step size (seconds). Negative => time reversal.
 * @param {object} [opts]  { J2: { centerIdx, J2, R_eq, mu } } optional.
 */
export function yoshida4Step(bodies, dt, opts) {
    _drift(bodies, C_COEF[0] * dt);
    _kick (bodies, D_COEF[0] * dt, opts);
    _drift(bodies, C_COEF[1] * dt);
    _kick (bodies, D_COEF[1] * dt, opts);
    _drift(bodies, C_COEF[2] * dt);
    _kick (bodies, D_COEF[2] * dt, opts);
    _drift(bodies, C_COEF[3] * dt);
}

function _drift(bodies, dt) {
    for (const b of bodies) {
        b.r[0] += b.v[0] * dt;
        b.r[1] += b.v[1] * dt;
        b.r[2] += b.v[2] * dt;
    }
}

function _kick(bodies, dt, opts) {
    const a = _accelerations(bodies, opts);
    for (let i = 0; i < bodies.length; i++) {
        bodies[i].v[0] += a[i][0] * dt;
        bodies[i].v[1] += a[i][1] * dt;
        bodies[i].v[2] += a[i][2] * dt;
    }
}

function _accelerations(bodies, opts) {
    const N = bodies.length;
    const acc = new Array(N);
    for (let i = 0; i < N; i++) acc[i] = [0, 0, 0];

    // Pairwise Newtonian gravity. Newton's third law => one pass over (i<j).
    for (let i = 0; i < N; i++) {
        for (let j = i + 1; j < N; j++) {
            const dx = bodies[j].r[0] - bodies[i].r[0];
            const dy = bodies[j].r[1] - bodies[i].r[1];
            const dz = bodies[j].r[2] - bodies[i].r[2];
            const r2 = dx*dx + dy*dy + dz*dz;
            const r  = Math.sqrt(r2);
            const inv_r3 = 1 / (r2 * r);
            const Gi = G_SI * inv_r3;
            const aij = Gi * bodies[j].m;
            const aji = Gi * bodies[i].m;
            acc[i][0] += aij * dx;
            acc[i][1] += aij * dy;
            acc[i][2] += aij * dz;
            acc[j][0] -= aji * dx;
            acc[j][1] -= aji * dy;
            acc[j][2] -= aji * dz;
        }
    }

    // Optional oblateness (J2) of a single central body. Equatorial frame
    // assumption: z axis aligned with the spin axis. Caller is responsible
    // for matching frame conventions.
    if (opts && opts.J2) {
        const { centerIdx, J2, R_eq, mu } = opts.J2;
        const c = bodies[centerIdx];
        for (let i = 0; i < N; i++) {
            if (i === centerIdx) continue;
            const dx = bodies[i].r[0] - c.r[0];
            const dy = bodies[i].r[1] - c.r[1];
            const dz = bodies[i].r[2] - c.r[2];
            const r2 = dx*dx + dy*dy + dz*dz;
            const r  = Math.sqrt(r2);
            const r5 = r2 * r2 * r;
            const zr = dz / r;
            const k  = -1.5 * J2 * mu * R_eq * R_eq / r5;
            const kx = k * (1 - 5 * zr * zr);
            const ky = k * (1 - 5 * zr * zr);
            const kz = k * (3 - 5 * zr * zr);
            acc[i][0] += kx * dx;
            acc[i][1] += ky * dy;
            acc[i][2] += kz * dz;
            const wt = bodies[i].m / c.m;
            acc[centerIdx][0] -= kx * dx * wt;
            acc[centerIdx][1] -= ky * dy * wt;
            acc[centerIdx][2] -= kz * dz * wt;
        }
    }

    return acc;
}

/**
 * Central-body J2 potential energy summed over all satellites (J).
 * Includes only the oblateness term — pairwise PE comes from totalEnergy().
 *
 *   PE_J2 = + mu_central * m_sat * J2 * R_eq^2 * (3 z^2 / r^2 - 1) / (2 r^3)
 *
 * Sign convention check: with acc = -grad(PE/m), the J2 acceleration here
 *   acc_x = -(3/2) mu J2 R^2 x (1 - 5 z^2/r^2) / r^5
 * is the negative gradient of  U(r) = +mu J2 R^2 (3z^2 - r^2) / (2 r^5)
 * which equals  +mu J2 R^2 (3 z^2/r^2 - 1) / (2 r^3).
 *
 * The integrator's J2 acceleration is the gradient of this potential, so
 * including this term in the diagnostic confirms the integrator preserves
 * the full Hamiltonian — not just the two-body part.
 */
export function totalJ2PotentialEnergy(bodies, j2Opts) {
    if (!j2Opts) return 0;
    const { centerIdx, J2, R_eq, mu } = j2Opts;
    const c = bodies[centerIdx];
    let PE = 0;
    for (let i = 0; i < bodies.length; i++) {
        if (i === centerIdx) continue;
        const dx = bodies[i].r[0] - c.r[0];
        const dy = bodies[i].r[1] - c.r[1];
        const dz = bodies[i].r[2] - c.r[2];
        const r2 = dx*dx + dy*dy + dz*dz;
        const r3 = r2 * Math.sqrt(r2);
        const zr2 = (dz * dz) / r2;
        PE += mu * bodies[i].m * J2 * R_eq * R_eq * (3 * zr2 - 1) / (2 * r3);
    }
    return PE;
}

/** Total kinetic + potential energy (J). For long-run integrator diagnostics. */
export function totalEnergy(bodies) {
    let KE = 0;
    for (const b of bodies) {
        const v2 = b.v[0]*b.v[0] + b.v[1]*b.v[1] + b.v[2]*b.v[2];
        KE += 0.5 * b.m * v2;
    }
    let PE = 0;
    const N = bodies.length;
    for (let i = 0; i < N; i++) {
        for (let j = i + 1; j < N; j++) {
            const dx = bodies[j].r[0] - bodies[i].r[0];
            const dy = bodies[j].r[1] - bodies[i].r[1];
            const dz = bodies[j].r[2] - bodies[i].r[2];
            const r  = Math.sqrt(dx*dx + dy*dy + dz*dz);
            PE -= G_SI * bodies[i].m * bodies[j].m / r;
        }
    }
    return { KE, PE, total: KE + PE };
}

/** Total angular momentum vector (kg·m²/s). */
export function totalAngularMomentum(bodies) {
    const L = [0, 0, 0];
    for (const b of bodies) {
        L[0] += b.m * (b.r[1] * b.v[2] - b.r[2] * b.v[1]);
        L[1] += b.m * (b.r[2] * b.v[0] - b.r[0] * b.v[2]);
        L[2] += b.m * (b.r[0] * b.v[1] - b.r[1] * b.v[0]);
    }
    return L;
}

/** Mass-weighted barycenter (position and velocity). */
export function barycenter(bodies) {
    let M = 0;
    const r = [0, 0, 0], v = [0, 0, 0];
    for (const b of bodies) {
        M += b.m;
        r[0] += b.m * b.r[0]; r[1] += b.m * b.r[1]; r[2] += b.m * b.r[2];
        v[0] += b.m * b.v[0]; v[1] += b.m * b.v[1]; v[2] += b.m * b.v[2];
    }
    return {
        m: M,
        r: [r[0] / M, r[1] / M, r[2] / M],
        v: [v[0] / M, v[1] / M, v[2] / M],
    };
}

/** Translate bodies into the barycentric frame (zero net momentum). */
export function shiftToBarycenter(bodies) {
    const bc = barycenter(bodies);
    for (const b of bodies) {
        b.r[0] -= bc.r[0]; b.r[1] -= bc.r[1]; b.r[2] -= bc.r[2];
        b.v[0] -= bc.v[0]; b.v[1] -= bc.v[1]; b.v[2] -= bc.v[2];
    }
    return bodies;
}

/**
 * Classical orbital elements -> inertial state vector.
 * Reference frame of the result equals the frame in which (i, raan) are
 * expressed.
 *
 * @param {object} el  { a, e, i_deg, raan_deg, argp_deg, M_deg, mu }
 *                     a in m, mu = G(M_central + m_body) in m^3/s^2.
 * @returns {{r: number[], v: number[]}}
 */
export function elementsToState(el) {
    const { a, e, mu } = el;
    const i    = el.i_deg    * D2R;
    const raan = el.raan_deg * D2R;
    const argp = el.argp_deg * D2R;
    const M    = ((el.M_deg % 360 + 360) % 360) * D2R;

    // Solve Kepler (Newton-Raphson with seeded guess for high e).
    let E = e < 0.8 ? M : Math.PI;
    for (let it = 0; it < 80; it++) {
        const f  = E - e * Math.sin(E) - M;
        const fp = 1 - e * Math.cos(E);
        const dE = f / fp;
        E -= dE;
        if (Math.abs(dE) < 1e-13) break;
    }

    const cosE = Math.cos(E), sinE = Math.sin(E);
    const sqrt1me2 = Math.sqrt(1 - e * e);

    // Perifocal (orbital plane) state.
    const x_p = a * (cosE - e);
    const y_p = a * sqrt1me2 * sinE;
    const r_orb = a * (1 - e * cosE);
    const factor = Math.sqrt(mu * a) / r_orb;
    const vx_p = -factor * sinE;
    const vy_p =  factor * sqrt1me2 * cosE;

    // Rotation R3(-raan) R1(-i) R3(-argp).
    const cR = Math.cos(raan), sR = Math.sin(raan);
    const ci = Math.cos(i),    si = Math.sin(i);
    const cw = Math.cos(argp), sw = Math.sin(argp);

    const R11 =  cR * cw - sR * sw * ci;
    const R12 = -cR * sw - sR * cw * ci;
    const R21 =  sR * cw + cR * sw * ci;
    const R22 = -sR * sw + cR * cw * ci;
    const R31 =  sw * si;
    const R32 =  cw * si;

    return {
        r: [
            R11 * x_p + R12 * y_p,
            R21 * x_p + R22 * y_p,
            R31 * x_p + R32 * y_p,
        ],
        v: [
            R11 * vx_p + R12 * vy_p,
            R21 * vx_p + R22 * vy_p,
            R31 * vx_p + R32 * vy_p,
        ],
    };
}

/**
 * Inertial state vector -> classical orbital elements (osculating).
 * Robust to circular and equatorial orbits via standard fall-throughs.
 *
 * @param {number[]} r   Position in m, relative to the primary.
 * @param {number[]} v   Velocity in m/s, relative to the primary.
 * @param {number} mu    Standard gravitational parameter G(M_p + m_b) (m^3/s^2).
 */
export function stateToElements(r, v, mu) {
    const [x, y, z]    = r;
    const [vx, vy, vz] = v;
    const r_mag = Math.sqrt(x*x + y*y + z*z);
    const v2 = vx*vx + vy*vy + vz*vz;

    const energy = 0.5 * v2 - mu / r_mag;
    const a = -mu / (2 * energy);

    const hx = y * vz - z * vy;
    const hy = z * vx - x * vz;
    const hz = x * vy - y * vx;
    const h  = Math.sqrt(hx*hx + hy*hy + hz*hz);

    const inc = Math.acos(Math.max(-1, Math.min(1, hz / h)));

    // Node line: z_hat × h_hat.
    const nx = -hy;
    const ny =  hx;
    const n  = Math.sqrt(nx*nx + ny*ny);

    let raan = 0;
    if (n > 1e-12) {
        raan = Math.acos(Math.max(-1, Math.min(1, nx / n)));
        if (ny < 0) raan = 2 * Math.PI - raan;
    }

    // Eccentricity vector.
    const v_dot_r = x * vx + y * vy + z * vz;
    const k = (v2 - mu / r_mag) / mu;
    const ex = k * x - (v_dot_r / mu) * vx;
    const ey = k * y - (v_dot_r / mu) * vy;
    const ez = k * z - (v_dot_r / mu) * vz;
    const e  = Math.sqrt(ex*ex + ey*ey + ez*ez);

    let argp = 0;
    if (n > 1e-12 && e > 1e-12) {
        argp = Math.acos(Math.max(-1, Math.min(1, (nx * ex + ny * ey) / (n * e))));
        if (ez < 0) argp = 2 * Math.PI - argp;
    }

    let nu;
    if (e > 1e-12) {
        nu = Math.acos(Math.max(-1, Math.min(1, (ex * x + ey * y + ez * z) / (e * r_mag))));
        if (v_dot_r < 0) nu = 2 * Math.PI - nu;
    } else if (n > 1e-12) {
        nu = Math.acos(Math.max(-1, Math.min(1, (nx * x + ny * y) / (n * r_mag))));
        if (z < 0) nu = 2 * Math.PI - nu;
    } else {
        nu = Math.atan2(y, x);
        if (nu < 0) nu += 2 * Math.PI;
    }

    const E_anom = 2 * Math.atan2(
        Math.sqrt(1 - e) * Math.sin(nu / 2),
        Math.sqrt(1 + e) * Math.cos(nu / 2),
    );
    const M = E_anom - e * Math.sin(E_anom);

    const period = 2 * Math.PI * Math.sqrt(a * a * a / mu);
    const true_lon = (raan + argp + nu) % (2 * Math.PI);
    const mean_lon = (raan + argp + M)  % (2 * Math.PI);

    const wrap = x => ((x * R2D) % 360 + 360) % 360;
    return {
        a, e,
        i_deg:        inc  * R2D,
        raan_deg:     raan * R2D,
        argp_deg:     argp * R2D,
        nu_deg:       nu   * R2D,
        M_deg:        wrap(M),
        true_lon_deg: wrap(true_lon),
        mean_lon_deg: wrap(mean_lon),
        period_s:     period,
        r_mag, v_mag: Math.sqrt(v2),
    };
}
