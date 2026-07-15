//! Derived observables: E = −∇Φ, E×B drifts, CPCP, equatorial-boundary
//! penetration E, and the SAPS latitude profile at 21 MLT.
//!
//! Sign conventions (northern hemisphere, B = −B r̂, i.e. downward):
//!   θ̂ points EQUATORWARD (south), φ̂ points EAST, and (r̂, θ̂, φ̂) is
//!   right-handed, so θ̂×r̂ = −φ̂ and φ̂×r̂ = +θ̂. Then
//!     v = E×B/B²  →  v_φ = +E_θ/B ,  v_θ = −E_φ/B
//!   so a poleward electric field (E_θ < 0) gives WESTWARD flow (the SAPS
//!   signature) and a dayside eastward E gives poleward/upward drift. The
//!   `poleward_e_gives_westward_flow` test pins this.

use crate::grid::{idx, Grid, N, NLAT, NMLT, R_ION_M};

pub struct Fields {
    /// E components (V/m) at cell centers.
    pub e_theta: Vec<f64>,
    pub e_phi: Vec<f64>,
    /// E×B drift (m/s): v_east = v_φ, v_north = −v_θ.
    pub v_east: Vec<f64>,
    pub v_north: Vec<f64>,
}

impl Fields {
    pub fn new() -> Self {
        Fields {
            e_theta: vec![0.0; N],
            e_phi: vec![0.0; N],
            v_east: vec![0.0; N],
            v_north: vec![0.0; N],
        }
    }

    /// Recompute E and v from Φ (volts). Centered differences; one-sided at
    /// the latitude edges (boundary Φ_b is zero in production, so the
    /// equatorward edge uses the half-cell gradient to 0 via `phi_b`).
    pub fn update(&mut self, grid: &Grid, phi: &[f64], phi_b: &[f64; NMLT]) {
        let dt = grid.dt;
        let dphi = grid.dphi;
        for i in 0..NLAT {
            let sc = grid.sin_colat[i];
            let b = grid.b_mag[i];
            for j in 0..NMLT {
                let k = idx(i, j);
                let je = (j + 1) % NMLT;
                let jw = (j + NMLT - 1) % NMLT;
                // ∂Φ/∂t (t = colatitude, increases equatorward → toward i−1).
                let dphidt = if i == 0 {
                    // between boundary (at +0.5Δt) and poleward neighbor.
                    (phi_b[j] - phi[idx(i + 1, j)]) / (2.5 * dt)
                } else if i == NLAT - 1 {
                    (phi[idx(i - 1, j)] - phi[k]) / dt
                } else {
                    (phi[idx(i - 1, j)] - phi[idx(i + 1, j)]) / (2.0 * dt)
                };
                let dphidp = (phi[idx(i, je)] - phi[idx(i, jw)]) / (2.0 * dphi);
                let et = -dphidt / R_ION_M;
                let ep = -dphidp / (R_ION_M * sc);
                self.e_theta[k] = et;
                self.e_phi[k] = ep;
                self.v_east[k] = et / b; // v_φ = +E_θ/B
                self.v_north[k] = ep / b; // v_north = −v_θ = +E_φ/B
            }
        }
    }
}

/// Cross polar cap potential (volts): max(Φ) − min(Φ).
pub fn cpcp(phi: &[f64]) -> f64 {
    let mut lo = f64::INFINITY;
    let mut hi = f64::NEG_INFINITY;
    for &v in phi {
        if v < lo {
            lo = v;
        }
        if v > hi {
            hi = v;
        }
    }
    hi - lo
}

/// Eastward E (V/m) at the equatorward boundary row, noon sector —
/// the "penetration E" readout (labeled on-page as measured AT the 40°
/// MLAT boundary, not the true equator). Averaged over ±1 column.
pub fn penetration_e(grid: &Grid, fields: &Fields) -> f64 {
    let jc = grid.col_at_mlt(12.0);
    let mut sum = 0.0;
    for d in -1i64..=1 {
        let j = (jc as i64 + d).rem_euclid(NMLT as i64) as usize;
        sum += fields.e_phi[idx(0, j)];
    }
    sum / 3.0
}

pub struct SapsSummary {
    /// Peak westward speed (m/s) in the subauroral band.
    pub peak_ms: f64,
    /// Latitude (deg) of the peak.
    pub peak_lat_deg: f64,
    /// Full width at half max (deg); 0 if no jet.
    pub width_deg: f64,
}

/// Westward-flow latitude profile at the given MLT (m/s, one value per
/// latitude row) and its peak/width summary over the subauroral band.
pub fn saps_profile(
    grid: &Grid,
    fields: &Fields,
    mlt: f64,
    profile: &mut [f64],
) -> SapsSummary {
    let j = grid.col_at_mlt(mlt);
    for i in 0..NLAT {
        profile[i] = -fields.v_east[idx(i, j)]; // westward positive
    }
    // Search the subauroral band only (50–70° MLAT) so the polar-cap
    // convection return flow doesn't masquerade as SAPS.
    let i_lo = ((50.0 - crate::grid::LAT_MIN_DEG) / crate::grid::DLAT_DEG) as usize;
    let i_hi = ((70.0 - crate::grid::LAT_MIN_DEG) / crate::grid::DLAT_DEG) as usize;
    let mut peak = 0.0f64;
    let mut ipk = i_lo;
    for i in i_lo..=i_hi.min(NLAT - 1) {
        if profile[i] > peak {
            peak = profile[i];
            ipk = i;
        }
    }
    if peak <= 0.0 {
        return SapsSummary { peak_ms: 0.0, peak_lat_deg: 0.0, width_deg: 0.0 };
    }
    let half = peak / 2.0;
    let mut lo = ipk;
    while lo > 0 && profile[lo] > half {
        lo -= 1;
    }
    let mut hi = ipk;
    while hi + 1 < NLAT && profile[hi] > half {
        hi += 1;
    }
    SapsSummary {
        peak_ms: peak,
        peak_lat_deg: grid.lat_deg(ipk),
        width_deg: (hi - lo) as f64 * crate::grid::DLAT_DEG,
    }
}
