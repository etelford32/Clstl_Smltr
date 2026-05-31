//! 1.5-layer shallow-water model of Jupiter's Great Red Spot.
//!
//! The Great Red Spot is a **hydrodynamic** vortex, not an MHD object: a
//! long-lived anticyclone in Jupiter's upper troposphere. The standard way
//! to model it (Marcus 1988; Dowling & Ingersoll 1989; Cho & Polvani 1996)
//! is the reduced-gravity ("1.5-layer") shallow-water system on a
//! beta-plane: one active weather layer of variable thickness `h` riding on
//! a deep, quiescent abyss. Seed an anticyclone between a retrograde jet on
//! its poleward flank and a prograde jet to its equator side — the measured
//! configuration at ~22°S — and it self-organises into a coherent, drifting
//! oval, while a cyclone of the same strength is shredded by the shear. That
//! asymmetry *is* the GRS.
//!
//! Numerics: Arakawa C-grid, Sadourny (1975) energy-conserving
//! vector-invariant advection, SSP-RK2 in time, biharmonic hyperviscosity,
//! periodic in longitude, walled+sponged in latitude. Zero external deps so
//! the kernel builds for `wasm32-unknown-unknown` in sandboxed CI.
//!
//! Validation (native `cargo test`): mass conservation, steady gradient-wind
//! balance, the inertial-oscillation frequency, and the anticyclone-survives
//! / cyclone-shreds signature.

pub mod grid;
pub mod init;
pub mod model;

use core::cell::UnsafeCell;

use grid::Grid;
use init::{balanced_h, seed_vortex, Vortex};
use model::{compute_rhs, vorticity_centres, Params, Work};

/// Full simulation state: geometry, parameters, prognostic fields, the
/// per-row background reference used by the forcing/sponge, and RK scratch.
pub struct Sim {
    pub g: Grid,
    pub p: Params,
    w: Work,

    pub h: Vec<f64>,
    pub u: Vec<f64>,
    pub v: Vec<f64>,

    /// Background jet (per centre row) and its balanced thickness.
    pub u_ref: Vec<f64>,
    pub h_ref: Vec<f64>,
    /// Relative vorticity at centres — refreshed by [`Sim::update_vort`].
    pub vort: Vec<f64>,

    // SSP-RK2 scratch
    h1: Vec<f64>, u1: Vec<f64>, v1: Vec<f64>,
    kh: Vec<f64>, ku: Vec<f64>, kv: Vec<f64>,
    kh2: Vec<f64>, ku2: Vec<f64>, kv2: Vec<f64>,

    pub t: f64,
    pub steps: u64,
    pub cfl: f64,
}

impl Sim {
    /// Construct with an explicit per-row jet `u_ref` (length `ny`). The
    /// background thickness is solved for discrete balance; the prognostic
    /// fields are initialised to that quiescent background.
    pub fn new(g: Grid, p: Params, u_ref: Vec<f64>) -> Self {
        assert_eq!(u_ref.len(), g.ny, "u_ref must have one value per centre row");
        let h_ref = balanced_h(&g, &p, &u_ref);
        let nc = g.nc();
        let nf = g.nf();
        let w = Work::new(&g);
        let mut s = Sim {
            g, p, w,
            h: vec![0.0; nc], u: vec![0.0; nc], v: vec![0.0; nf],
            u_ref, h_ref,
            vort: vec![0.0; nc],
            h1: vec![0.0; nc], u1: vec![0.0; nc], v1: vec![0.0; nf],
            kh: vec![0.0; nc], ku: vec![0.0; nc], kv: vec![0.0; nf],
            kh2: vec![0.0; nc], ku2: vec![0.0; nc], kv2: vec![0.0; nf],
            t: 0.0, steps: 0, cfl: 0.4,
        };
        s.reset_to_background();
        s
    }

    /// Reset the prognostic fields to the quiescent balanced background.
    pub fn reset_to_background(&mut self) {
        let (nx, ny) = (self.g.nx, self.g.ny);
        for j in 0..ny {
            for i in 0..nx {
                let c = self.g.c(i, j);
                self.h[c] = self.h_ref[j];
                self.u[c] = self.u_ref[j];
            }
        }
        for x in self.v.iter_mut() { *x = 0.0; }
        self.t = 0.0;
        self.steps = 0;
    }

    /// Recompute the balanced background from the current `u_ref` (used after
    /// the host writes a new jet profile through the C-ABI) and reset.
    pub fn rebalance(&mut self) {
        self.h_ref = balanced_h(&self.g, &self.p, &self.u_ref);
        self.reset_to_background();
    }

    /// Add a Gaussian vortex (anticyclone if `amp > 0`) onto the current
    /// fields, in geostrophic balance.
    pub fn seed(&mut self, vx: &Vortex) {
        seed_vortex(&self.g, &self.p, vx, &mut self.h, &mut self.u, &mut self.v);
    }

    /// CFL-limited stable step: gravity waves + advection + hyperviscosity +
    /// the sponge reaction rate.
    pub fn cfl_dt(&self) -> f64 {
        let dmin = self.g.dx.min(self.g.dy);
        let c = (self.p.gp * self.p.h0).sqrt();
        let mut umax = 0.0_f64;
        for &x in &self.u { umax = umax.max(x.abs()); }
        for &x in &self.v { umax = umax.max(x.abs()); }
        let mut dt = self.cfl * dmin / (c + umax + 1e-9);
        if self.p.nu4 > 0.0 {
            dt = dt.min(0.25 * dmin.powi(4) / (self.p.nu4 * 64.0));
        }
        if self.p.r_sponge > 0.0 {
            dt = dt.min(0.5 / self.p.r_sponge);
        }
        dt
    }

    /// One SSP-RK2 (Heun) step of size `dt`.
    pub fn substep(&mut self, dt: f64) {
        let nc = self.g.nc();
        let nf = self.g.nf();

        // stage 1: k1 = RHS(S);  S1 = S + dt·k1
        compute_rhs(&self.g, &self.p, &self.h, &self.u, &self.v, &mut self.w,
                    &mut self.kh, &mut self.ku, &mut self.kv, &self.u_ref, &self.h_ref);
        for c in 0..nc {
            self.h1[c] = self.h[c] + dt * self.kh[c];
            self.u1[c] = self.u[c] + dt * self.ku[c];
        }
        for f in 0..nf { self.v1[f] = self.v[f] + dt * self.kv[f]; }

        // stage 2: k2 = RHS(S1);  S = S + ½dt·(k1+k2)
        compute_rhs(&self.g, &self.p, &self.h1, &self.u1, &self.v1, &mut self.w,
                    &mut self.kh2, &mut self.ku2, &mut self.kv2, &self.u_ref, &self.h_ref);
        let hdt = 0.5 * dt;
        for c in 0..nc {
            self.h[c] += hdt * (self.kh[c] + self.kh2[c]);
            self.u[c] += hdt * (self.ku[c] + self.ku2[c]);
        }
        for f in 0..nf { self.v[f] += hdt * (self.kv[f] + self.kv2[f]); }

        self.t += dt;
        self.steps += 1;
    }

    /// Advance up to `dt_target`, sub-stepping at the CFL limit. Returns the
    /// number of sub-steps taken. Capped so a single host call can't stall.
    pub fn advance(&mut self, dt_target: f64) -> u32 {
        if !(dt_target > 0.0) { return 0; }
        let mut remaining = dt_target;
        let mut n = 0u32;
        while remaining > 0.0 && n < 4096 {
            let dt = self.cfl_dt().min(remaining);
            if !dt.is_finite() || dt <= 0.0 { break; }
            self.substep(dt);
            remaining -= dt;
            n += 1;
        }
        n
    }

    /// Refresh the centre-vorticity diagnostic from the current velocity.
    pub fn update_vort(&mut self) {
        vorticity_centres(&self.g, &self.u, &self.v, &mut self.vort);
    }

    /// Total mass ∑ h·dx·dy (conserved by the flux-form mass equation when
    /// forcing/sponge are off).
    pub fn total_mass(&self) -> f64 {
        let cell = self.g.dx * self.g.dy;
        self.h.iter().sum::<f64>() * cell
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Jupiter constants for the host-facing builder.
// ─────────────────────────────────────────────────────────────────────────────

/// Jupiter sidereal rotation rate (System III), rad/s.
pub const OMEGA_JUP: f64 = 1.758_5e-4;
/// Jupiter equatorial radius, m.
pub const R_JUP: f64 = 7.149_2e7;

/// Coriolis `f0` and `beta` for a beta-plane centred on `lat_deg`.
pub fn coriolis(lat_deg: f64) -> (f64, f64) {
    let lat = lat_deg.to_radians();
    let f0 = 2.0 * OMEGA_JUP * lat.sin();
    let beta = 2.0 * OMEGA_JUP * lat.cos() / R_JUP;
    (f0, beta)
}

// ─────────────────────────────────────────────────────────────────────────────
// C ABI — flat exports over a single global Sim slot (wasm32 is single-threaded).
// ─────────────────────────────────────────────────────────────────────────────

struct Slot(UnsafeCell<Option<Sim>>);
unsafe impl Sync for Slot {}
static SIM: Slot = Slot(UnsafeCell::new(None));

#[inline]
fn sim_mut() -> &'static mut Sim {
    unsafe {
        (*SIM.0.get())
            .as_mut()
            .expect("grs_configure must be called before any other entry point")
    }
}

/// Allocate the simulation. The jet starts at rest; the host then writes the
/// per-row jet profile through [`grs_jet_ptr`] and calls [`grs_reset`].
/// Returns 1 on success, 0 on invalid parameters.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn grs_configure(
    nx: u32, ny: u32,
    lx: f64, ly: f64,
    f0: f64, beta: f64,
    gp: f64, h0: f64,
    nu4: f64, tau_jet: f64, r_drag: f64,
    sponge_n: u32, r_sponge: f64,
) -> u32 {
    if nx < 8 || ny < 8 || lx <= 0.0 || ly <= 0.0 || gp <= 0.0 || h0 <= 0.0 {
        return 0;
    }
    let g = Grid::new(nx as usize, ny as usize, lx, ly, f0, beta);
    let p = Params {
        gp, h0, nu4, tau_jet, r_drag,
        sponge_n: sponge_n as usize, r_sponge,
    };
    let u_ref = vec![0.0; ny as usize];
    let sim = Sim::new(g, p, u_ref);
    unsafe { *SIM.0.get() = Some(sim); }
    1
}

/// Pointer to the per-row jet buffer `u_ref` (length = ny). The host writes
/// the measured jet (m/s) here, then calls [`grs_reset`].
#[no_mangle] pub extern "C" fn grs_jet_ptr() -> u32 { sim_mut().u_ref.as_ptr() as u32 }

/// Recompute the balanced background from `u_ref` and reset to quiescence.
#[no_mangle] pub extern "C" fn grs_reset() { sim_mut().rebalance(); }

/// Stamp a balanced Gaussian vortex (anticyclone if `amp > 0`).
#[no_mangle]
pub extern "C" fn grs_seed(x0: f64, y0: f64, amp: f64, rx: f64, ry: f64) {
    sim_mut().seed(&Vortex { x0, y0, amp, rx, ry });
}

/// Advance by up to `dt` seconds; returns sub-steps taken. Refreshes the
/// vorticity diagnostic so the host can read it immediately.
#[no_mangle]
pub extern "C" fn grs_step(dt: f64) -> u32 {
    let s = sim_mut();
    let n = s.advance(dt);
    s.update_vort();
    n
}

#[no_mangle] pub extern "C" fn grs_nx() -> u32 { sim_mut().g.nx as u32 }
#[no_mangle] pub extern "C" fn grs_ny() -> u32 { sim_mut().g.ny as u32 }
#[no_mangle] pub extern "C" fn grs_lx() -> f64 { sim_mut().g.lx }
#[no_mangle] pub extern "C" fn grs_ly() -> f64 { sim_mut().g.ly }
#[no_mangle] pub extern "C" fn grs_t()  -> f64 { sim_mut().t }
#[no_mangle] pub extern "C" fn grs_steps() -> u64 { sim_mut().steps }

#[no_mangle] pub extern "C" fn grs_h_ptr()    -> u32 { sim_mut().h.as_ptr() as u32 }
#[no_mangle] pub extern "C" fn grs_u_ptr()    -> u32 { sim_mut().u.as_ptr() as u32 }
#[no_mangle] pub extern "C" fn grs_v_ptr()    -> u32 { sim_mut().v.as_ptr() as u32 }
#[no_mangle] pub extern "C" fn grs_vort_ptr() -> u32 { sim_mut().vort.as_ptr() as u32 }

// ─────────────────────────────────────────────────────────────────────────────
// Native tests — exercise the kernel on x86_64 before shipping the wasm.
// ─────────────────────────────────────────────────────────────────────────────
#[cfg(test)]
mod tests {
    use super::*;

    /// A representative GRS-band setup: centred at 22°S, a channel a few
    /// vortex-widths wide, deformation radius ~1700 km.
    fn grs_params(nx: usize, ny: usize, tau_jet: f64, sponge: bool) -> (Grid, Params, Vec<f64>) {
        let lat0 = -22.0;
        let (f0, beta) = coriolis(lat0);
        let lx = 6.0e7;          // ~ longitudinal extent
        let ly = 3.0e7;          // ~ 28° of latitude
        let h0 = 5.0e3;          // 5 km active layer
        let ld = 1.7e6;          // deformation radius
        // L_d = √(g'H)/|f|  ⇒  g' = (L_d·f)² / H
        let gp = (ld * f0).powi(2) / h0;
        let g = Grid::new(nx, ny, lx, ly, f0, beta);
        // jet profile: prograde jet south of the spot, retrograde north —
        // a smooth double-jet straddling the channel centre.
        let mut u_ref = vec![0.0; ny];
        for j in 0..ny {
            let y = g.yc(j);
            let s = y / (0.18 * ly);
            u_ref[j] = -60.0 * s * (-s * s).exp();   // ±~30 m/s antisymmetric jets
        }
        // Biharmonic ν₄ must scale as Δx⁴ — fix it by a target grid-scale
        // damping time (~1.3 days) so it is meaningful at any resolution.
        let dmin = g.dx.min(g.dy);
        let nu4 = dmin.powi(4) / (1.3 * 86400.0);
        let p = Params {
            gp, h0,
            nu4,
            tau_jet,
            r_drag: 0.0,
            sponge_n: if sponge { ny / 8 } else { 0 },
            r_sponge: if sponge { 3.0e-5 } else { 0.0 },
        };
        (g, p, u_ref)
    }

    #[test]
    fn mass_is_conserved() {
        // Forcing + sponge off so the flux-form mass equation is exact.
        let (g, mut p, u_ref) = grs_params(64, 48, 0.0, false);
        p.nu4 = 0.0;
        let mut s = Sim::new(g, p, u_ref);
        s.seed(&Vortex { x0: 3.0e7, y0: 0.0, amp: 400.0, rx: 6.0e6, ry: 5.0e6 });
        let m0 = s.total_mass();
        for _ in 0..400 { let dt = s.cfl_dt(); s.substep(dt); }
        let m1 = s.total_mass();
        let rel = ((m1 - m0) / m0).abs();
        assert!(rel < 1e-10, "mass drift too large: {rel:e}");
        assert!(s.h.iter().all(|x| x.is_finite()), "non-finite h");
    }

    #[test]
    fn background_jet_stays_balanced() {
        // No vortex, no forcing/sponge: the balanced background should sit
        // nearly still — max|v| tiny compared to the ~30 m/s jets.
        let (g, p, u_ref) = grs_params(64, 64, 0.0, false);
        let mut s = Sim::new(g, p, u_ref);
        for _ in 0..600 { let dt = s.cfl_dt(); s.substep(dt); }
        let vmax = s.v.iter().fold(0.0_f64, |m, &x| m.max(x.abs()));
        let umax = s.u.iter().fold(0.0_f64, |m, &x| m.max(x.abs()));
        assert!(vmax < 1.0, "background not balanced: max|v| = {vmax:.3} m/s (umax {umax:.1})");
        assert!(s.v.iter().all(|x| x.is_finite()));
    }

    #[test]
    fn inertial_oscillation_frequency() {
        // f-plane, flat rest layer, uniform initial u0: the domain-mean
        // velocity must rotate at |f| with period 2π/|f|.
        let lat0 = -22.0;
        let (f0, _) = coriolis(lat0);
        let g = Grid::new(48, 48, 4.0e7, 4.0e7, f0, 0.0);   // beta = 0
        let h0 = 5.0e3;
        let gp = (1.7e6 * f0).powi(2) / h0;
        let p = Params { gp, h0, nu4: 0.0, tau_jet: 0.0, r_drag: 0.0, sponge_n: 0, r_sponge: 0.0 };
        let mut s = Sim::new(g, p, vec![0.0; 48]);
        let u0 = 5.0;
        for x in s.u.iter_mut() { *x = u0; }                // flat background already h=h0

        let period = 2.0 * std::f64::consts::PI / f0.abs();
        let target = 0.25 * period;                         // quarter turn
        let mut elapsed = 0.0;
        while elapsed < target {
            let dt = s.cfl_dt().min(target - elapsed);
            s.substep(dt);
            elapsed += dt;
        }
        let nc = s.g.nc() as f64;
        let ubar = s.u.iter().sum::<f64>() / nc;
        let vbar = s.v.iter().sum::<f64>() / s.v.len() as f64;
        // After a quarter inertial period u→0 and v→ -sign(f)·u0.
        let v_expected = -f0.signum() * u0;
        assert!(ubar.abs() < 0.15 * u0, "ubar should vanish at T/4: {ubar:.3}");
        assert!((vbar - v_expected).abs() < 0.20 * u0,
                "vbar {vbar:.3} ≠ expected {v_expected:.3}");
    }

    /// Peak of the *eddy* vorticity (zonal mean removed) coarse-grained over
    /// a vortex-scale box. This isolates the vortex from the jet band and
    /// rewards a coherent core: a compact oval survives the box average,
    /// whereas a strained vortex's filaments are small-scale and oscillate in
    /// sign, so they cancel under the average and the smoothed peak collapses.
    fn coherent_eddy_peak(g: &Grid, vort: &[f64], rx: f64, ry: f64) -> f64 {
        let (nx, ny) = (g.nx, g.ny);
        // eddy field = vorticity minus its zonal mean
        let mut eddy = vec![0.0; g.nc()];
        for j in 0..ny {
            let mut zbar = 0.0;
            for i in 0..nx { zbar += vort[g.c(i, j)]; }
            zbar /= nx as f64;
            for i in 0..nx { eddy[g.c(i, j)] = vort[g.c(i, j)] - zbar; }
        }
        let wx = ((rx / g.dx).round() as usize).max(1);
        let wy = ((ry / g.dy).round() as usize).max(1);
        let mut peak = 0.0_f64;
        for j in 0..ny {
            for i in 0..nx {
                let mut sum = 0.0;
                let mut cnt = 0.0;
                for dj in -(wy as isize)..=(wy as isize) {
                    let jj = j as isize + dj;
                    if jj < 0 || jj >= ny as isize { continue; }
                    for di in -(wx as isize)..=(wx as isize) {
                        let ii = ((i as isize + di).rem_euclid(nx as isize)) as usize;
                        sum += eddy[g.c(ii, jj as usize)];
                        cnt += 1.0;
                    }
                }
                peak = peak.max((sum / cnt).abs());
            }
        }
        peak
    }

    /// Eddy enstrophy ∑(ζ − ζ̄(y))² — the variance of the vorticity about
    /// its zonal mean, i.e. the part that belongs to the vortex, not the
    /// jets. A coherent vortex keeps it at large scales; a shredded one
    /// cascades it to the grid where hyperviscosity removes it.
    fn eddy_enstrophy(g: &Grid, vort: &[f64]) -> f64 {
        let (nx, ny) = (g.nx, g.ny);
        let mut e = 0.0;
        for j in 0..ny {
            let mut zbar = 0.0;
            for i in 0..nx { zbar += vort[g.c(i, j)]; }
            zbar /= nx as f64;
            for i in 0..nx {
                let d = vort[g.c(i, j)] - zbar;
                e += d * d;
            }
        }
        e
    }

    /// Fraction of the coherent vortex core retained after ~14 days.
    fn core_retention(amp: f64) -> f64 {
        let (g, p, u_ref) = grs_params(96, 80, 6.0 * 86400.0, true);
        let (lx, rx, ry) = (g.lx, 6.0e6, 5.0e6);
        let mut s = Sim::new(g, p, u_ref);
        s.seed(&Vortex { x0: 0.5 * lx, y0: 0.0, amp, rx, ry });
        s.update_vort();
        let p0 = coherent_eddy_peak(&s.g, &s.vort, rx, ry);
        let t_end = 14.0 * 86400.0;
        while s.t < t_end {
            let dt = s.cfl_dt().min(t_end - s.t);
            s.substep(dt);
        }
        s.update_vort();
        assert!(s.vort.iter().all(|z| z.is_finite()), "blew up at amp={amp}");
        coherent_eddy_peak(&s.g, &s.vort, rx, ry) / p0
    }

    #[test]
    #[ignore = "exploration: prints the asymmetry across vortex strengths"]
    fn explore_asymmetry() {
        for &a in &[600.0, 1000.0, 1600.0, 2400.0] {
            let anti = core_retention(a);
            let cyc = core_retention(-a);
            println!("amp={a:6.0}  core anti={anti:.3}  cyc={cyc:.3}  ratio={:.3}",
                     anti / cyc.max(1e-6));
        }
    }

    #[test]
    fn anticyclone_survives_cyclone_shreds() {
        // The GRS signature: seeded in the same anticyclonic ambient shear,
        // an anticyclone stays a coherent oval (retains its coarse-grained
        // core) while a cyclone of equal strength is strained into filaments
        // that cancel under coarse-graining.
        let anti = core_retention(1600.0);
        let cyc = core_retention(-1600.0);
        assert!(anti > 1.15 * cyc,
                "anticyclone should clearly out-survive cyclone: anti={anti:.3} cyc={cyc:.3}");
    }
}
