// Unit conversions for the TON 618 observatory.
//
// Internal code runs in geometrized units: G = c = M = 1. One unit of length
// is M (the mass in geometric units). The horizon is at r = 2 (M). Users see
// SI-ish labels (r_s, AU, light-hours, light-years) in the HUD.

export const TON618_MASS_SOLAR = 6.6e10;   // best-estimate central mass (M_sun)
export const G_SI              = 6.67430e-11;    // m^3 kg^-1 s^-2
export const C_SI              = 2.99792458e8;   // m / s
export const M_SUN_KG          = 1.98892e30;     // kg
export const AU_M              = 1.495978707e11; // m
export const LIGHT_HOUR_M      = C_SI * 3600;
export const LIGHT_YEAR_M      = C_SI * 3600 * 24 * 365.25;

// Schwarzschild radius in meters for TON 618.
export const R_S_METERS = 2 * G_SI * TON618_MASS_SOLAR * M_SUN_KG / (C_SI * C_SI);

// Geometric mass unit M in meters = r_s / 2.
export const M_METERS = R_S_METERS / 2;

// Convert a length in geometric units (r_geom, i.e. multiples of M) to human scales.
export function formatLength(r_geom) {
    const meters = r_geom * M_METERS;
    const rs     = r_geom / 2;              // r in units of r_s
    const au     = meters / AU_M;
    const lh     = meters / LIGHT_HOUR_M;
    const ly     = meters / LIGHT_YEAR_M;
    return { rs, au, lh, ly, meters };
}

// Horizon and photon-sphere radii for Schwarzschild (M = 1).
export const R_HORIZON_GEOM    = 2.0;
export const R_PHOTON_SPHERE   = 3.0;
// Apparent photon-ring radius at infinity = b_crit = 3 sqrt(3) M = 5.19615... M
// In r_s units that is 3 sqrt(3) / 2 = 2.5981...
export const B_CRIT_GEOM       = 3 * Math.sqrt(3);
export const PHOTON_RING_RS    = B_CRIT_GEOM / 2;
