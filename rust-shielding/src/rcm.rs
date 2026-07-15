//! rcm.rs — mini-RCM Region-2: a 2-invariant drift-physics ring current
//! (plan Phase 6). Replaces the parameterized R2 relaxation when enabled:
//! shielding TIMING becomes emergent instead of imposed.
//!
//! Formalism (Rice Convection Model, isotropic-pressure limit):
//!   * NK proton channels, each carrying a fixed energy invariant
//!     λ_k = W·V^(2/3), where V(L) = (32/35)·L⁴·R_E/B0 is the dipole
//!     flux-tube volume per unit magnetic flux. Channel k's kinetic energy
//!     at any L is W = λ_k·V^(-2/3) — adiabatic heating on inward
//!     transport falls out for free.
//!   * Flux-tube content η_k (particles per Wb) advects under the
//!     bounce-averaged drift, which is Hamiltonian in dipole Euler
//!     coordinates (ψ = B0·R_E²·sin²θ_iono, φ):
//!         H_k/q = Φ_solved + Φ_corot + (λ_k/q)·V^(-2/3)
//!         ψ̇ = +∂(H/q)/∂φ        φ̇ = −∂(H/q)/∂ψ
//!     (Sign check, pinned by tests: corotation advects EASTWARD, ion
//!     gradient/curvature drift advects WESTWARD, E×B matches the
//!     diagnostics module's v = E×B/B².)
//!   * Cold electrons E×B-drift and neutralize; the qΦ part of the charge
//!     flux therefore cancels and the field-aligned current is EXACTLY the
//!     divergence of the gradient-drift charge flux (Vasyliunas). In a
//!     dipole V depends on ψ alone, so the gc-drift is purely azimuthal —
//!     the FAC comes from azimuthal pressure asymmetry (the partial ring
//!     current), which is the physical Region-2 mechanism.
//!
//! Numerics: conservative first-order upwind on the (ψ, φ) cell complex —
//! total content is conserved to rounding (test-pinned), and the discrete
//! Vasyliunas current sums to zero over the domain exactly (periodic φ),
//! so the solver's source stays balanced by construction.
//!
//! Honest limitations (documented on-page): protons only (single species),
//! first-order upwind (numerically diffusive inner edge), crude
//! charge-exchange lifetime, plasma-sheet boundary from Borovsky-style
//! scalings of the upstream wind, R1 stays parameterized.

use crate::grid::{idx, Grid, N, NLAT, NMLT, B_EQ_T, R_ION_M};

/// Number of energy-invariant channels.
pub const NK: usize = 6;
/// Poleward edge of the drift domain (rows 0..NRCM), MLAT 40°–70°.
pub const NRCM: usize = 60;

/// Boundary-channel kinetic energies at the poleward edge (keV) — log-ish
/// ladder spanning the plasma-sheet distribution.
const W_BOUNDARY_KEV: [f64; NK] = [0.6, 1.5, 3.75, 9.4, 23.0, 58.0];

const KEV: f64 = 1.602e-16; // J per keV
const Q_E: f64 = 1.602e-19; // C
/// Corotation potential amplitude: ω_E·B0·R_E² ≈ 92 kV.
const COROT_KV: f64 = 92.1e3;

pub struct Rcm {
    /// Cell content per channel: C = η·Δψ·Δφ (particles), rows 0..NRCM.
    pub content: Vec<f64>, // NK × NRCM × NMLT
    /// Energy invariant per channel: λ_k = W_k·V(L_b)^(2/3).
    pub lambda: [f64; NK],
    /// Raw and time-smoothed Vasyliunas FAC (A/m², downward positive).
    jpar_raw: Vec<f64>,   // N (full grid, zero outside domain)
    pub jpar_applied: Vec<f64>, // N
    /// Pressure diagnostic (nPa) per cell (full grid, zero outside).
    pub pressure_npa: Vec<f64>,
    /// Flux function ψ_i at cell centers (Wb/rad; 2πψ = flux through the
    /// colatitude circle) and the per-row ψ-width of a cell.
    psi_c: [f64; NRCM],
    dpsi: [f64; NRCM],
    /// V(L)^(-2/3) at cell centers (per-unit-flux volume metric).
    vm23: [f64; NRCM],
    /// Corotation potential at cell centers (V).
    phi_cor: [f64; NRCM],
    /// Charge-exchange lifetime (s) per (channel, row).
    tau_ce: Vec<f64>, // NK × NRCM
    /// Scratch: effective Hamiltonian/q (V) per cell for the active channel.
    h_over_q: Vec<f64>, // NRCM × NMLT
    /// Enable corotation (tests switch it off to isolate terms).
    pub corotation: bool,
}

#[inline]
fn kidx(k: usize, i: usize, j: usize) -> usize {
    (k * NRCM + i) * NMLT + j
}

/// Dipole flux-tube volume per unit flux, V(L) = (32/35)·L⁴·R_E/B0 (m/T).
fn flux_tube_volume(l_shell: f64) -> f64 {
    (32.0 / 35.0) * l_shell.powi(4) * (R_ION_M / B_EQ_T)
}

impl Rcm {
    pub fn new(grid: &Grid) -> Self {
        let mut psi_c = [0.0; NRCM];
        let mut dpsi = [0.0; NRCM];
        let mut vm23 = [0.0; NRCM];
        let mut phi_cor = [0.0; NRCM];
        let b0r2 = B_EQ_T * R_ION_M * R_ION_M;
        for i in 0..NRCM {
            let t = grid.colat[i];
            let s2 = t.sin() * t.sin();
            psi_c[i] = b0r2 * s2;
            let tp = t - grid.dt * 0.5;
            let te = t + grid.dt * 0.5;
            dpsi[i] = b0r2 * (te.sin() * te.sin() - tp.sin() * tp.sin());
            let l = 1.0 / s2;
            vm23[i] = flux_tube_volume(l).powf(-2.0 / 3.0);
            phi_cor[i] = -COROT_KV * s2;
        }
        // λ_k from boundary energies at the poleward edge's L-shell.
        let l_b = 1.0 / (grid.colat[NRCM - 1].sin().powi(2));
        let v_b23 = flux_tube_volume(l_b).powf(2.0 / 3.0);
        let mut lambda = [0.0; NK];
        for k in 0..NK {
            lambda[k] = W_BOUNDARY_KEV[k] * KEV * v_b23;
        }
        // Charge-exchange lifetime: crude but monotone in the right ways —
        // shorter deeper in (denser geocorona) and for mid energies.
        // τ = 30 h · (L/6)⁴, floored at 30 min, doubled for the top channel
        // (charge-exchange cross-section falls off above ~40 keV).
        let mut tau_ce = vec![0.0; NK * NRCM];
        for k in 0..NK {
            for i in 0..NRCM {
                let l = 1.0 / (grid.colat[i].sin().powi(2));
                let mut tau = 30.0 * 3600.0 * (l / 6.0).powi(4);
                if k == NK - 1 {
                    tau *= 2.0;
                }
                tau_ce[k * NRCM + i] = tau.clamp(1800.0, 400.0 * 3600.0);
            }
        }
        Rcm {
            content: vec![0.0; NK * NRCM * NMLT],
            lambda,
            jpar_raw: vec![0.0; N],
            jpar_applied: vec![0.0; N],
            pressure_npa: vec![0.0; N],
            psi_c,
            dpsi,
            vm23,
            phi_cor,
            tau_ce,
            h_over_q: vec![0.0; NRCM * NMLT],
            corotation: true,
        }
    }

    /// Plasma-sheet boundary content per channel (particles per Wb),
    /// Borovsky-style: n_ps ~ 0.5·√n_sw cm⁻³, T_ps ~ 0.0165·v_sw keV,
    /// Maxwellian-partitioned over the channel energy ladder.
    fn boundary_eta(&self, vsw_kms: f64, n_cm3: f64) -> [f64; NK] {
        let n_ps = 0.5 * n_cm3.max(0.1).sqrt() * 1e6; // m⁻³
        let t_ps_kev = (0.0165 * vsw_kms).max(0.5);
        let l_b = ((B_EQ_T * R_ION_M * R_ION_M) / self.psi_c[NRCM - 1]).max(1.0);
        let v_b = flux_tube_volume(l_b);
        // Maxwellian energy-distribution weights at the ladder points:
        // f(x) ∝ √x·e^(−x), x = W/T, with log-ladder bin widths.
        let mut w = [0.0; NK];
        let mut sum = 0.0;
        for k in 0..NK {
            let x = W_BOUNDARY_KEV[k] / t_ps_kev;
            let x_lo = if k == 0 { 0.0 } else { (W_BOUNDARY_KEV[k] * W_BOUNDARY_KEV[k - 1]).sqrt() / t_ps_kev };
            let x_hi = if k == NK - 1 {
                W_BOUNDARY_KEV[k] * 2.0 / t_ps_kev
            } else {
                (W_BOUNDARY_KEV[k] * W_BOUNDARY_KEV[k + 1]).sqrt() / t_ps_kev
            };
            w[k] = x.sqrt() * (-x).exp() * (x_hi - x_lo).max(0.0);
            sum += w[k];
        }
        let eta_tot = n_ps * v_b; // particles per Wb
        let mut eta = [0.0; NK];
        for k in 0..NK {
            eta[k] = eta_tot * w[k] / sum.max(1e-30);
        }
        eta
    }

    /// Advance the drift model by dt (s) in the given ionospheric potential
    /// (volts, full grid), then rebuild the Vasyliunas FAC and pressure.
    /// `vsw_kms`/`n_cm3` set the plasma-sheet boundary condition.
    pub fn step(&mut self, grid: &Grid, phi: &[f64], dt_s: f64, vsw_kms: f64, n_cm3: f64) {
        let dphi = grid.dphi;
        let eta_b = self.boundary_eta(vsw_kms, n_cm3);
        self.jpar_raw.fill(0.0);

        for k in 0..NK {
            self.build_hamiltonian(k, phi);

            // CFL: bound the fastest face velocity, subcycle if needed.
            let mut max_cfl = 0.0f64;
            for i in 0..NRCM {
                for j in 0..NMLT {
                    let h = self.h_over_q[i * NMLT + j];
                    let je = (j + 1) % NMLT;
                    let hphi = (self.h_over_q[i * NMLT + je] - h).abs() / dphi;
                    max_cfl = max_cfl.max(hphi * dt_s / self.dpsi[i]);
                    if i + 1 < NRCM {
                        let hn = self.h_over_q[(i + 1) * NMLT + j];
                        let dps = (self.psi_c[i] - self.psi_c[i + 1]).abs();
                        max_cfl = max_cfl.max(((hn - h).abs() / dps) * dt_s / dphi);
                    }
                }
            }
            let nsub = (max_cfl / 0.8).ceil().max(1.0) as usize;
            let sdt = dt_s / nsub as f64;

            for _ in 0..nsub {
                self.advect_channel(k, grid, sdt, eta_b[k]);
            }

            // Charge-exchange loss.
            for i in 0..NRCM {
                let f = (-dt_s / self.tau_ce[k * NRCM + i]).exp();
                for j in 0..NMLT {
                    self.content[kidx(k, i, j)] *= f;
                }
            }
        }

        // Smooth the applied FAC (60 s relaxation) — the M–I loop
        // (Φ → drift → j∥ → Φ) is stable with a modest low-pass here.
        let relax = 1.0 - (-dt_s / 60.0).exp();
        for c in 0..N {
            self.jpar_applied[c] += (self.jpar_raw[c] - self.jpar_applied[c]) * relax;
        }

        // Pressure diagnostic: P = (2/3)·V^(−5/3)·Σ_k λ_k·η_k.
        for i in 0..NRCM {
            let v = 1.0 / self.vm23[i].powf(1.5); // V = (V^(-2/3))^(-3/2)
            let vm53 = v.powf(-5.0 / 3.0);
            for j in 0..NMLT {
                let mut sum = 0.0;
                for k in 0..NK {
                    let eta = self.content[kidx(k, i, j)] / (self.dpsi[i] * dphi);
                    sum += self.lambda[k] * eta;
                }
                self.pressure_npa[idx(i, j)] = (2.0 / 3.0) * vm53 * sum * 1e9;
            }
        }
        for i in NRCM..NLAT {
            for j in 0..NMLT {
                self.pressure_npa[idx(i, j)] = 0.0;
            }
        }
    }

    /// Effective Hamiltonian/charge (V) for channel k on the drift grid.
    fn build_hamiltonian(&mut self, k: usize, phi: &[f64]) {
        for i in 0..NRCM {
            let base = if self.corotation { self.phi_cor[i] } else { 0.0 }
                + (self.lambda[k] / Q_E) * self.vm23[i];
            for j in 0..NMLT {
                self.h_over_q[i * NMLT + j] = phi[idx(i, j)] + base;
            }
        }
    }

    /// Test hook: build channel k's Hamiltonian from an explicit potential
    /// so `advect_channel` can run standalone (no source/loss/smoothing).
    pub fn prepare_hamiltonian_for_test(&mut self, k: usize, _grid: &Grid, phi: &[f64]) {
        self.build_hamiltonian(k, phi);
    }

    /// One conservative upwind sweep of channel k. Also accumulates the
    /// gradient-drift (Vasyliunas) charge flux divergence into jpar_raw.
    /// Public so the test suite can exercise conservation and drift
    /// directions without the source/loss terms of `step`.
    pub fn advect_channel(&mut self, k: usize, grid: &Grid, dt: f64, eta_boundary: f64) {
        let dphi = grid.dphi;
        let lam_v = self.lambda[k] / Q_E;

        // ── φ-faces: total drift (E×B + corotation + gc) AND gc-only ────
        // φ̇ = −∂(H/q)/∂ψ. ψ decreases with i (poleward), so
        // ∂H/∂ψ at the face ≈ (H_{i−1} − H_{i+1}) / (ψ_{i−1} − ψ_{i+1}),
        // one-sided at the domain edges.
        let mut dcontent = vec![0.0f64; NRCM * NMLT];
        for i in 0..NRCM {
            for j in 0..NMLT {
                let je = (j + 1) % NMLT;
                // ∂/∂ψ across rows at the east face (average of the two
                // columns adjacent to the face).
                let dh_dpsi = |col: usize| -> f64 {
                    let h = |r: usize| self.h_over_q[r * NMLT + col];
                    if i == 0 {
                        (h(0) - h(1)) / (self.psi_c[0] - self.psi_c[1])
                    } else if i == NRCM - 1 {
                        (h(NRCM - 2) - h(NRCM - 1)) / (self.psi_c[NRCM - 2] - self.psi_c[NRCM - 1])
                    } else {
                        (h(i - 1) - h(i + 1)) / (self.psi_c[i - 1] - self.psi_c[i + 1])
                    }
                };
                let phidot = -0.5 * (dh_dpsi(j) + dh_dpsi(je)); // rad/s · (per ψ measure)
                // gc-only part: −∂(λ/q·V^(−2/3))/∂ψ, row-only (V = V(ψ)).
                let gc_only = {
                    let vm = |r: usize| lam_v * self.vm23[r];
                    -(if i == 0 {
                        (vm(0) - vm(1)) / (self.psi_c[0] - self.psi_c[1])
                    } else if i == NRCM - 1 {
                        (vm(NRCM - 2) - vm(NRCM - 1)) / (self.psi_c[NRCM - 2] - self.psi_c[NRCM - 1])
                    } else {
                        (vm(i - 1) - vm(i + 1)) / (self.psi_c[i - 1] - self.psi_c[i + 1])
                    })
                };
                // Upwind content flux through the east face (particles/s):
                // F = η_up · φ̇ · Δψ, with η = C/(Δψ·Δφ) → F = C_up·φ̇/Δφ.
                let c_here = self.content[kidx(k, i, j)];
                let c_east = self.content[kidx(k, i, je)];
                let c_up = if phidot >= 0.0 { c_here } else { c_east };
                let f_total = c_up * phidot / dphi;
                dcontent[i * NMLT + j] -= f_total * dt;
                dcontent[i * NMLT + je] += f_total * dt;
                // Vasyliunas closure: quasineutrality (cold electrons
                // cancel the E×B/corotation charge flux) leaves
                //   J∥_down = −div_h(gc charge flux)
                // — charge converging horizontally flows DOWN into the
                // ionosphere. The face flux is single-valued between the
                // two cells, so the total FAC sums to zero exactly.
                let c_up_gc = if gc_only >= 0.0 { c_here } else { c_east };
                let f_gc = c_up_gc * gc_only / dphi * Q_E; // A through this face
                self.jpar_raw[idx(i, j)] -= 0.5 * f_gc / grid.area[i];
                self.jpar_raw[idx(i, je)] += 0.5 * f_gc / grid.area[i];
            }
        }

        // ── ψ-faces (between rows): E×B/corotation transport only ───────
        // ψ̇ = +∂(H/q)/∂φ, evaluated at the face between rows i and i+1.
        for i in 0..NRCM {
            for j in 0..NMLT {
                let je = (j + 1) % NMLT;
                let jw = (j + NMLT - 1) % NMLT;
                if i + 1 < NRCM {
                    // Face between i (equatorward) and i+1 (poleward).
                    let dh_dphi = ((self.h_over_q[i * NMLT + je] + self.h_over_q[(i + 1) * NMLT + je])
                        - (self.h_over_q[i * NMLT + jw] + self.h_over_q[(i + 1) * NMLT + jw]))
                        / (4.0 * dphi);
                    let psidot = dh_dphi; // (Wb/rad)/s
                    // ψ increases equatorward (toward smaller i): ψ̇ > 0
                    // moves content from row i+1 to row i. The signed flux
                    // F = η_up·ψ̇·Δφ = C_up·ψ̇/Δψ_up handles both senses.
                    let (c_up, dpsi_up) = if psidot >= 0.0 {
                        (self.content[kidx(k, i + 1, j)], self.dpsi[i + 1])
                    } else {
                        (self.content[kidx(k, i, j)], self.dpsi[i])
                    };
                    let f = c_up / dpsi_up * psidot;
                    dcontent[i * NMLT + j] += f * dt;
                    dcontent[(i + 1) * NMLT + j] -= f * dt;
                } else {
                    // Poleward domain edge: plasma-sheet boundary.
                    let dh_dphi = (self.h_over_q[i * NMLT + je] - self.h_over_q[i * NMLT + jw])
                        / (2.0 * dphi);
                    let psidot = dh_dphi;
                    if psidot >= 0.0 {
                        // Inflow from the plasma sheet (ghost η = η_boundary).
                        let f = eta_boundary * psidot * dphi;
                        dcontent[i * NMLT + j] += f * dt;
                    } else {
                        // Outflow to the boundary: upwind from the edge row.
                        let f = self.content[kidx(k, i, j)] / self.dpsi[i] * psidot;
                        dcontent[i * NMLT + j] += f * dt;
                    }
                }
                if i == 0 {
                    // Equatorward domain edge: outflow-only absorber.
                    let dh_dphi = (self.h_over_q[je] - self.h_over_q[jw]) / (2.0 * dphi);
                    let psidot = dh_dphi;
                    if psidot > 0.0 {
                        // ψ̇ > 0 at the equatorward face carries content out.
                        let f = self.content[kidx(k, 0, j)] / self.dpsi[0] * psidot;
                        dcontent[j] -= f * dt;
                    }
                }
            }
        }

        for i in 0..NRCM {
            for j in 0..NMLT {
                let c = &mut self.content[kidx(k, i, j)];
                *c = (*c + dcontent[i * NMLT + j]).max(0.0);
            }
        }
    }

    /// Total content (particles) — conservation diagnostics/tests.
    pub fn total_content(&self) -> f64 {
        self.content.iter().sum()
    }

    /// Total downward Vasyliunas current (MA) — the emergent I_R2.
    pub fn downward_ma(&self, grid: &Grid) -> f64 {
        let mut sum = 0.0;
        for i in 0..NRCM {
            for j in 0..NMLT {
                let v = self.jpar_applied[idx(i, j)];
                if v > 0.0 {
                    sum += v * grid.area[i];
                }
            }
        }
        sum * 1e-6
    }
}
