/**
 * jovian-system.js — live Yoshida-4 N-body integration of the Jovian system
 *
 * Integrates Jupiter + the four Galilean moons (Io, Europa, Ganymede, Callisto)
 * in the Jovian barycentric, ecliptic-of-J2000 frame using a 4th-order
 * symplectic composition (Yoshida 1990).  The Laplace 1:2:4 mean-motion
 * resonance and Io's forced eccentricity emerge naturally from pairwise
 * Newtonian gravity — no special-case forcing.
 *
 * Why this matters for the orrery
 *   The previous solar-system view modelled the Galilean moons with mean
 *   Keplerian orbits.  Mean elements produce a static 1:2:4 ratio that drifts
 *   relative to JPL Horizons by ~0.5°/yr for Io.  The N-body path here keeps
 *   the resonance live and lets the user see the ~73-Earth-day Laplace
 *   libration with their own eyes.
 *
 * Numerical scheme
 *   Yoshida-4 7-stage drift-kick-drift composition.  Energy and angular
 *   momentum are bounded for any stable step size, so the integration is safe
 *   for arbitrarily long sim runs.  We adapt dt to the simulation speed:
 *   dt ∈ [60 s, 600 s] is plenty for Io's 1.769 d period.
 *
 * Public API
 *   const jov = new JovianSystem();
 *   jov.advanceTo(jd);                     // integrate forward/backward to that JD
 *   jov.getRelPosKm('io')  → {x,y,z}       // moon - Jupiter, ecliptic-of-J2000 km
 *   jov.getJupiterShiftKm() → {x,y,z}      // Jupiter - barycentre, km (tiny)
 *   jov.laplaceArgumentDeg()               // φ_L = λ_Io − 3λ_E + 2λ_G in degrees
 *
 * References
 *   Yoshida, H. (1990) "Construction of higher order symplectic integrators."
 *   Murray & Dermott (1999) "Solar System Dynamics" ch. 8 (resonances).
 *   JPL planet/satellite fact sheets (initial mean elements at J2000).
 */

import { yoshida4Step, elementsToState, stateToElements, G_SI }
    from './gravity-lab/physics.js';

const KM = 1000;
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const J2000_JD = 2451545.0;

// Body table — bodies[0] = Jupiter, then the four Galileans
const JOVIAN_BODIES = [
    { key: 'jupiter',  name: 'Jupiter',  mass: 1.89813e27 },
    { key: 'io',       name: 'Io',       mass: 8.9319e22 },
    { key: 'europa',   name: 'Europa',   mass: 4.7998e22 },
    { key: 'ganymede', name: 'Ganymede', mass: 1.4819e23 },
    { key: 'callisto', name: 'Callisto', mass: 1.0759e23 },
];
const KEYS  = JOVIAN_BODIES.map(b => b.key);
const idxOf = Object.fromEntries(KEYS.map((k, i) => [k, i]));

// J2000 mean Keplerian elements (jovicentric, ecliptic-of-J2000).
// Source: JPL planet-satellite fact sheets, mean values.
const INIT_EL = {
    io:       { a_km:  421_800, e: 0.0041, i_deg: 0.040, raan_deg:  43.977, argp_deg:  84.129, M_deg:  22.0 },
    europa:   { a_km:  671_100, e: 0.0094, i_deg: 0.470, raan_deg: 219.106, argp_deg:  88.970, M_deg: 308.0 },
    ganymede: { a_km:1_070_400, e: 0.0013, i_deg: 0.180, raan_deg:  63.552, argp_deg: 192.417, M_deg: 179.0 },
    callisto: { a_km:1_882_700, e: 0.0074, i_deg: 0.190, raan_deg: 298.848, argp_deg:  52.643, M_deg: 345.0 },
};

function _buildInitialBodies() {
    const bodies = JOVIAN_BODIES.map(b => ({
        m: b.mass, r: [0, 0, 0], v: [0, 0, 0], _key: b.key,
    }));
    const M_jup = bodies[0].m;
    for (const k of ['io', 'europa', 'ganymede', 'callisto']) {
        const el = INIT_EL[k];
        const i  = idxOf[k];
        const m  = bodies[i].m;
        const mu = G_SI * (M_jup + m);
        const st = elementsToState({
            a:    el.a_km * KM,
            e:    el.e,
            i_deg:    el.i_deg,
            raan_deg: el.raan_deg,
            argp_deg: el.argp_deg,
            M_deg:    el.M_deg,
            mu,
        });
        bodies[i].r = st.r;
        bodies[i].v = st.v;
    }
    // Cancel net momentum — Jupiter velocity in barycentric frame.
    let px = 0, py = 0, pz = 0;
    for (let i = 1; i < bodies.length; i++) {
        px += bodies[i].m * bodies[i].v[0];
        py += bodies[i].m * bodies[i].v[1];
        pz += bodies[i].m * bodies[i].v[2];
    }
    bodies[0].v[0] = -px / bodies[0].m;
    bodies[0].v[1] = -py / bodies[0].m;
    bodies[0].v[2] = -pz / bodies[0].m;
    return bodies;
}

function _reseedAtSimT(bodies, dt_s_since_J2000) {
    const M_jup = bodies[0].m;
    for (const k of ['io', 'europa', 'ganymede', 'callisto']) {
        const i  = idxOf[k];
        const m  = bodies[i].m;
        const mu = G_SI * (M_jup + m);
        const el = INIT_EL[k];
        const a_m = el.a_km * KM;
        const n_rad_s = Math.sqrt(mu / (a_m * a_m * a_m));
        const M_now = el.M_deg + n_rad_s * dt_s_since_J2000 * R2D;
        const st = elementsToState({
            a: a_m, e: el.e,
            i_deg: el.i_deg, raan_deg: el.raan_deg, argp_deg: el.argp_deg,
            M_deg: M_now, mu,
        });
        bodies[i].r = st.r;
        bodies[i].v = st.v;
    }
    // Cancel momentum
    let px = 0, py = 0, pz = 0;
    for (let i = 1; i < bodies.length; i++) {
        px += bodies[i].m * bodies[i].v[0];
        py += bodies[i].m * bodies[i].v[1];
        pz += bodies[i].m * bodies[i].v[2];
    }
    bodies[0].v[0] = -px / bodies[0].m;
    bodies[0].v[1] = -py / bodies[0].m;
    bodies[0].v[2] = -pz / bodies[0].m;
}

// ── JovianSystem ─────────────────────────────────────────────────────────────
//
// Lazy: integrates only when advanceTo is called.  If the requested JD is
// further away than RESEED_THRESHOLD_S (≈ 2 yr), we reseed analytically rather
// than burn through millions of integrator steps.

const RESEED_THRESHOLD_S = 730 * 86400;     // 2 yr
const MAX_DT             = 600;             // s
const MIN_DT             = 60;              // s
const MAX_STEPS_PER_CALL = 20000;

export class JovianSystem {
    constructor(initialJD = null) {
        this.bodies = _buildInitialBodies();
        this.t_s   = 0;                                       // seconds since J2000
        if (initialJD != null) {
            const dt_s = (initialJD - J2000_JD) * 86400;
            _reseedAtSimT(this.bodies, dt_s);
            this.t_s = dt_s;
        }
    }

    /** Advance the integrator to the requested JD.  Reseeds analytically for big jumps. */
    advanceTo(jd) {
        const target_t_s = (jd - J2000_JD) * 86400;
        const dt_s_total = target_t_s - this.t_s;
        if (Math.abs(dt_s_total) < 1) return;

        if (Math.abs(dt_s_total) > RESEED_THRESHOLD_S) {
            _reseedAtSimT(this.bodies, target_t_s);
            this.t_s = target_t_s;
            return;
        }

        // Otherwise integrate, capping at a finite step count per call so the
        // animation loop never stalls if simSpeed is huge.
        const sign  = Math.sign(dt_s_total);
        const absT  = Math.abs(dt_s_total);
        const dtMag = Math.min(MAX_DT, Math.max(MIN_DT, absT / 100));
        const steps = Math.min(MAX_STEPS_PER_CALL, Math.ceil(absT / dtMag));
        const dt    = sign * (absT / steps);
        for (let i = 0; i < steps; i++) {
            yoshida4Step(this.bodies, dt);
        }
        this.t_s += dt * steps;

        // If we hit the safety cap on a long jump, fall back to a reseed.
        const residual = target_t_s - this.t_s;
        if (Math.abs(residual) > 86400) {
            _reseedAtSimT(this.bodies, target_t_s);
            this.t_s = target_t_s;
        }
    }

    /** Position of moon relative to Jupiter, in km, ecliptic-of-J2000 frame. */
    getRelPosKm(moonKey) {
        const i = idxOf[moonKey];
        if (i == null || i === 0) return { x: 0, y: 0, z: 0 };
        const b = this.bodies[i], j = this.bodies[0];
        return {
            x: (b.r[0] - j.r[0]) / KM,
            y: (b.r[1] - j.r[1]) / KM,
            z: (b.r[2] - j.r[2]) / KM,
        };
    }

    /** Jupiter offset from the system barycentre (km).  Tiny — for completeness. */
    getJupiterShiftKm() {
        const j = this.bodies[0];
        return { x: j.r[0] / KM, y: j.r[1] / KM, z: j.r[2] / KM };
    }

    /** Mean longitude of a Galilean moon in degrees (approximate, from r). */
    meanLongitudeDeg(moonKey) {
        const i = idxOf[moonKey];
        if (i == null || i === 0) return 0;
        const dx = this.bodies[i].r[0] - this.bodies[0].r[0];
        const dy = this.bodies[i].r[1] - this.bodies[0].r[1];
        return ((Math.atan2(dy, dx) * R2D) % 360 + 360) % 360;
    }

    /**
     * Laplace resonance argument: φ_L = λ_Io − 3λ_Europa + 2λ_Ganymede.
     * Librates around 180° at ~0.74° amplitude — the smoking gun of the
     * 1:2:4 resonance.  Returns degrees in (-180, +180].
     */
    laplaceArgumentDeg() {
        const phi = this.meanLongitudeDeg('io')
                  - 3 * this.meanLongitudeDeg('europa')
                  + 2 * this.meanLongitudeDeg('ganymede');
        let p = phi % 360;
        if (p > 180)  p -= 360;
        if (p < -180) p += 360;
        return p;
    }
}

// Re-export keys & init data for callers that want them (e.g. UI labels).
export { JOVIAN_BODIES, INIT_EL };
