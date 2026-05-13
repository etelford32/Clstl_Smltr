//! Boundary conditions.
//!
//! Each of the four box sides can independently use Outflow (zero-gradient,
//! good for validating shock-tubes and for the open top of a coronal slab)
//! or Periodic (needed for the Orszag-Tang vortex and for any horizontally-
//! homogeneous flare configuration). Phase 4 adds a LineTied bottom BC that
//! pins B and v at the photospheric base; that lives in a follow-up.

use crate::grid::{Grid, NG};
use crate::state::{N_VARS, State};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BcKind {
    Outflow,
    Periodic,
}

#[derive(Clone, Copy, Debug)]
pub struct BoundaryConfig {
    pub left: BcKind,
    pub right: BcKind,
    pub bottom: BcKind,
    pub top: BcKind,
}

impl BoundaryConfig {
    pub const OUTFLOW_ALL: Self = Self {
        left: BcKind::Outflow,
        right: BcKind::Outflow,
        bottom: BcKind::Outflow,
        top: BcKind::Outflow,
    };
    pub const PERIODIC_ALL: Self = Self {
        left: BcKind::Periodic,
        right: BcKind::Periodic,
        bottom: BcKind::Periodic,
        top: BcKind::Periodic,
    };
}

/// Fill the NG-wide ghost layer on every side according to `cfg`.
///
/// We fill X-ghosts first then Y-ghosts. For periodic-Y the source cells
/// already include the just-written X-ghost columns, which is what we want
/// (corners need real values reachable by the two-step sweep).
pub fn apply_bcs(grid: &Grid, cfg: BoundaryConfig, s: &mut State) {
    let sx = grid.stride_x();
    let nx_p = grid.nx + 2 * NG;
    let ny_p = grid.ny + 2 * NG;

    // --- X sides ---
    for j in 0..ny_p {
        for g in 0..NG {
            let dst_l = j * sx + g;
            let dst_r = j * sx + (NG + grid.nx + g);
            let src_l = match cfg.left {
                BcKind::Outflow => j * sx + NG,
                BcKind::Periodic => j * sx + (grid.nx + g), // wrap from right edge
            };
            let src_r = match cfg.right {
                BcKind::Outflow => j * sx + (NG + grid.nx - 1),
                BcKind::Periodic => j * sx + (NG + g), // wrap from left edge
            };
            for k in 0..N_VARS {
                s.u[k][dst_l] = s.u[k][src_l];
                s.u[k][dst_r] = s.u[k][src_r];
            }
        }
    }

    // --- Y sides ---
    for g in 0..NG {
        for i in 0..nx_p {
            let dst_b = g * sx + i;
            let dst_t = (NG + grid.ny + g) * sx + i;
            let src_b = match cfg.bottom {
                BcKind::Outflow => NG * sx + i,
                BcKind::Periodic => (grid.ny + g) * sx + i,
            };
            let src_t = match cfg.top {
                BcKind::Outflow => (NG + grid.ny - 1) * sx + i,
                BcKind::Periodic => (NG + g) * sx + i,
            };
            for k in 0..N_VARS {
                s.u[k][dst_b] = s.u[k][src_b];
                s.u[k][dst_t] = s.u[k][src_t];
            }
        }
    }
}
