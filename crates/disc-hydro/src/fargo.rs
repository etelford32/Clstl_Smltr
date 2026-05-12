//! FARGO (Fast Advection in Rotating Gaseous Objects) azimuthal shift step.
//!
//! For each radial ring, we shift every cell by `vphi_bar(r) · dt` in the
//! azimuthal direction. The shift is split into:
//!
//!   * an *integer* number of cells `n_int` — done by a pointer-style index
//!     rotation, with no CFL restriction whatsoever; and
//!   * a *fractional* remainder ε ∈ [0,1) — handled by a donor-cell upwind
//!     pass over a sub-cell distance, which is unconditionally stable as
//!     long as |ε| < 1.
//!
//! Reference: Masset (2000) "FARGO: A fast eulerian transport algorithm for
//! differentially rotating disks", A&AS 141, 165.

use crate::grid::Grid;

/// Compute the φ-averaged azimuthal velocity at each radius.
pub fn compute_vphi_bar(g: &Grid, vphi: &[f64], out: &mut [f64]) {
    let inv_nphi = 1.0 / (g.nphi as f64);
    for i in 0..g.nr {
        let mut s = 0.0;
        for j in 0..g.nphi {
            s += vphi[g.idx(i, j)];
        }
        out[i] = s * inv_nphi;
    }
}

/// Shift each ring by `vphi_bar[i] · dt / (r[i] · dφ)` cells. Applies the
/// integer rotation in place, then a fractional donor-cell sub-shift.
pub fn shift(g: &Grid,
             sigma: &mut [f64], vr: &mut [f64], vphi: &mut [f64],
             vphi_bar: &[f64], dt: f64)
{
    let mut tmp = vec![0.0_f64; g.nphi];

    for i in 0..g.nr {
        let shift_cells = vphi_bar[i] * dt / (g.r[i] * g.dphi);
        // Floor towards -∞ so the fractional part is always in [0,1).
        let n_int   = shift_cells.floor() as i64;
        let frac    = shift_cells - (n_int as f64);
        let n_mod   = (n_int.rem_euclid(g.nphi as i64)) as usize;

        rotate_ring(g, sigma,  i, n_mod, frac, &mut tmp);
        rotate_ring(g, vr,     i, n_mod, frac, &mut tmp);
        rotate_ring(g, vphi,   i, n_mod, frac, &mut tmp);
    }
}

/// Rotate the ring `i` of a field by `n_int` cells in the +φ direction plus
/// a fractional donor-cell sweep by ε ∈ [0,1). The integer rotation is
/// exact (just an index relabel) and contributes no diffusion; the
/// fractional part is the only source of numerical viscosity.
fn rotate_ring(g: &Grid, field: &mut [f64],
               i: usize, n_int: usize, frac: f64,
               buf: &mut Vec<f64>)
{
    let n = g.nphi;
    // 1) Integer rotation: tmp[j] = field[i, (j - n_int) mod n]
    for j in 0..n {
        let src = (j + n - (n_int % n)) % n;
        buf[j] = field[g.idx(i, src)];
    }
    // 2) Fractional donor-cell sub-shift by ε ∈ [0,1):
    //    new[j] = (1-ε)·buf[j]  +  ε·buf[(j-1) mod n]
    // The sign convention matches a flow in the +φ direction; if vphi_bar
    // were negative, `frac` would still land in [0,1) thanks to floor().
    let one_minus = 1.0 - frac;
    for j in 0..n {
        let jm = (j + n - 1) % n;
        field[g.idx(i, j)] = one_minus * buf[j] + frac * buf[jm];
    }
}
