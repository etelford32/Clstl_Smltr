//! Solar prominence simulation — dense plasma suspended in flux rope dips.
//!
//! # Physical model
//!
//! **Prominences** (also called filaments when viewed on-disk) are dense,
//! cool (≈8 000 K) plasma structures suspended in the hot (>1 MK) corona
//! by magnetic fields.  They form in the dipped portions of helical flux
//! rope field lines, where gravity is balanced by the upward-concave
//! magnetic tension.
//!
//! ## Formation
//!
//! Chromospheric plasma is injected into the flux rope dips via:
//! 1. **Evaporation–condensation** — coronal heating concentrates at the
//!    loop footpoints, driving radiative condensation at the apex.
//! 2. **Levitation** — photospheric plasma is bodily lifted as the flux
//!    rope rises.
//!
//! ## Eruption
//!
//! When the parent flux rope erupts (torus or kink instability), the
//! prominence is ejected as the dense core of a coronal mass ejection
//! (CME).  The erupting prominence fragments, producing the characteristic
//! "three-part CME" structure: bright leading edge, dark cavity, and
//! bright core (the prominence material).
//!
//! # Visualisation
//!
//! Prominences are rendered as dense clusters of semi-transparent particles
//! with a characteristic cool red / magenta colour (Hα emission), distinct
//! from the hot yellow-white coronal particles.  During eruption, the
//! particles accelerate outward and gradually dissipate.

use bevy::prelude::*;

use super::flux_rope::{FluxRopeSet, RopePhase};

// ── Configuration ────────────────────────────────────────────────────────────

/// Maximum prominence particles per flux rope.
const MAX_PROM_PARTICLES: usize = 60;

/// Spawn rate: particles per second injected into each prominence.
const SPAWN_RATE: f32 = 8.0;

/// Lifetime of a prominence particle (seconds).  Long-lived because
/// prominences persist for days–weeks in reality.
const PARTICLE_LIFETIME: f32 = 12.0;

/// Prominence particle sphere radius (world units).
const PARTICLE_RADIUS: f32 = 0.04;

/// How strongly prominence particles are confined to the flux rope dip.
/// Higher = tighter confinement to the magnetic topology.
const CONFINEMENT_STRENGTH: f32 = 2.5;

/// Thermal oscillation amplitude — prominence plasma sloshes along the
/// field-line dip like a ball in a bowl.
const OSCILLATION_AMP: f32 = 0.15;

// ── Components ───────────────────────────────────────────────────────────────

/// Marks an entity as a prominence particle.
#[derive(Component)]
pub struct ProminenceParticle {
    /// Index of the parent flux rope in [`FluxRopeSet`].
    pub rope_index: usize,
    /// Parametric position along the rope axis [0, 1].
    pub axis_param: f32,
    /// Perpendicular offset from the rope axis (in the dip plane).
    pub dip_offset: Vec3,
    /// Remaining lifetime (seconds).
    pub lifetime: f32,
    /// Maximum lifetime at birth.
    #[allow(dead_code)]  // diagnostic/sampling field; preserved for HUD overlays
    pub max_lifetime: f32,
    /// Phase offset for thermal oscillation.
    pub osc_phase: f32,
}

/// Tracks the total number of prominence particles per rope.
#[derive(Resource)]
pub struct ProminenceSpawner {
    /// particle_count[rope_index] = how many live particles.
    pub counts: Vec<usize>,
    /// Fractional spawn accumulator per rope.
    accum: Vec<f32>,
}

impl Default for ProminenceSpawner {
    fn default() -> Self {
        Self {
            counts: vec![0; 8], // pre-allocate for up to 8 ropes
            accum: vec![0.0; 8],
        }
    }
}

// ── Helper: compute prominence dip position along a flux rope ────────────────

/// Returns the world-space position of the magnetic dip at parametric
/// coordinate `t` ∈ [0, 1] along the flux rope axis, plus a small
/// perpendicular offset simulating the finite thickness of the prominence.
fn dip_position(
    rope: &super::flux_rope::FluxRope,
    t: f32,
    offset: Vec3,
    time: f32,
    osc_phase: f32,
) -> Vec3 {
    let star_r = crate::STAR_RADIUS;
    let (sin_lat, cos_lat) = rope.latitude.sin_cos();
    let (sin_lon, cos_lon) = rope.longitude.sin_cos();
    let radial = Vec3::new(cos_lat * cos_lon, sin_lat, cos_lat * sin_lon);
    let axis = rope.axis_direction;

    let half_len = std::f32::consts::PI * rope.major_radius * 0.5;
    let s = (t * 2.0 - 1.0) * half_len; // [-half_len, +half_len]

    // Height profile: the dip is *below* the rope axis apex.
    // Prominences sit in the concave-upward portion of the helical field.
    // Model as an inverted parabola below the main arch.
    let height_frac = (1.0 - (s / half_len).powi(2)).max(0.0).sqrt();
    let dip_depth = rope.minor_radius * 0.6;
    let height = rope.major_radius * height_frac - dip_depth;

    // Thermal oscillation along the dip (slow sloshing).
    let osc = OSCILLATION_AMP * (time * 0.5 + osc_phase).sin();

    let base = radial * (star_r + height.max(0.05)) + axis * (s + osc);

    // Add perpendicular offset for finite prominence width.
    base + offset * rope.minor_radius * 0.4
}

// ── Bevy systems ─────────────────────────────────────────────────────────────

/// Spawns prominence particles into the dips of active (emerging) flux ropes.
pub fn spawn_prominence_particles(
    mut commands: Commands,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
    mut spawner: ResMut<ProminenceSpawner>,
    ropes: Res<FluxRopeSet>,
    time: Res<Time>,
) {
    let dt = time.delta_secs();

    // Ensure counts/accum vectors are large enough.
    while spawner.counts.len() < ropes.ropes.len() {
        spawner.counts.push(0);
        spawner.accum.push(0.0);
    }

    for (ri, rope) in ropes.ropes.iter().enumerate() {
        // Only spawn into emerging ropes with enough structure to support plasma.
        if rope.phase != RopePhase::Emerging || rope.major_radius < 0.3 {
            continue;
        }
        if spawner.counts[ri] >= MAX_PROM_PARTICLES {
            continue;
        }

        spawner.accum[ri] += SPAWN_RATE * dt;
        let to_spawn = spawner.accum[ri] as usize;
        spawner.accum[ri] -= to_spawn as f32;

        let mesh = meshes.add(Sphere::new(PARTICLE_RADIUS).mesh().uv(6, 3));

        for _ in 0..to_spawn {
            if spawner.counts[ri] >= MAX_PROM_PARTICLES {
                break;
            }

            // Random parametric position along the rope (concentrated near center).
            #[cfg(not(target_arch = "wasm32"))]
            let (axis_param, osc_phase, offset_a, offset_b, lifetime) = {
                use rand::Rng;
                let mut rng = rand::thread_rng();
                (
                    0.3 + rng.gen_range(0.0..0.4), // central region of the dip
                    rng.gen_range(0.0..std::f32::consts::TAU),
                    rng.gen_range(-1.0..1.0_f32),
                    rng.gen_range(-1.0..1.0_f32),
                    rng.gen_range(PARTICLE_LIFETIME * 0.7..PARTICLE_LIFETIME),
                )
            };

            #[cfg(target_arch = "wasm32")]
            let (axis_param, osc_phase, offset_a, offset_b, lifetime) = (
                0.3 + fastrand::f32() * 0.4,
                fastrand::f32() * std::f32::consts::TAU,
                fastrand::f32() * 2.0 - 1.0,
                fastrand::f32() * 2.0 - 1.0,
                PARTICLE_LIFETIME * 0.7 + fastrand::f32() * PARTICLE_LIFETIME * 0.3,
            );

            let offset = Vec3::new(offset_a, offset_b * 0.5, offset_a * 0.3)
                .normalize_or_zero();

            let pos = dip_position(
                rope,
                axis_param,
                offset,
                time.elapsed_secs(),
                osc_phase,
            );

            // Cool prominence colour: deep red / magenta (Hα 656.3 nm emission).
            let color = Color::srgba(0.9, 0.15, 0.25, 0.75);
            let mat = materials.add(StandardMaterial {
                base_color: color,
                emissive: LinearRgba::from(color) * 1.5,
                unlit: true,
                alpha_mode: AlphaMode::Blend,
                ..default()
            });

            commands.spawn((
                Mesh3d(mesh.clone()),
                MeshMaterial3d(mat),
                Transform::from_translation(pos),
                ProminenceParticle {
                    rope_index: ri,
                    axis_param,
                    dip_offset: offset,
                    lifetime,
                    max_lifetime: lifetime,
                    osc_phase,
                },
            ));

            spawner.counts[ri] += 1;
        }
    }
}

/// Updates prominence particle positions and handles eruption dynamics.
pub fn update_prominence_particles(
    mut commands: Commands,
    time: Res<Time>,
    ropes: Res<FluxRopeSet>,
    mut spawner: ResMut<ProminenceSpawner>,
    mut query: Query<(Entity, &mut Transform, &mut ProminenceParticle)>,
) {
    let dt = time.delta_secs();
    let t = time.elapsed_secs();

    for (entity, mut transform, mut prom) in query.iter_mut() {
        prom.lifetime -= dt;

        if prom.lifetime <= 0.0 {
            commands.entity(entity).despawn();
            if prom.rope_index < spawner.counts.len() {
                spawner.counts[prom.rope_index] =
                    spawner.counts[prom.rope_index].saturating_sub(1);
            }
            continue;
        }

        let rope = match ropes.ropes.get(prom.rope_index) {
            Some(r) => r,
            None => {
                commands.entity(entity).despawn();
                continue;
            }
        };

        match rope.phase {
            RopePhase::Emerging => {
                // Confined in the dip — track the dip position.
                let target = dip_position(
                    rope,
                    prom.axis_param,
                    prom.dip_offset,
                    t,
                    prom.osc_phase,
                );
                // Smooth following with confinement spring.
                let delta = target - transform.translation;
                transform.translation +=
                    delta * (CONFINEMENT_STRENGTH * dt).min(1.0);
            }
            RopePhase::Erupting => {
                // Prominence is ejected — accelerate outward with the rope.
                let (sin_lat, cos_lat) = rope.latitude.sin_cos();
                let (sin_lon, cos_lon) = rope.longitude.sin_cos();
                let radial =
                    Vec3::new(cos_lat * cos_lon, sin_lat, cos_lat * sin_lon);

                // Eject radially + along the rope axis.
                let eject_dir =
                    (radial * 0.8 + rope.axis_direction * 0.2).normalize_or_zero();
                let speed = rope.eruption_velocity * 0.7;
                transform.translation += eject_dir * speed * dt;

                // Kill off if too far from the star.
                if transform.translation.length() > 6.0 {
                    prom.lifetime = 0.0;
                }
            }
            RopePhase::Relaxing => {
                // Post-eruption: rapidly fade and despawn.
                prom.lifetime -= dt * 3.0; // accelerated death
            }
        }
    }
}
