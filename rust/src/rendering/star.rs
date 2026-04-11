//! Star rendering setup — custom solar materials, corona shell, bloom HDR,
//! and eruption visual effects.
//!
//! # Visual stack
//!
//! 1. **Photosphere** — [`SolarSurfaceMat`] applied to the star sphere.
//!    Procedural granulation, limb darkening, sunspots, flare ribbons.
//!
//! 2. **Corona** — [`CoronaGlowMat`] on a larger transparent shell (2.5× R).
//!    Helmet streamers, polar holes, EUV false-color, CME brightening.
//!
//! 3. **Flare flash** — [`FlareFlashMat`] on ephemeral expanding spheres
//!    spawned when a flux rope erupts.  CME shock front, post-flare loops.
//!
//! 4. **Bloom** — Bevy's built-in HDR bloom on the camera catches all
//!    emissive surfaces and creates the signature solar glow.
//!
//! 5. **Particles + Gizmos** — solar wind, prominence, field lines drawn
//!    on top by other systems.

use bevy::post_process::bloom::{Bloom, BloomCompositeMode};
use bevy::core_pipeline::tonemapping::Tonemapping;
use bevy::prelude::*;

use super::solar_material::*;
use crate::camera::CameraController;
use crate::prediction::flare_ml::FlareMLPrediction;
use crate::prediction::solar_wind::LiveWindSpeed;
use crate::simulation::flux_rope::{FluxRopeSet, RopePhase};
use crate::{MAX_PARTICLES, STAR_RADIUS};

const STAR_COLOR: Color = Color::srgb(1.0, 0.9, 0.3);

/// Corona shell radius (world units) — extent of the visible corona.
const CORONA_RADIUS: f32 = STAR_RADIUS * 2.8;

/// Marks the star entity and carries animation parameters.
#[derive(Component)]
pub struct Star {
    pub pulse_speed: f32,
    pub base_intensity: f32,
}

/// Stores a material handle on an entity so systems can mutate it each frame.
#[derive(Component)]
pub struct MaterialHandle(pub Handle<StandardMaterial>);

// ── Setup ────────────────────────────────────────────────────────────────────

pub fn setup(
    mut commands: Commands,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
    mut surface_mats: ResMut<Assets<SolarSurfaceMat>>,
    mut corona_mats: ResMut<Assets<CoronaGlowMat>>,
) {
    // ── 1. Photosphere (custom shader) ──────────────────────────────────────
    let star_mesh = meshes.add(Sphere::new(STAR_RADIUS).mesh().uv(128, 64));

    let surface_mat = surface_mats.add(SolarSurfaceMat {
        uniforms: SolarSurfaceUniforms::default(),
    });

    commands.spawn((
        Mesh3d(star_mesh),
        MeshMaterial3d(surface_mat),
        Transform::from_xyz(0.0, 0.0, 0.0),
        Star {
            pulse_speed: 2.0,
            base_intensity: 2.0,
        },
        SolarSurfaceEntity,
    ));

    // ── 2. Corona shell (custom shader, additive blend) ─────────────────────
    let corona_mesh = meshes.add(
        Sphere::new(CORONA_RADIUS)
            .mesh()
            .uv(96, 48),
    );

    let corona_mat = corona_mats.add(CoronaGlowMat {
        uniforms: CoronaUniforms {
            corona_radius: CORONA_RADIUS,
            ..CoronaUniforms::default()
        },
    });

    commands.spawn((
        Mesh3d(corona_mesh),
        MeshMaterial3d(corona_mat),
        Transform::from_xyz(0.0, 0.0, 0.0),
        CoronaShellEntity,
    ));

    // ── 3. Point light (still useful for illuminating particles) ────────────
    commands.spawn((
        PointLight {
            intensity: 500_000.0,
            color: STAR_COLOR,
            range: 100.0,
            radius: STAR_RADIUS,
            shadows_enabled: false,
            ..default()
        },
        Transform::from_xyz(0.0, 0.0, 0.0),
    ));

    commands.insert_resource(AmbientLight {
        color: Color::srgb(0.1, 0.1, 0.15),
        brightness: 300.0,
        affects_lightmapped_meshes: false,
    });

    // ── 4. Camera with HDR bloom ────────────────────────────────────────────
    commands.spawn((
        Camera3d::default(),
        Tonemapping::AcesFitted,
        Bloom::NATURAL,
        Transform::from_xyz(0.0, 5.0, 15.0).looking_at(Vec3::ZERO, Vec3::Y),
        CameraController {
            rotation_speed: 2.0,
            zoom_speed: 10.0,
            distance: 15.0,
            angle_x: 0.0,
            angle_y: 0.3,
        },
    ));

    println!("\n=== Parker Physics — Solar Flare ML Simulation ===");
    println!("Controls:");
    println!("  Arrow Keys - Rotate camera");
    println!("  W/S        - Zoom in/out");
    println!("  R          - Reset camera");
    println!("  ESC        - Exit");
    println!("\nRendering: procedural photosphere + corona + bloom HDR");
    println!("Physics:   flux ropes, prominences, ML flare prediction");
    println!("Data:      live NOAA/NASA pipeline");
    println!("Max particles: {}", MAX_PARTICLES);
    println!("===================================================\n");
}

// ── Solar surface update ─────────────────────────────────────────────────────

/// Update the solar surface shader uniforms every frame.
pub fn update_solar_surface(
    time: Res<Time>,
    ropes: Res<FluxRopeSet>,
    prediction: Res<FlareMLPrediction>,
    query: Query<&MeshMaterial3d<SolarSurfaceMat>, With<SolarSurfaceEntity>>,
    mut surface_mats: ResMut<Assets<SolarSurfaceMat>>,
) {
    for mat_handle in query.iter() {
        if let Some(mat) = surface_mats.get_mut(mat_handle) {
            let t = time.elapsed_secs();
            mat.uniforms.time = t;
            mat.uniforms.activity_scale = prediction.activity_scale;

            // Update active region positions (drift with differential rotation).
            if let Some(rope) = ropes.ropes.first() {
                let lon_drift = t * 0.31;
                mat.uniforms.ar1 = Vec4::new(
                    rope.latitude,
                    60_f32.to_radians() + lon_drift,
                    0.8 + rope.free_energy * 0.1,
                    if rope.phase == RopePhase::Erupting {
                        (1.0 - rope.phase_timer * 0.15).max(0.0)
                    } else {
                        0.0
                    },
                );
            }
            if let Some(rope) = ropes.ropes.get(1) {
                let lon_drift = t * 0.315;
                mat.uniforms.ar2 = Vec4::new(
                    rope.latitude,
                    200_f32.to_radians() + lon_drift,
                    0.7 + rope.free_energy * 0.1,
                    if rope.phase == RopePhase::Erupting {
                        (1.0 - rope.phase_timer * 0.15).max(0.0)
                    } else {
                        0.0
                    },
                );
            }
        }
    }
}

// ── Corona update ────────────────────────────────────────────────────────────

/// Update the corona glow shader uniforms every frame.
pub fn update_corona(
    time: Res<Time>,
    ropes: Res<FluxRopeSet>,
    prediction: Res<FlareMLPrediction>,
    wind: Res<LiveWindSpeed>,
    query: Query<&MeshMaterial3d<CoronaGlowMat>, With<CoronaShellEntity>>,
    mut corona_mats: ResMut<Assets<CoronaGlowMat>>,
) {
    for mat_handle in query.iter() {
        if let Some(mat) = corona_mats.get_mut(mat_handle) {
            let t = time.elapsed_secs();
            mat.uniforms.time = t;
            mat.uniforms.activity_scale = prediction.activity_scale;
            mat.uniforms.wind_scale = 0.5 + wind.speed_norm * 2.0;

            // Find the most actively erupting rope for the corona flash.
            let mut best_eruption = Vec4::ZERO;
            for rope in &ropes.ropes {
                if rope.phase == RopePhase::Erupting {
                    let intensity = rope.last_eruption_energy / 8.0;
                    if intensity > best_eruption.x {
                        best_eruption = Vec4::new(
                            intensity.min(3.0),
                            rope.latitude,
                            rope.longitude + t * 0.31,
                            rope.phase_timer,
                        );
                    }
                }
            }
            mat.uniforms.eruption = best_eruption;
        }
    }
}

// ── Flare flash spawning / update ────────────────────────────────────────────

/// Tracks which ropes have already spawned a flare flash (avoid duplicates).
#[derive(Resource, Default)]
pub struct FlareFlashTracker {
    /// `active[rope_index]` = true if a flash entity exists for that rope.
    active: Vec<bool>,
}

/// Spawns a flare flash effect sphere when a flux rope transitions to Erupting.
pub fn spawn_flare_flashes(
    mut commands: Commands,
    mut meshes: ResMut<Assets<Mesh>>,
    mut flash_mats: ResMut<Assets<FlareFlashMat>>,
    ropes: Res<FluxRopeSet>,
    time: Res<Time>,
    mut tracker: ResMut<FlareFlashTracker>,
) {
    // Ensure tracker vector is long enough.
    while tracker.active.len() < ropes.ropes.len() {
        tracker.active.push(false);
    }

    let t = time.elapsed_secs();

    for (i, rope) in ropes.ropes.iter().enumerate() {
        if rope.phase == RopePhase::Erupting && !tracker.active[i] {
            // Spawn a new flash effect.
            let flash_radius = STAR_RADIUS * 2.0;
            let mesh = meshes.add(Sphere::new(flash_radius).mesh().uv(48, 24));

            let lon_drift = t * if i == 0 { 0.31 } else { 0.315 };
            let mat = flash_mats.add(FlareFlashMat {
                uniforms: FlareUniforms {
                    time: t,
                    start_time: t,
                    intensity: (rope.last_eruption_energy / 4.0).min(4.0),
                    latitude: rope.latitude,
                    longitude: rope.longitude + lon_drift,
                    expansion_speed: rope.eruption_velocity.max(1.0),
                    _pad0: 0.0,
                    _pad1: 0.0,
                },
            });

            commands.spawn((
                Mesh3d(mesh),
                MeshMaterial3d(mat),
                Transform::from_xyz(0.0, 0.0, 0.0),
                FlareFlashEntity {
                    start_time: t,
                    lifetime: 12.0,
                    rope_index: i,
                },
            ));

            tracker.active[i] = true;
        }

        // Reset tracker when rope leaves erupting state.
        if rope.phase != RopePhase::Erupting && i < tracker.active.len() {
            tracker.active[i] = false;
        }
    }
}

/// Update flare flash uniforms and despawn expired effects.
pub fn update_flare_flashes(
    mut commands: Commands,
    time: Res<Time>,
    mut query: Query<(
        Entity,
        &FlareFlashEntity,
        &MeshMaterial3d<FlareFlashMat>,
    )>,
    mut flash_mats: ResMut<Assets<FlareFlashMat>>,
) {
    let t = time.elapsed_secs();

    for (entity, flash, mat_handle) in query.iter_mut() {
        let age = t - flash.start_time;

        if age > flash.lifetime {
            commands.entity(entity).despawn();
            continue;
        }

        // Update time uniform for the shader.
        if let Some(mat) = flash_mats.get_mut(mat_handle) {
            mat.uniforms.time = t;
        }
    }
}

// ── Legacy glow (kept as fallback for particles using StandardMaterial) ──────

pub fn update_star_glow(
    time: Res<Time>,
    query: Query<(&Star, &MaterialHandle)>,
    mut materials: ResMut<Assets<StandardMaterial>>,
) {
    for (star, mat_handle) in query.iter() {
        if let Some(material) = materials.get_mut(&mat_handle.0) {
            let pulse = (time.elapsed_secs() * star.pulse_speed).sin() * 0.3 + 1.0;
            let intensity = star.base_intensity * pulse;
            material.emissive = LinearRgba::from(STAR_COLOR) * intensity;
        }
    }
}
