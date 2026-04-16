//! Parker spiral particle emission for T Tauri protostar.
//!
//! The Parker spiral emerges from the interplay of radial stellar wind and
//! stellar rotation.  Gas streams radially, but the rotating magnetic field
//! imparts an azimuthal kick.  The result is an Archimedean spiral whose
//! winding tightness depends on the ratio Ω R☆ / v_wind.
//!
//! T Tauri parameters (scaled for visualisation):
//!   Ω_star  ~8× solar   (P_rot ≈ 3 days vs 25 days)
//!   v_wind  ≈ 200–400 km/s
//!   Ṁ       ≈ 10⁻⁸ M☉/yr  (10⁶× solar mass-loss rate)
//!   R_A     ≈ 3–8 R☆       (Alfvén radius — co-rotation boundary)
//!
//! The spiral angle at radius r:
//!   tan ψ = Ω r sin θ / v_r
//! Because Ω is much larger for T Tauri, the spiral is far tighter than
//! the Sun's classic ~45° at 1 AU.

use bevy::prelude::*;

use crate::t_tauri::star::{MaterialHandle, MAX_PARTICLES, OBLATENESS, STAR_RADIUS};

#[cfg(not(target_arch = "wasm32"))]
use rand::Rng;

#[cfg(target_arch = "wasm32")]
use std::f32::consts::{PI, TAU};

// ── Tuning knobs ────────────────────────────────────────────────────────────

const PARTICLE_SPAWN_RATE: usize = 12;
const PARTICLE_LIFETIME: f32 = 5.0;

/// Stellar angular velocity (visualisation units, rad/s).
/// ∼8× faster than the solar sim's 0.35.
const OMEGA_STAR: f32 = 0.70;

/// Peak radial wind speed at the domain edge.
const WIND_SPEED_MAX: f32 = 1.4;

/// Alfvén radius in stellar radii — inside this the field enforces
/// rigid co-rotation; outside, angular momentum is conserved (v_φ ∝ 1/r).
const ALFVEN_RADII: f32 = 5.0;

// ── Components & resources ──────────────────────────────────────────────────

#[derive(Component)]
pub struct TTauriParticle {
    /// Birth impulse (radially outward from spawn point on oblate surface).
    pub velocity: Vec3,
    pub lifetime: f32,
    pub max_lifetime: f32,
}

#[derive(Resource, Default)]
pub struct TTauriSpawner {
    pub count: usize,
}

// ── Spawn ───────────────────────────────────────────────────────────────────

pub fn spawn_particles(
    mut commands: Commands,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
    mut spawner: ResMut<TTauriSpawner>,
) {
    let budget = PARTICLE_SPAWN_RATE.min(MAX_PARTICLES.saturating_sub(spawner.count));

    for _ in 0..budget {
        // Random spherical coords.
        #[cfg(not(target_arch = "wasm32"))]
        let (theta, phi, speed, lifetime) = {
            let mut rng = rand::thread_rng();
            (
                rng.gen_range(0.0..std::f32::consts::TAU),
                rng.gen_range(0.0..std::f32::consts::PI),
                rng.gen_range(0.6..1.2),
                rng.gen_range(3.0..PARTICLE_LIFETIME),
            )
        };

        #[cfg(target_arch = "wasm32")]
        let (theta, phi, speed, lifetime) = (
            fastrand::f32() * TAU,
            fastrand::f32() * PI,
            0.6 + fastrand::f32() * 0.6,
            3.0 + fastrand::f32() * (PARTICLE_LIFETIME - 3.0),
        );

        // Spawn on the oblate surface.
        let y_scale = 1.0 - OBLATENESS;
        let x = STAR_RADIUS * phi.sin() * theta.cos();
        let y = STAR_RADIUS * y_scale * phi.cos();
        let z = STAR_RADIUS * phi.sin() * theta.sin();
        let position = Vec3::new(x, y, z);

        // Initial radial kick outward.
        let velocity = position.normalize() * speed;

        let mesh = meshes.add(Sphere::new(0.04).mesh().uv(6, 3));
        let color = Color::srgb(1.0, 0.70, 0.35);
        let mat = materials.add(StandardMaterial {
            base_color: color,
            emissive: LinearRgba::from(color) * 2.5,
            unlit: true,
            ..default()
        });

        commands.spawn((
            Mesh3d(mesh),
            MeshMaterial3d(mat.clone()),
            Transform::from_translation(position),
            TTauriParticle {
                velocity,
                lifetime,
                max_lifetime: lifetime,
            },
            MaterialHandle(mat),
        ));

        spawner.count += 1;
    }
}

// ── Advection — Parker spiral velocity field (analytical) ───────────────────

/// Each frame every particle is advected through a two-component velocity:
///
/// 1. **Radial wind** v_r(r) — accelerates from the surface outward.
/// 2. **Azimuthal** v_φ(r,θ) — angular momentum conservation past the
///    Alfvén radius, rigid co-rotation inside it.
///
/// Together these trace out the Parker/Archimedean spiral.
pub fn update_particles(
    mut commands: Commands,
    time: Res<Time>,
    mut spawner: ResMut<TTauriSpawner>,
    mut query: Query<(Entity, &mut Transform, &mut TTauriParticle, &MaterialHandle)>,
    mut materials: ResMut<Assets<StandardMaterial>>,
) {
    let dt = time.delta_secs();

    for (entity, mut xform, mut p, mat_handle) in query.iter_mut() {
        p.lifetime -= dt;
        if p.lifetime <= 0.0 {
            commands.entity(entity).despawn();
            spawner.count = spawner.count.saturating_sub(1);
            continue;
        }

        let pos = xform.translation;
        let dist = pos.length();
        if dist < 0.01 {
            commands.entity(entity).despawn();
            spawner.count = spawner.count.saturating_sub(1);
            continue;
        }

        let r_hat = pos / dist;

        // ── 1. Radial wind: √-ramp acceleration past the photosphere ────
        let above = (dist - STAR_RADIUS).max(0.0);
        let v_radial = if dist > STAR_RADIUS * 0.9 {
            let frac = (above / 8.0).min(1.0);
            r_hat * WIND_SPEED_MAX * frac.sqrt()
        } else {
            r_hat * 0.3
        };

        // ── 2. Azimuthal: Parker spiral from rotation ───────────────────
        let rho = (pos.x * pos.x + pos.z * pos.z).sqrt(); // cylindrical r
        let phi_hat = if rho > 0.01 {
            Vec3::new(-pos.z / rho, 0.0, pos.x / rho)
        } else {
            Vec3::ZERO
        };

        let r_alfven = STAR_RADIUS * ALFVEN_RADII;
        let v_azimuthal = if dist < r_alfven {
            // Inside Alfvén surface → co-rotating with the star.
            phi_hat * OMEGA_STAR * rho
        } else {
            // Outside → angular momentum conserved: v_φ = Ω R_A² sin θ / r
            let sin_theta = if dist > 0.01 { rho / dist } else { 0.0 };
            phi_hat * OMEGA_STAR * r_alfven * sin_theta * (r_alfven / dist)
        };

        // ── Combine: birth impulse fades, field takes over ──────────────
        let age = p.lifetime / p.max_lifetime; // 1 at birth → 0 at death
        let birth = p.velocity * age * 0.3;
        let field = v_radial + v_azimuthal;

        xform.translation += (birth + field) * dt;

        // ── Colour gradient: hot orange → cool red → dim ────────────────
        let life = p.lifetime / p.max_lifetime;
        if let Some(mat) = materials.get_mut(&mat_handle.0) {
            let color = if life > 0.7 {
                Color::srgb(1.0, 0.70, 0.30) // hot orange (near star)
            } else if life > 0.3 {
                Color::srgb(0.9, 0.50, 0.20) // cooling red-orange
            } else {
                Color::srgb(0.5, 0.25, 0.10) // dim red (far out)
            };
            mat.base_color = color.with_alpha(life);
            mat.emissive = LinearRgba::from(color) * (2.5 * life);
        }
    }
}
