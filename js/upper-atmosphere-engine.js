/**
 * upper-atmosphere-engine.js — Parkers Physics thermosphere/exosphere surrogate
 * ═══════════════════════════════════════════════════════════════════════════
 * Pure-JS, zero-dependency physics surrogate for the upper atmosphere
 * (80–2000 km). Mirrors the Jacchia-style exponential fallback in
 * dsmc/pipeline/atmosphere.py so the client-side visualisation matches
 * the backend contract exactly. When the SPARTA-refined surrogate
 * ships (Phase 3), this module will be swapped at a single call site
 * (`density`) — everything downstream keeps working unchanged.
 *
 * Exports:
 *   SPECIES               tuple of the 7 species we track
 *   SPECIES_MASS_KG       per-species atomic/molecular mass in kg
 *   exosphereTempK        Jacchia-ish T∞(F10.7, Ap)
 *   density(opts)         point evaluation at one altitude
 *   sampleProfile(opts)   dense profile from 80 km up
 *   stormPresets          operational test cases
 *
 * All inputs are SI + km; all outputs are SI with altitude in km.
 * Composition fractions come from a smooth log-space blend between
 * altitude anchor points in `_ANCHORS` — the anchors track MSIS / CIRA
 * climatology to within a factor of ~2 across the whole band.
 */

export const SPECIES = ["N2", "O2", "NO", "O", "N", "He", "H"];

export const SPECIES_MASS_KG = {
    N2: 4.6518e-26,
    O2: 5.3133e-26,
    NO: 4.9826e-26,
    O:  2.6567e-26,
    N:  2.3259e-26,
    He: 6.6465e-27,
    H:  1.6737e-27,
};

// ── Physical constants ──────────────────────────────────────────────────────
const KB = 1.380649e-23;        // Boltzmann [J/K]
const G0 = 9.80665;             // surface gravity [m/s²]
const R_EARTH_M = 6_371_000;    // mean Earth radius [m]

// ── Formal atmospheric layers ───────────────────────────────────────────────
// Altitude bands + regime tag for labeling plots and colouring shells.
// Mirrors dsmc/pipeline/profile.py:ATMOSPHERIC_LAYERS.
export const ATMOSPHERIC_LAYERS = [
    {
        id: "troposphere",
        name: "Troposphere",
        minKm: 0, maxKm: 12,
        color: "#6ea6ff",
        description: "Weather layer. Temperature decreases with altitude; ~75% of atmospheric mass.",
    },
    {
        id: "stratosphere",
        name: "Stratosphere",
        minKm: 12, maxKm: 50,
        color: "#9cc6ff",
        description: "Ozone layer. Temperature rises with altitude due to UV absorption.",
    },
    {
        id: "mesosphere",
        name: "Mesosphere",
        minKm: 50, maxKm: 85,
        color: "#7aa8ff",
        description: "Meteor burn-up layer. Coldest region of Earth's atmosphere.",
    },
    {
        id: "thermosphere",
        name: "Thermosphere",
        minKm: 85, maxKm: 600,
        color: "#ff8a4c",
        description: "Absorbs solar EUV. ISS orbits here. Dominant LEO drag source.",
    },
    {
        id: "exosphere",
        name: "Exosphere",
        minKm: 600, maxKm: 10_000,
        color: "#c080ff",
        description: "Molecular free flight. He/H escape; GPS and GEO satellites live here.",
    },
];

// ── Canonical satellite altitudes for the globe overlay ─────────────────────
// Mirrors dsmc/pipeline/profile.py:SATELLITE_REFERENCES.
//
// Each entry that represents an actual orbiting object also carries an
// `orbital` block — Keplerian mean elements at a representative epoch,
// good enough for visual-grade ground-track propagation in the absence
// of a live TLE refresh. The CelesTrak proxy at /api/celestrak/tle can
// upgrade these to real-time mean elements when the page is online; the
// hardcoded values here are the fallback so the visual works offline.
//
// noradId is the NORAD catalog number (also called SATCAT or SCC). It's
// the canonical key for fetching a single satellite's TLE from CelesTrak.
//
// `orbital: null` means "this is a reference altitude, not an object" —
// e.g. the Kármán line. Such entries get a static ring overlay only.
export const SATELLITE_REFERENCES = [
    {
        id: "karman", name: "Kármán line", altitudeKm: 100,
        color: "#ff7070",
        orbital: null,
        description: "Internationally recognised threshold of space (FAI). Below this, aerodynamic flight is possible.",
    },
    {
        id: "iss", name: "ISS", altitudeKm: 420,
        color: "#00ffd0",
        orbital: {
            noradId: 25544,
            inclinationDeg:    51.6,
            raanDeg:            0,
            argPerigeeDeg:      0,
            meanAnomalyDeg0:    0,
            eccentricity:       0.0006,
            periodMin:         92.7,
        },
        description: "International Space Station. Crewed since 2000. Heaviest LEO drag testbed.",
    },
    {
        id: "hubble", name: "Hubble (HST)", altitudeKm: 540,
        color: "#ffd060",
        orbital: {
            noradId: 20580,
            inclinationDeg:    28.5,
            raanDeg:           120,
            argPerigeeDeg:      0,
            meanAnomalyDeg0:   80,
            eccentricity:       0.0003,
            periodMin:         95.4,
        },
        description: "Hubble Space Telescope. Reboost-dependent; entered atmospheric drag regime in 1990.",
    },
    {
        id: "starlink", name: "Starlink shell", altitudeKm: 550,
        color: "#60a0ff",
        orbital: {
            // STARLINK-1007 — first operational v1.0 birds, representative.
            noradId: 44713,
            inclinationDeg:    53.0,
            raanDeg:           240,
            argPerigeeDeg:      0,
            meanAnomalyDeg0:   160,
            eccentricity:       0.0001,
            periodMin:         95.6,
        },
        description: "SpaceX Starlink representative shell at 550 km, 53° inclined. ~5000 active birds.",
    },
    {
        id: "iridium", name: "Iridium NEXT", altitudeKm: 780,
        color: "#a080ff",
        orbital: {
            // IRIDIUM 102 — representative NEXT-generation bird.
            noradId: 41917,
            inclinationDeg:    86.4,
            raanDeg:            60,
            argPerigeeDeg:      0,
            meanAnomalyDeg0:   240,
            eccentricity:       0.0002,
            periodMin:        100.4,
        },
        description: "Iridium NEXT polar constellation. 86.4° inclined; covers high-latitude comms.",
    },

    // ── Crewed + science assets in the LEO drag belt ──────────────────
    {
        id: "tiangong", name: "Tiangong (CSS)", altitudeKm: 385,
        color: "#ff70a0",
        orbital: {
            noradId: 48274,                   // CSS / TIANHE core module
            inclinationDeg:    41.5,
            raanDeg:           300,
            argPerigeeDeg:      0,
            meanAnomalyDeg0:   115,
            eccentricity:       0.0008,
            periodMin:         92.2,
        },
        description: "Chinese Space Station. Crewed since 2021; permanent T-shaped configuration "
                   + "since the Wentian + Mengtian modules docked in 2022.",
    },
    {
        id: "swarm-a", name: "Swarm-A", altitudeKm: 462,
        color: "#80f0d0",
        orbital: {
            noradId: 39452,
            inclinationDeg:    87.4,
            raanDeg:            45,
            argPerigeeDeg:      0,
            meanAnomalyDeg0:   200,
            eccentricity:       0.0011,
            periodMin:         93.8,
        },
        description: "ESA Swarm magnetic-field probe (one of three). Maps the lithospheric, "
                   + "ionospheric and core fields — gold-standard data for the magnetic-cascade "
                   + "module driving this simulator.",
    },
    {
        id: "icesat2", name: "ICESat-2", altitudeKm: 496,
        color: "#9cffe0",
        orbital: {
            noradId: 43613,
            inclinationDeg:    92.0,
            raanDeg:           120,
            argPerigeeDeg:      0,
            meanAnomalyDeg0:    35,
            eccentricity:       0.0003,
            periodMin:         94.5,
        },
        description: "NASA polar laser-altimeter measuring sea ice + ice-sheet elevation "
                   + "to 4 mm precision via the ATLAS photon-counting LIDAR.",
    },
    {
        id: "grace-fo", name: "GRACE-FO", altitudeKm: 490,
        color: "#f8c060",
        orbital: {
            noradId: 43476,
            inclinationDeg:    89.0,
            raanDeg:           220,
            argPerigeeDeg:      0,
            meanAnomalyDeg0:   310,
            eccentricity:       0.0021,
            periodMin:         94.4,
        },
        description: "GRACE Follow-On twin gravity-mapping pair. Inter-satellite laser "
                   + "ranging tracks Earth-mass redistribution — groundwater, ice, ocean.",
    },
    {
        id: "cryosat2", name: "CryoSat-2", altitudeKm: 717,
        color: "#a0e0ff",
        orbital: {
            noradId: 36508,
            inclinationDeg:    92.0,
            raanDeg:            70,
            argPerigeeDeg:      0,
            meanAnomalyDeg0:    50,
            eccentricity:       0.0010,
            periodMin:         99.2,
        },
        description: "ESA Ku-band SAR radar altimeter. Drift orbit — no fixed ground-track "
                   + "repeat — gives dense polar ice-thickness sampling.",
    },
    {
        id: "sentinel1a", name: "Sentinel-1A", altitudeKm: 693,
        color: "#c0a0ff",
        orbital: {
            noradId: 39634,
            inclinationDeg:    98.2,                // sun-synchronous
            raanDeg:           340,
            argPerigeeDeg:      0,
            meanAnomalyDeg0:   180,
            eccentricity:       0.0001,
            periodMin:         98.6,
        },
        description: "ESA Copernicus C-band SAR. Sun-synchronous dawn-dusk; "
                   + "InSAR deformation + maritime monitoring.",
    },
    {
        id: "noaa20", name: "NOAA-20 (JPSS-1)", altitudeKm: 824,
        color: "#ffe080",
        orbital: {
            noradId: 43013,
            inclinationDeg:    98.7,
            raanDeg:            10,
            argPerigeeDeg:      0,
            meanAnomalyDeg0:    90,
            eccentricity:       0.0001,
            periodMin:        101.4,
        },
        description: "Polar-orbiting NOAA weather sat. VIIRS imager + CrIS sounder feed "
                   + "operational forecasts and the JPSS data-assimilation chain.",
    },
    {
        id: "sentinel6", name: "Sentinel-6 MF", altitudeKm: 1336,
        color: "#ff9070",
        orbital: {
            noradId: 46984,
            inclinationDeg:    66.0,
            raanDeg:           150,
            argPerigeeDeg:      0,
            meanAnomalyDeg0:   270,
            eccentricity:       0.0008,
            periodMin:        112.4,
        },
        description: "Sentinel-6 Michael Freilich. Sea-level reference altimeter; "
                   + "successor to TOPEX/Jason — the operational sea-level record.",
    },
    {
        id: "geo-line", name: "Geostationary belt", altitudeKm: 2000,
        color: "#80a0c0",
        orbital: null,
        description: "Marker only — true GEO (35 786 km) is far outside the simulator's "
                   + "drag-belt. Shown so users know what's *above* the rendered band.",
    },
];

/**
 * Which layer does this altitude fall in? Returns null for < 0 km.
 */
export function layerAt(altitudeKm) {
    for (const L of ATMOSPHERIC_LAYERS) {
        if (altitudeKm >= L.minKm && altitudeKm < L.maxKm) return L;
    }
    return null;
}

// ── Composition anchors (number-density fractions) ──────────────────────────
// LEGACY altitude-only fractions — kept for fallback use only. The
// physical model below derives fractions from per-species diffusive
// equilibrium (Bates 1959 + barometric integration of each species'
// own scale height). These anchors are used only when the per-species
// path early-outs (e.g., during selfTest invariants).
const _ANCHORS = [
    { alt: 120,  frac: { N2: 0.78,   O2: 0.18,  NO: 5e-3, O: 0.03,  N: 0.01,  He: 1e-4,  H: 1e-6 } },
    { alt: 250,  frac: { N2: 0.55,   O2: 0.08,  NO: 1e-3, O: 0.36,  N: 4e-3,  He: 1e-3,  H: 1e-5 } },
    { alt: 400,  frac: { N2: 0.20,   O2: 0.02,  NO: 1e-4, O: 0.77,  N: 1e-3,  He: 8e-3,  H: 5e-5 } },
    { alt: 600,  frac: { N2: 0.05,   O2: 5e-3,  NO: 1e-5, O: 0.88,  N: 1e-4,  He: 6e-2,  H: 5e-4 } },
    { alt: 900,  frac: { N2: 5e-3,   O2: 5e-4,  NO: 1e-6, O: 0.55,  N: 1e-5,  He: 0.44,  H: 5e-3 } },
    { alt: 1500, frac: { N2: 1e-4,   O2: 1e-5,  NO: 1e-7, O: 0.12,  N: 1e-6,  He: 0.48,  H:  0.40 } },
    { alt: 2000, frac: { N2: 1e-5,   O2: 1e-6,  NO: 1e-8, O: 0.03,  N: 1e-7,  He: 0.27,  H:  0.70 } },
];

// ── Bates (1959) thermospheric temperature profile ──────────────────────────
//
// The thermosphere's vertical temperature structure is *not* an exponential
// fall-off — it's a monotonic rise from a near-mesopause base T₁₂₀ ≈ 380 K
// to the asymptotic exospheric temperature T∞ that's set by F10.7 and the
// geomagnetic state. The classic empirical fit (Bates 1959, MSIS, Jacchia):
//
//     T(z) = T∞ − (T∞ − T₁₂₀) · exp[ −σ · (z − 120) ]
//
// where σ ≈ 0.02 km⁻¹ controls how fast T relaxes toward T∞. At 200 km
// you're still inside the inversion (T ~ 800 K when T∞ = 1100 K); at
// 400+ km you're effectively at T∞.
//
// The closed-form integral that diffusion equilibrium needs:
//
//     ∫_120^z dz' / T(z')  =  (z − 120) / T∞   +  (1 / (σ T∞)) · ln[ T(z) / T₁₂₀ ]
//
// derived by partial fractions on 1/[T∞ − (T∞−T₁₂₀)·exp(−σ·u)].
// Used by `_speciesNumberDensity` to compute per-species barometric
// decay along the local Bates T(z) without numerical quadrature.
const BATES_T120_K = 380;          // base temperature at z₀ = 120 km (K)
const BATES_SIGMA  = 0.02;         // T-relaxation rate (km⁻¹)

/** Local kinetic temperature (K) at altitude under the Bates profile. */
export function batesTemperature(altKm, Tinf) {
    if (altKm <= 120) return BATES_T120_K;
    const dT = Tinf - BATES_T120_K;
    return Tinf - dT * Math.exp(-BATES_SIGMA * (altKm - 120));
}

/**
 * ∫_120^z dz' / T(z') under the Bates profile, in km/K. Used as the
 * temperature-weighted altitude integrand inside the per-species
 * barometric exponential below.
 */
function _batesInvTempIntegral(altKm, Tinf) {
    if (altKm <= 120) return 0;
    const T_z   = batesTemperature(altKm, Tinf);
    const linear = (altKm - 120) / Tinf;
    const corr   = (1 / (BATES_SIGMA * Tinf)) * Math.log(T_z / BATES_T120_K);
    return linear + corr;
}

// ── Per-species anchor concentrations at z₀ = 120 km ───────────────────────
// Climatological MSIS values (m⁻³) — units consistent with the rest of
// the engine. The total at 120 km is ~4×10¹⁷ m⁻³ which puts ρ_120 in
// the ~5×10⁻⁸ kg/m³ range, a hair above the engine's RHO_150 anchor
// (~2×10⁻⁹) by 30 km — exactly the homopause-to-thermosphere falloff.
//
// These don't change with solar activity at z₀ — the thermosphere
// expands above 120 km when T∞ rises, but the lower thermosphere is
// largely insensitive (turbopause mixing keeps fractions clamped there).
const N0_120 = Object.freeze({
    N2: 1.13e17,
    O2: 5.30e16,
    O:  7.60e16,
    N:  1.60e15,
    NO: 1.00e14,
    He: 4.00e13,
    H:  4.00e11,
});

// Thermal-diffusion coefficient α_i. Negligible (≈0) for heavy species;
// He has α ≈ −0.4, H has α ≈ −0.25 (Banks & Kockarts 1973). We absorb
// the (1+α) factor as a small correction on the (T₁₂₀/T)^(1+α) term.
const ALPHA_T = Object.freeze({
    N2: 0, O2: 0, O: 0, N: 0, NO: 0,
    He: -0.40,
    H:  -0.25,
});

/**
 * Number density of one species at altitude under diffusive equilibrium
 * along the Bates T(z) profile. Above the homopause (~105 km) each
 * species independently follows its own scale height H_i = kT/(m_i g):
 *
 *     n_i(z) = n_i(120) · [T(120)/T(z)]^(1+α_i)
 *                       · exp[ −(m_i · g_eff / k) · ∫_120^z dz'/T(z') ]
 *
 * where g_eff is the gravity at the midpoint of (120, z). The integral
 * has the closed form derived above.
 *
 * Returns 0 for altitudes below 120 km (the diffusive-equilibrium
 * regime starts at the homopause; below that, mixing keeps fractions
 * clamped — handled separately if ever needed).
 */
function _speciesNumberDensity(species, altKm, Tinf) {
    if (altKm < 120) return 0;
    const m_i  = SPECIES_MASS_KG[species];
    if (!Number.isFinite(m_i) || m_i <= 0) return 0;

    const T_z  = batesTemperature(altKm, Tinf);
    const Tratio = BATES_T120_K / T_z;
    const alpha  = ALPHA_T[species] ?? 0;
    const tFactor = Math.pow(Tratio, 1 + alpha);

    // Use a midpoint gravity — slow variation across (120, z), and this
    // saves us a numerical quadrature without a measurable accuracy hit
    // even at z = 2000 km (g changes only ~50 % across that span).
    const zMidKm = 0.5 * (120 + altKm);
    const g_eff  = gravity(zMidKm);

    const I_T = _batesInvTempIntegral(altKm, Tinf);   // km/K
    const argKm = (m_i * g_eff / KB) * I_T;           // dimensionless if I_T in m/K
    // I_T is km/K; convert to m/K by ×1000 inside the exponent:
    const arg = argKm * 1000;
    return N0_120[species] * tFactor * Math.exp(-arg);
}

// ── Public: derived quantities ──────────────────────────────────────────────

/**
 * Jacchia-ish exosphere temperature — intentionally matches
 * dsmc/pipeline/atmosphere.py:_exponential_fallback so the client and
 * server stay aligned during the fallback window.
 */
export function exosphereTempK(f107Sfu, ap) {
    const T = 900.0 + 2.0 * (f107Sfu - 150.0) + 3.0 * ap;
    return Math.max(T, 500.0);
}

/**
 * Local gravity at altitude (m/s²).
 */
export function gravity(altKm) {
    const r = R_EARTH_M / (R_EARTH_M + altKm * 1000);
    return G0 * r * r;
}

/**
 * Mass density (kg/m³) at altitude. Below 120 km we fall back to a short
 * barometric extrapolation anchored on the lumped 120-km column. Above
 * 120 km we sum the per-species contributions n_i × m_i directly — no
 * mean-scale-height fudging — so the density profile inherits the
 * correct heavy/light differential expansion when T∞ rises.
 */
function _massDensity(altKm, Tinf) {
    if (altKm <= 120) {
        // Stitch onto the per-species column at 120 km via a short
        // barometric exponential. Below the homopause turbulent mixing
        // dominates → use the column ρ at 120 km × the local Bates T(z)
        // ratio. This matches MSIS to ~factor of 2 across 80–120 km
        // which is plenty for the visualisation's purpose.
        let rho120 = 0;
        for (const s of SPECIES) rho120 += N0_120[s] * SPECIES_MASS_KG[s];
        return rho120 * Math.exp((120 - altKm) / 7.0);
    }
    let rho = 0;
    for (const s of SPECIES) {
        rho += _speciesNumberDensity(s, altKm, Tinf) * SPECIES_MASS_KG[s];
    }
    // Floor — keeps log10(ρ) finite for plotting code.
    return Math.max(rho, 1e-30);
}

/**
 * Total number density (m⁻³) under diffusive equilibrium.
 */
function _totalNumberDensity(altKm, Tinf) {
    if (altKm <= 120) {
        let n120 = 0;
        for (const s of SPECIES) n120 += N0_120[s];
        return n120 * Math.exp((120 - altKm) / 7.0);
    }
    let n = 0;
    for (const s of SPECIES) n += _speciesNumberDensity(s, altKm, Tinf);
    return Math.max(n, 1e0);
}

/**
 * Composition fractions at altitude — derived from the same per-species
 * diffusive-equilibrium calc as the density, so the storm response
 * (atomic O expanding more than N₂ when T∞ rises) is *physical*, not
 * decoration. Falls back to the legacy altitude-only anchors below
 * 120 km where the diffusive regime doesn't apply.
 */
function _fractionsAtT(altKm, Tinf) {
    if (altKm <= 120) return _fractionsAt(altKm);   // legacy mixing-region
    const out = {};
    let sum = 0;
    for (const s of SPECIES) {
        const n_i = _speciesNumberDensity(s, altKm, Tinf);
        out[s] = n_i;
        sum += n_i;
    }
    if (sum <= 0) return _fractionsAt(altKm);
    for (const s of SPECIES) out[s] /= sum;
    return out;
}

/**
 * Blend composition fractions across altitude anchors in log space.
 * Anchors below 120 km pin to 120, above 1500 km pin to 1500 — outside
 * that band MSIS itself is unreliable anyway.
 */
function _fractionsAt(altKm) {
    if (altKm <= _ANCHORS[0].alt) return { ..._ANCHORS[0].frac };
    if (altKm >= _ANCHORS[_ANCHORS.length - 1].alt) {
        return { ..._ANCHORS[_ANCHORS.length - 1].frac };
    }
    // Find the bracketing anchors.
    let i = 0;
    while (i + 1 < _ANCHORS.length && _ANCHORS[i + 1].alt < altKm) i++;
    const a = _ANCHORS[i];
    const b = _ANCHORS[i + 1];
    const t = (altKm - a.alt) / (b.alt - a.alt);

    // Log-space blend, then renormalise.
    const out = {};
    let sum = 0;
    for (const s of SPECIES) {
        const la = Math.log(Math.max(a.frac[s], 1e-20));
        const lb = Math.log(Math.max(b.frac[s], 1e-20));
        const v = Math.exp(la * (1 - t) + lb * t);
        out[s] = v;
        sum += v;
    }
    for (const s of SPECIES) out[s] /= sum;
    return out;
}

/**
 * Evaluate the surrogate at one altitude.
 * @returns {object} {altKm, T, rho, nTotal, H_km, mBar, fractions, n}
 *   where `fractions[species]` is the number-density fraction and
 *   `n[species]` is the species number density (m⁻³).
 */
export function density({ altitudeKm, f107Sfu, ap }) {
    if (altitudeKm < 80) {
        throw new Error("altitudeKm must be ≥ 80 (thermosphere lower bound)");
    }
    const Tinf = exosphereTempK(f107Sfu, ap);
    // Local kinetic temperature from the Bates (1959) inversion profile —
    // *not* T∞ everywhere. Below ~250 km T(z) is markedly cooler than T∞.
    const T_local = batesTemperature(altitudeKm, Tinf);

    const rho = _massDensity(altitudeKm, Tinf);
    const fractions = _fractionsAtT(altitudeKm, Tinf);

    // Mean molecular mass in kg (by number fraction).
    let mBar = 0;
    for (const s of SPECIES) mBar += fractions[s] * SPECIES_MASS_KG[s];

    // Total number density — direct sum (not ρ/m̄) so heavy/light
    // contributions remain self-consistent even with rounding.
    const nTotal = _totalNumberDensity(altitudeKm, Tinf);

    // Per-species number density (m⁻³).
    const n = {};
    for (const s of SPECIES) n[s] = fractions[s] * nTotal;

    // Scale height of the mean neutral (km), using local T.
    const g = gravity(altitudeKm);
    const H_km = mBar > 0 && T_local > 0 ? (KB * T_local / (mBar * g)) / 1000 : NaN;

    return {
        altitudeKm,
        // T is the *local kinetic* temperature — not T∞. Plots and
        // particle thermal speeds want this so vth varies through the
        // thermosphere instead of clamping to a single asymptotic value.
        T:    T_local,
        Tinf,                  // exosphere asymptote — useful for callers
        rho, nTotal, H_km, mBar, fractions, n,
    };
}

/**
 * Sample the surrogate on a dense altitude grid.
 *
 * @param {object} opts
 * @param {number} [opts.f107Sfu=120]
 * @param {number} [opts.ap=15]
 * @param {number} [opts.minKm=80]
 * @param {number} [opts.maxKm=2000]
 * @param {number} [opts.nPoints=200]
 * @returns {{ f107Sfu:number, ap:number, T:number, samples:Array }}
 */
export function sampleProfile({
    f107Sfu = 120,
    ap = 15,
    minKm = 80,
    maxKm = 2000,
    nPoints = 200,
} = {}) {
    const samples = [];
    for (let i = 0; i < nPoints; i++) {
        const altKm = minKm + (maxKm - minKm) * (i / (nPoints - 1));
        samples.push(density({ altitudeKm: altKm, f107Sfu, ap }));
    }
    return {
        f107Sfu,
        ap,
        T: exosphereTempK(f107Sfu, ap),
        samples,
    };
}

/**
 * Dominant species at a given altitude (by number density).
 */
export function dominantSpecies(altitudeKm) {
    const frac = _fractionsAt(altitudeKm);
    let best = SPECIES[0], bestVal = frac[best];
    for (const s of SPECIES) {
        if (frac[s] > bestVal) { best = s; bestVal = frac[s]; }
    }
    return best;
}

// ── Backend integration ─────────────────────────────────────────────────────
// The DSMC API lives at a configurable base URL. When the page is served
// from Vercel + the DSMC container is deployed elsewhere, set
// `window.PARKER_DSMC_API` before importing this module. Otherwise we
// stay entirely client-side (no network).

function _apiBase() {
    if (typeof window === "undefined") return null;
    // Precedence (highest to lowest):
    //   ?api=https://host  — URL-param override (CI / one-shot tests)
    //   window.PARKER_DSMC_API
    //   window.__PP_CONFIG.dsmcApi
    // Default: '' (same-origin) so the bundled Vercel Edge functions
    // under /v1/atmosphere/* answer without any explicit config.
    try {
        const qp = new URLSearchParams(window.location?.search || "");
        const fromQuery = qp.get("api");
        if (fromQuery) return fromQuery;
    } catch (_) { /* SSR / malformed URL — ignore */ }
    return window.PARKER_DSMC_API ?? window.__PP_CONFIG?.dsmcApi ?? "";
}

/**
 * Fetch a profile from the backend, falling back to the pure-JS
 * surrogate if the request fails, times out, or no base URL is set.
 * Returned shape matches sampleProfile() + extra metadata fields
 * (layers, satellites, model, issued_at_utc, etc.) when the backend
 * answered.
 */
export async function fetchProfile({
    f107Sfu, ap,
    minKm = 80, maxKm = 2000, nPoints = 160,
    lat = 0, lon = 0,
    timeoutMs = 2500,
    signal,
} = {}) {
    const base = _apiBase();
    // null = explicit opt-out (no API attempted); '' = same-origin
    // (the default — works against Vercel-hosted /api/atmosphere/*).
    if (base === null) return _clientProfile({ f107Sfu, ap, minKm, maxKm, nPoints });

    // Build the URL: same-origin if base is '', absolute otherwise.
    const path = '/v1/atmosphere/profile';
    const url  = base
        ? new URL(`${base.replace(/\/$/, "")}${path}`)
        : new URL(path, window.location.origin);
    if (f107Sfu != null) url.searchParams.set("f107", String(f107Sfu));
    if (ap != null)      url.searchParams.set("ap",   String(ap));
    url.searchParams.set("min_km",   String(minKm));
    url.searchParams.set("max_km",   String(maxKm));
    url.searchParams.set("n_points", String(nPoints));
    url.searchParams.set("lat",      String(lat));
    url.searchParams.set("lon",      String(lon));

    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    signal?.addEventListener("abort", () => ctl.abort());

    try {
        const r = await fetch(url, {
            signal: ctl.signal,
            headers: { "Accept": "application/json" },
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        return _normaliseBackendProfile(data);
    } catch (err) {
        // Network / parsing / timeout — surface but keep the page alive
        // by returning the client surrogate result.
        if (typeof console !== "undefined") {
            console.warn("[upper-atmosphere] backend profile unavailable, using client surrogate:", err?.message || err);
        }
        return _clientProfile({ f107Sfu, ap, minKm, maxKm, nPoints, fallback: true });
    } finally {
        clearTimeout(t);
    }
}

function _clientProfile({ f107Sfu, ap, minKm, maxKm, nPoints, fallback = false }) {
    const p = sampleProfile({ f107Sfu, ap, minKm, maxKm, nPoints });
    return {
        ...p,
        model: fallback ? "client-fallback" : "client",
        layers: ATMOSPHERIC_LAYERS,
        satellites: SATELLITE_REFERENCES,
    };
}

function _normaliseBackendProfile(data) {
    // Backend returns altitude_km / density_kg_m3 keys; we use
    // altitudeKm / rho on the client. Translate once here so callers
    // treat both sources uniformly.
    const samples = (data.samples || []).map(s => ({
        altitudeKm: s.altitude_km,
        T:          s.temperature_K,
        rho:        s.density_kg_m3,
        nTotal:     s.total_number_density,
        H_km:       s.scale_height_km ?? undefined,
        mBar:       s.mean_molecular_mass_kg,
        fractions:  s.fractions,
        n:          s.number_densities,
    }));
    return {
        f107Sfu:     data.f107_sfu ?? data.f107_used,
        ap:          data.ap ?? data.ap_used,
        T:           exosphereTempK(data.f107_sfu ?? 150, data.ap ?? 15),
        model:       data.model,
        issuedAt:    data.issued_at_utc,
        layers:      _normaliseLayers(data.layers) || ATMOSPHERIC_LAYERS,
        satellites:  _normaliseSatellites(data.satellites) || SATELLITE_REFERENCES,
        gravityWave: _normaliseGW(data.gravity_wave),
        samples,
    };
}

function _normaliseGW(gw) {
    // Backend uses snake_case for the GW block. Translate to the same
    // camelCase the JS engine emits so callers can treat both paths
    // uniformly.
    if (!gw || typeof gw !== 'object') return null;
    return {
        state:       gw.state,
        rmsPct:      gw.rms_pct,
        peakAltKm:   gw.peak_alt_km,
        peakPct:     gw.peak_pct,
        fitScaleHkm: gw.fit_scale_h_km,
        nPoints:     gw.n_points,
        residuals:   (gw.residuals || []).map(r => ({
            altitudeKm:  r.altitude_km,
            residualPct: r.residual_pct,
        })),
    };
}

function _normaliseLayers(list) {
    if (!Array.isArray(list) || list.length === 0) return null;
    return list.map(L => ({
        id: L.id, name: L.name,
        minKm: L.min_km, maxKm: L.max_km,
        color: ATMOSPHERIC_LAYERS.find(x => x.id === L.id)?.color || "#889",
        description: L.description,
    }));
}
function _normaliseSatellites(list) {
    if (!Array.isArray(list) || list.length === 0) return null;
    return list.map(S => ({
        id: S.id, name: S.name,
        altitudeKm: S.altitude_km,
        color: S.color || "#0cc",
    }));
}

// ── NOAA SWPC Kp↔Ap conversion table (SWPC canonical) ──────────────────────
const _KP_TO_AP = [0, 3, 7, 15, 27, 48, 80, 140, 240, 400];

/**
 * Fractional-Kp → Ap. Outside the [0, 9] band we clamp to the table
 * endpoints; NaN / bogus input → quiet-time default 15.
 */
export function kpToAp(kp) {
    if (!Number.isFinite(kp) || kp < 0) return 15;
    const lo = Math.floor(Math.min(kp, 9));
    const hi = Math.min(lo + 1, 9);
    const t = Math.max(0, Math.min(1, kp - lo));
    return _KP_TO_AP[lo] * (1 - t) + _KP_TO_AP[hi] * t;
}

/**
 * Estimate gravity-wave activity from a vertical profile by fitting a
 * smooth log-ρ exponential through the thermosphere (≥150 km) and
 * returning the RMS residual amplitude. Mirrors
 * dsmc/pipeline/profile.py:_gravity_wave_activity exactly so the
 * client surrogate and the SPARTA-backed backend agree on contract.
 *
 * The surrogate's profile follows the same Jacchia exponential as the
 * fit, so on the client this returns near-zero RMS (state="quiet").
 * Once a SPARTA-refined profile arrives via fetchProfile(), real
 * residuals show up because SPARTA captures collisional dynamics that
 * the empirical model smears over.
 *
 * @param {Array} samples — output of sampleProfile().samples or
 *                          fetchProfile().samples (each has altitudeKm + rho)
 * @returns {{ state, rmsPct, peakAltKm, peakPct, fitScaleHkm, nPoints, residuals }}
 */
export function gravityWaveActivity(samples) {
    if (!samples || samples.length < 4) return _quietGW();

    const pts = samples
        .filter(s => s.altitudeKm >= 150 && s.rho > 0)
        .map(s => [s.altitudeKm, Math.log(s.rho)]);
    if (pts.length < 4) return _quietGW();

    // Linear LSQ fit: log ρ = a + b·z   (b < 0, H_eff = -1/b in km)
    const n = pts.length;
    let sx=0, sy=0, sxx=0, sxy=0;
    for (const [z, lr] of pts) {
        sx += z; sy += lr; sxx += z*z; sxy += z*lr;
    }
    const denom = n * sxx - sx * sx;
    if (denom === 0) return _quietGW();
    const b = (n * sxy - sx * sy) / denom;
    const a = (sy - b * sx) / n;
    const H_eff_km = b < 0 ? (-1 / b) : null;

    let sumsq = 0, peakPct = 0, peakAlt = null;
    const residuals = [];
    for (const [z, lr] of pts) {
        const fit_lr = a + b * z;
        const pct = (Math.exp(lr - fit_lr) - 1) * 100;
        residuals.push({ altitudeKm: Math.round(z * 10) / 10,
                         residualPct: Math.round(pct * 1000) / 1000 });
        sumsq += pct * pct;
        if (Math.abs(pct) > Math.abs(peakPct)) {
            peakPct = pct; peakAlt = z;
        }
    }
    const rmsPct = Math.sqrt(sumsq / n);

    let state;
    if (rmsPct < 0.5) state = 'quiet';
    else if (rmsPct < 2) state = 'active';
    else if (rmsPct < 6) state = 'strong';
    else state = 'extreme';

    return {
        state,
        rmsPct:      Math.round(rmsPct * 1000) / 1000,
        peakAltKm:   peakAlt != null ? Math.round(peakAlt * 10) / 10 : null,
        peakPct:     Math.round(peakPct * 1000) / 1000,
        fitScaleHkm: H_eff_km != null ? Math.round(H_eff_km * 10) / 10 : null,
        nPoints:     n,
        residuals,
    };
}

function _quietGW() {
    return {
        state: 'quiet', rmsPct: 0, peakAltKm: null, peakPct: 0,
        fitScaleHkm: null, nPoints: 0, residuals: [],
    };
}

/**
 * Fetch current NOAA indices (F10.7, Kp, Ap) for "Live NOAA" buttons.
 * Preference order:
 *   1. Parkers Physics DSMC backend — GET /v1/atmosphere/indices
 *      (already pre-ingested by the Belay supervisor; fastest, cached).
 *   2. NOAA SWPC direct JSON endpoints (CORS-enabled).
 *      f107_cm_flux.json  → { flux: SFU, ... }[]      — daily F10.7
 *      planetary_k_index_1m.json → [[time, kp], ...]  — 1-minute Kp
 *
 * Resolves to null on any failure — callers should handle gracefully.
 */
export async function fetchLiveIndices({ timeoutMs = 3500 } = {}) {
    const base = _apiBase();

    // Try backend first (faster + authoritative).
    if (base) {
        try {
            const r = await _timedFetch(
                `${base.replace(/\/$/, "")}/v1/atmosphere/indices`,
                timeoutMs,
            );
            if (r.ok) {
                const d = await r.json();
                const f107 = d?.f107_latest?.f107_obs_sfu
                          ?? d?.f107_latest?.f107_adj_sfu
                          ?? null;
                const ap   = d?.ap_latest?.ap ?? null;
                if (Number.isFinite(f107) && Number.isFinite(ap)) {
                    return { f107Sfu: f107, ap, source: "backend" };
                }
            }
        } catch (_) { /* fall through to NOAA direct */ }
    }

    // NOAA direct — two concurrent fetches.
    try {
        const [fluxRes, kpRes] = await Promise.all([
            _timedFetch("https://services.swpc.noaa.gov/json/f107_cm_flux.json", timeoutMs),
            _timedFetch("https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json", timeoutMs),
        ]);
        let f107 = null, kp = null;
        if (fluxRes.ok) {
            const arr = await fluxRes.json();
            const cur = Array.isArray(arr) ? arr[arr.length - 1] : null;
            const raw = cur?.flux ?? cur?.f107 ?? cur?.f107_flux ?? null;
            if (Number.isFinite(raw)) f107 = raw;
        }
        if (kpRes.ok) {
            const arr = await kpRes.json();
            // Format: [["time_tag","Kp","a_running","station_count"], [...]]
            if (Array.isArray(arr) && arr.length > 1) {
                const last = arr[arr.length - 1];
                const raw = parseFloat(last[1]);
                if (Number.isFinite(raw)) kp = raw;
            }
        }
        if (Number.isFinite(f107) && Number.isFinite(kp)) {
            return { f107Sfu: f107, ap: kpToAp(kp), kp, source: "noaa-direct" };
        }
    } catch (_) { /* fall through */ }

    return null;
}

function _timedFetch(url, timeoutMs) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    return fetch(url, { signal: ctl.signal, headers: { Accept: "application/json" } })
        .finally(() => clearTimeout(t));
}

/**
 * Compact point snapshot for embedding in other pages (space-weather
 * card, dashboard widgets). Returns {ρ, T, dominant} at 200/400/600 km
 * by default.
 */
export function getSnapshot({
    f107Sfu, ap,
    altitudesKm = [200, 400, 600],
} = {}) {
    const hits = altitudesKm.map(alt => {
        const rec = density({ altitudeKm: alt, f107Sfu, ap });
        const dom = dominantSpecies(alt);
        return {
            altitudeKm: alt,
            rho: rec.rho,
            T: rec.T,
            dominantSpecies: dom,
            dominantFraction: rec.fractions[dom],
        };
    });
    return {
        f107Sfu, ap,
        T: exosphereTempK(f107Sfu, ap),
        altitudes: hits,
    };
}

// ── Debris sampler ──────────────────────────────────────────────────────────
//
// Pulls a small random sample from CelesTrak's `debris` SPECIAL list,
// filtered to the LEO band that matches our asset altitudes (so the
// conjunction screener sees plausible threats rather than GEO debris
// 36 000 km out of plane).
//
// Sample size is intentionally tiny — operational risk modelling needs
// the full 30k-object catalog (see js/satellite-tracker.js); this
// function is for *visualization-grade* debris context only. ~50
// objects gives users a sense of the LEO density without burying the
// scene in dots or driving the screener into a 4-asset × 30k
// quadratic blow-up.
//
// CelesTrak is free, CORS-enabled, no auth. The /api/celestrak/tle
// Edge proxy parses TLEs server-side and returns mean-element JSON.
//
// Deterministic-by-default: the `seed` option (when provided) drives
// a tiny LCG so the same sample is reproducible across reloads —
// useful for screenshots / regression tests.
export async function fetchDebrisSample({
    count       = 50,
    altMinKm    = 350,
    altMaxKm    = 900,
    timeoutMs   = 8000,
    seed        = null,
} = {}) {
    // Try the composite group first; fall through to per-event groups if
    // the composite is empty or returns an upstream error. Per-event
    // groups are individually <2 MB and far more resilient than the
    // 4-way fan-out, so the user always sees *some* debris even when
    // CelesTrak rolls a group name or hits a rate limit.
    const SOURCES = [
        '/api/celestrak/tle?group=debris',
        '/api/celestrak/tle?group=cosmos-1408-debris',
        '/api/celestrak/tle?group=fengyun-1c-debris',
        '/api/celestrak/tle?group=iridium-33-debris',
        '/api/celestrak/tle?group=cosmos-2251-debris',
    ];

    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
        let all = [];
        let lastErr = null;
        for (const url of SOURCES) {
            try {
                const r = await fetch(url, {
                    signal: ctl.signal,
                    headers: { Accept: 'application/json' },
                });
                if (!r.ok) { lastErr = new Error(`HTTP ${r.status} (${url})`); continue; }
                const data = await r.json();
                const sats = data?.satellites || [];
                if (sats.length > 0) {
                    all = sats;
                    break;
                }
            } catch (e) {
                lastErr = e;
                // AbortError aborts the whole fallback chain — bail out.
                if (e?.name === 'AbortError') throw e;
            }
        }
        if (all.length === 0 && lastErr) throw lastErr;
        // Filter to LEO debris in our altitude band. Skip anything with
        // a NaN inclination / mean motion / element so downstream
        // propagation never hits NaNs.
        const inBand = all.filter(s =>
            Number.isFinite(s.perigee_km) && Number.isFinite(s.apogee_km) &&
            Number.isFinite(s.inclination) && Number.isFinite(s.mean_motion) &&
            s.perigee_km >= altMinKm && s.apogee_km <= altMaxKm
        );
        // Shuffle + take. Use a seeded RNG when `seed` is provided so
        // the same set of debris shows on each reload.
        const rand = seed != null ? _seededRand(seed) : Math.random;
        const pool = inBand.slice();
        for (let i = pool.length - 1; i > 0; i--) {
            const j = Math.floor(rand() * (i + 1));
            [pool[i], pool[j]] = [pool[j], pool[i]];
        }
        return pool.slice(0, count).map(s => ({
            id:        `debris-${s.norad_id}`,
            name:      s.name || `Debris ${s.norad_id}`,
            noradId:   s.norad_id,
            altitudeKm: Math.round((s.perigee_km + s.apogee_km) / 2),
            color:     '#ff6688',
            orbital:   {
                noradId:        s.norad_id,
                inclinationDeg: s.inclination,
                raanDeg:        s.raan,
                argPerigeeDeg:  s.arg_perigee,
                meanAnomalyDeg0: s.mean_anomaly,        // M at TLE epoch — globe converts to M_now
                eccentricity:   s.eccentricity,
                periodMin:      s.period_min,
                meanMotionRevPerDay: s.mean_motion,     // needed by globe for M_now propagation
                epoch:          s.epoch,
            },
        }));
    } finally {
        clearTimeout(t);
    }
}

/** Tiny 32-bit LCG for the seeded debris sample. Good enough for
 *  reproducibility — not cryptographically anything. */
function _seededRand(seed) {
    let s = (seed | 0) || 1;
    return () => {
        s = (Math.imul(s, 1664525) + 1013904223) | 0;
        return ((s >>> 0) % 1_000_003) / 1_000_003;
    };
}

// ── Storm presets ──────────────────────────────────────────────────────────
// Archive values for the three events we gate SPARTA validation against.
// "level" is a 0..1 visual cue for shell colouring; tune as the storm
// library grows.

export const stormPresets = [
    {
        id: "quiet",
        name: "Quiet Sun",
        date: "solar-min climatology",
        f107: 75,
        ap: 5,
        level: 0.05,
        summary: "Solar-minimum baseline. ρ@400 km ≈ a few ×10⁻¹² kg/m³.",
    },
    {
        id: "nominal",
        name: "Nominal",
        date: "solar-mean climatology",
        f107: 150,
        ap: 15,
        level: 0.3,
        summary: "Default quiet-time operating point.",
    },
    {
        id: "starlink-2022",
        name: "Starlink Feb 2022",
        date: "2022-02-03 insertion + G2 storm",
        f107: 113,
        ap: 31,
        level: 0.55,
        summary:
            "49 Starlink v1.0 satellites inserted at ~210 km; G2 storm "
            + "spiked ρ by ~50% and 40 of 49 reentered. Benchmark case "
            + "for the SPARTA drag pipeline.",
    },
    {
        id: "gannon-may-2024",
        name: "Gannon May 2024",
        date: "2024-05-10 G5",
        f107: 195,
        ap: 207,
        level: 0.85,
        summary:
            "Severe (G5) geomagnetic storm. Thermospheric ρ jumped ~2× "
            + "at 400 km; ISS and many LEO assets saw elevated drag for "
            + "multiple days.",
    },
    {
        id: "ar3842-oct-2024",
        name: "AR3842 Oct 2024",
        date: "2024-10-03 X9.0 flare",
        f107: 250,
        ap: 150,
        level: 1.0,
        summary:
            "Largest X-class flare of cycle 25 to that date. Companion "
            + "event to the SWMF AR3842 benchmark.",
    },
];

// ── Tiny self-test (run on import in dev-server context) ────────────────────

/**
 * Fast sanity-check the surrogate — returns an array of {pass, msg}.
 * Callable from devtools: `import('./js/upper-atmosphere-engine.js').then(m=>console.table(m.selfTest()))`.
 */
export function selfTest() {
    const checks = [];
    const push = (pass, msg) => checks.push({ pass, msg });

    // Quiet-sun ρ@400 km should be O(10⁻¹¹) kg/m³.
    const q = density({ altitudeKm: 400, f107Sfu: 75, ap: 5 });
    push(q.rho > 1e-13 && q.rho < 1e-10,
        `quiet ρ@400 km = ${q.rho.toExponential(2)} (expect 1e-13 … 1e-10)`);

    // Storm ρ should exceed quiet ρ at the same altitude.
    const s = density({ altitudeKm: 400, f107Sfu: 250, ap: 200 });
    push(s.rho > q.rho,
        `storm ρ > quiet ρ @ 400 km (${s.rho.toExponential(2)} vs ${q.rho.toExponential(2)})`);

    // He should be abundant (≥20%) by 900 km and dominant by 1500 km;
    // H should dominate > 1800 km. "Abundant" is a climatology-agnostic
    // threshold — quiet-Sun has He dominant at 900 km while solar-max
    // keeps O dominant, and the surrogate is a compromise.
    const f900  = _fractionsAt(900);
    const f1500 = _fractionsAt(1500);
    const f1800 = _fractionsAt(1800);
    push(f900.He >= 0.20,
        `He @ 900 km = ${f900.He.toFixed(2)} (expect ≥ 0.20)`);
    push(f1500.He >= 0.30,
        `He @ 1500 km = ${f1500.He.toFixed(2)} (expect ≥ 0.30)`);
    push(dominantSpecies(1800) === "H",
        `1800 km dominant = ${dominantSpecies(1800)} (expect H)`);

    // Fractions at any altitude must sum to 1.
    const frac = _fractionsAt(550);
    const sum = SPECIES.reduce((a, s) => a + frac[s], 0);
    push(Math.abs(sum - 1) < 1e-9,
        `fractions sum @ 550 km = ${sum} (expect 1)`);

    return checks;
}
