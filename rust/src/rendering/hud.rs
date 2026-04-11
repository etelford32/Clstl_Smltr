//! HUD overlay — wind speed, flare prediction, and flux rope status.
//!
//! Renders a monospace text panel in the top-left corner of the window
//! showing live solar data, ML flare prediction, and flux rope state.
//!
//! Layout:
//! ```text
//! ┌──────────────────────────────┐
//! │ WIND   450 km/s              │
//! │ ALERT  MODERATE              │
//! │ TREND  → STEADY              │
//! │ DATA   LIVE                  │
//! │ ──────────────────           │
//! │ FLARE  M 12.3%  CME 4.1%    │
//! │ ROPE 1 EMERGING  E=2.3      │
//! │ ROPE 2 ERUPTING  X1.4       │
//! └──────────────────────────────┘
//! ```

use bevy::prelude::*;

use crate::prediction::feature_extract::SolarFeatures;
use crate::prediction::flare_ml::FlareMLPrediction;
use crate::prediction::solar_wind::LiveWindSpeed;
use crate::simulation::flux_rope::{FluxRopeSet, RopePhase};

// ── Marker component ──────────────────────────────────────────────────────────

/// Marks the Text entity that shows the wind speed HUD.
#[derive(Component)]
pub struct WindHudText;

// ── Setup ─────────────────────────────────────────────────────────────────────

/// Spawns the HUD panel as a UI overlay anchored to the top-left corner.
pub fn setup_hud(mut commands: Commands) {
    // Root node — absolutely positioned, top-left corner.
    commands
        .spawn((
            Node {
                position_type: PositionType::Absolute,
                top:    Val::Px(10.0),
                left:   Val::Px(10.0),
                padding: UiRect::all(Val::Px(7.0)),
                ..default()
            },
            BackgroundColor(Color::srgba(0.0, 0.02, 0.10, 0.72)),
            BorderRadius::all(Val::Px(5.0)),
        ))
        .with_children(|parent| {
            parent.spawn((
                Text::new(
                    "WIND   connecting…\nALERT  —\nTREND  —\nDATA   offline\n\
                     ──────────────\nFLARE  —\nROPE   —",
                ),
                TextFont {
                    font_size: 12.5,
                    ..default()
                },
                TextColor(Color::srgb(0.55, 0.85, 1.0)),
                WindHudText,
            ));
        });
}

// ── Update ────────────────────────────────────────────────────────────────────

/// Refreshes the HUD text every frame from live resources.
pub fn update_hud(
    wind: Res<LiveWindSpeed>,
    prediction: Res<FlareMLPrediction>,
    features: Option<Res<SolarFeatures>>,
    ropes: Res<FluxRopeSet>,
    mut query: Query<&mut Text, With<WindHudText>>,
) {
    // Refresh when any data source changes.
    if !wind.is_changed() && !prediction.is_changed() && !ropes.is_changed() {
        return;
    }

    // Wind data status.
    let data_status = if wind.age_secs < 90.0 {
        format!("LIVE ({:.0}s)", wind.age_secs)
    } else if wind.age_secs < 600.0 {
        format!("STALE ({:.0}s)", wind.age_secs)
    } else {
        "OFFLINE".to_string()
    };

    // Feature data status.
    let feat_status = match &features {
        Some(f) if f.age_secs < 180.0 => format!("LIVE ({:.0}s)", f.age_secs),
        Some(f) => format!("STALE ({:.0}s)", f.age_secs),
        None => "N/A".to_string(),
    };

    // X-ray flux estimate from features.
    let xray_str = match &features {
        Some(f) => {
            let norm = f.xray_flux_norm;
            if norm > 0.83 { "X" }
            else if norm > 0.67 { "M" }
            else if norm > 0.50 { "C" }
            else if norm > 0.33 { "B" }
            else { "A" }
        }
        None => "—",
    };

    // ML prediction summary.
    let flare_line = format!(
        "ML     {} {:.1}%  CME {:.1}%",
        prediction.predicted_class,
        prediction.flare_probability * 100.0,
        prediction.cme_probability * 100.0,
    );

    // Flux rope status lines.
    let mut rope_lines = String::new();
    for (i, rope) in ropes.ropes.iter().enumerate() {
        let phase_str = match rope.phase {
            RopePhase::Emerging => "EMERGING",
            RopePhase::Erupting => "ERUPTING",
            RopePhase::Relaxing => "RELAXING",
        };
        let detail = match rope.phase {
            RopePhase::Emerging => {
                format!("E={:.1} tw={:.1}", rope.free_energy, rope.twist)
            }
            RopePhase::Erupting => rope.flare_class_full(),
            RopePhase::Relaxing => format!("{:.0}s", rope.phase_timer),
        };
        rope_lines.push_str(&format!(
            "\nROPE {} {}  {}",
            i + 1,
            phase_str,
            detail
        ));
    }

    let new_text = format!(
        "WIND   {:.0} km/s  {}\n\
         ALERT  {}  Bz={}\n\
         XRAY   {}  F10.7={}\n\
         FEAT   {}\n\
         ──────────────\n\
         {}\
         {}",
        wind.speed_km_s,
        data_status,
        wind.alert_level,
        match &features {
            Some(f) => format!("{:.1}", f.bz_southward_norm * -30.0),
            None => "—".to_string(),
        },
        xray_str,
        match &features {
            Some(f) => format!("{:.0}", f.radio_flux_norm * 235.0 + 65.0),
            None => "—".to_string(),
        },
        feat_status,
        flare_line,
        rope_lines,
    );

    for mut text in &mut query {
        **text = new_text.clone();
    }
}
