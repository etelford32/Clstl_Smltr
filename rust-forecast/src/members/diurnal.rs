//! Diurnal harmonic predictor. Fits sun-locked sin/cos basis (k = 1, 2 cycles
//! per day) plus a slowly-varying mean to the recent obs window via ordinary
//! least-squares, then projects forward.
//!
//! Why sun-locked rather than UTC- or local-clock-locked: shifting to solar
//! phase removes the timezone-handling burden entirely — the same model
//! works at high latitude (where solar noon drifts large amounts from civil
//! noon in summer) and across DST transitions without retuning.
//!
//! This member is the workhorse for temperature, dew point, and cloud cover,
//! all of which have strong, near-sinusoidal daily cycles that often beat
//! NWP at hour-scale resolution near the station.

use crate::{astro, HourSample, ForecastConfig};

pub fn predict_24h(
    obs: &[HourSample],
    obs_y: &[Option<f64>],
    grid: &[f64],
    lat: f64,
    lon: f64,
    cfg: &ForecastConfig,
) -> Vec<Option<f64>> {
    let n = obs.len();
    if n < 12 {
        // Not enough data to fit a daily harmonic.
        return vec![None; grid.len()];
    }
    let take = cfg.diurnal_window.min(n);
    let start = n - take;

    // Build design matrix:
    //   [ 1,  cos(φ),  sin(φ),  cos(2φ),  sin(2φ),  τ ]
    // where φ is the solar diurnal phase and τ is a normalized linear-time
    // trend so a slow synoptic warming/cooling shift doesn't bleed into the
    // harmonic amplitudes.
    let cols = 6;
    let mut a:  Vec<f64> = Vec::with_capacity(take * cols);
    let mut b:  Vec<f64> = Vec::with_capacity(take);
    // Time origin = midpoint of fit window, scaled to ~1.
    let t_origin = (obs[start].t + obs[n - 1].t) * 0.5;
    let t_scale  = (obs[n - 1].t - obs[start].t).max(1.0) * 0.5;

    for i in start..n {
        let y = match obs_y[i] { Some(v) => v, None => continue };
        let phi = astro::diurnal_phase(lat, lon, obs[i].t);
        let tau = (obs[i].t - t_origin) / t_scale;
        a.extend_from_slice(&[
            1.0,
            phi.cos(), phi.sin(),
            (2.0 * phi).cos(), (2.0 * phi).sin(),
            tau,
        ]);
        b.push(y);
    }
    let rows = b.len();
    if rows < cols + 2 {
        return vec![None; grid.len()];
    }

    // Solve normal equations  (Aᵀ A) x = Aᵀ b  with a small ridge λ for
    // numerical stability when the diurnal cycle barely covers the window.
    let lambda = 1e-6;
    let beta = match solve_normal_eq(&a, &b, rows, cols, lambda) {
        Some(x) => x,
        None    => return vec![None; grid.len()],
    };

    // Project forward.
    grid.iter().map(|&t| {
        let phi = astro::diurnal_phase(lat, lon, t);
        let tau = (t - t_origin) / t_scale;
        Some(
              beta[0]
            + beta[1] * phi.cos()        + beta[2] * phi.sin()
            + beta[3] * (2.0 * phi).cos()+ beta[4] * (2.0 * phi).sin()
            + beta[5] * tau
        )
    }).collect()
}

/// Solve  (AᵀA + λI) x = Aᵀb  via Gauss elimination. Tiny system (≤ 8×8)
/// so a hand-rolled solver is fine — pulling in `nalgebra` would add ~150 KB
/// to the WASM bundle for no benefit. Inputs:
///   a: row-major rows × cols matrix
///   b: rows × 1
fn solve_normal_eq(a: &[f64], b: &[f64], rows: usize, cols: usize, lambda: f64) -> Option<Vec<f64>> {
    // Form M = AᵀA + λI  (cols × cols)
    let mut m = vec![0.0_f64; cols * cols];
    for j in 0..cols {
        for k in 0..cols {
            let mut s = 0.0;
            for r in 0..rows { s += a[r * cols + j] * a[r * cols + k]; }
            if j == k { s += lambda; }
            m[j * cols + k] = s;
        }
    }
    // y = Aᵀ b
    let mut y = vec![0.0_f64; cols];
    for j in 0..cols {
        let mut s = 0.0;
        for r in 0..rows { s += a[r * cols + j] * b[r]; }
        y[j] = s;
    }
    // Gaussian elimination on the augmented matrix.
    let mut aug = vec![0.0_f64; cols * (cols + 1)];
    for j in 0..cols {
        for k in 0..cols { aug[j * (cols + 1) + k] = m[j * cols + k]; }
        aug[j * (cols + 1) + cols] = y[j];
    }
    for i in 0..cols {
        // Partial pivot.
        let mut pivot = i;
        for r in (i + 1)..cols {
            if aug[r * (cols + 1) + i].abs() > aug[pivot * (cols + 1) + i].abs() {
                pivot = r;
            }
        }
        if pivot != i {
            for k in 0..(cols + 1) {
                aug.swap(i * (cols + 1) + k, pivot * (cols + 1) + k);
            }
        }
        let piv = aug[i * (cols + 1) + i];
        if piv.abs() < 1e-12 { return None; }
        for r in (i + 1)..cols {
            let f = aug[r * (cols + 1) + i] / piv;
            for k in i..(cols + 1) {
                aug[r * (cols + 1) + k] -= f * aug[i * (cols + 1) + k];
            }
        }
    }
    let mut x = vec![0.0_f64; cols];
    for i in (0..cols).rev() {
        let mut s = aug[i * (cols + 1) + cols];
        for k in (i + 1)..cols { s -= aug[i * (cols + 1) + k] * x[k]; }
        x[i] = s / aug[i * (cols + 1) + i];
    }
    Some(x)
}
