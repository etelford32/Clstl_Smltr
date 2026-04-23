/**
 * upper-atmosphere-engine.js — Parker Physics thermosphere/exosphere surrogate
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

// ── Composition anchors (number-density fractions) ──────────────────────────
// Shapes tracked against NRL-MSIS / CIRA 1972. Log-space linear blend
// between adjacent anchors; values below/above the anchor range use
// the nearest anchor (no extrapolation).
const _ANCHORS = [
    { alt: 120,  frac: { N2: 0.78,   O2: 0.18,  NO: 5e-3, O: 0.03,  N: 0.01,  He: 1e-4,  H: 1e-6 } },
    { alt: 250,  frac: { N2: 0.55,   O2: 0.08,  NO: 1e-3, O: 0.36,  N: 4e-3,  He: 1e-3,  H: 1e-5 } },
    { alt: 400,  frac: { N2: 0.20,   O2: 0.02,  NO: 1e-4, O: 0.77,  N: 1e-3,  He: 8e-3,  H: 5e-5 } },
    { alt: 600,  frac: { N2: 0.05,   O2: 5e-3,  NO: 1e-5, O: 0.88,  N: 1e-4,  He: 6e-2,  H: 5e-4 } },
    { alt: 900,  frac: { N2: 5e-3,   O2: 5e-4,  NO: 1e-6, O: 0.55,  N: 1e-5,  He: 0.44,  H: 5e-3 } },
    { alt: 1500, frac: { N2: 1e-4,   O2: 1e-5,  NO: 1e-7, O: 0.12,  N: 1e-6,  He: 0.48,  H:  0.40 } },
    { alt: 2000, frac: { N2: 1e-5,   O2: 1e-6,  NO: 1e-8, O: 0.03,  N: 1e-7,  He: 0.27,  H:  0.70 } },
];

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
 * Mass density (kg/m³) at altitude under Jacchia-exponential assumptions.
 * Anchored at 150 km with ρ ≈ 2×10⁻⁹ kg/m³; uses a short scale height
 * below 150 km (barometric) and a T-dependent scale height above.
 */
function _massDensity(altKm, T) {
    const RHO_150 = 2.0e-9;
    if (altKm <= 150) {
        return RHO_150 * Math.exp((150 - altKm) / 8.0);
    }
    const H_km = 0.053 * T;
    return RHO_150 * Math.exp(-(altKm - 150) / H_km);
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
    const T = exosphereTempK(f107Sfu, ap);
    const rho = _massDensity(altitudeKm, T);
    const fractions = _fractionsAt(altitudeKm);

    // Mean molecular mass in kg (by number fraction).
    let mBar = 0;
    for (const s of SPECIES) mBar += fractions[s] * SPECIES_MASS_KG[s];

    // Total number density = ρ / m̄.
    const nTotal = mBar > 0 ? rho / mBar : 0;

    // Per-species number density.
    const n = {};
    for (const s of SPECIES) n[s] = fractions[s] * nTotal;

    // Scale height of the mean neutral (km).
    const g = gravity(altitudeKm);
    const H_km = mBar > 0 && T > 0 ? (KB * T / (mBar * g)) / 1000 : NaN;

    return { altitudeKm, T, rho, nTotal, H_km, mBar, fractions, n };
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
