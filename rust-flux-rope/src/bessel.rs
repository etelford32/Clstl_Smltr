//! Bessel J0/J1 polynomial approximations (Abramowitz & Stegun 9.4.1 / 9.4.4).
//!
//! The Lundquist profile only ever evaluates on 0 ≤ x ≤ 2.4048 (α·s with s
//! inside the rope boundary at the first J0 zero), so the |x| ≤ 3 branch is
//! the whole story. |ε| < 5e-8 (J0) / 1.3e-8·x (J1) — far below nT precision.

/// J0(x) for |x| ≤ 3.
pub fn j0(x: f64) -> f64 {
    debug_assert!(x.abs() <= 3.0);
    let y = (x / 3.0) * (x / 3.0);
    1.0 + y * (-2.249_999_7
        + y * (1.265_620_8
            + y * (-0.316_386_6
                + y * (0.044_447_9 + y * (-0.003_944_4 + y * 0.000_210_0)))))
}

/// J1(x) for |x| ≤ 3.
pub fn j1(x: f64) -> f64 {
    debug_assert!(x.abs() <= 3.0);
    let y = (x / 3.0) * (x / 3.0);
    x * (0.5
        + y * (-0.562_499_85
            + y * (0.210_935_73
                + y * (-0.039_542_89
                    + y * (0.004_433_19 + y * (-0.000_317_61 + y * 0.000_011_09))))))
}

/// First zero of J0 — the Lundquist boundary condition α·σ = J0_ZERO1.
pub const J0_ZERO1: f64 = 2.404_825_557_695_773;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn j0_reference_values() {
        // Handbook values: J0(0)=1, J0(1)=0.7651976866, J0(2.4048...)≈0.
        assert!((j0(0.0) - 1.0).abs() < 1e-9);
        assert!((j0(1.0) - 0.765_197_686_6).abs() < 5e-8);
        assert!(j0(J0_ZERO1).abs() < 5e-7);
    }

    #[test]
    fn j1_reference_values() {
        // J1(0)=0, J1(1)=0.4400505857, J1(2.4048)≈0.5191474973.
        assert!(j1(0.0).abs() < 1e-12);
        assert!((j1(1.0) - 0.440_050_585_7).abs() < 5e-8);
        assert!((j1(J0_ZERO1) - 0.519_147_497_3).abs() < 5e-7);
    }
}
