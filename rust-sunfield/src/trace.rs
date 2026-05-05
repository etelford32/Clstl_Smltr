//! RK4 streamline integrator for B-field lines.
//!
//! Traces a seed point in both directions until termination, then resamples
//! the closed/open arc to a fixed number of evenly-arclength samples so the
//! output atlas has a uniform layout.

use crate::field::Field;
use crate::vec3::V3;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Topology {
    Closed = 0,
    OpenPositive = 1, // line escapes to the source surface, footpoint Br > 0
    OpenNegative = 2, //   "                                          Br < 0
    Stray = 3,        // ran out of steps without terminating
}

pub struct TracedLine {
    pub samples: Vec<V3>,    // length == samples_per_line
    pub tangents: Vec<V3>,   // unit B̂ at each sample
    pub topology: Topology,
    pub apex_height: f32,    // max(r) − 1 along the line
    pub total_length: f32,
}

pub struct TraceParams {
    pub source_surface: f32,  // R☉ — UI knob, default 2.5
    pub step: f32,            // arclength per RK4 step, R☉
    pub max_steps: u32,
    pub samples_per_line: u32,
}

/// Trace one field line from `seed` in both directions.
/// Returns None if the seed produces a degenerate (essentially-zero) line.
pub fn trace_line(field: &Field, seed: V3, p: &TraceParams) -> Option<TracedLine> {
    let fwd = trace_dir(field, seed, p, 1.0);
    let bwd = trace_dir(field, seed, p, -1.0);

    // Stitch: bwd reversed, then fwd (skip duplicated seed).
    let mut pts: Vec<V3> = bwd.points.iter().rev().copied().collect();
    if pts.is_empty() { pts.push(seed); }
    pts.extend(fwd.points.iter().skip(1).copied());

    if pts.len() < 4 { return None; }

    // Topology: if either end terminated above the source surface → open.
    // Sign of "open" comes from the photospheric footpoint Br.
    let topology = match (bwd.term, fwd.term) {
        (Term::Photosphere, Term::Photosphere) => Topology::Closed,
        (Term::SourceSurface, Term::Photosphere)
        | (Term::Photosphere, Term::SourceSurface) => {
            // pick the photospheric end and read Br there
            let foot = if bwd.term == Term::Photosphere { *pts.first().unwrap() }
                       else                              { *pts.last().unwrap()  };
            if field.br_at(foot.norm()) >= 0.0 { Topology::OpenPositive }
            else                                { Topology::OpenNegative }
        }
        (Term::SourceSurface, Term::SourceSurface) => Topology::OpenPositive, // rare
        _ => Topology::Stray,
    };

    // Resample to fixed samples_per_line by arclength.
    let n = p.samples_per_line as usize;
    let (samples, total_len) = resample_uniform(&pts, n);

    // Tangents from finite differences of resampled curve.
    let mut tangents: Vec<V3> = Vec::with_capacity(n);
    for i in 0..n {
        let a = samples[i.saturating_sub(1)];
        let b = samples[(i + 1).min(n - 1)];
        tangents.push(V3::sub(b, a).norm());
    }

    let apex = samples.iter().map(|s| s.len()).fold(0.0f32, f32::max) - 1.0;

    Some(TracedLine {
        samples,
        tangents,
        topology,
        apex_height: apex,
        total_length: total_len,
    })
}

// ───────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Term { Photosphere, SourceSurface, MaxSteps }

struct DirResult {
    points: Vec<V3>,
    term: Term,
}

fn trace_dir(field: &Field, seed: V3, p: &TraceParams, sign: f32) -> DirResult {
    let mut pts = Vec::with_capacity(p.max_steps as usize / 2);
    pts.push(seed);
    let mut cur = seed;

    for _ in 0..p.max_steps {
        let nxt = match rk4_step(field, cur, sign * p.step) {
            Some(v) => v,
            None => break, // field too weak — stop
        };
        let r = nxt.len();

        if r <= 1.0 {
            // Bisect back onto the photosphere for a clean footpoint.
            let foot = bisect_to_radius(field, cur, nxt, 1.0, sign * p.step);
            pts.push(foot);
            return DirResult { points: pts, term: Term::Photosphere };
        }
        if r >= p.source_surface {
            let top = bisect_to_radius(field, cur, nxt, p.source_surface, sign * p.step);
            pts.push(top);
            return DirResult { points: pts, term: Term::SourceSurface };
        }

        pts.push(nxt);
        cur = nxt;
    }
    DirResult { points: pts, term: Term::MaxSteps }
}

/// Classical RK4 with the unit B vector as the velocity.
/// `h` is signed arclength (negative = trace upstream).
fn rk4_step(field: &Field, p: V3, h: f32) -> Option<V3> {
    let k1 = unit_b(field, p)?;
    let k2 = unit_b(field, V3::add(p, V3::mul(k1, h * 0.5)))?;
    let k3 = unit_b(field, V3::add(p, V3::mul(k2, h * 0.5)))?;
    let k4 = unit_b(field, V3::add(p, V3::mul(k3, h)))?;
    let s = h / 6.0;
    Some(V3::new(
        p.x + s * (k1.x + 2.0 * k2.x + 2.0 * k3.x + k4.x),
        p.y + s * (k1.y + 2.0 * k2.y + 2.0 * k3.y + k4.y),
        p.z + s * (k1.z + 2.0 * k2.z + 2.0 * k3.z + k4.z),
    ))
}

#[inline]
fn unit_b(field: &Field, p: V3) -> Option<V3> {
    let b = field.b_at(p);
    let l = b.len();
    if l < 1e-12 { None } else { Some(V3::mul(b, 1.0 / l)) }
}

/// Bracketed bisection: walk back along the segment a→b until r crosses
/// `target`, refining 6× (≈ step/64 accuracy).
fn bisect_to_radius(field: &Field, a: V3, b: V3, target: f32, _h: f32) -> V3 {
    let mut lo = a;
    let mut hi = b;
    for _ in 0..6 {
        let mid = V3::mul(V3::add(lo, hi), 0.5);
        let rm = mid.len();
        // pick the half-segment that still straddles `target`
        let ra = lo.len();
        let cross_lo = (ra - target) * (rm - target) <= 0.0;
        if cross_lo { hi = mid; } else { lo = mid; }
        let _ = field; // (kept for future field-aware refinement)
    }
    V3::mul(V3::add(lo, hi), 0.5)
}

/// Resample a polyline to `n` uniformly-spaced (in arclength) points.
fn resample_uniform(pts: &[V3], n: usize) -> (Vec<V3>, f32) {
    let m = pts.len();
    let mut cum = vec![0.0f32; m];
    for i in 1..m {
        cum[i] = cum[i - 1] + V3::sub(pts[i], pts[i - 1]).len();
    }
    let total = cum[m - 1].max(1e-6);
    let mut out = Vec::with_capacity(n);
    let mut j = 0usize;
    let last = m - 2; // last valid segment start index
    for i in 0..n {
        let s = total * (i as f32) / ((n - 1) as f32);
        while j < last && cum[j + 1] < s { j += 1; }
        let seg = (cum[j + 1] - cum[j]).max(1e-9);
        let t = ((s - cum[j]) / seg).clamp(0.0, 1.0);
        let p = V3::add(V3::mul(pts[j], 1.0 - t), V3::mul(pts[j + 1], t));
        out.push(p);
    }
    (out, total)
}
