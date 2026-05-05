//! Seed-point generation for field-line tracing.
//!
//! Three seed populations:
//!   • Per-AR cluster: a small ring around each AR centre at altitude
//!     ~0.02 R☉, biased toward the dipole axis. Drives the loop arcade.
//!   • Global sparse grid: coarse Fibonacci sphere on the photosphere.
//!     Drives quiet-sun coronal holes / open-field-line visualization.
//!   • PIL seeds: walked along the Br = 0 contour near each AR — these
//!     become the prominence-ribbon anchors in Phase 2.

use crate::field::{Ar, Field};
use crate::vec3::V3;

const TAU: f32 = std::f32::consts::TAU;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SeedKind {
    ArArcade = 0,
    GlobalQuiet = 1,
    Pil = 2,
}

#[derive(Clone, Copy, Debug)]
pub struct Seed {
    pub pos: V3,
    pub kind: SeedKind,
    pub ar_index: i32, // −1 if not associated with an AR
}

pub struct SeedBudget {
    pub per_ar: u32,         // arcade seeds per AR
    pub global: u32,         // quiet-sun grid seeds
    pub max_total: u32,
}

pub fn build_seeds(ars: &[Ar], field: &Field, budget: SeedBudget) -> Vec<Seed> {
    let mut out: Vec<Seed> = Vec::with_capacity(budget.max_total as usize);

    // ── Per-AR arcade seeds: ring around AR at low altitude
    for (i, ar) in ars.iter().enumerate() {
        let er = V3::from_lat_lon(ar.lat_rad, ar.lon_rad, 1.0);
        // Local tangent frame at AR centre (y-up convention — matches field.rs).
        let e_lat = V3::new(
            -ar.lat_rad.sin() * ar.lon_rad.sin(),
             ar.lat_rad.cos(),
            -ar.lat_rad.sin() * ar.lon_rad.cos(),
        );
        let e_lon = V3::new( ar.lon_rad.cos(), 0.0, -ar.lon_rad.sin());

        let n = budget.per_ar.max(1);
        let radius_rad = 0.04 + 0.06 * ar.area.clamp(0.0, 1.0); // 0.04..0.10 rad
        for k in 0..n {
            let theta = TAU * (k as f32) / (n as f32);
            let dx = radius_rad * theta.cos();
            let dy = radius_rad * theta.sin();
            // Tangent-plane offset, then renormalize and lift slightly.
            let p_dir = V3::add(er, V3::add(V3::mul(e_lon, dx), V3::mul(e_lat, dy))).norm();
            let altitude = 1.005;
            out.push(Seed { pos: V3::mul(p_dir, altitude), kind: SeedKind::ArArcade, ar_index: i as i32 });
            if out.len() as u32 >= budget.max_total { return out; }
        }
    }

    // ── Global Fibonacci grid for quiet-sun + holes (y-up convention)
    let g = budget.global as i32;
    if g > 0 {
        let phi = std::f32::consts::PI * (3.0 - (5.0f32).sqrt()); // golden angle
        for i in 0..g {
            let y = 1.0 - 2.0 * (i as f32 + 0.5) / g as f32; // (-1, 1) — polar axis
            let r = (1.0 - y * y).max(0.0).sqrt();
            let theta = phi * i as f32;
            let p = V3::new(r * theta.cos(), y, r * theta.sin());
            out.push(Seed { pos: V3::mul(p, 1.005), kind: SeedKind::GlobalQuiet, ar_index: -1 });
            if out.len() as u32 >= budget.max_total { return out; }
        }
    }

    // ── PIL seeds: walk Br = 0 contour around each AR
    for (i, ar) in ars.iter().enumerate() {
        let pil_pts = crate::pil::trace_pil_around_ar(field, ar);
        for p in pil_pts {
            out.push(Seed { pos: V3::mul(p, 1.005), kind: SeedKind::Pil, ar_index: i as i32 });
            if out.len() as u32 >= budget.max_total { return out; }
        }
    }

    out
}
