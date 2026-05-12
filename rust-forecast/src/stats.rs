//! Pure-stats helpers shared across members and the blender. No allocations
//! beyond the obvious Vecs we return.

use crate::{members, HourSample, ForecastConfig, NwpProvider, NUM_OBS_MEMBERS};

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

/// Weighted quantile (Type 7-equivalent on midpoint cumulative weights).
///
///   - sorts the (value, weight) pairs by value
///   - assigns each value the cumulative-midpoint position
///         p_i = (W_i − w_i / 2) / W_total
///     where W_i is the running sum of weights up to and including i
///   - linearly interpolates between adjacent (p_i, value_i) for each
///     requested probability q ∈ [0, 1]
///
/// This is the same scheme NumPy's `np.quantile(..., method='linear')`
/// converges to in the equal-weight limit, so the Python reference can
/// reuse `np.quantile` for unweighted cases without numerical drift.
///
/// Mutates the input vector for in-place sorting (avoids an allocation
/// in the hot loop). Caller doesn't need the original order back.
pub fn weighted_quantiles(vw: &mut Vec<(f64, f64)>, qs: &[f64]) -> Vec<f64> {
    // Drop non-finite values up front so they don't poison the sort or
    // total-weight calculation. NaN < NaN is false → the sort would be
    // undefined behavior territory in stable Rust.
    vw.retain(|(v, w)| v.is_finite() && w.is_finite() && *w > 0.0);
    if vw.is_empty() {
        return qs.iter().map(|_| f64::NAN).collect();
    }
    if vw.len() == 1 {
        return qs.iter().map(|_| vw[0].0).collect();
    }
    vw.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
    let total: f64 = vw.iter().map(|(_, w)| w).sum();

    // Build (cumulative_midpoint_fraction, value) anchor points.
    let mut anchors: Vec<(f64, f64)> = Vec::with_capacity(vw.len());
    let mut cum = 0.0;
    for (v, w) in vw.iter() {
        let mid = cum + w / 2.0;
        cum += w;
        anchors.push((mid / total, *v));
    }

    qs.iter().map(|&q| {
        let q = q.clamp(0.0, 1.0);
        if q <= anchors[0].0          { return anchors[0].1; }
        if q >= anchors.last().unwrap().0 { return anchors.last().unwrap().1; }
        // Linear search is fine — we only ever have 5 anchors.
        for i in 0..anchors.len() - 1 {
            let (p0, v0) = anchors[i];
            let (p1, v1) = anchors[i + 1];
            if q <= p1 {
                let denom = (p1 - p0).max(1e-12);
                let t = (q - p0) / denom;
                return v0 + t * (v1 - v0);
            }
        }
        anchors.last().unwrap().1
    }).collect()
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
/// Returns the per-member RMSE in the same order as `member_names`:
///
///   [0]                     persist
///   [1]                     diurnal
///   [2]                     ar1
///   [3 .. 3 + N]            nwp_<name_i>      (raw, per provider)
///   [3 + N .. 3 + 2N]       nwp_bc_<name_i>   (bias-corrected, per provider)
///
/// Members that produce no usable predictions on the score window get `NaN`
/// (the softmax treats that as zero weight). When the obs window is too
/// short (< 4 hours) we return uniform 1.0s so the softmax falls back to
/// equal-weight averaging — strictly better than crashing on cold-start.
pub fn score_members(
    obs:        &[HourSample],
    obs_y:      &[Option<f64>],
    providers:  &[NwpProvider],
    lat: f64, lon: f64,
    cfg: &ForecastConfig,
    field_name: &str,
) -> Vec<f64> {
    let m      = NUM_OBS_MEMBERS + 2 * providers.len();
    let n      = obs.len();
    let window = cfg.score_window.min(n.saturating_sub(1));
    if window < 4 {
        return vec![1.0; m];
    }

    let start = n - window;
    let mut errs: Vec<Vec<f64>> = vec![Vec::new(); m];

    for h in start..n {
        let truth = match obs_y[h] { Some(v) => v, None => continue };

        // Slice obs history to "before h" only. NWP provider samples are
        // NOT filtered: a provider's forecast was issued at a single past
        // run-time and its samples are valid at various future hours. To
        // ask "what would this NWP have predicted for hour h?" we just
        // look up its sample valid at obs[h].t — there's no time-travel
        // concern. Filtering by `s.t < obs[h].t` would push the closest
        // available sample to obs[h].t − 1 hr, outside `nwp_raw`'s 30-min
        // tolerance, which would make every NWP member silently score NaN
        // and collapse to zero weight regardless of actual skill.
        let obs_h = &obs[..h];
        let oy_h: Vec<Option<f64>> = obs_y[..h].to_vec();
        let provider_hist: Vec<(&Vec<HourSample>, Vec<Option<f64>>)> = providers.iter().map(|p| {
            let h_field: Vec<Option<f64>> = p.samples.iter()
                .map(|s| field_get(s, field_name))
                .collect();
            (&p.samples, h_field)
        }).collect();

        // Each member predicts a single-hour grid pinned at obs[h].t.
        let grid = vec![obs[h].t];

        // Obs-only members (always run).
        let mut preds: Vec<Vec<Option<f64>>> = Vec::with_capacity(m);
        preds.push(members::persist::predict_24h(obs_h, &oy_h, &grid));
        preds.push(members::diurnal::predict_24h(obs_h, &oy_h, &grid, lat, lon, cfg));
        preds.push(members::ar1::predict_24h    (obs_h, &oy_h, &grid, cfg));
        // Per-provider raw NWP.
        for (samples, field) in &provider_hist {
            preds.push(members::nwp_raw::predict_24h(samples, field, &grid));
        }
        // Per-provider bias-corrected NWP.
        for (samples, field) in &provider_hist {
            preds.push(members::nwp_bc::predict_24h(obs_h, &oy_h, samples, field, &grid, cfg));
        }

        for (i, p) in preds.iter().enumerate() {
            if let Some(v) = p[0] {
                errs[i].push((v - truth).powi(2));
            }
        }
    }

    let mut out = vec![f64::NAN; m];
    for i in 0..m {
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
