use bevy::prelude::*;
use bevy::window::WindowResolution;

mod camera;
mod prediction;
mod rendering;
mod simulation;

use camera::{camera_controller, handle_exit};
use rendering::star::{setup, update_star_glow};
use simulation::fluid::{update_velocity_field, VelocityField};
use simulation::particles::{spawn_particles, update_particles, ParticleSpawner};

pub const STAR_RADIUS: f32 = 2.0;
pub const MAX_PARTICLES: usize = 2000;

fn main() {
    App::new()
        .add_plugins(DefaultPlugins.set(WindowPlugin {
            primary_window: Some(Window {
                title: "Celestial Star Renderer - Rust PoC".to_string(),
                resolution: WindowResolution::new(1280, 720),
                ..default()
            }),
            ..default()
        }))
        .insert_resource(ClearColor(Color::srgb(0.01, 0.01, 0.02)))
        .insert_resource(ParticleSpawner::default())
        .insert_resource(VelocityField::new())
        .add_systems(Startup, setup)
        .add_systems(
            Update,
            (
                // Field must be updated before particles read from it.
                update_velocity_field,
                (
                    camera_controller,
                    update_star_glow,
                    spawn_particles,
                    update_particles,
                    handle_exit,
                )
                    .after(update_velocity_field),
            ),
        )
        .run();
}
