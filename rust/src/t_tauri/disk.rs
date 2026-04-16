//! Accretion disk — Shakura-Sunyaev α-disk with T(r) profile and dust
//! sublimation edge for a Classical T Tauri star.
//!
//! # Physics
//!
//! The standard α-disk (Shakura & Sunyaev 1973) temperature profile is:
//!
//!   T_eff(r) = [3 G M★ Ṁ / (8π σ r³)]^{1/4} × [1 − (R★/r)^{1/2}]^{1/4}
//!
//! which simplifies to T ∝ r^{−3/4} far from the star.  We use a steeper
//! index (r^{−3/2}) to compress the full temperature range into a compact
//! visual domain (~10 R★ rather than ~100 R★ in reality).
//!
//! # Disk structure
//!
//! Three radial zones are rendered:
//!
//! | Zone | Radius | Temp | Content |
//! |------|--------|------|---------|
//! | Hot gas | R_trunc → R_sub | >1500 K | Dust-free magnetospheric gap |
//! | Sublimation edge | ≈R_sub | ~1500 K | Dust destruction front |
//! | Dusty disk | R_sub → R_outer | <1500 K | Grains, opacity, planet formation |
//!
//! # Observed parameters (from research)
//!
//!   Ṁ        ≈ 10⁻⁸ M☉/yr          (typical CTTS)
//!   α        ≈ 0.01–0.1             (viscosity parameter)
//!   R_trunc  ≈ 2–5 R★              (magnetospheric truncation)
//!   T_sub    ≈ 1500 K               (silicate dust sublimation)
//!   H/r      ≈ 0.04–0.1             (flared geometry, H/r ∝ r^{2/7})
//!   Disk mass ≈ 0.01–0.1 M★

use bevy::prelude::*;

use crate::t_tauri::star::{MaterialHandle, STAR_RADIUS};

#[cfg(not(target_arch = "wasm32"))]
use rand::Rng;

#[cfg(target_arch = "wasm32")]
use std::f32::consts::TAU;

// ── Disk geometry (world units) ─────────────────────────────────────────────

/// Magnetospheric truncation radius — inner edge of the gas disk.
/// Observed: 2–5 R★; we use 2.5 R★.
pub const R_TRUNCATION: f32 = STAR_RADIUS * 2.5; // 5.0

/// Dust sublimation front — T ≈ 1500 K.  Inside this the disk is
/// optically thin hot gas; outside it is opaque dusty material.
/// Positioned where our T(r) profile crosses 1500 K.
pub const R_SUBLIMATION: f32 = STAR_RADIUS * 2.75; // 5.5

/// Outer visible rim.  Real CTTS disks extend to 100–300 AU;
/// we cap at 4.5 R★ for the visual domain.
pub const R_OUTER: f32 = STAR_RADIUS * 4.5; // 9.0

// ── Temperature profile ─────────────────────────────────────────────────────

/// Reference temperature at R_TRUNCATION (K).
/// Hot gas near the magnetospheric boundary.
const T_REF: f32 = 5000.0;

/// Temperature power-law index.  Standard Shakura-Sunyaev is 0.75;
/// we use 1.5 to compress the 5000 K → 700 K range into our compact
/// visual domain (real disks need 100× more radial extent for this).
const T_INDEX: f32 = 1.5;

/// Dust sublimation temperature (K).
const T_SUBLIMATION: f32 = 1500.0;

/// Evaluate the effective temperature at radius `r`.
///
///   T(r) = T_REF × (r / R_TRUNCATION)^{−T_INDEX}
pub fn disk_temperature(r: f32) -> f32 {
    if r <= R_TRUNCATION {
        return T_REF;
    }
    T_REF * (r / R_TRUNCATION).powf(-T_INDEX)
}

// ── Disk flaring ────────────────────────────────────────────────────────────

/// Aspect ratio H/r at R_TRUNCATION.
const FLARE_H0: f32 = 0.04;

/// Flaring index: H/r ∝ r^{FLARE_POW}.  Irradiated disk theory gives 2/7.
const FLARE_POW: f32 = 2.0 / 7.0;

/// Scale height H(r) — half-thickness of the disk at radius `r`.
fn scale_height(r: f32) -> f32 {
    r * FLARE_H0 * (r / R_TRUNCATION).powf(FLARE_POW)
}

// ── Particle system ─────────────────────────────────────────────────────────

const MAX_DISK_PARTICLES: usize = 1500;
const DISK_SPAWN_RATE: usize = 15;
const DISK_LIFETIME: f32 = 14.0;

/// Keplerian speed scale:  v_K(r) = K_SCALE / √r.
const K_SCALE: f32 = 3.0;

#[derive(Component)]
pub struct DiskParticle {
    pub lifetime: f32,
    pub max_lifetime: f32,
    /// Orbital radius (fixed for the particle's life — circular orbit).
    pub radius: f32,
    /// Current azimuthal angle (rad).
    pub angle: f32,
    /// Vertical offset within the disk (sampled at spawn from ±H).
    pub height: f32,
}

#[derive(Resource, Default)]
pub struct DiskSpawner {
    pub count: usize,
}

// ── Spawn ───────────────────────────────────────────────────────────────────

pub fn spawn_disk_particles(
    mut commands: Commands,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
    mut spawner: ResMut<DiskSpawner>,
) {
    let budget = DISK_SPAWN_RATE.min(MAX_DISK_PARTICLES.saturating_sub(spawner.count));

    for _ in 0..budget {
        #[cfg(not(target_arch = "wasm32"))]
        let (r_frac, angle, h_frac, lifetime) = {
            let mut rng = rand::thread_rng();
            (
                rng.gen_range(0.0_f32..1.0),
                rng.gen_range(0.0..std::f32::consts::TAU),
                rng.gen_range(-1.0_f32..1.0),
                rng.gen_range(10.0..DISK_LIFETIME),
            )
        };

        #[cfg(target_arch = "wasm32")]
        let (r_frac, angle, h_frac, lifetime) = (
            fastrand::f32(),
            fastrand::f32() * TAU,
            fastrand::f32() * 2.0 - 1.0,
            10.0 + fastrand::f32() * (DISK_LIFETIME - 10.0),
        );

        // Radial distribution weighted by area:  r = R_in + √u × (R_out − R_in).
        let r = R_TRUNCATION + r_frac.sqrt() * (R_OUTER - R_TRUNCATION);

        // Vertical scatter from flared scale height (Gaussian-ish via linear).
        let h = scale_height(r) * h_frac;

        let x = r * angle.cos();
        let z = r * angle.sin();

        // Particle size: slightly larger in inner disk (emitting more).
        let size = if r < R_SUBLIMATION { 0.04 } else { 0.035 };
        let mesh = meshes.add(Sphere::new(size).mesh().uv(4, 2));

        let temp = disk_temperature(r);
        let color = temperature_to_color(temp);
        let emissive_str = emissive_for_temp(temp);

        let mat = materials.add(StandardMaterial {
            base_color: color,
            emissive: LinearRgba::from(color) * emissive_str,
            unlit: true,
            ..default()
        });

        commands.spawn((
            Mesh3d(mesh),
            MeshMaterial3d(mat.clone()),
            Transform::from_translation(Vec3::new(x, h, z)),
            DiskParticle {
                lifetime,
                max_lifetime: lifetime,
                radius: r,
                angle,
                height: h,
            },
            MaterialHandle(mat),
        ));

        spawner.count += 1;
    }
}

// ── Update: Keplerian differential rotation ─────────────────────────────────

/// Advance each disk particle along its Keplerian orbit.
///
///   ω(r) = v_K / r = K_SCALE × r^{−3/2}
///
/// Inner particles orbit faster than outer ones, producing the classic
/// differential-rotation shear visible in the particle field.
pub fn update_disk_particles(
    mut commands: Commands,
    time: Res<Time>,
    mut spawner: ResMut<DiskSpawner>,
    mut query: Query<(Entity, &mut Transform, &mut DiskParticle, &MaterialHandle)>,
    mut materials: ResMut<Assets<StandardMaterial>>,
) {
    let dt = time.delta_secs();
    let t_global = time.elapsed_secs();

    for (entity, mut xform, mut p, mat_handle) in query.iter_mut() {
        p.lifetime -= dt;
        if p.lifetime <= 0.0 {
            commands.entity(entity).despawn();
            spawner.count = spawner.count.saturating_sub(1);
            continue;
        }

        // Keplerian angular velocity.
        let omega = K_SCALE / p.radius.powf(1.5);
        p.angle += omega * dt;

        // XZ orbital position.
        xform.translation.x = p.radius * p.angle.cos();
        xform.translation.z = p.radius * p.angle.sin();

        // Gentle vertical oscillation (MHD turbulence in the disk).
        let osc = (t_global * 0.3 + p.angle * 2.0 + p.radius).sin() * 0.015 * p.radius;
        xform.translation.y = p.height + osc;

        // Fade out at end of life.
        let life = p.lifetime / p.max_lifetime;
        if let Some(mat) = materials.get_mut(&mat_handle.0) {
            let temp = disk_temperature(p.radius);
            let color = temperature_to_color(temp);
            let em = emissive_for_temp(temp);
            mat.base_color = color.with_alpha(life);
            mat.emissive = LinearRgba::from(color) * (em * life);
        }
    }
}

// ── Gizmo rendering: structural rings ───────────────────────────────────────

/// Draw key radial markers:
/// - Magnetospheric truncation (inner rim) — blue-white
/// - Dust sublimation edge — pulsing orange glow
/// - Temperature isotherms — faint colour-coded rings
/// - Outer rim — dim edge marker
pub fn draw_disk_structure(mut gizmos: Gizmos, time: Res<Time>) {
    let t = time.elapsed_secs();

    // ── Magnetospheric truncation — bright inner rim ────────────────────
    // Hot gas meets the stellar magnetosphere here.
    let trunc_alpha = 0.35 + 0.1 * (t * 1.5).sin();
    draw_ring(
        &mut gizmos,
        R_TRUNCATION,
        64,
        Color::srgba(0.7, 0.8, 1.0, trunc_alpha),
    );

    // ── Dust sublimation edge — the headline feature ────────────────────
    // This is where silicate grains are actively being destroyed at ~1500 K.
    // Rendered as a bright, pulsing double-ring.
    let sub_pulse = 1.0 + 0.2 * (t * 2.0).sin();
    let sub_alpha = (0.55 * sub_pulse).min(1.0);
    draw_ring(
        &mut gizmos,
        R_SUBLIMATION,
        80,
        Color::srgba(1.0, 0.6, 0.15, sub_alpha),
    );
    // Outer halo of the sublimation front.
    draw_ring(
        &mut gizmos,
        R_SUBLIMATION * 1.03,
        80,
        Color::srgba(1.0, 0.45, 0.1, sub_alpha * 0.4),
    );
    // Inner halo.
    draw_ring(
        &mut gizmos,
        R_SUBLIMATION * 0.97,
        80,
        Color::srgba(1.0, 0.75, 0.3, sub_alpha * 0.3),
    );

    // ── Temperature isotherms ───────────────────────────────────────────
    // Faint rings at key temperatures to show the thermal gradient.
    for &temp_k in &[3000.0_f32, T_SUBLIMATION, 1000.0] {
        // Invert the profile: r = R_TRUNC × (T_REF / T)^{1/T_INDEX}
        let r = R_TRUNCATION * (T_REF / temp_k).powf(1.0 / T_INDEX);
        if r > R_TRUNCATION && r < R_OUTER {
            let color = temperature_to_color(temp_k);
            draw_ring(&mut gizmos, r, 48, color.with_alpha(0.12));
        }
    }

    // ── Outer rim — faint boundary ──────────────────────────────────────
    draw_ring(
        &mut gizmos,
        R_OUTER,
        80,
        Color::srgba(0.25, 0.12, 0.05, 0.15),
    );
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/// Draw a flat ring in the XZ plane (disk midplane) at the given radius.
fn draw_ring(gizmos: &mut Gizmos, radius: f32, segments: usize, color: Color) {
    let tau = std::f32::consts::TAU;
    for j in 0..segments {
        let a0 = j as f32 / segments as f32 * tau;
        let a1 = (j + 1) as f32 / segments as f32 * tau;
        let p0 = Vec3::new(radius * a0.cos(), 0.0, radius * a0.sin());
        let p1 = Vec3::new(radius * a1.cos(), 0.0, radius * a1.sin());
        gizmos.line(p0, p1, color);
    }
}

/// Map a blackbody temperature (K) to approximate sRGB colour.
///
/// Tuned for the 500–6000 K range relevant to T Tauri accretion disks:
///
/// | Temp (K) | Colour | Zone |
/// |----------|--------|------|
/// | >4000 | yellow-white | hot inner gas |
/// | 2500–4000 | orange | warm gas/dust boundary |
/// | 1500–2500 | red-orange | sublimation zone |
/// | 800–1500 | deep red | warm dusty disk |
/// | <800 | dim brown | cold outer disk |
fn temperature_to_color(t_kelvin: f32) -> Color {
    let t = t_kelvin.clamp(500.0, 6000.0);

    if t > 4000.0 {
        // Yellow-white → white
        let f = (t - 4000.0) / 2000.0;
        Color::srgb(1.0, 0.88 + f * 0.07, 0.55 + f * 0.25)
    } else if t > 2500.0 {
        // Orange → yellow
        let f = (t - 2500.0) / 1500.0;
        Color::srgb(1.0, 0.55 + f * 0.33, 0.15 + f * 0.40)
    } else if t > 1500.0 {
        // Red-orange → orange
        let f = (t - 1500.0) / 1000.0;
        Color::srgb(0.85 + f * 0.15, 0.3 + f * 0.25, 0.05 + f * 0.10)
    } else if t > 800.0 {
        // Deep red → red-orange
        let f = (t - 800.0) / 700.0;
        Color::srgb(0.5 + f * 0.35, 0.12 + f * 0.18, 0.02 + f * 0.03)
    } else {
        // Dim brown-red
        let f = (t - 500.0) / 300.0;
        Color::srgb(0.2 + f * 0.3, 0.05 + f * 0.07, 0.01 + f * 0.01)
    }
}

/// Emissive intensity scaled by temperature — hotter gas glows brighter.
fn emissive_for_temp(t_kelvin: f32) -> f32 {
    if t_kelvin > 3000.0 {
        3.5
    } else if t_kelvin > 1500.0 {
        2.5
    } else {
        1.5
    }
}
