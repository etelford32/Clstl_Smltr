//! Finite-volume MHD solver: SSP-RK2 with PLM reconstruction, HLLD Riemann
//! fluxes, and GLM divergence cleaning (Dedner et al. 2002).
//!
//! Pipeline per RK stage, per axis:
//!   1. Reconstruct primitives to face-left and face-right states with
//!      piecewise-linear MUSCL using a minmod limiter.
//!   2. Compute the GLM-corrected (Bn, psi) at each face by upwinding with
//!      cleaning speed `c_h`.
//!   3. Call HLLD with those interface values; add F_psi = c_h^2 * Bn.
//!   4. Update conserved variables: U += -dt/dl * (F_{i+1/2} - F_{i-1/2}).
//!
//! After the full step we apply parabolic damping to psi:
//!   psi *= exp(-c_h * dt / c_r),  c_r = 0.18 (Mignone & Tzeferacos 2010).
//!
//! `c_h` is set from the CFL-limiting max wave speed each step, which keeps
//! the cleaning wave fast enough to outrun the physical fields without
//! shrinking dt further.

use crate::bc::{apply_bcs, BoundaryConfig};
use crate::grid::{Grid, NG};
use crate::hlld::hlld_flux;
use crate::state::{
    cons_to_prim, fast_speed, var, Prim, State, GAMMA, N_VARS,
    P_FLOOR, RHO_FLOOR,
};
use crate::Sim;

/// GLM parabolic-damping length scale (Mignone & Tzeferacos 2010). Smaller
/// values damp psi faster; 0.18 is the de-facto choice for HLLD+GLM codes.
const GLM_C_R: f64 = 0.18;

#[derive(Clone, Copy)]
enum Axis {
    X,
    Y,
}

impl Axis {
    #[inline]
    fn idx(self) -> usize { match self { Axis::X => 0, Axis::Y => 1 } }
    #[inline]
    fn stride(self, g: &Grid) -> usize { match self { Axis::X => 1, Axis::Y => g.stride_x() } }
    #[inline]
    fn dl(self, g: &Grid) -> f64 { match self { Axis::X => g.dx, Axis::Y => g.dy } }
}

/// minmod slope limiter.
#[inline]
fn minmod(a: f64, b: f64) -> f64 {
    if a * b <= 0.0 { 0.0 }
    else if a.abs() < b.abs() { a }
    else { b }
}

/// CFL-limited timestep + cleaning speed `c_h`.
///
/// Returns (dt, c_h). `c_h` is taken as the maximum face-normal fast speed
/// over the grid — this is the propagation speed of the GLM cleaning wave
/// and the CFL-controlling wave, so they share the limit.
pub fn compute_dt(sim: &Sim) -> (f64, f64) {
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
    let c_h = max_x.max(max_y).max(1.0e-30);
    let dt_x = g.dx / max_x.max(1.0e-30);
    let dt_y = g.dy / max_y.max(1.0e-30);
    let dt = sim.cfl * dt_x.min(dt_y);
    (dt, c_h)
}

#[inline]
fn read_u(s: &State, idx: usize) -> [f64; N_VARS] {
    let mut u = [0.0; N_VARS];
    for k in 0..N_VARS { u[k] = s.u[k][idx]; }
    u
}

/// Single Euler-style update: scratch = state + dt L(state).
/// Computes L(state) by sweeping x then y with HLLD+GLM fluxes.
fn stage_rhs(sim: &mut Sim, dt: f64, c_h: f64) {
    // Initialise scratch = state.
    for v in 0..N_VARS {
        sim.scratch.u[v].copy_from_slice(&sim.state.u[v]);
    }
    sweep_axis(sim, dt, c_h, Axis::X);
    sweep_axis(sim, dt, c_h, Axis::Y);
}

fn sweep_axis(sim: &mut Sim, dt: f64, c_h: f64, axis: Axis) {
    let g = sim.grid;
    let stride = axis.stride(&g);
    let dl = axis.dl(&g);
    let lambda = dt / dl;

    let (outer, inner, outer_stride, inner_start) = match axis {
        Axis::X => (g.ny, g.nx, g.stride_x(), NG),
        Axis::Y => (g.nx, g.ny, 1usize, NG),
    };
    let outer_start = NG;

    for o in 0..outer {
        let line_start = (outer_start + o) * outer_stride + inner_start * stride;

        // We need primitives at indices: line_start + k*stride for
        // k = -2, -1, 0, 1, ..., inner+1. PLM reconstruction at face k+1/2
        // uses primitives at k-1, k, k+1, k+2.

        // Helper to read primitives at offset k (in cells from line_start).
        // We pull from sim.state (read-only); writes go to sim.scratch.
        let prim_at = |k: isize| -> Prim {
            let idx = (line_start as isize + k * stride as isize) as usize;
            cons_to_prim(read_u(&sim.state, idx))
        };

        // Compute the leftmost face flux F_{-1/2}.
        // Face -1/2 sits between cell -1 (ghost) and cell 0 (first real).
        // PLM stencil needs cells -2, -1, 0, 1.
        let mut p_left_face: Prim;
        let mut p_right_face: Prim;
        {
            let pm1 = prim_at(-1);
            let p0 = prim_at(0);
            let pm2 = prim_at(-2);
            let p1 = prim_at(1);
            // Reconstruct to the right side of cell -1 (left state of face -1/2)
            p_left_face = recon_right(pm2, pm1, p0);
            // Reconstruct to the left side of cell 0 (right state of face -1/2)
            p_right_face = recon_left(pm1, p0, p1);
        }
        let mut f_left = face_flux(p_left_face, p_right_face, axis.idx(), c_h);

        for k in 0..inner {
            // Face (k+1/2) sits between cell k and cell k+1.
            let kk = k as isize;
            let p_km1 = prim_at(kk - 1);
            let p_k = prim_at(kk);
            let p_kp1 = prim_at(kk + 1);
            let p_kp2 = prim_at(kk + 2);

            let pl = recon_right(p_km1, p_k, p_kp1);
            let pr = recon_left(p_k, p_kp1, p_kp2);
            let f_right = face_flux(pl, pr, axis.idx(), c_h);

            let idx_c = (line_start as isize + kk * stride as isize) as usize;
            for v in 0..N_VARS {
                let updated = sim.scratch.u[v][idx_c] - lambda * (f_right[v] - f_left[v]);
                sim.scratch.u[v][idx_c] = updated;
            }
            apply_floors(&mut sim.scratch, idx_c);

            f_left = f_right;
            let _ = (p_left_face, p_right_face); // shut up unused-mut on first iteration
            p_left_face = pl;
            p_right_face = pr;
        }
    }
}

/// PLM reconstruction to the *right* face of the centre cell using a minmod
/// limited slope. `pm` = cell-1, `p` = cell, `pp` = cell+1. We limit each
/// primitive variable independently.
#[inline]
fn recon_right(pm: Prim, p: Prim, pp: Prim) -> Prim {
    let lim = |x_m: f64, x_c: f64, x_p: f64| {
        let dl = x_c - x_m;
        let dr = x_p - x_c;
        x_c + 0.5 * minmod(dl, dr)
    };
    Prim {
        rho: lim(pm.rho, p.rho, pp.rho),
        vx:  lim(pm.vx,  p.vx,  pp.vx),
        vy:  lim(pm.vy,  p.vy,  pp.vy),
        vz:  lim(pm.vz,  p.vz,  pp.vz),
        p:   lim(pm.p,   p.p,   pp.p),
        bx:  lim(pm.bx,  p.bx,  pp.bx),
        by:  lim(pm.by,  p.by,  pp.by),
        bz:  lim(pm.bz,  p.bz,  pp.bz),
        psi: lim(pm.psi, p.psi, pp.psi),
    }
}

/// PLM reconstruction to the *left* face of the centre cell.
#[inline]
fn recon_left(pm: Prim, p: Prim, pp: Prim) -> Prim {
    let lim = |x_m: f64, x_c: f64, x_p: f64| {
        let dl = x_c - x_m;
        let dr = x_p - x_c;
        x_c - 0.5 * minmod(dl, dr)
    };
    Prim {
        rho: lim(pm.rho, p.rho, pp.rho),
        vx:  lim(pm.vx,  p.vx,  pp.vx),
        vy:  lim(pm.vy,  p.vy,  pp.vy),
        vz:  lim(pm.vz,  p.vz,  pp.vz),
        p:   lim(pm.p,   p.p,   pp.p),
        bx:  lim(pm.bx,  p.bx,  pp.bx),
        by:  lim(pm.by,  p.by,  pp.by),
        bz:  lim(pm.bz,  p.bz,  pp.bz),
        psi: lim(pm.psi, p.psi, pp.psi),
    }
}

/// Compute the GLM-corrected face values (Bn, psi) using the upwind formula
/// (Dedner 2002 eq. 41), then call HLLD with those single-valued normal
/// components. Finally fill in F_psi = c_h^2 * Bn_face.
fn face_flux(pl: Prim, pr: Prim, axis_idx: usize, c_h: f64) -> [f64; N_VARS] {
    let (bn_l, bn_r) = match axis_idx { 0 => (pl.bx, pr.bx), _ => (pl.by, pr.by) };
    let bn_face = 0.5 * (bn_l + bn_r) - 0.5 / c_h * (pr.psi - pl.psi);
    let psi_face = 0.5 * (pl.psi + pr.psi) - 0.5 * c_h * (bn_r - bn_l);

    let mut f = hlld_flux(pl, pr, axis_idx, bn_face, psi_face);
    f[var::PSI] = c_h * c_h * bn_face;
    f
}

#[inline]
fn apply_floors(s: &mut State, idx: usize) {
    if s.u[var::RHO][idx] < RHO_FLOOR { s.u[var::RHO][idx] = RHO_FLOOR; }
    let rho = s.u[var::RHO][idx];
    let mx = s.u[var::MX][idx];
    let my = s.u[var::MY][idx];
    let mz = s.u[var::MZ][idx];
    let bx = s.u[var::BX][idx];
    let by = s.u[var::BY][idx];
    let bz = s.u[var::BZ][idx];
    let kin = 0.5 * (mx * mx + my * my + mz * mz) / rho;
    let mag = 0.5 * (bx * bx + by * by + bz * bz);
    let e_min = kin + mag + P_FLOOR / (GAMMA - 1.0);
    if s.u[var::E][idx] < e_min { s.u[var::E][idx] = e_min; }
}

#[inline]
fn swap_state_scratch(sim: &mut Sim) {
    core::mem::swap(&mut sim.state, &mut sim.scratch);
}

/// Apply parabolic GLM damping: psi *= exp(-c_h * dt / c_r). Mixed
/// hyperbolic/parabolic cleaning is more effective than pure hyperbolic at
/// keeping div B bounded over long integrations.
pub fn damp_psi(sim: &mut Sim, dt: f64, c_h: f64) {
    let g = sim.grid;
    let decay = (-c_h * dt / GLM_C_R).exp();
    for j in 0..g.ny {
        for i in 0..g.nx {
            let idx = g.idx(i, j);
            sim.state.u[var::PSI][idx] *= decay;
        }
    }
}

/// Diagnostic: mean and max |div B| over real cells. Uses central differences
/// on the cell-centred B-field. With pure HLLD+GLM the L1 norm should stay
/// bounded; without cleaning it grows linearly in time.
pub fn divb_norms(sim: &Sim) -> (f64, f64) {
    let g = &sim.grid;
    let inv_2dx = 0.5 / g.dx;
    let inv_2dy = 0.5 / g.dy;
    let mut acc = 0.0;
    let mut peak = 0.0_f64;
    let mut n = 0;
    for j in 0..g.ny {
        for i in 0..g.nx {
            let c = g.idx(i, j);
            // Neighbours (use padded indexing so ghost zones supply periodic
            // values at the edges).
            let xp = c + 1;
            let xm = c - 1;
            let yp = c + g.stride_x();
            let ym = c - g.stride_x();
            let d = (sim.state.u[var::BX][xp] - sim.state.u[var::BX][xm]) * inv_2dx
                  + (sim.state.u[var::BY][yp] - sim.state.u[var::BY][ym]) * inv_2dy;
            let a = d.abs();
            acc += a;
            if a > peak { peak = a; }
            n += 1;
        }
    }
    (acc / n as f64, peak)
}

/// Public top-level "advance one step" entry point.
/// Manages the c_h estimate, the SSP-RK2 stages, GLM damping, and the
/// resistive sub-cycle. Returns dt.
///
/// Operator splitting is Lie (first-order): ideal MHD step, then resistive
/// step. The resistive timescale on flare-relevant grids is usually much
/// longer than the Alfvén timescale, so the splitting error is small.
pub fn advance(sim: &mut Sim, bcs: BoundaryConfig) -> f64 {
    let (dt, c_h) = compute_dt(sim);
    sim.c_h = c_h;
    rk2_step(sim, dt, bcs, c_h);
    damp_psi(sim, dt, c_h);
    if sim.eta > 0.0 {
        crate::resistive::apply_resistive(sim, dt, sim.eta, bcs);
    }
    sim.t += dt;
    dt
}

/// Correct SSP-RK2 step that stashes U^n before stage 1.
fn rk2_step(sim: &mut Sim, dt: f64, bcs: BoundaryConfig, c_h: f64) {
    // Stash U^n in sim.pre.
    for v in 0..N_VARS {
        sim.pre.u[v].copy_from_slice(&sim.state.u[v]);
    }

    // Stage 1: state <- U^n + dt L(U^n).
    apply_bcs(&sim.grid, bcs, &mut sim.state);
    stage_rhs(sim, dt, c_h);
    swap_state_scratch(sim);

    // Stage 2: scratch <- U^(1) + dt L(U^(1)).
    apply_bcs(&sim.grid, bcs, &mut sim.state);
    stage_rhs(sim, dt, c_h);

    // state <- 0.5 (U^n + scratch).
    let g = sim.grid;
    for j in 0..g.ny {
        for i in 0..g.nx {
            let idx = g.idx(i, j);
            for v in 0..N_VARS {
                sim.state.u[v][idx] = 0.5 * (sim.pre.u[v][idx] + sim.scratch.u[v][idx]);
            }
            apply_floors(&mut sim.state, idx);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bc::BoundaryConfig;
    use crate::state::{prim_to_cons, Prim};
    use crate::{Grid, Sim};

    fn fill_sod(sim: &mut Sim, split: f64) {
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
                for k in 0..N_VARS { sim.state.u[k][idx] = u[k]; }
            }
        }
    }

    #[test]
    fn sod_shock_tube_with_hlld_plm_rk2() {
        // HLLD reduces to a contact-resolving Riemann solver in pure hydro;
        // PLM+RK2 sharpens the contact further. The same plateau tolerances
        // as the Phase-1 test should hold.
        let grid = Grid::new(400, 4, 1.0, 0.01);
        let mut sim = Sim::new(grid);
        sim.cfl = 0.4;
        fill_sod(&mut sim, 0.5);

        let bcs = BoundaryConfig::OUTFLOW_ALL;
        let t_end = 0.2_f64;
        while sim.t < t_end {
            // Cap dt at the remaining time without re-using `advance`, since
            // advance increments sim.t internally with the full CFL dt.
            let (mut dt, c_h) = compute_dt(&sim);
            if sim.t + dt > t_end { dt = t_end - sim.t; }
            sim.c_h = c_h;
            rk2_step(&mut sim, dt, bcs, c_h);
            damp_psi(&mut sim, dt, c_h);
            sim.t += dt;
        }

        let j = grid.ny / 2;
        let mut rho = vec![0.0; grid.nx];
        let mut pres = vec![0.0; grid.nx];
        let mut vx = vec![0.0; grid.nx];
        for i in 0..grid.nx {
            let idx = grid.idx(i, j);
            let u = read_u(&sim.state, idx);
            let p = cons_to_prim(u);
            rho[i] = p.rho; pres[i] = p.p; vx[i] = p.vx;
        }
        // Same checks as Phase 1.
        assert!((rho[grid.nx - 1] - 0.125).abs() < 0.02);
        assert!((rho[0] - 1.0).abs() < 0.02);
        let mut shock_i = None;
        for i in (0..grid.nx).rev() {
            if rho[i] > 0.2 { shock_i = Some(i); break; }
        }
        let shock_i = shock_i.expect("no shock found");
        let probe = shock_i.saturating_sub(10);
        assert!((rho[probe] - 0.266).abs() < 0.05,
                "post-shock rho = {}", rho[probe]);
        assert!((pres[probe] - 0.303).abs() < 0.05,
                "post-shock p = {}", pres[probe]);
        assert!(vx[probe] > 0.5);
    }

    /// Orszag-Tang vortex (Orszag & Tang 1979) — the standard 2D MHD
    /// benchmark. Periodic [0, 2π]^2 box; develops a network of MHD shocks
    /// and current sheets. We check that the integrator stays stable to
    /// t = 0.5, that no NaNs appear, that the density stays bounded, and
    /// that the mean |div B| stays small (proving GLM cleaning works).
    #[test]
    fn orszag_tang_stable_to_t05() {
        use std::f64::consts::PI;
        let n = 64;
        let l = 2.0 * PI;
        let grid = Grid::new(n, n, l, l);
        let mut sim = Sim::new(grid);
        sim.cfl = 0.3; // tighter for a vortex stress test

        // Athena-style IC: rho = 25/(36π), p = 5/(12π), v = (-sin y, sin x),
        // B = (-sin y, sin 2x) / sqrt(4π).
        let rho0 = 25.0 / (36.0 * PI);
        let p0 = 5.0 / (12.0 * PI);
        let b_amp = 1.0 / (4.0 * PI).sqrt();
        for j in 0..n {
            for i in 0..n {
                let idx = grid.idx(i, j);
                let x = grid.xc(i);
                let y = grid.yc(j);
                let p = Prim {
                    rho: rho0,
                    vx: -y.sin(), vy: x.sin(), vz: 0.0,
                    p: p0,
                    bx: -b_amp * y.sin(),
                    by:  b_amp * (2.0 * x).sin(),
                    bz: 0.0,
                    psi: 0.0,
                };
                let u = prim_to_cons(p);
                for k in 0..N_VARS { sim.state.u[k][idx] = u[k]; }
            }
        }

        let bcs = BoundaryConfig::PERIODIC_ALL;
        let t_end = 0.5_f64;

        // Energy at t=0: sum of total energy over real cells.
        let mut e_init = 0.0;
        for j in 0..n {
            for i in 0..n {
                e_init += sim.state.u[var::E][grid.idx(i, j)];
            }
        }

        let mut steps = 0;
        while sim.t < t_end {
            let (mut dt, c_h) = compute_dt(&sim);
            if sim.t + dt > t_end { dt = t_end - sim.t; }
            sim.c_h = c_h;
            rk2_step(&mut sim, dt, bcs, c_h);
            damp_psi(&mut sim, dt, c_h);
            sim.t += dt;
            steps += 1;
            assert!(steps < 5000, "OT runaway: {} steps without reaching t_end", steps);
        }

        // Stability checks.
        let mut rho_min = f64::INFINITY;
        let mut rho_max = f64::NEG_INFINITY;
        let mut e_final = 0.0;
        for j in 0..n {
            for i in 0..n {
                let idx = grid.idx(i, j);
                let r = sim.state.u[var::RHO][idx];
                assert!(r.is_finite(), "rho NaN at ({}, {})", i, j);
                assert!(sim.state.u[var::E][idx].is_finite(),
                        "E NaN at ({}, {})", i, j);
                rho_min = rho_min.min(r);
                rho_max = rho_max.max(r);
                e_final += sim.state.u[var::E][idx];
            }
        }
        assert!(rho_min > 0.0, "rho went non-positive: {}", rho_min);
        // OT at t=0.5 has rho roughly in [0.1*rho0, 5*rho0]. Loose bounds:
        assert!(rho_min > 0.01 * rho0,
                "rho_min = {} too low (rho0 = {})", rho_min, rho0);
        assert!(rho_max < 10.0 * rho0,
                "rho_max = {} too high (rho0 = {})", rho_max, rho0);

        // Energy should be conserved to better than 5% (the GLM source and
        // floors leak some energy; HLLD has no internal dissipation switch).
        let de_rel = ((e_final - e_init) / e_init).abs();
        assert!(de_rel < 0.05, "energy drift {} > 5%", de_rel);

        // GLM cleaning: mean |div B| should be small. Threshold chosen
        // generously — without cleaning this grows by orders of magnitude.
        // Apply periodic ghosts once so the divergence stencil sees them.
        apply_bcs(&sim.grid, bcs, &mut sim.state);
        let (mean_divb, _max_divb) = divb_norms(&sim);
        assert!(mean_divb < 0.1,
                "mean |div B| = {} too high (GLM not converging)", mean_divb);
    }
}
