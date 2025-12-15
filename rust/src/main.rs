use bevy::prelude::*;
use bevy::app::AppExit;
use bevy::input::ButtonInput;
use bevy::window::WindowResolution;

// Use different RNG for native vs WASM
#[cfg(not(target_arch = "wasm32"))]
use rand::Rng;

#[cfg(target_arch = "wasm32")]
use std::f32::consts::{PI, TAU};

// Constants for the star simulation
const STAR_RADIUS: f32 = 2.0;
const STAR_COLOR: Color = Color::srgb(1.0, 0.9, 0.3); // Yellow-orange star
const MAX_PARTICLES: usize = 2000;
const PARTICLE_SPAWN_RATE: usize = 10; // Particles per frame
const PARTICLE_LIFETIME: f32 = 3.0; // Seconds

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
        .add_systems(Startup, setup)
        .add_systems(Update, (
            camera_controller,
            update_star_glow,
            spawn_particles,
            update_particles,
            handle_exit,
        ))
        .run();
}

// Component to mark the star entity
#[derive(Component)]
struct Star {
    pulse_speed: f32,
    base_intensity: f32,
}

// Component for solar wind particles
#[derive(Component)]
struct Particle {
    velocity: Vec3,
    lifetime: f32,
    max_lifetime: f32,
}

// Component for camera controller
#[derive(Component)]
struct CameraController {
    rotation_speed: f32,
    zoom_speed: f32,
    distance: f32,
    angle_x: f32,
    angle_y: f32,
}

// Resource to manage particle spawning
#[derive(Resource, Default)]
struct ParticleSpawner {
    particle_count: usize,
}

// Component to store material handle
#[derive(Component)]
struct MaterialHandle(Handle<StandardMaterial>);

fn setup(
    mut commands: Commands,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
) {
    // Create the star sphere
    let star_mesh = meshes.add(Sphere::new(STAR_RADIUS).mesh().uv(64, 32));

    // Star material with emissive glow
    let star_material = materials.add(StandardMaterial {
        base_color: STAR_COLOR,
        emissive: LinearRgba::from(STAR_COLOR) * 2.0,
        ..default()
    });

    // Spawn the star with new required components system
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

    // Add a point light at the star's center
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

    // Add ambient light
    commands.insert_resource(AmbientLight {
        color: Color::srgb(0.1, 0.1, 0.15),
        brightness: 300.0,
        affects_lightmapped_meshes: false,
    });

    // Create the camera with controller
    commands.spawn((
        Camera3d::default(),
        Transform::from_xyz(0.0, 5.0, 15.0)
            .looking_at(Vec3::ZERO, Vec3::Y),
        CameraController {
            rotation_speed: 2.0,
            zoom_speed: 10.0,
            distance: 15.0,
            angle_x: 0.0,
            angle_y: 0.3,
        },
    ));

    // Print instructions
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

// Update star glow with pulsing effect
fn update_star_glow(
    time: Res<Time>,
    mut query: Query<(&Star, &MaterialHandle)>,
    mut materials: ResMut<Assets<StandardMaterial>>,
) {
    for (star, mat_handle) in query.iter_mut() {
        if let Some(material) = materials.get_mut(&mat_handle.0) {
            let pulse = (time.elapsed_secs() * star.pulse_speed).sin() * 0.3 + 1.0;
            let intensity = star.base_intensity * pulse;
            material.emissive = LinearRgba::from(STAR_COLOR) * intensity;
        }
    }
}

// Spawn solar wind particles
fn spawn_particles(
    mut commands: Commands,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
    mut spawner: ResMut<ParticleSpawner>,
) {
    // Spawn particles up to the limit
    let to_spawn = PARTICLE_SPAWN_RATE.min(MAX_PARTICLES - spawner.particle_count);

    for _ in 0..to_spawn {
        // Random position on sphere surface
        #[cfg(not(target_arch = "wasm32"))]
        let (theta, phi, speed, lifetime) = {
            let mut rng = rand::thread_rng();
            (
                rng.gen_range(0.0..std::f32::consts::TAU),
                rng.gen_range(0.0..std::f32::consts::PI),
                rng.gen_range(1.5..3.0),
                rng.gen_range(2.0..PARTICLE_LIFETIME),
            )
        };

        #[cfg(target_arch = "wasm32")]
        let (theta, phi, speed, lifetime) = {
            (
                fastrand::f32() * TAU,
                fastrand::f32() * PI,
                1.5 + fastrand::f32() * 1.5,
                2.0 + fastrand::f32() * (PARTICLE_LIFETIME - 2.0),
            )
        };

        let x = STAR_RADIUS * phi.sin() * theta.cos();
        let y = STAR_RADIUS * phi.sin() * theta.sin();
        let z = STAR_RADIUS * phi.cos();

        let position = Vec3::new(x, y, z);
        let direction = position.normalize();

        // Outward velocity
        let velocity = direction * speed;

        // Create particle mesh (small sphere)
        let particle_mesh = meshes.add(Sphere::new(0.05).mesh().uv(8, 4));

        // Particle material with emissive glow
        let particle_color = Color::srgb(1.0, 0.95, 0.7);
        let particle_material = materials.add(StandardMaterial {
            base_color: particle_color,
            emissive: LinearRgba::from(particle_color) * 3.0,
            unlit: true,
            ..default()
        });

        commands.spawn((
            Mesh3d(particle_mesh),
            MeshMaterial3d(particle_material.clone()),
            Transform::from_translation(position),
            Particle {
                velocity,
                lifetime,
                max_lifetime: lifetime,
            },
            MaterialHandle(particle_material),
        ));

        spawner.particle_count += 1;
    }
}

// Update particle positions and lifetimes
fn update_particles(
    mut commands: Commands,
    time: Res<Time>,
    mut spawner: ResMut<ParticleSpawner>,
    mut query: Query<(Entity, &mut Transform, &mut Particle, &MaterialHandle)>,
    mut materials: ResMut<Assets<StandardMaterial>>,
) {
    let delta = time.delta_secs();

    for (entity, mut transform, mut particle, mat_handle) in query.iter_mut() {
        // Update lifetime
        particle.lifetime -= delta;

        // Remove dead particles
        if particle.lifetime <= 0.0 {
            commands.entity(entity).despawn();
            spawner.particle_count -= 1;
            continue;
        }

        // Update position
        transform.translation += particle.velocity * delta;

        // Fade out based on remaining lifetime
        let life_ratio = particle.lifetime / particle.max_lifetime;
        if let Some(material) = materials.get_mut(&mat_handle.0) {
            // Color gradient: yellow -> white -> blue as particles age
            let color = if life_ratio > 0.7 {
                Color::srgb(1.0, 0.95, 0.7) // Yellow-white
            } else if life_ratio > 0.3 {
                Color::srgb(0.9, 0.95, 1.0) // White-blue
            } else {
                Color::srgb(0.6, 0.7, 1.0) // Blue
            };

            material.base_color = color.with_alpha(life_ratio);
            material.emissive = LinearRgba::from(color) * (3.0 * life_ratio);
        }
    }
}

// Camera controller system
fn camera_controller(
    keyboard: Res<ButtonInput<KeyCode>>,
    time: Res<Time>,
    mut query: Query<(&mut Transform, &mut CameraController)>,
) {
    for (mut transform, mut controller) in query.iter_mut() {
        let delta = time.delta_secs();

        // Rotation with arrow keys
        if keyboard.pressed(KeyCode::ArrowLeft) {
            controller.angle_x -= controller.rotation_speed * delta;
        }
        if keyboard.pressed(KeyCode::ArrowRight) {
            controller.angle_x += controller.rotation_speed * delta;
        }
        if keyboard.pressed(KeyCode::ArrowUp) {
            controller.angle_y = (controller.angle_y + controller.rotation_speed * delta)
                .min(std::f32::consts::FRAC_PI_2 - 0.1);
        }
        if keyboard.pressed(KeyCode::ArrowDown) {
            controller.angle_y = (controller.angle_y - controller.rotation_speed * delta)
                .max(-std::f32::consts::FRAC_PI_2 + 0.1);
        }

        // Zoom with W/S
        if keyboard.pressed(KeyCode::KeyW) {
            controller.distance = (controller.distance - controller.zoom_speed * delta).max(5.0);
        }
        if keyboard.pressed(KeyCode::KeyS) {
            controller.distance = (controller.distance + controller.zoom_speed * delta).min(50.0);
        }

        // Reset with R
        if keyboard.just_pressed(KeyCode::KeyR) {
            controller.angle_x = 0.0;
            controller.angle_y = 0.3;
            controller.distance = 15.0;
        }

        // Calculate camera position
        let x = controller.distance * controller.angle_y.cos() * controller.angle_x.sin();
        let y = controller.distance * controller.angle_y.sin();
        let z = controller.distance * controller.angle_y.cos() * controller.angle_x.cos();

        transform.translation = Vec3::new(x, y, z);
        transform.look_at(Vec3::ZERO, Vec3::Y);
    }
}

// Exit handler
fn handle_exit(
    keyboard: Res<ButtonInput<KeyCode>>,
    mut exit: MessageWriter<AppExit>,
) {
    if keyboard.just_pressed(KeyCode::Escape) {
        exit.write(AppExit::Success);
    }
}
