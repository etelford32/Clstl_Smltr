//! NWP with running-mean bias correction.
//!
//! NWP guidance is typically *smooth and biased* at the station scale —
//! systematically too cold in the lee of a hill, too warm at coastal sites
//! when the marine inversion isn't resolved, etc. The bias is slowly varying
//! (~hours), so a recent obs−NWP residual mean removes most of it without
//! overfitting.

use crate::{HourSample, ForecastConfig, members::nwp_raw};

pub fn predict_24h(
    obs:   &[HourSample],
    obs_y: &[Option<f64>],
    nwp:   &[HourSample],
    nwp_y: &[Option<f64>],
    grid:  &[f64],
    cfg:   &ForecastConfig,
) -> Vec<Option<f64>> {
    // Compute mean(obs - nwp_at_obs_time) over the past `nbc_window` hours.
    let n      = obs.len();
    let window = cfg.nbc_window.min(n);
    if window < 2 {
        // Fall back to raw NWP if we can't compute a bias.
        return nwp_raw::predict_24h(nwp, nwp_y, grid);
    }
    let start = n - window;

    // Build an obs-time grid for the alignment.
    let obs_grid: Vec<f64> = obs[start..].iter().map(|s| s.t).collect();
    let nwp_at_obs = nwp_raw::predict_24h(nwp, nwp_y, &obs_grid);

    let mut diffs: Vec<f64> = Vec::with_capacity(window);
    for i in 0..window {
        let truth = obs_y[start + i];
        if let (Some(t), Some(p)) = (truth, nwp_at_obs[i]) {
            diffs.push(t - p);
        }
    }
    let bias = if diffs.is_empty() {
        0.0
    } else {
        diffs.iter().sum::<f64>() / diffs.len() as f64
    };

    // Apply bias to forward NWP.
    let raw = nwp_raw::predict_24h(nwp, nwp_y, grid);
    raw.into_iter().map(|v| v.map(|x| x + bias)).collect()
}
