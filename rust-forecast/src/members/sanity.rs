//! Physical-consistency clamps applied after blending.
//!
//! Member outputs can disagree freely — temperature ensemble could be 70 °F,
//! dew-point ensemble could be 75 °F if the diurnal phase happens to align
//! oddly — but the *consensus* must satisfy thermodynamics. These post-blend
//! clamps enforce that in O(1) per hour.

use crate::ForecastHour;

pub fn clamp_inplace(h: &mut ForecastHour) {
    // Cloud cover, RH, precip prob ∈ [0, 100].
    for opt in [&mut h.cloud_cover, &mut h.relative_humidity_2m, &mut h.precip_probability] {
        if let Some(v) = opt {
            *opt = Some(v.clamp(0.0, 100.0));
        }
    }
    // Precipitation, wind speed, wind gust ≥ 0.
    for opt in [&mut h.precipitation, &mut h.wind_speed_10m, &mut h.wind_gusts_10m] {
        if let Some(v) = opt {
            *opt = Some(v.max(0.0));
        }
    }
    // Wind direction wrapped to [0, 360).
    if let Some(d) = h.wind_direction_10m {
        h.wind_direction_10m = Some(((d % 360.0) + 360.0) % 360.0);
    }
    // Gust ≥ wind speed.
    if let (Some(w), Some(g)) = (h.wind_speed_10m, h.wind_gusts_10m) {
        if g < w { h.wind_gusts_10m = Some(w); }
    }
    // Dew point ≤ temperature (cap at temperature; never above).
    if let (Some(t), Some(d)) = (h.temperature_2m, h.dew_point_2m) {
        if d > t { h.dew_point_2m = Some(t); }
    }
    // Apparent temperature: if missing, estimate from temperature and wind
    // using a simplified wind-chill / heat-index blend (stop-gap so the UI
    // always has a "feels like").
    if h.apparent_temperature.is_none() {
        if let Some(t) = h.temperature_2m {
            let mut feel = t;
            if let Some(w) = h.wind_speed_10m {
                if t < 50.0 && w > 3.0 {
                    // NWS wind-chill formula (°F, mph). Underestimates at low
                    // winds; valid only below 50 °F.
                    let w_pow = w.powf(0.16);
                    feel = 35.74 + 0.6215 * t - 35.75 * w_pow + 0.4275 * t * w_pow;
                }
            }
            if let Some(rh) = h.relative_humidity_2m {
                if t >= 80.0 && rh >= 40.0 {
                    // Rothfusz heat-index regression (°F, %).
                    feel = -42.379
                         + 2.04901523 * t
                         + 10.14333127 * rh
                         - 0.22475541 * t * rh
                         - 0.00683783 * t * t
                         - 0.05481717 * rh * rh
                         + 0.00122874 * t * t * rh
                         + 0.00085282 * t * rh * rh
                         - 0.00000199 * t * t * rh * rh;
                }
            }
            h.apparent_temperature = Some(feel);
        }
    }
    h.confidence = h.confidence.clamp(0.0, 1.0);
}
