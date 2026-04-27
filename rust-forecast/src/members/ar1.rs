//! AR(1) on de-seasonalized residuals.
//!
//! The diurnal member already explains most of the variance for temperature-
//! like fields. What's left is short-correlation noise (synoptic drift,
//! cloud-shading flickers, mesoscale fronts). A first-order autoregression
//! on the *residuals* of a quick rolling-mean detrend captures the bulk of
//! that residual variance without overfitting.
//!
//!   y_t  ≈  μ + φ · (y_{t-1} - μ) + ε_t
//!
//! φ is estimated with the lag-1 sample autocorrelation, clipped to a
//! configurable max so the predictor doesn't blow up if obs come back as
//! nearly-constant for some hours.

use crate::{HourSample, ForecastConfig};

pub fn predict_24h(
    obs: &[HourSample],
    obs_y: &[Option<f64>],
    grid: &[f64],
    cfg: &ForecastConfig,
) -> Vec<Option<f64>> {
    // Collect contiguous tail of valid values.
    let mut ys: Vec<f64> = Vec::with_capacity(obs.len());
    for v in obs_y.iter() {
        if let Some(x) = *v { ys.push(x); }
    }
    if ys.len() < 6 {
        return vec![None; grid.len()];
    }

    let n   = ys.len();
    let mu  = ys.iter().sum::<f64>() / n as f64;

    // Sample lag-1 autocorrelation (Yule-Walker estimator for AR(1)).
    let mut num = 0.0;
    let mut den = 0.0;
    for i in 1..n {
        num += (ys[i] - mu) * (ys[i - 1] - mu);
    }
    for i in 0..n {
        den += (ys[i] - mu).powi(2);
    }
    if den < 1e-9 {
        // Constant series. Just propagate the mean.
        return grid.iter().map(|_| Some(mu)).collect();
    }
    let phi_raw = num / den;
    let phi     = phi_raw.clamp(-cfg.ar1_phi_max, cfg.ar1_phi_max);

    // Walk the AR(1) recursion forward from the last observation. Time spacing
    // assumed ~1 hr; if the grid skips beyond the obs end we still recurse
    // step-by-step.
    let last = obs.last().map(|s| s.t).unwrap_or(0.0);
    let last_y = ys[n - 1];
    let mut state = last_y;
    let mut t_state = last;

    grid.iter().map(|&t_target| {
        // Number of 1-hour steps to roll forward.
        let mut steps = ((t_target - t_state) / 3600.0).round() as i64;
        if steps < 0 {
            // Caller asked for a time before the last obs — return current
            // state. Shouldn't happen in practice; defensive.
            return Some(state);
        }
        while steps > 0 {
            state    = mu + phi * (state - mu);
            t_state += 3600.0;
            steps   -= 1;
        }
        Some(state)
    }).collect()
}
