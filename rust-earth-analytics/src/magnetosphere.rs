//! Magnetosphere analytics system — space weather physics computations.
//!
//! Implements the same physical models as magnetosphere-engine.js but in Rust
//! for better performance and to enable batch/parametric sweeps that would be
//! too expensive in JS (e.g., computing magnetopause topology over a range of
//! solar wind conditions for prediction).
//!
//! ## Models
//!   - Shue et al. (1998): magnetopause standoff distance & flaring
//!   - Farris & Russell (1994): bow shock standoff
//!   - Carpenter & Anderson (1992): plasmapause L-shell
//!   - O'Brien & McPherron (2002): ring current Dst
//!   - Emery et al. (1999): auroral Joule heating
//!   - IRI-2016 (simplified): ionospheric layer parameters

use std::f32::consts::PI;

const DEG: f32 = PI / 180.0;

// ── Component: IonosphereState ──────────────────────────────────────────────

#[derive(Clone, Default)]
pub struct IonosphereState {
    pub d_layer_abs: f32,    // dB at 10 MHz
    pub fo_e: f32,           // MHz
    pub fo_f2: f32,          // MHz
    pub hm_f2: f32,          // km
    pub tec: f32,            // TECU
    pub e_layer_norm: f32,   // 0–1
    pub f2_active: bool,
    pub blackout: bool,
}

// ── Component: MagnetosphereState ───────────────────────────────────────────

pub struct MagnetosphereState {
    // Magnetopause (Shue)
    pub r0: f32,
    pub alpha: f32,
    pub pdyn: f32,
    // Bow shock (Farris-Russell)
    pub r0_bs: f32,
    pub alpha_bs: f32,
    // Plasmapause
    pub lpp: f32,
    // Ring current
    pub dst: f32,
    // Joule heating
    pub joule_gw: f32,
    // Ionosphere
    pub iono: IonosphereState,
}

impl MagnetosphereState {
    pub fn new() -> Self {
        Self {
            r0: 10.0, alpha: 0.5, pdyn: 1.3,
            r0_bs: 13.0, alpha_bs: 0.42,
            lpp: 4.7, dst: -15.0, joule_gw: 1.0,
            iono: IonosphereState::default(),
        }
    }
}

// ── System: MagnetosphereSystem ─────────────────────────────────────────────

pub struct MagnetosphereSystem;

impl MagnetosphereSystem {
    /// Run all magnetosphere physics given current solar wind conditions.
    pub fn update(
        state: &mut MagnetosphereState,
        n: f32, v: f32, bz: f32, kp: f32,
        f107: f32, xray: f32, sza_deg: f32,
    ) {
        // 1. Magnetopause (Shue 1998)
        let pdyn = 1.67e-6 * n * v * v;
        let pdyn_safe = pdyn.max(0.05);

        state.pdyn = pdyn;
        state.r0 = ((10.22 + 1.29 * (0.184 * (bz + 8.14)).tanh())
            * pdyn_safe.powf(-1.0 / 6.6))
            .max(3.5);
        state.alpha = ((0.58 - 0.007 * bz)
            * (1.0 + 0.024 * pdyn_safe.ln()))
            .max(0.30);

        // 2. Bow shock (Farris & Russell 1994)
        state.r0_bs = (state.r0 * 1.14 + 1.0).max(state.r0 + 1.5);
        state.alpha_bs = (state.alpha - 0.08).max(0.30);

        // 3. Plasmapause (Carpenter & Anderson 1992)
        state.lpp = (5.6 - 0.46 * kp).clamp(1.8, 6.5);

        // 4. Ring current Dst (O'Brien & McPherron 2002)
        let v_bs = v * (-bz).max(0.0) * 1e-3; // mV/m dawn-dusk E-field
        let q = if v_bs > 0.49 { -4.4 * (v_bs - 0.49) } else { 0.0 };
        let tau = 7.0; // hours recovery time
        let dst_inj = q * tau;
        let dst_pdyn = -7.26 * pdyn_safe.max(0.1).sqrt();
        state.dst = (dst_inj + dst_pdyn).clamp(-600.0, 30.0);

        // 5. Joule heating (Emery 1999)
        state.joule_gw = (0.15 * kp * kp + 0.4 * kp).max(0.5);

        // 6. Ionosphere (simplified IRI-2016)
        state.iono = Self::compute_ionosphere(f107, kp, xray, sza_deg);
    }

    fn compute_ionosphere(f107: f32, kp: f32, xray: f32, sza_deg: f32) -> IonosphereState {
        let cos_z = (sza_deg * DEG).cos().max(0.0);
        let day_fac = cos_z;
        let f107n = (f107 - 65.0) / 235.0;

        // D layer
        let flux_ref = 1e-5_f32;
        let xray_ratio = (xray.max(0.0) / flux_ref).sqrt();
        let d_layer_abs = (day_fac * xray_ratio * 18.0).max(0.0);
        let blackout = d_layer_abs > 10.0;

        // E layer
        let fo_e = if day_fac > 0.01 {
            0.9 * (1.0 + 0.006 * f107) * cos_z.powf(0.25)
        } else {
            0.5
        };

        // F2 layer
        let fo_f2_quiet = 4.0 + 0.035 * f107 * (0.3 + 0.7 * day_fac);
        let storm_delta = if kp > 4.0 { -(kp - 4.0) * 0.7 } else { 0.0 };
        let fo_f2 = (fo_f2_quiet + storm_delta).max(1.5);

        let hm_f2 = 290.0 - 0.02 * f107 + kp * 8.0;

        // TEC
        let tec = ((10.0 + 0.4 * f107)
            * cos_z.max(0.01).powf(0.6)
            * (1.0 - 0.08 * kp).max(0.1))
            .max(2.0);

        IonosphereState {
            d_layer_abs,
            fo_e: fo_e.max(0.0),
            fo_f2,
            hm_f2,
            tec,
            e_layer_norm: (day_fac * (1.0 + f107n * 0.5)).min(1.0),
            f2_active: fo_f2 > 6.0,
            blackout,
        }
    }

    /// Generate a parametric surface for the Shue-model geometry.
    /// Returns flat [x,y,z, ...] vertices.
    ///
    /// The Shue model: r(θ) = r0 × (2 / (1 + cos θ))^α
    /// where θ is the angle from the subsolar point.
    pub fn generate_surface(r0: f32, alpha: f32, n_theta: u32, n_phi: u32) -> Vec<f32> {
        let mut verts = Vec::with_capacity((n_theta * n_phi * 3) as usize);

        for i in 0..n_theta {
            let theta = (i as f32 / (n_theta - 1) as f32) * PI; // 0 → π

            // Shue standoff distance at this angle
            let denom = (1.0 + theta.cos()).max(0.001);
            let r = r0 * (2.0 / denom).powf(alpha);

            for j in 0..n_phi {
                let phi = (j as f32 / n_phi as f32) * 2.0 * PI; // 0 → 2π

                // Convert spherical to Cartesian
                // In solar-wind-aligned coords: X points sunward
                let x = r * theta.cos();
                let y = r * theta.sin() * phi.cos();
                let z = r * theta.sin() * phi.sin();

                verts.push(x);
                verts.push(y);
                verts.push(z);
            }
        }

        verts
    }

    /// Batch parametric sweep: compute magnetopause standoff r0 over a grid of
    /// (n, v, bz) conditions.  Useful for prediction/sensitivity analysis.
    /// Returns flat array of r0 values.
    pub fn parametric_sweep(
        n_vals: &[f32], v_vals: &[f32], bz_vals: &[f32],
    ) -> Vec<f32> {
        let total = n_vals.len() * v_vals.len() * bz_vals.len();
        let mut results = Vec::with_capacity(total);

        for &n in n_vals {
            for &v in v_vals {
                for &bz in bz_vals {
                    let pdyn = (1.67e-6 * n * v * v).max(0.05);
                    let r0 = ((10.22 + 1.29 * (0.184 * (bz + 8.14)).tanh())
                        * pdyn.powf(-1.0 / 6.6))
                        .max(3.5);
                    results.push(r0);
                }
            }
        }

        results
    }
}

// ── WASM-bindgen standalone exports ─────────────────────────────────────────

use wasm_bindgen::prelude::*;
use js_sys::Float32Array;

/// Standalone Shue model computation (no world needed).
/// Returns [r0, alpha, pdyn].
#[wasm_bindgen(js_name = "computeShueWasm")]
pub fn compute_shue_wasm(n: f32, v: f32, bz: f32) -> Float32Array {
    let pdyn = (1.67e-6 * n * v * v).max(0.05);
    let r0 = ((10.22 + 1.29 * (0.184 * (bz + 8.14)).tanh())
        * pdyn.powf(-1.0 / 6.6))
        .max(3.5);
    let alpha = ((0.58 - 0.007 * bz) * (1.0 + 0.024 * pdyn.ln())).max(0.30);
    let arr = [r0, alpha, pdyn];
    unsafe { Float32Array::view(&arr) }
}

/// Standalone geostrophic wind estimate.
#[wasm_bindgen(js_name = "geoWindMsWasm")]
pub fn geo_wind_ms_wasm(grad_hpa_100km: f32, lat_deg: f32) -> f32 {
    let f = 2.0 * 7.2921e-5 * (lat_deg * DEG).sin().abs();
    if f < 1.4e-5 { return -1.0; } // sentinel for "invalid near equator"
    let grad_pa_m = grad_hpa_100km * 1e-3;
    grad_pa_m / (f * 1.225)
}

/// Batch magnetopause sweep — compute r0 for a grid of conditions.
/// n_vals, v_vals, bz_vals are flat Float32Arrays.
/// Returns flat Float32Array of r0 values (n × v × bz).
#[wasm_bindgen(js_name = "magnetopauseSweep")]
pub fn magnetopause_sweep(n_vals: &[f32], v_vals: &[f32], bz_vals: &[f32]) -> Float32Array {
    let results = MagnetosphereSystem::parametric_sweep(n_vals, v_vals, bz_vals);
    unsafe { Float32Array::view(&results) }
}
