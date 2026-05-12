//! NRLMSISE-00 — Rust FFI + wasm-bindgen exports.
//!
//! Wraps Brodowski's C port of the NRL Mass Spectrometer / Incoherent
//! Scatter (2000-revision) atmosphere model. Provides:
//!
//!   • Safe Rust API (`density_point`, `density_profile`)
//!   • `extern "C"` shims for the eight libm functions the C source uses
//!     (exp, log, log10, sqrt, pow, sin, cos, fabs) — so the wasm32-
//!     unknown-unknown build resolves them at link time without libc.
//!   • wasm-bindgen exports (`nrlmsise00_density_point`,
//!     `nrlmsise00_density_profile`) that JS can call directly.
//!
//! Inputs/outputs follow the NRLMSISE-00 reference exactly:
//!
//!   Input:
//!     year (currently ignored), doy (1..366), sec (UT seconds in day),
//!     alt_km, lat_deg, lon_deg, lst_hr (local apparent solar time),
//!     f107a (81-day F10.7 average centred on doy),
//!     f107  (previous day's F10.7),
//!     ap_array[7] — daily Ap + 6 lagged 3-hour Ap windows.
//!   Output:
//!     d[0..9] — He, O, N2, O2, Ar, total mass (kg/m³), H, N, anom O
//!     t[0..2] — exospheric temp, temp at altitude
//!
//! Switch 0 is forced ON, which puts densities into m⁻³ and total mass
//! into kg/m³ (matching the rest of our Rust/WASM stack). Switches 1-23
//! are all enabled. Switch 9 is set to -1 so the C code reads our 7-
//! element ap_array (proper geomagnetic-history weighting) rather than
//! the scalar daily Ap fallback.

use wasm_bindgen::prelude::*;

// ── FFI structs (must match nrlmsise-00.h byte-for-byte) ─────────────────

#[repr(C)]
struct NrlMsiseFlags {
    switches: [i32; 24],
    sw:       [f64; 24],
    swc:      [f64; 24],
}

#[repr(C)]
struct ApArray {
    a: [f64; 7],
}

#[repr(C)]
struct NrlMsiseInput {
    year:   i32,
    doy:    i32,
    sec:    f64,
    alt:    f64,
    g_lat:  f64,
    g_long: f64,
    lst:    f64,
    f107a:  f64,
    f107:   f64,
    ap:     f64,
    ap_a:   *mut ApArray,
}

#[repr(C)]
struct NrlMsiseOutput {
    d: [f64; 9],
    t: [f64; 2],
}

extern "C" {
    /// Effective Total Mass Density mode — d[5] includes anomalous oxygen,
    /// which matters for drag above ~500 km. Always our entry point: it's
    /// what users mean by "atmospheric density for satellite drag".
    fn gtd7d(input: *mut NrlMsiseInput,
             flags: *mut NrlMsiseFlags,
             output: *mut NrlMsiseOutput);
}

// ── libm symbol shims ───────────────────────────────────────────────────
//
// The vendored C calls into <math.h>. On wasm32-unknown-unknown there's
// no libc/libm, so the linker fails unless we provide these symbols.
// Each one forwards to the pure-Rust `libm` crate, which is identical
// in behaviour to glibc's libm to within the last ULP.

#[no_mangle] pub extern "C" fn exp   (x: f64)         -> f64 { libm::exp  (x)    }
#[no_mangle] pub extern "C" fn log   (x: f64)         -> f64 { libm::log  (x)    }
#[no_mangle] pub extern "C" fn log10 (x: f64)         -> f64 { libm::log10(x)    }
#[no_mangle] pub extern "C" fn sqrt  (x: f64)         -> f64 { libm::sqrt (x)    }
#[no_mangle] pub extern "C" fn pow   (x: f64, y: f64) -> f64 { libm::pow  (x, y) }
#[no_mangle] pub extern "C" fn sin   (x: f64)         -> f64 { libm::sin  (x)    }
#[no_mangle] pub extern "C" fn cos   (x: f64)         -> f64 { libm::cos  (x)    }
#[no_mangle] pub extern "C" fn fabs  (x: f64)         -> f64 { libm::fabs (x)    }

// ── Safe Rust wrapper ────────────────────────────────────────────────────

/// Evaluate NRLMSISE-00 at one point. Returns the canonical 11-element
/// vector matching the C `output` struct, in m⁻³ / K:
///
///   [0] He    [1] O     [2] N2    [3] O2    [4] Ar
///   [5] total mass density (kg/m³, INCLUDES anomalous O)
///   [6] H     [7] N     [8] anomalous O
///   [9] T_exo (K)        [10] T(alt) (K)
pub fn density_point(
    year: i32, doy: i32, sec: f64,
    alt_km: f64, lat_deg: f64, lon_deg: f64, lst_hr: f64,
    f107a: f64, f107: f64,
    ap_history: &[f64; 7],
) -> [f64; 11] {
    // Build the flags once. switches[0] = 1 → SI output. Switch 9 = -1
    // tells the model to read ap_a (the 7-element geomagnetic history)
    // rather than the scalar `ap`. All other switches default to 1.
    let mut flags = NrlMsiseFlags {
        switches: {
            let mut s = [1_i32; 24];
            s[0] = 1;
            s[9] = -1;
            s
        },
        sw:  [0.0; 24],
        swc: [0.0; 24],
    };

    let mut ap_a = ApArray { a: *ap_history };
    let mut input = NrlMsiseInput {
        year, doy, sec,
        alt: alt_km,
        g_lat:  lat_deg,
        g_long: lon_deg,
        lst:    lst_hr,
        f107a, f107,
        ap:     ap_history[0],
        ap_a:   &mut ap_a as *mut ApArray,
    };
    let mut output = NrlMsiseOutput { d: [0.0; 9], t: [0.0; 2] };

    // SAFETY: input/flags/output are owned, properly aligned, and
    // out-live the call. ap_a is borrowed live for the duration.
    unsafe {
        gtd7d(&mut input as *mut _,
              &mut flags as *mut _,
              &mut output as *mut _);
    }

    [
        output.d[0], output.d[1], output.d[2], output.d[3], output.d[4],
        output.d[5],
        output.d[6], output.d[7], output.d[8],
        output.t[0], output.t[1],
    ]
}

// ── wasm-bindgen exports ─────────────────────────────────────────────────

/// JS-callable: one altitude point. Returns the 11-element array above.
#[wasm_bindgen]
pub fn nrlmsise00_density_point(
    year: i32, doy: i32, sec: f64,
    alt_km: f64, lat_deg: f64, lon_deg: f64, lst_hr: f64,
    f107a: f64, f107: f64,
    ap_history: &[f64],
) -> Vec<f64> {
    let mut ap = [4.0_f64; 7];
    for (i, v) in ap_history.iter().take(7).enumerate() { ap[i] = *v; }
    density_point(year, doy, sec, alt_km, lat_deg, lon_deg, lst_hr,
                  f107a, f107, &ap).to_vec()
}

/// JS-callable: an altitude profile at fixed (lat, lon, time, forcing).
///
/// Returns a flat Float64 array stride-12, where each row is:
///
///   [alt_km, He, O, N2, O2, Ar, mass_kg_m3, H, N, anom_O, T_exo, T_alt]
///
/// This is the operator-grade replacement for the JS `sampleProfile()`
/// fallback. One WASM call covers the whole drag-decay altitude grid
/// (~50 points), avoiding 50 individual JS↔WASM round-trips.
#[wasm_bindgen]
pub fn nrlmsise00_density_profile(
    year: i32, doy: i32, sec: f64,
    lat_deg: f64, lon_deg: f64, lst_hr: f64,
    f107a: f64, f107: f64,
    ap_history: &[f64],
    alt_grid_km: &[f64],
) -> Vec<f64> {
    const STRIDE: usize = 12;
    let n = alt_grid_km.len();
    let mut out = Vec::with_capacity(n * STRIDE);
    let mut ap = [4.0_f64; 7];
    for (i, v) in ap_history.iter().take(7).enumerate() { ap[i] = *v; }

    for &alt in alt_grid_km {
        let p = density_point(year, doy, sec, alt, lat_deg, lon_deg, lst_hr,
                              f107a, f107, &ap);
        out.push(alt);
        out.extend_from_slice(&p);
    }
    out
}

/// Stride of the flat profile array — JS reads this once at boot to
/// avoid hard-coding 12 in two places.
#[wasm_bindgen]
pub fn nrlmsise00_profile_stride() -> usize { 12 }
