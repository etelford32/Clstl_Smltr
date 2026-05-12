/**
 * habitable.js — Habitable zone, equilibrium temperature, atmospheric escape.
 *
 *   - Kopparapu et al. (2013, ApJ 765, 131; 2014, ApJL 787, L29)
 *     polynomial fits S_eff(T_eff) for 5 HZ boundaries.
 *   - Equilibrium temperature with Bond albedo + grey-atmosphere greenhouse.
 *   - Energy-limited XUV atmospheric escape (Watson+ 1981; Erkaev+ 2007;
 *     efficiency calibrated to Caldiroli+ 2025).
 *   - Stellar L(t), T_eff(t), F_XUV(t) tracks based on Baraffe+ 2015 /
 *     Tu+ 2015 power-law fits for FGK stars.
 *
 * All distances/luminosities returned in physical units (AU, L_sun, W/m^2).
 */

import { L_SUN, AU, M_SUN, R_SUN, SIGMA_SB, YEAR } from './physics.js';

// ─── Kopparapu 2013/14 polynomial coefficients ───────────────────────────────
// For each boundary: S_eff = S0 + a*T + b*T^2 + c*T^3 + d*T^4   (T = T_eff - 5780)
// Valid 2600 K <= T_eff <= 7200 K.
const KOPPARAPU = {
    recentVenus:     { S0: 1.7763,  a: 1.4335e-4, b: 3.3954e-9,  c: -7.6364e-12, d: -1.1950e-15 },
    runawayGreen:    { S0: 1.0385,  a: 1.2456e-4, b: 1.4612e-8,  c: -7.6345e-12, d: -1.7511e-15 },
    moistGreen:      { S0: 1.0140,  a: 8.1774e-5, b: 1.7063e-9,  c: -4.3241e-12, d: -6.6462e-16 },
    maxGreen:        { S0: 0.3507,  a: 5.9578e-5, b: 1.6707e-9,  c: -3.0058e-12, d: -5.1925e-16 },
    earlyMars:       { S0: 0.3207,  a: 5.4471e-5, b: 1.5275e-9,  c: -2.1709e-12, d: -3.8282e-16 },
};

export function kopparapuSeff(boundary, Teff) {
    const c = KOPPARAPU[boundary];
    if (!c) throw new Error('unknown HZ boundary: ' + boundary);
    const t = Teff - 5780;
    return c.S0 + c.a*t + c.b*t*t + c.c*t*t*t + c.d*t*t*t*t;
}

// HZ inner/outer distances in AU, given stellar L (in W) and T_eff (K).
export function hzBoundaries(Lstar, Teff) {
    const Lsun = Lstar / L_SUN;
    const boundaries = {};
    for (const key of Object.keys(KOPPARAPU)) {
        const Seff = kopparapuSeff(key, Teff);
        boundaries[key] = Math.sqrt(Lsun / Seff);   // AU
    }
    return boundaries;  // { recentVenus, runawayGreen, moistGreen, maxGreen, earlyMars }
}

// ─── Stellar evolution (very simple) ────────────────────────────────────────
// We use Baraffe+ (1998, 2015) / Tu+ (2015) inspired piecewise behaviour:
//   - Pre-MS: L falls from a few L_sun to ~0.7 L_sun over 30 Myr (for 1 Msun).
//   - MS:    L = L_zams * (1 + 0.4 * t/4.5Gyr) (slow brightening).
//   - F_XUV: saturated at ~1e-3 L_bol for t < 100 Myr, then ∝ t^-1.2.
//
// For a star of mass M in M_sun:
//   L_zams = M^3.5 L_sun (simple MS scaling for FGK; reasonable for 0.5-1.5 Msun)
//   T_eff_zams ≈ 5780 * M^0.6 K
//   t_sat_XUV ≈ 100 Myr * (M/M_sun)^-1 (faster rotators saturate longer)
export function stellarTrack(Mstar_solar, ageYr) {
    const M = Mstar_solar;
    const L_zams = Math.pow(M, 3.5);              // L/Lsun
    const T_zams = 5780 * Math.pow(M, 0.6);
    let L, Teff;

    const tMyr = ageYr / 1e6;
    if (tMyr < 30) {
        // Pre-MS contraction: log-linearly brighten down to L_zams
        const f = tMyr / 30;
        const L_pms_start = 3 * L_zams;           // 3x ZAMS at age=0
        L = L_pms_start * Math.pow(L_zams / L_pms_start, f);
        Teff = T_zams * (0.85 + 0.15 * f);        // a bit cooler in PMS
    } else {
        const tGyr = (tMyr - 30) / 1000;
        L    = L_zams * (1 + 0.4 * tGyr / 4.5);
        Teff = T_zams * (1 + 0.05 * tGyr / 4.5);
    }
    return { L_Lsun: L, L_W: L * L_SUN, Teff };
}

// XUV flux at 1 AU in W/m^2 for an FGK star (Tu+ 2015; saturated ~1e-3 L_bol).
export function xuvFlux1AU(Mstar_solar, ageYr) {
    const t_sat = 100e6 / Math.max(0.5, Mstar_solar);   // yr
    const trk   = stellarTrack(Mstar_solar, ageYr);
    const Lbol  = trk.L_W;
    let Lxuv;
    if (ageYr < t_sat) {
        Lxuv = 1e-3 * Lbol;
    } else {
        Lxuv = 1e-3 * Lbol * Math.pow(ageYr / t_sat, -1.2);
    }
    return Lxuv / (4 * Math.PI * AU * AU);     // W/m^2 at 1 AU
}

// ─── Equilibrium and surface temperature ────────────────────────────────────
//   T_eq = ( (1-A) S / (4 sigma) )^(1/4)
//   T_surf = T_eq * (1 + 3/4 * tau_IR)^(1/4)   (grey atmosphere)
// where tau_IR is the IR optical depth set by the atmosphere composition.
export function equilibriumTemp(SfluxWm2, albedo = 0.3) {
    return Math.pow((1 - albedo) * SfluxWm2 / (4 * SIGMA_SB), 0.25);
}

// Crude greenhouse opacity contributed by atmosphere components.
// Inputs: partial-pressure mixing ratios (sum to 1.0 by default).
//   CO2:  optical depth scales as (pCO2/1 bar)^0.5  -> Wordsworth + Pierrehumbert-style
//   H2O:  doubles each 10 K above 273 K (Clausius-Clapeyron amplifies)
//   N2 :  ~0 opacity
//   CH4:  small contribution
// We treat surface pressure p_surf (bar) explicitly.
export function greenhouseTau(p_surf_bar, mix, T_K) {
    const pCO2 = mix.CO2 * p_surf_bar;
    const pH2O = mix.H2O * p_surf_bar;
    const pCH4 = (mix.CH4 || 0) * p_surf_bar;
    let tau = 0;
    tau += 0.6 * Math.sqrt(Math.max(0, pCO2));            // CO2 broad
    // H2O is strongly temperature-dependent (clouds + vapour scaling)
    const fH2O = Math.max(0, Math.min(50, Math.pow(2, (T_K - 273) / 10)));
    tau += 0.4 * Math.sqrt(Math.max(0, pH2O)) * fH2O;
    tau += 0.2 * Math.sqrt(Math.max(0, pCH4));
    return tau;
}

// Iterate surface T self-consistently with the water-vapour feedback.
export function surfaceTemperature(S_flux, albedo, p_surf_bar, mix) {
    let T = equilibriumTemp(S_flux, albedo);
    for (let i = 0; i < 6; i++) {
        const tau = greenhouseTau(p_surf_bar, mix, T);
        const Teq = equilibriumTemp(S_flux, albedo);
        T = Teq * Math.pow(1 + 0.75 * tau, 0.25);
        if (T > 1500) { T = 1500; break; }   // runaway cap
    }
    return T;
}

// ─── Atmospheric escape ────────────────────────────────────────────────────
// Energy-limited XUV escape (Watson+ 1981; Erkaev+ 2007):
//   dM/dt = epsilon * pi * F_XUV * R_XUV^3 / (G M_p K_tide)
// epsilon = 0.15 (Caldiroli+ 2025 typical for FGK).  K_tide ~ 1 (close to unity for HZ orbits).
export function xuvEscapeRate(F_XUV, R_p, M_p, epsilon = 0.15) {
    const G = 6.67430e-11;
    // R_XUV ~ R_p for compact atmosphere; for puffed up sub-Neptune R_XUV up to 2*R_p.
    const R_XUV = R_p;
    return epsilon * Math.PI * F_XUV * R_XUV * R_XUV * R_XUV / (G * M_p);
}

// Jeans escape rate for a single species (only matters in cold/light cases).
export function jeansParameter(g, m_species, T) {
    // lambda = G M m / (k T R)  but expressed via surface escape velocity vesc:
    // lambda = m vesc^2 / (2 k T). m_species in kg, T in K.
    const K_B = 1.380649e-23;
    // Caller passes g and r implicitly via vesc^2 = 2 g r; we just need ratio.
    return m_species * (2 * g) / (2 * K_B * T);
}

// Habitability classifier given the live S_eff and HZ boundaries.
export function classify(S_eff, hz) {
    if (S_eff > hz.recentVenus * hz.recentVenus / hz.runawayGreen / hz.runawayGreen) return 'venus-zone';
    if (S_eff > hz.runawayGreen ** -2)  return 'venus-zone';
    // Compare flux directly: S_eff (= Lsun / d_AU^2). Inner = larger S_eff.
    const S_runaway = 1 / (hz.runawayGreen * hz.runawayGreen);
    const S_moist   = 1 / (hz.moistGreen   * hz.moistGreen);
    const S_max     = 1 / (hz.maxGreen     * hz.maxGreen);
    const S_emars   = 1 / (hz.earlyMars    * hz.earlyMars);
    if (S_eff > S_runaway) return 'venus-zone';
    if (S_eff > S_moist)   return 'inner-edge';
    if (S_eff > S_max)     return 'habitable';
    if (S_eff > S_emars)   return 'outer-edge';
    return 'frozen';
}

// Convenience: full habitability snapshot for a planet.
export function planetHabitability(planet, star, ageYr) {
    const trk = stellarTrack(star.Mstar_solar, ageYr);
    const d_AU = planet.a / AU;
    const S_flux = trk.L_W / (4 * Math.PI * planet.a * planet.a);   // W/m^2
    const S_eff_inst = (trk.L_Lsun) / (d_AU * d_AU);                // in S_earth units
    const hz = hzBoundaries(trk.L_W, trk.Teff);
    const Teq = equilibriumTemp(S_flux, planet.albedo ?? 0.3);
    const Tsurf = surfaceTemperature(S_flux, planet.albedo ?? 0.3, planet.p_surf_bar ?? 1, planet.mix ?? { N2: 0.78, O2: 0.21, CO2: 0.0004, H2O: 0.01 });
    const F_xuv = xuvFlux1AU(star.Mstar_solar, ageYr) / (d_AU * d_AU);
    const dMdt  = xuvEscapeRate(F_xuv, planet.R_m, planet.m);
    const cls   = classify(S_eff_inst, hz);
    return { S_flux, S_eff_inst, hz, Teq, Tsurf, F_xuv, dMdt, classification: cls, L_Lsun: trk.L_Lsun, Teff: trk.Teff };
}
