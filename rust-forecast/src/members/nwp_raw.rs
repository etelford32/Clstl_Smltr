//! Raw NWP guidance — pass-through with hourly time alignment.
//!
//! NWP samples often don't land exactly on the forecast grid (Open-Meteo
//! returns timestamps at the top of the local hour, but our grid is in UTC).
//! For each grid hour we take the NWP sample closest in time, within a
//! 30-minute tolerance.

use crate::HourSample;

const TOL_SECONDS: f64 = 30.0 * 60.0;

pub fn predict_24h(
    nwp: &[HourSample],
    nwp_y: &[Option<f64>],
    grid: &[f64],
) -> Vec<Option<f64>> {
    grid.iter().map(|&t| {
        let mut best: Option<(f64, f64)> = None;   // (dt, value)
        for (i, s) in nwp.iter().enumerate() {
            let dt = (s.t - t).abs();
            if dt > TOL_SECONDS { continue; }
            if let Some(v) = nwp_y[i] {
                if best.map_or(true, |(d, _)| dt < d) {
                    best = Some((dt, v));
                }
            }
        }
        best.map(|(_, v)| v)
    }).collect()
}
