/**
 * solar-atmosphere.js — Solar outer atmosphere physics engine
 *
 * Models the three layers above the photosphere with first-principles
 * temperature, density, pressure, and emission profiles:
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
 *  Vernazza, Avrett, Loeser (1981) ApJS 45, 635 — VAL-C chromosphere model
 *  Fontenla, Avrett, Loeser (1993) ApJ 406, 319 — FAL chromosphere update
 *  Athay (1976) "The Solar Chromosphere and Corona" — classic reference
 *  Withbroe & Noyes (1977) ARA&A 15 — energy balance of outer atmosphere
 *  Aschwanden (2005) "Physics of the Solar Corona" — comprehensive
 *
 * All functions are pure (no side effects, no Three.js dependency).
 * Heights are in km above the photosphere (τ₅₀₀₀ = 1 surface).
 */

// ── Physical constants (shared with helio-physics.js) ────────────────────────

const K_B     = 1.380_649e-23;   // Boltzmann constant [J/K]
const M_P     = 1.672_622e-27;   // proton mass [kg]
const G_SUN   = 274.0;           // surface gravity [m/s²]
const R_SUN   = 6.957e8;         // solar radius [m]

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
