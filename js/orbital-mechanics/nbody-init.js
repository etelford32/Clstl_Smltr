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
 * Planet heliocentric positions come from the existing horizons.js helpers
 * (VSOP87D for Earth + outer planets, Meeus 3-term Kepler for the inner
 * three).  Velocities are obtained by central finite difference at ±0.5 d.
 *
 * Asteroid initial states are generated from MPC J2000-osculating
 * elements via two-body Kepler propagation in elementsToState().
 *
 * Final step: shift the entire system into the barycentric frame so that
 * Yoshida-4 sees an inertial Cartesian frame with conserved linear
 * momentum.
 */

import {
    mercuryHeliocentric, venusHeliocentric, earthHeliocentric, marsHeliocentric,
    jupiterHeliocentric, saturnHeliocentric, uranusHeliocentric, neptuneHeliocentric,
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

// ── Planet heliocentric position helpers ─────────────────────────────
const PLANET_FN = {
    mercury: mercuryHeliocentric, venus:   venusHeliocentric,
    earth:   earthHeliocentric,   mars:    marsHeliocentric,
    jupiter: jupiterHeliocentric, saturn:  saturnHeliocentric,
    uranus:  uranusHeliocentric,  neptune: neptuneHeliocentric,
};

function planetHelio(key, jd) {
    const p = PLANET_FN[key](jd);
    return { x: p.x_AU, y: p.y_AU, z: p.z_AU };
}

function planetVelHelio(key, jd, h = 0.5) {
    const a = planetHelio(key, jd + h);
    const b = planetHelio(key, jd - h);
    return {
        vx: (a.x - b.x) / (2 * h),
        vy: (a.y - b.y) / (2 * h),
        vz: (a.z - b.z) / (2 * h),
    };
}

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
 *   2. For each planet, sample heliocentric position from VSOP87D / Meeus
 *      and velocity by central finite difference.
 *   3. For each asteroid, propagate its Keplerian elements from epoch
 *      to `jd0` via solveKepler() and evaluate position + velocity.
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

    // Planets
    for (let i = 1; i <= 8; i++) {
        const key = BODY_KEYS[i];
        const ratio = MASS_RATIO[key];
        gm[i] = GM_SUN * ratio;
        const p  = planetHelio(key, jd0);
        const vv = planetVelHelio(key, jd0);
        r[i*3]   = p.x;  r[i*3+1] = p.y;  r[i*3+2] = p.z;
        v[i*3]   = vv.vx; v[i*3+1] = vv.vy; v[i*3+2] = vv.vz;
    }

    // Asteroids
    for (let i = 9; i < N; i++) {
        const key   = BODY_KEYS[i];
        const ratio = MASS_RATIO[key];
        gm[i] = GM_SUN * ratio;
        const el  = ASTEROID_EL[key];
        const mu  = GM_SUN + gm[i];
        const st  = elementsToState({ ...el, mu_eff: mu }, jd0);
        r[i*3] = st.rx; r[i*3+1] = st.ry; r[i*3+2] = st.rz;
        v[i*3] = st.vx; v[i*3+1] = st.vy; v[i*3+2] = st.vz;
    }

    // ── Shift to barycentric frame ────────────────────────────────────
    // R_bary = Σ (m_i r_i) / Σ m_i  ; subtract from every position/velocity.
    // Using gm as the mass proxy (cancels common G factor).
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
