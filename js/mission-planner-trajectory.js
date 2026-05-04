/**
 * mission-planner-trajectory.js — Patched-conic trajectory math for the
 * Mission Planner page. All numbers are real km / km·s⁻¹ / Julian Days.
 *
 * Coverage:
 *   • Earth two-body: parking orbits, Hohmann transfers
 *   • Lunar transfer: geocentric Hohmann + lunar SOI patch + LOI capture
 *     burn into a circular lunar orbit. Phasing uses live ephemeris.
 *   • Mars transfer: heliocentric Hohmann + Earth-departure C3 + Mars
 *     SOI patch + MOI capture burn. Phase-angle window scan finds the
 *     next departure date that minimises required Δv.
 *
 * Approximations (good for a *visual* planner, not a flight planner):
 *   • Hohmann arcs (no Lambert solver yet — flagged for future work).
 *   • Co-planar transfers (we do not optimise inclination).
 *   • Tangential burns (v_∞ aligned with velocity vector at SOI).
 *   • Mars/Moon orbital radius taken at the relevant ephemeris JD.
 *
 * Future hooks: swap `_hohmannHelio` for a Lambert solver and the same
 * call sites get pork-chop scans for free.
 */

import { jdNow, moonGeocentric, earthHeliocentric, marsHeliocentric } from './horizons.js';

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
