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
use std::collections::BTreeMap;
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

/// One NWP provider's hourly forecast. Each provider produces two ensemble
/// members: a raw passthrough (`nwp_<name>`) and a bias-corrected variant
/// (`nwp_bc_<name>`). Adding ICON / GEM / JMA alongside GFS + ECMWF needs
/// no algorithm change — the softmax blender auto-discovers per-location
/// skill from the recent obs window.
///
/// `name` is a short identifier used to build the member labels. Stick to
/// lower-case ASCII without spaces; the wire format and skill JSON expose
/// it verbatim.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct NwpProvider {
    pub name:    String,
    pub samples: Vec<HourSample>,
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
    /// One entry per NWP provider (GFS, ECMWF, ICON, …). An empty vec is
    /// legal — the ensemble degrades gracefully to obs-only members
    /// (persist + diurnal + AR1).
    pub nwp:     Vec<NwpProvider>,
    pub config:  Option<ForecastConfig>,
}

/// One predicted hour from the ensemble. Scalar fields carry the weighted-
/// mean ("best estimate") consensus across members; the `quantiles` map
/// carries the corresponding P10/P50/P90 spread for each scalar field
/// (skipped for circular fields like wind direction). The UI renders the
/// scalar as a center line and the quantile band as an uncertainty cloud.
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
    /// Wind directional uncertainty in degrees: angular standard deviation
    /// across members after u/v decomposition (so 350°/10°/0° produce a
    /// small σ, not 180°). Useful for fan-shaped UI plots.
    pub wind_direction_sigma: Option<f64>,
    /// Per-hour confidence ∈ [0, 1] derived from normalized inter-member
    /// quantile spread (P90 − P10) divided by per-field scale.
    pub confidence:           f64,
    /// Field name → [P10, P50, P90]. BTreeMap keeps the JSON output ordered
    /// alphabetically — important so the WASM and Python paths produce
    /// byte-identical output for tests.
    pub quantiles:            BTreeMap<String, [f64; 3]>,
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

pub const VERSION: &str = "0.2.0";

/// Number of obs-only ensemble members. They run regardless of whether any
/// NWP provider is present: persist (0), diurnal (1), AR1 (2). NWP raw and
/// NWP_BC members are appended after these for each provider.
pub const NUM_OBS_MEMBERS: usize = 3;

/// Build the per-run member name list. Order matches the prediction /
/// weight / skill arrays everywhere downstream:
///
///   [0]                              persist
///   [1]                              diurnal
///   [2]                              ar1
///   [3 .. 3 + N]                     nwp_<name_i>           (raw)
///   [3 + N .. 3 + 2N]                nwp_bc_<name_i>        (bias-corrected)
///
/// where N = providers.len(). The blender treats every member uniformly —
/// each one is just a (Vec<f64>, weight) pair scored against the recent
/// obs window. Providers contribute exactly one raw + one BC member each.
pub fn member_names(providers: &[NwpProvider]) -> Vec<String> {
    let mut names = Vec::with_capacity(NUM_OBS_MEMBERS + 2 * providers.len());
    names.push("persist".to_string());
    names.push("diurnal".to_string());
    names.push("ar1".to_string());
    for p in providers { names.push(format!("nwp_{}", p.name)); }
    for p in providers { names.push(format!("nwp_bc_{}", p.name)); }
    names
}

/// Quantile breakpoints emitted in `ForecastHour::quantiles`. Choosing
/// 10/50/90 gives an 80 % central credibility band — the most common UI
/// rendering. Add 5/95 here later if a tighter probabilistic story is
/// needed; the underlying `weighted_quantiles` is generic.
pub const QUANTILES: [f64; 3] = [0.10, 0.50, 0.90];

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
    let mut providers = req.nwp.clone();
    for p in providers.iter_mut() {
        p.samples.sort_by(|a, b| a.t.partial_cmp(&b.t).unwrap());
    }
    let num_providers = providers.len();
    let num_members   = NUM_OBS_MEMBERS + 2 * num_providers;
    let names         = member_names(&providers);

    // The forecast grid is hourly aligned to t0_unix.
    let grid: Vec<f64> = (0..horizon).map(|h| req.t0_unix + h as f64 * 3600.0).collect();

    // Scalar fields forecast independently. wind_direction_10m is in this
    // list so it gets per-member predictions populated, but we skip the
    // scalar-mean blender for it in Phase 2 — the u/v pass (Phase 3) is
    // the source of truth for direction since linear averaging of
    // direction is wrong (350° + 10° → 180°, not 0°).
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

    // ── Phase 1 ──────────────────────────────────────────────────────────
    // For every field, run all members (3 obs-only + 2 per provider) against
    // the full grid, score them on the recent obs window, and record
    // (predictions, weights). We keep the per-member predictions around
    // because Phase 3 needs them for the wind u/v decomposition — that
    // pass blends u and v across members using each member's own
    // (speed_i, dir_i) pair, which can't be recovered from a post-blended
    // scalar.
    let mut predictions: BTreeMap<&str, Vec<Vec<Option<f64>>>> = BTreeMap::new();
    let mut weights:     BTreeMap<&str, Vec<f64>>              = BTreeMap::new();

    for fname in &fields {
        let f = field_accessor(fname);
        let obs_y = extract_field(&obs, &f);

        // Per-provider field extractions used for both the forecast pass
        // and the scoring pass.
        let provider_fields: Vec<Vec<Option<f64>>> = providers.iter()
            .map(|p| extract_field(&p.samples, &f))
            .collect();

        // Skip fields where neither obs nor any provider has data.
        let any_provider_data = provider_fields.iter().any(|v| v.iter().any(|x| x.is_some()));
        if obs_y.iter().all(|v| v.is_none()) && !any_provider_data {
            continue;
        }

        let mut preds: Vec<Vec<Option<f64>>> = Vec::with_capacity(num_members);
        // Obs-only members (indices 0, 1, 2).
        preds.push(members::persist::predict_24h(&obs, &obs_y, &grid));
        preds.push(members::diurnal::predict_24h(&obs, &obs_y, &grid, req.lat, req.lon, &cfg));
        preds.push(members::ar1::predict_24h    (&obs, &obs_y, &grid, &cfg));
        // Per-provider raw NWP members (indices 3 .. 3+N).
        for (pi, p) in providers.iter().enumerate() {
            preds.push(members::nwp_raw::predict_24h(&p.samples, &provider_fields[pi], &grid));
        }
        // Per-provider bias-corrected NWP members (indices 3+N .. 3+2N).
        for (pi, p) in providers.iter().enumerate() {
            preds.push(members::nwp_bc::predict_24h(
                &obs, &obs_y, &p.samples, &provider_fields[pi], &grid, &cfg,
            ));
        }

        let rmses = stats::score_members(
            &obs, &obs_y, &providers,
            req.lat, req.lon, &cfg, fname,
        );
        let w = stats::softmax_neg(&rmses, cfg.blend_temp);

        for (i, name) in names.iter().enumerate() {
            skills.push(MemberSkill {
                name:   format!("{}::{}", fname, name),
                rmse:   rmses[i],
                weight: w[i],
            });
        }
        predictions.insert(fname, preds);
        weights.insert(fname, w);
    }

    // ── Phase 2 ──────────────────────────────────────────────────────────
    // Scalar-blend each non-circular field: weighted mean for the central
    // estimate, weighted P10/P50/P90 for the uncertainty band, and a
    // confidence contribution from the normalized P90−P10 spread.
    let mut conf_n = 0_usize;
    for fname in &fields {
        if *fname == "wind_direction_10m" { continue; }
        let preds = match predictions.get(fname) { Some(p) => p, None => continue };
        let w     = &weights[fname];
        let scale = stats::field_scale(fname);

        for (h, hour) in hours.iter_mut().enumerate() {
            // Collect (value, weight) pairs from members that produced a
            // non-null prediction for this hour.
            let mut vw: Vec<(f64, f64)> = (0..num_members)
                .filter_map(|i| preds[i][h].map(|v| (v, w[i])))
                .collect();
            if vw.is_empty() { continue; }

            // Weighted mean → "best estimate".
            let den: f64 = vw.iter().map(|(_, w)| *w).sum();
            if den <= 1e-12 { continue; }
            let mean = vw.iter().map(|(v, w)| v * w).sum::<f64>() / den;
            set_field(hour, fname, Some(mean));

            // Weighted quantiles → uncertainty band.
            let qs = stats::weighted_quantiles(&mut vw, &QUANTILES);
            hour.quantiles.insert(fname.to_string(), [qs[0], qs[1], qs[2]]);

            // Confidence contribution from this field. (P90 − P10) / scale
            // bounded to [0, 1]; we average across fields at the end.
            let band = (qs[2] - qs[0]).max(0.0);
            hour.confidence += 1.0 - (band / scale).clamp(0.0, 1.0);
        }
        conf_n += 1;
    }
    if conf_n > 0 {
        for hour in hours.iter_mut() {
            hour.confidence /= conf_n as f64;
        }
    }

    // ── Phase 3 ──────────────────────────────────────────────────────────
    // Wind u/v pass — fixes the circular-averaging bug. For each member we
    // form (u_i, v_i) = (-s_i sin θ_i, -s_i cos θ_i), blend u and v with
    // the same softmax weights derived for wind_direction_10m, and recover
    // the consensus direction via atan2. Speed quantiles already came from
    // Phase 2; here we additionally emit a directional σ in degrees,
    // computed from the cross-member spread of the unit vector — it stays
    // small near 0°/360° crossings (which the linear average cannot).
    if let (Some(sp), Some(dr)) = (predictions.get("wind_speed_10m"),
                                   predictions.get("wind_direction_10m")) {
        // Use direction's weights when available; fall back to speed's;
        // last resort is uniform weighting across whatever members ran.
        let uniform: Vec<f64> = vec![1.0 / num_members.max(1) as f64; num_members];
        let w: &Vec<f64> = weights.get("wind_direction_10m")
            .or_else(|| weights.get("wind_speed_10m"))
            .unwrap_or(&uniform);

        for (h, hour) in hours.iter_mut().enumerate() {
            let mut uvw: Vec<(f64, f64, f64)> = Vec::with_capacity(num_members);
            for i in 0..num_members {
                if let (Some(s), Some(d)) = (sp[i][h], dr[i][h]) {
                    let r = d.to_radians();
                    uvw.push((-s * r.sin(), -s * r.cos(), w[i]));
                }
            }
            if uvw.is_empty() { continue; }

            let den: f64 = uvw.iter().map(|x| x.2).sum();
            if den <= 1e-12 { continue; }
            let u_b = uvw.iter().map(|(u, _, w)| u * w).sum::<f64>() / den;
            let v_b = uvw.iter().map(|(_, v, w)| v * w).sum::<f64>() / den;

            // atan2(-u, -v): convert "blowing-toward" components back to
            // "coming-from" meteorological direction in [0°, 360°).
            let dir = ((-u_b).atan2(-v_b).to_degrees() + 360.0) % 360.0;
            hour.wind_direction_10m = Some(dir);

            // Directional spread: angular σ from unit-vector dispersion.
            // Each member's unit wind vector contributes (cos α, sin α);
            // the magnitude of the *mean* unit vector R ∈ [0, 1] reflects
            // angular concentration. σ_deg = √(−2 ln R) in radians, then
            // clamped to a sensible 0–180° range.
            let mut cs = 0.0;
            let mut sn = 0.0;
            let mut wsum = 0.0;
            for (u, v, w) in &uvw {
                let mag = (u * u + v * v).sqrt();
                if mag < 1e-9 { continue; }
                cs += w * (-v / mag);   // cos(direction_from)
                sn += w * (-u / mag);   // sin(direction_from)
                wsum += w;
            }
            if wsum > 1e-9 {
                let r = ((cs / wsum).powi(2) + (sn / wsum).powi(2)).sqrt().min(1.0);
                let sigma_rad = if r > 1e-6 { (-2.0 * r.ln()).sqrt() } else { std::f64::consts::PI };
                hour.wind_direction_sigma = Some(sigma_rad.to_degrees().min(180.0));
            }
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

// ────────────────────────────────────────────────────────────────────────────
// Smoke tests — validate the most subtle bits of the algorithm. Run with
// `cargo test` (host target — wasm32 doesn't run unit tests).
// ────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// Linear averaging would give 180°. u/v decomposition must give ~0°
    /// (i.e. close to 0 or 360).
    #[test]
    fn wind_uv_handles_zero_crossing() {
        let t0 = 1_700_000_000.0_f64;
        // 48 obs hours, all wind from ~0° at 10 mph (alternating 350°/10°).
        let obs: Vec<HourSample> = (0..48)
            .map(|i| HourSample {
                t: t0 - (48 - i) as f64 * 3600.0,
                wind_speed_10m:     Some(10.0),
                wind_direction_10m: Some(if i % 2 == 0 { 350.0 } else { 10.0 }),
                ..Default::default()
            })
            .collect();
        // NWP says wind from 5° at 10 mph for the next 24 h.
        let gfs: Vec<HourSample> = (0..24)
            .map(|i| HourSample {
                t: t0 + i as f64 * 3600.0,
                wind_speed_10m:     Some(10.0),
                wind_direction_10m: Some(5.0),
                ..Default::default()
            })
            .collect();

        let resp = run(ForecastRequest {
            lat: 40.0, lon: -75.0, t0_unix: t0,
            obs,
            nwp: vec![NwpProvider { name: "gfs".into(), samples: gfs }],
            config: None,
        });

        let dir0 = resp.hours[0].wind_direction_10m.expect("direction");
        // Pass if within 30° of 0/360 (the broken linear blend would be ~180°).
        let folded = dir0.min((dir0 - 360.0).abs());
        assert!(folded < 30.0, "direction should land near 0°, got {dir0}°");
    }

    /// Quantiles must satisfy P10 ≤ P50 ≤ P90 for any field that emits them.
    #[test]
    fn quantiles_are_monotone() {
        let t0 = 1_700_000_000.0_f64;
        let obs: Vec<HourSample> = (0..72)
            .map(|i| HourSample {
                t: t0 - (72 - i) as f64 * 3600.0,
                temperature_2m: Some(60.0 + (i as f64 * 0.5).sin() * 8.0),
                ..Default::default()
            })
            .collect();
        let gfs: Vec<HourSample> = (0..24)
            .map(|i| HourSample {
                t: t0 + i as f64 * 3600.0,
                temperature_2m: Some(62.0 + i as f64 * 0.1),
                ..Default::default()
            })
            .collect();
        let resp = run(ForecastRequest {
            lat: 40.0, lon: -75.0, t0_unix: t0,
            obs,
            nwp: vec![NwpProvider { name: "gfs".into(), samples: gfs }],
            config: None,
        });
        for hour in &resp.hours {
            if let Some(q) = hour.quantiles.get("temperature_2m") {
                assert!(q[0] <= q[1] + 1e-9, "P10 > P50: {q:?}");
                assert!(q[1] <= q[2] + 1e-9, "P50 > P90: {q:?}");
            }
        }
    }

    /// Multi-provider ensemble: when one model is consistently right and
    /// another is consistently wrong on the recent obs window, the softmax
    /// blender must up-weight the accurate one. This is the whole point of
    /// running multiple NWP providers — auto-discovery of per-location skill.
    #[test]
    fn multi_provider_skill_weighting() {
        let t0 = 1_700_000_000.0_f64;
        // 48 hours of "ground truth" temperature, smoothly varying.
        let truth = |t: f64| 60.0 + 8.0 * ((t - t0) / 3600.0 * 0.2).sin();
        let obs: Vec<HourSample> = (0..48)
            .map(|i| {
                let t = t0 - (48 - i) as f64 * 3600.0;
                HourSample { t, temperature_2m: Some(truth(t)), ..Default::default() }
            })
            .collect();

        // "Good" provider tracks truth almost perfectly across the score
        // window AND the forecast horizon. "Bad" provider is offset +20°F
        // everywhere — large, persistent bias that's bigger than the
        // bias-correction member can fully absorb in a 12-hour window.
        let mk_provider = |name: &str, offset: f64| {
            let samples: Vec<HourSample> = (0..72)
                .map(|i| {
                    // Cover the score window (past 24 h of obs) AND the next
                    // 24 h of forecast horizon.
                    let t = t0 - 48.0 * 3600.0 + i as f64 * 3600.0;
                    HourSample { t, temperature_2m: Some(truth(t) + offset), ..Default::default() }
                })
                .collect();
            NwpProvider { name: name.into(), samples }
        };

        let resp = run(ForecastRequest {
            lat: 40.0, lon: -75.0, t0_unix: t0,
            obs,
            nwp: vec![mk_provider("good", 0.0), mk_provider("bad", 20.0)],
            config: None,
        });

        // Pull skill rows for temperature_2m. Member labels:
        //   nwp_good (raw), nwp_bad (raw), nwp_bc_good, nwp_bc_bad.
        let weight_for = |label: &str| -> f64 {
            resp.skill.iter()
                .find(|s| s.name == format!("temperature_2m::{label}"))
                .map(|s| s.weight)
                .unwrap_or(0.0)
        };
        let w_good = weight_for("nwp_good");
        let w_bad  = weight_for("nwp_bad");
        assert!(w_good > w_bad,
            "good provider must outweigh bad: w_good={w_good} w_bad={w_bad}");
        // Sanity: skill rows for both providers exist and sum across all
        // members for this field is ~1.0.
        let total: f64 = resp.skill.iter()
            .filter(|s| s.name.starts_with("temperature_2m::"))
            .map(|s| s.weight)
            .sum();
        assert!((total - 1.0).abs() < 1e-6,
            "weights for temperature_2m must sum to 1, got {total}");
    }

    /// Determinism: identical inputs must produce identical outputs.
    /// Catches non-deterministic iteration (HashMap, etc.) before it
    /// breaks the Python-vs-WASM golden test.
    #[test]
    fn deterministic_runs() {
        let t0 = 1_700_000_000.0_f64;
        let obs: Vec<HourSample> = (0..48)
            .map(|i| HourSample {
                t: t0 - (48 - i) as f64 * 3600.0,
                temperature_2m: Some(50.0 + i as f64 * 0.1),
                pressure_msl:   Some(1013.0),
                ..Default::default()
            })
            .collect();
        let r1 = run(ForecastRequest {
            lat: 40.0, lon: -75.0, t0_unix: t0,
            obs: obs.clone(), nwp: vec![], config: None,
        });
        let r2 = run(ForecastRequest {
            lat: 40.0, lon: -75.0, t0_unix: t0,
            obs, nwp: vec![], config: None,
        });
        for (a, b) in r1.hours.iter().zip(&r2.hours) {
            assert_eq!(a.temperature_2m, b.temperature_2m);
            assert_eq!(a.quantiles.get("temperature_2m"),
                       b.quantiles.get("temperature_2m"));
        }
    }
}
