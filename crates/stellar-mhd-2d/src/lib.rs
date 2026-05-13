//! 2.5-D resistive MHD kernel for stellar flare modelling.
//!
//! Roadmap (each phase has its own validation test):
//!   1. Pure hydro on a uniform Cartesian grid with an HLL Riemann solver,
//!      validated on the Sod shock tube. [`solver::hll`]
//!   2. Full MHD with HLLD + GLM divergence cleaning, validated on the
//!      Orszag-Tang vortex. (pending)
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

pub mod grid;
pub mod solver;
pub mod state;

pub use grid::{Grid, NG};
pub use state::{cons_to_prim, prim_to_cons, Prim, State, GAMMA, N_VARS};

/// Top-level simulation handle. Owns the grid, the conserved state, and a
/// scratch buffer used by the Riemann sweep. Time-stepping methods live in
/// [`solver`].
pub struct Sim {
    pub grid: Grid,
    pub state: State,
    pub scratch: State,
    pub t: f64,
    pub cfl: f64,
}

impl Sim {
    pub fn new(grid: Grid) -> Self {
        let state = State::zeros(&grid);
        let scratch = State::zeros(&grid);
        Self {
            grid,
            state,
            scratch,
            t: 0.0,
            cfl: 0.4,
        }
    }
}
