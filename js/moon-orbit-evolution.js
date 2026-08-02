/**
 * moon-orbit-evolution.js — the Moon's 4.5-billion-year orbital history,
 * as a pure, testable kernel.
 * ═══════════════════════════════════════════════════════════════════════════
 * No DOM, no three.js, no fetch, no ambient time. Gated by
 * tests/moon-orbit-evolution.mjs. The page's deep-time scrubber draws ONLY
 * numbers that come from here.
 *
 * ── WHAT THIS IS, HONESTLY ───────────────────────────────────────────────
 * Two ingredients, cleanly separated:
 *
 * 1. DISTANCE vs TIME — a monotone interpolation through the actual
 *    geological record, not a solved dissipation model. Tidal rhythmites
 *    and cyclostratigraphy give real paleo-distances:
 *      · today: 60.33 R_E, receding 3.83 cm/yr (lunar laser ranging)
 *      · 0.62 Ga: Elatina–Reynella rhythmites (Williams 2000)
 *      · 1.4  Ga: Xiamaling cyclostratigraphy (Meyers & Malinverno 2018)
 *      · 2.46 Ga: Joffre BIF Milankovitch record (Lantink et al. 2022)
 *    Between/beyond those, values are model-shaped (tidal torque ∝ a⁻⁶
 *    makes the first ~100 Myr furious) and each anchor is labeled
 *    'measured' | 'inferred' | 'model' so the UI can say which is which.
 *    A constant-Q backward integration is deliberately NOT used — it
 *    famously crashes the Moon into Earth at ~1.5 Ga (today's oceans
 *    dissipate anomalously hard); the rocks are the better authority.
 *    Future side: constant 3.83 cm/yr, disclosed as a ceiling (the rate
 *    falls as the ocean resonance detunes).
 *
 * 2. EVERYTHING ELSE IS DERIVED from that distance:
 *      · Day length from ANGULAR MOMENTUM CONSERVATION of the Earth–Moon
 *        pair (L_spin + L_orb = const, calibrated to today's 24 h at
 *        60.33 R_E; solar tidal leakage ~few % is ignored and disclosed).
 *        The test then checks the model against the SAME rhythmite papers'
 *        day lengths — 21.9 h at 0.62 Ga, 18.7 h at 1.4 Ga, 16.9 h at
 *        2.46 Ga — none of which were fed in. That agreement is the
 *        physics lesson of the whole panel.
 *      · Month length from Kepler: P ∝ a^{3/2}.
 *      · Days-per-year and days-per-month in LOCAL days (Elatina's famous
 *        ~400-day year falls out).
 *      · Apparent size ∝ 1/a, tidal amplitude ∝ 1/a³.
 *      · The end of total solar eclipses (~half a Gyr out, constant-rate
 *        estimate) and the Dwyer (2011) precession-dynamo window
 *        (a ≲ 48 R_E), cross-pinned to the interior kernel's epochs.
 *
 * Moon mass is IMPORTED from the interior kernel — one Moon, one mass.
 */

import { MOON_MASS_MEASURED_KG, R_MOON_KM } from './moon-interior-model.js';

// ── Constants ────────────────────────────────────────────────────────────────
export const EARTH_RADIUS_KM = 6371;
export const EARTH_MASS_KG = 5.972e24;
export const EARTH_MOMENT_OF_INERTIA = 0.3307 * EARTH_MASS_KG * (EARTH_RADIUS_KM * 1e3) ** 2;
export const G_NEWTON = 6.674e-11;
export const RECESSION_CM_PER_YR = 3.83;          // LLR, today (anomalously fast)
export const TODAY_DISTANCE_RE = 60.33;
export const TODAY_DAY_HOURS = 24.0;
export const SIDEREAL_MONTH_DAYS_TODAY = 27.3217;
export const YEAR_DAYS = 365.25;                  // absolute (24 h) days
/** Dwyer et al. 2011: mantle precession can stir the core dynamo out to ~48 R_E. */
export const PRECESSION_DYNAMO_MAX_RE = 48;

// ── The distance record ──────────────────────────────────────────────────────
export const DISTANCE_ANCHORS = Object.freeze([
    Object.freeze({ ageGa: 0.00, distRE: 60.33, kind: 'measured', label: 'Today — lunar laser ranging off the Apollo retroreflectors' }),
    Object.freeze({ ageGa: 0.62, distRE: 58.2, kind: 'measured', label: 'Elatina–Reynella tidal rhythmites, South Australia (Williams 2000)' }),
    Object.freeze({ ageGa: 1.40, distRE: 53.5, kind: 'measured', label: 'Xiamaling Formation cyclostratigraphy (Meyers & Malinverno 2018)' }),
    Object.freeze({ ageGa: 2.46, distRE: 50.5, kind: 'measured', label: 'Joffre banded-iron Milankovitch record (Lantink et al. 2022)' }),
    Object.freeze({ ageGa: 3.20, distRE: 47.0, kind: 'inferred', label: 'Moodies Group tidal bundles — a loose Archean constraint' }),
    Object.freeze({ ageGa: 4.00, distRE: 40.0, kind: 'model', label: 'Tidal-evolution models — recession slowing after the early sprint' }),
    Object.freeze({ ageGa: 4.45, distRE: 17.0, kind: 'model', label: 'The furious first ~50 Myr — torque ∝ 1/a⁶' }),
    Object.freeze({ ageGa: 4.50, distRE: 3.8, kind: 'model', label: 'Formation just outside the Roche limit, after the giant impact' }),
]);

// Monotone piecewise-cubic (Fritsch–Carlson) through the anchors, so the
// curve can't invent wiggles the data doesn't have.
const _xs = DISTANCE_ANCHORS.map(a => a.ageGa);
const _ys = DISTANCE_ANCHORS.map(a => a.distRE);
const _ms = (() => {
    const n = _xs.length;
    const d = [], m = new Array(n);
    for (let i = 0; i < n - 1; i++) d.push((_ys[i + 1] - _ys[i]) / (_xs[i + 1] - _xs[i]));
    m[0] = d[0]; m[n - 1] = d[n - 2];
    for (let i = 1; i < n - 1; i++) {
        m[i] = (d[i - 1] * d[i] <= 0) ? 0 : (d[i - 1] + d[i]) / 2;
    }
    for (let i = 0; i < n - 1; i++) {           // Fritsch–Carlson limiter
        if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
        const a = m[i] / d[i], b = m[i + 1] / d[i];
        const s = a * a + b * b;
        if (s > 9) {
            const t = 3 / Math.sqrt(s);
            m[i] = t * a * d[i]; m[i + 1] = t * b * d[i];
        }
    }
    return m;
})();

/**
 * Earth–Moon distance (Earth radii) at ageGa (Ga before present).
 * Negative age = future, constant-rate extrapolation (disclosed ceiling).
 */
export function distanceREAt(ageGa) {
    if (ageGa <= 0) {
        return TODAY_DISTANCE_RE
            + (-ageGa) * (RECESSION_CM_PER_YR * 1e-5 * 1e9) / EARTH_RADIUS_KM;   // cm/yr → km/Gyr
    }
    const a = Math.min(ageGa, _xs[_xs.length - 1]);
    let i = 0;
    while (i < _xs.length - 2 && a > _xs[i + 1]) i++;
    const h = _xs[i + 1] - _xs[i];
    const t = (a - _xs[i]) / h;
    const t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * _ys[i] + (t3 - 2 * t2 + t) * h * _ms[i]
        + (-2 * t3 + 3 * t2) * _ys[i + 1] + (t3 - t2) * h * _ms[i + 1];
}

export function distanceKmAt(ageGa) { return distanceREAt(ageGa) * EARTH_RADIUS_KM; }

// ── Derived: day length from angular-momentum conservation ───────────────────
const _MU = MOON_MASS_MEASURED_KG * EARTH_MASS_KG / (MOON_MASS_MEASURED_KG + EARTH_MASS_KG);
const _GM_TOT = G_NEWTON * (MOON_MASS_MEASURED_KG + EARTH_MASS_KG);
function _orbitalAngMomentum(distM) { return _MU * Math.sqrt(_GM_TOT * distM); }
// Calibrate the conserved total at today's 24 h (86400 s solar day ↔
// 86164 s sidereal spin) and 60.33 R_E.
const _OMEGA_TODAY = 2 * Math.PI / 86164;
const _L_TOTAL = EARTH_MOMENT_OF_INERTIA * _OMEGA_TODAY
    + _orbitalAngMomentum(TODAY_DISTANCE_RE * EARTH_RADIUS_KM * 1e3);

/**
 * Length of Earth's SOLAR day (hours) when the Moon was at
 * distanceREAt(ageGa). Pure L conservation gives the sidereal spin; the
 * solar day adds the orbit-around-the-Sun correction (1/P_solar =
 * 1/P_sidereal − 1/year), exactly as today's 23.934 h spin ↔ 24 h day.
 * The rhythmite day lengths come out on their own.
 */
const _SIDEREAL_YEAR_S = 365.25636 * 86400;
export function dayLengthHoursAt(ageGa) {
    const lSpin = _L_TOTAL - _orbitalAngMomentum(distanceREAt(ageGa) * EARTH_RADIUS_KM * 1e3);
    const omega = lSpin / EARTH_MOMENT_OF_INERTIA;
    const pSidereal = 2 * Math.PI / omega;
    return pSidereal / (1 - pSidereal / _SIDEREAL_YEAR_S) / 3600;
}

// ── Derived: months, local calendars, sky geometry, tides ────────────────────
/** Sidereal month (absolute 24 h days) — Kepler: P ∝ a^{3/2}. */
export function siderealMonthDaysAt(ageGa) {
    return SIDEREAL_MONTH_DAYS_TODAY * Math.pow(distanceREAt(ageGa) / TODAY_DISTANCE_RE, 1.5);
}

/** Synodic month (absolute days): 1/P_syn = 1/P_sid − 1/P_year. */
export function synodicMonthDaysAt(ageGa) {
    const p = siderealMonthDaysAt(ageGa);
    return p / (1 - p / YEAR_DAYS);
}

/** How many LOCAL (shorter) days fit in one year — Elatina's ~400. */
export function localDaysPerYearAt(ageGa) {
    return YEAR_DAYS * 24 / dayLengthHoursAt(ageGa);
}

/** How many LOCAL days from new moon to new moon. */
export function localDaysPerMonthAt(ageGa) {
    return synodicMonthDaysAt(ageGa) * 24 / dayLengthHoursAt(ageGa);
}

/** Moon's apparent size relative to today (∝ 1/a). */
export function apparentSizeFactorAt(ageGa) {
    return TODAY_DISTANCE_RE / distanceREAt(ageGa);
}

/** Lunar tidal amplitude relative to today (∝ 1/a³). */
export function tideFactorAt(ageGa) {
    return Math.pow(TODAY_DISTANCE_RE / distanceREAt(ageGa), 3);
}

/** Nearest anchor to ageGa — lets the UI say what the number rests on. */
export function evidenceAt(ageGa) {
    if (ageGa <= 0) {
        return { ...DISTANCE_ANCHORS[0], withinGa: -ageGa, extrapolated: true };
    }
    let best = DISTANCE_ANCHORS[0];
    for (const a of DISTANCE_ANCHORS) {
        if (Math.abs(a.ageGa - ageGa) < Math.abs(best.ageGa - ageGa)) best = a;
    }
    return { ...best, withinGa: Math.abs(best.ageGa - ageGa), extrapolated: false };
}

/**
 * When do TOTAL solar eclipses end? The Moon's perigee disc must still
 * cover the Sun's aphelion disc. Constant-rate future estimate, disclosed
 * — ocean dissipation will actually stretch this out.
 */
export const SUN_RADIUS_KM = 696000;
export const SUN_APHELION_KM = 1.521e8;
export const MEAN_ECCENTRICITY = 0.0549;
export function totalEclipseEndGyr() {
    // 2 R_moon / (a(1−e)) = 2 R_sun / d_aphelion  →  solve mean a
    const aEndKm = 2 * R_MOON_KM / (2 * SUN_RADIUS_KM / SUN_APHELION_KM) / (1 - MEAN_ECCENTRICITY);
    const deltaKm = aEndKm - TODAY_DISTANCE_RE * EARTH_RADIUS_KM;
    return deltaKm * 1e5 / RECESSION_CM_PER_YR / 1e9;   // km → cm → yr → Gyr
}

/**
 * When did the Moon recede past the Dwyer precession-dynamo limit
 * (~48 R_E)? Solved on the distance record; the interior kernel's epoch
 * table says the dynamo's high-field epoch had ended and the weak-field
 * decline was underway — the two kernels should agree, and the test
 * checks they do.
 */
export function precessionDynamoEndGa() {
    let lo = 0, hi = 4.5;
    for (let it = 0; it < 60; it++) {
        const mid = (lo + hi) / 2;
        if (distanceREAt(mid) > PRECESSION_DYNAMO_MAX_RE) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
}
