/**
 * mission-planner-trajectory.js — Patched-conic trajectory math for the
 * Mission Planner page. All numbers are real km / km·s⁻¹ / Julian Days.
 *
 * Coverage:
 *   • Earth two-body: parking orbits, Hohmann transfers
 *   • Lunar transfer: geocentric Hohmann + lunar SOI patch + LOI capture
 *     burn into a circular lunar orbit. Phasing uses live ephemeris.
 *   • Mars transfer (Hohmann): closed-form, fast, used for initial
 *     guesses and quick reference numbers.
 *   • Mars transfer (Lambert): full 3D Izzo solver via planMarsLambert(),
 *     arbitrary (jd_depart, jd_arrive). Drives the live pork-chop scan.
 *   • Plane-change Δv: combined-burn formula at the line of nodes,
 *     using the v∞ declination relative to the parking orbit plane.
 *
 * Approximations (good for a *visual* planner, not a flight planner):
 *   • Co-planar Hohmann path used only for reference numbers.
 *   • Lunar transfer still uses tangential Hohmann (textbook accuracy).
 *   • Plane change modeled as a single combined burn at the periapsis of
 *     the departure hyperbola; real missions optimise this differently.
 */

import {
    jdNow, moonGeocentric, earthHeliocentric, marsHeliocentric,
    mercuryHeliocentric, venusHeliocentric,
    jupiterHeliocentric, saturnHeliocentric,
    uranusHeliocentric,  neptuneHeliocentric,
} from './horizons.js';
import {
    lambert, lambertAll,
    vSub, vNorm, vScale, vCross, vDot, sampleKeplerArc,
} from './mission-planner-lambert.js';

// ── Physical constants ───────────────────────────────────────────────────────
export const KM_PER_AU       = 149597870.7;
export const SECONDS_PER_DAY = 86400;
export const D2R = Math.PI / 180;
export const R2D = 180 / Math.PI;

// Gravitational parameters (km³/s²)
export const MU_EARTH    = 398600.4418;
export const MU_SUN      = 1.32712440018e11;
export const MU_MOON     = 4902.800066;
export const MU_MARS     = 42828.37;
export const MU_JUPITER  = 1.26686534e8;
export const MU_SATURN   = 3.7931187e7;
export const MU_URANUS   = 5.793939e6;
export const MU_NEPTUNE  = 6.836529e6;

// Body radii (km)
export const R_EARTH   = 6378.137;
export const R_MOON    = 1737.4;
export const R_MARS    = 3389.5;
export const R_JUPITER = 69911;
export const R_SATURN  = 58232;
export const R_URANUS  = 25362;
export const R_NEPTUNE = 24622;

// Sphere-of-influence radii (km), classic Tisserand definition.
export const SOI_EARTH    =    924000;
export const SOI_MOON     =     66100;
export const SOI_MARS     =    577000;
export const SOI_JUPITER  =  48200000;
export const SOI_SATURN   =  54400000;
export const SOI_URANUS   =  51700000;
export const SOI_NEPTUNE  =  86700000;

// Mean orbital radii (km)
export const R_EARTH_HELIO = 1.00000011 * KM_PER_AU;   // mean Earth orbit
export const R_MARS_HELIO  = 1.523679   * KM_PER_AU;   // mean Mars orbit
export const T_MARS_DAYS   = 686.971;                  // sidereal Mars year

// ── Kepler primitives ───────────────────────────────────────────────────────

/** Solve M = E − e·sin E for E (Newton-Raphson, ≤ 8 iterations).  */
export function solveKepler(M, e, tol = 1e-10) {
    let E = (e < 0.8) ? M : Math.PI;
    for (let i = 0; i < 12; i++) {
        const f  = E - e * Math.sin(E) - M;
        const fp = 1 - e * Math.cos(E);
        const dE = f / fp;
        E -= dE;
        if (Math.abs(dE) < tol) break;
    }
    return E;
}

/** Convert eccentric anomaly E to true anomaly ν (radians). */
export function trueFromEccentric(E, e) {
    return 2 * Math.atan2(
        Math.sqrt(1 + e) * Math.sin(E / 2),
        Math.sqrt(1 - e) * Math.cos(E / 2),
    );
}

/** Circular-orbit speed (km/s) at radius r_km around body of given mu. */
export function vCirc(r_km, mu) { return Math.sqrt(mu / r_km); }

/** Vis-viva speed (km/s) at radius r on an elliptical orbit of semi-major axis a. */
export function vVisViva(r_km, a_km, mu) { return Math.sqrt(mu * (2/r_km - 1/a_km)); }

/** Hohmann transfer between two coplanar circular orbits. */
export function hohmann(r1_km, r2_km, mu) {
    const a    = (r1_km + r2_km) / 2;
    const e    = Math.abs(r2_km - r1_km) / (r1_km + r2_km);
    const v1   = vCirc(r1_km, mu);
    const v2   = vCirc(r2_km, mu);
    const vp   = vVisViva(r1_km, a, mu);             // periapsis speed of transfer
    const vap  = vVisViva(r2_km, a, mu);             // apoapsis speed of transfer
    const dv1  = vp  - v1;
    const dv2  = v2  - vap;
    const tof_s = Math.PI * Math.sqrt(a*a*a / mu);
    return { a, e, v1, v2, vp, vap, dv1, dv2, total: Math.abs(dv1) + Math.abs(dv2), tof_s };
}

// ── Lunar transfer (geocentric patched conic) ────────────────────────────────

/**
 * Plan a lunar transfer: launch from a circular parking orbit at
 * (R_EARTH + parking_alt_km), Hohmann out to current lunar distance,
 * patch into the Moon's SOI, and capture into a circular orbit at
 * (R_MOON + target_alt_moon_km).
 *
 * Phasing uses live `moonGeocentric()` so the plan is anchored to a real JD.
 */
export function planLunarTransfer({
    jd_depart           = jdNow(),
    parking_alt_km      = 300,
    target_alt_moon_km  = 100,
} = {}) {
    const jd       = jd_depart;
    const moon0    = moonGeocentric(jd);
    const r_park   = R_EARTH + parking_alt_km;
    const r_moon   = moon0.dist_km;
    const r_capt   = R_MOON  + target_alt_moon_km;

    const tx       = hohmann(r_park, r_moon, MU_EARTH);
    const tof_d    = tx.tof_s / SECONDS_PER_DAY;
    const moon1    = moonGeocentric(jd + tof_d);

    // Mean lunar angular speed (deg/day, sidereal).
    const moonOmega = 360 / 27.32166156;
    const lead_deg  = moonOmega * tof_d;

    // SOI patch: spacecraft arrives at lunar distance with apoapsis speed
    // v_ap (geocentric tangential). Moon orbits Earth at v_moon. The
    // hyperbolic excess relative to the Moon is (to first order) the
    // tangential difference plus a small radial term we ignore.
    const v_moon_helio = vCirc(r_moon, MU_EARTH);
    const v_inf_moon   = Math.abs(tx.vap - v_moon_helio);   // km/s

    // Capture burn at perilune of the inbound hyperbola → circular orbit.
    const v_perilune_hyp = Math.sqrt(v_inf_moon*v_inf_moon + 2*MU_MOON / r_capt);
    const v_circ_moon    = vCirc(r_capt, MU_MOON);
    const dv_loi         = v_perilune_hyp - v_circ_moon;

    return {
        kind: 'lunar',
        jd_depart: jd,
        jd_arrive: jd + tof_d,
        tof_s: tx.tof_s,
        tof_d,
        r_park_km:  r_park,
        r_moon_km:  r_moon,
        r_capt_km:  r_capt,
        moon_at_departure: moon0,
        moon_at_arrival:   moon1,
        ellipse: { rp_km: r_park, ra_km: r_moon, a_km: tx.a, e: tx.e },
        v_park_kms:        tx.v1,
        v_periapsis_xfer:  tx.vp,
        v_apoapsis_xfer:   tx.vap,
        v_moon_kms:        v_moon_helio,
        v_inf_moon_kms:    v_inf_moon,
        v_perilune_hyp_kms:v_perilune_hyp,
        v_circ_moon_kms:   v_circ_moon,
        dv_tli_kms:        tx.dv1,
        dv_loi_kms:        dv_loi,
        dv_total_kms:      tx.dv1 + dv_loi,
        lead_angle_deg:    lead_deg,
    };
}

// ── Mars transfer (heliocentric patched conic) ───────────────────────────────

/**
 * Plan a Mars transfer for a given Earth-departure JD. Uses live planet
 * ephemerides for both the heliocentric radii AND the phase-angle check.
 * The transfer is a coplanar Hohmann ellipse from r_earth → r_mars.
 *
 * Returns Δv_TMI from a 300-km circular parking orbit and Δv_MOI to
 * capture into a 400-km circular orbit at Mars (defaults — both knobs
 * exposed via parameters).
 */
export function planMarsTransfer({
    jd_depart           = jdNow(),
    parking_alt_km      = 300,
    target_alt_mars_km  = 400,
} = {}) {
    const jd      = jd_depart;
    const e0      = earthHeliocentric(jd);
    const m0      = marsHeliocentric(jd);

    const r1_km   = e0.dist_AU * KM_PER_AU;
    const r2_km   = R_MARS_HELIO;                  // use mean Mars radius for the ellipse

    const tx      = hohmann(r1_km, r2_km, MU_SUN);
    const tof_d   = tx.tof_s / SECONDS_PER_DAY;
    const m1      = marsHeliocentric(jd + tof_d);

    // Required Earth–Sun–Mars phase angle for a Hohmann arrival.
    const omega_mars = 360 / T_MARS_DAYS;          // deg/day
    const phi_req_deg  = 180 - omega_mars * tof_d;
    const phi_now_deg  = wrap360(m0.lon * 1 - e0.lon * 1);   // Mars − Earth lon (deg)
    const phi_err_deg  = wrap180(phi_now_deg - phi_req_deg);

    // C3 / v_inf at Earth departure (tangential approximation).
    const v_earth_helio = vCirc(r1_km, MU_SUN);
    const v_mars_helio  = vCirc(r2_km, MU_SUN);
    const v_inf_earth   = Math.abs(tx.vp  - v_earth_helio);
    const v_inf_mars    = Math.abs(v_mars_helio - tx.vap);
    const c3_earth      = v_inf_earth * v_inf_earth;

    // Earth-departure burn from circular parking orbit → Earth escape hyperbola.
    const r_park_e        = R_EARTH + parking_alt_km;
    const v_park_e        = vCirc(r_park_e, MU_EARTH);
    const v_park_e_hyp    = Math.sqrt(v_inf_earth*v_inf_earth + 2*MU_EARTH / r_park_e);
    const dv_tmi          = v_park_e_hyp - v_park_e;

    // Mars-arrival capture: perilune-equivalent at r_park_m around Mars.
    const r_park_m        = R_MARS + target_alt_mars_km;
    const v_circ_mars     = vCirc(r_park_m, MU_MARS);
    const v_park_m_hyp    = Math.sqrt(v_inf_mars*v_inf_mars + 2*MU_MARS / r_park_m);
    const dv_moi          = v_park_m_hyp - v_circ_mars;

    return {
        kind: 'mars',
        jd_depart: jd,
        jd_arrive: jd + tof_d,
        tof_s: tx.tof_s,
        tof_d,
        r1_km, r2_km,
        earth_at_departure: e0,
        mars_at_departure:  m0,
        mars_at_arrival:    m1,
        ellipse: {
            a_km:  tx.a,
            e:     tx.e,
            rp_km: Math.min(r1_km, r2_km),
            ra_km: Math.max(r1_km, r2_km),
        },
        phi_required_deg: phi_req_deg,
        phi_current_deg:  phi_now_deg,
        phi_error_deg:    phi_err_deg,
        v_inf_earth_kms:  v_inf_earth,
        v_inf_mars_kms:   v_inf_mars,
        c3_earth_km2s2:   c3_earth,
        v_park_earth_kms: v_park_e,
        v_park_mars_kms:  v_circ_mars,
        dv_tmi_kms:       dv_tmi,
        dv_moi_kms:       dv_moi,
        dv_total_kms:     dv_tmi + dv_moi,
    };
}

/**
 * Coarse pork-chop scan for the next Mars launch window. Iterates departure
 * dates from `jd_start` over `search_days`, evaluates the phase-angle
 * residual + total Δv, returns the best plan.
 *
 * Coarse step (default 2 d) is good enough for a visual demo; tighten if
 * you ever wire this into something operational.
 */
export function findMarsLaunchWindow({
    jd_start    = jdNow(),
    search_days = 900,
    step_days   = 2,
    parking_alt_km     = 300,
    target_alt_mars_km = 400,
} = {}) {
    let best = null;
    for (let dt = 0; dt <= search_days; dt += step_days) {
        const jd   = jd_start + dt;
        const plan = planMarsTransfer({ jd_depart: jd, parking_alt_km, target_alt_mars_km });
        // Cost: total Δv plus a soft penalty for phase-angle error.
        const score = plan.dv_total_kms + Math.abs(plan.phi_error_deg) * 0.02;
        if (!best || score < best.score) best = { score, plan };
    }
    return best.plan;
}

/**
 * Lunar launch-window finder. The Moon is always somewhere reachable, so
 * "window" here means the next time the apoapsis-direction at TLI puts the
 * spacecraft on a plane near the equator (low inclination cost). For now,
 * the result is just `jd_start` with the matching plan — this is a
 * placeholder for a fuller plane-of-arrival optimiser.
 */
export function findLunarLaunchWindow({
    jd_start            = jdNow(),
    parking_alt_km      = 300,
    target_alt_moon_km  = 100,
} = {}) {
    return planLunarTransfer({ jd_depart: jd_start, parking_alt_km, target_alt_moon_km });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function wrap360(x_deg) { return ((x_deg % 360) + 360) % 360; }
export function wrap180(x_deg) {
    let v = wrap360(x_deg);
    if (v > 180) v -= 360;
    return v;
}

/**
 * Sample a Kepler ellipse over true anomaly from ν_min to ν_max as a flat
 * Float32Array of (x, y) pairs in the orbital plane (focus at origin,
 * periapsis along +x). Distances are in whatever units rp/ra are given in.
 */
export function sampleEllipse({ a, e, nu_min = 0, nu_max = 2*Math.PI, n = 256 }) {
    const out = new Float32Array(n * 2);
    const p   = a * (1 - e*e);
    for (let i = 0; i < n; i++) {
        const nu = nu_min + (nu_max - nu_min) * (i / (n - 1));
        const r  = p / (1 + e * Math.cos(nu));
        out[i*2]   = r * Math.cos(nu);
        out[i*2+1] = r * Math.sin(nu);
    }
    return out;
}

/**
 * Position on a Kepler ellipse at fractional progress u∈[0,1] along the
 * Hohmann *half*-orbit (periapsis → apoapsis). Uses Kepler's equation so
 * the timing is correct (slow at apoapsis, fast at periapsis).
 *
 * Returns { x, y, nu } in the orbital plane (focus at origin, +x toward periapsis).
 */
export function hohmannPositionAt(u, a, e) {
    const M = u * Math.PI;            // half-orbit ⇒ M sweeps 0..π
    const E = solveKepler(M, e);
    const nu = trueFromEccentric(E, e);
    const r = a * (1 - e * Math.cos(E));
    return { x: r * Math.cos(nu), y: r * Math.sin(nu), nu, r };
}

// ── Heliocentric planet state vectors ───────────────────────────────────────
// horizons.js gives positions only. We get velocities via centered finite
// difference over a 1-day window — accurate to ~0.001 km/s for Earth/Mars.
const _DT_VEL_DAYS = 1.0;

function _planetPosKm(planetFn, jd) {
    const p = planetFn(jd);
    return [p.x_AU * KM_PER_AU, p.y_AU * KM_PER_AU, p.z_AU * KM_PER_AU];
}

export function planetState(planetFn, jd) {
    const dt   = _DT_VEL_DAYS;
    const pp   = planetFn(jd + dt);
    const pm   = planetFn(jd - dt);
    const inv  = KM_PER_AU / (2 * dt * SECONDS_PER_DAY);
    return {
        r: _planetPosKm(planetFn, jd),
        v: [(pp.x_AU - pm.x_AU) * inv,
            (pp.y_AU - pm.y_AU) * inv,
            (pp.z_AU - pm.z_AU) * inv],
    };
}

// ── Plane-change Δv at a parking orbit ──────────────────────────────────────
//
// Combined burn at the line of nodes between the parking orbit and the
// departure hyperbola: rotate by δ AND change magnitude in one impulse.
//
//   Δv = √(v_park² + v_hyp² − 2·v_park·v_hyp·cos δ)
//
// Where v_hyp is the hyperbolic departure speed at parking-orbit altitude
// (set by C3 = v∞²) and δ is the angle between parking-orbit plane and
// the inertial v∞ asymptote.
//
// δ is bounded below by |dec_v∞ − i_park| if dec_v∞ ≤ i_park, and by
// |dec_v∞| − i_park if i_park < |dec_v∞| (in which case an extra cosine-
// law penalty applies because the parking orbit can't even reach the
// asymptote declination without a plane change).

export function combinedBurnDV(v_park, v_hyp, delta_rad) {
    return Math.sqrt(v_park*v_park + v_hyp*v_hyp - 2*v_park*v_hyp*Math.cos(delta_rad));
}

/** Declination (radians) of a vector relative to the X-Y plane (= ecliptic). */
export function declination(v) {
    const m = vNorm(v);
    if (m < 1e-12) return 0;
    return Math.asin(v[2] / m);
}

/**
 * Required Δv to leave a circular parking orbit (radius r_park, inclination
 * i_park, around body of μ) onto a hyperbolic asymptote with v∞ vector
 * v_inf_vec. Models the burn as a single combined impulse at the line of
 * nodes; the geometric angle δ between planes is the maximum of (i_park
 * minus declination) and (declination minus i_park), absolute-valued.
 *
 * Returns: { dv_kms, v_park_kms, v_hyp_kms, dec_deg, plane_change_deg }.
 */
export function departureBurnFromParking({ r_park_km, mu, v_inf_vec, i_park_rad }) {
    const v_inf = vNorm(v_inf_vec);
    const v_park = vCirc(r_park_km, mu);
    const v_hyp  = Math.sqrt(v_inf*v_inf + 2*mu / r_park_km);
    const dec    = declination(v_inf_vec);
    // Plane change required: parking orbit can host any inclination ≥ |dec|.
    // If user picked i_park < |dec|, the missing tilt costs Δv; if user
    // picked i_park ≥ |dec|, a perfectly-timed launch matches the plane.
    const plane_change_rad = Math.max(0, Math.abs(dec) - i_park_rad)
                           + Math.max(0, i_park_rad - Math.abs(dec)) * 0; // tunable
    // The cleaner form for "min cost given i_park" is just |dec − i_park|
    // but we want a non-negative value — the burn always has SOME plane
    // tilt cost equal to the angle between the parking plane and the
    // asymptote. Use the smaller of the two complementary angles:
    const tilt = Math.abs(Math.abs(dec) - i_park_rad);
    const dv = combinedBurnDV(v_park, v_hyp, tilt);
    return {
        dv_kms: dv,
        v_park_kms: v_park,
        v_hyp_kms:  v_hyp,
        dec_deg:    dec * R2D,
        plane_change_deg: tilt * R2D,
    };
}

/**
 * Same idea on the arrival side: capture into a circular orbit at radius
 * r_capt around the target, given the v∞ at the planet. Combined-burn cost.
 */
export function arrivalBurnIntoOrbit({ r_capt_km, mu, v_inf_vec, i_capt_rad = null }) {
    const v_inf  = vNorm(v_inf_vec);
    const v_circ = vCirc(r_capt_km, mu);
    const v_hyp  = Math.sqrt(v_inf*v_inf + 2*mu / r_capt_km);
    const dec    = declination(v_inf_vec);
    const tilt   = (i_capt_rad == null) ? 0 : Math.abs(Math.abs(dec) - i_capt_rad);
    const dv     = (i_capt_rad == null) ? (v_hyp - v_circ)
                                        : combinedBurnDV(v_circ, v_hyp, tilt);
    return {
        dv_kms:  dv,
        v_circ_kms: v_circ,
        v_hyp_kms:  v_hyp,
        dec_deg:    dec * R2D,
        plane_change_deg: tilt * R2D,
    };
}

// ── Gravity-assist (powered-flyby) physics ──────────────────────────────────
//
// During a planetary flyby, the spacecraft enters the body's SOI with v∞_in,
// follows a hyperbolic trajectory with periapsis r_p, and exits with v∞_out
// of the SAME magnitude (energy conservation in the body's frame) but with
// the velocity direction rotated by α — the "turn angle". The maximum
// achievable turn is bounded by the geometry:
//
//     α_max(r_p, v∞) = 2·arcsin(μ / (r_p·v∞² + μ))
//
// Smaller r_p ⇒ bigger turn (more deflection); higher v∞ ⇒ smaller turn.
// In a real mission r_p must be ≥ R_body + min_alt to avoid impact.
//
// If the Lambert legs require a turn larger than α_max at the minimum
// allowed r_p, OR a magnitude change in v∞, the mission must supply a
// powered-flyby Δv at periapsis. We model this as the orthogonal sum of:
//   • Δv_mag = ||v∞_out| − |v∞_in||  (tangential burn at periapsis)
//   • Δv_dir = 2·v∞·sin((α_req − α_max)/2)  (when α_req > α_max)

const FLYBY_BODIES = {
    mercury: { mu: 22032.1,  r_km: 2439.7, min_alt_km: 200 },
    venus:   { mu: 324859.0, r_km: 6051.8, min_alt_km: 200 },
    earth:   { mu: MU_EARTH, r_km: R_EARTH, min_alt_km: 300 },
    mars:    { mu: MU_MARS,  r_km: R_MARS,  min_alt_km: 200 },
};

/** Maximum natural flyby turn angle (radians) at given r_p and v∞. */
export function flybyMaxTurnAngle(mu, v_inf_kms, r_p_km) {
    return 2 * Math.asin(mu / (r_p_km * v_inf_kms * v_inf_kms + mu));
}

/** Periapsis radius (km) required to achieve a given turn angle. */
export function flybyPeriapsisForTurn(mu, v_inf_kms, turn_rad) {
    const s = Math.sin(turn_rad / 2);
    if (s < 1e-9) return Infinity;       // ~zero turn needs infinite r_p
    return mu * (1 - s) / (s * v_inf_kms * v_inf_kms);
}

/**
 * Assess a planetary flyby: given v∞_in and v∞_out (vectors, in the body's
 * inertial frame), determine whether the geometry is ballistically
 * feasible and how much powered Δv (if any) is required.
 *
 * @param {string}  body_key   One of 'mercury', 'venus', 'earth', 'mars'.
 * @param {number[3]} v_inf_in   Incoming v∞ vector (km/s).
 * @param {number[3]} v_inf_out  Required outgoing v∞ vector (km/s).
 */
/**
 * B-plane parameters for a hyperbolic flyby.
 *
 * The B-plane is the plane perpendicular to the incoming v∞ asymptote ŝ,
 * located at the target body. Two orthonormal axes (T̂, R̂) span this plane:
 *
 *     T̂ = ŝ × K̂ / |ŝ × K̂|     (K̂ = ecliptic north for solar-system work)
 *     R̂ = ŝ × T̂                (right-handed completion)
 *
 * The B-vector points from the body to where the incoming asymptote
 * pierces the B-plane — it lies in the (T̂, R̂) plane, perpendicular to ŝ
 * by construction. Its magnitude is the impact parameter:
 *
 *     |B|² = r_p · (r_p + 2μ/v∞²)
 *
 * The flyby plane (containing v∞_in and v∞_out) is determined by the
 * rotation axis ĥ = (v∞_in × v∞_out)/|…|, which must be perpendicular to
 * v∞_in by construction. The B vector points along ĥ × ŝ, lying in the
 * flyby plane and in the B-plane simultaneously.
 *
 * Components B·T and B·R fully parameterize the flyby geometry — JPL
 * mission designers target specific (B·T, B·R) values to set up arrival
 * conditions at the next body in a tour.
 */
export function bPlaneParameters(v_inf_in, v_inf_out, mu, r_p_km) {
    const v_in_mag = vNorm(v_inf_in);
    const s_hat = [v_inf_in[0]/v_in_mag, v_inf_in[1]/v_in_mag, v_inf_in[2]/v_in_mag];

    // T̂ = ŝ × K̂ where K̂ is ecliptic north. Fall back to X if degenerate.
    const K = [0, 0, 1];
    let T = vCross(s_hat, K);
    let T_mag = vNorm(T);
    if (T_mag < 1e-9) {
        T = vCross(s_hat, [1, 0, 0]);
        T_mag = vNorm(T);
    }
    const T_hat = [T[0]/T_mag, T[1]/T_mag, T[2]/T_mag];
    const R_hat = vCross(s_hat, T_hat);    // already unit (ŝ ⊥ T̂)

    // Rotation axis from the actual Lambert legs.
    const h_vec = vCross(v_inf_in, v_inf_out);
    const h_mag = vNorm(h_vec);
    let h_hat, B_hat;
    if (h_mag < 1e-9) {
        // Co-linear v∞ vectors → no deflection. B is degenerate; pick T̂.
        h_hat = [...R_hat];
        B_hat = [...T_hat];
    } else {
        h_hat = [h_vec[0]/h_mag, h_vec[1]/h_mag, h_vec[2]/h_mag];
        // B̂ = ĥ × ŝ — perpendicular to ŝ, in the flyby plane.
        const B = vCross(h_hat, s_hat);
        const Bm = vNorm(B);
        B_hat = [B[0]/Bm, B[1]/Bm, B[2]/Bm];
    }

    // |B| from impact-parameter formula.
    const B_mag = Math.sqrt(r_p_km * (r_p_km + 2 * mu / (v_in_mag * v_in_mag)));
    const B_vec = [B_hat[0]*B_mag, B_hat[1]*B_mag, B_hat[2]*B_mag];

    return {
        s_hat, T_hat, R_hat, h_hat, B_hat,
        B_vec, B_mag,
        B_dot_T: vDot(B_vec, T_hat),
        B_dot_R: vDot(B_vec, R_hat),
        // Verify rotation-axis constraint: ĥ ⊥ ŝ (should be ~0 always).
        rotation_axis_residual: Math.abs(vDot(h_hat, s_hat)),
    };
}

export function flybyAssessment(body_key, v_inf_in, v_inf_out) {
    const body = FLYBY_BODIES[body_key];
    if (!body) throw new Error(`flybyAssessment: unknown body "${body_key}"`);

    const mag_in  = vNorm(v_inf_in);
    const mag_out = vNorm(v_inf_out);
    const v_avg   = 0.5 * (mag_in + mag_out);

    const cosTurn = vDot(v_inf_in, v_inf_out) / (mag_in * mag_out);
    const turn_req_rad = Math.acos(Math.max(-1, Math.min(1, cosTurn)));

    const r_min   = body.r_km + body.min_alt_km;
    const turn_max_rad = flybyMaxTurnAngle(body.mu, v_avg, r_min);

    let r_p, alt, dv_dir;
    if (turn_req_rad <= turn_max_rad) {
        r_p = flybyPeriapsisForTurn(body.mu, v_avg, turn_req_rad);
        alt = r_p - body.r_km;
        dv_dir = 0;
    } else {
        r_p = r_min;
        alt = body.min_alt_km;
        const missing = turn_req_rad - turn_max_rad;
        dv_dir = 2 * v_avg * Math.sin(missing / 2);
    }
    const dv_mag = Math.abs(mag_out - mag_in);

    return {
        body: body_key,
        v_inf_in_kms:      mag_in,
        v_inf_out_kms:     mag_out,
        turn_required_deg: turn_req_rad * R2D,
        turn_max_deg:      turn_max_rad * R2D,
        r_periapsis_km:    r_p,
        altitude_km:       alt,
        ballistic:         (turn_req_rad <= turn_max_rad) && (dv_mag < 0.05),
        dv_mag_kms:        dv_mag,
        dv_dir_kms:        dv_dir,
        dv_powered_kms:    dv_mag + dv_dir,
        b_plane:           bPlaneParameters(v_inf_in, v_inf_out, body.mu, r_p),
        body_radius_km:    body.r_km,
        body_mu:           body.mu,
    };
}

// ── Lambert-based Mars transfer ─────────────────────────────────────────────
//
// Solves Lambert's problem for a single (jd_depart, jd_arrive) pair using
// real Earth/Mars heliocentric position vectors (3D, including ecliptic
// latitude). Reports the full Δv breakdown including plane-change costs at
// both the parking orbit and Mars-arrival orbit.

export function planMarsLambert({
    jd_depart           = jdNow(),
    jd_arrive           = jdNow() + 260,
    parking_alt_km      = 300,
    target_alt_mars_km  = 400,
    parking_inc_deg     = 28.5,    // KSC default
    capture_inc_deg     = null,    // null = ignore arrival plane change
    prograde            = true,
} = {}) {
    if (jd_arrive <= jd_depart) throw new Error('planMarsLambert: jd_arrive must be > jd_depart');

    const tof_s = (jd_arrive - jd_depart) * SECONDS_PER_DAY;

    const e = planetState(earthHeliocentric, jd_depart);
    const m = planetState(marsHeliocentric,  jd_arrive);

    const sol = lambert(e.r, m.r, tof_s, MU_SUN, { prograde });

    const v_inf_e = vSub(sol.v1, e.v);
    const v_inf_m = vSub(sol.v2, m.v);

    const r_park_e = R_EARTH + parking_alt_km;
    const r_park_m = R_MARS  + target_alt_mars_km;

    const dep = departureBurnFromParking({
        r_park_km: r_park_e, mu: MU_EARTH,
        v_inf_vec: v_inf_e, i_park_rad: parking_inc_deg * D2R,
    });
    const arr = arrivalBurnIntoOrbit({
        r_capt_km: r_park_m, mu: MU_MARS,
        v_inf_vec: v_inf_m,
        i_capt_rad: capture_inc_deg == null ? null : capture_inc_deg * D2R,
    });

    return {
        kind: 'mars',
        method: 'lambert',
        jd_depart, jd_arrive, tof_d: jd_arrive - jd_depart, tof_s,
        earth_at_departure_kms: e,
        mars_at_arrival_kms:    m,
        lambert: sol,
        v_inf_earth_vec: v_inf_e,
        v_inf_mars_vec:  v_inf_m,
        v_inf_earth_kms: vNorm(v_inf_e),
        v_inf_mars_kms:  vNorm(v_inf_m),
        c3_earth_km2s2:  vNorm(v_inf_e) ** 2,
        c3_mars_km2s2:   vNorm(v_inf_m) ** 2,
        // Departure (TMI)
        dv_tmi_kms:           dep.dv_kms,
        dv_tmi_tangential_kms:dep.v_hyp_kms - dep.v_park_kms,
        v_park_earth_kms:     dep.v_park_kms,
        v_hyp_earth_kms:      dep.v_hyp_kms,
        dla_deg:              dep.dec_deg,        // declination of v∞ at Earth
        plane_change_dep_deg: dep.plane_change_deg,
        // Arrival (MOI)
        dv_moi_kms:           arr.dv_kms,
        dv_moi_tangential_kms:arr.v_hyp_kms - arr.v_circ_kms,
        v_park_mars_kms:      arr.v_circ_kms,
        v_hyp_mars_kms:       arr.v_hyp_kms,
        dla_mars_deg:         arr.dec_deg,
        plane_change_arr_deg: arr.plane_change_deg,
        dv_total_kms:         dep.dv_kms + arr.dv_kms,
        // Trajectory polyline (heliocentric km) for the renderer
        sample: () => sampleKeplerArc(e.r, sol.v1, tof_s, MU_SUN, 96),
    };
}

/**
 * Pork-chop scan: evaluates Lambert over a 2D grid of departure × arrival
 * dates and returns a heatmap of total Δv (and C3 + arrival v∞ for
 * additional curtain plots).
 *
 * Performance: ~6 ms for 40×40 grid, ~50 ms for 100×100 (Node v22).
 *
 * @returns {{
 *   n_dep, n_arr, jd_dep_min, jd_dep_max, jd_arr_min, jd_arr_max,
 *   dv:    Float32Array,   // total Δv (km/s), row-major [i*n_arr + j]
 *   c3:    Float32Array,   // departure C3 (km²/s²)
 *   vinfA: Float32Array,   // arrival v∞ (km/s)
 *   tof_d: Float32Array,   // time of flight (days)
 *   best:  { i, j, jd_dep, jd_arr, dv, c3, vinfA, tof_d }
 * }}
 */
export function porkchopMars({
    jd_dep_min, jd_dep_max, jd_arr_min, jd_arr_max,
    n_dep = 60, n_arr = 60,
    parking_alt_km     = 300,
    target_alt_mars_km = 400,
    parking_inc_deg    = 28.5,
    prograde           = true,
    dv_clip_kms        = 25,        // cells above this map to NaN
} = {}) {
    const dv    = new Float32Array(n_dep * n_arr);
    const c3    = new Float32Array(n_dep * n_arr);
    const vinfA = new Float32Array(n_dep * n_arr);
    const tofD  = new Float32Array(n_dep * n_arr);
    let best = { dv: Infinity, i: 0, j: 0, jd_dep: 0, jd_arr: 0, c3: 0, vinfA: 0, tof_d: 0 };

    // Pre-cache departure planet states (we hit each i many times)
    const deps = new Array(n_dep);
    for (let i = 0; i < n_dep; i++) {
        const jd = jd_dep_min + (jd_dep_max - jd_dep_min) * (i / (n_dep - 1));
        deps[i] = { jd, state: planetState(earthHeliocentric, jd) };
    }
    const arrs = new Array(n_arr);
    for (let j = 0; j < n_arr; j++) {
        const jd = jd_arr_min + (jd_arr_max - jd_arr_min) * (j / (n_arr - 1));
        arrs[j] = { jd, state: planetState(marsHeliocentric, jd) };
    }

    for (let i = 0; i < n_dep; i++) {
        const D = deps[i];
        for (let j = 0; j < n_arr; j++) {
            const A = arrs[j];
            const idx = i * n_arr + j;
            const tof = (A.jd - D.jd) * SECONDS_PER_DAY;
            if (tof < 30 * SECONDS_PER_DAY) {
                dv[idx] = NaN; c3[idx] = NaN; vinfA[idx] = NaN; tofD[idx] = NaN;
                continue;
            }
            try {
                const sol = lambert(D.state.r, A.state.r, tof, MU_SUN, { prograde });
                const vie = vSub(sol.v1, D.state.v);
                const vim = vSub(sol.v2, A.state.v);
                const vie_n = vNorm(vie), vim_n = vNorm(vim);

                const r_park_e = R_EARTH + parking_alt_km;
                const r_park_m = R_MARS  + target_alt_mars_km;
                const v_park_e = Math.sqrt(MU_EARTH / r_park_e);
                const v_hyp_e  = Math.sqrt(vie_n*vie_n + 2*MU_EARTH / r_park_e);
                const v_circ_m = Math.sqrt(MU_MARS / r_park_m);
                const v_hyp_m  = Math.sqrt(vim_n*vim_n + 2*MU_MARS / r_park_m);

                const tilt = Math.abs(Math.abs(declination(vie)) - parking_inc_deg * D2R);
                const dv_dep = combinedBurnDV(v_park_e, v_hyp_e, tilt);
                const dv_arr = v_hyp_m - v_circ_m;
                const total  = dv_dep + dv_arr;

                if (Number.isFinite(total) && total < dv_clip_kms) {
                    dv[idx]    = total;
                    c3[idx]    = vie_n * vie_n;
                    vinfA[idx] = vim_n;
                    tofD[idx]  = A.jd - D.jd;
                    if (total < best.dv) {
                        best = { dv: total, i, j, jd_dep: D.jd, jd_arr: A.jd,
                                 c3: vie_n*vie_n, vinfA: vim_n, tof_d: A.jd - D.jd };
                    }
                } else {
                    dv[idx] = NaN; c3[idx] = NaN; vinfA[idx] = NaN; tofD[idx] = NaN;
                }
            } catch (_) {
                dv[idx] = NaN; c3[idx] = NaN; vinfA[idx] = NaN; tofD[idx] = NaN;
            }
        }
    }
    return {
        n_dep, n_arr,
        jd_dep_min, jd_dep_max, jd_arr_min, jd_arr_max,
        dv, c3, vinfA, tof_d: tofD, best,
    };
}


// ── Lunar Lambert (geocentric, with TOF as a knob) ──────────────────────────
//
// Replaces the Hohmann lunar transfer with a Lambert solve so the user can
// pick any TOF — Apollo-fast (~3 d) all the way out to a lazy 7-day glide.
// For each TOF we sweep the burn-point angle θ around the parking orbit and
// pick the geometry that minimises total Δv.  This captures the real Apollo
// trade-off (faster = burn off-tangent = more Δv) without forcing the user
// to specify a phase angle.
//
// The Moon's geocentric inertial state at arrival comes from a centered
// finite-difference on moonGeocentric().

function _moonGeoCart(m) {
    const c = Math.cos(m.lat_rad);
    return [
        m.dist_km * c * Math.cos(m.lon_rad),
        m.dist_km * c * Math.sin(m.lon_rad),
        m.dist_km * Math.sin(m.lat_rad),
    ];
}

export function moonGeoState(jd, dt = 0.001) {
    const r  = _moonGeoCart(moonGeocentric(jd));
    const rp = _moonGeoCart(moonGeocentric(jd + dt));
    const rm = _moonGeoCart(moonGeocentric(jd - dt));
    const inv = 1 / (2 * dt * SECONDS_PER_DAY);
    return {
        r,
        v: [(rp[0] - rm[0]) * inv, (rp[1] - rm[1]) * inv, (rp[2] - rm[2]) * inv],
    };
}

export function planLunarLambert({
    jd_depart           = jdNow(),
    tof_d               = 5.0,
    parking_alt_km      = 300,
    target_alt_moon_km  = 100,
    parking_inc_deg     = 28.5,
    n_theta             = 30,           // burn-angle samples
} = {}) {
    const jd     = jd_depart;
    const tof_s  = tof_d * SECONDS_PER_DAY;
    const r_park = R_EARTH + parking_alt_km;
    const r_capt = R_MOON  + target_alt_moon_km;

    const moonState  = moonGeoState(jd + tof_d);
    const r2         = moonState.r;
    const r2_mag     = Math.hypot(r2[0], r2[1], r2[2]);
    const r2_unit    = [r2[0]/r2_mag, r2[1]/r2_mag, r2[2]/r2_mag];

    // Build an in-plane perpendicular by crossing r2 with +Z (north). For
    // |r2 × Z| ≈ 0 (Moon at the pole — never happens in practice) we'd
    // need a fallback; ignore for now.
    const z = [0, 0, 1];
    const cross = vCross(r2_unit, z);
    const cm = vNorm(cross);
    const perp = [cross[0]/cm, cross[1]/cm, cross[2]/cm];

    let best = null;
    for (let i = 0; i < n_theta; i++) {
        // θ ∈ [60°, 200°]: angular distance from r2 direction along which
        // the parking-orbit antipode sits. 180° = classical Hohmann burn.
        const theta = (60 + (200 - 60) * (i / (n_theta - 1))) * D2R;
        const c = Math.cos(theta), s = Math.sin(theta);
        const r1 = [
            r_park * (c * r2_unit[0] + s * perp[0]),
            r_park * (c * r2_unit[1] + s * perp[1]),
            r_park * (c * r2_unit[2] + s * perp[2]),
        ];

        let sol;
        try {
            sol = lambert(r1, r2, tof_s, MU_EARTH);
        } catch (_) { continue; }

        // Parking-orbit prograde tangent at r1, derived from the transfer
        // plane's actual angular-momentum direction (not from our θ
        // parameterization, which can run opposite to Lambert's prograde
        // branch depending on the Moon's geometry).
        const h_xfer = vCross(r1, sol.v1);
        const h_mag  = vNorm(h_xfer);
        const h_unit = [h_xfer[0]/h_mag, h_xfer[1]/h_mag, h_xfer[2]/h_mag];
        const r1_mag = vNorm(r1);
        const r1_unit_v = [r1[0]/r1_mag, r1[1]/r1_mag, r1[2]/r1_mag];
        const tangent = vCross(h_unit, r1_unit_v);   // prograde tangent at r1
        const v_park = Math.sqrt(MU_EARTH / r_park);
        const v_park_vec = [tangent[0]*v_park, tangent[1]*v_park, tangent[2]*v_park];

        const dv_burn_vec = vSub(sol.v1, v_park_vec);
        const dv_tli      = vNorm(dv_burn_vec);

        const v_inf_vec = vSub(sol.v2, moonState.v);
        const v_inf     = vNorm(v_inf_vec);

        // LOI: capture into circular lunar orbit (tangential, no plane change).
        const v_perilune_hyp = Math.sqrt(v_inf*v_inf + 2 * MU_MOON / r_capt);
        const v_circ_moon    = Math.sqrt(MU_MOON / r_capt);
        const dv_loi         = v_perilune_hyp - v_circ_moon;

        const total = dv_tli + dv_loi;
        if (!best || total < best.dv_total_kms) {
            best = {
                kind: 'lunar', method: 'lambert',
                jd_depart: jd, jd_arrive: jd + tof_d,
                tof_d, tof_s,
                burn_angle_deg: theta * R2D,
                r1, r2, r_park_km: r_park, r_capt_km: r_capt,
                lambert: sol,
                dv_tli_kms: dv_tli,
                dv_loi_kms: dv_loi,
                dv_total_kms: total,
                v_inf_moon_kms: v_inf,
                parking_inc_deg,
                moon_at_arrival: moonGeocentric(jd + tof_d),
                sample: () => sampleKeplerArc(r1, sol.v1, tof_s, MU_EARTH, 96),
            };
        }
    }
    if (!best) throw new Error(`planLunarLambert: no feasible Lambert at TOF=${tof_d}d`);
    return best;
}

// ── Cross-body return / inter-base routes ─────────────────────────────────
//
// All three routes are thin wrappers around the existing Lambert solver.
// They share the same plan shape (`kind`, `method`, `dv_*_kms`, `sample()`,
// arrival/departure body states) so the renderer can dispatch them through
// one helio-arc animator.

/**
 * Heliocentric state of the Moon at JD: Earth_helio + Moon_geo (translated).
 * Both are returned in km. Velocity is via centered finite difference.
 */
function moonHelioState(jd, dt = _DT_VEL_DAYS) {
    const e_now = planetState(earthHeliocentric, jd);
    const m_now = moonGeoState(jd);
    const r = [e_now.r[0] + m_now.r[0], e_now.r[1] + m_now.r[1], e_now.r[2] + m_now.r[2]];
    const v = [e_now.v[0] + m_now.v[0], e_now.v[1] + m_now.v[1], e_now.v[2] + m_now.v[2]];
    return { r, v };
}

/**
 * Mars → Earth heliocentric Lambert. Mirror of planMarsLambert with the
 * endpoints swapped: depart from a low Mars orbit, arrive at a low Earth
 * parking orbit. EDL is left for the renderer (capture into LEO is what
 * we report numerically).
 */
export function planMarsToEarthLambert({
    jd_depart           = jdNow(),
    jd_arrive           = jdNow() + 260,
    parking_alt_mars_km = 400,
    target_alt_km       = 300,
    parking_inc_deg     = 0,
    capture_inc_deg     = null,
    prograde            = true,
} = {}) {
    if (jd_arrive <= jd_depart) throw new Error('planMarsToEarthLambert: jd_arrive must be > jd_depart');

    const tof_s = (jd_arrive - jd_depart) * SECONDS_PER_DAY;
    const m = planetState(marsHeliocentric,  jd_depart);
    const e = planetState(earthHeliocentric, jd_arrive);

    const sol = lambert(m.r, e.r, tof_s, MU_SUN, { prograde });
    const v_inf_m = vSub(sol.v1, m.v);
    const v_inf_e = vSub(sol.v2, e.v);

    const r_park_m = R_MARS  + parking_alt_mars_km;
    const r_park_e = R_EARTH + target_alt_km;

    const dep = departureBurnFromParking({
        r_park_km: r_park_m, mu: MU_MARS,
        v_inf_vec: v_inf_m, i_park_rad: parking_inc_deg * D2R,
    });
    const arr = arrivalBurnIntoOrbit({
        r_capt_km: r_park_e, mu: MU_EARTH,
        v_inf_vec: v_inf_e,
        i_capt_rad: capture_inc_deg == null ? null : capture_inc_deg * D2R,
    });

    return {
        kind: 'mars-to-earth',
        method: 'lambert',
        jd_depart, jd_arrive, tof_d: jd_arrive - jd_depart, tof_s,
        depart_state_kms: m, arrive_state_kms: e,
        lambert: sol,
        v_inf_depart_kms: vNorm(v_inf_m),
        v_inf_arrive_kms: vNorm(v_inf_e),
        c3_depart_km2s2:  vNorm(v_inf_m) ** 2,
        dv_depart_kms:    dep.dv_kms,
        dv_arrive_kms:    arr.dv_kms,
        dv_total_kms:     dep.dv_kms + arr.dv_kms,
        sample: () => sampleKeplerArc(m.r, sol.v1, tof_s, MU_SUN, 96),
    };
}

/**
 * Moon → Mars heliocentric Lambert. Departs from the Moon's heliocentric
 * position (Earth_helio + Moon_geo), arrives at Mars. The Δv reported at
 * departure is for an injection from a circular low lunar orbit; the small
 * heliocentric offset between Moon and Earth is what makes this cheaper or
 * more expensive than a direct Earth → Mars depending on Moon phase.
 */
export function planMoonToMarsLambert({
    jd_depart           = jdNow(),
    jd_arrive           = jdNow() + 260,
    parking_alt_moon_km = 100,
    target_alt_mars_km  = 400,
    parking_inc_deg     = 0,
    capture_inc_deg     = null,
    prograde            = true,
} = {}) {
    if (jd_arrive <= jd_depart) throw new Error('planMoonToMarsLambert: jd_arrive must be > jd_depart');

    const tof_s = (jd_arrive - jd_depart) * SECONDS_PER_DAY;
    const moon = moonHelioState(jd_depart);
    const mars = planetState(marsHeliocentric, jd_arrive);

    const sol = lambert(moon.r, mars.r, tof_s, MU_SUN, { prograde });
    const v_inf_moon = vSub(sol.v1, moon.v);
    const v_inf_mars = vSub(sol.v2, mars.v);

    const r_park_moon = R_MOON + parking_alt_moon_km;
    const r_park_mars = R_MARS + target_alt_mars_km;

    const dep = departureBurnFromParking({
        r_park_km: r_park_moon, mu: MU_MOON,
        v_inf_vec: v_inf_moon, i_park_rad: parking_inc_deg * D2R,
    });
    const arr = arrivalBurnIntoOrbit({
        r_capt_km: r_park_mars, mu: MU_MARS,
        v_inf_vec: v_inf_mars,
        i_capt_rad: capture_inc_deg == null ? null : capture_inc_deg * D2R,
    });

    return {
        kind: 'moon-to-mars',
        method: 'lambert',
        jd_depart, jd_arrive, tof_d: jd_arrive - jd_depart, tof_s,
        depart_state_kms: moon, arrive_state_kms: mars,
        lambert: sol,
        v_inf_depart_kms: vNorm(v_inf_moon),
        v_inf_arrive_kms: vNorm(v_inf_mars),
        c3_depart_km2s2:  vNorm(v_inf_moon) ** 2,
        dv_depart_kms:    dep.dv_kms,
        dv_arrive_kms:    arr.dv_kms,
        dv_total_kms:     dep.dv_kms + arr.dv_kms,
        sample: () => sampleKeplerArc(moon.r, sol.v1, tof_s, MU_SUN, 96),
    };
}

/**
 * Moon → Earth geocentric Lambert (lunar return). Sweeps the burn-angle
 * parameter the same way planLunarLambert does, but with the Moon as the
 * departure point and a low Earth parking orbit as the arrival.
 */
export function planMoonToEarthLambert({
    jd_depart           = jdNow(),
    tof_d               = 4.5,
    parking_alt_moon_km = 100,
    target_alt_earth_km = 300,
    n_theta             = 30,
} = {}) {
    const tof_s = tof_d * SECONDS_PER_DAY;
    const r_moon  = R_MOON  + parking_alt_moon_km;
    const r_earth = R_EARTH + target_alt_earth_km;

    const moonState = moonGeoState(jd_depart);
    const r1        = moonState.r;
    const r1_mag    = vNorm(r1);
    const r1_unit   = [r1[0]/r1_mag, r1[1]/r1_mag, r1[2]/r1_mag];

    // Build an in-plane perpendicular by crossing r1 with +Z, mirror of
    // planLunarLambert's geometry (same caveat at the lunar pole).
    const z = [0, 0, 1];
    const cross = vCross(r1_unit, z);
    const cm = vNorm(cross);
    const perp = [cross[0]/cm, cross[1]/cm, cross[2]/cm];

    let best = null;
    for (let i = 0; i < n_theta; i++) {
        const theta = (60 + (200 - 60) * (i / (n_theta - 1))) * D2R;
        const c = Math.cos(theta), s = Math.sin(theta);
        const r2 = [
            r_earth * (c * r1_unit[0] + s * perp[0]),
            r_earth * (c * r1_unit[1] + s * perp[1]),
            r_earth * (c * r1_unit[2] + s * perp[2]),
        ];

        let sol;
        try { sol = lambert(r1, r2, tof_s, MU_EARTH); }
        catch (_) { continue; }

        // Δv at the Moon: we depart from a circular low lunar orbit, so
        // the departure burn is from v_circ_moon along the prograde tangent
        // up to v_hyp at perilune, plus the difference between the helio
        // arc's initial velocity and the Moon's own velocity (v∞).
        const v_inf_vec  = vSub(sol.v1, moonState.v);
        const v_inf      = vNorm(v_inf_vec);
        const v_perilune_hyp = Math.sqrt(v_inf*v_inf + 2 * MU_MOON / r_moon);
        const v_circ_moon    = Math.sqrt(MU_MOON / r_moon);
        const dv_dep         = v_perilune_hyp - v_circ_moon;

        // Δv at Earth: insert into a circular low Earth orbit at r_earth.
        const v_at_r2 = vNorm(sol.v2);
        const v_circ_e = Math.sqrt(MU_EARTH / r_earth);
        const dv_arr   = Math.abs(v_at_r2 - v_circ_e);

        const total = dv_dep + dv_arr;
        if (!best || total < best.dv_total_kms) {
            best = {
                kind: 'moon-to-earth',
                method: 'lambert',
                jd_depart, jd_arrive: jd_depart + tof_d,
                tof_d, tof_s,
                burn_angle_deg: theta * R2D,
                r1, r2, r_park_km: r_moon, r_capt_km: r_earth,
                lambert: sol,
                dv_depart_kms: dv_dep,
                dv_arrive_kms: dv_arr,
                dv_total_kms:  total,
                v_inf_moon_kms: v_inf,
                moon_at_departure: moonGeocentric(jd_depart),
                sample: () => sampleKeplerArc(r1, sol.v1, tof_s, MU_EARTH, 96),
            };
        }
    }
    if (!best) throw new Error(`planMoonToEarthLambert: no feasible Lambert at TOF=${tof_d}d`);
    return best;
}

// ── Outer-planet Lambert (Jupiter / Saturn / Uranus / Neptune) ──────────────
//
// Same shape as planMarsLambert — heliocentric Lambert from Earth at
// jd_depart to the target planet at jd_arrive — but generalised over the
// destination body so we can fly Voyager-style direct missions to any
// outer planet. Real missions use gravity assists; first-pass plan reports
// the unaided Δv so the user can see how steep an outer-planet capture is.
//
// Default time-of-flight follows the Hohmann transfer time (Earth_orbit →
// target_orbit half-ellipse). Real missions trade longer TOF for a smaller
// C3 by leaving the Hohmann window; the generic Lambert solver works for
// any (depart, arrive) pair so users can dial that in via the time slider.
const _OUTER_PLANET_CFG = {
    jupiter: {
        ephFn: jupiterHeliocentric, R_km: R_JUPITER, mu: MU_JUPITER,
        default_target_alt_km:  5000,    // ~10 RJ low-Jupiter orbit
        default_tof_d:          1000,    // ~Hohmann
    },
    saturn: {
        ephFn: saturnHeliocentric,  R_km: R_SATURN,  mu: MU_SATURN,
        default_target_alt_km:  5000,
        default_tof_d:          2200,
    },
    uranus: {
        ephFn: uranusHeliocentric,  R_km: R_URANUS,  mu: MU_URANUS,
        default_target_alt_km:  3000,
        default_tof_d:          5800,
    },
    neptune: {
        ephFn: neptuneHeliocentric, R_km: R_NEPTUNE, mu: MU_NEPTUNE,
        default_target_alt_km:  3000,
        default_tof_d:         11200,
    },
};

export function planEarthToOuterLambert({
    planet,                                  // 'jupiter' | 'saturn' | 'uranus' | 'neptune'
    jd_depart           = jdNow(),
    jd_arrive           = null,
    parking_alt_km      = 300,
    target_alt_km       = null,
    parking_inc_deg     = 28.5,
    capture_inc_deg     = null,
    prograde            = true,
} = {}) {
    const cfg = _OUTER_PLANET_CFG[planet];
    if (!cfg) throw new Error(`planEarthToOuterLambert: unknown planet ${planet}`);

    const _jd_arrive = jd_arrive ?? (jd_depart + cfg.default_tof_d);
    const _alt_km    = target_alt_km ?? cfg.default_target_alt_km;
    if (_jd_arrive <= jd_depart) throw new Error('planEarthToOuterLambert: jd_arrive must be > jd_depart');

    const tof_s = (_jd_arrive - jd_depart) * SECONDS_PER_DAY;
    const e = planetState(earthHeliocentric, jd_depart);
    const t = planetState(cfg.ephFn,         _jd_arrive);

    const sol = lambert(e.r, t.r, tof_s, MU_SUN, { prograde });
    const v_inf_e = vSub(sol.v1, e.v);
    const v_inf_t = vSub(sol.v2, t.v);

    const r_park_e = R_EARTH   + parking_alt_km;
    const r_park_t = cfg.R_km  + _alt_km;

    const dep = departureBurnFromParking({
        r_park_km: r_park_e, mu: MU_EARTH,
        v_inf_vec: v_inf_e, i_park_rad: parking_inc_deg * D2R,
    });
    const arr = arrivalBurnIntoOrbit({
        r_capt_km: r_park_t, mu: cfg.mu,
        v_inf_vec: v_inf_t,
        i_capt_rad: capture_inc_deg == null ? null : capture_inc_deg * D2R,
    });

    return {
        kind: `earth-to-${planet}`,
        method: 'lambert',
        jd_depart, jd_arrive: _jd_arrive,
        tof_d: _jd_arrive - jd_depart, tof_s,
        depart_state_kms: e, arrive_state_kms: t,
        lambert: sol,
        v_inf_depart_kms: vNorm(v_inf_e),
        v_inf_arrive_kms: vNorm(v_inf_t),
        c3_earth_km2s2:   vNorm(v_inf_e) ** 2,
        c3_arrive_km2s2:  vNorm(v_inf_t) ** 2,
        dv_depart_kms:    dep.dv_kms,
        dv_arrive_kms:    arr.dv_kms,
        dv_total_kms:     dep.dv_kms + arr.dv_kms,
        sample: () => sampleKeplerArc(e.r, sol.v1, tof_s, MU_SUN, 96),
    };
}

// ── Tour planner: chained Lambert legs ──────────────────────────────────────
//
// Sequence is an array of {from, to, tof_d} hops. Each hop solves Lambert
// in the heliocentric frame between the two body positions at the segment
// endpoints. Flybys are "free" if the magnitude of v∞ matches between the
// incoming and outgoing legs (within a few hundred m/s); we report the
// mismatch so the user can see how off the chosen dates are.
//
// Initial implementation: caller supplies the per-leg TOF. A future
// upgrade would optimise the leg TOFs via gradient descent on the total
// flyby mismatch.

const _BODY_FNS = {
    mercury: mercuryHeliocentric,
    venus:   venusHeliocentric,
    earth:   earthHeliocentric,
    mars:    marsHeliocentric,
};

export const TOUR_PRESETS = {
    veem: {
        name: 'V-E-E-M Earth → Venus → Earth → Mars (Galileo-style)',
        depart: 'earth',
        legs: [
            { to: 'venus', tof_d: 130 },
            { to: 'earth', tof_d: 350 },
            { to: 'mars',  tof_d: 280 },
        ],
    },
    em: {
        name: 'Direct Earth → Mars (Hohmann reference)',
        depart: 'earth',
        legs: [{ to: 'mars', tof_d: 258 }],
    },
    eve: {
        name: 'V-E Earth → Venus → Earth (BepiColombo-like first leg)',
        depart: 'earth',
        legs: [
            { to: 'venus', tof_d: 150 },
            { to: 'earth', tof_d: 360 },
        ],
    },
    evvm: {
        name: 'V-V-M Earth → Venus → Venus → Mars (deep flyby)',
        depart: 'earth',
        legs: [
            { to: 'venus', tof_d: 150 },
            { to: 'venus', tof_d: 225 },     // ~Venus year
            { to: 'mars',  tof_d: 320 },
        ],
    },
};

export function planTour({
    jd_depart           = jdNow(),
    sequence            = TOUR_PRESETS.veem,
    parking_alt_km      = 300,
    target_alt_capt_km  = 400,
    parking_inc_deg     = 28.5,
} = {}) {
    const fromKey = sequence.depart;
    const fromFn  = _BODY_FNS[fromKey];
    if (!fromFn) throw new Error(`planTour: unknown depart body "${fromKey}"`);

    const legs = [];
    let jd_curr     = jd_depart;
    let from_key    = fromKey;

    for (let i = 0; i < sequence.legs.length; i++) {
        const seg     = sequence.legs[i];
        const from_fn = _BODY_FNS[from_key];
        const to_fn   = _BODY_FNS[seg.to];
        if (!to_fn) throw new Error(`planTour: unknown body "${seg.to}" in leg ${i}`);

        const jd_a = jd_curr;
        const jd_b = jd_a + seg.tof_d;

        const stateA = planetState(from_fn, jd_a);
        const stateB = planetState(to_fn,   jd_b);

        // Try multi-rev too; pick the cheapest (smallest |v1 − v_planet_a|).
        const candidates = lambertAll(stateA.r, stateB.r, seg.tof_d * SECONDS_PER_DAY, MU_SUN, { maxM: 1 });
        let best = null;
        for (const sol of candidates) {
            const dv = vNorm(vSub(sol.v1, stateA.v));
            if (!best || dv < best.dv) best = { sol, dv };
        }
        if (!best) throw new Error(`planTour: no Lambert solution for leg ${i} (${from_key}→${seg.to})`);
        const sol = best.sol;

        const v_inf_dep = vSub(sol.v1, stateA.v);
        const v_inf_arr = vSub(sol.v2, stateB.v);

        legs.push({
            from: from_key, to: seg.to,
            jd_depart: jd_a, jd_arrive: jd_b,
            tof_d: seg.tof_d,
            r_depart: stateA.r, r_arrive: stateB.r,
            v_depart: sol.v1,   v_arrive: sol.v2,
            v_inf_depart_vec: v_inf_dep, v_inf_depart_kms: vNorm(v_inf_dep),
            v_inf_arrive_vec: v_inf_arr, v_inf_arrive_kms: vNorm(v_inf_arr),
            lambert: sol,
            sample: () => sampleKeplerArc(stateA.r, sol.v1, seg.tof_d * SECONDS_PER_DAY, MU_SUN, 96),
        });

        from_key = seg.to;
        jd_curr  = jd_b;
    }

    // ── Flyby physics at every intermediate body ────────────────────────────
    // For body between leg[i] and leg[i+1]: v∞_in = leg[i].v_inf_arrive,
    // v∞_out = leg[i+1].v_inf_depart. Compute the required turn angle, the
    // ballistic max turn, and any powered Δv needed to fix the difference.
    const flybys = [];
    let dv_powered_flyby_total = 0;
    for (let i = 0; i < legs.length - 1; i++) {
        const flyby = flybyAssessment(
            legs[i].to,
            legs[i].v_inf_arrive_vec,
            legs[i+1].v_inf_depart_vec,
        );
        legs[i].flyby_at_arrival = flyby;
        flybys.push(flyby);
        dv_powered_flyby_total += flyby.dv_powered_kms;
    }

    // Departure burn: from parking orbit at the first body (assume Earth).
    const first = legs[0];
    let dv_dep = NaN, c3_dep = NaN, dla_dep = NaN, tilt_dep = NaN;
    if (first.from === 'earth') {
        const r_park = R_EARTH + parking_alt_km;
        const v_park = Math.sqrt(MU_EARTH / r_park);
        const v_inf  = first.v_inf_depart_kms;
        const v_hyp  = Math.sqrt(v_inf*v_inf + 2 * MU_EARTH / r_park);
        const dec    = declination(first.v_inf_depart_vec);
        const tilt   = Math.abs(Math.abs(dec) - parking_inc_deg * D2R);
        dv_dep = combinedBurnDV(v_park, v_hyp, tilt);
        c3_dep = v_inf * v_inf;
        dla_dep = dec * R2D;
        tilt_dep = tilt * R2D;
    }

    // Arrival burn: capture at the last body.
    const last = legs[legs.length - 1];
    const lastBody = FLYBY_BODIES[last.to] || FLYBY_BODIES.earth;
    const r_capt   = lastBody.r_km + target_alt_capt_km;
    const v_circ   = Math.sqrt(lastBody.mu / r_capt);
    const v_hyp_c  = Math.sqrt(last.v_inf_arrive_kms ** 2 + 2 * lastBody.mu / r_capt);
    const dv_capt  = v_hyp_c - v_circ;

    return {
        kind: 'tour',
        name: sequence.name,
        sequence_id: Object.keys(TOUR_PRESETS).find(k => TOUR_PRESETS[k] === sequence) || 'custom',
        jd_depart, jd_arrive: jd_curr,
        tof_total_d: jd_curr - jd_depart,
        legs, flybys,
        // Δv breakdown
        dv_tmi_kms:               dv_dep,
        dv_capture_kms:           dv_capt,
        dv_powered_flyby_kms:     dv_powered_flyby_total,
        dv_total_kms:             dv_dep + dv_powered_flyby_total + dv_capt,
        c3_earth_km2s2:           c3_dep,
        dla_deg:                  dla_dep,
        plane_change_dep_deg:     tilt_dep,
        // Energy mismatch (legacy metric — kept for back-compat).
        max_flyby_mismatch_kms:   flybys.length
            ? Math.max(...flybys.map(f => f.dv_mag_kms))
            : 0,
        // Worst flyby altitude (smallest is most aggressive).
        min_flyby_altitude_km:    flybys.length
            ? Math.min(...flybys.map(f => f.altitude_km))
            : null,
        last_body: last.to,
        last_body_capture_alt_km: target_alt_capt_km,
    };
}

/**
 * Coarse local search that finds a good (jd_depart, per-leg TOF) combination
 * for a given tour preset. Cost = total Δv + 0.5 × Σ flyby mismatches.
 *
 * Search budget: ~1500–4000 evaluations depending on grid density. Runs in
 * ~30–80 ms for a 3-leg tour at default density. The result is *good*, not
 * *optimal* — production tour design uses gradient descent or evolutionary
 * algorithms on top of Lambert. This is enough to make the pre-canned
 * preset tours feasible (sub-15 km/s flyby mismatch instead of 20+).
 */
export function optimizeTour({
    jd_start             = jdNow(),
    sequence             = TOUR_PRESETS.veem,
    jd_depart_range_days = 540,        // search ± half this around jd_start
    jd_depart_steps      = 12,
    tof_range_days       = 80,         // search ± half this around the preset TOF
    tof_steps            = 5,
    parking_alt_km       = 300,
    parking_inc_deg      = 28.5,
    target_alt_capt_km   = 400,
} = {}) {
    const baseTofs = sequence.legs.map(l => l.tof_d);
    const tofChoices = baseTofs.map(t => {
        const out = [];
        for (let s = 0; s < tof_steps; s++) {
            out.push(t + (-tof_range_days/2) + (tof_range_days * s / (tof_steps - 1)));
        }
        return out;
    });

    let best = null;
    const total = jd_depart_steps * tofChoices.reduce((a, b) => a * b.length, 1);

    // Cartesian product of leg-TOF choices via index counter.
    const dims = tofChoices.map(c => c.length);
    const totalCombos = dims.reduce((a, b) => a*b, 1);

    for (let dep_i = 0; dep_i < jd_depart_steps; dep_i++) {
        const jd_depart = jd_start
            + (-jd_depart_range_days/2)
            + (jd_depart_range_days * dep_i / (jd_depart_steps - 1));

        for (let combo = 0; combo < totalCombos; combo++) {
            // Decode combo → leg TOFs
            let rem = combo;
            const legs = [];
            for (let k = 0; k < tofChoices.length; k++) {
                const idx = rem % dims[k];
                rem = Math.floor(rem / dims[k]);
                legs.push({ to: sequence.legs[k].to, tof_d: tofChoices[k][idx] });
            }
            try {
                const plan = planTour({
                    jd_depart,
                    sequence: { name: sequence.name, depart: sequence.depart, legs },
                    parking_alt_km, parking_inc_deg, target_alt_capt_km,
                });
                // Total Δv now already bundles powered-flyby cost into
                // dv_total_kms. Add a small penalty for ultra-low flyby
                // altitudes (< 500 km) — physically possible but operationally
                // risky, and a softer penalty drives the optimizer away from
                // marginal solutions.
                let altitudePenalty = 0;
                if (plan.min_flyby_altitude_km != null && plan.min_flyby_altitude_km < 500) {
                    altitudePenalty = (500 - plan.min_flyby_altitude_km) * 0.001;
                }
                const cost = plan.dv_total_kms + altitudePenalty;
                if (!best || cost < best.cost) {
                    best = { cost, plan, jd_depart, tofs: legs.map(l => l.tof_d) };
                }
            } catch (_) {}
        }
    }

    if (!best) throw new Error('optimizeTour: no feasible solution found in search space');
    best.plan._optimized = true;
    best.plan._search_evals = total;
    return best.plan;
}
