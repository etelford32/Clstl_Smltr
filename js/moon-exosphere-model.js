/**
 * moon-exosphere-model.js — the Moon's "atmosphere" as a pure, testable kernel.
 * ═══════════════════════════════════════════════════════════════════════════
 * No DOM, no three.js, no fetch, no ambient time (every time-dependent
 * function takes an explicit Date/ms). Gated by tests/moon-exosphere-model.mjs.
 * The renderer (js/moon-exosphere.js) draws ONLY numbers that come from here.
 *
 * ── WHAT THIS IS, HONESTLY ───────────────────────────────────────────────
 * The Moon has no atmosphere in the collisional sense. It has a SURFACE
 * BOUNDARY EXOSPHERE: ~10⁵ atoms/cm³ at night, ~10⁴ by day — fourteen
 * orders of magnitude thinner than Earth's air, so rarefied that atoms hop
 * ballistically and essentially never collide with each other. Only its
 * total gas load — of order tonnes — makes "atmosphere" defensible at all,
 * and the page says so. This kernel is a species table + analytic exosphere
 * relations distilled from the measurement literature, NOT a Monte-Carlo
 * transport simulation.
 *
 * Species number densities follow the LACE/Apollo 17 measurements
 * (Hoffman et al. 1973) as reviewed by Stern (1999, Rev. Geophys. 37:453)
 * with LADEE NMS/UVS-era values (Benna et al. 2015; Colaprete et al. 2016)
 * — central estimates; individual measurements scatter. The qualitative
 * shapes are the physics the tests pin:
 *   • Non-condensable gases (He, Ne, H₂) concentrate on the cold NIGHT side
 *     (exospheric equilibrium n ∝ T^(-5/2), Hodges 1973).
 *   • Argon-40 — radiogenic ⁴⁰K decay vented from the interior — CONDENSES
 *     onto the freezing night surface and returns in a pre-dawn bulge
 *     (the classic LACE sunrise signature).
 *   • Na and K are trace but optically bright (resonance scattering) and
 *     DAY-side, made by photon-stimulated desorption + solar-wind
 *     sputtering + micrometeoroid impact vaporization.
 *
 * Scale heights and Jeans escape are DERIVED, not quoted: gravity comes
 * from the interior kernel's own integrated mass (moon-interior-model.js),
 * so the exosphere's puffiness and the escape hierarchy follow from the
 * same planet that adds up to the measured lunar mass. The identity
 * λ_Jeans = R/H is exact and test-pinned. Na/K get a suprathermal source
 * temperature (~1200 K, Yakshinskiy & Madey PSD measurements) — that is
 * WHY the sodium tail exists (λ ≈ 6: a real escaping fraction per hop).
 *
 * The live sodium "weather": source partitioning (PSD-dominant) follows the
 * modeling consensus (Wilson et al. 2006; Sarantos et al. 2010 class);
 * magnetotail passage shuts off solar-wind sputtering (observed Na response
 * — Potter et al. 2000); meteor showers boost impact vaporization (the
 * 1998 Leonid sodium-tail spike, Smith et al. 1999, and LADEE's Geminids
 * enhancement). Fractions are representative, and disclosed as such.
 */

import { R_MOON_KM, gravityMS2 } from './moon-interior-model.js';

// ── Physical constants ───────────────────────────────────────────────────────
export const K_BOLTZ = 1.380649e-23;   // J/K
export const AMU_KG = 1.66053907e-27; // kg

/** Surface gravity from the interior kernel's integrated mass (m/s²). */
export const SURFACE_G_MS2 = gravityMS2(R_MOON_KM);
/** Escape speed derived from the same gravity: v = √(2gR) ≈ 2.37 km/s. */
export const ESCAPE_V_MS = Math.sqrt(2 * SURFACE_G_MS2 * R_MOON_KM * 1e3);

// Representative surface temperatures for the thermalized population.
export const DAY_K = 390;    // subsolar-ish daytime regolith
export const NIGHT_K = 100;  // deep lunar night

// ── The species table ────────────────────────────────────────────────────────
// Number densities in cm⁻³ near the surface — central estimates from
// LACE/LADEE via the reviews cited in the header. `sunriseCm3` only for the
// condensable Ar (the pre-dawn release bulge). `suprathermalK` marks species
// whose dominant source ejects atoms far hotter than the regolith.
export const SPECIES = Object.freeze([
    Object.freeze({
        key: 'he', name: 'Helium-4', amu: 4.0026,
        dayCm3: 2e3, nightCm3: 4e4, condensable: false,
        source: 'Solar-wind α particles, thermally re-emitted',
    }),
    Object.freeze({
        key: 'ne', name: 'Neon-20', amu: 20.18,
        dayCm3: 4e3, nightCm3: 4e4, condensable: false,
        source: 'Solar wind (LACE upper limit; LADEE confirmed)',
    }),
    Object.freeze({
        key: 'h2', name: 'Hydrogen (H₂)', amu: 2.016,
        dayCm3: 1.2e3, nightCm3: 3.5e4, condensable: false,
        source: 'Solar-wind protons recombined in the regolith',
    }),
    Object.freeze({
        key: 'ar', name: 'Argon-40', amu: 39.96,
        dayCm3: 8e3, nightCm3: 2e3, sunriseCm3: 4e4, condensable: true,
        source: 'Radiogenic ⁴⁰K decay, vented from the interior',
    }),
    Object.freeze({
        key: 'na', name: 'Sodium', amu: 22.99,
        dayCm3: 70, nightCm3: 15, condensable: false, suprathermalK: 1200,
        source: 'Photon-stimulated desorption + sputtering + impact vapor',
    }),
    Object.freeze({
        key: 'k', name: 'Potassium', amu: 39.10,
        dayCm3: 17, nightCm3: 4, condensable: false, suprathermalK: 1200,
        source: 'Same desorption trio as Na (fainter)',
    }),
]);

// ── Exosphere relations (all derived from g) ─────────────────────────────────
/** Isothermal scale height H = kT/(mg), in km. */
export function scaleHeightKm(amu, tK) {
    return K_BOLTZ * tK / (amu * AMU_KG * SURFACE_G_MS2) / 1e3;
}

/** Jeans escape parameter λ = mgR/(kT) = v_esc²/v_th². Also exactly R/H. */
export function jeansLambda(amu, tK) {
    return amu * AMU_KG * SURFACE_G_MS2 * (R_MOON_KM * 1e3) / (K_BOLTZ * tK);
}

/**
 * Escape regime from λ. Thresholds are the conventional reading of the
 * Jeans formula at lunar values: λ ≲ 4 escapes on a timescale of days;
 * 4–15 leaks a real fraction per ballistic hop (this band is WHY the Na
 * and K tails exist); above ~15 thermal escape is negligible and the atom
 * is lost to photoionization instead.
 */
export function escapeRegime(lambda) {
    if (lambda < 4) return 'escapes in days';
    if (lambda <= 15) return 'partial escape — feeds the tail';
    return 'bound (lost by photoionization)';
}

/**
 * Convenience profile for one species: effective source temperature
 * (suprathermal where applicable, else the day surface), scale heights,
 * λ and regime. This is what the page's species table renders.
 */
export function speciesProfile(key) {
    const s = SPECIES.find(x => x.key === key);
    if (!s) return null;
    const tEff = s.suprathermalK ?? DAY_K;
    const lambda = jeansLambda(s.amu, tEff);
    return {
        ...s,
        tEffK: tEff,
        scaleHeightDayKm: scaleHeightKm(s.amu, tEff),
        scaleHeightNightKm: scaleHeightKm(s.amu, NIGHT_K),
        lambda,
        regime: escapeRegime(lambda),
    };
}

/**
 * Total gas mass aloft, integrated from the species table's own columns:
 * M = Σ 2πR²·m·(n_day·H_day + n_night·H_night). Order-of-magnitude honest
 * — it lands at a few tonnes, consistent with the "~10–25 t" figures
 * quoted for the whole lunar atmosphere. The famous comparison stands:
 * one Space Shuttle launch exhausted more gas than the Moon holds.
 */
export function totalMassKg() {
    const halfArea = 2 * Math.PI * (R_MOON_KM * 1e3) ** 2;
    let m = 0;
    for (const s of SPECIES) {
        const mass = s.amu * AMU_KG;
        const tDay = s.suprathermalK ?? DAY_K;
        m += halfArea * mass * (
            s.dayCm3 * 1e6 * scaleHeightKm(s.amu, tDay) * 1e3 +
            s.nightCm3 * 1e6 * scaleHeightKm(s.amu, NIGHT_K) * 1e3
        );
    }
    return m;
}

// ── The live sodium weather ──────────────────────────────────────────────────
/**
 * Quiet-time partition of the sodium source budget. PSD dominates in the
 * modeling consensus; sputtering and impact vaporization split the rest.
 * These are representative fractions (the literature spread is real) — the
 * tests pin that they sum to exactly 1 so the "×quiet" readout is honest.
 */
export const QUIET_SODIUM_FRACTIONS = Object.freeze({
    psd: 0.70,       // photon-stimulated desorption (solar UV)
    sputter: 0.15,   // solar-wind ion sputtering
    impact: 0.15,    // micrometeoroid impact vaporization
});

/** Residual ion flux inside the magnetotail vs free solar wind (~lobes). */
export const TAIL_SPUTTER_RESIDUAL = 0.1;

/**
 * Sodium source rates relative to quiet time.
 *   uvFactor     — solar UV/X-ray driver for PSD (1 = quiet)
 *   swFactor     — solar-wind flux driver for sputtering (1 = quiet)
 *   inTail       — magnetotail passage: sputtering drops to the lobe residual
 *   showerBoost  — impact-vaporization multiplier from impactVaporBoost()
 * Returns each channel plus the total, all in units of the quiet total.
 */
export function sodiumSources({ uvFactor = 1, swFactor = 1, inTail = false, showerBoost = 1 } = {}) {
    const F = QUIET_SODIUM_FRACTIONS;
    const psd = F.psd * uvFactor;
    const sputter = F.sputter * swFactor * (inTail ? TAIL_SPUTTER_RESIDUAL : 1);
    const impact = F.impact * showerBoost;
    return { psd, sputter, impact, total: psd + sputter + impact };
}

/**
 * Sodium loss side: photoionization lifetime at 1 AU, quiet Sun
 * (Huebner et al. 1992 rate ≈ 6×10⁻⁶ s⁻¹ → ~2 days). The tail is the
 * atoms that escape before this clock runs out.
 */
export const SODIUM_PHOTOION_LIFETIME_HR = 47;

// ── Magnetotail passage ──────────────────────────────────────────────────────
export const SYNODIC_MONTH_DAYS = 29.53058867;
export const FULL_MOON_AGE_DAYS = SYNODIC_MONTH_DAYS / 2;   // 14.765
/** Half-width of the tail crossing: ~4 days centred on full moon. */
export const TAIL_HALF_WIDTH_DAYS = 2.0;

/**
 * Is the Moon inside Earth's magnetotail at synodic phase age (days since
 * new moon)? True for ~4 days centred on full moon — the window when the
 * solar-wind sputtering source shuts off (and the surface sees plasma-sheet
 * electrons instead of solar-wind protons).
 */
export function inMagnetotail(phaseAgeDays) {
    const a = ((phaseAgeDays % SYNODIC_MONTH_DAYS) + SYNODIC_MONTH_DAYS) % SYNODIC_MONTH_DAYS;
    return Math.abs(a - FULL_MOON_AGE_DAYS) <= TAIL_HALF_WIDTH_DAYS;
}

// ── Meteor shower calendar → impact-vaporization boost ───────────────────────
// Peaks are the familiar annual dates; boosts are representative peak
// multipliers on the impact-vapor channel (the 1998 Leonid storm roughly
// tripled the Na tail; Geminids are the strongest reliable annual shower).
export const METEOR_SHOWERS = Object.freeze([
    Object.freeze({ name: 'Quadrantids', month: 1, day: 3, boost: 2.5, sigmaDays: 1.0 }),
    Object.freeze({ name: 'Lyrids', month: 4, day: 22, boost: 1.5, sigmaDays: 2.0 }),
    Object.freeze({ name: 'Eta Aquariids', month: 5, day: 6, boost: 2.0, sigmaDays: 4.0 }),
    Object.freeze({ name: 'Perseids', month: 8, day: 12, boost: 2.0, sigmaDays: 3.0 }),
    Object.freeze({ name: 'Orionids', month: 10, day: 21, boost: 1.5, sigmaDays: 4.0 }),
    Object.freeze({ name: 'Leonids', month: 11, day: 17, boost: 2.5, sigmaDays: 2.0 }),
    Object.freeze({ name: 'Geminids', month: 12, day: 14, boost: 3.0, sigmaDays: 3.0 }),
]);

const _DOY_REF_YEAR = 2001;   // any non-leap year; peaks treated as fixed DOY
function _showerDoy(s) {
    return (Date.UTC(_DOY_REF_YEAR, s.month - 1, s.day) - Date.UTC(_DOY_REF_YEAR, 0, 1)) / 86400000 + 1;
}
function _utcDoy(ms) {
    const d = new Date(ms);
    return (Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) -
        Date.UTC(d.getUTCFullYear(), 0, 1)) / 86400000 + 1;
}

/**
 * Impact-vaporization multiplier vs quiet for a given date (UTC): 1 at
 * quiet times, rising through each shower as a Gaussian in day-of-year
 * (year-wrapped). Feed the result to sodiumSources() as showerBoost.
 */
export function impactVaporBoost(dateOrMs) {
    const ms = typeof dateOrMs === 'number' ? dateOrMs : dateOrMs.getTime();
    const doy = _utcDoy(ms);
    let extra = 0;
    for (const s of METEOR_SHOWERS) {
        let d = Math.abs(doy - _showerDoy(s));
        if (d > 365.25 / 2) d = 365.25 - d;   // wrap the year
        extra += (s.boost - 1) * Math.exp(-(d * d) / (2 * s.sigmaDays * s.sigmaDays));
    }
    return 1 + extra;
}

/** Nearest shower and its current boost contribution, for the panel readout. */
export function activeShower(dateOrMs) {
    const ms = typeof dateOrMs === 'number' ? dateOrMs : dateOrMs.getTime();
    const doy = _utcDoy(ms);
    let best = null;
    for (const s of METEOR_SHOWERS) {
        let d = Math.abs(doy - _showerDoy(s));
        if (d > 365.25 / 2) d = 365.25 - d;
        const contrib = (s.boost - 1) * Math.exp(-(d * d) / (2 * s.sigmaDays * s.sigmaDays));
        if (!best || contrib > best.contrib) best = { name: s.name, daysAway: d, contrib };
    }
    return best;
}
