//! Solar feature extraction — live NASA/NOAA data → ML input vector.
//!
//! Transforms raw space weather observations into the 12-dimensional
//! normalised feature vector consumed by [`super::flare_ml::FlareMLPrediction`].
//!
//! # Data flow
//!
//! ```text
//! ┌──────────────────────────┐
//! │  NOAA / NASA APIs        │
//! │  (via Vercel Edge proxy) │
//! └──────────┬───────────────┘
//!            │ fetch (JS host page or native ureq)
//!            ▼
//! ┌──────────────────────────┐
//! │  SolarFeatures resource  │ ← updated every POLL_INTERVAL
//! │  (12 normalised floats)  │
//! └──────────┬───────────────┘
//!            │ read by
//!            ▼
//! ┌──────────────────────────┐
//! │  FlareMLPrediction       │ ← neural network inference
//! │  (class probs, CME prob) │
//! └──────────────────────────┘
//! ```
//!
//! # Feature definitions
//!
//! All features are normalised to approximately [0, 1] using physically
//! motivated clamp ranges.  See the module-level table in `flare_ml.rs`
//! for the complete list.

use bevy::prelude::*;

use super::flare_ml::N_FEATURES;

// ── Configuration ────────────────────────────────────────────────────────────

/// Seconds between feature refresh polls (native only).
const POLL_INTERVAL_SECS: u64 = 120;

/// Default API base URL for feature data.
pub const DEFAULT_API_BASE: &str = "http://localhost:8000/v1";

// ── Resource ─────────────────────────────────────────────────────────────────

/// Live solar features extracted from NASA/NOAA data streams.
///
/// Each field stores the latest normalised value for one ML input feature.
/// Updated by the background polling thread (native) or JS bridge (WASM).
#[derive(Resource, Debug, Clone)]
pub struct SolarFeatures {
    /// GOES X-ray flux (log₁₀ W/m²), normalised: -9 → 0.0, -3 → 1.0.
    pub xray_flux_norm: f32,
    /// X-ray flux time derivative (rising/falling), normalised [-1, 1].
    pub xray_deriv: f32,
    /// Solar wind speed, normalised: 250 km/s → 0.0, 900 km/s → 1.0.
    pub wind_speed_norm: f32,
    /// Wind speed trend: -1 = falling, 0 = steady, +1 = rising.
    pub wind_trend: f32,
    /// IMF Bz component, normalised: 0 = northward (quiet), 1 = strongly southward.
    pub bz_southward_norm: f32,
    /// Proton density, normalised: 0 = 1/cc, 1 = 25/cc.
    pub density_norm: f32,
    /// F10.7 radio flux, normalised: 65 sfu → 0.0, 300 sfu → 1.0.
    pub radio_flux_norm: f32,
    /// Active region count, normalised: 0 = none, 1 = 15+ regions.
    pub ar_count_norm: f32,
    /// Maximum AR magnetic classification complexity, normalised [0, 1].
    /// 0 = α (simple), 0.33 = β, 0.67 = βγ, 1.0 = βγδ (most complex).
    pub ar_mag_class_norm: f32,
    /// Recent flare rate (M+ flares per 24h), normalised: 0 = none, 1 = 10+.
    pub flare_rate_norm: f32,
    /// Hours since last M-class or stronger flare, normalised:
    /// 0 = just now, 1 = 48+ hours ago.
    pub hours_since_m_flare_norm: f32,
    /// Latest CME speed if any Earth-directed CME, normalised:
    /// 0 = no CME / 300 km/s, 1 = 3000 km/s.
    pub cme_speed_norm: f32,

    /// Age of the feature data (seconds since last update).
    pub age_secs: f32,

    // Native: receiving end of the background-thread channel.
    #[cfg(not(target_arch = "wasm32"))]
    receiver: crossbeam_channel::Receiver<RawFeatures>,
}

impl Default for SolarFeatures {
    fn default() -> Self {
        Self {
            xray_flux_norm: 0.33,       // ~C1 background
            xray_deriv: 0.0,
            wind_speed_norm: 0.31,      // ~450 km/s
            wind_trend: 0.0,
            bz_southward_norm: 0.0,     // northward (quiet)
            density_norm: 0.2,          // ~5/cc
            radio_flux_norm: 0.3,       // ~135 sfu (moderate cycle)
            ar_count_norm: 0.3,         // ~4-5 regions
            ar_mag_class_norm: 0.33,    // β class
            flare_rate_norm: 0.1,       // ~1 per day
            hours_since_m_flare_norm: 0.5, // ~24h ago
            cme_speed_norm: 0.0,        // no CME
            age_secs: 0.0,
            #[cfg(not(target_arch = "wasm32"))]
            receiver: crossbeam_channel::bounded(0).1,
        }
    }
}

impl SolarFeatures {
    /// Pack all features into the 12-element array expected by the ML model.
    pub fn as_array(&self) -> [f32; N_FEATURES] {
        [
            self.xray_flux_norm,
            self.xray_deriv,
            self.wind_speed_norm,
            self.wind_trend,
            self.bz_southward_norm,
            self.density_norm,
            self.radio_flux_norm,
            self.ar_count_norm,
            self.ar_mag_class_norm,
            self.flare_rate_norm,
            self.hours_since_m_flare_norm,
            self.cme_speed_norm,
        ]
    }
}

// ── Raw features (internal, pre-normalisation) ───────────────────────────────

/// Raw (un-normalised) feature values received from the API.
#[derive(Debug, Clone)]
struct RawFeatures {
    xray_flux_wm2: f64,      // W/m² (e.g. 1e-6 for C1)
    xray_deriv: f64,          // W/m²/min
    wind_speed_km_s: f64,
    wind_trend_slope: f64,    // km/s/min
    #[allow(non_snake_case)]
    bz_nT: f64,              // nT (negative = southward)
    density_cc: f64,          // #/cc
    radio_flux_sfu: f64,      // solar flux units
    ar_count: u32,
    ar_max_mag_class: u8,     // 0=α, 1=β, 2=βγ, 3=βγδ
    m_plus_flare_count_24h: u32,
    hours_since_m_flare: f64,
    cme_speed_km_s: f64,
}

impl RawFeatures {
    /// Normalise raw values to [0, 1] ranges for ML input.
    fn normalise(&self) -> SolarFeatures {
        let xray_log = if self.xray_flux_wm2 > 0.0 {
            self.xray_flux_wm2.log10()
        } else {
            -9.0
        };

        SolarFeatures {
            xray_flux_norm: ((xray_log + 9.0) / 6.0).clamp(0.0, 1.0) as f32,
            xray_deriv: (self.xray_deriv / 1e-6).clamp(-1.0, 1.0) as f32,
            wind_speed_norm: ((self.wind_speed_km_s - 250.0) / 650.0).clamp(0.0, 1.0) as f32,
            wind_trend: (self.wind_trend_slope / 10.0).clamp(-1.0, 1.0) as f32,
            bz_southward_norm: ((-self.bz_nT).max(0.0) / 30.0).clamp(0.0, 1.0) as f32,
            density_norm: (self.density_cc / 25.0).clamp(0.0, 1.0) as f32,
            radio_flux_norm: ((self.radio_flux_sfu - 65.0) / 235.0).clamp(0.0, 1.0) as f32,
            ar_count_norm: (self.ar_count as f32 / 15.0).clamp(0.0, 1.0),
            ar_mag_class_norm: (self.ar_max_mag_class as f32 / 3.0).clamp(0.0, 1.0),
            flare_rate_norm: (self.m_plus_flare_count_24h as f32 / 10.0).clamp(0.0, 1.0),
            hours_since_m_flare_norm: (self.hours_since_m_flare / 48.0).clamp(0.0, 1.0) as f32,
            cme_speed_norm: ((self.cme_speed_km_s - 300.0) / 2700.0).clamp(0.0, 1.0) as f32,
            age_secs: 0.0,
            #[cfg(not(target_arch = "wasm32"))]
            receiver: crossbeam_channel::bounded(0).1,
        }
    }
}

// ── WASM bridge ──────────────────────────────────────────────────────────────

#[cfg(target_arch = "wasm32")]
mod wasm_bridge {
    use std::sync::atomic::{AtomicU32, Ordering};

    /// 12 atomic slots for the normalised features.
    pub static FEATURES: [AtomicU32; 12] = [
        AtomicU32::new(0), AtomicU32::new(0), AtomicU32::new(0), AtomicU32::new(0),
        AtomicU32::new(0), AtomicU32::new(0), AtomicU32::new(0), AtomicU32::new(0),
        AtomicU32::new(0), AtomicU32::new(0), AtomicU32::new(0), AtomicU32::new(0),
    ];

    pub fn set(index: usize, value: f32) {
        if index < 12 {
            FEATURES[index].store(value.to_bits(), Ordering::Relaxed);
        }
    }

    pub fn get_all() -> [f32; 12] {
        let mut out = [0.0_f32; 12];
        for (i, atom) in FEATURES.iter().enumerate() {
            out[i] = f32::from_bits(atom.load(Ordering::Relaxed));
        }
        out
    }
}

/// JavaScript-callable function to push a single normalised feature value.
///
/// Usage from JS:
/// ```js
/// // After fetching /api/noaa/xray:
/// wasm.set_solar_feature(0, normalised_xray_flux);
/// ```
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn set_solar_feature(index: u32, value: f32) {
    wasm_bridge::set(index as usize, value);
}

/// JavaScript-callable function to push all 12 features at once.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn set_solar_features(features: &[f32]) {
    for (i, &v) in features.iter().enumerate().take(12) {
        wasm_bridge::set(i, v);
    }
}

// ── Native: background polling thread ────────────────────────────────────────

#[cfg(not(target_arch = "wasm32"))]
fn start_feature_poll_thread(tx: crossbeam_channel::Sender<RawFeatures>) {
    use std::time::Duration;

    let base_url = std::env::var("FEATURE_API_BASE")
        .unwrap_or_else(|_| DEFAULT_API_BASE.to_string());

    std::thread::Builder::new()
        .name("feature-extract-poll".into())
        .spawn(move || loop {
            match fetch_features(&base_url) {
                Ok(raw) => {
                    let _ = tx.send(raw);
                }
                Err(e) => {
                    eprintln!("[feature-extract] poll error: {e}");
                }
            }
            std::thread::sleep(Duration::from_secs(POLL_INTERVAL_SECS));
        })
        .expect("failed to spawn feature-extract-poll thread");
}

/// Fetch all feature data from the various API endpoints.
#[cfg(not(target_arch = "wasm32"))]
fn fetch_features(base_url: &str) -> Result<RawFeatures, String> {
    // Fetch solar wind data (has speed, density, Bz, trend).
    let wind_url = format!("{}/solar-wind/wind-speed", base_url);
    let wind: serde_json::Value = ureq::get(&wind_url)
        .call()
        .map_err(|e| format!("wind fetch: {e}"))?
        .into_json()
        .map_err(|e| format!("wind parse: {e}"))?;

    let current = &wind["data"]["current"];
    let trend = &wind["data"]["trend"];

    let wind_speed = current["speed_km_s"].as_f64().unwrap_or(450.0);
    let density = current["density_cc"].as_f64().unwrap_or(5.0);
    let bz = current["bz_nT"].as_f64().unwrap_or(0.0);
    let trend_slope = trend["slope_km_s_per_min"].as_f64().unwrap_or(0.0);

    // Use defaults for features that require additional API calls.
    // In production, these would come from separate endpoints.
    let raw = RawFeatures {
        xray_flux_wm2: 1e-7,        // B1 background (default)
        xray_deriv: 0.0,
        wind_speed_km_s: wind_speed,
        wind_trend_slope: trend_slope,
        bz_nT: bz,
        density_cc: density,
        radio_flux_sfu: 120.0,       // moderate default
        ar_count: 4,                 // default
        ar_max_mag_class: 1,         // β
        m_plus_flare_count_24h: 0,
        hours_since_m_flare: 48.0,
        cme_speed_km_s: 0.0,
    };

    Ok(raw)
}

// ── Bevy plugin ──────────────────────────────────────────────────────────────

/// Plugin that wires live NASA/NOAA feature extraction into the simulation.
pub struct SolarFeaturesPlugin;

impl Plugin for SolarFeaturesPlugin {
    fn build(&self, app: &mut App) {
        #[cfg(not(target_arch = "wasm32"))]
        {
            let (tx, rx) = crossbeam_channel::bounded(8);
            start_feature_poll_thread(tx);
            let mut features = SolarFeatures::default();
            features.receiver = rx;
            app.insert_resource(features);
        }

        #[cfg(target_arch = "wasm32")]
        app.insert_resource(SolarFeatures::default());

        app.add_systems(Update, update_solar_features);
    }
}

// ── Bevy system ──────────────────────────────────────────────────────────────

/// Reads the latest features from the background thread (native) or
/// WASM atomic store, and updates the [`SolarFeatures`] resource.
pub fn update_solar_features(time: Res<Time>, mut features: ResMut<SolarFeatures>) {
    features.age_secs += time.delta_secs();

    #[cfg(not(target_arch = "wasm32"))]
    {
        let mut latest: Option<RawFeatures> = None;
        while let Ok(raw) = features.receiver.try_recv() {
            latest = Some(raw);
        }
        if let Some(raw) = latest {
            let normalised = raw.normalise();
            features.xray_flux_norm = normalised.xray_flux_norm;
            features.xray_deriv = normalised.xray_deriv;
            features.wind_speed_norm = normalised.wind_speed_norm;
            features.wind_trend = normalised.wind_trend;
            features.bz_southward_norm = normalised.bz_southward_norm;
            features.density_norm = normalised.density_norm;
            features.radio_flux_norm = normalised.radio_flux_norm;
            features.ar_count_norm = normalised.ar_count_norm;
            features.ar_mag_class_norm = normalised.ar_mag_class_norm;
            features.flare_rate_norm = normalised.flare_rate_norm;
            features.hours_since_m_flare_norm = normalised.hours_since_m_flare_norm;
            features.cme_speed_norm = normalised.cme_speed_norm;
            features.age_secs = 0.0;
        }
    }

    #[cfg(target_arch = "wasm32")]
    {
        let vals = wasm_bridge::get_all();
        // Only update if JS has pushed non-zero values.
        if vals.iter().any(|&v| v != 0.0) {
            features.xray_flux_norm = vals[0];
            features.xray_deriv = vals[1];
            features.wind_speed_norm = vals[2];
            features.wind_trend = vals[3];
            features.bz_southward_norm = vals[4];
            features.density_norm = vals[5];
            features.radio_flux_norm = vals[6];
            features.ar_count_norm = vals[7];
            features.ar_mag_class_norm = vals[8];
            features.flare_rate_norm = vals[9];
            features.hours_since_m_flare_norm = vals[10];
            features.cme_speed_norm = vals[11];
            features.age_secs = 0.0;
        }
    }
}
