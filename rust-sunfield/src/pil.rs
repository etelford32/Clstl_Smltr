//! Polarity Inversion Line detection.
//!
//! For each AR, sample Br on a small lat/lon patch around the AR centre,
//! find zero-crossings between adjacent grid cells, and emit a list of
//! photospheric points along the contour. These are returned as PIL seeds
//! for the tracer (closed loops anchored to the PIL → prominence ribbons).

use crate::field::{Ar, Field};
use crate::vec3::V3;

/// Walk Br = 0 contour on a small patch around the AR.
/// Returns a list of unit-sphere points along the PIL, evenly sampled.
pub fn trace_pil_around_ar(field: &Field, ar: &Ar) -> Vec<V3> {
    // Patch half-size in radians, scaled by AR area.
    let half = (0.10 + 0.20 * ar.area.clamp(0.0, 1.0)).clamp(0.10, 0.35);
    // Resolution: 24×24 grid is plenty for visual placement of ~10 PIL seeds.
    const GRID: usize = 24;

    let lat0 = ar.lat_rad;
    let lon0 = ar.lon_rad;

    // Sample Br on the lat/lon grid.
    let mut br = [[0.0f32; GRID]; GRID];
    for j in 0..GRID {
        let v = (j as f32) / ((GRID - 1) as f32) * 2.0 - 1.0; // -1..1
        let lat = lat0 + half * v;
        for i in 0..GRID {
            let u = (i as f32) / ((GRID - 1) as f32) * 2.0 - 1.0;
            let lon = lon0 + half * u / lat.cos().max(0.05); // approximate metric
            let p = V3::from_lat_lon(lat, lon, 1.0);
            br[j][i] = field.br_at(p);
        }
    }

    // Find zero-crossing cell midpoints.
    let mut seeds: Vec<V3> = Vec::new();
    for j in 0..GRID - 1 {
        for i in 0..GRID - 1 {
            let a = br[j][i];
            let b = br[j][i + 1];
            let c = br[j + 1][i];
            let cross_h = a * b < 0.0;
            let cross_v = a * c < 0.0;
            if !(cross_h || cross_v) { continue; }

            let u = (i as f32 + 0.5) / ((GRID - 1) as f32) * 2.0 - 1.0;
            let v = (j as f32 + 0.5) / ((GRID - 1) as f32) * 2.0 - 1.0;
            let lat = lat0 + half * v;
            let lon = lon0 + half * u / lat.cos().max(0.05);
            seeds.push(V3::from_lat_lon(lat, lon, 1.0));
        }
    }

    // Cap and decimate so a single AR doesn't flood the seed budget.
    const MAX_PER_AR: usize = 10;
    if seeds.len() > MAX_PER_AR {
        let stride = seeds.len() / MAX_PER_AR;
        seeds.iter().step_by(stride.max(1)).take(MAX_PER_AR).copied().collect()
    } else {
        seeds
    }
}
