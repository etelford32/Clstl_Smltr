//! Live solar wind speed integration — [`LiveWindPlugin`].
//!
//! Bridges the Parker Physics NOAA pipeline into the Bevy simulation so that
//! particle speeds and the velocity-field scale respond to real observed data.
//!
//! # Architecture
//!
//! **Native desktop build** — a background OS thread polls the results API
//! every [`POLL_INTERVAL_SECS`] seconds using [`ureq`] (blocking HTTP).
//! Readings arrive in the main thread via a [`crossbeam_channel`] and are
//! applied to the [`LiveWindSpeed`] resource inside [`update_live_wind`].
//!
//! **WebAssembly build** — fetching from Rust/WASM is complex and
//! platform-specific.  Instead we expose the public JS function
//! [`set_live_wind_speed`] (via `wasm-bindgen`) so the host page can poll
//! the API with a simple `fetch()` call and push the result directly into the
//! running simulation:
//!
//! ```js
//! // Paste into browser console or host-page script:
//! setInterval(() =>
//!   fetch('/v1/solar-wind/wind-speed')
//!     .then(r => r.json())
//!     .then(d => wasm.set_live_wind_speed(
//!         d.data.current.speed_norm,
//!         d.data.current.speed_km_s)),
//!   60_000);
//! ```

use bevy::prelude::*;

// ── Config ────────────────────────────────────────────────────────────────────

/// Default API endpoint.  Overridden by `WIND_API_URL` environment variable.
pub const DEFAULT_API_URL: &str = "http://localhost:8000/v1/solar-wind/wind-speed";

/// Seconds between background polls (native only).
const POLL_INTERVAL_SECS: u64 = 60;

// ── WindReading (shared between native channel and WASM atomics) ──────────────

#[derive(Debug, Clone, Copy)]
pub struct WindReading {
    /// Normalised 0–1 where 0 = 250 km/s and 1 = 900 km/s.
    pub speed_norm: f32,
    /// Raw speed in km/s for logging / UI display.
    pub speed_km_s: f32,
}

// ── Resource ──────────────────────────────────────────────────────────────────

/// Current live solar wind speed exposed as a Bevy resource.
///
/// The simulation reads [`speed_norm`] each frame to scale the radial
/// outflow in [`crate::simulation::fluid::VelocityField`].
#[derive(Resource)]
pub struct LiveWindSpeed {
    /// Normalised wind speed (0 = calm / 250 km/s, 1 = storm / 900 km/s).
    pub speed_norm: f32,
    /// Raw speed in km/s (for HUD / debug display).
    pub speed_km_s: f32,
    /// Seconds elapsed since the last successful update (staleness indicator).
    pub age_secs: f32,

    /// Alert level string received from the pipeline ("QUIET" … "EXTREME").
    pub alert_level: &'static str,

    // Native only: receiving end of the background-thread channel.
    #[cfg(not(target_arch = "wasm32"))]
    receiver: crossbeam_channel::Receiver<WindReading>,
}

impl LiveWindSpeed {
    /// Construct a resource with nominal defaults (quiet solar wind ~450 km/s).
    #[cfg(not(target_arch = "wasm32"))]
    fn new(receiver: crossbeam_channel::Receiver<WindReading>) -> Self {
        Self {
            speed_norm: 0.5,
            speed_km_s: 450.0,
            age_secs: 0.0,
            alert_level: "QUIET",
            receiver,
        }
    }
}

impl Default for LiveWindSpeed {
    fn default() -> Self {
        Self {
            speed_norm: 0.5,
            speed_km_s: 450.0,
            age_secs: 0.0,
            alert_level: "QUIET",
            #[cfg(not(target_arch = "wasm32"))]
            // Placeholder; real receiver inserted by the plugin.
            receiver: crossbeam_channel::bounded(0).1,
        }
    }
}

// ── WASM: JS bridge ───────────────────────────────────────────────────────────

#[cfg(target_arch = "wasm32")]
mod wasm_bridge {
    use std::sync::atomic::{AtomicU32, Ordering};

    // Atomic storage for the two f32 values (encoded as their raw bit patterns).
    // Defaults: speed_norm = 0.5  (0x3F00_0000)
    //           speed_km_s = 450.0 (0x43E1_0000)
    pub static SPEED_NORM: AtomicU32 = AtomicU32::new(0x3F00_0000);
    pub static SPEED_KM_S: AtomicU32 = AtomicU32::new(0x43E1_0000);

    pub fn get() -> (f32, f32) {
        (
            f32::from_bits(SPEED_NORM.load(Ordering::Relaxed)),
            f32::from_bits(SPEED_KM_S.load(Ordering::Relaxed)),
        )
    }

    pub fn set(norm: f32, km_s: f32) {
        SPEED_NORM.store(norm.to_bits(), Ordering::Relaxed);
        SPEED_KM_S.store(km_s.to_bits(), Ordering::Relaxed);
    }
}

/// JavaScript-callable entry point for the WASM build.
///
/// The host page calls this after every successful API fetch so the simulation
/// can respond immediately without waiting for an internal polling loop.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn set_live_wind_speed(speed_norm: f32, speed_km_s: f32) {
    wasm_bridge::set(speed_norm, speed_km_s);
}

// ── Native: background polling thread ────────────────────────────────────────

#[cfg(not(target_arch = "wasm32"))]
fn start_poll_thread(tx: crossbeam_channel::Sender<WindReading>) {
    use std::time::Duration;

    let url = std::env::var("WIND_API_URL")
        .unwrap_or_else(|_| DEFAULT_API_URL.to_string());

    std::thread::Builder::new()
        .name("wind-speed-poll".into())
        .spawn(move || loop {
            match ureq::get(&url).call() {
                Ok(resp) => match resp.into_json::<serde_json::Value>() {
                    Ok(body) => {
                        let data = &body["data"]["current"];
                        let norm = data["speed_norm"].as_f64().unwrap_or(0.5) as f32;
                        let km_s = data["speed_km_s"].as_f64().unwrap_or(450.0) as f32;
                        let norm = norm.clamp(0.0, 1.0);
                        let _ = tx.send(WindReading {
                            speed_norm: norm,
                            speed_km_s: km_s,
                        });
                    }
                    Err(e) => eprintln!("[wind-speed] JSON parse error: {e}"),
                },
                Err(e) => eprintln!("[wind-speed] poll failed ({e}) — using last value"),
            }
            std::thread::sleep(Duration::from_secs(POLL_INTERVAL_SECS));
        })
        .expect("failed to spawn wind-speed-poll thread");
}

// ── Bevy plugin ───────────────────────────────────────────────────────────────

/// Bevy plugin that wires the live NOAA wind speed data into the simulation.
///
/// Add to your [`App`] with `.add_plugins(LiveWindPlugin)`.
pub struct LiveWindPlugin;

impl Plugin for LiveWindPlugin {
    fn build(&self, app: &mut App) {
        // Native: start background thread + register resource with channel.
        #[cfg(not(target_arch = "wasm32"))]
        {
            let (tx, rx) = crossbeam_channel::bounded(32);
            start_poll_thread(tx);
            app.insert_resource(LiveWindSpeed::new(rx));
        }

        // WASM: register default resource; JS drives it via set_live_wind_speed().
        #[cfg(target_arch = "wasm32")]
        app.insert_resource(LiveWindSpeed::default());

        app.add_systems(Update, update_live_wind);
    }
}

// ── Bevy system ───────────────────────────────────────────────────────────────

/// Drains the latest wind reading from the background thread (native) or the
/// WASM atomic store (WASM) and updates the [`LiveWindSpeed`] resource.
///
/// Runs every frame; the system is cheap because it only reads from a
/// non-blocking channel and never blocks on I/O.
pub fn update_live_wind(time: Res<Time>, mut wind: ResMut<LiveWindSpeed>) {
    wind.age_secs += time.delta_secs();

    #[cfg(not(target_arch = "wasm32"))]
    {
        // Drain all pending messages; keep only the latest.
        let mut latest: Option<WindReading> = None;
        while let Ok(reading) = wind.receiver.try_recv() {
            latest = Some(reading);
        }
        if let Some(r) = latest {
            wind.speed_norm = r.speed_norm;
            wind.speed_km_s = r.speed_km_s;
            wind.age_secs = 0.0;
            wind.alert_level = classify_alert(r.speed_norm);
            println!(
                "[wind-speed] Live: {:.0} km/s (norm={:.3}, alert={})",
                r.speed_km_s, r.speed_norm, wind.alert_level
            );
        }
    }

    #[cfg(target_arch = "wasm32")]
    {
        let (norm, km_s) = wasm_bridge::get();
        wind.speed_norm = norm;
        wind.speed_km_s = km_s;
        wind.alert_level = classify_alert(norm);
        // age_secs keeps incrementing on WASM; JS should call set_live_wind_speed
        // each minute to indicate the data is fresh.
    }
}

/// Map normalised speed to a human-readable alert string.
fn classify_alert(norm: f32) -> &'static str {
    // norm 0→1 maps to 250→900 km/s.
    // QUIET < 400 km/s  → norm < ~0.23
    // MODERATE 400–600  → 0.23–0.54
    // HIGH 600–800      → 0.54–0.85
    // EXTREME ≥ 800     → ≥ 0.85
    if norm >= 0.85 {
        "EXTREME"
    } else if norm >= 0.54 {
        "HIGH"
    } else if norm >= 0.23 {
        "MODERATE"
    } else {
        "QUIET"
    }
}
