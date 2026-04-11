//! Magnetic flux rope model — Titov–Démoulin analytic framework.
//!
//! # Physical model
//!
//! A **flux rope** is a bundle of helically twisted magnetic field lines
//! suspended in the solar corona.  The rope stores free magnetic energy
//! injected by photospheric shearing and flux cancellation.  When the
//! overlying strapping field can no longer confine the rope, it erupts —
//! producing a solar flare and coronal mass ejection (CME).
//!
//! ## Titov–Démoulin (1999) configuration
//!
//! The rope is parametrised by:
//! - **Major radius** `R` — distance from the torus axis to the centre of the
//!   current channel (i.e. height above the photosphere).
//! - **Minor radius** `a` — cross-sectional radius of the current channel.
//! - **Twist** `Φ` — total number of field-line turns (toroidal twist), related
//!   to the toroidal flux and poloidal current.
//! - **Toroidal flux** `Φ_t` — axial magnetic flux threading the cross-section.
//! - **Axial current** `I` — drives the poloidal (azimuthal) field component.
//!
//! ## Free magnetic energy
//!
//! E_free ≈ (μ₀ I² / 4π) × [ln(8R/a) − 2 + ℓ_i/2]
//!
//! where ℓ_i ≈ 0.5 is the internal inductance per unit length.
//!
//! ## Eruption criterion — torus instability
//!
//! The rope erupts when the **decay index** `n` of the external strapping
//! field exceeds a critical value n_crit ≈ 1.5:
//!
//!   n = −(R / B_ext) × dB_ext/dR
//!
//! Below this threshold the hoop force (outward, ∝ I²/R) is balanced by
//! the strapping tension (inward, ∝ B_ext).  Above it the equilibrium is
//! lost and the rope accelerates outward — this is the flare / CME onset.
//!
//! ## Kink instability
//!
//! Even below the torus threshold, a rope can erupt via the helical kink
//! instability when the safety factor q < 1 (twist Φ > 2π).  This
//! triggers internal reconnection and partial eruption (confined flares).
//!
//! # Integration with the simulation
//!
//! Each flux rope is attached to an active region (bipole) from
//! [`super::magnetic`].  The rope:
//! 1. Slowly accumulates twist and free energy from photospheric driving.
//! 2. Deforms the local magnetic field (adds toroidal + poloidal components).
//! 3. Supports dense prominence plasma in its dipped field lines.
//! 4. Erupts when torus or kink threshold is crossed, triggering CME
//!    particles and flare brightening.
//!
//! When driven by **live NASA DONKI data** (via [`crate::prediction::flare_ml`]),
//! the rope's energy injection rate and eruption timing are modulated by
//! real observed active-region properties.

use bevy::prelude::*;

// ── Physical constants (CGS-Gaussian, normalised to simulation units) ────────

/// Permeability of free space / 4π (in simulation units, set to 1 for
/// normalised MHD).
const MU0_OVER_4PI: f32 = 1.0;

/// Critical torus-instability decay index.  Theoretical value ~1.5;
/// observational studies (Zuccarello+ 2015) find 1.3–1.7.
const N_CRIT_TORUS: f32 = 1.5;

/// Critical twist for kink instability (safety factor q < 1 ↔ Φ > 2π).
const TWIST_CRIT_KINK: f32 = std::f32::consts::TAU; // 2π

/// Minimum rope height (major radius) at formation — just above the
/// photosphere.  In world units (star radius ≈ 2.0).
const R_MIN: f32 = 0.15;

/// Maximum height before rope exits the simulation domain.
const R_MAX: f32 = 4.5;

/// Internal inductance per unit length (ℓ_i ≈ 0.5 for uniform current).
const L_INTERNAL: f32 = 0.5;

/// Base energy injection rate (twist per second) from photospheric shearing.
/// Modulated by ML-inferred active-region complexity.
const BASE_TWIST_RATE: f32 = 0.04;

/// Rope acceleration during eruption (world units / s²).
const ERUPTION_ACCEL: f32 = 3.0;

/// Seconds between flux rope physics updates (decoupled from render frame).
const PHYSICS_DT: f32 = 0.1;

// ── Data structures ─────────────────────────────────────────────────────────

/// Current phase of a flux rope's lifecycle.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RopePhase {
    /// Quasi-static rise — accumulating twist and free energy.
    Emerging,
    /// Torus/kink threshold crossed — accelerating eruption.
    Erupting,
    /// Post-eruption: reconnection/relaxation, then reform.
    Relaxing,
}

/// A single magnetic flux rope anchored to an active region.
#[derive(Debug, Clone)]
pub struct FluxRope {
    /// Active-region index (matches bipole ordering in [`super::magnetic`]).
    pub ar_index: usize,

    /// Major radius — height of the rope axis above the photosphere (world units).
    pub major_radius: f32,
    /// Minor radius — cross-sectional radius of the current channel.
    pub minor_radius: f32,

    /// Accumulated toroidal twist Φ (radians).  Kink unstable above 2π.
    pub twist: f32,
    /// Axial current I driving the poloidal field.
    pub axial_current: f32,

    /// Free magnetic energy stored in the rope (arbitrary units).
    pub free_energy: f32,

    /// Decay index n of the external strapping field at the rope apex.
    pub decay_index: f32,

    /// Current lifecycle phase.
    pub phase: RopePhase,

    /// Heliographic latitude of the rope footpoint midpoint (radians).
    pub latitude: f32,
    /// Heliographic longitude of the rope footpoint midpoint (radians).
    pub longitude: f32,

    /// Direction the rope axis extends along the PIL (unit vector in
    /// the tangent plane at the footpoint).
    pub axis_direction: Vec3,

    /// Chirality: +1 for dextral, −1 for sinistral.
    pub chirality: f32,

    /// ML-driven energy injection multiplier.  1.0 = baseline.
    /// Higher values mean the active region is more complex / flare-productive.
    pub ml_activity_scale: f32,

    /// Velocity during eruption (world units / s).
    pub eruption_velocity: f32,

    /// Time spent in current phase (seconds).
    pub phase_timer: f32,

    /// Total energy released in the most recent eruption (for flare class).
    pub last_eruption_energy: f32,
}

impl FluxRope {
    /// Create a new flux rope at an active region.
    pub fn new(ar_index: usize, latitude: f32, longitude: f32, chirality: f32) -> Self {
        let (sin_lat, cos_lat) = latitude.sin_cos();
        let (sin_lon, cos_lon) = longitude.sin_cos();

        // Surface normal at the footpoint midpoint.
        let normal = Vec3::new(cos_lat * cos_lon, sin_lat, cos_lat * sin_lon);
        // PIL direction — roughly east–west along the equator, tilted by Joy's law.
        // Approximate as tangent perpendicular to the radial and rotation axis.
        let axis = normal.cross(Vec3::Y).normalize_or_zero();

        Self {
            ar_index,
            major_radius: R_MIN,
            minor_radius: R_MIN * 0.3,
            twist: 0.0,
            axial_current: 0.1,
            free_energy: 0.0,
            decay_index: 0.0,
            phase: RopePhase::Emerging,
            latitude,
            longitude,
            axis_direction: axis,
            chirality,
            ml_activity_scale: 1.0,
            eruption_velocity: 0.0,
            phase_timer: 0.0,
            last_eruption_energy: 0.0,
        }
    }

    /// World-space position of the rope apex (top of the torus loop).
    pub fn apex_position(&self) -> Vec3 {
        let star_r = crate::STAR_RADIUS;
        let (sin_lat, cos_lat) = self.latitude.sin_cos();
        let (sin_lon, cos_lon) = self.longitude.sin_cos();
        let radial = Vec3::new(cos_lat * cos_lon, sin_lat, cos_lat * sin_lon);
        radial * (star_r + self.major_radius)
    }

    /// Compute the free magnetic energy using the Titov–Démoulin self-inductance.
    ///
    /// E_free = (μ₀ I² / 4π) × R × [ln(8R/a) − 2 + ℓ_i/2]
    fn compute_free_energy(&self) -> f32 {
        let r = self.major_radius.max(0.01);
        let a = self.minor_radius.max(0.001);
        let ln_term = (8.0 * r / a).ln() - 2.0 + L_INTERNAL / 2.0;
        MU0_OVER_4PI * self.axial_current.powi(2) * r * ln_term.max(0.0)
    }

    /// Estimate the decay index of the external (strapping) dipole field
    /// at the current rope height.
    ///
    /// For a dipole: B_ext ∝ 1/r³ → n = 3 at all heights.
    /// With active-region overlay the effective n is lower near the surface
    /// and increases with height.  We model this as:
    ///   n(R) ≈ n_surface + (3 − n_surface) × tanh(R / R_scale)
    /// where n_surface ≈ 0.5 and R_scale ≈ 0.8.
    fn compute_decay_index(&self) -> f32 {
        let n_surface = 0.5;
        let n_dipole = 3.0;
        let r_scale = 0.8;
        n_surface + (n_dipole - n_surface) * (self.major_radius / r_scale).tanh()
    }

    /// Compute the magnetic field contribution of this flux rope at an
    /// arbitrary world-space position.  Returns the additional B-field
    /// vector to be superposed with the background dipole + AR field.
    ///
    /// The rope field is modelled as a Gold–Hoyle flux tube (force-free,
    /// constant-α, cylindrical):
    ///   B_axial   = B₀ / (1 + α²r²)
    ///   B_poloidal = B₀αr / (1 + α²r²)
    /// where r is the perpendicular distance from the rope axis and
    /// α = twist / (π R).
    pub fn field_at(&self, world_pos: Vec3) -> Vec3 {
        if self.phase == RopePhase::Relaxing {
            return Vec3::ZERO;
        }

        let apex = self.apex_position();
        let star_r = crate::STAR_RADIUS;
        let (sin_lat, cos_lat) = self.latitude.sin_cos();
        let (sin_lon, cos_lon) = self.longitude.sin_cos();
        let radial = Vec3::new(cos_lat * cos_lon, sin_lat, cos_lat * sin_lon);

        // Rope axis direction (along the PIL).
        let axis = self.axis_direction;
        // Poloidal direction (radial × axis).
        let poloid = radial.cross(axis).normalize_or_zero();

        // Closest point on the rope axis to world_pos:
        // Project onto the torus centre-line (simplified as a circular arc).
        let to_pos = world_pos - radial * star_r;
        let along_axis = to_pos.dot(axis);
        // Clamp along-axis extent to half the rope length (≈ π R for a semicircle).
        let half_len = std::f32::consts::PI * self.major_radius * 0.5;
        let clamped = along_axis.clamp(-half_len, half_len);

        // Point on the axis closest to world_pos.
        let axis_point = radial * (star_r + self.major_radius) + axis * clamped;
        let delta = world_pos - axis_point;
        let perp_dist = delta.length();

        let a = self.minor_radius.max(0.001);
        if perp_dist > a * 4.0 {
            return Vec3::ZERO; // too far from the rope — negligible contribution
        }

        // Gold–Hoyle parameter α.
        let alpha = self.twist / (std::f32::consts::PI * self.major_radius).max(0.01);
        let b0 = self.axial_current * 0.5; // field strength proportional to current

        let denom = 1.0 + alpha * alpha * perp_dist * perp_dist;
        let b_axial = b0 / denom;
        let b_poloidal = b0 * alpha * perp_dist / denom;

        // Direction of the poloidal component (circular around the axis).
        let perp_dir = if perp_dist > 0.001 {
            delta.normalize()
        } else {
            poloid
        };
        let circ_dir = axis.cross(perp_dir).normalize_or_zero() * self.chirality;

        axis * b_axial + circ_dir * b_poloidal
    }

    /// Advance the rope physics by dt seconds.
    pub fn step(&mut self, dt: f32) {
        self.phase_timer += dt;

        match self.phase {
            RopePhase::Emerging => self.step_emerging(dt),
            RopePhase::Erupting => self.step_erupting(dt),
            RopePhase::Relaxing => self.step_relaxing(dt),
        }

        // Recompute derived quantities.
        self.free_energy = self.compute_free_energy();
        self.decay_index = self.compute_decay_index();
    }

    /// Quasi-static emergence: inject twist, grow current, check thresholds.
    fn step_emerging(&mut self, dt: f32) {
        // Photospheric shearing injects twist.
        let twist_rate = BASE_TWIST_RATE * self.ml_activity_scale;
        self.twist += twist_rate * dt;

        // Axial current grows with twist (simplified Ampere's law).
        self.axial_current += 0.02 * self.ml_activity_scale * dt;

        // Rope slowly rises due to increasing magnetic pressure.
        let rise_rate = 0.01 * (self.twist / TWIST_CRIT_KINK).min(2.0);
        self.major_radius += rise_rate * dt;
        self.minor_radius = self.major_radius * 0.3;

        // Check eruption thresholds.
        let n = self.compute_decay_index();
        let torus_unstable = n > N_CRIT_TORUS;
        let kink_unstable = self.twist > TWIST_CRIT_KINK;

        if torus_unstable || kink_unstable {
            self.phase = RopePhase::Erupting;
            self.phase_timer = 0.0;
            self.eruption_velocity = 0.5; // initial kick
            self.last_eruption_energy = self.free_energy;
        }
    }

    /// Eruption: rapid acceleration, energy release.
    fn step_erupting(&mut self, dt: f32) {
        // Accelerate outward (hoop force dominates).
        self.eruption_velocity += ERUPTION_ACCEL * dt;
        self.major_radius += self.eruption_velocity * dt;

        // Energy dissipates via reconnection (exponential decay).
        self.free_energy *= (1.0 - 2.0 * dt).max(0.0);
        self.twist *= (1.0 - 1.5 * dt).max(0.0);
        self.axial_current *= (1.0 - 1.0 * dt).max(0.0);

        // Transition to relaxing once the rope exits the domain or energy depletes.
        if self.major_radius > R_MAX || self.free_energy < 0.01 {
            self.phase = RopePhase::Relaxing;
            self.phase_timer = 0.0;
        }
    }

    /// Post-eruption relaxation: reform the rope from scratch.
    fn step_relaxing(&mut self, dt: f32) {
        // After a cooldown, reset and begin re-emergence.
        let cooldown = 15.0 / self.ml_activity_scale.max(0.1);
        if self.phase_timer > cooldown {
            self.major_radius = R_MIN;
            self.minor_radius = R_MIN * 0.3;
            self.twist = 0.0;
            self.axial_current = 0.1;
            self.free_energy = 0.0;
            self.eruption_velocity = 0.0;
            self.phase = RopePhase::Emerging;
            self.phase_timer = 0.0;
        }
    }

    /// Classify the most recent eruption as a GOES flare class.
    ///
    /// Maps free energy at eruption onset to the logarithmic GOES scale:
    ///   A < 1e-8, B < 1e-7, C < 1e-6, M < 1e-5, X ≥ 1e-5 W/m²
    ///
    /// Our simulation energy is in arbitrary units, so we map:
    ///   energy < 0.5 → B,  < 2.0 → C,  < 8.0 → M,  ≥ 8.0 → X
    pub fn flare_class(&self) -> &'static str {
        let e = self.last_eruption_energy;
        if e >= 8.0 {
            "X"
        } else if e >= 2.0 {
            "M"
        } else if e >= 0.5 {
            "C"
        } else {
            "B"
        }
    }

    /// Flare class with numeric subclass (e.g. "M3.2").
    pub fn flare_class_full(&self) -> String {
        let e = self.last_eruption_energy;
        let (letter, base) = if e >= 8.0 {
            ("X", 8.0)
        } else if e >= 2.0 {
            ("M", 2.0)
        } else if e >= 0.5 {
            ("C", 0.5)
        } else {
            ("B", 0.1)
        };
        let subclass = ((e / base) * 1.0).clamp(1.0, 9.9);
        format!("{}{:.1}", letter, subclass)
    }
}

// ── Bevy resource ────────────────────────────────────────────────────────────

/// Collection of all active flux ropes in the simulation.
#[derive(Resource)]
pub struct FluxRopeSet {
    pub ropes: Vec<FluxRope>,
    timer: f32,
}

impl Default for FluxRopeSet {
    fn default() -> Self {
        // Initialise one flux rope per active region (matching magnetic.rs bipoles).
        let ropes = vec![
            // AR1 — northern hemisphere, ~25°N
            FluxRope::new(0, 25_f32.to_radians(), 60_f32.to_radians(), 1.0),
            // AR2 — southern hemisphere, ~18°S
            FluxRope::new(1, -18_f32.to_radians(), 200_f32.to_radians(), -1.0),
        ];
        Self { ropes, timer: 0.0 }
    }
}

// ── Bevy systems ─────────────────────────────────────────────────────────────

/// Advance flux rope physics.  Runs at a fixed sub-step cadence.
pub fn update_flux_ropes(time: Res<Time>, mut set: ResMut<FluxRopeSet>) {
    set.timer += time.delta_secs();
    while set.timer >= PHYSICS_DT {
        set.timer -= PHYSICS_DT;
        for rope in &mut set.ropes {
            rope.step(PHYSICS_DT);
        }
    }
}

/// Render flux ropes as thick, twisted gizmo tubes.
///
/// Each rope is visualised as a set of helical field lines wound around the
/// rope axis.  The colour encodes the phase:
///   - Emerging: cyan–blue (cool, building energy)
///   - Erupting: orange–red–white (hot, reconnecting)
///   - Relaxing: dim grey (post-eruption)
pub fn draw_flux_ropes(mut gizmos: Gizmos, set: Res<FluxRopeSet>) {
    for rope in &set.ropes {
        if rope.phase == RopePhase::Relaxing {
            continue; // don't draw during cooldown
        }

        let star_r = crate::STAR_RADIUS;
        let (sin_lat, cos_lat) = rope.latitude.sin_cos();
        let (sin_lon, cos_lon) = rope.longitude.sin_cos();
        let radial = Vec3::new(cos_lat * cos_lon, sin_lat, cos_lat * sin_lon);
        let axis = rope.axis_direction;
        let poloid = radial.cross(axis).normalize_or_zero();

        let half_len = std::f32::consts::PI * rope.major_radius * 0.5;
        let n_segments = 40;
        let n_strands = 4; // helical strands wound around the axis

        for strand in 0..n_strands {
            let phase_offset =
                std::f32::consts::TAU * strand as f32 / n_strands as f32;

            let mut prev_point: Option<Vec3> = None;

            for i in 0..=n_segments {
                let t = i as f32 / n_segments as f32;
                let s = (t * 2.0 - 1.0) * half_len; // position along axis [-half_len, +half_len]

                // Height profile: semicircular arch.
                let height_frac = (1.0 - (s / half_len).powi(2)).max(0.0).sqrt();
                let height = rope.major_radius * height_frac;

                // Point on the rope axis.
                let axis_pt = radial * (star_r + height) + axis * s;

                // Helical offset around the axis.
                let twist_angle =
                    rope.twist * t * rope.chirality + phase_offset;
                let r_offset = rope.minor_radius * 0.7;
                let offset_dir = (poloid * twist_angle.cos()
                    + radial.cross(poloid).normalize_or_zero() * twist_angle.sin())
                    .normalize_or_zero();
                let point = axis_pt + offset_dir * r_offset;

                if let Some(prev) = prev_point {
                    let color = match rope.phase {
                        RopePhase::Emerging => {
                            // Energy level → blue to cyan.
                            let e_frac =
                                (rope.free_energy / 8.0).clamp(0.0, 1.0);
                            Color::srgba(
                                0.1 + 0.4 * e_frac,
                                0.5 + 0.5 * e_frac,
                                1.0,
                                0.6 + 0.3 * height_frac,
                            )
                        }
                        RopePhase::Erupting => {
                            // Hot reconnection glow.
                            let flash =
                                (rope.phase_timer * 4.0).sin().abs();
                            Color::srgba(
                                1.0,
                                0.3 + 0.5 * flash,
                                0.05 + 0.2 * flash,
                                0.9,
                            )
                        }
                        RopePhase::Relaxing => {
                            Color::srgba(0.3, 0.3, 0.3, 0.2)
                        }
                    };
                    gizmos.line(prev, point, color);
                }
                prev_point = Some(point);
            }
        }
    }
}
