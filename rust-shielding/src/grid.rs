//! Spherical finite-volume grid for the ionospheric potential solve.
//!
//! Cell-centered, magnetic latitude × MLT:
//!   * NLAT = 100 latitude cells, 0.5° each, spanning MLAT 40°–90°.
//!     i = 0 is the EQUATORWARD row (center 40.25°), i = 99 the poleward
//!     row (center 89.75°). The poleward face of row 99 sits exactly at
//!     the pole where sin(colat) = 0 — its flux vanishes identically, so
//!     the pole closure is automatic in the FV form (no special casing).
//!   * NMLT = 96 azimuthal cells, 0.25 h MLT each, periodic. φ = 0 at
//!     midnight (00 MLT), π/2 at dawn (06), π at noon (12), 3π/2 at dusk.
//!   * Equatorward boundary (MLAT 40°): Dirichlet, Φ = boundary array
//!     (all zeros in production — standard IE practice; the analytic test
//!     sets it to the closed-form solution).
//!
//! All angles are stored in radians; colatitude t = π/2 − λ.

pub const NLAT: usize = 100;
pub const NMLT: usize = 96;
pub const N: usize = NLAT * NMLT;

pub const LAT_MIN_DEG: f64 = 40.0;
pub const DLAT_DEG: f64 = 0.5;
pub const DMLT_HRS: f64 = 24.0 / NMLT as f64;

/// Ionospheric shell radius: R_E + 110 km (E-region current layer).
pub const R_ION_M: f64 = 6.371e6 + 110.0e3;

/// Dipole equatorial surface field (T) — sets |B| for E×B drifts.
pub const B_EQ_T: f64 = 3.12e-5;

#[inline]
pub fn idx(i: usize, j: usize) -> usize {
    i * NMLT + j
}

#[derive(Clone)]
pub struct Grid {
    /// Cell-center colatitude t_i (rad), decreasing with i.
    pub colat: [f64; NLAT],
    /// Cell-center magnetic latitude λ_i (rad), increasing with i.
    pub lat: [f64; NLAT],
    /// sin(t) at cell centers.
    pub sin_colat: [f64; NLAT],
    /// sin(t) at the poleward face of cell i (face between i and i+1;
    /// for i = NLAT−1 this is the pole, sin = 0).
    pub sin_face_pole: [f64; NLAT],
    /// sin(t) at the equatorward face of cell i (face between i−1 and i;
    /// for i = 0 this is the Dirichlet boundary at MLAT 40°).
    pub sin_face_eq: [f64; NLAT],
    /// Azimuth of cell center j (rad, 0 = midnight, π = noon).
    pub phi: [f64; NMLT],
    /// MLT of cell center j (hours).
    pub mlt: [f64; NMLT],
    /// Dipole dip-angle factor sin(I) per latitude row.
    pub sin_dip: [f64; NLAT],
    /// Dipole |B| (T) per latitude row.
    pub b_mag: [f64; NLAT],
    /// Cell area (m²) per latitude row: R² sin(t) Δt Δφ.
    pub area: [f64; NLAT],
    /// Δt = Δλ (rad), Δφ (rad).
    pub dt: f64,
    pub dphi: f64,
}

impl Grid {
    pub fn new() -> Self {
        let dt = DLAT_DEG.to_radians();
        let dphi = std::f64::consts::TAU / NMLT as f64;
        let mut g = Grid {
            colat: [0.0; NLAT],
            lat: [0.0; NLAT],
            sin_colat: [0.0; NLAT],
            sin_face_pole: [0.0; NLAT],
            sin_face_eq: [0.0; NLAT],
            phi: [0.0; NMLT],
            mlt: [0.0; NMLT],
            sin_dip: [0.0; NLAT],
            b_mag: [0.0; NLAT],
            area: [0.0; NLAT],
            dt,
            dphi,
        };
        for i in 0..NLAT {
            let lat_deg = LAT_MIN_DEG + DLAT_DEG * (i as f64 + 0.5);
            let lat = lat_deg.to_radians();
            let t = std::f64::consts::FRAC_PI_2 - lat;
            g.lat[i] = lat;
            g.colat[i] = t;
            g.sin_colat[i] = t.sin();
            g.sin_face_pole[i] = (t - dt * 0.5).sin();
            g.sin_face_eq[i] = (t + dt * 0.5).sin();
            let s = lat.sin();
            let denom = (1.0 + 3.0 * s * s).sqrt();
            g.sin_dip[i] = 2.0 * s / denom;
            g.b_mag[i] = B_EQ_T * denom;
            g.area[i] = R_ION_M * R_ION_M * t.sin() * dt * dphi;
        }
        // The pole face of the top row sits at colat 0 by construction;
        // pin it against rounding so the closure is exact.
        g.sin_face_pole[NLAT - 1] = 0.0;
        for j in 0..NMLT {
            let mlt = DMLT_HRS * (j as f64 + 0.5);
            g.mlt[j] = mlt;
            g.phi[j] = mlt / 24.0 * std::f64::consts::TAU;
        }
        g
    }

    /// Latitude (deg) of row i's center.
    pub fn lat_deg(&self, i: usize) -> f64 {
        LAT_MIN_DEG + DLAT_DEG * (i as f64 + 0.5)
    }

    /// Column index nearest an MLT hour.
    pub fn col_at_mlt(&self, mlt: f64) -> usize {
        let j = (mlt / DMLT_HRS - 0.5).round() as i64;
        j.rem_euclid(NMLT as i64) as usize
    }
}

impl Default for Grid {
    fn default() -> Self {
        Self::new()
    }
}
