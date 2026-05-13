//! 2.5-D resistive MHD kernel for stellar flare modelling.
//!
//! Roadmap (each phase has its own validation test):
//!   1. Pure hydro on a uniform Cartesian grid with an HLL Riemann solver,
//!      validated on the Sod shock tube. [done]
//!   2. Full MHD with HLLD + GLM divergence cleaning, validated on the
//!      Orszag-Tang vortex. [done]
//!   3. Explicit resistivity (eta * laplacian B), validated against the
//!      Sweet-Parker reconnection scaling. (pending)
//!   4. Sheared magnetic-arcade initial condition for a flare run. (pending)
//!   5. WASM C-ABI exports + integration into star2d.html. (pending)
//!   6. Top-boundary outflow coupled to the star2d wind particle system. (pending)
//!
//! Conventions:
//!   * mu_0 = 1, so magnetic pressure is 0.5 * B^2 and the Lorentz force is
//!     (curl B) x B = (B . grad) B - grad(0.5 B^2).
//!   * gamma = 5/3 (fully-ionised monatomic plasma).
//!   * No external crates — the kernel must build for `wasm32-unknown-unknown`
//!     in a sandboxed environment without network access.

pub mod bc;
pub mod flare_ic;
pub mod grid;
pub mod hlld;
pub mod resistive;
pub mod solver;
pub mod state;
pub mod wasm;

pub use bc::{BcKind, BoundaryConfig};
pub use grid::{Grid, NG};
pub use resistive::{apply_resistive, ohmic_power, resistive_dt};
pub use solver::{advance, compute_dt, divb_norms};
pub use state::{cons_to_prim, prim_to_cons, Prim, State, GAMMA, N_VARS};

/// Top-level simulation handle. Owns the grid, the conserved state, the
/// previous-step state used by SSP-RK2, and a scratch buffer for the
/// Riemann sweep. Time-stepping methods live in [`solver`].
pub struct Sim {
    pub grid: Grid,
    /// Current conserved state U^n (and U^{n+1} after a step).
    pub state: State,
    /// Scratch buffer for the Riemann sweep / stage updates.
    pub scratch: State,
    /// Snapshot of U^n taken at the start of each RK2 step.
    pub pre: State,
    pub t: f64,
    pub cfl: f64,
    /// GLM cleaning speed, refreshed each step from the max wave speed.
    pub c_h: f64,
    /// Uniform magnetic diffusivity. Used when `eta_grid` is None.
    pub eta: f64,
    /// Optional per-cell magnetic diffusivity on the padded grid. When
    /// present it overrides `eta`. Lets us localise reconnection at a
    /// chosen trigger point (the standard Yokoyama-Shibata recipe for
    /// flare initiation): low η_bg everywhere, an η_peak Gaussian at the
    /// X-point. Stored padded so the resistive stencil can read ghosts
    /// without a separate BC pass on η.
    pub eta_grid: Option<Vec<f64>>,
}

impl Sim {
    pub fn new(grid: Grid) -> Self {
        let state = State::zeros(&grid);
        let scratch = State::zeros(&grid);
        let pre = State::zeros(&grid);
        Self {
            grid,
            state,
            scratch,
            pre,
            t: 0.0,
            cfl: 0.4,
            c_h: 0.0,
            eta: 0.0,
            eta_grid: None,
        }
    }

    /// Install a spatially-varying η field built from a closure of
    /// physical (x, y). Ghost-cell values are computed too so the resistive
    /// stencil reads consistent values at the box edges.
    pub fn set_eta_field<F: Fn(f64, f64) -> f64>(&mut self, f: F) {
        use crate::grid::NG;
        let g = self.grid;
        let nx_p = g.nx + 2 * NG;
        let ny_p = g.ny + 2 * NG;
        let mut v = vec![0.0; g.padded_len()];
        for j in 0..ny_p {
            for i in 0..nx_p {
                let x = g.x0 + (i as f64 - NG as f64 + 0.5) * g.dx;
                let y = g.y0 + (j as f64 - NG as f64 + 0.5) * g.dy;
                v[j * nx_p + i] = f(x, y);
            }
        }
        self.eta_grid = Some(v);
    }
}
