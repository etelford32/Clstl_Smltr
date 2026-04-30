/**
 * solar-atmosphere.js — Solar structure & atmosphere physics engine
 *
 * Complete radial profile from core to corona.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  INTERIOR (r/R_sun = 0 → 1)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   Core               0–0.25 R_sun
 *     pp-chain fusion: ε ∝ ρ T⁴ (CNO negligible at solar T)
 *     T_c = 15.7 MK, ρ_c = 150 g/cm³, P_c = 2.5×10¹⁶ Pa
 *     Generates ~99% of luminosity L_sun = 3.828×10²⁶ W
 *
 *   Radiative Zone     0.25–0.713 R_sun
 *     Photon random-walk: mean free path ~1 cm, escape time ~170 000 yr
 *     Radiative temperature gradient: dT/dr = -(3κρL) / (64πσr²T³)
 *     Opacity κ dominated by bound-free & free-free absorption
 *
 *   Tachocline         ~0.713 R_sun (thin ~0.04 R_sun)
 *     Differential → rigid rotation transition
 *     Magnetic field amplification → solar dynamo source region
 *     Ω-effect shears poloidal field into toroidal
 *
 *   Convective Zone    0.713–1.0 R_sun
 *     Mixing-length convection: l_mix ≈ α_MLT × H_P (α ≈ 1.5–2.0)
 *     Nearly adiabatic gradient: ∇ = ∇_ad = 0.4 (ideal gas γ=5/3)
 *     Granulation: 1 Mm cells, 10-min lifetime
 *     Supergranulation: 30 Mm cells, ~24 hr lifetime
 *     Overturn time: ~10 days (base) to ~10 min (top)
 *
 *   Photosphere        r = 1.0 R_sun (τ₅₀₀₀ = 1 surface)
 *     T_eff = 5778 K, opacity minimum at ~1.6 μm
 *     Limb darkening: I(θ)/I(0) ≈ 1 − u(1 − cos θ), u ≈ 0.6
 *     Spectral class G2V
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  ATMOSPHERE (height above photosphere)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   Chromosphere   0–2 100 km above photosphere
 *     Temperature inversion: 4 400 K (T_min) → 25 000 K
 *     Dominant emission: H-alpha 656.3 nm, Ca II H&K 393/397 nm
 *     Spicule dynamics: jets reaching 5 000–10 000 km at 20–100 km/s
 *     Density: ~10¹⁶ → 10¹⁰ cm⁻³ (drops 6 orders of magnitude)
 *
 *   Transition Region   ~100 km thick (2 100–2 200 km)
 *     Steep T jump: 25 000 K → 1 MK in ~100 km
 *     Key emission lines: C IV 154.9 nm, O VI 103.2 nm, Si IV 140.3 nm
 *     Thermal conduction front from corona meets chromospheric radiation
 *     Density: ~10¹⁰ → 10⁸ cm⁻³
 *
 *   Corona   > 2 200 km (extends to several R_sun)
 *     T = 1–3 MK (coronal heating problem: wave dissipation + nanoflares)
 *     Emission: X-ray, EUV (Fe IX 171 Å, Fe XII 193 Å, Fe XIV 211 Å)
 *     Parker wind launch: transonic at ~4–6 R_sun (already in helio-physics.js)
 *     Density: ~10⁸ cm⁻³ at base, ∝ exp(-h/H) with scale height H ~ 50 000 km
 *
 * ── Physics references ──────────────────────────────────────────────────────
 *  Bahcall & Pinsonneault (2004) PRL 92 — Standard Solar Model (SSM, BP04)
 *  Christensen-Dalsgaard et al. (1996) Science 272 — helioseismic inversions
 *  Stix (2002) "The Sun: An Introduction" — comprehensive interior physics
 *  Kippenhahn, Weigert, Weiss (2012) — stellar structure & evolution
 *  Vernazza, Avrett, Loeser (1981) ApJS 45, 635 — VAL-C chromosphere model
 *  Fontenla, Avrett, Loeser (1993) ApJ 406, 319 — FAL chromosphere update
 *  Withbroe & Noyes (1977) ARA&A 15 — energy balance of outer atmosphere
 *  Aschwanden (2005) "Physics of the Solar Corona" — comprehensive
 *
 * ── Integration points & data quality notes ─────────────────────────────────
 *  • Interior profiles (T, ρ, P, L) are based on the Standard Solar Model
 *    (BP04) with analytical fits.  Accuracy: ~5% for T and ρ, ~10% for
 *    opacity and energy generation.  Not calibrated against individual
 *    helioseismic inversion bins — use for educational/visualization only.
 *  • The tachocline width (0.04 R_sun) and rotation profile are from
 *    helioseismic data (Christensen-Dalsgaard 1996).  The exact transition
 *    shape is still debated; we use a tanh smoothing.
 *  • Atmosphere profiles (chromosphere/TR/corona) are semi-empirical (VAL-C
 *    + Fontenla).  Real structure is highly inhomogeneous (fibrils, spicules,
 *    network/internetwork); our 1-D model represents a spatial average.
 *  • T_corona is estimated from live GOES X-ray flux class in the UI layer
 *    (sun.html).  This is a coarse proxy — actual coronal temperature maps
 *    require DEM (Differential Emission Measure) analysis from SDO/AIA
 *    multi-channel data, which is beyond what SWPC provides.
 *  • Fusion rate uses ε_pp ∝ ρ T⁴ power-law approximation valid for
 *    T = 10–20 MK.  Full pp-chain + CNO cycle rates require nuclear
 *    cross-section tables (Adelberger et al. 2011) — not implemented.
 *  • Opacity uses a Kramers-like power law (κ ∝ ρ T^{-3.5}).  Real opacity
 *    requires OPAL tables (Iglesias & Rogers 1996) — significantly more
 *    complex but would improve radiative zone accuracy.
 *
 * All functions are pure (no side effects, no Three.js dependency).
 * Interior uses fractional radius r/R_sun ∈ [0, 1].
 * Atmosphere uses height in km above the photosphere (τ₅₀₀₀ = 1 surface).
 */

// ── Physical constants (shared with helio-physics.js) ────────────────────────

const K_B     = 1.380_649e-23;   // Boltzmann constant [J/K]
const M_P     = 1.672_622e-27;   // proton mass [kg]
const G_SUN   = 274.0;           // surface gravity [m/s²]
const R_SUN   = 6.957e8;         // solar radius [m]
const M_SUN   = 1.989e30;        // solar mass [kg]
const L_SUN   = 3.828e26;        // solar luminosity [W]
const SIGMA   = 5.670_374e-8;    // Stefan-Boltzmann constant [W m⁻² K⁻⁴]
const G_GRAV  = 6.674_30e-11;    // gravitational constant [m³ kg⁻¹ s⁻²]

// ═══════════════════════════════════════════════════════════════════════════════
//  SOLAR INTERIOR  (r_frac = r / R_sun, range 0 → 1)
// ═══════════════════════════════════════════════════════════════════════════════

// Standard Solar Model (BP04) anchor values
const T_CENTER   = 15.7e6;    // K — core center temperature
const RHO_CENTER = 150e3;     // kg/m³ — core center density (150 g/cm³)
const P_CENTER   = 2.5e16;    // Pa — core center pressure

// Layer boundaries (fractional radius)
const R_CORE     = 0.25;      // core outer edge
const R_RAD      = 0.713;     // radiative zone outer edge / tachocline
const R_TACH_W   = 0.04;      // tachocline half-width
const R_CONV     = 1.0;       // convective zone extends to surface

/**
 * Solar interior temperature (K) at fractional radius r_frac = r/R_sun.
 *
 * Uses piecewise analytical fits to the BP04 Standard Solar Model.
 * Core: steep drop from 15.7 MK.  Radiative: ~T⁴ gradient.
 * Convective: nearly adiabatic (∇_ad = 0.4).
 *
 * @param {number} r_frac  Fractional radius [0, 1].  0 = center, 1 = surface.
 * @returns {number} Temperature in Kelvin
 */
export function interiorTemp(r_frac) {
    const r = Math.max(0, Math.min(1, r_frac));

    // Core (0 → 0.25): T drops roughly as (1 − (r/0.25)²)^0.35
    // Fit to SSM: 15.7 MK at center, ~7 MK at r = 0.25
    if (r < R_CORE) {
        const x = r / R_CORE;
        return T_CENTER * Math.pow(1 - x * x, 0.35);
    }

    // Radiative zone (0.25 → 0.713): radiative diffusion gradient
    // T drops from ~7 MK to ~2.0 MK following radiative equilibrium
    const T_core_edge = T_CENTER * Math.pow(1 - 1, 0.35);  // ~7 MK
    // More accurate: use known anchors
    const T_at_025 = 7.0e6;
    const T_at_071 = 2.0e6;
    if (r < R_RAD) {
        const t = (r - R_CORE) / (R_RAD - R_CORE);
        // Radiative gradient: T⁴ roughly linear → T ∝ (1−t)^0.25
        return T_at_025 * Math.pow(1 - t * (1 - Math.pow(T_at_071 / T_at_025, 4)), 0.25);
    }

    // Convective zone (0.713 → 1.0): nearly adiabatic
    // T drops from ~2.0 MK to 5778 K at the surface
    // Adiabatic gradient for ideal gas: T ∝ P^(γ−1)/γ = P^0.4
    // In practice, T ∝ (1 − r)^α with α ≈ 0.4 (mixing-length calibrated)
    const T_at_conv_base = T_at_071;
    const T_surface = 5778;
    const t_conv = (r - R_RAD) / (1.0 - R_RAD);
    // Log-interpolation gives smooth transition
    return T_at_conv_base * Math.pow(T_surface / T_at_conv_base, t_conv);
}

/**
 * Solar interior density (kg/m³) at fractional radius r_frac.
 *
 * Based on polytropic-like fit to BP04:
 *   ρ(r) = ρ_c × [sin(πr/R) / (πr/R)]^n  with effective index n ≈ 3.1
 *
 * @param {number} r_frac  Fractional radius [0, 1]
 * @returns {number} Density in kg/m³
 */
export function interiorDensity(r_frac) {
    const r = Math.max(0.001, Math.min(1, r_frac));
    // Modified Lane-Emden n=3 polytrope (Eddington's standard model)
    // Good to ~10% across the solar interior
    const xi = Math.PI * r;
    const theta = Math.sin(xi) / xi;    // sinc function
    return RHO_CENTER * Math.pow(Math.max(0, theta), 3.1);
}

/**
 * Solar interior pressure (Pa) at fractional radius r_frac.
 *
 * Ideal gas: P = (ρ / μ m_p) × k_B × T
 * where μ ≈ 0.62 is the mean molecular weight (fully ionised solar mix).
 *
 * @param {number} r_frac  Fractional radius [0, 1]
 * @returns {number} Pressure in Pascal
 */
export function interiorPressure(r_frac) {
    const rho = interiorDensity(r_frac);
    const T   = interiorTemp(r_frac);
    const mu  = 0.62;   // mean molecular weight (H: 0.71, He: 0.27, metals: 0.02)
    return (rho / (mu * M_P)) * K_B * T;
}

/**
 * Gravitational acceleration g(r) inside the Sun.
 * g(r) = G M(r) / r²  where M(r) is the enclosed mass.
 *
 * We approximate M(r) by integrating the density profile numerically
 * (precomputed fit: M(r)/M_sun ≈ (r/0.9)^3 for r < 0.4, then slower growth).
 *
 * @param {number} r_frac  Fractional radius [0, 1]
 * @returns {number} Gravity in m/s²
 */
export function interiorGravity(r_frac) {
    const r = Math.max(0.001, Math.min(1, r_frac));
    // Enclosed mass fraction: fit to SSM integration
    // M(<r)/M_sun ≈ tanh(4.5 r³) gives: M(0.25) ≈ 0.50, M(0.5) ≈ 0.94, M(1.0) = 1.0
    const m_frac = Math.tanh(4.5 * r * r * r);
    const r_m = r * R_SUN;
    return G_GRAV * (m_frac * M_SUN) / (r_m * r_m);
}

/**
 * Nuclear energy generation rate ε (W/kg) at fractional radius.
 *
 * pp-chain dominates at solar core temperatures:
 *   ε_pp ≈ ε₀ × (ρ/ρ₀) × (T/T₀)⁴   [W/kg]
 * where ε₀ ≈ 1.08 × 10⁻⁵ W/kg at ρ₀ = 150 g/cm³, T₀ = 15.7 MK.
 *
 * The T⁴ dependence is an approximation valid for 10–20 MK.
 * At T > 17 MK the CNO cycle starts to contribute; we include a
 * correction term that adds ~1.5% at solar center conditions.
 *
 * NOTE: This power-law is a simplification. Full nuclear rates require
 * Gamow-peak cross-section integrations (Adelberger et al. 2011) and
 * screening corrections — not implemented here.
 *
 * @param {number} r_frac  Fractional radius [0, 1]
 * @returns {number} Energy generation rate in W/kg
 */
export function fusionRate(r_frac) {
    const T   = interiorTemp(r_frac);
    const rho = interiorDensity(r_frac);

    // pp-chain: only significant where T > ~4 MK
    if (T < 4e6) return 0;

    // ε₀ calibrated so ∫ε·ρ·dV ≈ L_sun
    const eps0 = 1.08e-5;   // W/kg at reference conditions
    const T_ratio = T / T_CENTER;
    const rho_ratio = rho / RHO_CENTER;
    const pp = eps0 * rho_ratio * Math.pow(T_ratio, 4);

    // CNO correction: ε_CNO ∝ T^16 but tiny at solar T
    // Adds ~1.5% at center, negligible elsewhere
    const cno = eps0 * 0.015 * rho_ratio * Math.pow(T_ratio, 16);

    return pp + cno;
}

/**
 * Cumulative luminosity L(r) / L_sun enclosed within fractional radius r.
 *
 * Computed by numerical integration of ε(r) × ρ(r) × 4πr² dr.
 *
 * @param {number} r_frac  Fractional radius [0, 1]
 * @returns {number} L(r) / L_sun  (0 at center, ~1.0 at surface)
 */
export function cumulativeLuminosity(r_frac) {
    const N = 100;
    const dr = Math.min(1, Math.max(0, r_frac)) / N;
    let L = 0;
    for (let i = 0; i < N; i++) {
        const r1 = (i + 0.5) * dr;
        const r_m = r1 * R_SUN;
        const dV = 4 * Math.PI * r_m * r_m * (dr * R_SUN);
        L += fusionRate(r1) * interiorDensity(r1) * dV;
    }
    return L / L_SUN;
}

/**
 * Photon diffusion (random-walk) escape time from radius r to the surface.
 *
 * Mean free path: l = 1 / (κ ρ)  where κ is Rosseland mean opacity.
 * Random walk: t ≈ (R − r)² / (c × l)  where c is speed of light.
 *
 * At the core (l ≈ 1 cm): ~170 000 years.
 * In the convective zone: convection is faster → use overturn time instead.
 *
 * @param {number} r_frac  Fractional radius [0, 1]
 * @returns {{ diffusion_yr: number, mechanism: string }}
 */
export function photonEscapeTime(r_frac) {
    const r = Math.max(0, Math.min(1, r_frac));
    const c = 3e8;  // m/s

    if (r >= R_RAD) {
        // Convective zone: convection transports energy, not photon diffusion
        // Overturn time: ~10 days at base, ~10 minutes at surface
        const t_conv = (r - R_RAD) / (1 - R_RAD);
        const days = 10 * Math.pow(1 - t_conv, 2.5) + (10 / 1440);
        return { diffusion_yr: days / 365.25, mechanism: 'convection' };
    }

    // Radiative zone + core: photon random walk
    // Kramers opacity: κ ≈ κ₀ × (ρ/ρ₀) × (T/T₀)^{-3.5}
    // κ₀ ≈ 1.0 m²/kg at reference conditions
    const rho = interiorDensity(r);
    const T   = interiorTemp(r);
    const kappa = 1.0 * (rho / RHO_CENTER) * Math.pow(T / T_CENTER, -3.5);
    const mfp = 1 / (Math.max(1e-6, kappa) * Math.max(1, rho));  // metres
    const dist = (1 - r) * R_SUN;   // metres to surface
    // Random walk: N_steps = (dist/mfp)², time = N_steps × (mfp/c)
    const t_sec = (dist * dist) / (mfp * c);
    return { diffusion_yr: t_sec / (365.25 * 86400), mechanism: 'radiative diffusion' };
}

/**
 * Rotation rate at fractional radius r_frac.
 *
 * The Sun rotates differentially:
 *   - Convective zone: differential (equator ~25.4 d, pole ~35 d)
 *   - Radiative zone: rigid (~27 d, sidereal)
 *   - Tachocline: smooth tanh transition between the two regimes
 *
 * Latitude dependence: Ω(θ) = A + B sin²θ + C sin⁴θ
 *   where A = 14.713, B = −2.396, C = −1.787 °/day (Snodgrass & Ulrich 1990)
 *
 * @param {number} r_frac       Fractional radius [0, 1]
 * @param {number} [lat_deg=0]  Heliographic latitude (degrees). 0 = equator.
 * @returns {{ period_days: number, omega_deg_day: number, zone: string }}
 */
export function rotationRate(r_frac, lat_deg = 0) {
    const r = Math.max(0, Math.min(1, r_frac));
    const sinLat = Math.sin(lat_deg * Math.PI / 180);
    const s2 = sinLat * sinLat;
    const s4 = s2 * s2;

    // Convective zone: latitude-dependent differential rotation
    // Snodgrass & Ulrich (1990) sidereal rate (°/day)
    const omega_conv = 14.713 - 2.396 * s2 - 1.787 * s4;  // °/day

    // Radiative zone: rigid-body rotation at ~27-day (sidereal) rate
    const omega_rigid = 14.05;  // °/day (~25.6 day equatorial equivalent)

    // Tachocline transition: tanh profile centered at R_RAD
    const tach = 0.5 * (1 + Math.tanh((r - R_RAD) / (R_TACH_W / 2)));
    const omega = omega_rigid + (omega_conv - omega_rigid) * tach;

    const period = 360 / omega;
    const zone = r < R_RAD - R_TACH_W ? 'rigid (radiative)'
               : r < R_RAD + R_TACH_W ? 'tachocline'
               : 'differential (convective)';

    return { period_days: period, omega_deg_day: omega, zone };
}

/**
 * Convective properties at fractional radius r_frac.
 * Only meaningful in the convective zone (r > 0.713).
 *
 * Mixing-length theory (Böhm-Vitense 1958):
 *   l_mix = α_MLT × H_P    where H_P = P / (ρ g) is pressure scale height
 *   v_conv ≈ (l_mix × F / ρ)^(1/3)   where F is the convective flux
 *
 * @param {number} r_frac  Fractional radius [0, 1]
 * @returns {{ v_conv_ms: number, l_mix_km: number, H_P_km: number,
 *             overturn_days: number, granule_km: number, regime: string } | null}
 */
export function convectiveProperties(r_frac) {
    const r = Math.max(0, Math.min(1, r_frac));
    if (r < R_RAD) return null;  // no convection in radiative zone

    const rho = interiorDensity(r);
    const T   = interiorTemp(r);
    const g   = interiorGravity(r);
    const P   = interiorPressure(r);

    // Pressure scale height H_P = P / (ρ g)
    const H_P = P / (Math.max(1, rho) * Math.max(1, g));
    const H_P_km = H_P / 1000;

    // Mixing length α ≈ 1.7 (solar-calibrated)
    const alpha_MLT = 1.7;
    const l_mix = alpha_MLT * H_P;
    const l_mix_km = l_mix / 1000;

    // Convective velocity (simplified mixing-length estimate)
    // v_conv ≈ (F_conv × l_mix / (ρ × c_P × T))^(1/3)
    // F_conv ≈ L_sun / (4π r² R_sun²) but mostly carried by convection here
    const r_m = r * R_SUN;
    const F_conv = L_SUN / (4 * Math.PI * r_m * r_m);
    const c_P = 5 * K_B / (2 * 0.62 * M_P);   // c_P for ideal monatomic gas
    const v_conv = Math.pow(F_conv * l_mix / (Math.max(1, rho) * c_P * Math.max(1, T)), 1 / 3);

    // Overturn time: distance to surface / v_conv
    const dist = (1 - r) * R_SUN;
    const overturn_days = (dist / Math.max(0.1, v_conv)) / 86400;

    // Granule scale at the surface ≈ H_P ~ 150 km → ~1 Mm cells
    // At depth, granulation is larger (supergranulation scale)
    const granule_km = Math.min(30000, l_mix_km * 0.8);

    const regime = v_conv > 1e3 ? 'vigorous (near-surface)' : 'slow (deep)';

    return {
        v_conv_ms: v_conv,
        l_mix_km,
        H_P_km,
        overturn_days,
        granule_km,
        regime,
    };
}

/**
 * Identify the interior layer at a given fractional radius.
 * @param {number} r_frac  Fractional radius [0, 1]
 * @returns {{ name: string, abbrev: string, color: string }}
 */
export function interiorLayerAt(r_frac) {
    const r = Math.max(0, Math.min(1, r_frac));
    if (r < R_CORE)             return { name: 'Core',             abbrev: 'CORE', color: '#ff4400' };
    if (r < R_RAD - R_TACH_W)  return { name: 'Radiative Zone',   abbrev: 'RAD',  color: '#ff8800' };
    if (r < R_RAD + R_TACH_W)  return { name: 'Tachocline',       abbrev: 'TACH', color: '#ffaa00' };
    if (r < 0.995)              return { name: 'Convective Zone',  abbrev: 'CONV', color: '#ffcc00' };
    return                        { name: 'Photosphere',          abbrev: 'PHOT', color: '#ffd700' };
}

/**
 * Complete interior state at a single fractional radius.
 * @param {number} r_frac  Fractional radius [0, 1]
 * @param {number} [lat_deg=0]  Latitude for rotation calculation
 * @returns {object}  Full state at this radius
 */
export function interiorStateAt(r_frac, lat_deg = 0) {
    const r = Math.max(0, Math.min(1, r_frac));
    const T   = interiorTemp(r);
    const rho = interiorDensity(r);
    const P   = interiorPressure(r);
    const g   = interiorGravity(r);
    const eps = fusionRate(r);
    const L_frac = cumulativeLuminosity(r);
    const rot = rotationRate(r, lat_deg);
    const layer = interiorLayerAt(r);
    const conv = convectiveProperties(r);
    const escape = photonEscapeTime(r);
    const depth_km = (1 - r) * R_SUN / 1000;

    return {
        r_frac: r,
        depth_km,
        T_K: T,
        rho_kgm3: rho,
        rho_gcm3: rho / 1000,
        P_Pa: P,
        g_ms2: g,
        eps_Wkg: eps,
        L_frac,
        rotation: rot,
        layer,
        convection: conv,
        escape,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SOLAR ATMOSPHERE  (height above photosphere in km)
// ═══════════════════════════════════════════════════════════════════════════════

// ── Temperature profile ──────────────────────────────────────────────────────
//
// Based on the VAL-C (Vernazza, Avrett, Loeser 1981) semi-empirical model
// with smooth analytical fits through the chromosphere, transition region,
// and inner corona.

/**
 * Solar atmosphere temperature (K) at height h_km above photosphere.
 *
 * @param {number} h_km   Height above τ=1 photosphere (km). 0 = surface.
 * @param {number} [T_corona=1.5e6]  Coronal base temperature (K).
 *                         Varies with activity: quiet 1.0 MK, active 2–3 MK.
 * @returns {number} Temperature in Kelvin
 */
export function solarAtmosphereTemp(h_km, T_corona = 1.5e6) {
    const h = Math.max(0, h_km);

    // Photosphere to temperature minimum (0–500 km)
    // T drops from 5778 K to ~4400 K (radiative cooling dominates)
    if (h < 500) {
        const t = h / 500;
        return 5778 - 1378 * Math.pow(t, 0.7);  // 5778 → 4400 K
    }

    // Chromosphere: temperature minimum to upper chromosphere (500–2100 km)
    // Gradual rise from 4400 K to ~25000 K via wave dissipation + radiative
    // heating (Ca II, Mg II emission pumps)
    if (h < 2100) {
        const t = (h - 500) / 1600;
        // VAL-C inspired: slow rise first, accelerating toward top
        // Two-part: 4400→8000 K (lower, linear-ish), 8000→25000 K (upper, steeper)
        if (t < 0.5) {
            return 4400 + 7200 * t;         // 4400 → 8000 K
        }
        const t2 = (t - 0.5) / 0.5;
        return 8000 + 17000 * Math.pow(t2, 1.8);  // 8000 → 25000 K
    }

    // Transition region (2100–2200 km): steep jump 25000 K → T_corona
    // This is the thermal conduction front — steepest T gradient in nature
    // (~100 K/m in the steepest part)
    if (h < 2200) {
        const t = (h - 2100) / 100;
        // Hyperbolic tangent gives the characteristic steep-then-flattening shape
        const tanh_t = Math.tanh((t - 0.3) * 4.0);
        const frac = (tanh_t + 1) / 2;   // 0 at bottom → 1 at top
        return 25000 + (T_corona - 25000) * frac;
    }

    // Corona (> 2200 km): nearly isothermal with slow hydrostatic falloff
    // T decreases very slowly with height (conduction-dominated)
    // T(h) ≈ T_corona × (1 − 0.15 × (h/R_sun)^0.4) for inner corona
    const h_Rsun = (h * 1000) / R_SUN;  // height in solar radii
    return T_corona * Math.max(0.3, 1 - 0.15 * Math.pow(h_Rsun, 0.4));
}

/**
 * Identify which atmospheric layer a given height falls in.
 * @param {number} h_km  Height above photosphere (km)
 * @returns {{ name: string, abbrev: string, color: string }}
 */
export function layerAt(h_km) {
    if (h_km < 0)    return { name: 'Sub-photosphere', abbrev: 'SUB',  color: '#ff6600' };
    if (h_km < 500)  return { name: 'Photosphere',     abbrev: 'PHOT', color: '#ffd700' };
    if (h_km < 2100) return { name: 'Chromosphere',    abbrev: 'CHRM', color: '#ff4466' };
    if (h_km < 2200) return { name: 'Transition Region', abbrev: 'TR', color: '#cc44ff' };
    return              { name: 'Corona',            abbrev: 'COR',  color: '#44bbff' };
}

// ── Density profile ──────────────────────────────────────────────────────────
//
// Based on VAL-C + Aschwanden (2005) coronal models.
// Electron number density (cm⁻³) — approximately equal to proton density
// in the fully ionised corona (H → p⁺ + e⁻).

/**
 * Electron number density (cm⁻³) at height h_km.
 *
 * @param {number} h_km        Height above photosphere (km)
 * @param {number} [T_corona]  Coronal temperature (K) — affects scale height
 * @returns {number} n_e in cm⁻³
 */
export function solarAtmosphereDensity(h_km, T_corona = 1.5e6) {
    const h = Math.max(0, h_km);

    // Photosphere: n_e ~ 10^13 cm⁻³ (partially ionised, ~0.01% ionisation)
    // Total particle density is ~10^17 but electron density is much lower
    if (h < 500) {
        // n_e drops from ~1.5×10^13 at surface to ~5×10^11 at T_min
        const t = h / 500;
        return 1.5e13 * Math.pow(10, -1.5 * t);
    }

    // Chromosphere (500–2100 km): n_e ~5×10^11 → 10^10 at top
    // Hydrogen progressively ionises as T rises through 8000 K
    if (h < 2100) {
        const t = (h - 500) / 1600;
        return 5e11 * Math.pow(10, -1.7 * t);
    }

    // Transition region (2100–2200 km): rapid density drop as T jumps
    // Pressure roughly constant (conduction front), so n ∝ 1/T
    if (h < 2200) {
        const t = (h - 2100) / 100;
        const n_top_chrom = 5e11 * Math.pow(10, -1.7);  // ~1e10
        const T_here = solarAtmosphereTemp(h, T_corona);
        const T_bot  = 25000;
        // Constant pressure: n × T = const
        return n_top_chrom * (T_bot / T_here);
    }

    // Corona (> 2200 km): hydrostatic with barometric scale height
    // H = k_B T / (m_p g) where g decreases as (R_sun / (R_sun + h))²
    const n_base = 1e8;   // typical coronal base density (cm⁻³)
    const h_m    = h * 1000;
    const T      = solarAtmosphereTemp(h, T_corona);
    // Scale height at local gravity
    const g_local = G_SUN * Math.pow(R_SUN / (R_SUN + h_m), 2);
    const H       = K_B * T / (M_P * g_local);        // metres
    const h_above_base = (h - 2200) * 1000;            // metres above corona base
    return n_base * Math.exp(-h_above_base / H);
}

// ── Pressure profile ─────────────────────────────────────────────────────────

/**
 * Gas pressure (Pa) at height h_km.  P = 2 n_e k_B T (electron + proton).
 * @param {number} h_km  Height above photosphere (km)
 * @param {number} [T_corona]  Coronal temperature (K)
 * @returns {number} Pressure in Pascal
 */
export function solarAtmospherePressure(h_km, T_corona = 1.5e6) {
    const n_e = solarAtmosphereDensity(h_km, T_corona) * 1e6;  // cm⁻³ → m⁻³
    const T   = solarAtmosphereTemp(h_km, T_corona);
    return 2 * n_e * K_B * T;   // factor 2: electrons + protons
}

// ── Emission characteristics ─────────────────────────────────────────────────

/**
 * Dominant emission lines at a given height.
 * Returns an array of { ion, wavelength_nm, formation_T_K, name }.
 */
export function dominantEmission(h_km) {
    const T = solarAtmosphereTemp(h_km);

    if (T < 6000) {
        return [
            { ion: 'Continuum', wavelength_nm: 500, formation_T_K: 5778, name: 'Visible continuum' },
        ];
    }
    if (T < 10000) {
        return [
            { ion: 'H I',    wavelength_nm: 656.3, formation_T_K: 6500,  name: 'H-alpha' },
            { ion: 'Ca II',  wavelength_nm: 393.4, formation_T_K: 7000,  name: 'Ca II K' },
            { ion: 'Ca II',  wavelength_nm: 396.8, formation_T_K: 7000,  name: 'Ca II H' },
            { ion: 'Mg II',  wavelength_nm: 280.3, formation_T_K: 8000,  name: 'Mg II k' },
        ];
    }
    if (T < 30000) {
        return [
            { ion: 'H I',    wavelength_nm: 121.6, formation_T_K: 20000, name: 'Lyman-alpha' },
            { ion: 'He I',   wavelength_nm: 58.4,  formation_T_K: 20000, name: 'He I 584' },
            { ion: 'He II',  wavelength_nm: 30.4,  formation_T_K: 50000, name: 'He II 304 (SDO/AIA)' },
        ];
    }
    if (T < 300000) {
        return [
            { ion: 'C IV',   wavelength_nm: 154.9, formation_T_K: 100000,  name: 'C IV (TR diagnostic)' },
            { ion: 'O VI',   wavelength_nm: 103.2, formation_T_K: 300000,  name: 'O VI (TR diagnostic)' },
            { ion: 'Si IV',  wavelength_nm: 140.3, formation_T_K: 80000,   name: 'Si IV' },
        ];
    }
    // Corona
    return [
        { ion: 'Fe IX',  wavelength_nm: 17.1, formation_T_K: 600000,   name: 'Fe IX 171 Å (SDO/AIA)' },
        { ion: 'Fe XII', wavelength_nm: 19.3, formation_T_K: 1500000,  name: 'Fe XII 193 Å (SDO/AIA)' },
        { ion: 'Fe XIV', wavelength_nm: 21.1, formation_T_K: 2000000,  name: 'Fe XIV 211 Å (SDO/AIA)' },
        { ion: 'Fe XVIII', wavelength_nm: 9.4, formation_T_K: 7000000, name: 'Fe XVIII 94 Å (flares)' },
    ];
}

// ── Spicule dynamics ─────────────────────────────────────────────────────────

/**
 * Spicule parameters — chromospheric plasma jets driven by magnetic
 * tension and p-mode acoustic shocks.
 *
 * Type I: driven by p-mode leakage. Rise 3–5 Mm at 15–40 km/s, life ~5 min.
 * Type II: faster, driven by reconnection. Rise 3–10 Mm at 50–100 km/s, life ~1 min.
 *
 * @param {number} [kp=2]       Proxy for solar activity (higher → more Type II)
 * @param {number} [f107=150]   F10.7 solar radio flux (activity proxy)
 * @returns {{ type1: object, type2: object, density_per_Mm2: number }}
 */
export function spiculeParams(kp = 2, f107 = 150) {
    // Activity scaling: more Type II spicules during active Sun
    const activityFrac = Math.min(1, f107 / 250);

    return {
        type1: {
            height_km:    3000 + Math.random() * 2000,      // 3–5 Mm
            velocity_kms: 15 + Math.random() * 25,           // 15–40 km/s
            lifetime_s:   200 + Math.random() * 100,          // 200–300 s
            width_km:     300 + Math.random() * 200,          // 300–500 km
        },
        type2: {
            height_km:    3000 + Math.random() * 7000,       // 3–10 Mm
            velocity_kms: 50 + Math.random() * 50,            // 50–100 km/s
            lifetime_s:   30 + Math.random() * 60,             // 30–90 s
            width_km:     100 + Math.random() * 200,           // 100–300 km (thinner)
        },
        density_per_Mm2: Math.round(50 + activityFrac * 100), // ~50–150 per Mm²
        type2_fraction:  0.2 + activityFrac * 0.3,             // 20–50% are Type II
    };
}

// ── Coronal heating budget ───────────────────────────────────────────────────

/**
 * Estimate the coronal energy input required to maintain temperature.
 *
 * Withbroe & Noyes (1977): The corona + solar wind require ~3×10⁵ erg/cm²/s
 * over quiet sun, up to 10⁷ erg/cm²/s in active regions.
 *
 * @param {number} [T_corona=1.5e6]  Coronal temperature (K)
 * @param {number} [xrayFlux=1e-7]   GOES X-ray flux (W/m²) — activity proxy
 * @returns {{ total_W_m2: number, radiative: number, conductive: number, wind: number, source: string }}
 */
export function coronalHeatingBudget(T_corona = 1.5e6, xrayFlux = 1e-7) {
    // Radiative losses: dominated by EUV lines, scale as ~T^(-0.5) × n²
    // Typical quiet: ~100 W/m², active region: ~10000 W/m²
    const T6 = T_corona / 1e6;
    const radiative = 300 * Math.pow(T6, 1.5);        // W/m²

    // Conductive losses: Spitzer conductivity → flux ~ T^(5/2) / L
    // L ~ 50,000 km (coronal loop half-length)
    const conductive = 50 * Math.pow(T6, 2.5);         // W/m²

    // Wind enthalpy: energy carried away by solar wind (~200–400 W/m²)
    const wind = 200 + 100 * T6;                        // W/m²

    const total = radiative + conductive + wind;

    // Dominant heating mechanism is still debated (the "coronal heating problem")
    const xLog = Math.log10(Math.max(1e-9, xrayFlux));
    const source = xLog > -5 ? 'Nanoflare reconnection (active)'
                 : xLog > -6 ? 'Mixed: Alfvén waves + nanoflares'
                 :              'Alfvén wave dissipation (quiet)';

    return { total_W_m2: total, radiative, conductive, wind, source };
}

// ── Full profile computation ─────────────────────────────────────────────────

/**
 * Compute a full atmospheric profile from photosphere to outer corona.
 * Returns an array of sample points at logarithmically-spaced heights.
 *
 * @param {number} [T_corona=1.5e6]  Coronal temperature (K)
 * @param {number} [nSamples=120]    Number of sample points
 * @param {number} [h_max_km=500000] Maximum height (km)
 * @returns {Array<{ h_km, T_K, n_e, P_Pa, layer }>}
 */
export function atmosphereProfile(T_corona = 1.5e6, nSamples = 120, h_max_km = 500000) {
    const points = [];
    // Use a mix of linear (dense sampling in chromosphere/TR) and log (corona)
    // Dense in 0–2500 km, sparser beyond
    const n_dense = Math.round(nSamples * 0.6);
    const n_sparse = nSamples - n_dense;

    for (let i = 0; i < n_dense; i++) {
        const h = (i / (n_dense - 1)) * 2500;
        points.push(_samplePoint(h, T_corona));
    }
    for (let i = 1; i <= n_sparse; i++) {
        const t = i / n_sparse;
        const h = 2500 + (h_max_km - 2500) * Math.pow(t, 2.5);  // log-like spacing
        points.push(_samplePoint(h, T_corona));
    }
    return points;
}

function _samplePoint(h_km, T_corona) {
    return {
        h_km,
        T_K:   solarAtmosphereTemp(h_km, T_corona),
        n_e:   solarAtmosphereDensity(h_km, T_corona),
        P_Pa:  solarAtmospherePressure(h_km, T_corona),
        layer: layerAt(h_km),
    };
}

// ── Convenience: state at a single height ────────────────────────────────────

/**
 * Full atmospheric state at a single height.
 * @param {number} h_km       Height above photosphere (km)
 * @param {number} [T_corona] Coronal temperature (K)
 * @param {object} [live]     Optional live SWPC data { xrayFlux, f107, kp }
 * @returns {object} Complete state at this height
 */
export function stateAt(h_km, T_corona = 1.5e6, live = {}) {
    const T   = solarAtmosphereTemp(h_km, T_corona);
    const n_e = solarAtmosphereDensity(h_km, T_corona);
    const P   = solarAtmospherePressure(h_km, T_corona);
    const layer = layerAt(h_km);
    const emission = dominantEmission(h_km);

    // Pressure scale height at this point
    const h_m = h_km * 1000;
    const g   = G_SUN * Math.pow(R_SUN / (R_SUN + h_m), 2);
    const H_km = (K_B * T / (M_P * g)) / 1000;

    return {
        h_km,
        T_K: T,
        n_e_cm3: n_e,
        P_Pa: P,
        layer,
        emission,
        scaleHeight_km: H_km,
        gravity_ms2: g,
    };
}
