//! Height-integrated conductance: solar EUV + auroral oval + subauroral
//! trough, with the SAPS conductance-feedback depletion layered on top.
//!
//! Composition convention (per the plan): EUV and auroral contributions add
//! in quadrature; the trough is a multiplicative depletion of the total.
//! The SAPS feedback (state.rs) deepens the trough where |E| exceeds the
//! frictional-heating threshold, floored so it cannot run away.
//!
//! Simplifications (documented on the page): magnetic pole = rotation pole,
//! subsolar point at MLAT 0 / 12 MLT, no season, single hemisphere.

use crate::grid::{Grid, N, NLAT, NMLT};

/// Absolute conductance floor (S) — the plan's ~0.5 S cap on trough
/// depletion. This is what stops the SAPS feedback from running away:
/// however deep the depletion multipliers go, Σ never drops below this.
pub const SIGMA_FLOOR: f64 = 0.5;
/// Diffuse nightside/polar background (S), added in quadrature: polar rain,
/// starlight, scattered EUV. Without it the nightside polar cap is orders
/// too resistive and CPCP runs far above the Boyle et al. climatology.
pub const SIGMA_BG: f64 = 2.0;
/// Floor for the SAPS-feedback depletion multiplier (prevents runaway).
pub const SAPS_DEPLETION_FLOOR: f64 = 0.45;

/// Static model parameters (latitudes in degrees).
pub struct CondParams {
    pub oval_center_deg: f64,
    pub oval_sigma_deg: f64,
    /// MLT hour of peak auroral conductance (pre-midnight).
    pub oval_peak_mlt: f64,
    pub trough_center_deg: f64,
    pub trough_sigma_deg: f64,
    /// Depletion depth d: multiplier dips to (1 − d) at trough center.
    pub trough_depth: f64,
}

impl Default for CondParams {
    fn default() -> Self {
        CondParams {
            oval_center_deg: 69.0,
            oval_sigma_deg: 2.5,
            oval_peak_mlt: 22.5,
            trough_center_deg: 63.0,
            trough_sigma_deg: 1.5,
            trough_depth: 0.60,
        }
    }
}

/// Moen–Brekke (1993) solar-EUV conductances (S) from F10.7 and solar
/// zenith angle χ. Valid for cos χ > 0; callers clamp.
#[inline]
pub fn euv_pedersen(f107: f64, cos_chi: f64) -> f64 {
    f107.powf(0.49) * (0.34 * cos_chi + 0.93 * cos_chi.sqrt())
}

#[inline]
pub fn euv_hall(f107: f64, cos_chi: f64) -> f64 {
    f107.powf(0.53) * (0.81 * cos_chi + 0.54 * cos_chi.sqrt())
}

/// Nightside trough MLT window: 1 inside 19–05 MLT, cosine-tapered over
/// 2 h at each edge, 0 on the dayside.
fn trough_mlt_window(mlt: f64) -> f64 {
    // Hours from midnight, in [−12, 12).
    let h = (mlt + 12.0).rem_euclid(24.0) - 12.0;
    let a = h.abs();
    if a <= 5.0 {
        1.0
    } else if a <= 7.0 {
        0.5 * (1.0 + ((a - 5.0) / 2.0 * std::f64::consts::PI).cos())
    } else {
        0.0
    }
}

/// Rebuild ΣP/ΣH over the grid.
///
/// * `activity_ma` scales the auroral-oval amplitude. Callers pass
///   max(I_R1, I_R2), NOT instantaneous I_R1: precipitation has inertia,
///   and after a northward turning the oval stays bright while R2 decays.
///   Scaling by raw R1 made the overshielding window absurdly resistive
///   (500 kV CPCP artifacts).
/// * `lat_shift_deg` moves oval + trough equatorward together (dynamic-
///   pressure compression proxy from the density control; ≤ 0).
/// * `saps_depletion` is the persistent per-cell feedback multiplier in
///   [SAPS_DEPLETION_FLOOR, 1] maintained by state.rs (all 1s when off).
pub fn rebuild(
    grid: &Grid,
    p: &CondParams,
    f107: f64,
    activity_ma: f64,
    lat_shift_deg: f64,
    saps_depletion: &[f64],
    sigma_p: &mut [f64],
    sigma_h: &mut [f64],
) {
    debug_assert_eq!(saps_depletion.len(), N);
    // Hardy-style oval magnitudes, scaled to the driving level: ~6 S quiet
    // (1 MA) up to ~13–15 S in the active oval (4–5 MA).
    let aur_h_max = (4.0 + 2.2 * activity_ma).min(18.0);
    let aur_p_max = aur_h_max / 1.6;
    let oval_c = p.oval_center_deg + lat_shift_deg;
    let trough_c = p.trough_center_deg + lat_shift_deg;

    for i in 0..NLAT {
        let lat_deg = grid.lat_deg(i);
        let cos_lat = grid.lat[i].cos();
        let g_oval =
            (-((lat_deg - oval_c) * (lat_deg - oval_c)) / (2.0 * p.oval_sigma_deg * p.oval_sigma_deg)).exp();
        let g_trough = (-((lat_deg - trough_c) * (lat_deg - trough_c))
            / (2.0 * p.trough_sigma_deg * p.trough_sigma_deg))
            .exp();
        for j in 0..NMLT {
            let k = i * NMLT + j;
            // Solar zenith angle: cos χ = cos λ · cos(hour angle).
            let hour_angle = (grid.mlt[j] - 12.0) / 24.0 * std::f64::consts::TAU;
            let cos_chi = (cos_lat * hour_angle.cos()).max(0.0);
            let (euv_p, euv_h) = if cos_chi > 0.0 {
                (euv_pedersen(f107, cos_chi), euv_hall(f107, cos_chi))
            } else {
                (0.0, 0.0)
            };
            // Pre-midnight-peaked MLT modulation of the oval.
            let dphi = (grid.mlt[j] - p.oval_peak_mlt) / 24.0 * std::f64::consts::TAU;
            let mlt_mod = 1.0 + 0.45 * dphi.cos();
            let aur_p = aur_p_max * g_oval * mlt_mod;
            let aur_h = aur_h_max * g_oval * mlt_mod;

            // Quadrature composition (EUV ⊕ aurora ⊕ background), then the
            // multiplicative trough/SAPS depletion.
            let trough_f =
                1.0 - p.trough_depth * g_trough * trough_mlt_window(grid.mlt[j]);
            let dep = trough_f * saps_depletion[k];
            let base_p = (euv_p * euv_p + aur_p * aur_p + SIGMA_BG * SIGMA_BG).sqrt();
            let base_h = (euv_h * euv_h + aur_h * aur_h + SIGMA_BG * SIGMA_BG).sqrt();
            sigma_p[k] = (base_p * dep).max(SIGMA_FLOOR);
            sigma_h[k] = (base_h * dep).max(SIGMA_FLOOR);
        }
    }
}

/// True where a cell sits in the (shifted) trough latitude band and night
/// MLT window — the only place SAPS feedback may deepen conductance.
pub fn in_trough_band(grid: &Grid, p: &CondParams, lat_shift_deg: f64, i: usize, j: usize) -> bool {
    let c = p.trough_center_deg + lat_shift_deg;
    let lat = grid.lat_deg(i);
    (lat - c).abs() <= 2.5 * p.trough_sigma_deg && trough_mlt_window(grid.mlt[j]) > 0.05
}
