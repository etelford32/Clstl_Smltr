//! physics.rs — pure ring-current physics constants + functions, ported
//! bit-for-bit from js/ring-current-model.js (the reference oracle). No state,
//! no I/O. Kept faithful to the JS so the WASM runtime and the JS module agree
//! (tests/ring-current-kernel-smoke.mjs pins the agreement).

use std::f64::consts::PI;

pub const B0_T: f64 = 3.11e-5; // equatorial surface field (T)
pub const B0_NT: f64 = 3.11e4;
pub const R_E: f64 = 6.371e6; // Earth radius (m)
pub const Q_E: f64 = 1.602176634e-19; // elementary charge (C)
pub const KEV_J: f64 = 1.602176634e-16; // keV → J
pub const OMEGA_E: f64 = 7.2921159e-5; // Earth sidereal rotation (rad/s)
pub const C_LIGHT: f64 = 2.99792458e8;

// Drift denominator L²· and corotation potential amplitude (V·R_E).
pub const B0_RE2: f64 = B0_T * R_E * R_E;
pub const COROT_C: f64 = OMEGA_E * B0_RE2;

#[inline]
fn mu0() -> f64 {
    4.0 * PI * 1e-7
}

/// Dessler–Parker–Sckopke: ring-current energy per nT of |Dst*| (J/nT).
///   W_m = (4π / 3μ₀)·B₀²·R_E³ ;  DPS = (3/2)·W_m / B₀(nT).
pub fn dps_j_per_nt() -> f64 {
    let w_m = (4.0 * PI / (3.0 * mu0())) * B0_T * B0_T * R_E.powi(3);
    1.5 * w_m / B0_NT
}

/// Charge-exchange species (fixes the cross-section AND the mass). Mirrors the
/// JS `cxKey`: H⁺ and He⁺ use `Ion` (proton), O⁺ uses `Oxygen`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Cx {
    Ion,
    Oxygen,
}

/// Charge-exchange cross-section (cm²) with geocoronal H. 0 for non-positive E.
pub fn cx_cross_section(e_kev: f64, cx: Cx) -> f64 {
    if !(e_kev > 0.0) {
        return 0.0;
    }
    match cx {
        Cx::Oxygen => 1.0e-15 / (1.0 + (e_kev / 300.0).powf(1.5)),
        Cx::Ion => 2.0e-15 / (1.0 + (e_kev / 10.0).powi(2)),
    }
}

/// Geocoronal neutral-H density (cm⁻³) at dipole distance L.
pub fn geocoronal_density(l: f64) -> f64 {
    4.4e4 * l.max(1.05).powf(-3.5)
}

fn species_mass_kg(cx: Cx) -> f64 {
    match cx {
        Cx::Oxygen => 2.6567e-26, // O⁺
        Cx::Ion => 1.67262192369e-27, // proton
    }
}

/// Charge-exchange lifetime (hours): τ = 1 / (σ·n_H·v). NaN if undefined.
pub fn cx_lifetime_hours(e_kev: f64, l: f64, cx: Cx) -> f64 {
    let sigma = cx_cross_section(e_kev, cx);
    if sigma <= 0.0 || !(l > 0.0) {
        return f64::NAN;
    }
    let n_h = geocoronal_density(l);
    let m = species_mass_kg(cx);
    let gamma = 1.0 + (e_kev * KEV_J) / (m * C_LIGHT * C_LIGHT);
    let v_cm = C_LIGHT * (1.0 - 1.0 / (gamma * gamma)).sqrt() * 100.0;
    1.0 / (sigma * n_h * v_cm) / 3600.0
}

/// Gradient–curvature drift period (hours) for an equatorially-mirroring ion.
/// NaN for non-positive E or L.
pub fn drift_period_hours(e_kev: f64, l: f64) -> f64 {
    if !(e_kev > 0.0) || !(l > 0.0) {
        return f64::NAN;
    }
    let e_j = e_kev * KEV_J;
    let seconds = (2.0 * PI * Q_E * B0_T * R_E * R_E) / (3.0 * l * e_j);
    seconds / 3600.0
}

/// O⁺ energy fraction vs storm depth: 0.06 + 0.58·(1 − e^(Dst*/180)), Dst* ≤ 0.
pub fn oxygen_fraction(dst_star: f64) -> f64 {
    let d = dst_star.min(0.0);
    0.06 + 0.58 * (1.0 - (d / 180.0).exp())
}

/// Carpenter & Anderson (1992) plasmapause L, clamped.
pub fn plasmapause_l(kp: f64) -> f64 {
    (5.6 - 0.46 * kp).clamp(1.8, 6.5)
}

/// Maynard & Chen (1975) shielded Volland–Stern convection amplitude A(Kp),
/// volts per R_E^γ (γ=2).
pub fn convection_amplitude(kp: f64) -> f64 {
    let k = kp.clamp(0.0, 9.0);
    let denom = 1.0 - 0.159 * k + 0.0093 * k * k;
    0.045 / (denom * denom * denom) * 1e3
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dps_constant() {
        // W_m ≈ 8.3×10¹⁷ J → ≈4.0×10¹³ J per nT of |Dst*|.
        let dps = dps_j_per_nt();
        assert!((dps - 4.0e13).abs() / 4.0e13 < 0.05, "dps {dps:e}");
    }

    #[test]
    fn cross_sections_and_lifetime() {
        // O⁺ decays faster than H⁺ at 100 keV, L=4 (the two-phase recovery).
        let th = cx_lifetime_hours(100.0, 4.0, Cx::Ion);
        let to = cx_lifetime_hours(100.0, 4.0, Cx::Oxygen);
        assert!(th.is_finite() && to.is_finite());
        assert!(to < th, "O+ {to} should be < H+ {th}");
    }

    #[test]
    fn convection_grows_with_kp() {
        assert!(convection_amplitude(7.0) > convection_amplitude(3.0));
        assert!(convection_amplitude(3.0) > convection_amplitude(1.0));
    }

    #[test]
    fn oxygen_fraction_deepens() {
        assert!((oxygen_fraction(0.0) - 0.06).abs() < 1e-9);
        assert!(oxygen_fraction(-150.0) > 0.3);
    }
}
