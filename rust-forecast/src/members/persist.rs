//! Persistence baseline. The most-recent valid observation, propagated flat.
//!
//! This is the dumb-but-hard-to-beat baseline: at lead times of 1–3 hours,
//! the autocorrelation of surface temperature, wind, and pressure is so high
//! that "no change" beats most NWP guidance at the station scale. Including
//! it as an ensemble member means the blender automatically up-weights it
//! when it is in fact the best predictor.

use crate::HourSample;

pub fn predict_24h(
    _obs: &[HourSample],
    obs_y: &[Option<f64>],
    grid: &[f64],
) -> Vec<Option<f64>> {
    // Walk back from the end of obs to find the last valid value.
    let last = obs_y.iter().rev().find_map(|v| *v);
    grid.iter().map(|_| last).collect()
}
