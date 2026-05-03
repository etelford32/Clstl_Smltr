/**
 * nbody-init.js — Build N-body initial conditions at any JD.
 *
 * The 13-body system used by the time-machine validation tier:
 *
 *   index  body         GM (AU³/day²)         source
 *   0      Sun          GM_SUN
 *   1      Mercury      GM_SUN / 6023600
 *   2      Venus        GM_SUN / 408523.71
 *   3      Earth+Moon   GM_SUN / 328900.55
 *   4      Mars         GM_SUN / 3098703.59
 *   5      Jupiter      GM_SUN / 1047.348644
 *   6      Saturn       GM_SUN / 3497.9018
 *   7      Uranus       GM_SUN / 22902.98
 *   8      Neptune      GM_SUN / 19412.26
 *   9      Ceres        GM_SUN · 4.7e-10
 *   10     Vesta        GM_SUN · 1.3e-10
 *   11     Pallas       GM_SUN · 1.03e-10
 *   12     Hygiea       GM_SUN · 4.2e-11
 *
 * Mass ratios are IAU 2015 / DE440 nominal values.
 *
 * Seeding strategy
 * ────────────────
 * Planets are seeded from the Standish (1992) MEAN Keplerian elements at
 * the requested epoch via two-body Kepler propagation.  This gives
 * initial osculating elements that exactly equal the linear-secular
 * reference at t=0, so the residual table starts at zero and the N-body
 * trajectory shows the higher-order perturbative drift on top of the
 * secular trend.  At J2000 the Standish-Kepler position matches VSOP87D
 * to <1 mAU for the inner planets and to the mean-vs-osculating offset
 * (≲ 0.3 AU) for Jupiter–Neptune.
 *
 * Asteroids are seeded from JPL Small-Body DB osculating elements at
 * their published epoch, then Kepler-propagated to the simulation
 * epoch.  They contribute mostly as gravitational perturbers.
 *
 * Final step: shift the entire system into the barycentric frame so
 * Yoshida-4 sees an inertial Cartesian frame with conserved net momentum.
 */

import {
    PLANET_ELEMENTS, planetElementsAt,
} from '../horizons.js';
import { GM_SUN, elementsToState } from './yoshida4.js';

// ── Mass ratios (m_body / M_sun) ─────────────────────────────────────
// Planets: IAU 2015 nominal.  Earth includes the Moon (Earth+Moon barycenter).
const MASS_RATIO = {
    mercury: 1 / 6023600,
    venus:   1 / 408523.71,
    earth:   1 / 328900.55,    // Earth + Moon
    mars:    1 / 3098703.59,
    jupiter: 1 / 1047.348644,
    saturn:  1 / 3497.9018,
    uranus:  1 / 22902.98,
    neptune: 1 / 19412.26,
    // Major asteroids (Park et al. 2019, JPL Small-Body DB)
    ceres:   4.70e-10,
    vesta:   1.30e-10,
    pallas:  1.03e-10,
    hygiea:  4.20e-11,
};

// Body index assignments — must match BODY_KEYS export.
export const BODY_KEYS = [
    'sun',
    'mercury', 'venus', 'earth', 'mars',
    'jupiter', 'saturn', 'uranus', 'neptune',
    'ceres', 'vesta', 'pallas', 'hygiea',
];
export const N_BODIES = BODY_KEYS.length;
export const EARTH_INDEX = BODY_KEYS.indexOf('earth');
export const SUN_INDEX   = 0;

// ── Asteroid Keplerian elements at MPC epoch JD 2459600.5 (2022-01-21) ─
// Source: JPL SBDB osculating elements.  argp is ω (NOT ω̄ = Ω + ω).
const ASTEROID_EL = {
    ceres:  { a:2.7691651, e:0.0789126, i:10.587740, node:80.305531,
              argp:73.621287, M0:291.428878, epochJd:2459600.5 },
    vesta:  { a:2.3614032, e:0.0894077, i: 7.142175, node:103.810804,
              argp:151.667130, M0:155.928860, epochJd:2459600.5 },
    pallas: { a:2.7723622, e:0.2299822, i:34.836204, node:172.910134,
              argp:310.452527, M0:103.527380, epochJd:2459600.5 },
    hygiea: { a:3.1421604, e:0.1126632, i: 3.831651, node:283.190961,
              argp:312.291637, M0:160.636497, epochJd:2459600.5 },
};

/**
 * Build a fully-initialised barycentric N-body state at the given JD.
 *
 * Steps:
 *   1. Place the Sun at heliocentric origin with zero velocity.
 *   2. For each planet, evaluate the Standish secular elements at jd0
 *      and convert to a heliocentric state vector via two-body Kepler.
 *   3. For each asteroid, propagate its Keplerian elements from the
 *      MPC epoch to jd0 via solveKepler() and evaluate position+velocity.
 *   4. Shift the whole system so the centre of mass is at the origin
 *      with zero net momentum.
 *
 * @param {number} jd0  Epoch (Julian Day) at which to seed the system.
 * @returns {{ r:Float64Array, v:Float64Array, gm:Float64Array, jd:number,
 *             names:string[] }}
 */
export function buildInitialState(jd0) {
    const N  = N_BODIES;
    const r  = new Float64Array(N * 3);
    const v  = new Float64Array(N * 3);
    const gm = new Float64Array(N);

    // Sun
    gm[SUN_INDEX] = GM_SUN;

    // Planets — seed from Standish secular elements at jd0
    for (let i = 1; i <= 8; i++) {
        const key   = BODY_KEYS[i];
        const ratio = MASS_RATIO[key];
        gm[i]       = GM_SUN * ratio;
        const std   = planetElementsAt(key, jd0);
        const mu    = GM_SUN + gm[i];
        const argp  = std.omegaBar - std.node;
        const st    = elementsToState({
            a: std.a, e: std.e, i: std.i, node: std.node,
            argp, M0: std.M, epochJd: jd0, mu_eff: mu,
        }, jd0);
        r[i*3] = st.rx; r[i*3+1] = st.ry; r[i*3+2] = st.rz;
        v[i*3] = st.vx; v[i*3+1] = st.vy; v[i*3+2] = st.vz;
    }

    // Asteroids — propagate published osculating elements from MPC epoch
    for (let i = 9; i < N; i++) {
        const key   = BODY_KEYS[i];
        const ratio = MASS_RATIO[key];
        gm[i]       = GM_SUN * ratio;
        const el    = ASTEROID_EL[key];
        const mu    = GM_SUN + gm[i];
        const st    = elementsToState({ ...el, mu_eff: mu }, jd0);
        r[i*3] = st.rx; r[i*3+1] = st.ry; r[i*3+2] = st.rz;
        v[i*3] = st.vx; v[i*3+1] = st.vy; v[i*3+2] = st.vz;
    }

    // ── Shift to barycentric frame ────────────────────────────────────
    let M = 0, Rx = 0, Ry = 0, Rz = 0, Vx = 0, Vy = 0, Vz = 0;
    for (let i = 0; i < N; i++) {
        M  += gm[i];
        Rx += gm[i] * r[i*3];
        Ry += gm[i] * r[i*3+1];
        Rz += gm[i] * r[i*3+2];
        Vx += gm[i] * v[i*3];
        Vy += gm[i] * v[i*3+1];
        Vz += gm[i] * v[i*3+2];
    }
    Rx /= M; Ry /= M; Rz /= M;
    Vx /= M; Vy /= M; Vz /= M;
    for (let i = 0; i < N; i++) {
        r[i*3]   -= Rx; r[i*3+1] -= Ry; r[i*3+2] -= Rz;
        v[i*3]   -= Vx; v[i*3+1] -= Vy; v[i*3+2] -= Vz;
    }

    return { r, v, gm, jd: jd0, names: BODY_KEYS.slice() };
}

/**
 * Convenience: extract the heliocentric position of body `idx` from a
 * barycentric state, by subtracting the Sun's position.
 */
export function bodyHelio(state, idx) {
    const r = state.r;
    return {
        x: r[idx*3]   - r[SUN_INDEX*3],
        y: r[idx*3+1] - r[SUN_INDEX*3+1],
        z: r[idx*3+2] - r[SUN_INDEX*3+2],
    };
}

/**
 * Convenience: extract the heliocentric velocity of body `idx` from a
 * barycentric state.
 */
export function bodyHelioVel(state, idx) {
    const v = state.v;
    return {
        vx: v[idx*3]   - v[SUN_INDEX*3],
        vy: v[idx*3+1] - v[SUN_INDEX*3+1],
        vz: v[idx*3+2] - v[SUN_INDEX*3+2],
    };
}

