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

import { jdNow, moonGeocentric, earthHeliocentric, marsHeliocentric } from './horizons.js';
import { lambert, vSub, vNorm, vScale, vCross, vDot, sampleKeplerArc } from './mission-planner-lambert.js';

// ── Physical constants ───────────────────────────────────────────────────────
export const KM_PER_AU       = 149597870.7;
export const SECONDS_PER_DAY = 86400;
export const D2R = Math.PI / 180;
export const R2D = 180 / Math.PI;

// Gravitational parameters (km³/s²)
export const MU_EARTH = 398600.4418;
export const MU_SUN   = 1.32712440018e11;
export const MU_MOON  = 4902.800066;
export const MU_MARS  = 42828.37;

// Body radii (km)
export const R_EARTH = 6378.137;
export const R_MOON  = 1737.4;
export const R_MARS  = 3389.5;

// Sphere-of-influence radii (km), classic Tisserand definition.
export const SOI_EARTH = 924000;
export const SOI_MOON  =  66100;
export const SOI_MARS  = 577000;

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

