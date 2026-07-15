//! Time integration and the full per-step pipeline (plan §2.3):
//!
//!   1. read controls (Bz, By, vsw, n, F10.7, τ_s)
//!   2. R1 amplitude instantaneous from the coupling function;
//!      R2 relaxes toward α·I_R1 with time constant τ_s — THE shielding ODE:
//!          dI_R2/dt = (α·I_R1 − I_R2)/τ_s        (exact exponential update)
//!      undershielding after southward turnings, overshielding after
//!      northward turnings, and steady-state shielding all fall out of it.
//!   3. rebuild conductance (EUV + oval + trough + SAPS depletion)
//!   4. assemble & solve for Φ (warm-started BiCGSTAB)
//!   5. SAPS feedback: where |E| exceeds the heating threshold inside the
//!      trough band, relax the persistent depletion multiplier toward
//!      E_th/|E| (τ ≈ 5 min: frictional heating → recombination), floored
//!      (conductance.rs). Applied to the NEXT step's solve — time-honest
//!      sharpening across steps, and one solve per step instead of two
//!      (a 10 s application lag on a 300 s relaxation is invisible).
//!   6. an R1-only solve (same operator, R2-free source; linearity makes
//!      this exact) gives the unshielded penetration E → shielding
//!      efficiency = 1 − E_pen/E_unshielded. Refreshed once per sim minute
//!      (UNSHIELDED_EVERY) — it feeds a slow reference readout.
//!   7. diagnostics + f32 frame buffers for zero-copy JS rendering.

use crate::conductance::{self, CondParams, SAPS_DEPLETION_FLOOR};
use crate::diagnostics::{self, Fields, SapsSummary};
use crate::fac::{self, FacParams};
use crate::grid::{idx, Grid, N, NLAT, NMLT};
use crate::rcm::Rcm;
use crate::solver::{self, Operator, Workspace};

/// How Region 2 is produced (plan Phase 6).
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum R2Mode {
    /// Parameterized: mirror-image sheets whose amplitude relaxes toward
    /// α·I_R1 with time constant τ_s. Morphology imposed, timing emergent.
    Relaxation,
    /// mini-RCM drift physics (rcm.rs): proton channels drift in the
    /// solved E-field; R2 is the Vasyliunas current of the partial ring
    /// current. Morphology AND timing emergent; τ_s slider inert.
    DriftPhysics,
}

/// SAPS frictional-heating threshold (V/m): ~30 mV/m.
pub const SAPS_E_THRESHOLD: f64 = 0.030;
/// Depletion relaxation time constant (s): heating → recombination.
pub const SAPS_TAU_S: f64 = 300.0;

/// Production solver tolerance. The correctness tests drive the solver to
/// 1e-11 directly; the interactive loop doesn't need that — 1e-6 changes
/// CPCP in the 4th digit and sharply cuts warm-start iteration counts
/// (this is the WASM hot path at interactive rates).
pub const PROD_TOL: f64 = 1e-6;
pub const PROD_MAX_ITER: usize = 400;
/// The R1-only (unshielded) reference solve feeds a slow readout — run it
/// once per sim minute, not every 10 s step.
pub const UNSHIELDED_EVERY: u64 = 6;

#[derive(Clone, Copy)]
pub struct Controls {
    pub bz_nt: f64,
    pub by_nt: f64,
    pub vsw_kms: f64,
    pub n_cm3: f64,
    pub f107: f64,
    /// Shielding time constant (minutes), user slider 5–60.
    pub tau_s_min: f64,
    pub saps_enabled: bool,
}

impl Default for Controls {
    fn default() -> Self {
        Controls {
            bz_nt: -2.0,
            by_nt: 0.0,
            vsw_kms: 400.0,
            n_cm3: 5.0,
            f107: 120.0,
            tau_s_min: 25.0,
            saps_enabled: true,
        }
    }
}

pub struct Sim {
    pub grid: Grid,
    pub cond: CondParams,
    pub facp: FacParams,
    pub controls: Controls,
    /// R2/R1 equilibrium ratio α.
    pub alpha: f64,
    pub r2_mode: R2Mode,
    pub rcm: Rcm,

    pub t_sim_s: f64,
    pub i_r1_ma: f64,
    pub i_r2_ma: f64,

    pub sigma_p: Vec<f64>,
    pub sigma_h: Vec<f64>,
    pub saps_depletion: Vec<f64>,
    pub jpar: Vec<f64>,
    pub jpar_r1: Vec<f64>,
    pub phi: Vec<f64>,
    pub phi_r1: Vec<f64>,
    pub phi_b: [f64; NMLT],
    pub fields: Fields,
    fields_r1: Fields,
    ws: Workspace,
    b: Vec<f64>,
    b_r1: Vec<f64>,

    // Diagnostics of the last step.
    pub cpcp_v: f64,
    pub pen_e_vpm: f64,
    pub pen_e_unshielded_vpm: f64,
    pub saps: SapsSummary,
    pub saps_profile: Vec<f64>,
    pub last_iters: usize,
    step_count: u64,
    pub last_residual: f64,

    // f32 frame buffers (stable addresses for JS views; see lib.rs).
    pub out_phi_kv: Vec<f32>,
    pub out_sigma_p: Vec<f32>,
    pub out_emag_mvpm: Vec<f32>,
    pub out_v_east: Vec<f32>,
    pub out_v_north: Vec<f32>,
    pub out_saps_profile: Vec<f32>,
    /// Ring-current pressure (nPa) — nonzero only in DriftPhysics mode.
    pub out_pressure: Vec<f32>,
}

impl Sim {
    pub fn new() -> Self {
        let controls = Controls::default();
        let grid = Grid::new();
        let rcm = Rcm::new(&grid);
        let mut sim = Sim {
            grid,
            cond: CondParams::default(),
            facp: FacParams::default(),
            controls,
            alpha: 0.8,
            r2_mode: R2Mode::Relaxation,
            rcm,
            t_sim_s: 0.0,
            i_r1_ma: 0.0,
            i_r2_ma: 0.0,
            sigma_p: vec![0.0; N],
            sigma_h: vec![0.0; N],
            saps_depletion: vec![1.0; N],
            jpar: vec![0.0; N],
            jpar_r1: vec![0.0; N],
            phi: vec![0.0; N],
            phi_r1: vec![0.0; N],
            phi_b: [0.0; NMLT],
            fields: Fields::new(),
            fields_r1: Fields::new(),
            ws: Workspace::new(),
            b: vec![0.0; N],
            b_r1: vec![0.0; N],
            cpcp_v: 0.0,
            pen_e_vpm: 0.0,
            pen_e_unshielded_vpm: 0.0,
            saps: SapsSummary { peak_ms: 0.0, peak_lat_deg: 0.0, width_deg: 0.0 },
            saps_profile: vec![0.0; NLAT],
            last_iters: 0,
            step_count: 0,
            last_residual: 0.0,
            out_phi_kv: vec![0.0; N],
            out_sigma_p: vec![0.0; N],
            out_emag_mvpm: vec![0.0; N],
            out_v_east: vec![0.0; N],
            out_v_north: vec![0.0; N],
            out_saps_profile: vec![0.0; NLAT],
            out_pressure: vec![0.0; N],
        };
        // Start in equilibrium at the default (quiet) driving so the first
        // frame is already a sensible steady state.
        let e_kl = fac::kan_lee_mvpm(controls.bz_nt, controls.by_nt, controls.vsw_kms);
        sim.i_r1_ma = fac::r1_current_ma(e_kl);
        sim.i_r2_ma = sim.alpha * sim.i_r1_ma;
        sim
    }

    /// Equatorward shift (deg, ≤0) of oval/FAC/trough latitudes with solar
    /// wind dynamic pressure — the density control's honest, modest role
    /// (magnetopause compression proxy). Quiet 2 nPa → 0; 10 nPa → ≈ −1°.
    fn lat_shift_deg(&self) -> f64 {
        let c = &self.controls;
        let p_dyn_npa = 1.6726e-6 * c.n_cm3 * c.vsw_kms * c.vsw_kms;
        -3.0 * ((p_dyn_npa.max(0.1) / 2.0).powf(1.0 / 6.0) - 1.0).max(0.0)
    }

    /// Advance one step of `dt_s` seconds of simulated time.
    pub fn step(&mut self, dt_s: f64) {
        let c = self.controls;
        // (1–2) Driving.
        let e_kl = fac::kan_lee_mvpm(c.bz_nt, c.by_nt, c.vsw_kms);
        self.i_r1_ma = fac::r1_current_ma(e_kl);
        match self.r2_mode {
            R2Mode::Relaxation => {
                let tau = (c.tau_s_min * 60.0).max(1.0);
                let eq = self.alpha * self.i_r1_ma;
                self.i_r2_ma += (eq - self.i_r2_ma) * (1.0 - (-dt_s / tau).exp());
            }
            R2Mode::DriftPhysics => {
                // Drift the ring current in the PREVIOUS step's solved
                // potential (one-step lag, same convention as the SAPS
                // feedback), then read the emergent R2 off the Vasyliunas
                // current. τ_s is inert here — timing comes from drifts.
                self.rcm
                    .step(&self.grid, &self.phi, dt_s, c.vsw_kms, c.n_cm3);
                self.i_r2_ma = self.rcm.downward_ma(&self.grid);
            }
        }
        self.t_sim_s += dt_s;

        let shift = self.lat_shift_deg();

        // SAPS depletion recovery happens even where E is weak now.
        if !c.saps_enabled {
            self.saps_depletion.fill(1.0);
        }

        // (3–4) Conductance → operator → solve. Uses the depletion field as
        // updated at the END of the previous step (see below).
        self.solve_pass(shift);

        // (5) SAPS conductance feedback: relax the persistent depletion
        // toward E_th/|E| using the freshly solved field. It takes effect
        // on the NEXT step's solve — a 10 s lag on a 300 s relaxation is
        // invisible, and it saves a full re-solve every step.
        if c.saps_enabled {
            let relax = 1.0 - (-dt_s / SAPS_TAU_S).exp();
            for i in 0..NLAT {
                for j in 0..NMLT {
                    let k = idx(i, j);
                    let e_mag = self.fields.e_theta[k].hypot(self.fields.e_phi[k]);
                    let target = if conductance::in_trough_band(&self.grid, &self.cond, shift, i, j)
                        && e_mag > SAPS_E_THRESHOLD
                    {
                        (SAPS_E_THRESHOLD / e_mag).max(SAPS_DEPLETION_FLOOR)
                    } else {
                        1.0
                    };
                    let d = self.saps_depletion[k];
                    self.saps_depletion[k] = d + (target - d) * relax;
                }
            }
        }

        // (6) Unshielded reference solve (R1 only, same operator) — a slow
        // readout, refreshed once per sim minute.
        self.step_count += 1;
        if self.step_count % UNSHIELDED_EVERY == 1 || self.step_count <= 1 {
            let op = solver::assemble(
                &self.grid,
                &self.sigma_p,
                &self.sigma_h,
                &self.grid.sin_dip,
                &self.phi_b,
            );
            for k in 0..N {
                let i = k / NMLT;
                self.b_r1[k] =
                    self.jpar_r1[k] * self.grid.sin_dip[i] * self.grid.area[i] + op.bc_rhs[k];
            }
            solver::bicgstab(&op, &self.b_r1, &mut self.phi_r1, PROD_TOL, PROD_MAX_ITER, &mut self.ws);
            self.fields_r1.update(&self.grid, &self.phi_r1, &self.phi_b);
        }

        // (7) Diagnostics + frame buffers.
        self.cpcp_v = diagnostics::cpcp(&self.phi);
        self.pen_e_vpm = diagnostics::penetration_e(&self.grid, &self.fields);
        self.pen_e_unshielded_vpm = diagnostics::penetration_e(&self.grid, &self.fields_r1);
        self.saps = diagnostics::saps_profile(&self.grid, &self.fields, 21.0, &mut self.saps_profile);
        self.fill_frame();
    }

    /// Conductance rebuild → FAC rebuild → assemble → solve → fields.
    fn solve_pass(&mut self, shift: f64) {
        conductance::rebuild(
            &self.grid,
            &self.cond,
            self.controls.f107,
            self.i_r1_ma.max(self.i_r2_ma), // precipitation inertia — see conductance.rs
            shift,
            &self.saps_depletion,
            &mut self.sigma_p,
            &mut self.sigma_h,
        );
        match self.r2_mode {
            R2Mode::Relaxation => {
                fac::rebuild_jpar(&self.grid, &self.facp, self.i_r1_ma, self.i_r2_ma, shift, &mut self.jpar);
            }
            R2Mode::DriftPhysics => {
                fac::rebuild_jpar(&self.grid, &self.facp, self.i_r1_ma, 0.0, shift, &mut self.jpar);
                for k in 0..N {
                    self.jpar[k] += self.rcm.jpar_applied[k];
                }
            }
        }
        fac::rebuild_jpar(&self.grid, &self.facp, self.i_r1_ma, 0.0, shift, &mut self.jpar_r1);
        let op: Operator = solver::assemble(
            &self.grid,
            &self.sigma_p,
            &self.sigma_h,
            &self.grid.sin_dip,
            &self.phi_b,
        );
        for k in 0..N {
            let i = k / NMLT;
            self.b[k] = self.jpar[k] * self.grid.sin_dip[i] * self.grid.area[i] + op.bc_rhs[k];
        }
        let (it, res) = solver::bicgstab(&op, &self.b, &mut self.phi, PROD_TOL, PROD_MAX_ITER, &mut self.ws);
        self.last_iters = it;
        self.last_residual = res;
        self.fields.update(&self.grid, &self.phi, &self.phi_b);
    }

    fn fill_frame(&mut self) {
        for k in 0..N {
            self.out_phi_kv[k] = (self.phi[k] * 1e-3) as f32;
            self.out_sigma_p[k] = self.sigma_p[k] as f32;
            self.out_emag_mvpm[k] =
                (self.fields.e_theta[k].hypot(self.fields.e_phi[k]) * 1e3) as f32;
            self.out_v_east[k] = self.fields.v_east[k] as f32;
            self.out_v_north[k] = self.fields.v_north[k] as f32;
        }
        for i in 0..NLAT {
            self.out_saps_profile[i] = self.saps_profile[i] as f32;
        }
        for k in 0..N {
            self.out_pressure[k] = self.rcm.pressure_npa[k] as f32;
        }
    }

    /// Shielding efficiency 1 − E_pen/E_unshielded (1 = fully shielded,
    /// 0 = no shielding, < 0 = overshielding reversal).
    pub fn shielding_efficiency(&self) -> f64 {
        let denom = self.pen_e_unshielded_vpm;
        if denom.abs() < 1e-9 {
            return 0.0;
        }
        1.0 - self.pen_e_vpm / denom
    }
}

impl Default for Sim {
    fn default() -> Self {
        Self::new()
    }
}
