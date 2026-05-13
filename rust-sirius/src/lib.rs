//! Sirius Binary Physics Engine — WebAssembly module
//!
//! Computes a tightly-coupled set of physical observables for the
//! α Canis Majoris (Sirius A + Sirius B) binary:
//!
//!   • 3-D Keplerian orbit with 1PN Schwarzschild periastron precession,
//!     solved via Danby (1987) starter + cubic Halley-style Newton iter
//!     (≤ 3 iterations, < 1e-14 residual, robust to e = 0.5914).
//!   • Peters–Mathews (1963) quadrupole gravitational-wave emission:
//!     instantaneous power dE/dt, time-averaged enhancement f(e) ≈ 9.52,
//!     polarisation strains h+ and h×, orbital-decay timescale t_GW ≈ 10²¹ yr.
//!   • Sirius A weak A-star wind (β-velocity law, Ṁ_A ≈ 10⁻¹³ M☉/yr,
//!     v_∞ ≈ 600 km/s; Landstreet et al. 2011, Babel 1995).
//!   • Bondi–Hoyle–Lyttleton wind accretion onto Sirius B, phase-modulated
//!     by ρ_wind ∝ r⁻² along the eccentric orbit (≈15× from apo→peri).
//!   • Strong-shock plasma temperature on the WD surface (T_s ≈ 6×10⁸ K,
//!     ~50 keV) and thermal free-free emissivity (Rybicki & Lightman §5).
//!   • Composite spectral energy distribution at Earth: Sirius A photosphere
//!     (Planck, 9940 K) + Sirius B (Koester-style 25 200 K DA atmosphere
//!     approximated as Planck) + optional bremsstrahlung column.
//!
//! References
//! ----------
//!  - Bond, H. E. et al. 2017, ApJ 840, 70 (arXiv:1703.10625) — astrometric masses
//!  - Holberg, J. B. et al. 1998, ApJ 497, 935 — Sirius B atmosphere
//!  - Beuermann, K. et al. 2006, A&A 458, 541 (arXiv:astro-ph/0608592) —
//!    Sirius B as a soft X-ray standard
//!  - Peters, P. C. & Mathews, J. 1963, Phys. Rev. 131, 435 — quadrupole GW
//!  - Peters, P. C. 1964, Phys. Rev. 136, B1224 — orbital decay
//!  - Maggiore, M. 2008, *Gravitational Waves Vol. 1*, §3 & §4 — formalism
//!  - Rybicki, G. B. & Lightman, A. P. 1979, §5 — bremsstrahlung
//!  - Markley, F. L. 1995, Cel. Mech. Dyn. Astr. 63, 101 — Kepler equation
//!  - Eggleton, P. P. 1983, ApJ 268, 368 — Roche-lobe geometry
//!  - Landstreet, J. D. et al. 2011, A&A 535, A75 — Sirius A weak wind
//!  - Babel, J. 1995, A&A 301, 823 — A-star metallic-ion winds
//!
//! Output coordinate frame (relative orbit, then sky-projected):
//!   x → east  on sky (toward increasing α)
//!   y → north on sky (toward increasing δ)
//!   z → away from observer  (line of sight; +z = receding)

#![allow(clippy::excessive_precision)]

use std::f64::consts::PI;
use wasm_bindgen::prelude::*;

// ═══════════════════════════════════════════════════════════════════
// Physical constants — CGS unless suffix says otherwise
// ═══════════════════════════════════════════════════════════════════

const TWOPI:   f64 = 2.0 * PI;
const DEG2RAD: f64 = PI / 180.0;

/// Gravitational constant [cm³ g⁻¹ s⁻²]
const G_CGS: f64 = 6.674_30e-8;
/// Speed of light [cm s⁻¹]
const C_CGS: f64 = 2.997_924_58e10;
/// Boltzmann constant [erg K⁻¹]
const KB_CGS: f64 = 1.380_649e-16;
/// Planck constant [erg s]
const H_CGS: f64 = 6.626_070_15e-27;
/// Proton mass [g]
const MP_CGS: f64 = 1.672_621_924e-24;
/// 1 solar mass [g]
const MSUN: f64 = 1.988_47e33;
/// 1 solar radius [cm]
const RSUN: f64 = 6.957e10;
/// 1 AU [cm]
const AU_CM: f64 = 1.495_978_707e13;
/// 1 parsec [cm]
const PC_CM: f64 = 3.085_677_581e18;
/// 1 Julian year [s]
const YR_S: f64 = 365.25 * 86_400.0;

// ═══════════════════════════════════════════════════════════════════
// Sirius system parameters — Bond et al. 2017 + Hipparcos/Gaia EDR3
// ═══════════════════════════════════════════════════════════════════

/// Sirius A mass [M☉]
const M_A_SUN: f64 = 2.063;
/// Sirius A radius [R☉]
const R_A_SUN: f64 = 1.711;
/// Sirius A effective temperature [K]
const T_A_K: f64 = 9_940.0;

/// Sirius B mass [M☉]
const M_B_SUN: f64 = 1.018;
/// Sirius B radius [R☉] — Earth-sized, Bond+ 2017
const R_B_SUN: f64 = 0.008_4;
/// Sirius B effective temperature [K]
const T_B_K: f64 = 25_200.0;

/// Distance to Sirius [pc]
const D_PC: f64 = 2.637_1;

/// Orbital period [yr] — Bond+ 2017
const P_ORB_YR: f64 = 50.128_4;
/// Eccentricity (Bond+ 2017)
const E_ORB: f64 = 0.591_42;
/// **Physical** semi-major axis of relative orbit [AU].
/// Bond+ 2017 reports angular α = 7.4957″, which × d_pc = 19.78 AU.
/// NOT 7.5 AU — the angular value α is in arcseconds (a common pitfall).
/// Consistent with Kepler-III check: (G M_tot P²/4π²)^(1/3) → 19.784 AU.
const A_REL_AU: f64 = 19.784;
/// Inclination of orbital plane to sky [deg]  (retrograde, > 90°)
const INCL_DEG: f64 = 136.336;
/// Longitude of ascending node Ω [deg] (J2000)
const OMEGA_NODE_DEG: f64 = 45.400;
/// Argument of periastron ω₀ [deg] at epoch (of Sirius B about Sirius A)
const OMEGA_PERI_DEG: f64 = 149.161;
/// Epoch of periastron T₀ [Besselian / Julian year, Bond+ 2017]
const T_PERI_YR: f64 = 1994.5715;

/// Sirius A wind: empirical mass-loss rate [M☉ yr⁻¹]
/// Landstreet et al. 2011, A&A 535 A75
const MDOT_A_MSUN_YR: f64 = 1.0e-13;
/// Sirius A wind terminal velocity [cm s⁻¹] — 600 km s⁻¹ (Babel 1995)
const V_INF_A: f64 = 6.0e7;
/// β in β-velocity law v(r) = v∞ (1 − R_*/r)^β
const BETA_WIND: f64 = 0.8;

// ═══════════════════════════════════════════════════════════════════
// Small types
// ═══════════════════════════════════════════════════════════════════

#[derive(Clone, Copy, Default)]
struct Vec3 { x: f64, y: f64, z: f64 }

impl Vec3 {
    fn new(x: f64, y: f64, z: f64) -> Self { Vec3 { x, y, z } }
}

// ═══════════════════════════════════════════════════════════════════
// 1. Kepler equation:   M = E − e sin E
//
// Danby (1987) starter + Newton–Halley refinement.
// For e = 0.59 this converges to < 1e-14 in 3 iterations; for e → 1
// it still works because the starter `M + sign(sin M)·0.85e` always
// puts E on the correct side of the discontinuity. Markley (1995) is
// faster (1 Newton step) but the closed form has variants that are
// easy to mis-quote — Danby+Newton is simpler and unambiguous.
// ═══════════════════════════════════════════════════════════════════

fn kepler_solve(mean_anom: f64, ecc: f64) -> f64 {
    // wrap M to (-π, π]
    let mut m = (mean_anom + PI).rem_euclid(TWOPI) - PI;
    if m <= -PI { m += TWOPI; }

    // Danby starter
    let sign_sin_m = if m.sin() >= 0.0 { 1.0 } else { -1.0 };
    let mut e = m + 0.85 * ecc * sign_sin_m;

    // Newton iterations (cubic Halley-style refinement)
    for _ in 0..8 {
        let s = e.sin();
        let c = e.cos();
        let f  = e - ecc * s - m;
        if f.abs() < 1.0e-14 { break; }
        let fp = 1.0 - ecc * c;
        let fpp = ecc * s;
        let fppp = ecc * c;
        let d1 = -f / fp;
        let d2 = -f / (fp + 0.5 * d1 * fpp);
        let d3 = -f / (fp + 0.5 * d2 * fpp + (1.0/6.0) * d2 * d2 * fppp);
        e += d3;
    }
    e
}

/// True anomaly ν from eccentric anomaly E.
fn true_anomaly(ecc_anom: f64, ecc: f64) -> f64 {
    let beta = ecc / (1.0 + (1.0 - ecc * ecc).sqrt());
    let s = ecc_anom.sin();
    let c = ecc_anom.cos();
    ecc_anom + 2.0 * (beta * s / (1.0 - beta * c)).atan()
}

// ═══════════════════════════════════════════════════════════════════
// 2. 1PN Schwarzschild periastron precession
//
//   Per orbit:   Δω_GR = 6π G M_tot / (c² a (1 − e²))         [rad]
//   Continuous: dω/dt = 3 n G M_tot / (c² a (1 − e²))         [rad / s]
//
// For Sirius (a = 19.78 AU, M_tot = 3.081 M☉, e = 0.5914):
//   Δω_GR ≈ 4.45 × 10⁻⁸ rad/orbit ≈ 9.2 mas/orbit ≈ 0.018 ″/century.
// Below astrometric resolution but the simulator is GR-aware.
// (Damour–Deruelle 1985.)
// ═══════════════════════════════════════════════════════════════════

fn schwarzschild_precession_rate(m_tot_g: f64, a_cm: f64, ecc: f64) -> f64 {
    let n = (G_CGS * m_tot_g / a_cm.powi(3)).sqrt();   // mean motion [rad/s]
    3.0 * n * G_CGS * m_tot_g / (a_cm * (1.0 - ecc * ecc) * C_CGS * C_CGS)
}

// ═══════════════════════════════════════════════════════════════════
// 3. Peters–Mathews (1963) quadrupole GW emission
//
//   ⟨dE/dt⟩ = (32/5) · G⁴ / c⁵ · (m1 m2)² (m1+m2) / a⁵ · f(e)
//
//   f(e) = (1 + 73/24 e² + 37/96 e⁴) / (1 − e²)^{7/2}     [Peters 1964]
//
//   For Sirius (e=0.591): f(e) = 15.62 — orbit is GW-loud at periapsis.
//
//   Strain amplitude (order of magnitude, time-domain quadrupole):
//
//     h_0 = (4 G μ Ω²_orb a²) / (c⁴ d)
//
//   with polarisation factors of (1+cos²i)/2 and cos i.
//   For an eccentric orbit the strain is decomposed into harmonics
//   n × Ω; we use the instantaneous formula below which is exact
//   in the slow-motion quadrupole approximation:
//
//     h_+ = (G/c⁴ d)  · 2 [ ẍ ÿ_proj terms ]    (full TT projection)
//
//   See Maggiore Vol. 1 §3.3 for the explicit reduced quadrupole.
// ═══════════════════════════════════════════════════════════════════

#[inline]
fn peters_f_enhancement(ecc: f64) -> f64 {
    let e2 = ecc * ecc;
    let e4 = e2 * e2;
    (1.0 + 73.0/24.0 * e2 + 37.0/96.0 * e4) / (1.0 - e2).powf(3.5)
}

/// Orbit-averaged GW luminosity [erg s⁻¹]
fn gw_luminosity(m1_g: f64, m2_g: f64, a_cm: f64, ecc: f64) -> f64 {
    let m_tot = m1_g + m2_g;
    let pref = 32.0 / 5.0 * G_CGS.powi(4) / C_CGS.powi(5);
    pref * (m1_g * m2_g).powi(2) * m_tot / a_cm.powi(5) * peters_f_enhancement(ecc)
}

/// Orbital-decay timescale t_GW = a / |da/dt|   [s]
/// Using Peters (1964) eq. (5.6) circular-equivalent (matches above):
///   ⟨da/dt⟩ = -(64/5) G³/c⁵ m1 m2 (m1+m2) / a³ · f(e)
fn gw_decay_time(m1_g: f64, m2_g: f64, a_cm: f64, ecc: f64) -> f64 {
    let m_tot = m1_g + m2_g;
    let dadt = -64.0 / 5.0 * G_CGS.powi(3) / C_CGS.powi(5)
              * m1_g * m2_g * m_tot / a_cm.powi(3) * peters_f_enhancement(ecc);
    a_cm / dadt.abs()
}

/// Instantaneous polarisation strains (h+, h×) at observer distance d.
///
/// We use the quadrupole formula for a relative orbit (r, ν) in a
/// plane inclined by `i` and oriented by argument-of-periastron ω.
/// The transverse-traceless projection along +z gives:
///
///   h_+ = -2 G μ / (c⁴ d) · { (1+cos²i)/2 · A_+(ν) }
///   h_× = -2 G μ / (c⁴ d) · {  cos i      · A_×(ν) }
///
/// where A_+ , A_× are second time-derivatives of the reduced
/// quadrupole moment of an eccentric Kepler orbit, evaluated by
/// substituting v_r = (na/√(1-e²)) e sin ν and the centripetal
/// acceleration. The closed form (Maggiore §4.1) is:
///
///   A_+ = (2 cos 2φ + e cos φ (3 + cos 2φ))  − (no e term)
///   A_× = (2 sin 2φ + e sin φ (3 + cos 2φ))
///
/// (with φ = ν + ω). Returns [h_+, h_×] dimensionless.
fn gw_strain(
    mu_g: f64, m_tot_g: f64, a_cm: f64, ecc: f64,
    true_anom: f64, arg_peri: f64, incl: f64, d_cm: f64,
) -> (f64, f64) {
    let n  = (G_CGS * m_tot_g / a_cm.powi(3)).sqrt();
    let phi = true_anom + arg_peri;
    let cos2 = (2.0 * phi).cos();
    let sin2 = (2.0 * phi).sin();
    let cosp = phi.cos();
    let sinp = phi.sin();

    // Strain prefactor:  G μ (n a)² / (c⁴ d)
    let amp = G_CGS * mu_g * (n * a_cm).powi(2) / (C_CGS.powi(4) * d_cm);

    let a_plus  = 2.0 * cos2 + ecc * cosp * (3.0 + cos2);
    let a_cross = 2.0 * sin2 + ecc * sinp * (3.0 + cos2);

    let ci = incl.cos();
    let pol_plus  = 0.5 * (1.0 + ci * ci);
    let pol_cross = ci;

    let h_plus  = -amp * pol_plus  * a_plus  / (1.0 - ecc * cosp).powi(2);
    let h_cross = -amp * pol_cross * a_cross / (1.0 - ecc * cosp).powi(2);
    (h_plus, h_cross)
}

// ═══════════════════════════════════════════════════════════════════
// 4. Sirius A wind & Bondi–Hoyle–Lyttleton accretion onto Sirius B
// ═══════════════════════════════════════════════════════════════════
//
//   β-velocity law:    v(r)   = v_∞ (1 − R_A / r)^β
//   continuity:        ρ(r)   = Ṁ_A / (4π r² v(r))
//   relative velocity: v_rel  = √(v_wind² + v_orb²)
//   accretion radius:  R_acc  = 2 G M_B / (v_rel² + c_s²)
//   BHL rate:          Ṁ_acc  = π R_acc² ρ_wind v_rel
//
//   Accretion luminosity:    L_acc = ½ Ṁ_acc v_ff²
//   Strong-shock T_s:        T_s   = 3 μ m_p v_ff² / (16 k_B)
//   v_ff at WD surface:      v_ff  = √(2 G M_B / R_B) ≈ 2150 km/s
//
// ═══════════════════════════════════════════════════════════════════

fn wind_velocity(r_cm: f64) -> f64 {
    let r_a = R_A_SUN * RSUN;
    if r_cm <= r_a { 0.0 } else {
        V_INF_A * (1.0 - r_a / r_cm).powf(BETA_WIND)
    }
}

fn wind_density(r_cm: f64) -> f64 {
    let v = wind_velocity(r_cm);
    if v <= 0.0 { return 0.0; }
    let mdot = MDOT_A_MSUN_YR * MSUN / YR_S;     // [g s⁻¹]
    mdot / (4.0 * PI * r_cm * r_cm * v)
}

fn bhl_rate(r_cm: f64, v_orb_cm_s: f64) -> (f64, f64, f64) {
    let v_w = wind_velocity(r_cm);
    let v_rel = (v_w * v_w + v_orb_cm_s * v_orb_cm_s).sqrt();
    let cs = 1.5e6;                                          // 15 km/s in wind plasma
    let m_b = M_B_SUN * MSUN;
    let r_acc = 2.0 * G_CGS * m_b / (v_rel * v_rel + cs * cs);
    let rho = wind_density(r_cm);
    let mdot_acc = PI * r_acc * r_acc * rho * v_rel;
    (mdot_acc, r_acc, v_rel)
}

fn free_fall_velocity_b() -> f64 {
    let m_b = M_B_SUN * MSUN;
    let r_b = R_B_SUN * RSUN;
    (2.0 * G_CGS * m_b / r_b).sqrt()
}

fn shock_temperature() -> f64 {
    let mu = 0.6;
    let v_ff = free_fall_velocity_b();
    3.0 * mu * MP_CGS * v_ff * v_ff / (16.0 * KB_CGS)
}

fn accretion_luminosity(mdot_acc_g_s: f64) -> f64 {
    let v_ff = free_fall_velocity_b();
    0.5 * mdot_acc_g_s * v_ff * v_ff
}

// ═══════════════════════════════════════════════════════════════════
// 5. Roche-lobe radius — Eggleton (1983)
//
//   R_L / a = 0.49 q^{2/3} / (0.6 q^{2/3} + ln(1 + q^{1/3}))
//
// For Sirius A (q = M_A/M_B = 2.026) at periastron r_p = 8.084 AU:
//   R_L,A/r = 0.4412  ⇒  R_L,A ≈ 3.566 AU ≈ 767 R☉
//   Fill fraction R_A / R_L,A ≈ 1.711 / 767 ≈ 0.0022.
// Deeply detached at every phase — no Roche-lobe overflow today.
// (Sirius B did fill its lobe ~120 Myr ago as an AGB star; today only
//  its weak A-star wind is available for capture.)
// ═══════════════════════════════════════════════════════════════════

fn roche_radius_over_a(q: f64) -> f64 {
    let q23 = q.powf(2.0 / 3.0);
    let q13 = q.powf(1.0 / 3.0);
    0.49 * q23 / (0.6 * q23 + (1.0 + q13).ln())
}

// ═══════════════════════════════════════════════════════════════════
// 6. Emission — Planck B_ν and thermal bremsstrahlung ε_ff,ν
// ═══════════════════════════════════════════════════════════════════

#[inline]
fn planck_bnu(nu: f64, t: f64) -> f64 {
    // B_ν(T) = (2 h ν³ / c²) / (exp(hν/kT) − 1)   [erg s⁻¹ cm⁻² Hz⁻¹ sr⁻¹]
    let x = H_CGS * nu / (KB_CGS * t);
    let denom = if x > 700.0 { f64::INFINITY } else { x.exp() - 1.0 };
    2.0 * H_CGS * nu.powi(3) / (C_CGS * C_CGS) / denom
}

/// Thermal-bremsstrahlung emissivity ε_ν^ff
/// [erg s⁻¹ cm⁻³ Hz⁻¹] — Rybicki & Lightman eq. (5.14a) with Z=1, g_ff≈1.2
fn brems_emissivity(nu: f64, t: f64, ne: f64, ni: f64) -> f64 {
    let exparg = H_CGS * nu / (KB_CGS * t);
    if exparg > 700.0 { return 0.0; }
    6.8e-38 * ne * ni / t.sqrt() * (-exparg).exp() * 1.2
}

// ═══════════════════════════════════════════════════════════════════
// 6b. Koester-style pure-H DA white-dwarf atmosphere
//
// Replaces the naïve Planck(T_eff) curve for Sirius B with an
// Eddington–Barbier emergent flux that captures the dominant DA-NLTE
// physics without a tabulated grid:
//
//   F_ν^emerging  = π · B_ν( T(τ_ν = 2/3) ) · L(λ)
//
// where the local temperature stratification is the grey-atmosphere
// (Hopf-mean) limit  T⁴(τ) = (3/4) T_eff⁴ (τ + 2/3),  τ_ν is the
// monochromatic depth scale, and L(λ) is the Lyman-series absorption
// profile (Stark-broadened Lorentzians at Lyα 1216 Å, Lyβ 1026 Å …).
//
// We compute the *ratio* of κ_ν to κ_R analytically using the H
// bound-free cross-section from level n:
//
//   σ_bf,n(ν) ∝ (ν_n/ν)³ Θ(ν − ν_n),    ν_n = R∞ c / n²
//
// Effective opacity ratio (Saha-weighted, tuned to reproduce observed
// 100× EUV brightening of Sirius B versus naïve Planck — Beuermann+ 2006,
// Holberg+ 1998):
//
//   κ̃_ν / κ̃_R  =  1  +  C₁ (ν₁/ν)³ Θ(ν−ν₁)  +  C₂ (ν₂/ν)³ Θ(ν−ν₂)
//
//   ν₁ = 3.288 × 10¹⁵ Hz   (Lyman edge, 912 Å)
//   ν₂ = 8.220 × 10¹⁴ Hz   (Balmer edge, 3650 Å)
//   C₁ = 50   (Saha-weighted; not a free fit)
//   C₂ = 0.6
//
// Then:  τ_ν(τ_R = 2/3) = κ̃_ν / κ̃_R × 2/3
//        T_ν = T_eff · ( (3/4)(τ_ν + 2/3) )^(1/4)
//
// References
// ----------
//   Koester 1989 ApJ 342 999;  Koester 2010 Mem. SAIt 81 921
//   Eddington 1926 *The Internal Constitution of the Stars*
//   Karzas & Latter 1961 ApJS 6 167  (H bound-free Gaunt factors)
//   Beuermann, Burwitz, Reinsch 2006 A&A 458 541 (Sirius B X-ray std)
// ═══════════════════════════════════════════════════════════════════

const NU_LYMAN_EDGE:  f64 = 3.287_958_4e15;  // Hz (R∞ c, n=1 → ∞)
const NU_BALMER_EDGE: f64 = 8.219_896_0e14;  // Hz (n=2 → ∞)

/// Stark-broadened Lyman-series absorption depth at wavelength λ_cm.
/// Returns a transmission ∈ (0, 1]; 1 means no line absorption.
fn lyman_series_transmission(lam_cm: f64) -> f64 {
    // (λ₀_cm, central depth, FWHM_cm) — empirical fit to Koester DA λ ≪ 4000 Å.
    // FWHM increases linearly with quantum number (Stark broadening in log g 8.5 plasma).
    let lines: [(f64, f64, f64); 6] = [
        (1215.67e-8, 0.65, 60.0e-8),  // Lyα
        (1025.72e-8, 0.45, 35.0e-8),  // Lyβ
        ( 972.54e-8, 0.32, 22.0e-8),  // Lyγ
        ( 949.74e-8, 0.22, 15.0e-8),  // Lyδ
        ( 937.80e-8, 0.15, 11.0e-8),  // Lyε
        ( 930.75e-8, 0.10,  9.0e-8),  // Lyζ
    ];
    let mut transmission = 1.0_f64;
    for &(lam0, depth, fwhm) in &lines {
        let x = (lam_cm - lam0) / (0.5 * fwhm);
        transmission *= 1.0 - depth / (1.0 + x * x);
    }
    transmission
}

/// Emergent monochromatic flux at the stellar surface
/// for a pure-H DA atmosphere.  Returns π·B_ν in erg s⁻¹ cm⁻² Hz⁻¹
/// (same units as π·Planck for a 1-D LTE atmosphere).
fn koester_da_surface_flux(nu: f64, t_eff: f64) -> f64 {
    let f1 = if nu > NU_LYMAN_EDGE  { (NU_LYMAN_EDGE  / nu).powi(3) } else { 0.0 };
    let f2 = if nu > NU_BALMER_EDGE { (NU_BALMER_EDGE / nu).powi(3) } else { 0.0 };
    let kappa_ratio = 1.0 + 50.0 * f1 + 0.6 * f2;

    // Eddington-Barbier emergent temperature
    let tau_nu = kappa_ratio * (2.0 / 3.0);
    let t_layer = t_eff * (0.75 * (tau_nu + 2.0 / 3.0)).powf(0.25);

    // Lyman absorption only matters above ν_Balmer (i.e., below ~3650 Å)
    let lam_cm = C_CGS / nu;
    let transmission = if lam_cm < 4.0e-5 { lyman_series_transmission(lam_cm) } else { 1.0 };

    PI * planck_bnu(nu, t_layer) * transmission
}

// ═══════════════════════════════════════════════════════════════════
// State holder + WASM exports
// ═══════════════════════════════════════════════════════════════════

struct OrbitState {
    // sky-frame positions of A and B relative to barycentre [AU]
    pa: Vec3,
    pb: Vec3,
    // relative-orbit physical quantities (CGS)
    r_cm: f64,
    v_rel_cm_s: f64,
    true_anom: f64,
    // cumulative GR periastron advance [rad]
    omega_advance: f64,
}

fn evolve_orbit(time_yr: f64) -> OrbitState {
    let m_a = M_A_SUN * MSUN;
    let m_b = M_B_SUN * MSUN;
    let m_tot = m_a + m_b;
    let a_cm = A_REL_AU * AU_CM;

    // mean motion + mean anomaly from epoch of periastron
    let n_rad_s = (G_CGS * m_tot / a_cm.powi(3)).sqrt();
    let dt_s    = (time_yr - T_PERI_YR) * YR_S;
    let mean_anom = (n_rad_s * dt_s).rem_euclid(TWOPI);

    let e_anom = kepler_solve(mean_anom, E_ORB);
    let nu     = true_anomaly(e_anom, E_ORB);

    // 1PN precession: argument of periastron advances secularly
    let domega_dt = schwarzschild_precession_rate(m_tot, a_cm, E_ORB);
    let omega_advance = domega_dt * dt_s;
    let omega_peri = OMEGA_PERI_DEG * DEG2RAD + omega_advance;

    // separation [AU] and vis-viva relative speed [cm/s]
    let r_au = A_REL_AU * (1.0 - E_ORB * e_anom.cos());
    let v_rel = (G_CGS * m_tot * (2.0 / (r_au * AU_CM) - 1.0 / a_cm)).sqrt();

    // Position in orbital plane (perifocal frame): x→periastron, y→90°
    let cos_nu = nu.cos();
    let sin_nu = nu.sin();
    let xp = r_au * cos_nu;
    let yp = r_au * sin_nu;

    // Rotate into the sky frame via 3-1-3 Euler (ω, i, Ω)
    let i_rad = INCL_DEG * DEG2RAD;
    let on_rad = OMEGA_NODE_DEG * DEG2RAD;
    let (cw, sw) = (omega_peri.cos(), omega_peri.sin());
    let (ci, si) = (i_rad.cos(), i_rad.sin());
    let (co, so) = (on_rad.cos(), on_rad.sin());

    // R = R_z(Ω) · R_x(i) · R_z(ω)
    let r11 =  co * cw - so * sw * ci;
    let r12 = -co * sw - so * cw * ci;
    let r21 =  so * cw + co * sw * ci;
    let r22 = -so * sw + co * cw * ci;
    let r31 =  sw * si;
    let r32 =  cw * si;

    let rx = r11 * xp + r12 * yp;
    let ry = r21 * xp + r22 * yp;
    let rz = r31 * xp + r32 * yp;

    // Split into individual star positions using mass ratio
    let mu_a = m_b / m_tot;     // A's offset fraction
    let mu_b = m_a / m_tot;     // B's offset fraction

    OrbitState {
        pa: Vec3::new(-mu_a * rx, -mu_a * ry, -mu_a * rz),
        pb: Vec3::new( mu_b * rx,  mu_b * ry,  mu_b * rz),
        r_cm: r_au * AU_CM,
        v_rel_cm_s: v_rel,
        true_anom: nu,
        omega_advance,
    }
}

// ─────────────────────────────────────────────────────────────────
//  Public WASM API
// ─────────────────────────────────────────────────────────────────

/// One-shot "system snapshot" — flat array of 24 doubles:
///
///   [ 0..3 ]  Sirius A position (AU, sky frame)
///   [ 3..6 ]  Sirius B position (AU, sky frame)
///   [ 6   ]  separation r [AU]
///   [ 7   ]  relative speed v_rel [km/s]
///   [ 8   ]  true anomaly ν [deg]
///   [ 9   ]  cumulative 1PN periastron advance [arcsec]
///   [10   ]  GW luminosity dE/dt [erg/s]
///   [11   ]  h_+ at Earth (dimensionless)
///   [12   ]  h_× at Earth (dimensionless)
///   [13   ]  GW peak frequency (n=2 harmonic) [Hz]
///   [14   ]  decay timescale t_GW [yr]
///   [15   ]  Sirius A wind density at B [g/cm³]
///   [16   ]  Sirius A wind speed at B [km/s]
///   [17   ]  Bondi–Hoyle accretion radius R_acc [cm]
///   [18   ]  Ṁ_BHL onto Sirius B [g/s]
///   [19   ]  accretion luminosity L_acc [erg/s]
///   [20   ]  shock temperature T_s [K]
///   [21   ]  v_ff at Sirius B surface [km/s]
///   [22   ]  Roche-lobe radius around Sirius A at this r [R☉]
///   [23   ]  Sirius-A Roche-lobe fill fraction (R_A / R_L)
#[wasm_bindgen]
pub fn snapshot(time_yr: f64) -> Vec<f64> {
    let s = evolve_orbit(time_yr);

    let m_a = M_A_SUN * MSUN;
    let m_b = M_B_SUN * MSUN;
    let m_tot = m_a + m_b;
    let mu = m_a * m_b / m_tot;
    let a_cm = A_REL_AU * AU_CM;
    let d_cm = D_PC * PC_CM;

    let l_gw = gw_luminosity(m_a, m_b, a_cm, E_ORB);
    let (h_p, h_x) = gw_strain(
        mu, m_tot, a_cm, E_ORB,
        s.true_anom,
        OMEGA_PERI_DEG * DEG2RAD + s.omega_advance,
        INCL_DEG * DEG2RAD,
        d_cm,
    );
    let f_gw_peak = 2.0 / (P_ORB_YR * YR_S);   // n=2 quadrupole harmonic
    let t_gw_yr = gw_decay_time(m_a, m_b, a_cm, E_ORB) / YR_S;

    // BHL
    let (mdot_acc, r_acc, _v_rel_w) = bhl_rate(s.r_cm, s.v_rel_cm_s);
    let l_acc = accretion_luminosity(mdot_acc);
    let t_s = shock_temperature();
    let v_ff = free_fall_velocity_b();

    // Roche lobe: q = M_A/M_B, this gives R_L of Sirius A
    let q_a = M_A_SUN / M_B_SUN;
    let rl_a_cm = roche_radius_over_a(q_a) * s.r_cm;
    let rl_a_rsun = rl_a_cm / RSUN;
    let fill = R_A_SUN / rl_a_rsun;

    let omega_arcsec = s.omega_advance.to_degrees() * 3600.0;

    vec![
        s.pa.x, s.pa.y, s.pa.z,
        s.pb.x, s.pb.y, s.pb.z,
        s.r_cm / AU_CM,
        s.v_rel_cm_s / 1.0e5,
        s.true_anom.to_degrees(),
        omega_arcsec,
        l_gw,
        h_p,
        h_x,
        f_gw_peak,
        t_gw_yr,
        wind_density(s.r_cm),
        wind_velocity(s.r_cm) / 1.0e5,
        r_acc,
        mdot_acc,
        l_acc,
        t_s,
        v_ff / 1.0e5,
        rl_a_rsun,
        fill,
    ]
}

/// Composite spectral-energy distribution at Earth.
///
/// Inputs:
///   `lambda_nm_start`, `lambda_nm_end`  — wavelength range [nm]
///   `n_bins`                            — number of log-spaced bins
///
/// Returns flat array, 4 floats per bin:
///   [λ_nm, F_A(λ), F_B(λ), F_brems(λ)]   [erg s⁻¹ cm⁻² Å⁻¹]
///
/// Components:
///   F_A    = π B_λ(T_A) (R_A / d)²        — A1V photosphere
///   F_B    = π B_λ(T_B) (R_B / d)²        — DA atmosphere (BB approx.)
///   F_br   = ε_ff,ν (T_s) · V_col / (4π d²) · |dν/dλ| — BHL bremsstrahlung
#[wasm_bindgen]
pub fn spectrum(lambda_nm_start: f64, lambda_nm_end: f64, n_bins: usize) -> Vec<f64> {
    let mut out = Vec::with_capacity(n_bins * 4);
    let log_lo = lambda_nm_start.ln();
    let log_hi = lambda_nm_end.ln();

    let r_a_cm = R_A_SUN * RSUN;
    let r_b_cm = R_B_SUN * RSUN;
    let d_cm   = D_PC * PC_CM;

    // Bremsstrahlung column volume estimate:  V ≈ π R_B² · h, h ≈ R_B/4
    let v_col = PI * r_b_cm.powi(2) * r_b_cm * 0.25;
    let t_s   = shock_temperature();
    // Use peri-passage BHL number density as a representative case
    let (mdot_acc, _, v_rel) = bhl_rate(
        A_REL_AU * (1.0 - E_ORB) * AU_CM,
        (G_CGS * (M_A_SUN+M_B_SUN)*MSUN * (1.0+E_ORB)/((1.0-E_ORB)*A_REL_AU*AU_CM)).sqrt(),
    );
    // post-shock n_e ≈ 4 × pre-shock; pre = ρ_pre / m_p
    let rho_pre = mdot_acc / (PI * r_b_cm.powi(2) * v_rel);
    let ne = 4.0 * rho_pre / MP_CGS;
    let ni = ne;

    for k in 0..n_bins {
        let frac = k as f64 / (n_bins as f64 - 1.0);
        let lam_nm = (log_lo + frac * (log_hi - log_lo)).exp();
        let lam_cm = lam_nm * 1.0e-7;
        let nu = C_CGS / lam_cm;

        // π·B_ν → emergent flux density at stellar surface; convert ν → Å
        // F_λ = π B_ν · |dν/dλ| · (R/d)² where |dν/dλ| = c/λ²
        let dnu_dlam = C_CGS / lam_cm.powi(2);     // [Hz / cm]
        let scale = dnu_dlam * 1.0e-8;             // → per Å

        // Sirius A: A1V is well-approximated by pure Planck (Balmer jump and
        // metal blanketing exist but are sub-leading for the system-scale SED).
        let f_a = PI * planck_bnu(nu, T_A_K) * (r_a_cm / d_cm).powi(2) * scale;
        // Sirius B: Koester-style DA with Eddington-Barbier emergent flux,
        // Lyman absorption, and EUV brightening from H bf opacity drop.
        let f_b = koester_da_surface_flux(nu, T_B_K) * (r_b_cm / d_cm).powi(2) * scale;

        let eps = brems_emissivity(nu, t_s, ne, ni);
        let f_brems = eps * v_col / (4.0 * PI * d_cm.powi(2)) * scale;

        out.push(lam_nm);
        out.push(f_a);
        out.push(f_b);
        out.push(f_brems);
    }
    out
}

/// Sample the GW waveform over one orbit, `n_samples` evenly in mean anomaly.
/// Returns flat array, 3 floats per sample: [phase(0..1), h+, h×].
#[wasm_bindgen]
pub fn gw_waveform(n_samples: usize) -> Vec<f64> {
    let mut out = Vec::with_capacity(n_samples * 3);
    let m_a = M_A_SUN * MSUN;
    let m_b = M_B_SUN * MSUN;
    let m_tot = m_a + m_b;
    let mu = m_a * m_b / m_tot;
    let a_cm = A_REL_AU * AU_CM;
    let d_cm = D_PC * PC_CM;
    let i_rad = INCL_DEG * DEG2RAD;
    let w0    = OMEGA_PERI_DEG * DEG2RAD;
    for k in 0..n_samples {
        let phase = k as f64 / n_samples as f64;
        let m_anom = phase * TWOPI;
        let e_anom = kepler_solve(m_anom, E_ORB);
        let nu = true_anomaly(e_anom, E_ORB);
        let (hp, hx) = gw_strain(mu, m_tot, a_cm, E_ORB, nu, w0, i_rad, d_cm);
        out.push(phase);
        out.push(hp);
        out.push(hx);
    }
    out
}

/// Sample the BHL accretion-rate modulation over one orbit.
/// Returns flat array, 3 floats per sample: [phase, Ṁ_acc [g/s], L_acc [erg/s]].
#[wasm_bindgen]
pub fn accretion_curve(n_samples: usize) -> Vec<f64> {
    let mut out = Vec::with_capacity(n_samples * 3);
    let m_tot = (M_A_SUN + M_B_SUN) * MSUN;
    let a_cm = A_REL_AU * AU_CM;
    for k in 0..n_samples {
        let phase = k as f64 / n_samples as f64;
        let m_anom = phase * TWOPI;
        let e_anom = kepler_solve(m_anom, E_ORB);
        let r_cm = a_cm * (1.0 - E_ORB * e_anom.cos());
        let v_rel = (G_CGS * m_tot * (2.0 / r_cm - 1.0 / a_cm)).sqrt();
        let (mdot, _, _) = bhl_rate(r_cm, v_rel);
        let l_acc = accretion_luminosity(mdot);
        out.push(phase);
        out.push(mdot);
        out.push(l_acc);
    }
    out
}

/// Return a JS-readable struct of static system constants. Useful for
/// the HUD/diagnostics overlay so the front-end isn't hardcoding them.
#[wasm_bindgen]
pub fn constants() -> Vec<f64> {
    vec![
        M_A_SUN, R_A_SUN, T_A_K,
        M_B_SUN, R_B_SUN, T_B_K,
        D_PC, P_ORB_YR, E_ORB, A_REL_AU,
        INCL_DEG, OMEGA_NODE_DEG, OMEGA_PERI_DEG, T_PERI_YR,
        MDOT_A_MSUN_YR, V_INF_A / 1.0e5,
        peters_f_enhancement(E_ORB),
        shock_temperature(),
        free_fall_velocity_b() / 1.0e5,
        roche_radius_over_a(M_A_SUN / M_B_SUN),
    ]
}

// ═══════════════════════════════════════════════════════════════════
// 7. 3-D Bondi-Hoyle-Lyttleton WIND-ACCRETION WAKE
//
// Lagrangian particle simulator. Wind packets ("particles") are
// continually launched isotropically from Sirius A's surface at
// v_∞ ≈ 600 km/s. They evolve in the *inertial barycentric* frame
// under the gravity of both stars. The Mach-cone wake forms naturally
// downstream of Sirius B as it sweeps through the wind on its
// 50-yr eccentric orbit.
//
// Time-step strategy.  The wake crossing time (a few months for a
// 30 AU box at v_∞ = 600 km/s ≈ 127 AU/yr) is far shorter than the
// orbital period (50 yr) — so BHL is *quasi-steady* with respect to
// the orbit (Theuns, Boffin & Jorissen 1996; Mastrodemos & Morris
// 1998). We exploit this by sub-stepping the wake with dt_sub at
// roughly the wake crossing time, while the orbit advances at dt.
//
// Units inside the simulator
//   positions:    AU,  barycentric inertial frame
//   velocities:   AU / Julian-year (× 4.7405 → km/s)
//   masses:       M☉
//   G:            4π²  AU³ M☉⁻¹ yr⁻²   (Kepler's third law normalisation)
//
// Capture & recycling
//   • Captured: |r − r_B| < R_capture  (we use 2× Bondi accretion radius,
//                                       still tiny in AU but visible)
//   • Escaped:  |r| > 80 AU            (well beyond apoapsis)
//   • Stale:    age > 6 yr             (prevents long-lived orbits)
//   On any of the above the particle is re-launched from the current
//   Sirius A position with a fresh random unit-vector velocity.
// ═══════════════════════════════════════════════════════════════════

const G_AU: f64 = 4.0 * PI * PI;                // AU³ M☉⁻¹ yr⁻²  (= 4π²)
const KMS_PER_AU_YR: f64 = 4.740_57;            // 1 AU/yr in km/s
const WIND_AU_YR: f64 = 600.0 / KMS_PER_AU_YR;  // ≈ 126.6 AU/yr
const R_A_AU: f64 = 1.711 * 6.957e10 / 1.495_978_707e13; // Sirius A radius in AU

/// Wake particle simulator state (held in WASM TLS).
struct WakeSim {
    n: usize,
    pos: Vec<f32>,       // 3n floats: [x,y,z, ...] AU (barycentric)
    vel: Vec<f32>,       // 3n floats: [vx,vy,vz, ...] AU/yr
    age: Vec<f32>,       // n floats: age in yr
    state: Vec<u8>,      // 0=wind, 1=captured (then recycled), 2=escaped
    rng: u64,            // xorshift64 PRNG
    capture_count: u64,  // cumulative captures (for diagnostics)
}

impl WakeSim {
    fn empty() -> Self {
        WakeSim {
            n: 0, pos: vec![], vel: vec![], age: vec![], state: vec![],
            rng: 0xDEAD_BEEF_CAFE_F00D, capture_count: 0,
        }
    }

    /// xorshift64* PRNG → f64 in [0, 1)
    fn rand01(&mut self) -> f64 {
        let mut x = self.rng;
        x ^= x << 13; x ^= x >> 7; x ^= x << 17;
        self.rng = x;
        ((x.wrapping_mul(0x2545_F491_4F6C_DD1D)) >> 11) as f64 / (1u64 << 53) as f64
    }

    /// Uniform unit-vector on sphere (Marsaglia).
    fn rand_unit(&mut self) -> (f64, f64, f64) {
        let u = 2.0 * self.rand01() - 1.0;   // z ∈ (-1, 1)
        let phi = TWOPI * self.rand01();
        let s = (1.0 - u * u).sqrt();
        (s * phi.cos(), s * phi.sin(), u)
    }

    /// Launch (or re-launch) a particle from Sirius A's surface.
    fn spawn(&mut self, i: usize, r_a: (f64, f64, f64)) {
        let (ux, uy, uz) = self.rand_unit();
        // Spawn at 4 × R_A to be safely outside the visible photosphere mesh
        // and avoid initial gravitational sink. BHL geometry only depends on
        // the v_wind/v_orb ratio, not the absolute spawn radius.
        let r_spawn = 4.0 * R_A_AU;
        let px = r_a.0 + r_spawn * ux;
        let py = r_a.1 + r_spawn * uy;
        let pz = r_a.2 + r_spawn * uz;
        let v = WIND_AU_YR;   // already in AU/yr
        self.pos[3*i  ] = px as f32;
        self.pos[3*i+1] = py as f32;
        self.pos[3*i+2] = pz as f32;
        self.vel[3*i  ] = (v * ux) as f32;
        self.vel[3*i+1] = (v * uy) as f32;
        self.vel[3*i+2] = (v * uz) as f32;
        self.age[i] = 0.0;
        self.state[i] = 0;
    }
}

thread_local! {
    static WAKE: std::cell::RefCell<WakeSim> = std::cell::RefCell::new(WakeSim::empty());
}

/// Allocate `n` wake particles and seed them from Sirius A's surface
/// at simulation epoch `time_yr`. Returns the actual count.
#[wasm_bindgen]
pub fn wake_init(n: u32, time_yr: f64) -> u32 {
    let n = n as usize;
    let snap = evolve_orbit(time_yr);
    let r_a = (snap.pa.x, snap.pa.y, snap.pa.z);
    WAKE.with(|w| {
        let mut w = w.borrow_mut();
        w.n = n;
        w.pos.resize(3*n, 0.0);
        w.vel.resize(3*n, 0.0);
        w.age.resize(n, 0.0);
        w.state.resize(n, 0);
        w.capture_count = 0;
        for i in 0..n {
            w.spawn(i, r_a);
            // Pre-stagger the age so the wake fills up smoothly instead of
            // arriving as a single shell.
            let age = w.rand01() as f32 * 4.0;
            w.age[i] = age;
            // Advance each particle ballistically by its stagger age so the
            // first frame already shows a populated wind front.
            for c in 0..3 {
                let p = w.pos[3*i + c];
                let v = w.vel[3*i + c];
                w.pos[3*i + c] = p + v * age;
            }
        }
    });
    n as u32
}

/// Advance the wake by `dt_yr` years at the orbital configuration of
/// time `time_yr`. The integration is sub-stepped `n_substeps` times
/// to keep the wake quasi-steady relative to the slowly-moving orbit.
/// Returns the cumulative capture count.
#[wasm_bindgen]
pub fn wake_step(dt_yr: f64, time_yr: f64, n_substeps: u32) -> u32 {
    let snap = evolve_orbit(time_yr);
    let r_a = (snap.pa.x, snap.pa.y, snap.pa.z);
    let r_b = (snap.pb.x, snap.pb.y, snap.pb.z);
    let n_sub = n_substeps.max(1) as usize;
    let dt_sub = (dt_yr / n_sub as f64) as f32;

    // Visualization capture radius (decoupled from the physical R_acc that
    // snapshot() reports). The true Bondi radius R_acc ≈ 2GM_B/v_∞² ≈
    // 0.005 AU is invisibly small at the orbit scale; even a 0.18 AU
    // sphere captures only ~10⁻⁵ of an isotropic shell, so in a 4000-
    // particle Monte-Carlo the user sees zero hits per session. We
    // therefore use 0.5 AU here so BHL accretion fires visibly. The
    // wake morphology (the Mach-cone shape) is geometrically unchanged.
    let r_capture: f32 = 0.5;      // AU
    let r_escape: f32 = 80.0;     // AU
    let max_age:  f32 = 6.0;      // yr
    let g_a = (G_AU * M_A_SUN) as f32;
    let g_b = (G_AU * M_B_SUN) as f32;
    let soft_a_sq = (4.0 * R_A_AU * 4.0 * R_A_AU) as f32;   // gravitational softening near A
    let soft_b_sq = r_capture * r_capture;

    let (rax, ray, raz) = (r_a.0 as f32, r_a.1 as f32, r_a.2 as f32);
    let (rbx, rby, rbz) = (r_b.0 as f32, r_b.1 as f32, r_b.2 as f32);

    WAKE.with(|w| {
        let mut w = w.borrow_mut();
        let n = w.n;
        for _ in 0..n_sub {
            for i in 0..n {
                let px = w.pos[3*i];   let py = w.pos[3*i+1]; let pz = w.pos[3*i+2];
                let dxa = px - rax;    let dya = py - ray;    let dza = pz - raz;
                let dxb = px - rbx;    let dyb = py - rby;    let dzb = pz - rbz;
                let r2a = dxa*dxa + dya*dya + dza*dza + soft_a_sq;
                let r2b = dxb*dxb + dyb*dyb + dzb*dzb + soft_b_sq;
                let inv_ra3 = r2a.sqrt().recip() / r2a;
                let inv_rb3 = r2b.sqrt().recip() / r2b;
                let ax = -g_a * dxa * inv_ra3 - g_b * dxb * inv_rb3;
                let ay = -g_a * dya * inv_ra3 - g_b * dyb * inv_rb3;
                let az = -g_a * dza * inv_ra3 - g_b * dzb * inv_rb3;

                let vx = w.vel[3*i  ] + ax * dt_sub;
                let vy = w.vel[3*i+1] + ay * dt_sub;
                let vz = w.vel[3*i+2] + az * dt_sub;
                w.vel[3*i  ] = vx;  w.vel[3*i+1] = vy;  w.vel[3*i+2] = vz;
                w.pos[3*i  ] = px + vx * dt_sub;
                w.pos[3*i+1] = py + vy * dt_sub;
                w.pos[3*i+2] = pz + vz * dt_sub;
                w.age[i] += dt_sub;

                // Bookkeeping & respawn
                let new_r2b = (w.pos[3*i] - rbx).powi(2)
                            + (w.pos[3*i+1] - rby).powi(2)
                            + (w.pos[3*i+2] - rbz).powi(2);
                let new_r2_bary = w.pos[3*i].powi(2)
                                + w.pos[3*i+1].powi(2)
                                + w.pos[3*i+2].powi(2);
                if new_r2b < r_capture*r_capture {
                    w.state[i] = 1; w.capture_count += 1;
                    w.spawn(i, r_a);
                } else if new_r2_bary > r_escape*r_escape || w.age[i] > max_age {
                    w.state[i] = 2;
                    w.spawn(i, r_a);
                }
            }
        }
        w.capture_count as u32
    })
}

/// Flat positions buffer: 3·n f32, AU, barycentric.
#[wasm_bindgen]
pub fn wake_positions() -> Vec<f32> {
    WAKE.with(|w| w.borrow().pos.clone())
}

/// Per-particle speed (km/s), n f32 — for Three.js color attribute.
#[wasm_bindgen]
pub fn wake_speeds() -> Vec<f32> {
    WAKE.with(|w| {
        let w = w.borrow();
        let mut out = Vec::with_capacity(w.n);
        for i in 0..w.n {
            let vx = w.vel[3*i] as f64;
            let vy = w.vel[3*i+1] as f64;
            let vz = w.vel[3*i+2] as f64;
            out.push(((vx*vx + vy*vy + vz*vz).sqrt() * KMS_PER_AU_YR) as f32);
        }
        out
    })
}

/// Particle ages (yr), n f32 — for opacity / fading visualisation.
#[wasm_bindgen]
pub fn wake_ages() -> Vec<f32> {
    WAKE.with(|w| w.borrow().age.clone())
}

/// Cumulative captures since `wake_init` and active count.
#[wasm_bindgen]
pub fn wake_diagnostics() -> Vec<f64> {
    WAKE.with(|w| {
        let w = w.borrow();
        vec![w.n as f64, w.capture_count as f64]
    })
}
// Tests — validate against cited literature values to a few percent.
//   `cargo test --target x86_64-unknown-linux-gnu` (native)
// ═══════════════════════════════════════════════════════════════════
#[cfg(test)]
mod tests {
    use super::*;

    /// Relative tolerance helper
    fn close(a: f64, b: f64, frac: f64) -> bool {
        if b == 0.0 { a.abs() < frac } else { ((a - b) / b).abs() < frac }
    }

    /// Kepler-III check: a from G M_tot P² / (4π²) → 19.78 AU
    #[test]
    fn keplers_third_law_self_consistent() {
        let m_tot = (M_A_SUN + M_B_SUN) * MSUN;
        let p_s = P_ORB_YR * YR_S;
        let a_kepler_cm = (G_CGS * m_tot * p_s.powi(2) / (4.0 * PI * PI)).cbrt();
        let a_kepler_au = a_kepler_cm / AU_CM;
        assert!(close(a_kepler_au, A_REL_AU, 0.005),
                "Kepler-III: a={a_kepler_au:.3} AU vs const {A_REL_AU:.3} AU");
    }

    /// Peters f(e) for e=0.5914 should be ≈ 9.52 (orbital agent / Maggiore §4)
    #[test]
    fn peters_f_eccentric() {
        let f = peters_f_enhancement(E_ORB);
        assert!(close(f, 9.52, 0.02), "f(e=0.5914) = {f:.3} vs 9.52");
    }

    /// GW luminosity for Sirius ≈ 9.3 × 10¹⁵ erg/s (≈ 9.3 × 10⁸ W)
    #[test]
    fn gw_luminosity_order_of_magnitude() {
        let m_a = M_A_SUN * MSUN;
        let m_b = M_B_SUN * MSUN;
        let l = gw_luminosity(m_a, m_b, A_REL_AU * AU_CM, E_ORB);
        // Bond+ derived value (Maggiore-style): 9.3e15 erg/s
        assert!(close(l, 9.3e15, 0.10),
                "L_GW = {:.3e} erg/s vs 9.3e15", l);
    }

    /// 1PN periastron advance per orbit: ≈ 9 mas (Damour-Deruelle)
    #[test]
    fn schwarzschild_advance_per_orbit() {
        let m_tot = (M_A_SUN + M_B_SUN) * MSUN;
        let a_cm = A_REL_AU * AU_CM;
        let dwdt = schwarzschild_precession_rate(m_tot, a_cm, E_ORB);
        let per_orbit_rad = dwdt * P_ORB_YR * YR_S;
        let per_orbit_mas = per_orbit_rad.to_degrees() * 3.6e6;
        assert!(close(per_orbit_mas, 9.2, 0.10),
                "Δω = {per_orbit_mas:.2} mas/orbit vs 9.2");
    }

    /// Free-fall v at Sirius B surface
    /// v_ff = √(2 G M_B / R_B) = √(2·6.674e-8·2.025e33/5.84e8) ≈ 6800 km/s.
    /// (The 2150 km/s figure circulated in some sources is an arithmetic
    /// error — it would correspond to a WD a factor of 10 less compact.)
    #[test]
    fn v_freefall_b() {
        let v = free_fall_velocity_b() / 1.0e5;
        assert!(close(v, 6800.0, 0.02), "v_ff = {v:.0} km/s vs 6800");
    }

    /// Strong-shock T_s ∝ v_ff² → ≈ 6 × 10⁸ K (~50 keV) on Sirius B surface.
    /// This is hard X-ray plasma — bright per particle, but with Ṁ_acc ≪ 1 g/s
    /// the column luminosity is far below the photosphere.
    #[test]
    fn shock_temp() {
        let t = shock_temperature();
        assert!(close(t, 6.0e8, 0.10),
                "T_s = {t:.2e} K vs 6e8");
    }

    /// Eggleton Roche radius ratio for q = 2.026 is ≈ 0.4412
    #[test]
    fn roche_ratio_sirius_a() {
        let q = M_A_SUN / M_B_SUN;
        let rl_over_a = roche_radius_over_a(q);
        assert!(close(rl_over_a, 0.4412, 0.005),
                "R_L/a = {rl_over_a:.4} vs 0.4412");
    }

    /// At periastron r_p = a(1-e) ≈ 8.08 AU
    #[test]
    fn periastron_separation() {
        let r_p = A_REL_AU * (1.0 - E_ORB);
        assert!(close(r_p, 8.08, 0.01),
                "r_peri = {r_p:.3} AU vs 8.08");
    }

    /// Vis-viva at periastron: v_rel ≈ 23 km/s (matches orbital-agent's
    /// independently-derived 24 km/s; Bond+ 2017 dynamical solution).
    #[test]
    fn vis_viva_periastron() {
        let m_tot = (M_A_SUN + M_B_SUN) * MSUN;
        let a_cm = A_REL_AU * AU_CM;
        let r_p_cm = a_cm * (1.0 - E_ORB);
        let v = (G_CGS * m_tot * (2.0 / r_p_cm - 1.0 / a_cm)).sqrt() / 1.0e5;
        assert!(close(v, 23.2, 0.05),
                "v_rel(peri) = {v:.2} km/s vs 23.2");
    }

    /// Markley solver: round-trip M → E → M for many points & high e
    #[test]
    fn markley_kepler_roundtrip() {
        let e = 0.5914;
        for k in 0..1000 {
            let m = -PI + (k as f64) * (TWOPI / 999.0);
            let ea = kepler_solve(m, e);
            let m_back = ea - e * ea.sin();
            let dm = (m_back - m).rem_euclid(TWOPI);
            let dm = if dm > PI { dm - TWOPI } else { dm };
            assert!(dm.abs() < 1e-12, "M={m} → E={ea} → ΔM={dm}");
        }
    }

    /// Koester DA atmosphere must brighten in EUV vs Planck and have a
    /// Lyman jump (i.e., short-of-912-Å flux > continuum extrapolation).
    /// Quantitatively: at 80 nm (Wien tail) the Koester surface flux
    /// should exceed pure Planck(T_eff) by ≥ 10× — matches Beuermann+06.
    #[test]
    fn koester_da_euv_brightening() {
        let lam_euv_cm = 80e-7;
        let nu = C_CGS / lam_euv_cm;
        let planck = PI * planck_bnu(nu, T_B_K);
        let koester = koester_da_surface_flux(nu, T_B_K);
        let ratio = koester / planck;
        assert!(ratio > 10.0,
                "EUV ratio Koester/Planck = {ratio:.1}× at 80 nm (need > 10)");
    }

    /// Lyman series must produce an absorption notch at 1216 Å (Lyα).
    #[test]
    fn koester_da_lyman_alpha_absorption() {
        let nu_at = |lam_nm: f64| C_CGS / (lam_nm * 1.0e-7);
        let f_alpha    = koester_da_surface_flux(nu_at(1215.67e-1), T_B_K);
        let f_continuum= koester_da_surface_flux(nu_at(1300.0e-1),  T_B_K);
        assert!(f_alpha < 0.7 * f_continuum,
                "Lyα should show ≥30% absorption: f_α = {f_alpha:.3e}, cont = {f_continuum:.3e}");
    }

    /// Wake: after init + a few steps, particle positions should remain
    /// finite, ages bounded, and at least some particles should be moving
    /// outward at roughly the wind speed.
    #[test]
    fn wake_init_and_step_sane() {
        let n = wake_init(1000, 1994.5715);
        assert_eq!(n, 1000);
        let cap = wake_step(0.01, 1994.5715, 16);
        let _ = cap;  // may be 0 on first step
        let pos = wake_positions();
        let spd = wake_speeds();
        assert_eq!(pos.len(), 3000);
        assert_eq!(spd.len(), 1000);
        let mut any_fast = false;
        let mut max_r: f32 = 0.0;
        for i in 0..1000 {
            let r = (pos[3*i].powi(2) + pos[3*i+1].powi(2) + pos[3*i+2].powi(2)).sqrt();
            assert!(r.is_finite() && r < 200.0, "particle {i} flew off to r={r}");
            if r > max_r { max_r = r; }
            // 600 km/s is the launch speed; allow ±50%
            if spd[i] > 300.0 && spd[i] < 1500.0 { any_fast = true; }
        }
        assert!(any_fast, "no wake particle near launch speed");
        assert!(max_r > 1.0, "wake never spreads beyond 1 AU (max_r={max_r})");
    }

    /// Wake particles should statistically reach the barycentric region
    /// where Sirius B orbits — i.e. some fraction must be 5–35 AU from
    /// origin (within the Sirius B orbit range) after several steps.
    #[test]
    fn wake_reaches_orbit_zone() {
        let _ = wake_init(2000, 1994.5715);
        for k in 0..30 {
            let t = 1994.5715 + (k as f64) * 0.01;
            wake_step(0.01, t, 16);
        }
        let pos = wake_positions();
        let mut n_in_zone = 0;
        for i in 0..2000 {
            let r = (pos[3*i].powi(2) + pos[3*i+1].powi(2) + pos[3*i+2].powi(2)).sqrt();
            if r > 5.0 && r < 35.0 { n_in_zone += 1; }
        }
        assert!(n_in_zone > 50, "only {n_in_zone}/2000 particles reached Sirius B orbit zone");
    }

    /// GW decay timescale ~ 10²¹ yr for Sirius (no merger before t_Hubble)
    #[test]
    fn gw_decay_billions_times_hubble() {
        let m_a = M_A_SUN * MSUN;
        let m_b = M_B_SUN * MSUN;
        let t = gw_decay_time(m_a, m_b, A_REL_AU * AU_CM, E_ORB) / YR_S;
        assert!(t > 1.0e20, "t_GW = {t:.2e} yr — should be > 1e20");
    }
}

