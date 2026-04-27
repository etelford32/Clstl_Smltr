//! 24-Hour Location Forecast — deterministic multi-method ensemble.
//!
//! Goal: produce a 24-hour hourly weather forecast for a single point that
//! consistently beats raw NWP guidance for short-horizon (1–24 h) at the
//! station scale by blending several cheap, modular predictors and updating
//! their weights from how each has been doing on the most recent observed
//! window.
//!
//! ## Inputs (all caller-supplied — this crate is offline / pure)
//!
//!   • `obs` — recent hourly observations at the point (any subset of
//!     temperature, dew point, wind, pressure, cloud, precip). Used both
//!     to anchor the persistence baseline and to score competing methods.
//!   • `nwp` — N hourly NWP samples for the next 24 h (Open-Meteo / MET
//!     Norway / NWS). Acts as the physical-prior member of the ensemble.
//!   • `lat`, `lon`, `t0_unix` — astronomical anchors for the diurnal
//!     harmonic predictor (computes the local sub-solar geometry).
//!
//! ## Members
//!
//!   1. PERSIST — last observed value, drifted by long-window AR(1) bias.
//!   2. DIURNAL — Fourier-style 24 h + 12 h harmonics fit by least-squares
//!      to obs, projected forward using the astronomical sun altitude as
//!      an irradiance phase reference (so the harmonic is sun-locked, not
//!      clock-locked — important for high-latitude / shifting DST).
//!   3. AR1     — first-order autoregression on de-seasonalized obs;
//!      recursively predicts residuals.
//!   4. NWP     — raw NWP guidance (the prior).
//!   5. NWP_BC  — NWP with running-mean bias correction from obs vs.
//!      NWP for the past `nbc_window` hours.
//!
//! ## Blender
//!
//! At forecast time we score each member by its leave-one-out RMSE over
//! the most recent `score_window` observed hours, convert to weights via
//! `softmax(-rmse / temperature)`, then blend hour-by-hour. The result is
//! the "consensus" forecast. The temperature parameter controls how
//! peaked the weights become — low temp → winner-takes-all, high temp →
//! near-uniform average.
//!
//! ## Determinism
//!
//! No `rand` dependency anywhere. Identical inputs → bit-identical output.
//! This is critical: the Python reference (`24hour_location_forecast` CLI)
//! must produce the same numbers as the WASM build for tests to be
//! meaningful.
//!
//! ## Modularity
//!
//! Each `members::*` module is independent and exposes a single
//! `predict_24h(...)` function. Adding a new member is one file plus one
//! line in `ensemble::run`. No cross-module state.

use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

pub mod astro;
pub mod members;
pub mod stats;

// ────────────────────────────────────────────────────────────────────────────
// Public input / output types (also mirrored 1-for-1 in Python reference).
// ────────────────────────────────────────────────────────────────────────────

/// One hourly observation OR one hourly NWP sample. Field naming matches
/// Open-Meteo / MET Norway terminology so the JS adapter can pass values
/// through with no remapping.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct HourSample {
    /// Unix epoch seconds at the start of the hour (UTC).
    pub t: f64,
    pub temperature_2m:        Option<f64>,   // °F
    pub apparent_temperature:  Option<f64>,   // °F
    pub relative_humidity_2m:  Option<f64>,   // %
    pub dew_point_2m:          Option<f64>,   // °F (derived if missing)
    pub pressure_msl:          Option<f64>,   // hPa
    pub wind_speed_10m:        Option<f64>,   // mph
    pub wind_gusts_10m:        Option<f64>,   // mph
    pub wind_direction_10m:    Option<f64>,   // ° true
    pub precipitation:         Option<f64>,   // mm/hr
    pub precip_probability:    Option<f64>,   // 0–100
    pub cloud_cover:           Option<f64>,   // 0–100
}

/// Tuning knobs for the ensemble. All have safe defaults; the JS layer can
/// override them via `ForecastRequest.config`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ForecastConfig {
    /// Hours of obs used to score competing members. 12–48 is typical.
    pub score_window:   usize,
    /// Hours of obs used to fit the diurnal harmonic. ≥48 needed for two
    /// full daily cycles → stable phase estimate.
    pub diurnal_window: usize,
    /// AR(1) phi clamp [0, 0.99]. 0.0 disables AR member.
    pub ar1_phi_max:    f64,
    /// Softmax temperature for the weight blender. Smaller → sharper weights.
    pub blend_temp:     f64,
    /// NWP bias-correction smoothing horizon (hours).
    pub nbc_window:     usize,
    /// Forecast horizon in hours. Locked to 24 here; surfaced for clarity.
    pub horizon:        usize,
}

impl Default for ForecastConfig {
    fn default() -> Self {
        Self {
            score_window:   24,
            diurnal_window: 72,
            ar1_phi_max:    0.95,
            blend_temp:     1.5,
            nbc_window:     12,
            horizon:        24,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ForecastRequest {
    pub lat:     f64,
    pub lon:     f64,
    /// Unix epoch seconds — the start of the 24-hour forecast horizon.
    pub t0_unix: f64,
    /// Most-recent first or oldest-first; we sort by `t` regardless.
    pub obs:     Vec<HourSample>,
    pub nwp:     Vec<HourSample>,
    pub config:  Option<ForecastConfig>,
}

/// One predicted hour from the ensemble.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ForecastHour {
    pub t:                    f64,
    pub temperature_2m:       Option<f64>,
    pub apparent_temperature: Option<f64>,
    pub relative_humidity_2m: Option<f64>,
    pub dew_point_2m:         Option<f64>,
    pub pressure_msl:         Option<f64>,
    pub wind_speed_10m:       Option<f64>,
    pub wind_gusts_10m:       Option<f64>,
    pub wind_direction_10m:   Option<f64>,
    pub precipitation:        Option<f64>,
    pub precip_probability:   Option<f64>,
    pub cloud_cover:          Option<f64>,
    /// Per-hour confidence ∈ [0, 1] derived from inter-member spread.
    pub confidence:           f64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MemberSkill {
    pub name:    String,
    pub rmse:    f64,
    pub weight:  f64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ForecastResponse {
    pub hours:    Vec<ForecastHour>,
    pub skill:    Vec<MemberSkill>,
    /// Identifies which inputs were available — UI uses this to gate
    /// display of fields the algorithm couldn't compute.
    pub fields:   Vec<String>,
    /// Algorithm version. Bump on any change that affects numeric output
    /// so caches invalidate. Mirrored in the Python reference.
    pub version:  String,
}

pub const VERSION: &str = "0.1.0";

// ────────────────────────────────────────────────────────────────────────────
// Top-level ensemble entry point. Pure Rust — also used by Python via FFI
// in offline mode (the Python reference re-implements this for parity).
// ────────────────────────────────────────────────────────────────────────────

pub fn run(req: ForecastRequest) -> ForecastResponse {
    let cfg = req.config.unwrap_or_default();
    let horizon = cfg.horizon.min(24);

    // Sort once — defensive; downstream code assumes ascending time.
    let mut obs = req.obs.clone();
    obs.sort_by(|a, b| a.t.partial_cmp(&b.t).unwrap());
    let mut nwp = req.nwp.clone();
    nwp.sort_by(|a, b| a.t.partial_cmp(&b.t).unwrap());

    // The forecast grid is hourly aligned to t0_unix.
    let grid: Vec<f64> = (0..horizon).map(|h| req.t0_unix + h as f64 * 3600.0).collect();

    // Which scalar fields do we have data for? Each is forecast independently.
    let fields = vec![
        "temperature_2m",
        "apparent_temperature",
        "relative_humidity_2m",
        "dew_point_2m",
        "pressure_msl",
        "wind_speed_10m",
        "wind_gusts_10m",
        "wind_direction_10m",
        "precipitation",
        "precip_probability",
        "cloud_cover",
    ];

    let mut hours: Vec<ForecastHour> = grid.iter().map(|&t| ForecastHour { t, ..Default::default() }).collect();
    let mut skills: Vec<MemberSkill> = Vec::new();

    for fname in &fields {
        let f = field_accessor(fname);
        let obs_y = extract_field(&obs, &f);
        let nwp_y = extract_field(&nwp, &f);

        // Skip fields where we have neither obs nor NWP — nothing to do.
        if obs_y.iter().all(|v| v.is_none()) && nwp_y.iter().all(|v| v.is_none()) {
            continue;
        }

        // Run each member to produce a 24-vec of predictions.
        let m_persist = members::persist::predict_24h(&obs, &obs_y, &grid);
        let m_diurnal = members::diurnal::predict_24h(&obs, &obs_y, &grid, req.lat, req.lon, &cfg);
        let m_ar1     = members::ar1::predict_24h(&obs, &obs_y, &grid, &cfg);
        let m_nwp     = members::nwp_raw::predict_24h(&nwp, &nwp_y, &grid);
        let m_nwp_bc  = members::nwp_bc::predict_24h(&obs, &obs_y, &nwp, &nwp_y, &grid, &cfg);

        let members_named: Vec<(&str, Vec<Option<f64>>)> = vec![
            ("persist", m_persist),
            ("diurnal", m_diurnal),
            ("ar1",     m_ar1),
            ("nwp",     m_nwp),
            ("nwp_bc",  m_nwp_bc),
        ];

        // Score each member on the most recent `score_window` observed hours.
        // For each scored hour we re-run the member as if "now" were that hour
        // (cheap: each member's predict_24h is O(N) and only needs the obs
        // history before that hour — handled via slicing inside the closures).
        let scored = stats::score_members(
            &obs, &obs_y, &nwp, &nwp_y,
            req.lat, req.lon, &cfg,
            &fname,
        );

        // Convert RMSEs → softmax weights.
        let weights = stats::softmax_neg(&scored, cfg.blend_temp);

        // Hour-by-hour weighted average across members. Only counts the
        // members that produced a non-null prediction for that hour.
        for (h, hour) in hours.iter_mut().enumerate() {
            let mut num = 0.0;
            let mut den = 0.0;
            let mut vals_for_spread: Vec<f64> = Vec::with_capacity(members_named.len());
            for (i, (_name, vec)) in members_named.iter().enumerate() {
                if let Some(v) = vec[h] {
                    num += weights[i] * v;
                    den += weights[i];
                    vals_for_spread.push(v);
                }
            }
            if den > 1e-9 {
                let blended = num / den;
                set_field(hour, fname, Some(blended));
                // Confidence is a normalized 1 − spread/scale heuristic;
                // averaged across fields below.
                let spread = stats::stddev(&vals_for_spread);
                let scale  = stats::field_scale(fname);
                hour.confidence += (1.0 - (spread / scale).clamp(0.0, 1.0)) / fields.len() as f64;
            }
        }

        for (i, (name, _)) in members_named.iter().enumerate() {
            skills.push(MemberSkill {
                name:   format!("{}::{}", fname, name),
                rmse:   scored[i],
                weight: weights[i],
            });
        }
    }

    // Apply derived-field consistency. Dew point ≤ temperature; clouds [0,100];
    // RH [0,100]; precipitation ≥ 0; wind speed ≥ 0; gust ≥ wind. These are
    // physical hard constraints — applied after blending so member outputs
    // can disagree freely but the consensus is always valid.
    for hour in hours.iter_mut() {
        members::sanity::clamp_inplace(hour);
    }

    ForecastResponse {
        hours,
        skill:   skills,
        fields:  fields.iter().map(|s| s.to_string()).collect(),
        version: VERSION.to_string(),
    }
}

// ────────────────────────────────────────────────────────────────────────────
// Field-accessor helpers (no reflection in stable Rust → boilerplate).
// ────────────────────────────────────────────────────────────────────────────

type FieldAcc = fn(&HourSample) -> Option<f64>;

fn field_accessor(name: &str) -> FieldAcc {
    match name {
        "temperature_2m"        => |s: &HourSample| s.temperature_2m,
        "apparent_temperature"  => |s: &HourSample| s.apparent_temperature,
        "relative_humidity_2m"  => |s: &HourSample| s.relative_humidity_2m,
        "dew_point_2m"          => |s: &HourSample| s.dew_point_2m,
        "pressure_msl"          => |s: &HourSample| s.pressure_msl,
        "wind_speed_10m"        => |s: &HourSample| s.wind_speed_10m,
        "wind_gusts_10m"        => |s: &HourSample| s.wind_gusts_10m,
        "wind_direction_10m"    => |s: &HourSample| s.wind_direction_10m,
        "precipitation"         => |s: &HourSample| s.precipitation,
        "precip_probability"    => |s: &HourSample| s.precip_probability,
        "cloud_cover"           => |s: &HourSample| s.cloud_cover,
        _ => |_: &HourSample| None,
    }
}

fn extract_field(samples: &[HourSample], f: &FieldAcc) -> Vec<Option<f64>> {
    samples.iter().map(f).collect()
}

fn set_field(hour: &mut ForecastHour, name: &str, val: Option<f64>) {
    match name {
        "temperature_2m"        => hour.temperature_2m       = val,
        "apparent_temperature"  => hour.apparent_temperature = val,
        "relative_humidity_2m"  => hour.relative_humidity_2m = val,
        "dew_point_2m"          => hour.dew_point_2m         = val,
        "pressure_msl"          => hour.pressure_msl         = val,
        "wind_speed_10m"        => hour.wind_speed_10m       = val,
        "wind_gusts_10m"        => hour.wind_gusts_10m       = val,
        "wind_direction_10m"    => hour.wind_direction_10m   = val,
        "precipitation"         => hour.precipitation        = val,
        "precip_probability"    => hour.precip_probability   = val,
        "cloud_cover"           => hour.cloud_cover          = val,
        _ => {}
    }
}

// ────────────────────────────────────────────────────────────────────────────
// WASM bindings.
// ────────────────────────────────────────────────────────────────────────────

#[wasm_bindgen]
pub fn version() -> String { VERSION.to_string() }

/// Run the 24-hour forecast ensemble. Argument is a JS object matching the
/// `ForecastRequest` shape. Returns a JS object matching `ForecastResponse`.
#[wasm_bindgen]
pub fn forecast24(req: JsValue) -> Result<JsValue, JsError> {
    let req: ForecastRequest = serde_wasm_bindgen::from_value(req)
        .map_err(|e| JsError::new(&format!("invalid request: {e}")))?;
    let resp = run(req);
    serde_wasm_bindgen::to_value(&resp)
        .map_err(|e| JsError::new(&format!("serialization failed: {e}")))
}
