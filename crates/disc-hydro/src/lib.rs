//! disc-hydro
//! ==========
//! A 2-D log-polar FARGO kernel for protoplanetary-disc hydrodynamics,
//! compiled to a freestanding WebAssembly module. The eventual goal is a
//! 2.5-D / 3-D MHD solver running in a browser worker thread; this crate
//! is the proving-ground that establishes the toolchain end-to-end:
//!
//!   * Rust → wasm32-unknown-unknown, no external dependencies.
//!   * Flat `extern "C"` ABI for the host (JavaScript).
//!   * Linear memory exposed to JS for zero-copy reads of Σ, v_r, v_φ.
//!
//! State machine
//! -------------
//! `hydro_init(...)`  →  installs a fresh [`Sim`] in the global slot.
//! `hydro_step(dt)`   →  advances the disc by ≤ `dt` (FARGO sub-stepping).
//! `hydro_sigma_ptr()` / `hydro_vr_ptr()` / `hydro_vphi_ptr()` return raw
//! offsets into linear memory the host can read as `Float64Array`s.

#![allow(clippy::needless_range_loop)]

mod grid;
mod transport;
mod fargo;
mod source;

use core::cell::UnsafeCell;

use grid::Grid;
use source::Planet;

// ─────────────────────────────────────────────────────────────────────────────
// Global single-sim slot.
//
// `wasm32-unknown-unknown` is single-threaded by design, so a `static mut`
// wrapped behind an `UnsafeCell` is sound — there are no concurrent
// accessors. We don't use `OnceLock` because that would pull in std::sync.
// ─────────────────────────────────────────────────────────────────────────────
struct Slot(UnsafeCell<Option<Sim>>);
unsafe impl Sync for Slot {}
static SIM: Slot = Slot(UnsafeCell::new(None));

#[inline]
fn sim_mut() -> &'static mut Sim {
    unsafe {
        (*SIM.0.get()).as_mut().expect("hydro_init must be called before any other entry point")
    }
}

pub struct Sim {
    pub grid: Grid,
    pub sigma: Vec<f64>,
    pub vr:    Vec<f64>,
    pub vphi:  Vec<f64>,
    /// φ-averaged azimuthal velocity per radius — recomputed each step.
    vphi_bar:  Vec<f64>,
    /// Residual w_phi = v_phi - vphi_bar  (reused buffer).
    w_phi:     Vec<f64>,
    /// Frozen 1-D reference Σ profile for boundary damping.
    sigma_ref: Vec<f64>,
    /// Persistent PLM/LLF scratch arrays — keeps the inner loop alloc-free.
    pub(crate) scratch: TransportScratch,
    pub gm_star: f64,
    pub planets: Vec<Planet>,
    pub t: f64,
    pub steps: u64,
}

/// Per-call workspace for the PLM+LLF transport. Allocated once at
/// `Sim::new()` and reused on every substep so the hot loop never hits the
/// allocator. All arrays are sized for the (nr × nphi) grid except the
/// radial face fluxes, which need (nr + 1) × nphi.
pub(crate) struct TransportScratch {
    // Slopes (one per primitive per direction).
    pub sl_sig_r: Vec<f64>,  pub sl_sig_p: Vec<f64>,
    pub sl_vr_r:  Vec<f64>,  pub sl_vr_p:  Vec<f64>,
    pub sl_vp_r:  Vec<f64>,  pub sl_vp_p:  Vec<f64>,
    pub sl_wp_p:  Vec<f64>,
    // Radial face fluxes ((nr + 1) · nphi entries).
    pub fr_sig:   Vec<f64>,  pub fr_mr:    Vec<f64>,  pub fr_mp:    Vec<f64>,
    // Azimuthal face fluxes (n entries; stored at the "j-1/2" face of each cell).
    pub fp_sig:   Vec<f64>,  pub fp_mr:    Vec<f64>,  pub fp_mp:    Vec<f64>,
    // Updated conservatives.
    pub sig_new:  Vec<f64>,  pub mr_new:   Vec<f64>,  pub mp_new:   Vec<f64>,
}

impl TransportScratch {
    fn new(n: usize, n_face_r: usize) -> Self {
        let z = |k| vec![0.0_f64; k];
        Self {
            sl_sig_r: z(n), sl_sig_p: z(n),
            sl_vr_r:  z(n), sl_vr_p:  z(n),
            sl_vp_r:  z(n), sl_vp_p:  z(n),
            sl_wp_p:  z(n),
            fr_sig: z(n_face_r), fr_mr: z(n_face_r), fr_mp: z(n_face_r),
            fp_sig: z(n),        fp_mr: z(n),        fp_mp: z(n),
            sig_new: z(n), mr_new: z(n), mp_new: z(n),
        }
    }
}

impl Sim {
    fn new(nr: u32, nphi: u32, r_min: f64, r_max: f64,
           gm_star: f64, sigma0: f64, sigma_slope: f64,
           cs0: f64, cs_slope: f64) -> Self
    {
        let grid = Grid::new_log(nr as usize, nphi as usize, r_min, r_max,
                                 gm_star, cs0, cs_slope);
        let n = grid.n_cells();
        let mut sigma     = vec![0.0_f64; n];
        let mut vr        = vec![0.0_f64; n];
        let mut vphi      = vec![0.0_f64; n];
        let mut sigma_ref = vec![0.0_f64; grid.nr];

        // Power-law radial profile Σ(r) = Σ0·(r / r_min)^sigma_slope; perfect
        // Keplerian rotation (the *full* v_φ, not just residual — FARGO
        // takes care of separating it each step). Tiny azimuthal seed
        // perturbation breaks the symmetry so spiral wakes can form when a
        // planet is added later.
        for i in 0..grid.nr {
            let ratio = grid.r[i] / r_min;
            let sig0  = sigma0 * ratio.powf(sigma_slope);
            sigma_ref[i] = sig0;
            let v_k = (gm_star / grid.r[i]).sqrt();
            for j in 0..grid.nphi {
                let k = grid.idx(i, j);
                let phi = (j as f64 + 0.5) * grid.dphi;
                let bump = 1.0 + 1e-4 * (3.0 * phi).sin();
                sigma[k] = sig0 * bump;
                vphi[k]  = v_k;
                vr[k]    = 0.0;
            }
        }

        let scratch = TransportScratch::new(n, (grid.nr + 1) * grid.nphi);
        Self {
            vphi_bar:  vec![0.0; grid.nr],
            w_phi:     vec![0.0; n],
            sigma_ref,
            scratch,
            grid, sigma, vr, vphi,
            gm_star,
            planets: Vec::new(),
            t: 0.0,
            steps: 0,
        }
    }

    /// CFL across the residual flow + sound speed.
    fn cfl_dt(&self, cfl: f64) -> f64 {
        let mut dt_min = f64::INFINITY;
        for i in 0..self.grid.nr {
            let cs = self.grid.cs[i];
            let dr = self.grid.dr[i];
            let r_dphi = self.grid.r[i] * self.grid.dphi;
            for j in 0..self.grid.nphi {
                let k = self.grid.idx(i, j);
                let abs_vr = self.vr[k].abs();
                let abs_wp = self.w_phi[k].abs();
                let dt_r = dr / (abs_vr + cs + 1e-30);
                let dt_p = r_dphi / (abs_wp + cs + 1e-30);
                if dt_r < dt_min { dt_min = dt_r; }
                if dt_p < dt_min { dt_min = dt_p; }
            }
        }
        cfl * dt_min
    }

    fn substep(&mut self, dt: f64) {
        // 1. Refresh vphi_bar and residual.
        fargo::compute_vphi_bar(&self.grid, &self.vphi, &mut self.vphi_bar);
        for i in 0..self.grid.nr {
            let bar = self.vphi_bar[i];
            for j in 0..self.grid.nphi {
                let k = self.grid.idx(i, j);
                self.w_phi[k] = self.vphi[k] - bar;
            }
        }
        // 2. Source half-step (Strang-style splitting, but we collapse to
        //    a forward Euler full step at this proving-ground stage).
        source::apply_sources(&self.grid,
                              &mut self.sigma, &mut self.vr, &mut self.vphi,
                              self.gm_star, &self.planets, dt);
        // 3. Transport sub-step using residual w_phi (PLM + minmod + LLF).
        transport::advect(&self.grid,
                          &mut self.sigma, &mut self.vr, &mut self.vphi,
                          &self.w_phi, &mut self.scratch, dt);
        // 4. FARGO shift by vphi_bar·dt — large dt is fine here, that's the point.
        fargo::shift(&self.grid,
                     &mut self.sigma, &mut self.vr, &mut self.vphi,
                     &self.vphi_bar, dt);
        // 5. Wave-killing boundaries.
        source::damp_boundaries(&self.grid,
                                &mut self.sigma, &mut self.vr, &mut self.vphi,
                                &self.sigma_ref, dt);
        self.t += dt;
        self.steps += 1;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// C ABI
// ─────────────────────────────────────────────────────────────────────────────

/// Create a new simulation. Returns 1 on success, 0 on failure.
#[no_mangle]
pub extern "C" fn hydro_init(
    nr: u32, nphi: u32,
    r_min: f64, r_max: f64,
    gm_star: f64,
    sigma0: f64, sigma_slope: f64,
    cs0: f64, cs_slope: f64,
) -> u32 {
    if nr < 4 || nphi < 4 || r_max <= r_min || gm_star <= 0.0 {
        return 0;
    }
    let sim = Sim::new(nr, nphi, r_min, r_max,
                       gm_star, sigma0, sigma_slope, cs0, cs_slope);
    unsafe { *SIM.0.get() = Some(sim); }
    1
}

/// Advance the disc by *up to* `dt_target` simulated time units.
/// Returns the number of sub-steps actually taken (informational).
#[no_mangle]
pub extern "C" fn hydro_step(dt_target: f64) -> u32 {
    let s = sim_mut();
    if dt_target <= 0.0 { return 0; }

    let mut remaining = dt_target;
    let mut n = 0u32;
    // Soft cap to keep the JS thread responsive: ≤ 256 substeps per call.
    while remaining > 0.0 && n < 256 {
        let dt = s.cfl_dt(0.4).min(remaining);
        if !dt.is_finite() || dt <= 0.0 { break; }
        s.substep(dt);
        remaining -= dt;
        n += 1;
    }
    n
}

/// Place / replace a single planet (sufficient for the proving-ground demo).
#[no_mangle]
pub extern "C" fn hydro_set_planet(x: f64, y: f64, gm: f64, eps: f64) {
    let s = sim_mut();
    s.planets.clear();
    if gm > 0.0 {
        s.planets.push(Planet { x, y, gm, eps: eps.max(1e-6) });
    }
}

#[no_mangle] pub extern "C" fn hydro_nr()    -> u32 { sim_mut().grid.nr   as u32 }
#[no_mangle] pub extern "C" fn hydro_nphi()  -> u32 { sim_mut().grid.nphi as u32 }
#[no_mangle] pub extern "C" fn hydro_r_min() -> f64 { sim_mut().grid.r_min }
#[no_mangle] pub extern "C" fn hydro_r_max() -> f64 { sim_mut().grid.r_max }
#[no_mangle] pub extern "C" fn hydro_t()     -> f64 { sim_mut().t }
#[no_mangle] pub extern "C" fn hydro_steps() -> u64 { sim_mut().steps }

#[no_mangle] pub extern "C" fn hydro_sigma_ptr() -> u32 { sim_mut().sigma.as_ptr() as u32 }
#[no_mangle] pub extern "C" fn hydro_vr_ptr()    -> u32 { sim_mut().vr.as_ptr()    as u32 }
#[no_mangle] pub extern "C" fn hydro_vphi_ptr()  -> u32 { sim_mut().vphi.as_ptr()  as u32 }

/// Return a pointer to the cell-centre radii array (length = nr).
#[no_mangle] pub extern "C" fn hydro_r_centers_ptr() -> u32 { sim_mut().grid.r.as_ptr() as u32 }

// ─────────────────────────────────────────────────────────────────────────────
// Native-side tests — sanity-check the kernel on x86_64 before we ship it.
//
// Tests construct `Sim` directly instead of going through the global C-ABI
// slot. That keeps each test independent so cargo can run them in parallel
// without races on the `static mut SIM`.
// ─────────────────────────────────────────────────────────────────────────────
#[cfg(test)]
mod tests {
    use super::*;

    fn fresh_sim() -> Sim {
        // 64 × 64 disc from 0.5 to 5.0 length units, GM* = 1, Σ ∝ r^-1.
        Sim::new(64, 64, 0.5, 5.0, 1.0, 1.0, -1.0, 0.05, -0.25)
    }

    /// Drive the same CFL-bounded sub-stepping that hydro_step() does, but
    /// against an explicit Sim handle.
    fn run_for(s: &mut Sim, dt_target: f64, calls: usize) {
        for _ in 0..calls {
            let mut remaining = dt_target;
            for _ in 0..256 {
                if remaining <= 0.0 { break; }
                let dt = s.cfl_dt(0.4).min(remaining);
                if !dt.is_finite() || dt <= 0.0 { break; }
                s.substep(dt);
                remaining -= dt;
            }
        }
    }

    /// Sum Σ·dA over the *active* region (10 % strip at each radial edge
    /// excluded because of wave-killing damping there).
    fn active_mass(s: &Sim) -> f64 {
        let g = &s.grid;
        let n_skip = ((g.nr as f64) * 0.10).ceil() as usize;
        let mut m = 0.0;
        for i in n_skip..(g.nr - n_skip) {
            let area = g.r[i] * g.dr[i] * g.dphi;
            for j in 0..g.nphi {
                m += s.sigma[g.idx(i, j)] * area;
            }
        }
        m
    }

    /// Σ in the active region must drift by < 1 % over a 5-inner-orbit run
    /// at moderate resolution (96 × 96). This is the second-order PLM/LLF
    /// quality bar — donor-cell on the identical setup drifts > 50 %.
    /// Inner orbit at r = 0.5 is T = 2π·r^{3/2} ≈ 2.22 code-units.
    #[test]
    fn mass_conservation_under_one_percent_over_five_orbits() {
        let mut s = Sim::new(96, 96, 0.5, 5.0, 1.0, 1.0, -1.0, 0.05, -0.25);
        let m0 = active_mass(&s);
        // 60 calls × dt = 0.2 → t ≈ 12 ≈ 5.4 inner orbits.
        run_for(&mut s, 0.2, 60);
        let m1 = active_mass(&s);
        let drift = (m1 - m0) / m0;
        assert!(drift.abs() < 0.01,
                "Σ active-region mass drift {:+.4} ({:+.2} %) > 1 % bar",
                drift, drift * 100.0);
    }

    // Note: a formal Richardson "drift halves with doubled resolution" test
    // is deliberately omitted at this stage. Forward Euler in time + cell-
    // centred source coupling are still first-order, so the spatial 2nd-
    // order accuracy from PLM is masked by O(dt) error in long runs. RK2
    // time integration + flux-corrected source coupling are the next step.

    /// Proving-ground sanity checks: the kernel must run without producing
    /// NaN/Inf, Σ must stay strictly positive, and the radial velocity
    /// must not run away to super-sonic speeds inside the active region.
    #[test]
    fn kernel_remains_finite_and_bounded() {
        let mut s = fresh_sim();
        run_for(&mut s, 0.2, 50);
        let g = &s.grid;
        let n_skip = (g.nr as f64 * 0.06).ceil() as usize;
        let mut max_abs_vr = 0.0_f64;
        let mut min_sigma  = f64::INFINITY;
        for i in n_skip..(g.nr - n_skip) {
            for j in 0..g.nphi {
                let k = g.idx(i, j);
                assert!(s.sigma[k].is_finite() && s.vr[k].is_finite() && s.vphi[k].is_finite(),
                        "non-finite field at ({},{})", i, j);
                if s.sigma[k] < min_sigma { min_sigma = s.sigma[k]; }
                if s.vr[k].abs() > max_abs_vr { max_abs_vr = s.vr[k].abs(); }
            }
        }
        assert!(min_sigma > 0.0, "Σ went non-positive: min = {}", min_sigma);
        let cs_max = g.cs.iter().cloned().fold(0.0_f64, f64::max);
        assert!(max_abs_vr < 5.0 * cs_max,
                "radial flow {} exceeds 5·c_s,max = {}", max_abs_vr, 5.0 * cs_max);
    }

    /// A q = 10⁻³ planet on a r = 1.5 circular orbit must imprint a
    /// measurable spiral wake in Σ within a small fraction of an orbit.
    /// Sanity check that the planet-gravity source path works end-to-end.
    #[test]
    fn planet_imprints_spiral_wake() {
        let mut s = Sim::new(96, 192, 0.5, 5.0, 1.0, 1.0, -1.0, 0.05, -0.25);
        // Drop a planet at φ = 0, r = 1.5.
        s.planets.push(source::Planet { x: 1.5, y: 0.0, gm: 1e-3, eps: 0.045 });
        run_for(&mut s, 0.05, 60); // ≈ 1.4 inner orbits
        // Max azimuthal asymmetry over r ∈ [0.8, 2.5].
        let mut max_asym = 0.0_f64;
        for i in 0..s.grid.nr {
            if s.grid.r[i] < 0.8 || s.grid.r[i] > 2.5 { continue; }
            let mut mn = f64::INFINITY; let mut mx = 0.0_f64;
            for j in 0..s.grid.nphi {
                let v = s.sigma[s.grid.idx(i, j)];
                if v < mn { mn = v; } if v > mx { mx = v; }
            }
            let asym = (mx - mn) / (mx + mn);
            if asym > max_asym { max_asym = asym; }
        }
        assert!(max_asym > 0.02,
                "expected ≥ 2 % spiral-wake asymmetry, got {:.3}", max_asym);
    }
}
