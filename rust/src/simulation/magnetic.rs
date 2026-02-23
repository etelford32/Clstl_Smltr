//! Solar magnetic field lines — dipole + active regions.
//!
//! # Physical model
//!
//! The coronal field is the superposition of:
//!
//! * **Global dipole** — moment aligned with the solar rotation axis (+Y).
//!   Produces the large-scale open/closed topology (polar open lines, mid-
//!   latitude closed arcs).
//!
//! * **Active regions** (AR) — two bipolar sunspot pairs buried just below the
//!   photosphere.  Each pair is modelled as two point poles ±B₀ separated by
//!   a fixed angular distance.  They slowly drift eastward following the
//!   differential-rotation law.
//!
//! # Field-line tracing
//!
//! Lines are integrated with 4th-order Runge–Kutta from seed points on the
//! star surface.  A line is classified **Closed** when it returns to the
//! photosphere and **Open** when it exits the domain.
//!
//! # Performance
//!
//! Retracing is done at most once every [`RETRACE_SECS`] seconds (timer-
//! gated).  At 46 lines × 300 steps × 4 RK4 evaluations ≈ 55 K field
//! evaluations, this takes well under 5 ms even on modest hardware.
//! Rendering uses Bevy gizmos (batched line strips) — one pass per frame.

use bevy::prelude::*;

// ── Tunable constants ─────────────────────────────────────────────────────────

/// RK4 step length along the field line (world units).
const STEP: f32 = 0.07;
/// Maximum integration steps per line.
const MAX_STEPS: usize = 300;
/// Seconds between full retraces.
const RETRACE_SECS: f32 = 5.0;

/// Dipole field strength coefficient.
const DIPOLE_B0: f32 = 1.0;
/// Active-region pole strength.
const AR_B0: f32 = 0.85;

const STAR_R: f32 = crate::STAR_RADIUS;
const DOMAIN_R: f32 = 5.0;

// ── Resource ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineKind {
    Closed,
    Open,
}

/// Stores all traced field-line paths.  Recomputed periodically by
/// [`update_field_lines`] and rendered every frame by [`draw_field_lines`].
#[derive(Resource)]
pub struct FieldLineSet {
    /// Sequence of world-space points for each traced line.
    pub lines: Vec<(LineKind, Vec<Vec3>)>,
    /// Counts up to [`RETRACE_SECS`]; triggers a retrace when reached.
    timer: f32,
}

impl Default for FieldLineSet {
    fn default() -> Self {
        // Start timer at the threshold so the first frame triggers a retrace.
        Self {
            lines: Vec::new(),
            timer: RETRACE_SECS,
        }
    }
}

// ── Bevy systems ──────────────────────────────────────────────────────────────

/// Advances the retrace timer and rebuilds all field lines when it fires.
/// Run this before [`draw_field_lines`].
pub fn update_field_lines(time: Res<Time>, mut set: ResMut<FieldLineSet>) {
    set.timer += time.delta_secs();
    if set.timer >= RETRACE_SECS {
        set.timer = 0.0;
        let poles = active_poles(time.elapsed_secs());
        set.lines = trace_all(&poles);
    }
}

/// Draws every stored field line as a gradient gizmo strip each frame.
pub fn draw_field_lines(mut gizmos: Gizmos, set: Res<FieldLineSet>) {
    for (kind, pts) in &set.lines {
        let n = pts.len();
        if n < 2 {
            continue;
        }
        for (i, pair) in pts.windows(2).enumerate() {
            let t = i as f32 / (n - 1) as f32;
            let color = match kind {
                LineKind::Closed => closed_color(t),
                LineKind::Open => open_color(t),
            };
            gizmos.line(pair[0], pair[1], color);
        }
    }
}

// ── Colour helpers ────────────────────────────────────────────────────────────

/// Gold–orange–red gradient.  t=0/1 are footpoints; t=0.5 is the hot apex.
fn closed_color(t: f32) -> Color {
    // Apex prominence: 0 at footpoints, 1 at midpoint.
    let apex = 1.0 - (t * 2.0 - 1.0).powi(2);

    // Footpoints: bright gold (1.0, 0.85, 0.25)
    // Apex:       orange-red  (1.0, 0.25, 0.04)
    let g = 0.85 - 0.60 * apex;
    let b = 0.25 - 0.21 * apex;
    // Slightly more opaque near the star where the field is strongest.
    let a = 0.55 + 0.30 * (1.0 - apex);
    Color::srgba(1.0, g.max(0.0), b.max(0.0), a)
}

/// Blue-white near the star, fading to dim blue at the domain boundary.
fn open_color(t: f32) -> Color {
    // t=0 near star, t=1 at domain edge.
    let r = 0.50 - 0.30 * t;
    let g = 0.70 - 0.35 * t;
    let a = 0.70 - 0.45 * t;
    Color::srgba(r.max(0.0), g.max(0.0), 1.0, a.max(0.05))
}

// ── Magnetic field mathematics ────────────────────────────────────────────────

/// Global dipole field.  Moment **m** = (0, 1, 0) (rotation axis = +Y).
///
/// B_dip(r) = B₀ / r⁵ × [3(m·r̂)r − r²m]
///          = B₀ / r⁵ × [3·r.y·pos − r²·Ŷ]
fn dipole(pos: Vec3) -> Vec3 {
    let r2 = pos.length_squared();
    let r5 = r2 * r2 * r2.sqrt();
    if r5 < 1e-9 {
        return Vec3::ZERO;
    }
    (3.0 * pos.y * pos - r2 * Vec3::Y) * (DIPOLE_B0 / r5)
}

/// Superposition of monopole contributions from active-region poles.
///
/// Each pole at position **p** with polarity *s* contributes:
/// B_pole = s × AR_B0 / |r−p|³ × (r−p)
fn ar_field(pos: Vec3, poles: &[(Vec3, f32)]) -> Vec3 {
    let mut b = Vec3::ZERO;
    for &(p, sign) in poles {
        let d = pos - p;
        let r2 = d.length_squared();
        let r3 = r2 * r2.sqrt();
        if r3 < 1e-9 {
            continue;
        }
        b += d * (sign * AR_B0 / r3);
    }
    b
}

/// Total field: dipole + all active-region contributions.
fn b_total(pos: Vec3, poles: &[(Vec3, f32)]) -> Vec3 {
    dipole(pos) + ar_field(pos, poles)
}

/// Returns the normalised field direction at `pos`, flipped if necessary to
/// stay consistent with `hint` (prevents 180° direction reversals at nulls).
fn b_dir(pos: Vec3, poles: &[(Vec3, f32)], hint: Vec3) -> Vec3 {
    let b = b_total(pos, poles);
    if b.length_squared() < 1e-10 {
        return hint;
    }
    let n = b.normalize();
    if n.dot(hint) >= 0.0 { n } else { -n }
}

// ── Active-region definitions ─────────────────────────────────────────────────

/// Returns `(pole_position_world, polarity)` for all active-region poles at
/// time `sim_t`.  Poles drift eastward following the Carrington rotation law.
fn active_poles(sim_t: f32) -> Vec<(Vec3, f32)> {
    // AR1 — northern hemisphere, ~25°N latitude
    let ar1_lon = 60_f32.to_radians() + sim_t * 0.31;
    let mut poles = bipole(25_f32.to_radians(), ar1_lon, 12_f32.to_radians());

    // AR2 — southern hemisphere, ~18°S latitude
    let ar2_lon = 200_f32.to_radians() + sim_t * 0.315;
    poles.extend(bipole(-18_f32.to_radians(), ar2_lon, 10_f32.to_radians()));

    poles
}

/// Builds a bipolar pair centred at (`lat`, `lon`) with east–west half-
/// separation `half_sep` (radians).  Poles are buried at 88 % of star radius
/// to avoid near-surface singularities.
///
/// Returns `[(+pole_pos, +1.0), (−pole_pos, −1.0)]`.
fn bipole(lat: f32, lon: f32, half_sep: f32) -> Vec<(Vec3, f32)> {
    let p_pos = surface_point(lat, lon + half_sep) * 0.88;
    let n_pos = surface_point(lat, lon - half_sep) * 0.88;
    vec![(p_pos, 1.0), (n_pos, -1.0)]
}

/// World-space position on the star surface at heliographic (`lat`, `lon`).
/// Y-up convention: lat = 0 at equator, +π/2 at north pole.
fn surface_point(lat: f32, lon: f32) -> Vec3 {
    Vec3::new(
        lat.cos() * lon.cos(),
        lat.sin(),
        lat.cos() * lon.sin(),
    ) * STAR_R
}

// ── Field-line tracing ────────────────────────────────────────────────────────

/// Builds the complete set of seed points and traces all field lines.
fn trace_all(poles: &[(Vec3, f32)]) -> Vec<(LineKind, Vec<Vec3>)> {
    let mut lines: Vec<(LineKind, Vec<Vec3>)> = Vec::new();

    // ── 1. Large closed arcs — mid-latitude dipole loops ─────────────────────
    // Polar angle (from +Y) determines apex height: r_apex = STAR_R / sin²(θ).
    //   θ=50° → r_apex≈3.4,  θ=58° → r_apex≈2.8,  θ=66° → r_apex≈2.4
    for &theta_deg in &[50.0_f32, 58.0, 66.0] {
        let theta = theta_deg.to_radians();
        for lon_deg in [0.0_f32, 60.0, 120.0, 180.0, 240.0, 300.0] {
            let lon = lon_deg.to_radians();
            let seed = Vec3::new(
                theta.sin() * lon.cos(),
                theta.cos(),
                theta.sin() * lon.sin(),
            ) * STAR_R * 1.02;
            lines.push(trace(seed, poles));
        }
    }

    // ── 2. Polar open field lines ─────────────────────────────────────────────
    // At θ ≤ 30° the apex height exceeds DOMAIN_R, so lines escape to infinity.
    for &theta_deg in &[12.0_f32, 24.0] {
        for lon_deg in [0.0_f32, 90.0, 180.0, 270.0] {
            let lon = lon_deg.to_radians();
            for &hemi in &[1.0_f32, -1.0] {
                // Mirror north/south by flipping the Y component.
                let theta = theta_deg.to_radians();
                let seed = Vec3::new(
                    theta.sin() * lon.cos(),
                    theta.cos() * hemi,
                    theta.sin() * lon.sin(),
                ) * STAR_R * 1.02;
                lines.push(trace(seed, poles));
            }
        }
    }

    // ── 3. Active-region compact loops ────────────────────────────────────────
    // Seed just above each positive pole and fan out with small angular offsets
    // so we capture the full arcade of loops connecting the bipole.
    for &(pole_pos, _polarity) in poles.iter().filter(|&&(_, p)| p > 0.0) {
        let centre = pole_pos.normalize();
        // Build two orthogonal tangent vectors in the tangent plane at `centre`.
        let tangent_a = if centre.x.abs() < 0.9 {
            centre.cross(Vec3::X).normalize()
        } else {
            centre.cross(Vec3::Z).normalize()
        };
        let tangent_b = centre.cross(tangent_a);

        for &(da, db) in &[
            (0.0_f32, 0.0),
            (0.12, 0.0),
            (-0.12, 0.0),
            (0.0, 0.10),
            (0.0, -0.10),
            (0.18, 0.0),
            (-0.18, 0.0),
        ] {
            let seed_dir = (centre + tangent_a * da + tangent_b * db).normalize_or_zero();
            if seed_dir.length_squared() < 0.5 {
                continue;
            }
            lines.push(trace(seed_dir * STAR_R * 1.02, poles));
        }
    }

    lines
}

/// Traces one field line from `start` using 4th-order Runge–Kutta.
///
/// Returns the kind (Closed / Open) and the sequence of world-space points.
fn trace(start: Vec3, poles: &[(Vec3, f32)]) -> (LineKind, Vec<Vec3>) {
    let mut pos = start;
    let mut pts = vec![pos];

    let b0 = b_total(pos, poles);
    if b0.length_squared() < 1e-10 {
        return (LineKind::Open, pts);
    }
    let mut dir = b0.normalize();

    for _ in 0..MAX_STEPS {
        // Standard RK4 — each kN is a normalised unit direction.
        let k1 = b_dir(pos, poles, dir);
        let k2 = b_dir(pos + k1 * (STEP * 0.5), poles, k1);
        let k3 = b_dir(pos + k2 * (STEP * 0.5), poles, k2);
        let k4 = b_dir(pos + k3 * STEP, poles, k3);

        // Weighted average direction (RK4 coefficients), then normalise.
        let raw = k1 + k2 * 2.0 + k3 * 2.0 + k4;
        dir = raw.normalize_or_zero();
        if dir.length_squared() < 0.5 {
            break;
        }

        pos += dir * STEP;
        let r = pos.length();

        // Returned to star surface (min travel guard prevents false-positive
        // on the first few steps when we're still near the seed).
        if r <= STAR_R * 1.01 && pts.len() > 25 {
            pts.push(pos);
            return (LineKind::Closed, pts);
        }

        // Exited the domain.
        if r >= DOMAIN_R * 0.97 {
            pts.push(pos.normalize() * DOMAIN_R);
            return (LineKind::Open, pts);
        }

        pts.push(pos);
    }

    (LineKind::Open, pts)
}
