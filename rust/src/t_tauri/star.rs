//! T Tauri protostar — oblate sphere with variable glow.
//!
//! Classical T Tauri stars are pre-main-sequence objects:
//!   T_eff  ≈ 3500–4500 K  (K/M spectral type, orange-red)
//!   P_rot  ≈ 1–10 days    (rapid → measurable oblateness)
//!   B_surf ≈ 1–3 kG       (strong dipolar magnetic field)
//!   Variability: irregular, accretion-driven (days–weeks timescale)

use bevy::core_pipeline::tonemapping::Tonemapping;
use bevy::prelude::*;

use crate::camera::CameraController;

// ── Physical parameters (world-unit scale) ──────────────────────────────────

/// Stellar radius in world units.
pub const STAR_RADIUS: f32 = 2.0;

/// Oblateness: ε ≈ 0.12 for a ∼3-day rotation period at ∼2 R☉.
/// Y-axis (rotation axis) is compressed by this fraction.
pub const OBLATENESS: f32 = 0.12;

pub const MAX_PARTICLES: usize = 2500;

/// ∼4000 K blackbody → orange-red.
const STAR_COLOR: Color = Color::srgb(1.0, 0.6, 0.25);

// ── Components ──────────────────────────────────────────────────────────────

#[derive(Component)]
pub struct TTauriStar {
    pub base_intensity: f32,
}

/// Shared handle so systems can mutate the material each frame.
#[derive(Component)]
pub struct MaterialHandle(pub Handle<StandardMaterial>);

// ── Setup ───────────────────────────────────────────────────────────────────

pub fn setup(
    mut commands: Commands,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
) {
    // 1. Oblate star sphere ──────────────────────────────────────────────────
    let star_mesh = meshes.add(Sphere::new(STAR_RADIUS).mesh().uv(128, 64));
    let star_material = materials.add(StandardMaterial {
        base_color: STAR_COLOR,
        emissive: LinearRgba::from(STAR_COLOR) * 3.0,
        unlit: true,
        ..default()
    });

    // Non-uniform scale → oblate spheroid (rotation axis = Y).
    let y_scale = 1.0 - OBLATENESS;

    commands.spawn((
        Mesh3d(star_mesh),
        MeshMaterial3d(star_material.clone()),
        Transform::from_xyz(0.0, 0.0, 0.0).with_scale(Vec3::new(1.0, y_scale, 1.0)),
        TTauriStar {
            base_intensity: 3.0,
        },
        MaterialHandle(star_material),
    ));

    // 2. Lighting — warm orange-tinted ───────────────────────────────────────
    commands.spawn((
        PointLight {
            intensity: 350_000.0,
            color: STAR_COLOR,
            range: 100.0,
            radius: STAR_RADIUS,
            shadows_enabled: false,
            ..default()
        },
        Transform::from_xyz(0.0, 0.0, 0.0),
    ));

    commands.insert_resource(AmbientLight {
        color: Color::srgb(0.06, 0.04, 0.02),
        brightness: 150.0,
        affects_lightmapped_meshes: false,
    });

    // 3. Camera ──────────────────────────────────────────────────────────────
    commands.spawn((
        Camera3d::default(),
        Tonemapping::AcesFitted,
        Transform::from_xyz(0.0, 5.0, 15.0).looking_at(Vec3::ZERO, Vec3::Y),
        CameraController {
            rotation_speed: 2.0,
            zoom_speed: 10.0,
            distance: 15.0,
            angle_x: 0.0,
            angle_y: 0.3,
        },
    ));

    println!("\n=== T Tauri Protostar Simulation ===");
    println!("A young star being born — oblate, rapidly rotating,");
    println!("with Parker spiral stellar wind.");
    println!("Controls:");
    println!("  Arrow Keys - Rotate camera");
    println!("  W/S        - Zoom in/out");
    println!("  R          - Reset camera");
    println!("  ESC        - Exit");
    println!("Max particles: {MAX_PARTICLES}");
    println!("====================================\n");
}

// ── Star glow — irregular T Tauri variability ───────────────────────────────

/// T Tauri light curves show quasi-periodic variability from rotating accretion
/// hot spots plus stochastic accretion-rate fluctuations.
pub fn update_star_glow(
    time: Res<Time>,
    query: Query<(&TTauriStar, &MaterialHandle)>,
    mut materials: ResMut<Assets<StandardMaterial>>,
) {
    for (star, mat_handle) in query.iter() {
        if let Some(material) = materials.get_mut(&mat_handle.0) {
            let t = time.elapsed_secs();

            // Multi-frequency variability (matches real T Tauri light curves).
            let slow = (t * 0.4).sin() * 0.10; // ~15 s period — rotation modulation
            let med = (t * 1.2 + 0.7).sin() * 0.06; // ~5 s — accretion oscillation
            let fast = (t * 3.5 + 2.1).sin() * (t * 5.7).sin() * 0.04; // stochastic flicker

            let intensity = star.base_intensity * (1.0 + slow + med + fast);

            // Hot-spot colour shift: slightly yellower when the accretion
            // shock rotates into view.
            let hot_spot = ((t * 0.8).sin() * 0.5 + 0.5).powi(3);
            let r = 1.0;
            let g = 0.6 + hot_spot * 0.15;
            let b = 0.25 + hot_spot * 0.10;
            let color = Color::srgb(r, g, b);

            material.base_color = color;
            material.emissive = LinearRgba::from(color) * intensity;
        }
    }
}
