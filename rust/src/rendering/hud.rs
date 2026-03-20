//! Wind speed HUD overlay.
//!
//! Renders a small monospace text panel in the top-left corner of the window
//! showing live wind speed, alert level, and data freshness sourced from the
//! NOAA pipeline via [`crate::prediction::solar_wind::LiveWindSpeed`].
//!
//! Layout (world units, top-left origin):
//! ```text
//! ┌──────────────────────────────┐
//! │ WIND   450 km/s              │
//! │ ALERT  MODERATE              │
//! │ TREND  → STEADY              │
//! │ DATA   LIVE                  │
//! └──────────────────────────────┘
//! ```

use bevy::prelude::*;

use crate::prediction::solar_wind::LiveWindSpeed;

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
                Text::new("WIND   connecting…\nALERT  —\nTREND  —\nDATA   offline"),
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

/// Refreshes the HUD text every frame from the [`LiveWindSpeed`] resource.
pub fn update_hud(
    wind: Res<LiveWindSpeed>,
    mut query: Query<&mut Text, With<WindHudText>>,
) {
    // Only rewrite the string when the resource actually changed.
    if !wind.is_changed() {
        return;
    }

    let trend_arrow = "→"; // static for now; extended in a future phase
    let data_status = if wind.age_secs < 90.0 {
        format!("LIVE  ({:.0}s ago)", wind.age_secs)
    } else if wind.age_secs < 600.0 {
        format!("STALE ({:.0}s ago)", wind.age_secs)
    } else {
        "OFFLINE".to_string()
    };

    let new_text = format!(
        "WIND   {:.0} km/s\nALERT  {}\nTREND  {} steady\nDATA   {}",
        wind.speed_km_s,
        wind.alert_level,
        trend_arrow,
        data_status,
    );

    for mut text in &mut query {
        **text = new_text.clone();
    }
}
