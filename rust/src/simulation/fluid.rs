//! CPU-side 3-D solar velocity field.
//!
//! Implements a 16³ uniform grid covering a ±[`DOMAIN_RADIUS`] cube around
//! the star.  Each frame three physical contributions are superposed:
//!
//! 1. **Solar wind** — radial outflow that accelerates past the photosphere.
//! 2. **Differential rotation** — equatorial plasma rotates faster than polar
//!    plasma, matching the Sun's observed Carrington profile.
//! 3. **Convective supergranules** — eight large buoyancy plumes on the star
//!    surface that slowly drift and produce swirling lateral outflow.
//!
//! The resulting field is sampled by the particle system via trilinear
//! interpolation.  The same algorithm is expressed in WGSL in
//! `assets/shaders/fluid_advect.wgsl`, ready to be promoted to a GPU compute
//! pass once WebGPU support is added for native builds.

use bevy::prelude::*;

// ── Constants ────────────────────────────────────────────────────────────────

/// Grid resolution along each axis.  16³ = 4 096 cells.
const GRID_RES: usize = 16;

/// The velocity field covers a cube ±DOMAIN_RADIUS on every axis.
const DOMAIN_RADIUS: f32 = 5.0;

/// Peak solar-wind speed reached at the domain edge (world units / second).
const WIND_SPEED_MAX: f32 = 1.6;

/// Equatorial angular velocity (effective, in world-units / second).
/// Polar regions rotate at ~70 % of this value via the Carrington profile.
const OMEGA_EQ: f32 = 0.35;

/// Number of convective supergranule cells on the star surface.
const N_GRANULES: usize = 8;

// ── Data structure ────────────────────────────────────────────────────────────

/// A 3-D velocity grid wrapped as a Bevy [`Resource`].
#[derive(Resource)]
pub struct VelocityField {
    /// Flat buffer, indexed as `z * R² + y * R + x` where `R = GRID_RES`.
    cells: Vec<Vec3>,
    /// Accumulated simulation time driving time-varying features.
    time: f32,
    /// Live wind speed multiplier driven by the NOAA pipeline.
    ///
    /// 1.0 = nominal (450 km/s).  Ranges from ~0.5 (slow, 250 km/s) to
    /// ~2.5 (extreme storm, 900 km/s) as set by [`crate::apply_live_wind_scale`].
    pub wind_speed_scale: f32,
}

impl VelocityField {
    pub fn new() -> Self {
        let mut field = Self {
            cells: vec![Vec3::ZERO; GRID_RES * GRID_RES * GRID_RES],
            time: 0.0,
            wind_speed_scale: 1.0,
        };
        field.rebuild();
        field
    }

    /// Advance the field by `dt` seconds and recompute all cells.
    pub fn tick(&mut self, dt: f32) {
        self.time += dt;
        self.rebuild();
    }

    /// Sample the velocity at `world_pos` using trilinear interpolation.
    pub fn sample(&self, world_pos: Vec3) -> Vec3 {
        let r = GRID_RES as f32;
        // Map world coords [-DOMAIN_RADIUS, DOMAIN_RADIUS] → [0, GRID_RES - 1].
        let f = (world_pos + Vec3::splat(DOMAIN_RADIUS))
            / (2.0 * DOMAIN_RADIUS)
            * (r - 1.0);

        let fx = f.x.clamp(0.0, r - 1.001);
        let fy = f.y.clamp(0.0, r - 1.001);
        let fz = f.z.clamp(0.0, r - 1.001);

        let x0 = fx as usize;
        let y0 = fy as usize;
        let z0 = fz as usize;
        let x1 = (x0 + 1).min(GRID_RES - 1);
        let y1 = (y0 + 1).min(GRID_RES - 1);
        let z1 = (z0 + 1).min(GRID_RES - 1);

        let tx = fx - fx.floor();
        let ty = fy - fy.floor();
        let tz = fz - fz.floor();

        let g = GRID_RES;
        let c000 = self.cells[z0 * g * g + y0 * g + x0];
        let c100 = self.cells[z0 * g * g + y0 * g + x1];
        let c010 = self.cells[z0 * g * g + y1 * g + x0];
        let c110 = self.cells[z0 * g * g + y1 * g + x1];
        let c001 = self.cells[z1 * g * g + y0 * g + x0];
        let c101 = self.cells[z1 * g * g + y0 * g + x1];
        let c011 = self.cells[z1 * g * g + y1 * g + x0];
        let c111 = self.cells[z1 * g * g + y1 * g + x1];

        let c00 = c000.lerp(c100, tx);
        let c01 = c001.lerp(c101, tx);
        let c10 = c010.lerp(c110, tx);
        let c11 = c011.lerp(c111, tx);
        let c0 = c00.lerp(c10, ty);
        let c1 = c01.lerp(c11, ty);
        c0.lerp(c1, tz)
    }

    // ── Private: field construction ──────────────────────────────────────────

    fn rebuild(&mut self) {
        let g = GRID_RES;
        let half = DOMAIN_RADIUS;
        let t = self.time;
        let scale = self.wind_speed_scale;

        for iz in 0..g {
            for iy in 0..g {
                for ix in 0..g {
                    // World-space centre of this cell.
                    let pos = Vec3::new(
                        (ix as f32 / (g as f32 - 1.0)) * 2.0 * half - half,
                        (iy as f32 / (g as f32 - 1.0)) * 2.0 * half - half,
                        (iz as f32 / (g as f32 - 1.0)) * 2.0 * half - half,
                    );
                    self.cells[iz * g * g + iy * g + ix] = velocity_at(pos, t, scale);
                }
            }
        }
    }
}

// ── Physics ───────────────────────────────────────────────────────────────────

/// Compute the velocity at an arbitrary world position.
/// This function is also mirrored in `assets/shaders/fluid_advect.wgsl`.
fn velocity_at(pos: Vec3, t: f32, wind_scale: f32) -> Vec3 {
    let dist = pos.length();
    if dist < 0.01 {
        return Vec3::ZERO;
    }
    let r_hat = pos / dist;
    let star_r = crate::STAR_RADIUS;

    let wind = solar_wind(dist, r_hat, star_r, wind_scale);
    let rot = differential_rotation(pos, dist);
    let conv = supergranule_field(pos, r_hat, dist, star_r, t);

    // Damp everything smoothly inside the deep interior (< 50 % of star radius),
    // representing the radiative zone where convection doesn't penetrate.
    let damp = if dist < star_r * 0.5 {
        (dist / (star_r * 0.5)).powi(2)
    } else {
        1.0
    };

    (wind + rot + conv) * damp
}

/// Radial solar-wind outflow.
///
/// Zero beneath the photosphere; accelerates via a √-ramp through the corona,
/// reaching [`WIND_SPEED_MAX`] × `scale` at the domain boundary.
/// `scale` is driven live from NOAA DSCOVR/ACE measurements via
/// [`crate::prediction::solar_wind::LiveWindSpeed`].
fn solar_wind(dist: f32, r_hat: Vec3, star_r: f32, scale: f32) -> Vec3 {
    if dist <= star_r {
        return Vec3::ZERO;
    }
    let frac = ((dist - star_r) / (DOMAIN_RADIUS - star_r)).clamp(0.0, 1.0);
    r_hat * WIND_SPEED_MAX * frac.sqrt() * scale
}

/// Azimuthal rotation following the Sun's Carrington differential-rotation law:
///
/// Ω(λ) = Ω_eq × (1 − 0.3 sin²λ)
///
/// where λ is heliographic latitude.  Rotation is capped at the photospheric
/// radius so the corona co-rotates only via field lines, not bulk flow.
fn differential_rotation(pos: Vec3, dist: f32) -> Vec3 {
    let rho = (pos.x * pos.x + pos.z * pos.z).sqrt(); // cylindrical radius
    if rho < 0.01 {
        return Vec3::ZERO;
    }
    // φ̂ (azimuthal unit vector in the XZ plane, pointing in +φ direction)
    let phi_hat = Vec3::new(-pos.z / rho, 0.0, pos.x / rho);

    let sin_lat = (pos.y / dist).clamp(-1.0, 1.0); // sin of heliographic latitude
    let omega = OMEGA_EQ * (1.0 - 0.3 * sin_lat * sin_lat);

    // Velocity = Ω × R_cyl; cap R_cyl at star surface so outer corona doesn't
    // rigidly co-rotate (field-line co-rotation handled by wind term).
    let r_cyl = rho.min(crate::STAR_RADIUS);
    phi_hat * omega * r_cyl
}

/// Convective supergranulation — eight buoyancy plumes on the star surface.
///
/// Each plume:
/// - Has a fixed seed position that drifts with differential rotation.
/// - Produces radial upwelling at its centre (Gaussian falloff in angle).
/// - Drives lateral outflow away from the centre (like real supergranules).
/// - Adds a weak vortex component due to Coriolis coupling.
fn supergranule_field(pos: Vec3, r_hat: Vec3, dist: f32, star_r: f32, t: f32) -> Vec3 {
    // Seed directions for N_GRANULES plume centres (unit sphere, Y-up).
    // Chosen to be roughly evenly distributed.
    const SEEDS: [(f32, f32); N_GRANULES] = [
        (0.0, 0.0),          // (lon, lat) in radians
        (0.785, 0.524),
        (1.571, -0.524),
        (2.356, 0.785),
        (3.142, 0.0),
        (3.927, -0.785),
        (4.712, 0.524),
        (5.498, -0.262),
    ];

    let mut total = Vec3::ZERO;

    for (i, &(lon0, lat0)) in SEEDS.iter().enumerate() {
        // Each granule drifts eastward at a slightly different rate (mimicking
        // differential rotation at different latitudes).
        let drift = t * (0.08 + i as f32 * 0.012);
        let lon = lon0 + drift;
        // Slight latitude oscillation — rising and sinking over ~100 s cycle.
        let lat = lat0 + (t * (0.04 + i as f32 * 0.007)).sin() * 0.2;

        let (sin_lat, cos_lat) = lat.sin_cos();
        let (sin_lon, cos_lon) = lon.sin_cos();

        // Plume centre on the star surface.
        let centre_dir = Vec3::new(cos_lat * cos_lon, sin_lat, cos_lat * sin_lon);

        // Angular distance from the current position to this plume centre.
        let cos_angle = r_hat.dot(centre_dir).clamp(-1.0, 1.0);
        let angle = cos_angle.acos(); // 0 at centre, π at antipode

        // Gaussian envelope — plumes cover ~30° radius (π/6 ≈ 0.52 rad).
        let sigma = 0.55_f32;
        let influence = (-(angle * angle) / (2.0 * sigma * sigma)).exp();
        if influence < 0.002 {
            continue;
        }

        // ── Upwelling: strongest at centre, falls off radially ──────────────
        let upwelling_strength = (-(angle * angle) / (2.0 * (sigma * 0.6).powi(2))).exp();
        let v_up = r_hat * upwelling_strength * 0.9;

        // ── Lateral outflow: plasma streams away from centre ─────────────────
        // Project the vector (pos on star surface → plume centre) onto the
        // tangent plane at pos, giving the outflow direction.
        let pos_surf = r_hat * star_r;
        let to_centre = (centre_dir * star_r - pos_surf).normalize_or_zero();
        // Outflow points *away* from centre (−to_centre), scaled by angle.
        let outflow_frac = (angle / sigma).min(1.0);
        let v_lateral = -to_centre * outflow_frac * 0.6;

        // ── Coriolis vortex: clockwise in N hemisphere, CCW in S ─────────────
        // Approximated as a cross product with the rotation axis (Y).
        let v_vortex = r_hat.cross(Vec3::Y).normalize_or_zero()
            * (pos.y / star_r).clamp(-1.0, 1.0).signum()  // hemisphere sign
            * 0.25;

        // Damp strongly above the photosphere so granules only affect the corona
        // indirectly via wind.
        let height_damp = if dist > star_r {
            (1.0 - ((dist - star_r) / star_r).min(1.0)).powi(2)
        } else {
            1.0
        };

        total += (v_up + v_lateral + v_vortex) * influence * height_damp;
    }

    total
}

// ── Bevy system ───────────────────────────────────────────────────────────────

/// Advances the velocity field by one frame.  Must run before particle update.
pub fn update_velocity_field(time: Res<Time>, mut field: ResMut<VelocityField>) {
    field.tick(time.delta_secs());
}
