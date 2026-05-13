//! Flat C-ABI surface for the host (JavaScript / WebAssembly).
//!
//! All entry points operate on a process-global `Sim` slot. `wasm32-unknown-
//! unknown` is single-threaded, so an `UnsafeCell<Option<Sim>>` is sound —
//! there are no concurrent accessors. We avoid `OnceLock` to keep zero std
//! dependencies (no `std::sync`).
//!
//! Memory model: each field of the 9-variable conserved state is a flat
//! `Vec<f64>` of length `(nx + 2 NG) * (ny + 2 NG)`. The pointer-returning
//! exports hand JS a stable offset into linear memory; views must be
//! refreshed after any call that could grow the heap (i.e. `mhd_init_flare`).

use core::cell::UnsafeCell;

use crate::bc::BoundaryConfig;
use crate::flare_ic::{install_harris_with_bump, peak_jz, peak_vy, FlareConfig};
use crate::grid::NG;
use crate::solver::advance;
use crate::state::var;
use crate::{Grid, Sim};

struct Slot(UnsafeCell<Option<Sim>>);
unsafe impl Sync for Slot {}
static SIM: Slot = Slot(UnsafeCell::new(None));

struct BcSlot(UnsafeCell<BoundaryConfig>);
unsafe impl Sync for BcSlot {}
static BCS: BcSlot = BcSlot(UnsafeCell::new(BoundaryConfig::OUTFLOW_ALL));

#[inline]
fn sim_mut() -> &'static mut Sim {
    unsafe {
        (*SIM.0.get())
            .as_mut()
            .expect("mhd_init_flare must be called before any other entry point")
    }
}

#[inline]
fn sim_ref() -> &'static Sim {
    unsafe {
        (*SIM.0.get())
            .as_ref()
            .expect("mhd_init_flare must be called before any other entry point")
    }
}

/// Build the global `Sim`, install the Harris-sheet flare IC + η bump,
/// and lock in the recommended BCs (periodic-x, outflow-y). Returns 1 on
/// success, 0 on bad grid parameters. Safe to call repeatedly: each call
/// reinitialises the state.
#[no_mangle]
pub extern "C" fn mhd_init_flare(nx: u32, ny: u32, lx: f64, ly: f64) -> u32 {
    if nx < 8 || ny < 8 || !(lx > 0.0) || !(ly > 0.0) {
        return 0;
    }
    let mut grid = Grid::new(nx as usize, ny as usize, lx, ly);
    grid.x0 = -0.5 * lx;
    grid.y0 = -0.5 * ly;
    let mut sim = Sim::new(grid);
    sim.cfl = 0.3;
    let cfg = FlareConfig::default_yokoyama();
    install_harris_with_bump(&mut sim, &cfg);
    unsafe {
        *SIM.0.get() = Some(sim);
        *BCS.0.get() = cfg.bcs;
    }
    1
}

/// Advance the kernel by one full timestep. Returns the dt that was taken.
#[no_mangle]
pub extern "C" fn mhd_step() -> f64 {
    let bcs = unsafe { *BCS.0.get() };
    advance(sim_mut(), bcs)
}

/// Advance until `sim.t >= t_target`. Returns the number of sub-steps taken.
#[no_mangle]
pub extern "C" fn mhd_step_until(t_target: f64) -> u32 {
    let bcs = unsafe { *BCS.0.get() };
    let mut n = 0u32;
    while sim_ref().t < t_target {
        advance(sim_mut(), bcs);
        n += 1;
        if n >= 10_000 {
            break;
        }
    }
    n
}

// ── Layout / state info ─────────────────────────────────────────────────

#[no_mangle] pub extern "C" fn mhd_nx()        -> u32 { sim_ref().grid.nx as u32 }
#[no_mangle] pub extern "C" fn mhd_ny()        -> u32 { sim_ref().grid.ny as u32 }
#[no_mangle] pub extern "C" fn mhd_ng()        -> u32 { NG as u32 }
#[no_mangle] pub extern "C" fn mhd_stride_x()  -> u32 { sim_ref().grid.stride_x() as u32 }
#[no_mangle] pub extern "C" fn mhd_padded_len()-> u32 { sim_ref().grid.padded_len() as u32 }
#[no_mangle] pub extern "C" fn mhd_dx()        -> f64 { sim_ref().grid.dx }
#[no_mangle] pub extern "C" fn mhd_dy()        -> f64 { sim_ref().grid.dy }
#[no_mangle] pub extern "C" fn mhd_x0()        -> f64 { sim_ref().grid.x0 }
#[no_mangle] pub extern "C" fn mhd_y0()        -> f64 { sim_ref().grid.y0 }
#[no_mangle] pub extern "C" fn mhd_t()         -> f64 { sim_ref().t }

// ── Field pointers (all padded length) ──────────────────────────────────
//
// JS reads these as Float64Array views into wasm linear memory. After any
// call that could reallocate (mhd_init_flare), refresh the views.

#[no_mangle] pub extern "C" fn mhd_rho_ptr() -> u32 { sim_ref().state.u[var::RHO].as_ptr() as u32 }
#[no_mangle] pub extern "C" fn mhd_mx_ptr()  -> u32 { sim_ref().state.u[var::MX].as_ptr()  as u32 }
#[no_mangle] pub extern "C" fn mhd_my_ptr()  -> u32 { sim_ref().state.u[var::MY].as_ptr()  as u32 }
#[no_mangle] pub extern "C" fn mhd_mz_ptr()  -> u32 { sim_ref().state.u[var::MZ].as_ptr()  as u32 }
#[no_mangle] pub extern "C" fn mhd_bx_ptr()  -> u32 { sim_ref().state.u[var::BX].as_ptr()  as u32 }
#[no_mangle] pub extern "C" fn mhd_by_ptr()  -> u32 { sim_ref().state.u[var::BY].as_ptr()  as u32 }
#[no_mangle] pub extern "C" fn mhd_bz_ptr()  -> u32 { sim_ref().state.u[var::BZ].as_ptr()  as u32 }
#[no_mangle] pub extern "C" fn mhd_e_ptr()   -> u32 { sim_ref().state.u[var::E].as_ptr()   as u32 }

// ── Diagnostics ─────────────────────────────────────────────────────────

#[no_mangle] pub extern "C" fn mhd_peak_jz() -> f64 { peak_jz(sim_ref()) }
#[no_mangle] pub extern "C" fn mhd_peak_vy() -> f64 { peak_vy(sim_ref()) }
