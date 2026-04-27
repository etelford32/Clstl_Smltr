// Local GR diagnostics for an observer in the Schwarzschild geometry.
//
// All formulae are evaluated in geometrized units (G = c = M = 1). The
// observatory uses TON 618 mass scaling (units.js) to convert results into
// SI / human units for the HUD.
//
// References:
//   Misner-Thorne-Wheeler, "Gravitation", chs. 23, 25 (Schwarzschild geometry,
//   stationary & orbiting observers).
//   Bardeen-Press-Teukolsky 1972 (ISCO, photon sphere, circular orbits).
//
// All r-values are in units of M; the horizon is r_h = 2.

import {
    M_METERS, C_SI, LIGHT_YEAR_M, LIGHT_HOUR_M, AU_M,
    R_HORIZON_GEOM, R_PHOTON_SPHERE, B_CRIT_GEOM,
    TON618_MASS_SOLAR, M_SUN_KG, G_SI,
} from './units.js';

export const R_ISCO_GEOM = 6.0;          // ISCO radius for Schwarzschild (M = 1)
export const R_MARGINAL_BOUND = 4.0;     // marginally bound circular orbit
export const SURFACE_GRAVITY = 1.0 / (4.0 * R_HORIZON_GEOM / 2.0); // kappa = 1/(4M) in geometrized
// Hawking temperature (Schwarzschild): T_H = hbar c^3 / (8 pi G M k_B). In geometrized
// units the dimensionful constant is folded in once we plug TON 618's mass below.
const HBAR     = 1.054571817e-34;
const KBOLTZ   = 1.380649e-23;
const M_KG     = TON618_MASS_SOLAR * M_SUN_KG;

// ---------------------------------------------------------------------------
// Stationary (static) observer at radius r > 2M.
// ---------------------------------------------------------------------------
// Time dilation: dt/dτ = 1/sqrt(1 - 2M/r). Diverges at the horizon.
export function lapse(r) {
    const f = 1 - 2 / r;
    if (f <= 0) return Infinity;
    return 1 / Math.sqrt(f);
}

// Proper acceleration of a static observer (radially outward, magnitude only).
// In geometric units: a_static = M / (r^2 sqrt(1 - 2M/r)).
export function staticProperAcceleration(r) {
    const f = 1 - 2 / r;
    if (f <= 0) return Infinity;
    return 1.0 / (r * r * Math.sqrt(f));
}

// Tidal acceleration per unit length (radial component, geometric units):
// (Δa/L)_r = 2M/r^3. Tangential is half this with opposite sign.
export function tidalAcceleration(r) {
    return {
        radial:     2.0 / (r * r * r),
        tangential: -1.0 / (r * r * r),
    };
}

// ---------------------------------------------------------------------------
// Circular timelike geodesics (Keplerian).
// ---------------------------------------------------------------------------
// Coordinate angular velocity Omega = sqrt(M / r^3). Same form as Newton.
export function keplerOmega(r) { return Math.sqrt(1.0 / (r * r * r)); }

// Orbital velocity measured by a local static observer:
// v_phi^(local) = r sin theta * Omega / sqrt(1 - 2M/r), but at the equator
// the practical expression is v = sqrt(M/(r-2M)).
export function circularLocalVelocity(r) {
    if (r <= 2.0) return Infinity;
    return Math.sqrt(1.0 / (r - 2.0));
}

// Lorentz factor of circular orbit relative to local static observer:
// gamma_orb = (1 - 3M/r)^(-1/2)  for r > 3M.
export function orbitalGamma(r) {
    const fac = 1.0 - 3.0 / r;
    if (fac <= 0) return Infinity;
    return 1.0 / Math.sqrt(fac);
}

// Orbital period in coordinate time (same as proper time at infinity):
// T = 2 pi sqrt(r^3 / M). Returns geometric units.
export function orbitalPeriod(r) {
    return 2.0 * Math.PI * Math.sqrt(r * r * r);
}

// ---------------------------------------------------------------------------
// Photon physics
// ---------------------------------------------------------------------------
// Frequency-shift factor for a photon emitted at r_emit, received at r_recv,
// both observers static. g = sqrt((1 - 2M/r_recv)/(1 - 2M/r_emit)).
export function gravRedshiftFactor(r_emit, r_recv) {
    const f_e = 1 - 2 / r_emit;
    const f_r = 1 - 2 / r_recv;
    if (f_e <= 0 || f_r <= 0) return null;
    return Math.sqrt(f_r / f_e);
}

// Coordinate light-travel time r_emit -> r_recv (radial null geodesic, infall
// path, integrated). Closed form: ∫ dr / (1 - 2M/r) = (r2 - r1) + 2M ln |...|.
export function coordinateLightTime(r1, r2) {
    const f = (r) => r + 2.0 * Math.log(Math.abs(r - 2.0));
    return Math.abs(f(r2) - f(r1));
}

// Proper radial distance from r1 to r2 (r1 < r2, both > 2M):
// L_proper = ∫_{r1}^{r2} dr / sqrt(1 - 2M/r). Numeric quadrature; handles
// near-horizon mildly singular endpoint.
export function properRadialDistance(r1, r2) {
    if (r1 < 2.001) r1 = 2.001;
    if (r2 <= r1) return 0;
    const N = 96;
    const h = (r2 - r1) / N;
    let s = 0;
    for (let i = 0; i <= N; ++i) {
        const r = r1 + h * i;
        const f = 1 - 2 / r;
        const w = (i === 0 || i === N) ? 1 : (i % 2 === 0 ? 2 : 4);
        s += w / Math.sqrt(f);
    }
    return s * h / 3.0; // composite Simpson's
}

// ---------------------------------------------------------------------------
// Free-fall observer from rest at infinity (Painlevé-Gullstrand).
// ---------------------------------------------------------------------------
// Local infall speed seen by a static observer: v_PG/c = sqrt(2M/r).
export function freefallLocalSpeed(r) {
    return Math.sqrt(2.0 / r);
}

// Lorentz factor of PG observer relative to static observer at same r.
// gamma_PG = 1/sqrt(1 - v^2) = 1/sqrt(1 - 2M/r) — same as static lapse, because
// the PG observer rides through the static frame at exactly the escape speed.
export function freefallGamma(r) {
    return lapse(r);
}

// ---------------------------------------------------------------------------
// Hawking temperature for the host black hole (TON 618 mass).
// ---------------------------------------------------------------------------
// Constant — depends only on M, not on the camera position.
export function hawkingTemperatureK() {
    return (HBAR * Math.pow(C_SI, 3)) / (8.0 * Math.PI * G_SI * M_KG * KBOLTZ);
}

// ---------------------------------------------------------------------------
// Convenience: bundle everything for the HUD at a given observer state.
// ---------------------------------------------------------------------------
export function diagnostics(cam) {
    const r = cam.r;
    const f = Math.max(1 - 2 / r, 0);
    const td = lapse(r);
    const tidal = tidalAcceleration(r);
    const v_orb = circularLocalVelocity(r);
    const period_geom = orbitalPeriod(r);

    // Convert orbital period to seconds: time unit T = M_geom / c = M_meters / c.
    const T_sec_per_M = M_METERS / C_SI;
    const period_seconds = period_geom * T_sec_per_M;
    const period_years = period_seconds / (3600 * 24 * 365.25);

    // Convert tidal accel: 1/M^2 in geometric -> SI via c^4 / (G M)^2
    const tidal_SI_factor = Math.pow(C_SI, 4) / (G_SI * M_KG) / (G_SI * M_KG); // 1/(time^2 * length) in SI form
    // Easier: a_geom is dimensionless per-length-per-length in M units; convert directly:
    //   a_SI [1/s^2] = a_geom * c^2 / M_meters^2 * M_meters = a_geom * c^2 / M_meters.
    // Actually tidal "Δa/L" has units 1/time^2; geometric form is per-M^2 in length.
    //   (Δa/L)_SI = (Δa/L)_geom * c^2 / M_meters^2.
    const tidal_per_s2 = tidal.radial * (C_SI * C_SI) / (M_METERS * M_METERS);

    // Static proper acceleration in SI (m/s^2):
    //   a_SI = a_geom * c^2 / M_meters.
    const a_SI = staticProperAcceleration(r) * (C_SI * C_SI) / M_METERS;

    // Proper distance to horizon (geometric, in M).
    const d_proper_to_horizon = (r > 2.001) ? properRadialDistance(2.001, r) : 0;
    // Coordinate light travel time from horizon to here (geometric M units → seconds).
    const t_light_geom = coordinateLightTime(2.001, r);
    const t_light_seconds = t_light_geom * T_sec_per_M;

    return {
        // fundamentals
        r_M:           r,
        r_rs:          r / 2.0,
        f,                                         // metric coefficient 1 - 2M/r
        valid_static:  r > 2.0,

        // observer kinematics
        gamma_static:  td,                          // static-observer time dilation
        a_static_geom: staticProperAcceleration(r),
        a_static_SI:   a_SI,

        // free-fall observer
        v_freefall:        freefallLocalSpeed(r),     // c units
        gamma_freefall:    freefallGamma(r),

        // circular orbit (prograde Keplerian)
        v_orbital:     v_orb,                         // c units
        gamma_orbit:   orbitalGamma(r),
        omega_orbit:   keplerOmega(r),
        period_orbit_geom:    period_geom,
        period_orbit_seconds: period_seconds,
        period_orbit_years:   period_years,

        // tides
        tidal_radial_geom:     tidal.radial,
        tidal_tangential_geom: tidal.tangential,
        tidal_radial_per_s2:   tidal_per_s2,

        // distances & travel times
        proper_distance_to_horizon_geom: d_proper_to_horizon,
        light_time_to_horizon_seconds:   t_light_seconds,

        // landmark radii (constants, returned for HUD)
        r_horizon:     R_HORIZON_GEOM,
        r_photon:      R_PHOTON_SPHERE,
        r_isco:        R_ISCO_GEOM,
        b_crit:        B_CRIT_GEOM,

        // global thermodynamics
        T_hawking_K:   hawkingTemperatureK(),
    };
}
