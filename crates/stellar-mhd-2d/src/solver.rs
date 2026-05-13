//! Finite-volume MHD solver.
//!
//! Phase 1 (this file): pure-hydro HLL Riemann solver, piecewise-constant
//! reconstruction (Godunov), forward-Euler time stepping. Validated by
//! `tests/sod.rs` against the analytic Sod shock-tube solution.
//!
//! Later phases replace HLL with HLLD, upgrade reconstruction to PLM, and
//! switch the integrator to SSP-RK2. The grid + state + boundary code below
//! is solver-agnostic so those swaps don't touch the outer loop.

use crate::grid::{Grid, NG};
use crate::state::{
    cons_to_prim, fast_speed, var, Prim, State, GAMMA, N_VARS, P_FLOOR, RHO_FLOOR,
};
use crate::Sim;

/// Axis selector. We sweep dimensions separately (Strang-style) so the same
/// 1D Riemann solver works for both x- and y-faces.
#[derive(Clone, Copy)]
pub enum Axis {
    X,
    Y,
}

impl Axis {
    #[inline]
    fn idx(&self) -> usize {
        match self {
            Axis::X => 0,
            Axis::Y => 1,
        }
    }
}

/// Analytic flux of the conservative MHD system along axis `axis`, evaluated
/// from primitive variables. We currently zero the magnetic contributions in
/// Phase 1 (B == 0 everywhere) but write the full form so Phase 2 only has
/// to drop in the HLLD wave structure.
fn flux(p: Prim, axis: Axis) -> [f64; N_VARS] {
    let (vn, vt1, vt2, bn, bt1, bt2) = match axis {
        Axis::X => (p.vx, p.vy, p.vz, p.bx, p.by, p.bz),
        Axis::Y => (p.vy, p.vx, p.vz, p.by, p.bx, p.bz),
    };
    let bsq = p.bx * p.bx + p.by * p.by + p.bz * p.bz;
    let ptot = p.p + 0.5 * bsq;
    let vdotb = p.vx * p.bx + p.vy * p.by + p.vz * p.bz;
    let e = p.p / (GAMMA - 1.0)
        + 0.5 * p.rho * (p.vx * p.vx + p.vy * p.vy + p.vz * p.vz)
        + 0.5 * bsq;

    let mut f = [0.0; N_VARS];
    f[var::RHO] = p.rho * vn;
    let (fmn, fmt1, fmt2) = (
        p.rho * vn * vn + ptot - bn * bn,
        p.rho * vn * vt1 - bn * bt1,
        p.rho * vn * vt2 - bn * bt2,
    );
    match axis {
        Axis::X => {
            f[var::MX] = fmn;
            f[var::MY] = fmt1;
            f[var::MZ] = fmt2;
            f[var::BX] = 0.0;
            f[var::BY] = vn * bt1 - vt1 * bn;
            f[var::BZ] = vn * bt2 - vt2 * bn;
        }
        Axis::Y => {
            f[var::MY] = fmn;
            f[var::MX] = fmt1;
            f[var::MZ] = fmt2;
            f[var::BY] = 0.0;
            f[var::BX] = vn * bt1 - vt1 * bn;
            f[var::BZ] = vn * bt2 - vt2 * bn;
        }
    }
    f[var::E] = (e + ptot) * vn - bn * vdotb;
    f[var::PSI] = 0.0;
    f
}

/// HLL numerical flux at a face between left state `pl` and right state `pr`.
/// Robust two-wave solver: diffusive on contact discontinuities but stable
/// everywhere, which is fine for Phase-1 hydro validation.
fn hll_flux(pl: Prim, pr: Prim, axis: Axis, ul: [f64; N_VARS], ur: [f64; N_VARS])
    -> [f64; N_VARS]
{
    let cl = fast_speed(pl, axis.idx());
    let cr = fast_speed(pr, axis.idx());
    let (vnl, vnr) = match axis {
        Axis::X => (pl.vx, pr.vx),
        Axis::Y => (pl.vy, pr.vy),
    };
    let sl = (vnl - cl).min(vnr - cr);
    let sr = (vnl + cl).max(vnr + cr);
    let fl = flux(pl, axis);
    let fr = flux(pr, axis);

    let mut f = [0.0; N_VARS];
    if sl >= 0.0 {
        f.copy_from_slice(&fl);
    } else if sr <= 0.0 {
        f.copy_from_slice(&fr);
    } else {
        let inv = 1.0 / (sr - sl);
        for k in 0..N_VARS {
            f[k] = (sr * fl[k] - sl * fr[k] + sl * sr * (ur[k] - ul[k])) * inv;
        }
    }
    f
}

/// Read 9 conserved values at padded index `idx`.
#[inline]
fn read_u(s: &State, idx: usize) -> [f64; N_VARS] {
    let mut u = [0.0; N_VARS];
    for k in 0..N_VARS {
        u[k] = s.u[k][idx];
    }
    u
}

/// Outflow (zero-gradient) boundary on all four sides. Phase 4 will replace
/// the bottom with a line-tied photospheric BC and the top with a sampling
/// hook into the wind particle system, but for shock-tube validation
/// zero-gradient is the textbook choice.
fn apply_bcs(grid: &Grid, s: &mut State) {
    let sx = grid.stride_x();
    let ny_p = grid.ny + 2 * NG;
    let nx_p = grid.nx + 2 * NG;
    // Left & right ghosts: copy first/last real column.
    for j in 0..ny_p {
        for g in 0..NG {
            let src_l = j * sx + NG;
            let dst_l = j * sx + g;
            let src_r = j * sx + (NG + grid.nx - 1);
            let dst_r = j * sx + (NG + grid.nx + g);
            for k in 0..N_VARS {
                s.u[k][dst_l] = s.u[k][src_l];
                s.u[k][dst_r] = s.u[k][src_r];
            }
        }
    }
    // Bottom & top ghosts: copy first/last real row (full padded width).
    for g in 0..NG {
        for i in 0..nx_p {
            let src_b = NG * sx + i;
            let dst_b = g * sx + i;
            let src_t = (NG + grid.ny - 1) * sx + i;
            let dst_t = (NG + grid.ny + g) * sx + i;
            for k in 0..N_VARS {
                s.u[k][dst_b] = s.u[k][src_b];
                s.u[k][dst_t] = s.u[k][src_t];
            }
        }
    }
}

/// CFL-limited timestep. Scans all real cells for the maximum |v_n| + c_fast
/// in each axis.
pub fn compute_dt(sim: &Sim) -> f64 {
    let g = &sim.grid;
    let mut max_x = 0.0_f64;
    let mut max_y = 0.0_f64;
    for j in 0..g.ny {
        for i in 0..g.nx {
            let idx = g.idx(i, j);
            let u = read_u(&sim.state, idx);
            let p = cons_to_prim(u);
            max_x = max_x.max(p.vx.abs() + fast_speed(p, 0));
            max_y = max_y.max(p.vy.abs() + fast_speed(p, 1));
        }
    }
    let dt_x = g.dx / max_x.max(1.0e-30);
    let dt_y = g.dy / max_y.max(1.0e-30);
    sim.cfl * dt_x.min(dt_y)
}

/// One forward-Euler MHD step using HLL fluxes, dimensionally split.
/// Phase 2 will upgrade this to SSP-RK2 with PLM reconstruction.
pub fn step(sim: &mut Sim, dt: f64) {
    apply_bcs(&sim.grid, &mut sim.state);
    sweep(sim, dt, Axis::X);
    apply_bcs(&sim.grid, &mut sim.state);
    sweep(sim, dt, Axis::Y);
    sim.t += dt;
}

fn sweep(sim: &mut Sim, dt: f64, axis: Axis) {
    let g = sim.grid;
    let (stride, dl) = match axis {
        Axis::X => (1usize, g.dx),
        Axis::Y => (g.stride_x(), g.dy),
    };
    let lambda = dt / dl;

    // We walk every real cell and compute the right-face flux F_{i+1/2}.
    // The left-face flux is the previous cell's right-face flux, so we keep
    // a one-cell rolling buffer per row/column.
    //
    // To support both axes with the same code we iterate over a flat index
    // `idx` and step by `stride`. The "row" outer dimension is the one we
    // don't sweep; it's `ny` rows for X, `nx` columns for Y.
    let (outer, inner, outer_stride, inner_start) = match axis {
        Axis::X => (g.ny, g.nx, g.stride_x(), NG),
        Axis::Y => (g.nx, g.ny, 1usize, NG),
    };
    let outer_start = NG;

    for o in 0..outer {
        let line_start = (outer_start + o) * outer_stride + inner_start * stride;
        // Compute the leftmost face flux F_{-1/2} once, then advance.
        let mut idx_l = line_start - stride; // first ghost on the low side
        let mut ul = read_u(&sim.state, idx_l);
        let mut pl = cons_to_prim(ul);

        let mut idx_r = line_start;
        let mut ur = read_u(&sim.state, idx_r);
        let mut pr = cons_to_prim(ur);

        // F at the face *between* idx_l (ghost) and idx_r (first real cell).
        let mut f_left = hll_flux(pl, pr, axis, ul, ur);

        for k in 0..inner {
            let idx_c = line_start + k * stride;
            let idx_rp = idx_c + stride;
            let urp = read_u(&sim.state, idx_rp);
            let prp = cons_to_prim(urp);

            // Right-face flux for cell k: between idx_c (left state) and
            // idx_rp (right state). We already have pr/ur as the left state
            // of *this* face from the previous iteration's right state.
            let f_right = hll_flux(pr, prp, axis, ur, urp);

            // Update conserved variables of cell idx_c.
            for v in 0..N_VARS {
                let new_val = sim.state.u[v][idx_c] - lambda * (f_right[v] - f_left[v]);
                sim.scratch.u[v][idx_c] = new_val;
            }
            // Floors: density and pressure can never go non-positive.
            sim.scratch.u[var::RHO][idx_c] = sim.scratch.u[var::RHO][idx_c].max(RHO_FLOOR);
            // We don't have direct pressure access here; cons_to_prim() will
            // re-apply P_FLOOR on the next read. Keep E above the magnetic +
            // kinetic floor so cons_to_prim sees something physical.
            let rho = sim.scratch.u[var::RHO][idx_c];
            let mx = sim.scratch.u[var::MX][idx_c];
            let my = sim.scratch.u[var::MY][idx_c];
            let mz = sim.scratch.u[var::MZ][idx_c];
            let bx = sim.scratch.u[var::BX][idx_c];
            let by = sim.scratch.u[var::BY][idx_c];
            let bz = sim.scratch.u[var::BZ][idx_c];
            let kin = 0.5 * (mx * mx + my * my + mz * mz) / rho;
            let mag = 0.5 * (bx * bx + by * by + bz * bz);
            let e_min = kin + mag + P_FLOOR / (GAMMA - 1.0);
            if sim.scratch.u[var::E][idx_c] < e_min {
                sim.scratch.u[var::E][idx_c] = e_min;
            }

            // Roll the rolling buffer forward.
            f_left = f_right;
            idx_l = idx_c;
            ul = ur;
            pl = pr;
            ur = urp;
            pr = prp;
            idx_r = idx_rp;
            let _ = (idx_l, idx_r, ul, pl); // suppress unused-write warnings
        }
    }

    // Commit scratch -> state for the real-cell region we just touched.
    for j in 0..g.ny {
        for i in 0..g.nx {
            let idx = g.idx(i, j);
            for v in 0..N_VARS {
                sim.state.u[v][idx] = sim.scratch.u[v][idx];
            }
        }
    }
}

#[cfg(test)]
mod tests {
    //! Sod shock-tube test. Initial condition (Sod 1978):
    //!   left  (x < 0.5): rho=1.0, p=1.0, v=0
    //!   right (x > 0.5): rho=0.125, p=0.1, v=0
    //! At t = 0.2 we should see a left-going rarefaction, a right-going
    //! contact, and a right-going shock. The post-shock density plateau is
    //! ~0.265 and the post-shock pressure plateau is ~0.303 (analytic).
    use super::*;
    use crate::state::{prim_to_cons, Prim};
    use crate::{Grid, Sim};

    fn sod_ic(sim: &mut Sim, split: f64) {
        let g = sim.grid;
        for j in 0..g.ny {
            for i in 0..g.nx {
                let idx = g.idx(i, j);
                let x = g.xc(i);
                let p = if x < split {
                    Prim { rho: 1.0, vx: 0.0, vy: 0.0, vz: 0.0, p: 1.0,
                           bx: 0.0, by: 0.0, bz: 0.0, psi: 0.0 }
                } else {
                    Prim { rho: 0.125, vx: 0.0, vy: 0.0, vz: 0.0, p: 0.1,
                           bx: 0.0, by: 0.0, bz: 0.0, psi: 0.0 }
                };
                let u = prim_to_cons(p);
                for k in 0..N_VARS {
                    sim.state.u[k][idx] = u[k];
                }
            }
        }
    }

    #[test]
    fn sod_shock_tube_plateaus() {
        // Run the tube along x with a thin transverse extent.
        let grid = Grid::new(400, 4, 1.0, 0.01);
        let mut sim = Sim::new(grid);
        sim.cfl = 0.4;
        sod_ic(&mut sim, 0.5);

        let t_end = 0.2_f64;
        while sim.t < t_end {
            let mut dt = compute_dt(&sim);
            if sim.t + dt > t_end {
                dt = t_end - sim.t;
            }
            step(&mut sim, dt);
        }

        // Sample a horizontal cut at j = ny/2.
        let j = grid.ny / 2;
        let mut rho = vec![0.0; grid.nx];
        let mut pres = vec![0.0; grid.nx];
        let mut vx = vec![0.0; grid.nx];
        for i in 0..grid.nx {
            let idx = grid.idx(i, j);
            let mut u = [0.0; N_VARS];
            for k in 0..N_VARS { u[k] = sim.state.u[k][idx]; }
            let p = cons_to_prim(u);
            rho[i] = p.rho;
            pres[i] = p.p;
            vx[i] = p.vx;
        }

        // Pre-shock right state should still be near the initial right state.
        // Sample at the very right edge (untouched by waves at t=0.2):
        assert!((rho[grid.nx - 1] - 0.125).abs() < 0.02,
                "right state contaminated: rho = {}", rho[grid.nx - 1]);
        assert!((pres[grid.nx - 1] - 0.1).abs() < 0.02);

        // Pre-rarefaction left state should still be near the initial left state.
        assert!((rho[0] - 1.0).abs() < 0.02,
                "left state contaminated: rho = {}", rho[0]);
        assert!((pres[0] - 1.0).abs() < 0.02);

        // Find the post-shock plateau by scanning from the right inward until
        // density rises above 0.2 (well clear of the 0.125 pre-shock value
        // and below the 0.42-ish contact plateau).
        let mut shock_i = None;
        for i in (0..grid.nx).rev() {
            if rho[i] > 0.2 {
                shock_i = Some(i);
                break;
            }
        }
        let shock_i = shock_i.expect("no shock found");
        // Sample 10 cells to the left of the shock front -- the post-shock
        // plateau between shock and contact.
        let probe = shock_i.saturating_sub(10);
        let post_shock_rho = rho[probe];
        let post_shock_p = pres[probe];
        // Analytic Sod post-shock plateau: rho ~ 0.2655, p ~ 0.3031.
        // HLL on a uniform 400-cell grid smears it, so we allow generous bands.
        assert!((post_shock_rho - 0.266).abs() < 0.05,
                "post-shock rho = {} (expected ~0.266)", post_shock_rho);
        assert!((post_shock_p - 0.303).abs() < 0.05,
                "post-shock p = {} (expected ~0.303)", post_shock_p);
        // Post-shock velocity is positive (shock moving right, gas behind it
        // moving right too).
        assert!(vx[probe] > 0.5,
                "post-shock vx = {} (expected ~0.927)", vx[probe]);
    }
}
