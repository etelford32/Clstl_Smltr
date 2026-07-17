//! ring-current-kernel — the ring-current TRANSPORT core as a WASM module.
//!
//! A bounce-averaged phase-space-density model on an (L, MLT, energy, species)
//! grid: corotation + Volland–Stern convection E×B and gradient–curvature
//! drift, Schulz–Lanzerotti radial diffusion, species-resolved charge-exchange
//! loss, and a Kp-gated plasma-sheet source. The emergent Dst* (via
//! Dessler–Parker–Sckopke), per-species equatorial pressure/flux maps, and the
//! ENA emissivity source all fall out of the modeled distribution.
//!
//! Design contract (matches the rust-shielding / rust-gravity precedent):
//!   * No wasm-bindgen: plain `extern "C"` exports, loaded by
//!     js/ring-current-kernel.js with `WebAssembly.instantiate` (browser AND
//!     the Node oracle smoke test).
//!   * One global sim behind the C ABI; map buffers are f32 in a single
//!     `out_map` allocated once at construction and refilled in place, so WASM
//!     memory does not grow after init and JS TypedArray views stay valid.
//!   * Deterministic and seedless: same driver history → same state.
//!
//! This is a PORT of js/ring-current-transport.js, which remains the reference
//! oracle — tests/ring-current-kernel-smoke.mjs drives both and asserts they
//! agree. Native physics is gated by `cargo test` (physics.rs + transport.rs).

#![allow(static_mut_refs)]

pub mod physics;
pub mod transport;

use transport::Sim;

// Single-threaded WASM: one global sim instance behind the C ABI.
static mut SIM: Option<Box<Sim>> = None;

#[inline]
fn sim() -> &'static mut Sim {
    unsafe {
        if SIM.is_none() {
            SIM = Some(Box::new(Sim::new()));
        }
        SIM.as_mut().unwrap()
    }
}

/// (Re)initialize the simulation to an empty magnetosphere.
#[no_mangle]
pub extern "C" fn rc_init() {
    unsafe {
        SIM = Some(Box::new(Sim::new()));
    }
}

/// Set the live driver: geomagnetic Kp and dawn–dusk coupling VBs (mV/m).
#[no_mangle]
pub extern "C" fn rc_set_driver(kp: f64, vbs: f64) {
    sim().set_driver(kp, vbs);
}

/// Advance `dt_s` seconds of simulated time under the current driver.
#[no_mangle]
pub extern "C" fn rc_step(dt_s: f64) {
    sim().step(dt_s);
}

// ── Grid metadata ────────────────────────────────────────────────────────────

#[no_mangle]
pub extern "C" fn rc_nl() -> u32 {
    transport::NL as u32
}
#[no_mangle]
pub extern "C" fn rc_nmlt() -> u32 {
    transport::NMLT as u32
}
#[no_mangle]
pub extern "C" fn rc_ne() -> u32 {
    transport::NE as u32
}
#[no_mangle]
pub extern "C" fn rc_l_min() -> f64 {
    transport::LMIN
}
#[no_mangle]
pub extern "C" fn rc_l_max() -> f64 {
    transport::LMAX
}

// ── Scalar diagnostics ───────────────────────────────────────────────────────

#[no_mangle]
pub extern "C" fn rc_sim_time_s() -> f64 {
    sim().t_sec
}
#[no_mangle]
pub extern "C" fn rc_dst_star() -> f64 {
    sim().dst_star()
}
#[no_mangle]
pub extern "C" fn rc_energy_j() -> f64 {
    sim().energy_content_j()
}
#[no_mangle]
pub extern "C" fn rc_oxygen_fraction() -> f64 {
    sim().oxygen_fraction_val()
}
#[no_mangle]
pub extern "C" fn rc_peak_l() -> f64 {
    sim().asym().0
}
#[no_mangle]
pub extern "C" fn rc_asym_index() -> f64 {
    sim().asym().1
}
#[no_mangle]
pub extern "C" fn rc_peak_mlt() -> f64 {
    sim().asym().2
}

// ── Map buffers (f32, NL×NMLT row-major) ─────────────────────────────────────
// Each refills the shared out_map for the requested selection, then returns its
// pointer. species: 0=all, 1=H⁺, 2=O⁺, 3=He⁺. kind: 0=content, 1=energy.

#[no_mangle]
pub extern "C" fn rc_pressure_ptr(species: u32) -> *const f32 {
    let s = sim();
    s.fill_pressure(species);
    s.out_map.as_ptr()
}

#[no_mangle]
pub extern "C" fn rc_equatorial_ptr(species: u32, kind: u32) -> *const f32 {
    let s = sim();
    s.fill_equatorial(species, kind != 0);
    s.out_map.as_ptr()
}

#[no_mangle]
pub extern "C" fn rc_ena_ptr() -> *const f32 {
    let s = sim();
    s.fill_ena();
    s.out_map.as_ptr()
}

/// EMIC proton-precipitation rate map (content/s) — the proton-aurora source.
#[no_mangle]
pub extern "C" fn rc_precip_ptr() -> *const f32 {
    let s = sim();
    s.fill_precip();
    s.out_map.as_ptr()
}

/// Proton anisotropy map A = ΣMH/ΣC over EMIC-resonant channels.
#[no_mangle]
pub extern "C" fn rc_anisotropy_ptr() -> *const f32 {
    let s = sim();
    s.fill_anisotropy();
    s.out_map.as_ptr()
}
