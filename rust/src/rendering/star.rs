//! Star rendering — StandardMaterial with dynamic glow, plus gizmo-based
//! spicules, microflares, coronal streamers, and CME shockwave visuals.
//!
//! All rendering uses Bevy's built-in `StandardMaterial` (no custom WGSL)
//! for maximum compatibility across native + WebGL2 + WebGPU.  Rich solar
//! detail is achieved through per-frame material mutation and gizmo drawing.

use bevy::core_pipeline::tonemapping::Tonemapping;
use bevy::prelude::*;

use crate::camera::CameraController;
use crate::prediction::flare_ml::FlareMLPrediction;
use crate::prediction::solar_wind::LiveWindSpeed;
use crate::simulation::flux_rope::{FluxRopeSet, RopePhase};
use crate::{MAX_PARTICLES, STAR_RADIUS};

const STAR_COLOR: Color = Color::srgb(1.0, 0.9, 0.3);

/// Corona visual extent (world units).
const CORONA_EXTENT: f32 = STAR_RADIUS * 2.5;

/// Number of spicule hair lines drawn each frame.
const NUM_SPICULES: usize = 120;

/// Number of microflare points drawn each frame.
const NUM_MICROFLARES: usize = 10;

/// Number of coronal streamer lines per hemisphere.
const NUM_STREAMERS: usize = 8;

// ── Components ───────────────────────────────────────────────────────────────

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
) {
    // ── 1. Star sphere (StandardMaterial, reliable everywhere) ───────────
    let star_mesh = meshes.add(Sphere::new(STAR_RADIUS).mesh().uv(128, 64));

    let star_material = materials.add(StandardMaterial {
        base_color: STAR_COLOR,
        emissive: LinearRgba::from(STAR_COLOR) * 3.0,
        unlit: true,
        ..default()
    });

    commands.spawn((
        Mesh3d(star_mesh),
        MeshMaterial3d(star_material.clone()),
        Transform::from_xyz(0.0, 0.0, 0.0),
        Star {
            pulse_speed: 2.0,
            base_intensity: 3.0,
        },
        MaterialHandle(star_material),
    ));

    // ── 2. Lighting ─────────────────────────────────────────────────────────
    commands.spawn((
        PointLight {
            intensity: 400_000.0,
            color: STAR_COLOR,
            range: 100.0,
            radius: STAR_RADIUS,
            shadows_enabled: false,
            ..default()
        },
        Transform::from_xyz(0.0, 0.0, 0.0),
    ));

    commands.insert_resource(AmbientLight {
        color: Color::srgb(0.08, 0.08, 0.12),
        brightness: 200.0,
        affects_lightmapped_meshes: false,
    });

    // ── 3. Camera with tonemapping (no bloom — keep it clean) ───────────
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

    println!("\n=== Parker Physics — Solar Flare ML Simulation ===");
    println!("Controls:");
    println!("  Arrow Keys - Rotate camera");
    println!("  W/S        - Zoom in/out");
    println!("  R          - Reset camera");
    println!("  ESC        - Exit");
    println!("Max particles: {}", MAX_PARTICLES);
    println!("===================================================\n");
}

// ── Star glow (pulsing emissive + flare-reactive) ────────────────────────────

/// Animate star emissive: base pulse + flare brightening + activity scaling.
pub fn update_star_glow(
    time: Res<Time>,
    ropes: Res<FluxRopeSet>,
    prediction: Res<FlareMLPrediction>,
    query: Query<(&Star, &MaterialHandle)>,
    mut materials: ResMut<Assets<StandardMaterial>>,
) {
    for (star, mat_handle) in query.iter() {
        if let Some(material) = materials.get_mut(&mat_handle.0) {
            let t = time.elapsed_secs();

            // Base pulse (slow breathing).
            let pulse = (t * star.pulse_speed).sin() * 0.15 + 1.0;

            // Flare brightening: erupting ropes flash the whole star.
            let mut flare_boost = 0.0_f32;
            for rope in &ropes.ropes {
                if rope.phase == RopePhase::Erupting {
                    let flash = (-rope.phase_timer * 0.8).exp();
                    flare_boost += flash * 0.5;
                }
            }

            // Activity-modulated base level.
            let activity = prediction.activity_scale;
            let intensity = star.base_intensity * pulse * (0.8 + activity * 0.2)
                + flare_boost;

            // Shift colour toward white-blue during flares.
            let flare_frac = flare_boost.min(1.0);
            let r = 1.0;
            let g = 0.9 - flare_frac * 0.15;
            let b = 0.3 + flare_frac * 0.5;
            let color = Color::srgb(r, g, b);

            material.base_color = color;
            material.emissive = LinearRgba::from(color) * intensity;
        }
    }
}

// ── Spicule / coronal hair rendering ─────────────────────────────────────────

/// Draw spicule "hairs" — thin radial jets at the solar limb.
///
/// Each spicule is a short line segment shooting outward from the photosphere.
/// Heights vary (type I: 5000 km ≈ 0.15 R, type II: 10000 km ≈ 0.3 R).
/// They animate with gentle sway.
pub fn draw_spicules(mut gizmos: Gizmos, time: Res<Time>) {
    let t = time.elapsed_secs();
    let r = STAR_RADIUS;

    for i in 0..NUM_SPICULES {
        let fi = i as f32;
        // Distribute around the full sphere.
        let theta = fi * 2.399; // golden angle
        let phi = (fi * 0.618 + 0.3).fract() * std::f32::consts::PI;

        let dir = Vec3::new(
            phi.sin() * theta.cos(),
            phi.cos(),
            phi.sin() * theta.sin(),
        )
        .normalize();

        // Height varies per spicule, animated.
        let type_ii = (fi * 7.3 + t * 0.2).sin() > 0.6;
        let base_height = if type_ii { 0.25 } else { 0.12 };
        let height = base_height + 0.05 * (t * 1.5 + fi * 3.7).sin().abs();

        // Slight tangential sway.
        let sway = Vec3::new(
            (t * 0.8 + fi * 2.1).sin() * 0.02,
            (t * 0.6 + fi * 1.3).cos() * 0.015,
            (t * 1.1 + fi * 0.9).sin() * 0.02,
        );

        let base = dir * (r * 1.005);
        let tip = dir * (r + height) + sway;

        // Type II spicules are brighter and bluer.
        let alpha = 0.2 + 0.15 * (t * 2.0 + fi * 5.0).sin().abs();
        let color = if type_ii {
            Color::srgba(0.7, 0.85, 1.0, alpha * 0.8)
        } else {
            Color::srgba(1.0, 0.6, 0.3, alpha * 0.5)
        };

        gizmos.line(base, tip, color);
    }
}

// ── Microflare rendering ─────────────────────────────────────────────────────

/// Draw microflare transient brightenings — small bright points that pulse.
///
/// These represent nanoflare reconnection events (Parker 1988 coronal heating).
/// Each appears as a short-lived bright cross/star at a random surface location.
pub fn draw_microflares(mut gizmos: Gizmos, time: Res<Time>) {
    let t = time.elapsed_secs();
    let r = STAR_RADIUS;

    for i in 0..NUM_MICROFLARES {
        let fi = i as f32;
        // Position cycles slowly so microflares appear to pop up and fade.
        let seed_t = t * 0.15 + fi * 13.7;
        let theta = (seed_t * 0.7).sin() * std::f32::consts::TAU;
        let phi = (seed_t * 0.43 + fi * 1.9).cos().acos();

        let dir = Vec3::new(
            phi.sin() * theta.cos(),
            phi.cos(),
            phi.sin() * theta.sin(),
        )
        .normalize();

        // Blink envelope: each microflare is visible for ~1-2 seconds.
        let blink_phase = t * (0.8 + fi * 0.3) + fi * 11.0;
        let blink = (blink_phase.sin()).max(0.0).powi(4); // sharp pulse
        if blink < 0.05 {
            continue; // not visible this frame
        }

        let pos = dir * (r * 1.01);
        let size = 0.06 + 0.04 * blink;

        // Build a tangent frame for the cross shape.
        let up = if dir.y.abs() > 0.9 { Vec3::X } else { Vec3::Y };
        let tangent_a = dir.cross(up).normalize() * size;
        let tangent_b = dir.cross(tangent_a).normalize() * size;

        let alpha = blink * 0.9;
        let color = Color::srgba(1.0, 0.95, 0.7, alpha);

        // Draw a small cross at the microflare site.
        gizmos.line(pos - tangent_a, pos + tangent_a, color);
        gizmos.line(pos - tangent_b, pos + tangent_b, color);
        // Radial tick showing energy release direction.
        gizmos.line(pos, pos + dir * size * 1.5, color);
    }
}

// ── Coronal streamer rendering ───────────────────────────────────────────────

/// Draw coronal streamers — elongated brightness features extending radially.
///
/// Helmet streamers form along the magnetic neutral line (equatorial belt).
/// Polar plumes are narrower features at the poles.
pub fn draw_coronal_streamers(
    mut gizmos: Gizmos,
    time: Res<Time>,
    wind: Res<LiveWindSpeed>,
) {
    let t = time.elapsed_secs();
    let r = STAR_RADIUS;
    let wind_scale = 0.5 + wind.speed_norm * 2.0;

    // ── Equatorial helmet streamers ─────────────────────────────────────────
    for i in 0..NUM_STREAMERS {
        let fi = i as f32;
        let lon = fi * std::f32::consts::TAU / NUM_STREAMERS as f32
            + t * 0.05 * wind_scale;

        // Streamers are near the equator with slight latitude wobble.
        let lat = (t * 0.03 + fi * 1.2).sin() * 0.15;

        let dir = Vec3::new(
            lat.cos() * lon.cos(),
            lat.sin(),
            lat.cos() * lon.sin(),
        )
        .normalize();

        let n_points = 12;
        let max_height = CORONA_EXTENT - r;

        for j in 0..n_points {
            let frac0 = j as f32 / n_points as f32;
            let frac1 = (j + 1) as f32 / n_points as f32;
            let h0 = r + frac0 * max_height;
            let h1 = r + frac1 * max_height;

            // Slight curvature from solar wind deflection.
            let bend = Vec3::Y * frac0 * frac0 * 0.1;
            let p0 = dir * h0 + bend;
            let p1 = dir * h1 + bend;

            // Fade with distance: bright near surface, dim at extent.
            let alpha = (1.0 - frac0) * 0.25;
            // Streamers are pale white-yellow.
            let color = Color::srgba(0.95, 0.9, 0.7, alpha);

            gizmos.line(p0, p1, color);
        }
    }

    // ── Polar plumes ────────────────────────────────────────────────────────
    for pole_sign in [-1.0_f32, 1.0] {
        for i in 0..4 {
            let fi = i as f32;
            let angle = fi * std::f32::consts::TAU / 4.0
                + t * 0.02 + pole_sign * 0.5;

            let spread = 0.2; // narrow cone around pole
            let dir = Vec3::new(
                spread * angle.cos(),
                pole_sign,
                spread * angle.sin(),
            )
            .normalize();

            let n_points = 8;
            let max_height = (CORONA_EXTENT - r) * 0.7;

            for j in 0..n_points {
                let frac0 = j as f32 / n_points as f32;
                let frac1 = (j + 1) as f32 / n_points as f32;

                let p0 = dir * (r + frac0 * max_height);
                let p1 = dir * (r + frac1 * max_height);

                let alpha = (1.0 - frac0) * 0.15;
                let color = Color::srgba(0.6, 0.8, 1.0, alpha);

                gizmos.line(p0, p1, color);
            }
        }
    }
}

// ── CME shockwave rendering ──────────────────────────────────────────────────

/// Draw expanding CME shockwave rings when a flux rope is erupting.
pub fn draw_cme_shockwaves(
    mut gizmos: Gizmos,
    time: Res<Time>,
    ropes: Res<FluxRopeSet>,
) {
    let t = time.elapsed_secs();

    for rope in &ropes.ropes {
        if rope.phase != RopePhase::Erupting {
            continue;
        }

        let lon_drift = t * 0.31;
        let (sin_lat, cos_lat) = rope.latitude.sin_cos();
        let (sin_lon, cos_lon) = (rope.longitude + lon_drift).sin_cos();
        let erupt_dir = Vec3::new(cos_lat * cos_lon, sin_lat, cos_lat * sin_lon);

        // Expanding shock ring.
        let age = rope.phase_timer;
        let shock_radius = STAR_RADIUS + age * rope.eruption_velocity * 0.5;
        let fade = (-age * 0.3).exp();

        if fade < 0.02 || shock_radius > CORONA_EXTENT * 1.5 {
            continue;
        }

        // Build tangent frame at eruption direction.
        let up = if erupt_dir.y.abs() > 0.9 { Vec3::X } else { Vec3::Y };
        let tang_a = erupt_dir.cross(up).normalize();
        let tang_b = erupt_dir.cross(tang_a).normalize();

        // Draw the shock ring as a polygon.
        let n_ring = 32;
        for j in 0..n_ring {
            let a0 = j as f32 / n_ring as f32 * std::f32::consts::TAU;
            let a1 = (j + 1) as f32 / n_ring as f32 * std::f32::consts::TAU;

            let ring_radius = shock_radius * 0.4;
            let p0 = erupt_dir * shock_radius
                + (tang_a * a0.cos() + tang_b * a0.sin()) * ring_radius;
            let p1 = erupt_dir * shock_radius
                + (tang_a * a1.cos() + tang_b * a1.sin()) * ring_radius;

            let alpha = fade * 0.6;
            let color = Color::srgba(1.0, 0.95, 0.8, alpha);
            gizmos.line(p0, p1, color);
        }

        // Inner bright flash at eruption site.
        if age < 2.0 {
            let flash_alpha = (1.0 - age / 2.0) * 0.8;
            let flash_color = Color::srgba(1.0, 1.0, 0.9, flash_alpha);
            let flash_r = STAR_RADIUS * 0.15;
            for j in 0..16 {
                let a0 = j as f32 / 16.0 * std::f32::consts::TAU;
                let a1 = (j + 1) as f32 / 16.0 * std::f32::consts::TAU;
                let center = erupt_dir * (STAR_RADIUS * 1.02);
                let p0 = center + (tang_a * a0.cos() + tang_b * a0.sin()) * flash_r;
                let p1 = center + (tang_a * a1.cos() + tang_b * a1.sin()) * flash_r;
                gizmos.line(p0, p1, flash_color);
            }
        }
    }
}
