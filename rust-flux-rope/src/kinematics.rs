//! Drag-based model (DBM) kinematics + self-similar expansion laws.
//! Spec: FLUX_ROPE_PHYSICS_SPEC.md §5 (Vršnak et al. 2013 closed form —
//! no ODE integration, so the ensemble layer pays zero stepping cost).

pub const AU_KM: f64 = 1.495_978_707e8;
pub const RSUN_KM: f64 = 6.957e5;

/// DBM state: launch apex distance/speed, ambient wind, drag parameter.
#[derive(Clone, Copy, Debug)]
pub struct Dbm {
    pub d0_km: f64,
    pub v0_kms: f64,
    pub w_kms: f64,
    /// Drag parameter Γ [km⁻¹]; typical 0.1e-7 … 2e-7.
    pub gamma_per_km: f64,
}

impl Dbm {
    /// Apex speed at t seconds after launch [km/s].
    pub fn speed_kms(&self, t_s: f64) -> f64 {
        let dv0 = self.v0_kms - self.w_kms;
        if self.gamma_per_km.abs() < 1e-30 || dv0 == 0.0 {
            return self.v0_kms;
        }
        self.w_kms + dv0 / (1.0 + self.gamma_per_km * dv0.abs() * t_s)
    }

    /// Apex heliocentric distance at t seconds after launch [km].
    pub fn apex_km(&self, t_s: f64) -> f64 {
        let dv0 = self.v0_kms - self.w_kms;
        if self.gamma_per_km.abs() < 1e-30 || dv0 == 0.0 {
            // Γ→0 degenerates to ballistic (guard the ln/Γ division).
            return self.d0_km + self.v0_kms * t_s;
        }
        let sgn = dv0.signum();
        self.d0_km
            + self.w_kms * t_s
            + sgn * (1.0 + self.gamma_per_km * dv0.abs() * t_s).ln() / self.gamma_per_km
    }
}

/// Axial field strength at apex distance d: B₁AU · (d/AU)^(−n_B). [nT]
pub fn b_axis_nt(b_1au_nt: f64, d_km: f64, n_b: f64) -> f64 {
    b_1au_nt * (d_km / AU_KM).powf(-n_b)
}

/// Apex cross-section minor radius: σ₁AU · (d/AU)^(n_σ). [km]
pub fn sigma_apex_km(sigma_1au_km: f64, d_km: f64, n_sigma: f64) -> f64 {
    sigma_1au_km * (d_km / AU_KM).powf(n_sigma)
}

// ── Sheath (spec §14) ────────────────────────────────────────────────────────

/// Fixed ambient fast-magnetosonic speed near 1 AU [km/s] (√(v_A²+c_s²) for
/// typical B≈5 nT, n≈5 cm⁻³, T≈1e5 K). A shock — and therefore a sheath —
/// exists only while the apex outruns the ambient wind by more than this.
pub const V_MS_KMS: f64 = 70.0;

/// Fast-shock magnetosonic Mach number of the apex (0 when sub-magnetosonic).
pub fn shock_mach(v_apex_kms: f64, w_kms: f64) -> f64 {
    ((v_apex_kms - w_kms) / V_MS_KMS).max(0.0)
}

/// Rankine–Hugoniot density/field compression ratio for a perpendicular fast
/// shock, γ = 5/3: X = (γ+1)M² / ((γ−1)M² + 2), → 1 at M = 1, capped at 4.
pub fn compression_ratio(mach: f64) -> f64 {
    if mach <= 1.0 {
        return 1.0;
    }
    let m2 = mach * mach;
    ((8.0 / 3.0) * m2 / ((2.0 / 3.0) * m2 + 2.0)).min(4.0)
}

/// Ambient (Parker-spiral) field magnitude at heliocentric distance d [nT].
pub fn b_ambient_nt(b_amb_1au_nt: f64, d_km: f64) -> f64 {
    b_amb_1au_nt * (d_km / AU_KM).powf(-1.6)
}

#[cfg(test)]
mod tests {
    use super::*;

    const DBM: Dbm = Dbm { d0_km: 21.5 * RSUN_KM, v0_kms: 1100.0, w_kms: 400.0, gamma_per_km: 0.2e-7 };

    #[test]
    fn dbm_matches_numeric_integration() {
        // RK4 the ODE dv/dt = −Γ(v−w)|v−w| and compare against the closed form.
        let (mut v, mut d, dt) = (DBM.v0_kms, DBM.d0_km, 10.0);
        let acc = |v: f64| -DBM.gamma_per_km * (v - DBM.w_kms) * (v - DBM.w_kms).abs();
        let mut t = 0.0;
        while t < 180_000.0 {
            let k1 = acc(v);
            let k2 = acc(v + 0.5 * dt * k1);
            let k3 = acc(v + 0.5 * dt * k2);
            let k4 = acc(v + dt * k3);
            let dv = dt * (k1 + 2.0 * k2 + 2.0 * k3 + k4) / 6.0;
            d += v * dt + 0.5 * dv * dt; // trapezoid-ish position update
            v += dv;
            t += dt;
        }
        assert!((v - DBM.speed_kms(t)).abs() < 0.5, "v {} vs {}", v, DBM.speed_kms(t));
        assert!((d - DBM.apex_km(t)).abs() / DBM.apex_km(t) < 1e-4);
    }

    #[test]
    fn dbm_decelerates_toward_ambient() {
        assert!(DBM.speed_kms(0.0) == 1100.0);
        let v50h = DBM.speed_kms(50.0 * 3600.0);
        assert!(v50h < 1100.0 && v50h > DBM.w_kms);
        // Very late: asymptotically the ambient wind.
        assert!((DBM.speed_kms(1e8) - DBM.w_kms).abs() < 5.0);
    }

    #[test]
    fn dbm_st_patrick_class_transit() {
        // v0=1100, w=400, Γ=0.2e-7 → ~1 AU in ≈50 h (the Mar 2015 transit).
        let d50h = DBM.apex_km(50.0 * 3600.0);
        assert!((d50h / AU_KM - 1.0).abs() < 0.02, "50h apex = {} AU", d50h / AU_KM);
    }

    #[test]
    fn dbm_slow_cme_accelerates() {
        let slow = Dbm { v0_kms: 300.0, ..DBM };
        let v = slow.speed_kms(100_000.0);
        assert!(v > 300.0 && v < 400.0);
        assert!(slow.apex_km(100_000.0) > slow.d0_km + 300.0 * 100_000.0);
    }

    #[test]
    fn gamma_zero_is_ballistic() {
        let b = Dbm { gamma_per_km: 0.0, ..DBM };
        assert!((b.apex_km(1000.0) - (b.d0_km + 1100.0 * 1000.0)).abs() < 1e-6);
        assert_eq!(b.speed_kms(99_999.0), 1100.0);
    }

    #[test]
    fn scaling_laws_anchor_at_1au() {
        assert!((b_axis_nt(25.0, AU_KM, 1.64) - 25.0).abs() < 1e-12);
        assert!((sigma_apex_km(0.115 * AU_KM, AU_KM, 1.14) - 0.115 * AU_KM).abs() < 1e-6);
        // Falloff direction: stronger/thinner closer in.
        assert!(b_axis_nt(25.0, 0.1 * AU_KM, 1.64) > 25.0 * 40.0);
        assert!(sigma_apex_km(0.115 * AU_KM, 0.1 * AU_KM, 1.14) < 0.115 * AU_KM * 0.1);
    }
}
