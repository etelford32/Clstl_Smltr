//! CLI harness for the Phase-6 drift-physics R2 (mini-RCM). Same canonical
//! scenario as storm_scenario.rs but with R2Mode::DriftPhysics, plus a
//! 3 h quiet spin-up so the ring current populates before the storm.
//!
//!     cargo run --release --example rcm_scenario > /tmp/rcm.csv

use shielding_kernel::state::{Controls, R2Mode, Sim};

fn main() {
    let mut sim = Sim::new();
    sim.r2_mode = R2Mode::DriftPhysics;
    sim.controls = Controls {
        bz_nt: -2.0,
        by_nt: 0.0,
        vsw_kms: 450.0,
        n_cm3: 5.0,
        f107: 150.0,
        tau_s_min: 20.0, // inert in drift mode
        saps_enabled: true,
    };

    println!("t_min,bz_nT,r1_MA,r2_MA,cpcp_kV,penE_mVm,penE_unshielded_mVm,shield_eff,saps_peak_ms,peak_p_npa,content,iters");

    let log = |sim: &Sim, minute: f64| {
        let peak_p = sim
            .rcm
            .pressure_npa
            .iter()
            .fold(0.0f64, |m, &v| m.max(v));
        println!(
            "{:.0},{:.1},{:.3},{:.3},{:.2},{:.4},{:.4},{:.3},{:.1},{:.2},{:.3e},{}",
            minute,
            sim.controls.bz_nt,
            sim.i_r1_ma,
            sim.i_r2_ma,
            sim.cpcp_v * 1e-3,
            sim.pen_e_vpm * 1e3,
            sim.pen_e_unshielded_vpm * 1e3,
            sim.shielding_efficiency(),
            sim.saps.peak_ms,
            peak_p,
            sim.rcm.total_content(),
            sim.last_iters,
        );
    };

    let mut minute = 0.0;
    let run = |sim: &mut Sim, minutes: usize, every: usize, minute: &mut f64| {
        for m in 0..minutes {
            for _ in 0..6 {
                sim.step(10.0);
            }
            *minute += 1.0;
            if m % every == 0 {
                log(sim, *minute);
            }
        }
    };

    // Phase A: 3 h quiet spin-up (ring current populates from the plasma
    // sheet under weak convection).
    run(&mut sim, 180, 10, &mut minute);
    // Phase B: southward turning → 2 h storm main phase.
    sim.controls.bz_nt = -15.0;
    sim.controls.vsw_kms = 700.0;
    run(&mut sim, 120, 2, &mut minute);
    // Phase C: northward turning → 1 h (overshielding window).
    sim.controls.bz_nt = 5.0;
    run(&mut sim, 60, 2, &mut minute);
}
