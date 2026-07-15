//! Field-aligned current source terms: Region 1 and Region 2 sheets, plus
//! the solar-wind coupling function that drives R1.
//!
//! Both regions are Gaussian sheets in latitude with a sin(φ) azimuthal
//! profile (φ = 0 at midnight): R1 downward at dawn / upward at dusk, R2
//! the mirror image ~6.5° equatorward. Amplitudes are calibrated against
//! the DISCRETE grid integral, so total downward current equals the
//! requested MA exactly and — because Σ_j sin φ_j = 0 on a uniform
//! periodic grid — total upward equals total downward to rounding.
//! Current conservation is by construction, and asserted in tests.
//!
//! Convention: J∥ > 0 means downward (into the ionosphere) = a source of
//! diverging horizontal current.

use crate::grid::{Grid, N, NLAT, NMLT};

pub struct FacParams {
    pub r1_center_deg: f64,
    pub r1_sigma_deg: f64,
    pub r2_center_deg: f64,
    pub r2_sigma_deg: f64,
}

impl Default for FacParams {
    fn default() -> Self {
        FacParams {
            r1_center_deg: 72.0,
            r1_sigma_deg: 1.5,
            r2_center_deg: 65.5,
            r2_sigma_deg: 1.25,
        }
    }
}

/// Kan–Lee merging electric field (mV/m) from IMF and solar wind speed:
/// E_KL = v · B_T · sin²(θ_c/2), θ_c = IMF clock angle.
pub fn kan_lee_mvpm(bz_nt: f64, by_nt: f64, vsw_kms: f64) -> f64 {
    let bt = (bz_nt * bz_nt + by_nt * by_nt).sqrt();
    if bt < 1e-9 {
        return 0.0;
    }
    // sin²(θc/2) = (1 − cos θc)/2, cos θc = Bz/B_T.
    let sin2_half = 0.5 * (1.0 - bz_nt / bt);
    // v[km/s]·1e3 · B[nT]·1e−9 → V/m; ×1e3 → mV/m.
    vsw_kms * bt * sin2_half * 1e-3
}

/// Total Region-1 current (MA, one polarity) from the coupling function.
/// Calibrated so quiet driving (Bz −2 nT, 400 km/s) → ≈1 MA and strong
/// storm driving (Bz −15 nT, 700 km/s) → ≈4.5 MA, saturating near 5 MA
/// (the CPCP-saturation flavor of Boyle/Siscoe).
pub fn r1_current_ma(e_kl_mvpm: f64) -> f64 {
    0.4 + 4.6 * (e_kl_mvpm / 7.0).tanh()
}

/// Gaussian latitude profile × sin(MLT-angle) sheet, normalized so that
/// the discrete integral of the DOWNWARD half over the grid equals
/// `total_ma` mega-amps. `polarity` = +1 for R1 (down at dawn), −1 for R2.
/// Adds into `jpar` (A/m²).
fn add_sheet(
    grid: &Grid,
    center_deg: f64,
    sigma_deg: f64,
    total_ma: f64,
    polarity: f64,
    jpar: &mut [f64],
) {
    if total_ma <= 0.0 {
        return;
    }
    // Discrete normalization: Σ_{cells, downward} g_i · sin φ_j · A_ij.
    let mut down_sum = 0.0;
    let mut g = [0.0f64; NLAT];
    for i in 0..NLAT {
        let d = grid.lat_deg(i) - center_deg;
        g[i] = (-d * d / (2.0 * sigma_deg * sigma_deg)).exp();
    }
    for i in 0..NLAT {
        for j in 0..NMLT {
            let s = polarity * grid.phi[j].sin();
            if s > 0.0 {
                down_sum += g[i] * s * grid.area[i];
            }
        }
    }
    if down_sum <= 0.0 {
        return;
    }
    let amp = total_ma * 1e6 / down_sum;
    for i in 0..NLAT {
        for j in 0..NMLT {
            jpar[i * NMLT + j] += amp * g[i] * polarity * grid.phi[j].sin();
        }
    }
}

/// Rebuild the J∥ field (A/m²) from current R1/R2 amplitudes.
/// `lat_shift_deg` co-moves the sheets with the oval (compression proxy).
pub fn rebuild_jpar(
    grid: &Grid,
    p: &FacParams,
    i_r1_ma: f64,
    i_r2_ma: f64,
    lat_shift_deg: f64,
    jpar: &mut [f64],
) {
    debug_assert_eq!(jpar.len(), N);
    jpar.fill(0.0);
    add_sheet(grid, p.r1_center_deg + lat_shift_deg, p.r1_sigma_deg, i_r1_ma, 1.0, jpar);
    add_sheet(grid, p.r2_center_deg + lat_shift_deg, p.r2_sigma_deg, i_r2_ma, -1.0, jpar);
}

/// Net FAC (A) over the grid — should be ~0 by construction.
pub fn net_current_a(grid: &Grid, jpar: &[f64]) -> f64 {
    let mut sum = 0.0;
    for i in 0..NLAT {
        for j in 0..NMLT {
            sum += jpar[i * NMLT + j] * grid.area[i];
        }
    }
    sum
}

/// Total downward FAC (A).
pub fn downward_current_a(grid: &Grid, jpar: &[f64]) -> f64 {
    let mut sum = 0.0;
    for i in 0..NLAT {
        for j in 0..NMLT {
            let v = jpar[i * NMLT + j];
            if v > 0.0 {
                sum += v * grid.area[i];
            }
        }
    }
    sum
}
