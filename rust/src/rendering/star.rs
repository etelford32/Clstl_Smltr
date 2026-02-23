use bevy::prelude::*;

use crate::camera::CameraController;
use crate::{MAX_PARTICLES, STAR_RADIUS};

const STAR_COLOR: Color = Color::srgb(1.0, 0.9, 0.3);

/// Marks the star entity and carries animation parameters.
#[derive(Component)]
pub struct Star {
    pub pulse_speed: f32,
    pub base_intensity: f32,
}

/// Stores a material handle on an entity so systems can mutate it each frame.
#[derive(Component)]
pub struct MaterialHandle(pub Handle<StandardMaterial>);

pub fn setup(
    mut commands: Commands,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
) {
    let star_mesh = meshes.add(Sphere::new(STAR_RADIUS).mesh().uv(64, 32));

    let star_material = materials.add(StandardMaterial {
        base_color: STAR_COLOR,
        emissive: LinearRgba::from(STAR_COLOR) * 2.0,
        ..default()
    });

    commands.spawn((
        Mesh3d(star_mesh),
        MeshMaterial3d(star_material.clone()),
        Transform::from_xyz(0.0, 0.0, 0.0),
        Star {
            pulse_speed: 2.0,
            base_intensity: 2.0,
        },
        MaterialHandle(star_material),
    ));

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

    commands.spawn((
        Camera3d::default(),
        Transform::from_xyz(0.0, 5.0, 15.0).looking_at(Vec3::ZERO, Vec3::Y),
        CameraController {
            rotation_speed: 2.0,
            zoom_speed: 10.0,
            distance: 15.0,
            angle_x: 0.0,
            angle_y: 0.3,
        },
    ));

    println!("\n=== Celestial Star Renderer (Rust) ===");
    println!("Controls:");
    println!("  Arrow Keys - Rotate camera");
    println!("  W/S        - Zoom in/out");
    println!("  R          - Reset camera");
    println!("  ESC        - Exit");
    println!("\nSolar wind particles will spawn around the star.");
    println!("Max particles: {}", MAX_PARTICLES);
    println!("=====================================\n");
}

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
