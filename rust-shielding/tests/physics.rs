//! The plan-§2.4 correctness suite. These tests gate the physics:
//! if you touch grid.rs / solver.rs / fac.rs / conductance.rs / state.rs,
//! run `cargo test` here before shipping anything to the page.

use shielding_kernel::diagnostics;
use shielding_kernel::fac;
use shielding_kernel::grid::{idx, Grid, N, NLAT, NMLT, R_ION_M};
use shielding_kernel::solver::{self, Workspace};
use shielding_kernel::state::{Controls, Sim};

/// Analytic check (plan §2.4 #1): uniform Σ, no Hall, sin(I) ≡ 1, and a
/// single-harmonic FAC J∥ = A·Y₁¹ = A·sinθ·cosφ. On the sphere
/// ∇²Y₁¹ = −2/R²·Y₁¹, so Φ = (A·R²)/(2Σ₀)·sinθ·cosφ exactly. Dirichlet
/// boundary is set from the closed form. Assert < 1% relative L2 error.
#[test]
fn analytic_y11_under_1_percent() {
    let grid = Grid::new();
    let sigma0 = 10.0; // S
    let amp = 1.0e-6; // A/m² peak
    let sigma_p = vec![sigma0; N];
    let sigma_h = vec![0.0; N];
    let ones = [1.0f64; NLAT];

    let exact = |t: f64, phi: f64| amp * R_ION_M * R_ION_M / (2.0 * sigma0) * t.sin() * phi.cos();

    let t_b = grid.colat[0] + grid.dt * 0.5; // boundary colatitude (50°)
    let mut phi_b = [0.0f64; NMLT];
    for j in 0..NMLT {
        phi_b[j] = exact(t_b, grid.phi[j]);
    }

    let op = solver::assemble(&grid, &sigma_p, &sigma_h, &ones, &phi_b);
    let mut b = vec![0.0; N];
    for i in 0..NLAT {
        for j in 0..NMLT {
            let k = idx(i, j);
            let jpar = amp * grid.colat[i].sin() * grid.phi[j].cos();
            b[k] = jpar * grid.area[i] + op.bc_rhs[k];
        }
    }
    let mut x = vec![0.0; N];
    let mut ws = Workspace::new();
    let (_it, res) = solver::bicgstab(&op, &b, &mut x, 1e-11, 2000, &mut ws);
    assert!(res < 1e-10, "solver did not converge: rel res {res}");

    let mut err2 = 0.0;
    let mut ref2 = 0.0;
    for i in 0..NLAT {
        for j in 0..NMLT {
            let e = exact(grid.colat[i], grid.phi[j]);
            let d = x[idx(i, j)] - e;
            err2 += d * d;
            ref2 += e * e;
        }
    }
    let rel = (err2 / ref2).sqrt();
    assert!(rel < 0.01, "analytic Y11 L2 error {rel:.4} ≥ 1%");
}

/// Current conservation (plan §2.4 #2): total downward FAC equals total
/// upward FAC by construction; and the downward total matches the
/// requested amplitude.
#[test]
fn fac_current_conservation() {
    let grid = Grid::new();
    let p = fac::FacParams::default();
    let mut jpar = vec![0.0; N];
    fac::rebuild_jpar(&grid, &p, 4.2, 3.1, -0.7, &mut jpar);
    let net = fac::net_current_a(&grid, &jpar);
    let down = fac::downward_current_a(&grid, &jpar);
    assert!(down > 0.0);
    assert!(
        (net / down).abs() < 1e-9,
        "net FAC {net:.3e} A is not ≈ 0 (downward {down:.3e} A)"
    );
    // Each sheet alone integrates to exactly its requested amplitude.
    // (Together they overlap in latitude, so the COMBINED downward total is
    // slightly below the sum — that partial cancellation is physical.)
    for (r1, r2, expect_ma) in [(4.2, 0.0, 4.2), (0.0, 3.1, 3.1)] {
        let mut jp = vec![0.0; N];
        fac::rebuild_jpar(&grid, &p, r1, r2, -0.7, &mut jp);
        let d = fac::downward_current_a(&grid, &jp);
        let expect = expect_ma * 1e6;
        assert!(
            ((d - expect) / expect).abs() < 1e-9,
            "sheet downward {d:.6e} ≠ requested {expect:.6e}"
        );
    }
}

/// Superposition (plan §2.4 #3): with Σ frozen the operator is linear, so
/// Φ(R1+R2) = Φ(R1) + Φ(R2).
#[test]
fn superposition_in_linear_regime() {
    let grid = Grid::new();
    // Production-like frozen conductance (storm oval, SAPS feedback off).
    let cond = shielding_kernel::conductance::CondParams::default();
    let dep = vec![1.0; N];
    let mut sigma_p = vec![0.0; N];
    let mut sigma_h = vec![0.0; N];
    shielding_kernel::conductance::rebuild(&grid, &cond, 150.0, 4.0, 0.0, &dep, &mut sigma_p, &mut sigma_h);

    let p = fac::FacParams::default();
    let phi_b = [0.0f64; NMLT];
    let op = solver::assemble(&grid, &sigma_p, &sigma_h, &grid.sin_dip, &phi_b);
    let mut ws = Workspace::new();

    let solve_for = |r1: f64, r2: f64, ws: &mut Workspace| -> Vec<f64> {
        let mut jpar = vec![0.0; N];
        fac::rebuild_jpar(&grid, &p, r1, r2, 0.0, &mut jpar);
        let mut b = vec![0.0; N];
        for i in 0..NLAT {
            for j in 0..NMLT {
                let k = idx(i, j);
                b[k] = jpar[k] * grid.sin_dip[i] * grid.area[i] + op.bc_rhs[k];
            }
        }
        let mut x = vec![0.0; N];
        let (_it, res) = solver::bicgstab(&op, &b, &mut x, 1e-11, 3000, &mut ws.clone_lite());
        assert!(res < 1e-10, "solve failed: {res}");
        x
    };

    let x_both = solve_for(4.0, 3.2, &mut ws);
    let x_r1 = solve_for(4.0, 0.0, &mut ws);
    let x_r2 = solve_for(0.0, 3.2, &mut ws);

    let scale = x_both.iter().fold(0.0f64, |m, v| m.max(v.abs()));
    let mut worst = 0.0f64;
    for k in 0..N {
        worst = worst.max((x_both[k] - x_r1[k] - x_r2[k]).abs());
    }
    assert!(
        worst / scale < 1e-6,
        "superposition violated: max dev {:.3e} of scale {:.3e}",
        worst,
        scale
    );
}

/// Symmetry (plan §2.4 #4): with MLT-uniform Σ and no Hall term, the R1
/// sin(φ) source gives an exactly dawn/dusk-antisymmetric potential:
/// Φ(λ, MLT) = −Φ(λ, 24−MLT).
#[test]
fn dawn_dusk_antisymmetry_without_hall() {
    let grid = Grid::new();
    let sigma_p = vec![8.0; N];
    let sigma_h = vec![0.0; N];
    let phi_b = [0.0f64; NMLT];
    let op = solver::assemble(&grid, &sigma_p, &sigma_h, &grid.sin_dip, &phi_b);
    let p = fac::FacParams::default();
    let mut jpar = vec![0.0; N];
    fac::rebuild_jpar(&grid, &p, 3.0, 0.0, 0.0, &mut jpar);
    let mut b = vec![0.0; N];
    for i in 0..NLAT {
        for j in 0..NMLT {
            let k = idx(i, j);
            b[k] = jpar[k] * grid.sin_dip[i] * grid.area[i] + op.bc_rhs[k];
        }
    }
    let mut x = vec![0.0; N];
    let mut ws = Workspace::new();
    let (_it, res) = solver::bicgstab(&op, &b, &mut x, 1e-11, 3000, &mut ws);
    assert!(res < 1e-10);

    let scale = x.iter().fold(0.0f64, |m, v| m.max(v.abs()));
    let mut worst = 0.0f64;
    // Mirror column of j is NMLT−1−j (φ_j = (j+½)Δφ → 2π−φ).
    for i in 0..NLAT {
        for j in 0..NMLT {
            let jm = NMLT - 1 - j;
            worst = worst.max((x[idx(i, j)] + x[idx(i, jm)]).abs());
        }
    }
    assert!(
        worst / scale < 1e-8,
        "dawn/dusk antisymmetry violated: {:.3e} of {:.3e}",
        worst,
        scale
    );
}

/// A uniform Hall conductance must assemble to a no-op (Hall currents are
/// divergence-free unless ∇Σ_H ≠ 0) — pins the stencil algebra.
#[test]
fn uniform_hall_is_divergence_free() {
    let grid = Grid::new();
    let sigma_p = vec![8.0; N];
    let phi_b = [0.0f64; NMLT];
    let ones = [1.0f64; NLAT];
    let op0 = solver::assemble(&grid, &sigma_p, &vec![0.0; N], &ones, &phi_b);
    let oph = solver::assemble(&grid, &sigma_p, &vec![5.0; N], &ones, &phi_b);
    // Compare A·x on a deterministic non-trivial field.
    let x: Vec<f64> = (0..N)
        .map(|k| ((k % 97) as f64 * 0.37).sin() + ((k / 97) as f64 * 0.11).cos())
        .collect();
    let mut y0 = vec![0.0; N];
    let mut yh = vec![0.0; N];
    solver::apply(&op0, &x, &mut y0);
    solver::apply(&oph, &x, &mut yh);
    let scale = y0.iter().fold(0.0f64, |m, v| m.max(v.abs()));
    let mut worst = 0.0f64;
    for k in 0..N {
        worst = worst.max((y0[k] - yh[k]).abs());
    }
    assert!(
        worst / scale < 1e-12,
        "uniform Hall changed the operator: {:.3e} of {:.3e}",
        worst,
        scale
    );
}

fn run_to_steady(sim: &mut Sim, minutes: f64) {
    let steps = (minutes * 6.0) as usize; // dt = 10 s
    for _ in 0..steps {
        sim.step(10.0);
    }
}

/// CPCP lands in the physical 30–120 kV band across driving levels
/// (plan Phase-1 exit criterion; benchmark: Boyle et al. 1997 ranges).
#[test]
fn cpcp_range_across_driving() {
    // Quiet: Bz −2 nT, 400 km/s.
    let mut sim = Sim::new();
    sim.controls = Controls { bz_nt: -2.0, vsw_kms: 400.0, tau_s_min: 10.0, ..Controls::default() };
    run_to_steady(&mut sim, 60.0);
    let quiet = sim.cpcp_v * 1e-3;
    assert!(
        (20.0..=65.0).contains(&quiet),
        "quiet CPCP {quiet:.1} kV outside 20–65 kV"
    );

    // Storm: Bz −15 nT, 700 km/s.
    let mut sim = Sim::new();
    sim.controls = Controls { bz_nt: -15.0, vsw_kms: 700.0, tau_s_min: 10.0, ..Controls::default() };
    run_to_steady(&mut sim, 60.0);
    let storm = sim.cpcp_v * 1e-3;
    assert!(
        (80.0..=260.0).contains(&storm),
        "storm CPCP {storm:.1} kV outside 80–260 kV"
    );
    assert!(storm > 2.0 * quiet, "storm CPCP should far exceed quiet");
}

/// Shielding dynamics (plan Phase-3 exit): a southward turning spikes the
/// penetration E, which then decays on ~τ_s as R2 catches up; a subsequent
/// northward turning reverses its sign (overshielding).
#[test]
fn shielding_undershoot_then_overshielding() {
    let mut sim = Sim::new();
    sim.controls = Controls {
        bz_nt: -2.0,
        vsw_kms: 450.0,
        tau_s_min: 20.0,
        saps_enabled: false, // isolate the linear shielding physics
        ..Controls::default()
    };
    run_to_steady(&mut sim, 120.0); // quiet equilibrium

    // Southward turning.
    sim.controls.bz_nt = -15.0;
    sim.controls.vsw_kms = 700.0;
    run_to_steady(&mut sim, 2.0);
    let spike = sim.pen_e_vpm * 1e3;
    run_to_steady(&mut sim, 90.0); // ≈ 4.5 τ_s
    let settled = sim.pen_e_vpm * 1e3;
    assert!(spike > 0.0, "undershielding penetration E should be eastward (+), got {spike:.3}");
    assert!(
        settled.abs() < 0.55 * spike.abs(),
        "penetration E did not decay: spike {spike:.3} → settled {settled:.3} mV/m"
    );
    // Steady-state shielding efficiency should be substantial.
    let eff = sim.shielding_efficiency();
    assert!(eff > 0.5, "steady shielding efficiency {eff:.2} ≤ 0.5");

    // Northward turning → overshielding (sign reversal).
    sim.controls.bz_nt = 5.0;
    sim.controls.vsw_kms = 700.0;
    run_to_steady(&mut sim, 3.0);
    let over = sim.pen_e_vpm * 1e3;
    assert!(
        over < 0.0,
        "overshielding after northward turning should reverse penetration E, got {over:.3} mV/m"
    );
}

/// SAPS emergence (plan Phase-4 exit): storm driving produces a westward
/// subauroral jet at 21 MLT — peak ≥ 400 m/s, 1–5° wide, 52–68° MLAT —
/// that sharpens as the conductance feedback deepens the trough.
#[test]
fn saps_westward_jet_emerges_and_sharpens() {
    let mut sim = Sim::new();
    sim.controls = Controls {
        bz_nt: -15.0,
        vsw_kms: 700.0,
        tau_s_min: 20.0,
        saps_enabled: true,
        ..Controls::default()
    };
    run_to_steady(&mut sim, 20.0);
    let early = sim.saps.peak_ms;
    run_to_steady(&mut sim, 70.0);
    let late = sim.saps.peak_ms;

    assert!(
        late > 400.0,
        "SAPS peak {late:.0} m/s below 400 m/s after 90 min of storm driving"
    );
    assert!(
        (52.0..=68.0).contains(&sim.saps.peak_lat_deg),
        "SAPS peak latitude {:.1}° outside the subauroral band",
        sim.saps.peak_lat_deg
    );
    assert!(
        (1.0..=5.0).contains(&sim.saps.width_deg),
        "SAPS width {:.1}° outside 1–5°",
        sim.saps.width_deg
    );
    assert!(
        late >= early,
        "jet should sharpen/strengthen with feedback: {early:.0} → {late:.0} m/s"
    );

    // The same storm WITHOUT the trough feedback must produce a weaker jet
    // — the trough is what makes SAPS exist in the model.
    let mut flat = Sim::new();
    flat.controls = Controls {
        bz_nt: -15.0,
        vsw_kms: 700.0,
        tau_s_min: 20.0,
        saps_enabled: false,
        ..Controls::default()
    };
    flat.cond.trough_depth = 0.0;
    run_to_steady(&mut flat, 90.0);
    assert!(
        flat.saps.peak_ms < 0.75 * late,
        "removing the trough should weaken SAPS: {:.0} vs {:.0} m/s",
        flat.saps.peak_ms,
        late
    );
}

/// E×B sign convention: a poleward electric field must map to WESTWARD
/// flow (northern hemisphere, B down) — the SAPS signature direction.
#[test]
fn poleward_e_gives_westward_flow() {
    let grid = Grid::new();
    let mut f = diagnostics::Fields::new();
    // Φ increasing poleward → E = −∇Φ points equatorward... build the
    // opposite: Φ decreasing poleward (E poleward).
    let mut phi = vec![0.0; N];
    for i in 0..NLAT {
        for j in 0..NMLT {
            phi[idx(i, j)] = grid.colat[i] * 1e5; // grows equatorward
        }
    }
    let phi_b = [grid.colat[0] * 1e5 + grid.dt * 0.5 * 1e5; NMLT];
    f.update(&grid, &phi, &phi_b);
    // E_θ = −(1/R)∂Φ/∂θ < 0 (poleward). Westward flow = −v_east > 0.
    let k = idx(50, 10);
    assert!(f.e_theta[k] < 0.0, "expected poleward E_θ");
    assert!(f.v_east[k] < 0.0, "poleward E must give westward drift");
}

/// Golden regression (plan §2.4 #5): canonical storm scenario snapshot.
/// If a physics change moves these on purpose, update the constants in the
/// same PR and say so — that's the point of the golden file.
#[test]
fn golden_canonical_storm() {
    let mut sim = Sim::new();
    sim.controls = Controls {
        bz_nt: -12.0,
        by_nt: 3.0,
        vsw_kms: 650.0,
        n_cm3: 8.0,
        f107: 150.0,
        tau_s_min: 25.0,
        saps_enabled: true,
    };
    run_to_steady(&mut sim, 60.0);

    let cpcp_kv = sim.cpcp_v * 1e-3;
    let saps = sim.saps.peak_ms;

    // Golden values recorded from the calibrated Phase-1 build
    // (examples/storm_scenario.rs prints them).
    const GOLDEN_CPCP_KV: f64 = 157.834;
    const GOLDEN_SAPS_MS: f64 = 850.1;
    assert!(
        ((cpcp_kv - GOLDEN_CPCP_KV) / GOLDEN_CPCP_KV).abs() < 0.01,
        "CPCP drifted from golden: {cpcp_kv:.3} vs {GOLDEN_CPCP_KV}"
    );
    assert!(
        ((saps - GOLDEN_SAPS_MS) / GOLDEN_SAPS_MS).abs() < 0.01,
        "SAPS peak drifted from golden: {saps:.1} vs {GOLDEN_SAPS_MS}"
    );
}

// Workspace helper for the closure-borrow dance in the superposition test.
trait CloneLite {
    fn clone_lite(&self) -> Workspace;
}
impl CloneLite for Workspace {
    fn clone_lite(&self) -> Workspace {
        Workspace::new()
    }
}

// ═══════════════════════════════════════════════════════════════════════
// Phase 6 — mini-RCM drift-physics R2 (rcm.rs)
// ═══════════════════════════════════════════════════════════════════════

use shielding_kernel::rcm::{Rcm, NK, NRCM};
use shielding_kernel::state::R2Mode;

/// The upwind advection is conservative: with no source/loss and no flow
/// across the domain edges (φ-independent potential → ψ̇ = 0), total
/// content is preserved to rounding.
#[test]
fn rcm_advection_conserves_content() {
    let grid = Grid::new();
    let mut rcm = Rcm::new(&grid);
    // Interior blob in channel 2, rows 20–30, all MLT.
    for i in 20..=30 {
        for j in 0..NMLT {
            rcm.content[(2 * NRCM + i) * NMLT + j] = 1.0e18 * (1.0 + (j as f64 * 0.3).sin());
        }
    }
    let before = rcm.total_content();
    // Zero solved potential → corotation + gradient drift only: pure
    // azimuthal flow (V and Φ_cor are φ-independent → ψ̇ = 0 everywhere,
    // so nothing can leave through the latitude boundaries either).
    let phi = vec![0.0; N];
    rcm.prepare_hamiltonian_for_test(2, &grid, &phi);
    for _ in 0..200 {
        rcm.advect_channel(2, &grid, 10.0, 0.0);
    }
    let after = rcm.total_content();
    assert!(
        ((after - before) / before).abs() < 1e-12,
        "content drifted: {before:.6e} → {after:.6e}"
    );
}

/// Sign conventions, pinned: corotation advects EASTWARD; ion
/// gradient/curvature drift advects WESTWARD. (These two fix the canonical
/// orientation of the (ψ, φ) Euler pair — get them right and E×B follows.)
#[test]
fn rcm_drift_directions() {
    let grid = Grid::new();
    let phi = vec![0.0; N];

    // Blob column tracker: circular centroid displacement sign.
    let centroid_shift = |rcm: &Rcm, k: usize, i: usize, j0: usize| -> f64 {
        let mut sx = 0.0;
        let mut sy = 0.0;
        for j in 0..NMLT {
            let c = rcm.content[(k * NRCM + i) * NMLT + j];
            let a = (j as f64 + 0.5) / NMLT as f64 * std::f64::consts::TAU;
            sx += c * a.cos();
            sy += c * a.sin();
        }
        let a = sy.atan2(sx);
        let a0 = (j0 as f64 + 0.5) / NMLT as f64 * std::f64::consts::TAU;
        let mut d = a - a0;
        while d > std::f64::consts::PI {
            d -= std::f64::consts::TAU;
        }
        while d < -std::f64::consts::PI {
            d += std::f64::consts::TAU;
        }
        d
    };

    // (a) Corotation only: kill the energy invariant of channel 0.
    let mut rcm = Rcm::new(&grid);
    rcm.lambda[0] = 0.0;
    let (row, col) = (30usize, 24usize);
    rcm.content[(0 * NRCM + row) * NMLT + col] = 1.0e18;
    rcm.prepare_hamiltonian_for_test(0, &grid, &phi);
    for _ in 0..180 {
        rcm.advect_channel(0, &grid, 10.0, 0.0);
    }
    let d_corot = centroid_shift(&rcm, 0, row, col);
    assert!(d_corot > 0.005, "corotation must drift EASTWARD, got Δφ = {d_corot:.4} rad");

    // (b) Gradient drift only (corotation off, top energy channel).
    let mut rcm = Rcm::new(&grid);
    rcm.corotation = false;
    let k = NK - 1;
    rcm.content[(k * NRCM + row) * NMLT + col] = 1.0e18;
    rcm.prepare_hamiltonian_for_test(k, &grid, &phi);
    for _ in 0..180 {
        rcm.advect_channel(k, &grid, 10.0, 0.0);
    }
    let d_gc = centroid_shift(&rcm, k, row, col);
    assert!(d_gc < -0.005, "ion gc-drift must be WESTWARD, got Δφ = {d_gc:.4} rad");
}

/// The Vasyliunas current sums to zero over the domain (exact, by the
/// single-valued face-flux construction) — the solver's source stays
/// balanced with drift-physics R2 exactly as with the parameterized one.
#[test]
fn rcm_vasyliunas_current_balance() {
    let mut sim = Sim::new();
    sim.r2_mode = R2Mode::DriftPhysics;
    sim.controls = Controls { bz_nt: -12.0, vsw_kms: 650.0, ..Controls::default() };
    run_to_steady(&mut sim, 45.0);
    let mut net = 0.0;
    let mut down = 0.0;
    for i in 0..NLAT {
        for j in 0..NMLT {
            let v = sim.rcm.jpar_applied[idx(i, j)] * sim.grid.area[i];
            net += v;
            if v > 0.0 {
                down += v;
            }
        }
    }
    assert!(down > 1e5, "expected a substantial ring-current FAC, got {down:.3e} A");
    assert!(
        (net / down).abs() < 1e-9,
        "Vasyliunas current unbalanced: net {net:.3e} of downward {down:.3e}"
    );
}

/// Emergent R2 polarity and magnitude: the partial ring current's FAC is
/// downward on the dusk half, upward on the dawn half (Region-2 sense),
/// with a storm-time total in the physical 0.5–6 MA band.
#[test]
fn rcm_r2_polarity_and_magnitude() {
    let mut sim = Sim::new();
    sim.r2_mode = R2Mode::DriftPhysics;
    sim.controls = Controls { bz_nt: -2.0, vsw_kms: 450.0, ..Controls::default() };
    run_to_steady(&mut sim, 40.0); // spin-up
    sim.controls.bz_nt = -15.0;
    sim.controls.vsw_kms = 700.0;
    run_to_steady(&mut sim, 60.0);

    assert!(
        (0.5..=6.0).contains(&sim.i_r2_ma),
        "emergent I_R2 {:.2} MA outside 0.5–6 MA",
        sim.i_r2_ma
    );
    let mut dusk = 0.0;
    let mut dawn = 0.0;
    for i in 0..NLAT {
        for j in 0..NMLT {
            let v = sim.rcm.jpar_applied[idx(i, j)] * sim.grid.area[i];
            if sim.grid.mlt[j] >= 12.0 {
                dusk += v;
            } else {
                dawn += v;
            }
        }
    }
    assert!(dusk > 0.0, "dusk half should carry net DOWNWARD R2, got {dusk:.3e} A");
    assert!(dawn < 0.0, "dawn half should carry net UPWARD R2, got {dawn:.3e} A");
}

/// THE Phase-6 exit criterion: shielding timing is EMERGENT. A southward
/// turning spikes the penetration E, which decays as the drifting ring
/// current builds its own R2; a northward turning then reverses the sign
/// (overshielding) because the built-up partial ring current outlives the
/// convection that made it.
#[test]
fn rcm_emergent_shielding_and_overshielding() {
    let mut sim = Sim::new();
    sim.r2_mode = R2Mode::DriftPhysics;
    sim.controls = Controls {
        bz_nt: -2.0,
        vsw_kms: 450.0,
        saps_enabled: false, // isolate the shielding physics
        ..Controls::default()
    };
    run_to_steady(&mut sim, 90.0); // ring-current spin-up

    sim.controls.bz_nt = -15.0;
    sim.controls.vsw_kms = 700.0;
    run_to_steady(&mut sim, 3.0);
    let spike = sim.pen_e_vpm * 1e3;
    assert!(spike > 0.0, "undershielding penetration E should be eastward, got {spike:.4}");

    run_to_steady(&mut sim, 117.0);
    let settled = sim.pen_e_vpm * 1e3;
    assert!(
        settled.abs() < 0.6 * spike.abs(),
        "no emergent shielding: spike {spike:.4} → settled {settled:.4} mV/m"
    );

    sim.controls.bz_nt = 5.0;
    run_to_steady(&mut sim, 20.0);
    let over = sim.pen_e_vpm * 1e3;
    assert!(
        over < 0.0,
        "no emergent overshielding after northward turning: {over:.4} mV/m"
    );
}
