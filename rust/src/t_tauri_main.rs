use bevy::prelude::*;
use bevy::window::WindowResolution;

mod camera;
mod t_tauri;

use camera::{camera_controller, handle_exit};
use t_tauri::disk::{
    draw_disk_structure, spawn_disk_particles, update_disk_particles, DiskSpawner,
};
use t_tauri::particles::{spawn_particles, update_particles, TTauriSpawner};
use t_tauri::star::{setup, update_star_glow};

fn main() {
    App::new()
        .add_plugins(DefaultPlugins.set(WindowPlugin {
            primary_window: Some(Window {
                title: "T Tauri Protostar — Accretion Disk Simulation".to_string(),
                resolution: WindowResolution::new(1280, 720),
                ..default()
            }),
            ..default()
        }))
        .insert_resource(ClearColor(Color::srgb(0.01, 0.01, 0.02)))
        .insert_resource(TTauriSpawner::default())
        .insert_resource(DiskSpawner::default())
        .add_systems(Startup, setup)
        .add_systems(
            Update,
            (
                camera_controller,
                handle_exit,
                // Star.
                update_star_glow,
                // Stellar wind (Parker spiral).
                spawn_particles,
                update_particles,
                // Accretion disk.
                spawn_disk_particles,
                update_disk_particles,
                draw_disk_structure,
            ),
        )
        .run();
}
