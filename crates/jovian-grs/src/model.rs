//! 1.5-layer (reduced-gravity) shallow-water dynamics on the C-grid.
//!
//! Vector-invariant form (Sadourny 1975, energy-conserving):
//!
//! ```text
//!   ∂u/∂t = + q · (h v)        - ∂B/∂x  +  D_u + F_u
//!   ∂v/∂t = - q · (h u)        - ∂B/∂y  +  D_v + F_v
//!   ∂h/∂t = - ∂(h u)/∂x - ∂(h v)/∂y
//! ```
//!
//! with potential vorticity `q = (f + ζ)/h`, relative vorticity
//! `ζ = ∂v/∂x − ∂u/∂y`, and Bernoulli function `B = g'h + ½(u²+v²)`.
//! The `q·(h v)` terms fold the Coriolis force and the nonlinear advection
//! into one mass-flux-weighted product, which is what makes the scheme
//! conserve energy and behave well for long vortex integrations.
//!
//! Added on top:
//!   * `D` — biharmonic hyperviscosity `−ν₄∇⁴` on the momentum, the minimal
//!     dissipation that drains the enstrophy cascade at the grid scale while
//!     leaving the resolved vortex almost untouched.
//!   * `F` — a relaxation of the *zonal-mean* zonal wind toward the measured
//!     jet profile (maintains the jets against dissipation without damping
//!     the eddies) plus a wall sponge.

use crate::grid::Grid;

/// Physical + numerical parameters that don't change during a run.
#[derive(Clone)]
pub struct Params {
    /// Reduced gravity g' = g·Δρ/ρ  (m/s²).
    pub gp: f64,
    /// Mean active-layer depth H (m) — sets the gravity-wave speed √(g'H).
    pub h0: f64,
    /// Biharmonic hyperviscosity ν₄ (m⁴/s).
    pub nu4: f64,
    /// Zonal-jet relaxation timescale (s); ≤0 disables jet maintenance.
    pub tau_jet: f64,
    /// Linear (bottom) drag rate (1/s); 0 disables.
    pub r_drag: f64,
    /// Number of rows over which the wall sponge ramps in at each y-wall.
    pub sponge_n: usize,
    /// Peak sponge relaxation rate at the wall (1/s).
    pub r_sponge: f64,
}

/// Reusable scratch buffers so the RHS evaluation is allocation-free.
pub struct Work {
    pub bern: Vec<f64>,   // Bernoulli B at centres            (nc)
    pub uflux: Vec<f64>,  // zonal mass flux U = h̄·u at u-pts   (nc)
    pub vflux: Vec<f64>,  // merid mass flux V = h̄·v at v-pts   (nf)
    pub q: Vec<f64>,      // potential vorticity at corners     (nf)
    pub lap: Vec<f64>,    // ∇² scratch                         (max(nc,nf))
    pub lap2: Vec<f64>,   // ∇²(∇²) scratch                     (max(nc,nf))
}

impl Work {
    pub fn new(g: &Grid) -> Self {
        let m = g.nc().max(g.nf());
        Work {
            bern: vec![0.0; g.nc()],
            uflux: vec![0.0; g.nc()],
            vflux: vec![0.0; g.nf()],
            q: vec![0.0; g.nf()],
            lap: vec![0.0; m],
            lap2: vec![0.0; m],
        }
    }
}

/// Evaluate the full right-hand side for state `(h,u,v)`, writing the
/// tendencies into `(kh,ku,kv)`. `u_ref`/`h_ref` are the per-row background
/// jet and balanced thickness used by the forcing + sponge.
#[allow(clippy::too_many_arguments)]
pub fn compute_rhs(
    g: &Grid, p: &Params,
    h: &[f64], u: &[f64], v: &[f64],
    w: &mut Work,
    kh: &mut [f64], ku: &mut [f64], kv: &mut [f64],
    u_ref: &[f64], h_ref: &[f64],
) {
    let (nx, ny) = (g.nx, g.ny);
    let (dx, dy) = (g.dx, g.dy);

    // ── mass fluxes ────────────────────────────────────────────────────
    for j in 0..ny {
        for i in 0..nx {
            let c = g.c(i, j);
            w.uflux[c] = 0.5 * (h[c] + h[g.c(g.ip1(i), j)]) * u[c];
        }
    }
    for i in 0..nx {
        w.vflux[g.f(i, 0)] = 0.0;
        w.vflux[g.f(i, ny)] = 0.0;
    }
    for jf in 1..ny {
        for i in 0..nx {
            let f = g.f(i, jf);
            w.vflux[f] = 0.5 * (h[g.c(i, jf - 1)] + h[g.c(i, jf)]) * v[f];
        }
    }

    // ── potential vorticity at corners ─────────────────────────────────
    for i in 0..nx {
        let ip1 = g.ip1(i);
        // South wall (jf=0) and north wall (jf=ny): free-slip ⇒ ζ = 0.
        let hc0 = 0.5 * (h[g.c(i, 0)] + h[g.c(ip1, 0)]);
        w.q[g.f(i, 0)] = g.f_f[0] / hc0;
        let hcn = 0.5 * (h[g.c(i, ny - 1)] + h[g.c(ip1, ny - 1)]);
        w.q[g.f(i, ny)] = g.f_f[ny] / hcn;
    }
    for jf in 1..ny {
        for i in 0..nx {
            let ip1 = g.ip1(i);
            let zeta = (v[g.f(ip1, jf)] - v[g.f(i, jf)]) / dx
                     - (u[g.c(i, jf)] - u[g.c(i, jf - 1)]) / dy;
            let hc = 0.25 * (h[g.c(i, jf - 1)] + h[g.c(ip1, jf - 1)]
                           + h[g.c(i, jf)]     + h[g.c(ip1, jf)]);
            w.q[g.f(i, jf)] = (g.f_f[jf] + zeta) / hc;
        }
    }

    // ── Bernoulli function at centres ──────────────────────────────────
    for j in 0..ny {
        for i in 0..nx {
            let c = g.c(i, j);
            let u_e = u[c];
            let u_w = u[g.c(g.im1(i), j)];
            let v_n = v[g.f(i, j + 1)];
            let v_s = v[g.f(i, j)];
            let ke = 0.5 * (0.5 * (u_e * u_e + u_w * u_w) + 0.5 * (v_n * v_n + v_s * v_s));
            w.bern[c] = p.gp * h[c] + ke;
        }
    }

    // ── mass tendency (flux form) ──────────────────────────────────────
    for j in 0..ny {
        for i in 0..nx {
            let c = g.c(i, j);
            let dudx = (w.uflux[c] - w.uflux[g.c(g.im1(i), j)]) / dx;
            let dvdy = (w.vflux[g.f(i, j + 1)] - w.vflux[g.f(i, j)]) / dy;
            kh[c] = -(dudx + dvdy);
        }
    }

    // ── u momentum tendency (east faces, centre rows) ──────────────────
    for j in 0..ny {
        for i in 0..nx {
            let c = g.c(i, j);
            let ip1 = g.ip1(i);
            let pgf = (w.bern[g.c(ip1, j)] - w.bern[c]) / dx;
            let q_above = w.q[g.f(i, j + 1)];
            let q_below = w.q[g.f(i, j)];
            let v_above = 0.5 * (w.vflux[g.f(i, j + 1)] + w.vflux[g.f(ip1, j + 1)]);
            let v_below = 0.5 * (w.vflux[g.f(i, j)]     + w.vflux[g.f(ip1, j)]);
            let cor = 0.5 * (q_above * v_above + q_below * v_below);
            ku[c] = cor - pgf;
        }
    }

    // ── v momentum tendency (north faces) ──────────────────────────────
    for i in 0..nx {
        kv[g.f(i, 0)] = 0.0;
        kv[g.f(i, ny)] = 0.0;
    }
    for jf in 1..ny {
        for i in 0..nx {
            let f = g.f(i, jf);
            let im1 = g.im1(i);
            let pgf = (w.bern[g.c(i, jf)] - w.bern[g.c(i, jf - 1)]) / dy;
            let q_right = w.q[f];
            let q_left = w.q[g.f(im1, jf)];
            let u_right = 0.5 * (w.uflux[g.c(i, jf)]   + w.uflux[g.c(i, jf - 1)]);
            let u_left  = 0.5 * (w.uflux[g.c(im1, jf)] + w.uflux[g.c(im1, jf - 1)]);
            let cor = 0.5 * (q_right * u_right + q_left * u_left);
            kv[f] = -cor - pgf;
        }
    }

    // ── biharmonic hyperviscosity on the momentum ──────────────────────
    if p.nu4 > 0.0 {
        // u-grid (centre rows, periodic-x, Neumann y).
        laplacian_c(g, u, &mut w.lap);
        laplacian_c(g, &w.lap, &mut w.lap2);
        for c in 0..g.nc() { ku[c] -= p.nu4 * w.lap2[c]; }
        // v-grid (faces, periodic-x, Dirichlet v=0 at walls).
        laplacian_f(g, v, &mut w.lap);
        laplacian_f(g, &w.lap, &mut w.lap2);
        for jf in 1..ny {
            for i in 0..nx {
                let f = g.f(i, jf);
                kv[f] -= p.nu4 * w.lap2[f];
            }
        }
    }

    // ── linear bottom drag ─────────────────────────────────────────────
    if p.r_drag > 0.0 {
        for c in 0..g.nc() { ku[c] -= p.r_drag * u[c]; }
        for jf in 1..ny { for i in 0..nx { let f = g.f(i, jf); kv[f] -= p.r_drag * v[f]; } }
    }

    // ── jet maintenance: relax the zonal-MEAN u toward the target jet ──
    if p.tau_jet > 0.0 {
        let inv_tau = 1.0 / p.tau_jet;
        for j in 0..ny {
            let mut ubar = 0.0;
            for i in 0..nx { ubar += u[g.c(i, j)]; }
            ubar /= nx as f64;
            let corr = (u_ref[j] - ubar) * inv_tau;
            for i in 0..nx { ku[g.c(i, j)] += corr; }
        }
    }

    // ── wall sponge: absorb energy reaching the y-walls ────────────────
    if p.sponge_n > 0 && p.r_sponge > 0.0 {
        let n = p.sponge_n;
        for j in 0..ny {
            // distance (in rows) to the nearest wall
            let d = j.min(ny - 1 - j);
            if d >= n { continue; }
            let s = (1.0 - d as f64 / n as f64).powi(2) * p.r_sponge;
            for i in 0..nx {
                let c = g.c(i, j);
                ku[c] -= s * (u[c] - u_ref[j]);
                kh[c] -= s * (h[c] - h_ref[j]);
            }
        }
        for jf in 1..ny {
            let d = jf.min(ny - jf);
            if d >= n { continue; }
            let s = (1.0 - d as f64 / n as f64).powi(2) * p.r_sponge;
            for i in 0..nx { let f = g.f(i, jf); kv[f] -= s * v[f]; }
        }
    }
}

/// ∇² of a centre/u-grid field: periodic in x, zero-gradient (Neumann) in y.
fn laplacian_c(g: &Grid, a: &[f64], out: &mut [f64]) {
    let (nx, ny) = (g.nx, g.ny);
    let (idx2, idy2) = (1.0 / (g.dx * g.dx), 1.0 / (g.dy * g.dy));
    for j in 0..ny {
        let jm = if j == 0 { 0 } else { j - 1 };          // Neumann mirror
        let jp = if j + 1 == ny { ny - 1 } else { j + 1 };
        for i in 0..nx {
            let c = g.c(i, j);
            out[c] = (a[g.c(g.ip1(i), j)] - 2.0 * a[c] + a[g.c(g.im1(i), j)]) * idx2
                   + (a[g.c(i, jp)]       - 2.0 * a[c] + a[g.c(i, jm)])       * idy2;
        }
    }
}

/// ∇² of a face/v-grid field: periodic in x, Dirichlet (=0) at the y-walls.
/// Only interior faces `jf ∈ 1..ny` carry a value; walls stay zero.
fn laplacian_f(g: &Grid, a: &[f64], out: &mut [f64]) {
    let (nx, ny) = (g.nx, g.ny);
    let (idx2, idy2) = (1.0 / (g.dx * g.dx), 1.0 / (g.dy * g.dy));
    for i in 0..nx { out[g.f(i, 0)] = 0.0; out[g.f(i, ny)] = 0.0; }
    for jf in 1..ny {
        for i in 0..nx {
            let f = g.f(i, jf);
            // neighbours at jf±1; the walls (jf=0,ny) hold a=0 already.
            out[f] = (a[g.f(g.ip1(i), jf)] - 2.0 * a[f] + a[g.f(g.im1(i), jf)]) * idx2
                   + (a[g.f(i, jf + 1)]    - 2.0 * a[f] + a[g.f(i, jf - 1)])    * idy2;
        }
    }
}

/// Relative vorticity ζ interpolated to centres (for rendering/diagnostics).
pub fn vorticity_centres(g: &Grid, u: &[f64], v: &[f64], out: &mut [f64]) {
    let (nx, ny) = (g.nx, g.ny);
    let (dx, dy) = (g.dx, g.dy);
    for j in 0..ny {
        for i in 0..nx {
            let im1 = g.im1(i);
            // average the four surrounding corner vorticities to the centre
            let mut z = 0.0;
            for &(ii, jf) in &[(i, j), (i, j + 1), (im1, j), (im1, j + 1)] {
                let dvdx = (v[g.f(g.ip1(ii), jf)] - v[g.f(ii, jf)]) / dx;
                let dudy = if jf == 0 || jf == ny {
                    0.0
                } else {
                    (u[g.c(ii, jf)] - u[g.c(ii, jf - 1)]) / dy
                };
                z += dvdx - dudy;
            }
            out[g.c(i, j)] = 0.25 * z;
        }
    }
}
