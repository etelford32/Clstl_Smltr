//! S-Star Orbital Engine — Galactic Center S-star propagator (WASM)
//!
//! Computes 3D positions and velocities of S-stars orbiting Sgr A*
//! using Keplerian orbital mechanics with first-order post-Newtonian
//! (1PN) corrections:
//!
//!   - Schwarzschild orbital precession (apsidal advance)
//!     S2: ~12 arcmin/orbit — confirmed by GRAVITY (2020)
//!   - Gravitational redshift contribution to radial velocity
//!     S2 at periapsis: ~100 km/s — confirmed by GRAVITY (2018)
//!
//! Orbital elements:
//!   S2:  GRAVITY Collaboration (2020, A&A 636, L5)
//!   S1, S12, S14: Gillessen et al. (2017, ApJ 837, 30)
//!
//! Output coordinate frame (astrometric):
//!   x → East on sky  (increasing RA direction)
//!   y → North on sky (increasing Dec direction)
//!   z → away from observer (line-of-sight depth)
//!   Positions: AU relative to Sgr A*
//!   Velocities: km/s

use std::f64::consts::PI;
use wasm_bindgen::prelude::*;
use serde::Serialize;

// ═══════════════════════════════════════════════════════════════════
// Physical Constants
// ═══════════════════════════════════════════════════════════════════

const TWOPI: f64 = 2.0 * PI;
const DEG2RAD: f64 = PI / 180.0;

/// Sgr A* mass [M☉] — GRAVITY Collaboration (2022)
const _M_SGRA: f64 = 4.154e6;

/// Distance to Sgr A* [pc] — used to convert arcsec → AU
const _D_SGRA_PC: f64 = 8178.0;

/// GM/c² for Sgr A* [AU]
/// = G × 4.154×10⁶ M☉ / c²
/// = 6.674e-11 × 8.262e36 / (2.998e8)² / 1.496e11
/// ≈ 0.04100 AU  (Schwarzschild radius = 2 × this)
const GM_C2_AU: f64 = 0.04100;

/// 1 AU in km — IAU 2012 exact definition
const AU_KM: f64 = 1.495_978_707e8;

/// 1 Julian year in seconds (365.25 days)
const YR_S: f64 = 365.25 * 86400.0;

/// AU/yr → km/s  (≈ 4.74047)
const AU_YR_KMS: f64 = AU_KM / YR_S;

/// Speed of light [km/s]
const C_KMS: f64 = 299_792.458;

/// Julian Date of J2000.0 epoch
const J2000: f64 = 2_451_545.0;

/// Days per Julian year
const DAYS_PER_YR: f64 = 365.25;

// ═══════════════════════════════════════════════════════════════════
// S-Star Catalog
// ═══════════════════════════════════════════════════════════════════

/// Keplerian orbital elements for an S-star orbiting Sgr A*.
struct SStar {
    name: &'static str,
    spectral: &'static str,
    mass_msun: f64,     // Stellar mass [M☉]
    a_arcsec: f64,      // Semi-major axis [arcsec on sky]
    a_au: f64,          // Semi-major axis [AU] (= a_arcsec × D_pc)
    e: f64,             // Eccentricity
    i_deg: f64,         // Inclination [deg] (>90° = retrograde)
    omega_deg: f64,     // Ω — longitude of ascending node [deg]
    w_deg: f64,         // ω — argument of periapsis [deg]
    t_peri: f64,        // Periapsis epoch [decimal year]
    period: f64,        // Orbital period [yr]
}

const NUM_STARS: usize = 8;

/// Published orbital elements for the eight tracked S-stars.
///
/// Semi-major axes converted: a_au = a_arcsec × 8178 pc
const CATALOG: [SStar; NUM_STARS] = [
    // ── S2 (S0-2) ────────────────────────────────────────────
    // The "Rosetta stone" of galactic center physics.
    // 16-year orbit, confirmed Schwarzschild precession in 2020.
    // Periapsis: 118 AU from Sgr A*, speed 7,650 km/s (2.55% c).
    // Source: GRAVITY Collaboration (2020, A&A 636, L5)
    SStar {
        name: "S2", spectral: "B0-2.5V", mass_msun: 14.0,
        a_arcsec: 0.12540, a_au: 1025.5,
        e: 0.88466, i_deg: 134.18, omega_deg: 228.17, w_deg: 66.25,
        t_peri: 2018.379, period: 16.046,
    },
    // ── S1 ────────────────────────────────────────────────────
    // Wide orbit, well-characterized from 30 years of observations.
    // Source: Gillessen et al. (2017, ApJ 837, 30)
    SStar {
        name: "S1", spectral: "B2-3V", mass_msun: 10.0,
        a_arcsec: 0.508, a_au: 4154.4,
        e: 0.556, i_deg: 119.14, omega_deg: 342.04, w_deg: 122.30,
        t_peri: 2001.8, period: 94.1,
    },
    // ── S12 ───────────────────────────────────────────────────
    // Evolved K/M giant on a moderately eccentric orbit.
    // Source: Gillessen et al. (2017, ApJ 837, 30)
    SStar {
        name: "S12", spectral: "K/M III", mass_msun: 4.0,
        a_arcsec: 0.286, a_au: 2338.9,
        e: 0.888, i_deg: 33.56, omega_deg: 230.10, w_deg: 317.90,
        t_peri: 1995.59, period: 58.9,
    },
    // ── S14 ───────────────────────────────────────────────────
    // Extreme eccentricity (0.976) — deepest periapsis dive
    // of the four, reaching only 44 AU from Sgr A* at ~13,100 km/s.
    // Source: Gillessen et al. (2017, ApJ 837, 30)
    SStar {
        name: "S14", spectral: "B9V", mass_msun: 6.0,
        a_arcsec: 0.225, a_au: 1840.1,
        e: 0.9761, i_deg: 100.59, omega_deg: 226.38, w_deg: 334.59,
        t_peri: 2000.12, period: 38.0,
    },
    // ── S29 ───────────────────────────────────────────────────
    // Tracked through its 2021 periapsis by GRAVITY+ — among the
    // tightest "fast" passages: ~13 AU at periapsis. Wide orbit
    // (~90 yr period) makes it a long-baseline GR target.
    // Source: GRAVITY Collaboration (2022, A&A 657, A82); Habibi+ (2017)
    SStar {
        name: "S29", spectral: "B-MS", mass_msun: 12.0,
        a_arcsec: 0.397, a_au: 3247.1,
        e: 0.728, i_deg: 91.8, omega_deg: 158.4, w_deg: 350.2,
        t_peri: 2025.96, period: 124.0,
    },
    // ── S38 ───────────────────────────────────────────────────
    // Hot B-type S-star with high eccentricity, retrograde orbit.
    // Source: Boehle et al. (2016) / Gillessen et al. (2017)
    SStar {
        name: "S38", spectral: "B0V", mass_msun: 7.0,
        a_arcsec: 0.139, a_au: 1136.7,
        e: 0.81, i_deg: 171.0, omega_deg: 100.4, w_deg: 17.99,
        t_peri: 2003.15, period: 19.2,
    },
    // ── S55 (S0-102) ──────────────────────────────────────────
    // The "second S2" — UCLA's discovery of a 12.8-yr orbiter
    // that briefly held the shortest known S-star period.
    // Source: Meyer et al. (2012, Science 338, 84); Gillessen+ 2017
    SStar {
        name: "S55", spectral: "B-MS", mass_msun: 7.0,
        a_arcsec: 0.105, a_au: 858.7,
        e: 0.7209, i_deg: 92.6, omega_deg: 197.1, w_deg: 311.0,
        t_peri: 2009.34, period: 12.8,
    },
    // ── S62 ───────────────────────────────────────────────────
    // Closest periapsis claimed in the S-star census (~16 AU at
    // 8.7% c). Discovery is debated — some authors argue the data
    // are blended with S29's track. Visualised here on Peißker+
    // 2020 elements as a "tracked candidate."
    // Source: Peißker et al. (2020, ApJ 899, 50)
    SStar {
        name: "S62", spectral: "B-MS", mass_msun: 6.0,
        a_arcsec: 0.0905, a_au: 740.1,
        e: 0.976, i_deg: 72.8, omega_deg: 120.7, w_deg: 42.6,
        t_peri: 2003.33, period: 9.9,
    },
];

// ═══════════════════════════════════════════════════════════════════
// Kepler Equation Solver
// ═══════════════════════════════════════════════════════════════════

/// Solve Kepler's equation  M = E − e sin E  for eccentric anomaly E.
///
/// Newton-Raphson with up to 30 iterations.  Convergence is quadratic;
/// even for e = 0.976 (S14) this converges in ≤ 8 iterations to
/// machine precision (1e-15 rad ≈ 3 × 10⁻¹⁰ arcsec).
fn solve_kepler(mean_anom: f64, ecc: f64) -> f64 {
    let m = ((mean_anom % TWOPI) + TWOPI) % TWOPI;

    // First-order starter: E₀ ≈ M + e sin M
    let mut ea = m + ecc * m.sin();

    for _ in 0..30 {
        let (se, ce) = ea.sin_cos();
        let f = ea - ecc * se - m;
        let fp = 1.0 - ecc * ce;
        let delta = f / fp;
        ea -= delta;
        if delta.abs() < 1e-15 {
            break;
        }
    }
    ea
}

// ═══════════════════════════════════════════════════════════════════
// Orbital Propagation
// ═══════════════════════════════════════════════════════════════════

/// Propagate an S-star to the given Julian Date.
///
/// Returns `[x, y, z, vx, vy, vz, r, v_radial_obs]`:
///
/// | Field          | Unit  | Description                                |
/// |----------------|-------|--------------------------------------------|
/// | x, y, z        | AU    | Position relative to Sgr A*                |
/// | vx, vy, vz     | km/s  | Velocity (kinematic only)                  |
/// | r              | AU    | Distance from Sgr A*                       |
/// | v_radial_obs   | km/s  | Observed RV (Doppler + grav. redshift)     |
fn propagate_to_jd(star: &SStar, jd: f64) -> [f64; 8] {
    let yr = 2000.0 + (jd - J2000) / DAYS_PER_YR;
    let dt = yr - star.t_peri;
    let n = TWOPI / star.period; // mean motion [rad/yr]
    let mean_anom = n * dt;

    // ── 1PN Schwarzschild precession ─────────────────────────
    //   Δω/orbit = 6π GM / (c² a (1 − e²))
    // Accumulated linearly over fractional orbits.
    let one_minus_e2 = 1.0 - star.e * star.e;
    let dw_per_orbit = 6.0 * PI * GM_C2_AU / (star.a_au * one_minus_e2);
    let n_orbits = dt / star.period;
    let w_eff = star.w_deg * DEG2RAD + dw_per_orbit * n_orbits;

    // ── Solve Kepler's equation ──────────────────────────────
    let ea = solve_kepler(mean_anom, star.e);
    let ce = ea.cos();

    // True anomaly via half-angle formula (numerically stable)
    let nu = 2.0
        * ((1.0 + star.e).sqrt() * (ea * 0.5).sin())
            .atan2((1.0 - star.e).sqrt() * (ea * 0.5).cos());
    let (snu, cnu) = nu.sin_cos();

    // Radius [AU]
    let r = star.a_au * (1.0 - star.e * ce);

    // ── Orbital-plane coordinates ────────────────────────────
    // X-axis → periapsis direction, Y-axis → 90° prograde
    let x_orb = r * cnu;
    let y_orb = r * snu;

    // Velocity in orbital plane [AU/yr]
    //   vX = −(na / √(1−e²)) sin ν
    //   vY =  (na / √(1−e²)) (e + cos ν)
    let v_coeff = n * star.a_au / one_minus_e2.sqrt();
    let vx_orb = -v_coeff * snu;
    let vy_orb = v_coeff * (star.e + cnu);

    // ── Thiele-Innes rotation (orbital plane → sky frame) ────
    // Uses effective ω (with accumulated GR precession)
    let (sw, cw) = w_eff.sin_cos();
    let (so, co) = (star.omega_deg * DEG2RAD).sin_cos();
    let (si, ci) = (star.i_deg * DEG2RAD).sin_cos();

    // Thiele-Innes constants:
    //   A = cos Ω cos ω − sin Ω sin ω cos i     (P matrix row 1)
    //   B = sin Ω cos ω + cos Ω sin ω cos i     (P matrix row 2)
    //   C = sin ω sin i                          (P matrix row 3)
    //   F = −cos Ω sin ω − sin Ω cos ω cos i    (Q matrix row 1)
    //   G = −sin Ω sin ω + cos Ω cos ω cos i    (Q matrix row 2)
    //   H = cos ω sin i                          (Q matrix row 3)
    let a_ti = co * cw - so * sw * ci;
    let b_ti = so * cw + co * sw * ci;
    let c_ti = sw * si;
    let f_ti = -co * sw - so * cw * ci;
    let g_ti = -so * sw + co * cw * ci;
    let h_ti = cw * si;

    // 3D position [AU]
    let x = a_ti * x_orb + f_ti * y_orb;
    let y = b_ti * x_orb + g_ti * y_orb;
    let z = c_ti * x_orb + h_ti * y_orb;

    // 3D velocity [km/s]
    let vx = (a_ti * vx_orb + f_ti * vy_orb) * AU_YR_KMS;
    let vy = (b_ti * vx_orb + g_ti * vy_orb) * AU_YR_KMS;
    let vz = (c_ti * vx_orb + h_ti * vy_orb) * AU_YR_KMS;

    // ── Gravitational redshift ───────────────────────────────
    // z_grav = GM / (c² r)  →  Δv = c × z_grav
    // For S2 at periapsis (r ≈ 118 AU): Δv ≈ 104 km/s
    let v_grav = C_KMS * GM_C2_AU / r;

    // Total observed radial velocity: kinematic + gravitational
    // (positive = receding / redshifted)
    let v_radial_obs = vz + v_grav;

    [x, y, z, vx, vy, vz, r, v_radial_obs]
}

// ═══════════════════════════════════════════════════════════════════
// WASM Exports
// ═══════════════════════════════════════════════════════════════════

/// Number of S-stars in the catalog.
#[wasm_bindgen]
pub fn get_star_count() -> u32 {
    NUM_STARS as u32
}

/// Name of the S-star at the given index (0 = S2, 1 = S1, ...).
#[wasm_bindgen]
pub fn get_star_name(star_id: u32) -> Result<String, JsValue> {
    CATALOG
        .get(star_id as usize)
        .map(|s| s.name.to_string())
        .ok_or_else(|| JsValue::from_str("Invalid star_id"))
}

/// Full orbital elements and derived quantities for the given star.
///
/// Returns a JS object with fields:
///   name, spectral_type, mass_msun, a_arcsec, a_au, eccentricity,
///   inclination_deg, omega_deg, w_deg, t_periapsis, period_yr,
///   periapsis_au, apoapsis_au, v_periapsis_kms,
///   precession_arcmin_per_orbit
#[wasm_bindgen]
pub fn get_orbital_elements(star_id: u32) -> Result<JsValue, JsValue> {
    let s = CATALOG
        .get(star_id as usize)
        .ok_or_else(|| JsValue::from_str("Invalid star_id"))?;

    let n = TWOPI / s.period;
    let one_minus_e2 = 1.0 - s.e * s.e;
    let v_peri = n * s.a_au * (1.0 + s.e) / one_minus_e2.sqrt() * AU_YR_KMS;
    let dw = 6.0 * PI * GM_C2_AU / (s.a_au * one_minus_e2);

    #[derive(Serialize)]
    struct Elements {
        name: String,
        spectral_type: String,
        mass_msun: f64,
        a_arcsec: f64,
        a_au: f64,
        eccentricity: f64,
        inclination_deg: f64,
        omega_deg: f64,
        w_deg: f64,
        t_periapsis: f64,
        period_yr: f64,
        periapsis_au: f64,
        apoapsis_au: f64,
        v_periapsis_kms: f64,
        precession_arcmin_per_orbit: f64,
    }

    let el = Elements {
        name: s.name.to_string(),
        spectral_type: s.spectral.to_string(),
        mass_msun: s.mass_msun,
        a_arcsec: s.a_arcsec,
        a_au: s.a_au,
        eccentricity: s.e,
        inclination_deg: s.i_deg,
        omega_deg: s.omega_deg,
        w_deg: s.w_deg,
        t_periapsis: s.t_peri,
        period_yr: s.period,
        periapsis_au: s.a_au * (1.0 - s.e),
        apoapsis_au: s.a_au * (1.0 + s.e),
        v_periapsis_kms: v_peri,
        precession_arcmin_per_orbit: dw.to_degrees() * 60.0,
    };

    serde_wasm_bindgen::to_value(&el).map_err(|e| JsValue::from_str(&e.to_string()))
}

/// Propagate a single S-star to a Julian Date.
///
/// Returns `[x, y, z, vx, vy, vz, r, v_radial_obs]` — see
/// [`propagate_to_jd`] for field descriptions.
#[wasm_bindgen]
pub fn propagate_sstar(star_id: u32, jd: f64) -> Result<Vec<f64>, JsValue> {
    let star = CATALOG
        .get(star_id as usize)
        .ok_or_else(|| JsValue::from_str("Invalid star_id"))?;
    Ok(propagate_to_jd(star, jd).to_vec())
}

/// Propagate ALL S-stars to a Julian Date in one call.
///
/// Returns flat array `[x₀,y₀,z₀,vx₀,vy₀,vz₀,r₀,vr₀, x₁,y₁,...]`
/// with 8 values per star × NUM_STARS stars = 8·NUM_STARS f64s total.
/// Efficient for animation loops (single WASM call per frame).
#[wasm_bindgen]
pub fn propagate_all(jd: f64) -> Vec<f64> {
    let mut out = Vec::with_capacity(NUM_STARS * 8);
    for star in &CATALOG {
        out.extend_from_slice(&propagate_to_jd(star, jd));
    }
    out
}

/// Generate an orbital path for one star over a Julian Date range.
///
/// Returns flat array of `[x,y,z,vx,vy,vz,r,vr]` × `n_points`.
/// Useful for drawing orbital ellipses or time-series charts.
#[wasm_bindgen]
pub fn propagate_orbit_path(
    star_id: u32,
    jd_start: f64,
    jd_end: f64,
    n_points: u32,
) -> Result<Vec<f64>, JsValue> {
    let star = CATALOG
        .get(star_id as usize)
        .ok_or_else(|| JsValue::from_str("Invalid star_id"))?;

    let n = n_points.max(2) as usize;
    let step = (jd_end - jd_start) / (n - 1) as f64;

    let mut out = Vec::with_capacity(n * 8);
    for i in 0..n {
        let jd = jd_start + step * i as f64;
        out.extend_from_slice(&propagate_to_jd(star, jd));
    }
    Ok(out)
}

/// Compute the next periapsis passage (Julian Date) after `after_jd`.
///
/// For S2, from 2026: returns JD of ~2034.4 (next close approach).
#[wasm_bindgen]
pub fn next_periapsis_jd(star_id: u32, after_jd: f64) -> Result<f64, JsValue> {
    let star = CATALOG
        .get(star_id as usize)
        .ok_or_else(|| JsValue::from_str("Invalid star_id"))?;

    let yr = 2000.0 + (after_jd - J2000) / DAYS_PER_YR;
    let dt = yr - star.t_peri;
    // Number of complete orbits, rounded up to get the *next* one
    let n_next = if dt <= 0.0 { 0.0 } else { (dt / star.period).ceil() };
    let next_yr = star.t_peri + n_next * star.period;
    Ok(J2000 + (next_yr - 2000.0) * DAYS_PER_YR)
}
