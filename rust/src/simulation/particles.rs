use bevy::prelude::*;

use crate::rendering::star::MaterialHandle;
use crate::simulation::fluid::VelocityField;
use crate::{MAX_PARTICLES, STAR_RADIUS};

#[cfg(not(target_arch = "wasm32"))]
use rand::Rng;

#[cfg(target_arch = "wasm32")]
use std::f32::consts::{PI, TAU};

const PARTICLE_SPAWN_RATE: usize = 10;
const PARTICLE_LIFETIME: f32 = 4.0;

/// A solar wind particle advected through the velocity field.
///
/// `velocity` is the initial outward impulse assigned at birth.  During
/// advection it is blended with the field: the impulse dominates when the
/// particle is young and fades linearly so the field takes full control by
/// the end of its lifetime.
#[derive(Component)]
pub struct Particle {
    /// Initial birth velocity (radially outward from spawn point).
    pub velocity: Vec3,
    pub lifetime: f32,
    pub max_lifetime: f32,
}

/// Tracks total live particle count to enforce [`MAX_PARTICLES`].
#[derive(Resource, Default)]
pub struct ParticleSpawner {
    pub particle_count: usize,
}

pub fn spawn_particles(
    mut commands: Commands,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
    mut spawner: ResMut<ParticleSpawner>,
) {
    let to_spawn = PARTICLE_SPAWN_RATE.min(MAX_PARTICLES - spawner.particle_count);

    for _ in 0..to_spawn {
        #[cfg(not(target_arch = "wasm32"))]
        let (theta, phi, speed, lifetime) = {
            let mut rng = rand::thread_rng();
            (
                rng.gen_range(0.0..std::f32::consts::TAU),
                rng.gen_range(0.0..std::f32::consts::PI),
                rng.gen_range(0.8..1.8), // lower birth speed — field now provides most motion
                rng.gen_range(2.5..PARTICLE_LIFETIME),
            )
        };

        #[cfg(target_arch = "wasm32")]
        let (theta, phi, speed, lifetime) = (
            fastrand::f32() * TAU,
            fastrand::f32() * PI,
            0.8 + fastrand::f32() * 1.0,
            2.5 + fastrand::f32() * (PARTICLE_LIFETIME - 2.5),
        );

        let x = STAR_RADIUS * phi.sin() * theta.cos();
        let y = STAR_RADIUS * phi.sin() * theta.sin();
        let z = STAR_RADIUS * phi.cos();

        let position = Vec3::new(x, y, z);
        let velocity = position.normalize() * speed;

        let particle_mesh = meshes.add(Sphere::new(0.05).mesh().uv(8, 4));

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

pub fn update_particles(
    mut commands: Commands,
    time: Res<Time>,
    field: Res<VelocityField>,
    mut spawner: ResMut<ParticleSpawner>,
    mut query: Query<(Entity, &mut Transform, &mut Particle, &MaterialHandle)>,
    mut materials: ResMut<Assets<StandardMaterial>>,
) {
    let delta = time.delta_secs();

    for (entity, mut transform, mut particle, mat_handle) in query.iter_mut() {
        particle.lifetime -= delta;

        if particle.lifetime <= 0.0 {
            commands.entity(entity).despawn();
            spawner.particle_count -= 1;
            continue;
        }

        // Age factor: 1.0 at birth → 0.0 at death.
        // The birth impulse dominates early so particles shoot outward from the
        // surface; the field progressively takes over, giving curved, swirling
        // paths through convective cells and the differential rotation pattern.
        let age = particle.lifetime / particle.max_lifetime;
        let field_vel = field.sample(transform.translation);
        let effective_vel = particle.velocity * age * 0.55 + field_vel;

        transform.translation += effective_vel * delta;

        // Colour gradient: yellow-white (hot) → white-blue (cool) → dim blue
        let life_ratio = particle.lifetime / particle.max_lifetime;
        if let Some(material) = materials.get_mut(&mat_handle.0) {
            let color = if life_ratio > 0.7 {
                Color::srgb(1.0, 0.95, 0.7) // yellow-white (freshly ejected)
            } else if life_ratio > 0.3 {
                Color::srgb(0.9, 0.95, 1.0) // white-blue (cooling)
            } else {
                Color::srgb(0.6, 0.7, 1.0) // blue (cold, dissipating)
            };

            material.base_color = color.with_alpha(life_ratio);
            material.emissive = LinearRgba::from(color) * (3.0 * life_ratio);
        }
    }
}
