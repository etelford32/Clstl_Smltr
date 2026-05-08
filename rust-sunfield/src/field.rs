//! PFSS-lite magnetic field model.
//!
//! Superposition of buried magnetic dipoles (one per active region, plus an
//! extra dipole for complexity ≥ 2 to capture δ-spot mixed polarity) and
//! monopole-like sources for coronal holes (open flux). Net monopole charge
//! is removed so the global flux balances — a real PFSS requirement and
//! cheap to enforce here.
//!
//! Field is evaluated in closed form at any point above the photosphere;
//! no Laplace solver. Good enough for visuals and very fast.

use crate::vec3::V3;

/// One buried dipole. Position is below the photosphere (r < 1).
#[derive(Clone, Copy, Debug)]
pub struct Dipole {
    pub pos: V3,      // [R☉]
    pub moment: V3,   // arbitrary units; sets relative weighting
}

/// Open-flux monopole-like source (coronal hole proxy).
#[derive(Clone, Copy, Debug)]
pub struct Monopole {
    pub pos: V3,
    pub charge: f32,  // signed
}

/// Whole field as a flat list of contributions.
pub struct Field {
    pub dipoles: Vec<Dipole>,
    pub monopoles: Vec<Monopole>,
}

impl Field {
    /// Magnetic field B(r) from the superposition.
    /// Dipole field: B = (3 (m·r̂) r̂ − m) / r³, with r the displacement
    /// from the dipole position. Constants dropped — only direction +
    /// relative magnitude matter for tracing.
    pub fn b_at(&self, p: V3) -> V3 {
        let mut bx = 0.0f32;
        let mut by = 0.0f32;
        let mut bz = 0.0f32;

        for d in &self.dipoles {
            let r = V3::sub(p, d.pos);
            let r2 = V3::dot(r, r);
            if r2 < 1e-8 { continue; }
            let r_len = r2.sqrt();
            let inv_r3 = 1.0 / (r2 * r_len);
            let m_dot_r = V3::dot(d.moment, r) / r_len;
            // 3 (m·r̂) r̂ − m, scaled by 1/r³
            let cx = (3.0 * m_dot_r * r.x / r_len - d.moment.x) * inv_r3;
            let cy = (3.0 * m_dot_r * r.y / r_len - d.moment.y) * inv_r3;
            let cz = (3.0 * m_dot_r * r.z / r_len - d.moment.z) * inv_r3;
            bx += cx; by += cy; bz += cz;
        }

        for m in &self.monopoles {
            let r = V3::sub(p, m.pos);
            let r2 = V3::dot(r, r);
            if r2 < 1e-8 { continue; }
            let r_len = r2.sqrt();
            let s = m.charge / (r2 * r_len); // q r̂ / r² as q r / r³
            bx += s * r.x;
            by += s * r.y;
            bz += s * r.z;
        }

        V3::new(bx, by, bz)
    }

    /// Radial component of B at a unit-sphere point (sign drives PIL).
    pub fn br_at(&self, p_unit: V3) -> f32 {
        let b = self.b_at(p_unit);
        V3::dot(b, p_unit)
    }
}

// ───────────────────────────────────────────────────────────────────
// Builders
// ───────────────────────────────────────────────────────────────────

/// Active region as it arrives from JS.
#[derive(Clone, Copy, Debug)]
pub struct Ar {
    pub lat_rad: f32,
    pub lon_rad: f32,
    pub area: f32,         // normalized 0..1, or raw — used as relative weight
    pub polarity: f32,     // +1 leading-positive / −1 leading-negative
    pub tilt_rad: f32,     // Joy's-law tilt (signed by hemisphere)
    pub complexity: u8,    // 0=α, 1=β, 2=β-γ, 3=β-γ-δ
}

#[derive(Clone, Copy, Debug)]
pub struct Hole {
    pub lat_rad: f32,
    pub lon_rad: f32,
    pub area: f32,
    pub sign: f32,         // +1 positive open / −1 negative open
}

/// Build a Field from active regions + holes. Implements:
///   • 1 dipole per AR (β-class default)
///   • +1 extra mixed-polarity dipole for complexity ≥ 2 (δ-spot proxy)
///   • Joy's-law tilt of the dipole moment in the local tangent plane
///   • Monopole sources at coronal holes, with global-flux balancing
pub fn build_field(ars: &[Ar], holes: &[Hole]) -> Field {
    const BURIAL_DEPTH: f32 = 0.05;       // dipole sits at r = 1 - depth
    const DELTA_OFFSET_RAD: f32 = 0.025;  // angular offset for δ-spot dipole
    const MOMENT_SCALE: f32 = 1.0;

    let mut dipoles: Vec<Dipole> = Vec::with_capacity(ars.len() * 2);

    for ar in ars {
        let r0 = 1.0 - BURIAL_DEPTH;

        // Local frame at the AR centre (y-up convention).
        let er = V3::from_lat_lon(ar.lat_rad, ar.lon_rad, 1.0);
        // ê_lat (north) and ê_lon (east) on a unit sphere — derivatives of er.
        let e_lat = V3::new(
            -ar.lat_rad.sin() * ar.lon_rad.sin(),
             ar.lat_rad.cos(),
            -ar.lat_rad.sin() * ar.lon_rad.cos(),
        );
        let e_lon = V3::new( ar.lon_rad.cos(), 0.0, -ar.lon_rad.sin());

        // Dipole moment direction: tangent plane, tilted from east-west by
        // Joy's law. Sign of moment = polarity (leading magnetic sense).
        let cos_t = ar.tilt_rad.cos();
        let sin_t = ar.tilt_rad.sin();
        let m_dir = V3::add(V3::mul(e_lon, cos_t), V3::mul(e_lat, sin_t));
        let m_mag = MOMENT_SCALE * ar.area.max(0.01) * ar.polarity.signum();

        let pos = V3::mul(er, r0);
        dipoles.push(Dipole {
            pos,
            moment: V3::mul(m_dir, m_mag),
        });

        // δ-spot: extra dipole offset along the moment axis with reversed
        // sign — produces the close-quarters mixed polarity that drives
        // big flares.
        if ar.complexity >= 2 {
            let off = V3::mul(m_dir, DELTA_OFFSET_RAD);
            let pos2_dir = V3::add(er, off).norm();
            let pos2 = V3::mul(pos2_dir, r0);
            dipoles.push(Dipole {
                pos: pos2,
                moment: V3::mul(m_dir, -0.6 * m_mag),
            });
        }
    }

    // Holes → monopoles, then balance global flux to zero.
    let mut monopoles: Vec<Monopole> = holes.iter().map(|h| {
        let p = V3::from_lat_lon(h.lat_rad, h.lon_rad, 1.0 - BURIAL_DEPTH);
        Monopole { pos: p, charge: h.sign * h.area.max(0.01) }
    }).collect();

    if !monopoles.is_empty() {
        let net: f32 = monopoles.iter().map(|m| m.charge).sum();
        let n = monopoles.len() as f32;
        let bias = net / n;
        for m in &mut monopoles { m.charge -= bias; }
    }

    Field { dipoles, monopoles }
}
