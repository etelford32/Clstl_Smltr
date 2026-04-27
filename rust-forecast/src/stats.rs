//! Pure-stats helpers shared across members and the blender. No allocations
//! beyond the obvious Vecs we return.

use crate::{members, HourSample, ForecastConfig};

pub fn mean(xs: &[f64]) -> f64 {
    if xs.is_empty() { return 0.0; }
    xs.iter().sum::<f64>() / xs.len() as f64
}

pub fn stddev(xs: &[f64]) -> f64 {
    if xs.len() < 2 { return 0.0; }
    let m = mean(xs);
    let v = xs.iter().map(|&x| (x - m).powi(2)).sum::<f64>() / (xs.len() - 1) as f64;
    v.sqrt()
}

/// Convert RMSE vector → softmax-ish weights via softmax(-rmse / temperature).
/// NaN / non-finite RMSEs map to zero weight (member is treated as failed).
pub fn softmax_neg(rmses: &[f64], temperature: f64) -> Vec<f64> {
    let temp = temperature.max(1e-6);
    let neg: Vec<f64> = rmses.iter()
        .map(|&r| if r.is_finite() { -r / temp } else { f64::NEG_INFINITY })
        .collect();
    let m = neg.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    if !m.is_finite() {
        // Every member failed → uniform weights so we still emit output.
        return vec![1.0 / rmses.len() as f64; rmses.len()];
    }
    let exps: Vec<f64> = neg.iter().map(|&v| (v - m).exp()).collect();
    let s: f64 = exps.iter().sum();
    if s <= 0.0 { return vec![1.0 / rmses.len() as f64; rmses.len()]; }
    exps.iter().map(|&e| e / s).collect()
}

/// Score each ensemble member against the most-recent `score_window` observed
/// hours via leave-one-out: at hour h ∈ [N − W, N), re-run the member using
/// only obs strictly before h, then compare its h-step prediction to obs[h].
///
/// Returns the per-member RMSE in the same order as the members are run in
/// `lib::run`. Members that produce no usable predictions on the score window
/// get `NaN` (which the softmax treats as zero weight).
pub fn score_members(
    obs:   &[HourSample],
    obs_y: &[Option<f64>],
    nwp:   &[HourSample],
    _nwp_y: &[Option<f64>],
    lat: f64, lon: f64,
    cfg: &ForecastConfig,
    field_name: &str,
) -> [f64; 5] {
    let n      = obs.len();
    let window = cfg.score_window.min(n.saturating_sub(1));
    if window < 4 {
        // Not enough history to score reliably → treat all members as
        // equally good; downstream softmax falls back to uniform weights
        // which makes the blender a simple equal-weight average.
        return [1.0; 5];
    }

    let start = n - window;
    let mut errs: [Vec<f64>; 5] = Default::default();

    for h in start..n {
        let truth = match obs_y[h] { Some(v) => v, None => continue };

        // Slice obs/nwp histories to "before h" only.
        let obs_h = &obs[..h];
        let oy_h: Vec<Option<f64>> = obs_y[..h].to_vec();
        let nwp_h: Vec<HourSample> = nwp.iter().filter(|s| s.t < obs[h].t).cloned().collect();
        let ny_h: Vec<Option<f64>> = nwp_h.iter().map(|s| field_get(s, field_name)).collect();

        // Each member predicts a single-hour grid pinned at obs[h].t.
        let grid = vec![obs[h].t];

        let preds: [Vec<Option<f64>>; 5] = [
            members::persist::predict_24h(obs_h, &oy_h, &grid),
            members::diurnal::predict_24h(obs_h, &oy_h, &grid, lat, lon, cfg),
            members::ar1::predict_24h    (obs_h, &oy_h, &grid, cfg),
            members::nwp_raw::predict_24h(&nwp_h, &ny_h, &grid),
            members::nwp_bc::predict_24h (obs_h, &oy_h, &nwp_h, &ny_h, &grid, cfg),
        ];

        for (i, p) in preds.iter().enumerate() {
            if let Some(v) = p[0] {
                errs[i].push((v - truth).powi(2));
            }
        }
    }

    let mut out = [f64::NAN; 5];
    for i in 0..5 {
        if errs[i].is_empty() { continue; }
        let mse: f64 = errs[i].iter().sum::<f64>() / errs[i].len() as f64;
        out[i] = mse.sqrt();
    }
    out
}

/// Typical magnitude of a field — used to normalize inter-member spread
/// into a 0..1 confidence proxy. Tuned to roughly the standard deviation
/// of mid-latitude hourly observations.
pub fn field_scale(name: &str) -> f64 {
    match name {
        "temperature_2m"        => 15.0,    // °F
        "apparent_temperature"  => 15.0,
        "relative_humidity_2m"  => 25.0,    // %
        "dew_point_2m"          => 12.0,
        "pressure_msl"          => 8.0,     // hPa
        "wind_speed_10m"        => 8.0,     // mph
        "wind_gusts_10m"        => 12.0,
        "wind_direction_10m"    => 60.0,    // ° — unused (circular)
        "precipitation"         => 1.5,     // mm/hr
        "precip_probability"    => 30.0,
        "cloud_cover"           => 35.0,
        _ => 10.0,
    }
}

fn field_get(s: &HourSample, name: &str) -> Option<f64> {
    match name {
        "temperature_2m"        => s.temperature_2m,
        "apparent_temperature"  => s.apparent_temperature,
        "relative_humidity_2m"  => s.relative_humidity_2m,
        "dew_point_2m"          => s.dew_point_2m,
        "pressure_msl"          => s.pressure_msl,
        "wind_speed_10m"        => s.wind_speed_10m,
        "wind_gusts_10m"        => s.wind_gusts_10m,
        "wind_direction_10m"    => s.wind_direction_10m,
        "precipitation"         => s.precipitation,
        "precip_probability"    => s.precip_probability,
        "cloud_cover"           => s.cloud_cover,
        _ => None,
    }
}
