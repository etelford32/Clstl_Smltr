use bevy::prelude::*;
use bevy::window::WindowResolution;

mod camera;
mod prediction;
mod rendering;
mod simulation;

use camera::{camera_controller, handle_exit};
use prediction::feature_extract::{update_solar_features, SolarFeaturesPlugin};
use prediction::flare_ml::{run_flare_prediction, FlareMLPrediction};
use prediction::solar_wind::{update_live_wind, LiveWindPlugin, LiveWindSpeed};
use rendering::hud::{setup_hud, update_hud};
use rendering::star::{setup, update_star_glow};
use simulation::fluid::{update_velocity_field, VelocityField};
use simulation::flux_rope::{draw_flux_ropes, update_flux_ropes, FluxRopeSet};
use simulation::magnetic::{draw_field_lines, update_field_lines, FieldLineSet};
use simulation::particles::{spawn_particles, update_particles, ParticleSpawner};
use simulation::prominence::{
    spawn_prominence_particles, update_prominence_particles, ProminenceSpawner,
};

/// Transfer the live wind speed from [`LiveWindSpeed`] into the velocity field
/// scale so that real NOAA observations modulate the particle animation.
///
/// Maps normalised speed [0, 1] → wind scale [0.5, 2.5]:
///   - 0.0 (250 km/s quiet)  → scale 0.5  (slow corona outflow)
///   - 0.5 (450 km/s nominal) → scale 1.5  (normal animation speed)
///   - 1.0 (900 km/s storm)  → scale 2.5  (dramatic storm particles)
fn apply_live_wind_scale(wind: Res<LiveWindSpeed>, mut field: ResMut<VelocityField>) {
    field.wind_speed_scale = 0.5 + wind.speed_norm * 2.0;
}

pub const STAR_RADIUS: f32 = 2.0;
pub const MAX_PARTICLES: usize = 2000;

fn main() {
    App::new()
        .add_plugins(DefaultPlugins.set(WindowPlugin {
            primary_window: Some(Window {
                title: "Parker Physics — Solar Flare ML Simulation".to_string(),
                resolution: WindowResolution::new(1280, 720),
                ..default()
            }),
            ..default()
        }))
        // Live NOAA wind speed pipeline (polls API in background thread).
        .add_plugins(LiveWindPlugin)
        // Live NASA/NOAA feature extraction for ML prediction.
        .add_plugins(SolarFeaturesPlugin)
        .insert_resource(ClearColor(Color::srgb(0.01, 0.01, 0.02)))
        .insert_resource(ParticleSpawner::default())
        .insert_resource(VelocityField::new())
        .insert_resource(FieldLineSet::default())
        .insert_resource(FluxRopeSet::default())
        .insert_resource(FlareMLPrediction::default())
        .insert_resource(ProminenceSpawner::default())
        .add_systems(Startup, (setup, setup_hud))
        .add_systems(
            Update,
            (
                // 0. Receive latest live data from NASA/NOAA pipelines.
                update_live_wind,
                update_solar_features,
                // 1. ML flare prediction (reads features, writes activity scale).
                run_flare_prediction
                    .after(update_solar_features),
                // 2. Apply live scale to the velocity field, then rebuild it.
                apply_live_wind_scale
                    .after(update_live_wind),
                update_velocity_field
                    .after(apply_live_wind_scale),
                // 3. Magnetic topology + flux rope physics.
                update_field_lines
                    .after(update_velocity_field),
                update_flux_ropes
                    .after(run_flare_prediction),
                // 4. Everything that reads the results of the physics tick.
                (
                    camera_controller,
                    update_star_glow,
                    spawn_particles,
                    update_particles,
                    draw_field_lines,
                    draw_flux_ropes,
                    spawn_prominence_particles,
                    update_prominence_particles,
                    handle_exit,
                    update_hud,
                )
                    .after(update_field_lines)
                    .after(update_flux_ropes),
            ),
        )
        .run();
}
