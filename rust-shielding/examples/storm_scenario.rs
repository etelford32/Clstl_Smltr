//! CLI harness (plan §3): validate the physics headlessly before any
//! frontend exists. Prints a CSV time series of the canonical
//! southward-turning → storm → northward-turning scenario, then a summary
//! block with the values the golden-regression test pins.
//!
//!     cargo run --release --example storm_scenario > /tmp/storm.csv

use shielding_kernel::state::{Controls, Sim};

fn main() {
    let mut sim = Sim::new();
    sim.controls = Controls {
        bz_nt: -2.0,
        by_nt: 0.0,
        vsw_kms: 450.0,
        n_cm3: 5.0,
        f107: 150.0,
        tau_s_min: 20.0,
        saps_enabled: true,
    };

    println!("t_min,bz_nT,r1_MA,r2_MA,cpcp_kV,penE_mVm,penE_unshielded_mVm,shield_eff,saps_peak_ms,saps_lat_deg,saps_width_deg,iters");

    let mut minute = 0.0;
    let log = |sim: &Sim, minute: f64| {
        println!(
            "{:.0},{:.1},{:.3},{:.3},{:.2},{:.4},{:.4},{:.3},{:.1},{:.2},{:.2},{}",
            minute,
            sim.controls.bz_nt,
            sim.i_r1_ma,
            sim.i_r2_ma,
            sim.cpcp_v * 1e-3,
            sim.pen_e_vpm * 1e3,
            sim.pen_e_unshielded_vpm * 1e3,
            sim.shielding_efficiency(),
            sim.saps.peak_ms,
            sim.saps.peak_lat_deg,
            sim.saps.width_deg,
            sim.last_iters,
        );
    };

    // Phase A: 30 min quiet.
    for _ in 0..30 {
        for _ in 0..6 {
            sim.step(10.0);
        }
        minute += 1.0;
        log(&sim, minute);
    }
    // Phase B: southward turning → 90 min storm.
    sim.controls.bz_nt = -15.0;
    sim.controls.vsw_kms = 700.0;
    for _ in 0..90 {
        for _ in 0..6 {
            sim.step(10.0);
        }
        minute += 1.0;
        log(&sim, minute);
    }
    // Phase C: northward turning → 45 min recovery.
    sim.controls.bz_nt = 5.0;
    for _ in 0..45 {
        for _ in 0..6 {
            sim.step(10.0);
        }
        minute += 1.0;
        log(&sim, minute);
    }

    // Golden-scenario summary (matches tests/physics.rs::golden_canonical_storm).
    let mut g = Sim::new();
    g.controls = Controls {
        bz_nt: -12.0,
        by_nt: 3.0,
        vsw_kms: 650.0,
        n_cm3: 8.0,
        f107: 150.0,
        tau_s_min: 25.0,
        saps_enabled: true,
    };
    for _ in 0..(60 * 6) {
        g.step(10.0);
    }
    eprintln!("--- golden canonical storm (60 min) ---");
    eprintln!("GOLDEN_CPCP_KV = {:.3}", g.cpcp_v * 1e-3);
    eprintln!("GOLDEN_SAPS_MS = {:.1}", g.saps.peak_ms);
    eprintln!(
        "penE = {:.3} mV/m  unshielded = {:.3} mV/m  eff = {:.3}",
        g.pen_e_vpm * 1e3,
        g.pen_e_unshielded_vpm * 1e3,
        g.shielding_efficiency()
    );
    eprintln!(
        "SAPS lat = {:.2}°  width = {:.2}°  R1 = {:.2} MA  R2 = {:.2} MA  iters = {}",
        g.saps.peak_lat_deg,
        g.saps.width_deg,
        g.i_r1_ma,
        g.i_r2_ma,
        g.last_iters
    );
}
