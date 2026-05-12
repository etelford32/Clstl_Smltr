//! Astronomical anchors used by the diurnal predictor.
//!
//! The diurnal harmonic must be locked to true solar time — not to the wall
//! clock — or it drifts by an hour twice a year (DST) and by up to 4° of
//! longitude inside a single timezone. Cheap NOAA solar-position formulas
//! suffice for forecast anchoring (we don't need arcsec accuracy).
//!
//! Reference: Solar Position Algorithm, NREL/TP-560-34302 (Reda & Andreas,
//! 2008), simplified to the "astronomer-grade" closed form on
//! https://gml.noaa.gov/grad/solcalc/.

use std::f64::consts::PI;

const DEG2RAD: f64 = PI / 180.0;
const RAD2DEG: f64 = 180.0 / PI;

/// Sun altitude angle [deg] above the local horizon for the given location
/// at the given UTC unix-epoch time.
///
/// Negative = below horizon (night). +90 = sun overhead.
pub fn sun_altitude_deg(lat_deg: f64, lon_deg: f64, t_unix: f64) -> f64 {
    let (decl_deg, eot_min) = solar_geometry(t_unix);

    // Local solar time in minutes since solar midnight.
    // tst = utc_minutes + 4 * lon + eot
    let utc_minutes = ((t_unix.rem_euclid(86400.0)) / 60.0).rem_euclid(1440.0);
    let tst         = utc_minutes + 4.0 * lon_deg + eot_min;
    // Hour angle: 0° at solar noon, ±15°/h.
    let ha_deg = (tst / 4.0) - 180.0;

    let lat_r  = lat_deg  * DEG2RAD;
    let decl_r = decl_deg * DEG2RAD;
    let ha_r   = ha_deg   * DEG2RAD;

    let sin_alt = lat_r.sin() * decl_r.sin()
                + lat_r.cos() * decl_r.cos() * ha_r.cos();
    sin_alt.asin() * RAD2DEG
}

/// Returns (declination_deg, equation_of_time_minutes) at the given UTC time.
///
/// Closed-form expansion good to ~1 arcmin / 1 min over decades — plenty for
/// a 24-hour forecast anchor.
pub fn solar_geometry(t_unix: f64) -> (f64, f64) {
    // Julian day fraction since J2000.0 (2000-01-01 12:00 UTC).
    let jd       = t_unix / 86400.0 + 2440587.5;
    let n        = jd - 2451545.0;
    let g_deg    = (357.528 + 0.985_600_28 * n).rem_euclid(360.0);   // mean anomaly
    let l_deg    = (280.460 + 0.985_647_4  * n).rem_euclid(360.0);   // mean longitude
    let g        = g_deg * DEG2RAD;
    let lambda   = (l_deg + 1.915 * g.sin() + 0.020 * (2.0 * g).sin()).rem_euclid(360.0);
    let lambda_r = lambda * DEG2RAD;
    let eps      = (23.439 - 0.000_000_4 * n) * DEG2RAD;             // obliquity

    let decl_r   = (eps.sin() * lambda_r.sin()).asin();
    let decl_deg = decl_r * RAD2DEG;

    // Equation of time, minutes (NOAA "approximate" form).
    let y = (eps / 2.0).tan().powi(2);
    let l = l_deg * DEG2RAD;
    let eot_rad =
          y * (2.0 * l).sin()
        - 2.0 * 0.0167 * g.sin()
        + 4.0 * 0.0167 * y * g.sin() * (2.0 * l).cos()
        - 0.5 * y * y * (4.0 * l).sin()
        - 1.25 * 0.0167 * 0.0167 * (2.0 * g).sin();
    let eot_min = 4.0 * eot_rad * RAD2DEG;

    (decl_deg, eot_min)
}

/// Diurnal phase φ ∈ [0, 2π) — 0 at solar midnight, π at solar noon.
/// Used as the input to harmonic basis functions in `members::diurnal`.
pub fn diurnal_phase(_lat_deg: f64, lon_deg: f64, t_unix: f64) -> f64 {
    // Reuse the eot computed inside sun_altitude_deg via the same formula.
    let (_decl, eot_min) = solar_geometry(t_unix);
    let utc_minutes = ((t_unix.rem_euclid(86400.0)) / 60.0).rem_euclid(1440.0);
    let tst         = utc_minutes + 4.0 * lon_deg + eot_min;
    let frac        = (tst / 1440.0).rem_euclid(1.0);
    frac * 2.0 * PI
}
