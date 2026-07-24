//! shielding-kernel — the Shielding Lab's WASM physics core.
//!
//! Solves height-integrated ionospheric current continuity
//!
//! ```text
//! ∇⊥ · ( Σ · ∇⊥Φ ) = −J∥ · sin(I)
//! ```
//!
//! for the electrostatic potential Φ on a 100×96 magnetic-latitude/MLT
//! grid (MLAT 40–90°, Δ0.5° × Δ0.25 h), with Region-1/Region-2 FAC
//! driving, Moen–Brekke EUV + auroral-oval + subauroral-trough conductance,
//! a relaxation-ODE Region 2 (the shielding physics), and SAPS conductance
//! feedback. This is the same equation the SWMF IE component (Ridley
//! Ionosphere Model) solves — see SHIELDING_LAB_PLAN.md.
//!
//! Design contract (matches rust-gravity precedent):
//!   * No wasm-bindgen: plain `extern "C"` exports, loaded by
//!     js/shielding-lab/kernel.js with `WebAssembly.instantiate` (works in
//!     the browser AND in Node for the smoke test).
//!   * The solver runs in f64 internally; frames ship to JS as f32 arrays
//!     (plan §2.2). All buffers are allocated once at `shl_init` and never
//!     reallocated, so WASM memory does not grow after the first step and
//!     JS TypedArray views stay valid (kernel.js still re-views per frame
//!     defensively).
//!   * Deterministic and seedless: same control history → same frames.
//!
//! Physics correctness is gated by `cargo test` (tests/physics.rs — the
//! plan §2.4 suite: analytic Y₁¹ solution, current conservation,
//! superposition, dawn/dusk antisymmetry, CPCP calibration, shielding
//! dynamics, SAPS emergence, golden regression).

pub mod conductance;
pub mod diagnostics;
pub mod fac;
pub mod grid;
pub mod rcm;
pub mod solver;
pub mod state;

use state::Sim;

// Single-threaded WASM: one global sim instance behind the C ABI.
// (Native tests use `state::Sim` directly and never touch this.)
static mut SIM: Option<Box<Sim>> = None;

#[inline]
#[allow(static_mut_refs)]
fn sim() -> &'static mut Sim {
    unsafe {
        if SIM.is_none() {
            SIM = Some(Box::new(Sim::new()));
        }
        SIM.as_mut().unwrap()
    }
}

/// (Re)initialize the simulation to the default quiet steady state.
#[no_mangle]
pub extern "C" fn shl_init() {
    #[allow(static_mut_refs)]
    unsafe {
        SIM = Some(Box::new(Sim::new()));
    }
    // One step settles diagnostics/frames so views are valid immediately.
    sim().step(1.0);
}

/// Update the driving controls. `saps_on` is 0/1.
#[no_mangle]
pub extern "C" fn shl_set_controls(
    bz_nt: f64,
    by_nt: f64,
    vsw_kms: f64,
    n_cm3: f64,
    f107: f64,
    tau_s_min: f64,
    saps_on: u32,
) {
    let s = sim();
    s.controls.bz_nt = bz_nt.clamp(-60.0, 30.0);
    s.controls.by_nt = by_nt.clamp(-40.0, 40.0);
    s.controls.vsw_kms = vsw_kms.clamp(200.0, 1200.0);
    s.controls.n_cm3 = n_cm3.clamp(0.1, 100.0);
    s.controls.f107 = f107.clamp(60.0, 300.0);
    s.controls.tau_s_min = tau_s_min.clamp(2.0, 90.0);
    s.controls.saps_enabled = saps_on != 0;
}

/// Advance `substeps` × `dt_s` seconds of simulated time.
#[no_mangle]
pub extern "C" fn shl_step(dt_s: f64, substeps: u32) {
    let s = sim();
    for _ in 0..substeps.min(600) {
        s.step(dt_s.clamp(0.1, 60.0));
    }
}

/// Region-2 mode: 0 = parameterized relaxation (default), 1 = mini-RCM
/// drift physics (Phase 6). Switching to drift physics starts the ring
/// current from the current state's plasma-sheet boundary (≈1 h spin-up);
/// switching back leaves the parameterized R2 at its last ODE value.
#[no_mangle]
pub extern "C" fn shl_set_r2_mode(mode: u32) {
    sim().r2_mode = if mode == 1 {
        state::R2Mode::DriftPhysics
    } else {
        state::R2Mode::Relaxation
    };
}

// ── Grid metadata ───────────────────────────────────────────────────────

#[no_mangle]
pub extern "C" fn shl_nlat() -> u32 {
    grid::NLAT as u32
}

#[no_mangle]
pub extern "C" fn shl_nmlt() -> u32 {
    grid::NMLT as u32
}

#[no_mangle]
pub extern "C" fn shl_lat_min_deg() -> f64 {
    grid::LAT_MIN_DEG
}

#[no_mangle]
pub extern "C" fn shl_dlat_deg() -> f64 {
    grid::DLAT_DEG
}

// ── Frame buffers (f32, NLAT×NMLT row-major, i=0 equatorward) ───────────

#[no_mangle]
pub extern "C" fn shl_phi_ptr() -> *const f32 {
    sim().out_phi_kv.as_ptr()
}

#[no_mangle]
pub extern "C" fn shl_sigma_p_ptr() -> *const f32 {
    sim().out_sigma_p.as_ptr()
}

#[no_mangle]
pub extern "C" fn shl_emag_ptr() -> *const f32 {
    sim().out_emag_mvpm.as_ptr()
}

#[no_mangle]
pub extern "C" fn shl_v_east_ptr() -> *const f32 {
    sim().out_v_east.as_ptr()
}

#[no_mangle]
pub extern "C" fn shl_v_north_ptr() -> *const f32 {
    sim().out_v_north.as_ptr()
}

/// Westward-flow profile at 21 MLT (NLAT f32, m/s).
#[no_mangle]
pub extern "C" fn shl_saps_profile_ptr() -> *const f32 {
    sim().out_saps_profile.as_ptr()
}

/// Ring-current pressure (nPa, NLAT×NMLT) — zero unless drift-physics R2.
#[no_mangle]
pub extern "C" fn shl_pressure_ptr() -> *const f32 {
    sim().out_pressure.as_ptr()
}

// ── Scalar diagnostics ──────────────────────────────────────────────────

#[no_mangle]
pub extern "C" fn shl_cpcp_kv() -> f64 {
    sim().cpcp_v * 1e-3
}

/// Penetration E at the 40° MLAT boundary, noon sector (mV/m, eastward +).
#[no_mangle]
pub extern "C" fn shl_pen_e_mvpm() -> f64 {
    sim().pen_e_vpm * 1e3
}

/// Same readout from the R1-only (unshielded) solve.
#[no_mangle]
pub extern "C" fn shl_pen_e_unshielded_mvpm() -> f64 {
    sim().pen_e_unshielded_vpm * 1e3
}

#[no_mangle]
pub extern "C" fn shl_shielding_efficiency() -> f64 {
    sim().shielding_efficiency()
}

#[no_mangle]
pub extern "C" fn shl_saps_peak_ms() -> f64 {
    sim().saps.peak_ms
}

#[no_mangle]
pub extern "C" fn shl_saps_peak_lat_deg() -> f64 {
    sim().saps.peak_lat_deg
}

#[no_mangle]
pub extern "C" fn shl_saps_width_deg() -> f64 {
    sim().saps.width_deg
}

#[no_mangle]
pub extern "C" fn shl_r1_ma() -> f64 {
    sim().i_r1_ma
}

#[no_mangle]
pub extern "C" fn shl_r2_ma() -> f64 {
    sim().i_r2_ma
}

/// Region-2 equilibrium ratio α (I_R2_eq = α·I_R1, state.rs). Read-only:
/// exported so the page's live shielding-fraction S = I_R2/(α·I_R1) reads
/// the real constant instead of hardcoding a JS copy that could drift.
#[no_mangle]
pub extern "C" fn shl_r2_alpha() -> f64 {
    sim().alpha
}

#[no_mangle]
pub extern "C" fn shl_sim_time_s() -> f64 {
    sim().t_sim_s
}

#[no_mangle]
pub extern "C" fn shl_solver_iters() -> u32 {
    sim().last_iters as u32
}

#[no_mangle]
pub extern "C" fn shl_solver_residual() -> f64 {
    sim().last_residual
}
