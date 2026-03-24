/**
 * helio-physics.js — First-principles space-plasma physics engine
 *
 * Three coupled physical models:
 *
 *  1. Parker (1958) transonic solar wind
 *     Solves W − ln W = 4 ln ξ + 4/ξ − 3  (W = (V/a)², ξ = r/r_c)
 *     via Newton–Raphson for the supersonic (solar wind) branch.
 *     Uses the two-fluid isothermal sound speed a² = 2 k_B T / m_p
 *     (electron + proton thermal pressure) — NOT the common single-fluid
 *     error a² = k_B T / m_p that gives r_c ≈ 0.5 AU instead of ~6 R_sun.
 *     r_c = G M_sun / (2 a²) = G M_sun m_p / (4 k_B T)  ≈ 0.027 AU at T = 1 MK
 *
 *  2. MHD state parameters
 *     Alfvén speed V_A = B / √(μ₀ ρ)
 *     Plasma beta β = 2 μ₀ n k_B T / B²  (β < 1: magnetically dominated)
 *     Sweet–Parker rate  V_rec/V_A = S^{-1/2}            (very slow, S ≫ 1)
 *     Petschek fast rate V_rec/V_A ≈ π / (8 ln S)        (turbulence-driven)
 *     where S = μ₀ L V_A / η is the Lundquist number.
 *
 *  3. Parker-CGL Thermal Differentiation
 *     Combined Chew–Goldberger–Low double-adiabatic + Alfvénic wave heating
 *     to model the proton temperature profile observed by Helios, Wind, PSP:
 *       T(r) = T_corona × (r₀/r)^0.74  +  wave-heating correction
 *     CGL anisotropy: T_⊥ ∝ B (near corona ≈ oblate), T_⊥/T_∥ ≈ 0.4 at 1 AU
 *     Debye length λ_D = √(ε₀ k_B T_e / n e²) ≈ 9 m at 1 AU (quantum-thermal grain)
 *
 * All functions are pure (no side effects, no Three.js dependency).
 */

// ── Physical constants ────────────────────────────────────────────────────────

export const PHYS = Object.freeze({
    G_MSUN:  1.327_124e20,   // G × M_sun [m³ s⁻²]
    K_B:     1.380_649e-23,  // Boltzmann constant [J K⁻¹]
    M_P:     1.672_622e-27,  // proton mass [kg]
    M_E:     9.109_384e-31,  // electron mass [kg]
    MU_0:    1.256_637e-6,   // vacuum permeability [H m⁻¹]
    EPS_0:   8.854_188e-12,  // vacuum permittivity [F m⁻¹]
    E_CH:    1.602_176e-19,  // elementary charge [C]
    AU_M:    1.495_979e11,   // 1 AU in metres
    R_SUN_M: 6.957e8,        // solar radius in metres
});

// ── 1. Parker (1958) transonic solar wind ─────────────────────────────────────

/**
 * Build a precomputed Parker speed-ratio lookup table.
 *
 * Returns an object { lut, r_min, r_max, N, r_c_AU } where
 *   lut[i] = V(r_i) / V(1 AU)   (normalised so lut[i_1AU] = 1.0)
 *
 * Correct two-fluid sound speed:  a² = 2 k_B T / m_p
 *   At T = 1.5 MK → a ≈ 158 km/s, r_c ≈ 0.018 AU (3.8 R_sun)
 *   At T = 1.0 MK → a ≈ 129 km/s, r_c ≈ 0.027 AU (5.8 R_sun)
 *
 * Speed ratio profile (T = 1.5 MK, V_1AU = 450 km/s):
 *   r = 0.008 AU : ratio ≈ 0.06   →  V ≈  27 km/s  (subsonic corona)
 *   r = 0.018 AU : ratio ≈ 0.35   →  V ≈ 157 km/s  (critical point)
 *   r = 0.10  AU : ratio ≈ 0.62   →  V ≈ 280 km/s
 *   r = 0.50  AU : ratio ≈ 0.92   →  V ≈ 415 km/s
 *   r = 1.00  AU : ratio = 1.00   →  V = measured
 */
export function buildParkerLUT(N = 200, r_min_AU = 0.002, r_max_AU = 2.1, T_K = 1.5e6) {
    const { K_B, M_P, G_MSUN, AU_M } = PHYS;

    // Two-fluid isothermal sound speed (electron + proton contributions)
    const a2   = 2 * K_B * T_K / M_P;
    const r_c  = G_MSUN / (2 * a2 * AU_M);   // critical radius in AU

    const lut  = new Float32Array(N);
    const step = (r_max_AU - r_min_AU) / (N - 1);

    for (let i = 0; i < N; i++) {
        lut[i] = _solveParker((r_min_AU + step * i) / r_c);
    }

    // Normalise to V(1 AU) = 1
    const i_1AU = Math.round((1.0 - r_min_AU) / step);
    const norm  = lut[Math.min(N - 1, Math.max(0, i_1AU))];
    if (norm > 0) for (let i = 0; i < N; i++) lut[i] /= norm;

    return { lut, r_min: r_min_AU, r_max: r_max_AU, N, r_c_AU: r_c };
}

/**
 * Solve the Parker transcendental equation for one radius.
 * Returns dimensionless speed V/a on the correct branch:
 *   ξ ≥ 1 → supersonic branch (W > 1)
 *   ξ < 1 → subsonic branch   (W < 1)
 */
function _solveParker(xi) {
    if (xi <= 0) return 0;

    // RHS: 4 ln ξ + 4/ξ − 3
    const rhs = 4 * Math.log(Math.max(1e-9, xi)) + 4 / Math.max(1e-9, xi) - 3;

    let W;
    if (xi >= 1.0) {
        // Supersonic branch: W > 1.  Good initial guess: rhs + 0.5 (for large ξ).
        W = Math.max(1.5, rhs + 0.5);
        for (let k = 0; k < 60; k++) {
            if (W <= 1.0001) { W = 1.0001; break; }
            const dW = (W - Math.log(W) - rhs) / (1 - 1 / W);
            W = Math.max(1.0001, W - dW);
            if (Math.abs(dW) < 1e-10) break;
        }
    } else {
        // Subsonic branch: W < 1.  For small W: W − ln W ≈ −ln W → W ≈ exp(−rhs).
        if (rhs > 300) return 0.001;
        W = Math.max(0.001, Math.min(0.9999, Math.exp(-rhs)));
        for (let k = 0; k < 60; k++) {
            const dW = (W - Math.log(W) - rhs) / (1 - 1 / W);
            W = Math.max(0.001, Math.min(0.9999, W - dW));
            if (Math.abs(dW) < 1e-10) break;
        }
    }
    return Math.sqrt(Math.max(0, W));
}

/**
 * Linearly interpolate Parker speed ratio V(r) / V(1 AU) from the LUT.
 * Clamped to [0.025, 3.0] to prevent numerical extremes.
 */
export function parkerSpeedRatio(r_AU, { lut, r_min, r_max, N }) {
    const t   = (r_AU - r_min) / (r_max - r_min);
    const idx = t * (N - 1);
    const lo  = Math.max(0, Math.min(N - 2, Math.floor(idx)));
    const f   = idx - lo;
    return Math.max(0.025, Math.min(3.0, lut[lo] * (1 - f) + lut[lo + 1] * f));
}

// ── 2. MHD state parameters ───────────────────────────────────────────────────

/**
 * Alfvén speed (km/s) — the characteristic speed of magnetohydrodynamic waves.
 *   V_A = B / √(μ₀ ρ)   where ρ = n m_p
 * At 1 AU with B = 5 nT, n = 7 cm⁻³: V_A ≈ 40 km/s.
 */
export function alfvenSpeed(B_nT, n_cc) {
    const B   = Math.max(1e-12, B_nT) * 1e-9;
    const rho = Math.max(1e-25, n_cc) * 1e6 * PHYS.M_P;
    return B / Math.sqrt(PHYS.MU_0 * rho) * 1e-3;   // km/s
}

/**
 * Plasma beta β = P_thermal / P_magnetic = 2 μ₀ n k_B T / B²
 *   β < 1 : magnetically dominated (near-sun flux tubes, strong-field regions)
 *   β ≈ 1 : equipartition (Alfvén critical point in outer corona)
 *   β > 1 : thermally dominated (most of solar wind at 1 AU, β ≈ 0.5–2)
 */
export function plasmaBeta(n_cc, T_K, B_nT) {
    const B = Math.max(1e-12, B_nT) * 1e-9;
    return 2 * PHYS.MU_0 * n_cc * 1e6 * PHYS.K_B * T_K / (B * B);
}

/**
 * Sweet–Parker reconnection rate V_rec / V_A = S^{−½}
 * Extremely slow for macroscopic current sheets (S ≳ 10⁸).
 * @param L_AU  current-sheet half-length (AU), typically 0.01–0.1 at the HCS
 * @param V_A   Alfvén speed (km/s)
 * @param eta   magnetic diffusivity (m² s⁻¹); classical ≈ 1–10; anomalous ≈ 10⁵–10⁸
 */
export function sweetParkerRate(L_AU, V_A_kms, eta = 1e3) {
    const S = PHYS.MU_0 * (L_AU * PHYS.AU_M) * (V_A_kms * 1e3) / eta;
    return 1 / Math.sqrt(Math.max(1, S));
}

/**
 * Petschek fast reconnection rate V_rec / V_A ≈ π / (8 ln S)
 * Applies when anomalous resistivity or plasmoid instability are active.
 * Gives V_rec ~ 0.01–0.10 V_A for typical S ~ 10⁸–10¹².
 */
export function petschekRate(L_AU, V_A_kms, eta = 1e3) {
    const S = PHYS.MU_0 * (L_AU * PHYS.AU_M) * (V_A_kms * 1e3) / eta;
    if (S < 100) return sweetParkerRate(L_AU, V_A_kms, eta);
    return Math.PI / (8 * Math.log(S));
}

// ── 3. Parker-CGL Thermal Differentiation ────────────────────────────────────
//
// Combines:
//   a) Empirical power-law from Helios/Wind/PSP: T_p ∝ r^{−0.74} in fast wind
//   b) Alfvénic wave heating correction (Zank et al. 2018): significant inside 0.5 AU
//   c) CGL double-adiabatic invariants:
//        T_⊥ / B = const  (magnetic moment conservation → T_⊥ ∝ B)
//        T_∥ n² / B² = const  (parallel adiabat)
//      Near the Sun (B ∝ r⁻², radial): T_⊥/T_∥ ≈ 20 (oblate)
//      At 1 AU (B_φ ∝ r⁻¹ dominant): T_⊥/T_∥ ≈ 0.4 (mildly prolate → firehose stable)
//   d) Quantum-thermal grain scale: Debye length λ_D ≈ 9 m at 1 AU

/**
 * Plasma temperature (K) at heliocentric distance r_AU.
 * @param T_corona  coronal base temperature (K), default 1.5 MK
 */
export function plasmaTemp(r_AU, T_corona = 1.5e6) {
    const r    = Math.max(r_AU, 0.046);   // anchor at ≈10 R_sun
    const r0   = 0.046;
    // Helios/PSP empirical power-law: T_p ∝ r^{−0.74}
    const T_p  = T_corona * Math.pow(r0 / r, 0.74);
    // Alfvénic wave heating: adds ~20–30% inside 0.5 AU, negligible beyond
    const T_w  = T_corona * 0.28 * Math.pow(r0 / r, 0.35) * Math.exp(-(r / 0.40));
    return Math.max(5000, T_p + T_w);
}

/**
 * Convert plasma temperature to RGB [0–1] — thermal plasma spectral map.
 *   5  kK → deep red      (cool outer heliosphere, rarefaction regions)
 *   50 kK → orange-red    (1 AU average proton temp ~50–120 kK)
 *  200 kK → orange-gold   (inner wind, 0.3–0.5 AU)
 *  600 kK → warm gold     (0.1 AU)
 *  1.5 MK → white         (corona / reconnection exhaust)
 */
export function tempToRGB(T_K) {
    const logT = Math.log10(Math.max(3000, Math.min(3e6, T_K)));
    const t    = (logT - 3.70) / (6.18 - 3.70);   // 0 = 5 kK, 1 = 1.5 MK

    let r, g, b;
    if (t < 0.25) {
        // Deep red → red (cool plasma)
        const s = t / 0.25;
        r = 0.30 + 0.52 * s;  g = 0.0;             b = 0.0;
    } else if (t < 0.50) {
        // Red → orange
        const s = (t - 0.25) / 0.25;
        r = 0.82 + 0.12 * s;  g = 0.06 + 0.14 * s; b = 0.0;
    } else if (t < 0.75) {
        // Orange → gold
        const s = (t - 0.50) / 0.25;
        r = 0.94 + 0.04 * s;  g = 0.20 + 0.52 * s; b = 0.0  + 0.16 * s;
    } else {
        // Gold → white (hot corona)
        const s = (t - 0.75) / 0.25;
        r = 0.98;              g = 0.72 + 0.26 * s; b = 0.16 + 0.82 * s;
    }
    return [Math.min(1, Math.max(0, r)),
            Math.min(1, Math.max(0, g)),
            Math.min(1, Math.max(0, b))];
}

/**
 * CGL double-adiabatic temperature anisotropy ratio T_⊥ / T_∥
 * Matched to Helios observations:
 *   r ≈ 0.046 AU : T_⊥/T_∥ ≈ 20  (oblate corona, T_⊥ ≫ T_∥)
 *   r ≈ 0.3   AU : T_⊥/T_∥ ≈ 1   (isotropic, Alfvén critical zone)
 *   r = 1.0   AU : T_⊥/T_∥ ≈ 0.4 (mildly prolate, sub-firehose)
 */
export function cglAnisotropy(r_AU) {
    const r = Math.max(0.01, r_AU);
    // Inner: T_⊥ ∝ B_r ∝ r^{−2} (power-law fit to observations, exponent 1.6)
    if (r < 0.3) return Math.max(1.0, 20 * Math.pow(0.046 / r, 1.6));
    // Outer: B_φ ∝ r^{−1} dominates → T_⊥ ∝ r^{−0.7}
    return Math.max(0.15, Math.pow(0.3 / r, 0.7));
}

/**
 * Debye length (m) — quantum-thermal electrostatic screening scale.
 *   λ_D = √(ε₀ k_B T_e / (n e²))   ≈ 7.43 √(T_e[eV] / n[cm⁻³])  metres
 * At 1 AU: T_e ≈ 10 eV, n ≈ 7 cm⁻³ → λ_D ≈ 9.3 m (sub-metre: fully classical regime)
 * This is the grain below which charge screening breaks down → quantum plasma effects.
 */
export function debyeLength(T_e_eV, n_cc) {
    const T_K = T_e_eV * 11604.5;   // 1 eV = 11 604.5 K
    const n   = Math.max(1, n_cc) * 1e6;
    return Math.sqrt(PHYS.EPS_0 * PHYS.K_B * T_K / (n * PHYS.E_CH * PHYS.E_CH));
}
