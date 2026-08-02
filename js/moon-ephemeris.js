/**
 * moon-ephemeris.js — where the Moon actually is, as a pure, testable kernel.
 * ═══════════════════════════════════════════════════════════════════════════
 * No DOM, no three.js, no fetch, no ambient time (every function takes an
 * explicit Date/ms). Gated by tests/moon-ephemeris.mjs. The page uses this
 * to orient the globe and light the terminator so the 3D Moon matches the
 * sky outside the visitor's window — and to compute the eclipse calendar.
 *
 * ── WHAT THIS IS, HONESTLY ───────────────────────────────────────────────
 * A truncated analytic theory after Meeus, "Astronomical Algorithms" (2nd
 * ed.) — NOT a numerical integration and NOT JPL ephemeris precision:
 *   • Moon position: the ~45 largest periodic terms of the ELP-2000/82
 *     abridgement (Meeus ch. 47). Good to ~0.01° in longitude/latitude and
 *     tens of km in distance — the test pins the book's own worked example
 *     (1992 April 12) to that tolerance.
 *   • Sun position: the low-precision solar theory (ch. 25), ~0.01°.
 *   • Libration: OPTICAL libration only (ch. 53). Physical libration is
 *     ±0.04° and is dropped — invisible at globe scale. The same machinery
 *     yields the sub-solar point (the terminator), with the Sun→Moon
 *     direction built vectorially from both positions.
 *   • Phases (ch. 49) and eclipses (ch. 54): mean syzygies with the full
 *     periodic corrections, then the γ/u classification. Timing ignores
 *     ΔT (~69 s in the 2020s) — minutes-level, calendar-grade, and the
 *     test pins dates AND types against the canonical catalog (2024 Apr 8
 *     total solar, 2025 Mar 14 total lunar, 2026 Aug 12 total solar…).
 *     Eclipse PATHS on Earth's surface are far beyond this theory — the
 *     page must say "check a local source", not pretend.
 *
 * Conventions: selenographic longitude east-positive (matches
 * moon-landmarks-data and latLonToXYZ). Sub-Earth point = optical libration
 * (l′, b′): positive l′ exposes the eastern limb (Mare Crisium side),
 * positive b′ the north polar region. All angles degrees, times Unix ms.
 */

// ── Helpers ──────────────────────────────────────────────────────────────────
const D2R = Math.PI / 180;
const JD_UNIX_EPOCH = 2440587.5;

function _msToT(ms) {                       // Julian centuries from J2000.0
    return (ms / 86400000 + JD_UNIX_EPOCH - 2451545.0) / 36525;
}
function _jdeToMs(jde) { return (jde - JD_UNIX_EPOCH) * 86400000; }
const _norm360 = (d) => ((d % 360) + 360) % 360;
const _norm180 = (d) => { const x = _norm360(d); return x > 180 ? x - 360 : x; };

// ── Moon position — Meeus ch. 47, truncated ELP-2000/82 ─────────────────────
// Rows: [D, M, M', F, Σl coef (1e-6 deg), Σr coef (1e-3 km)]
const _LR_TERMS = [
    [0, 0, 1, 0, 6288774, -20905355], [2, 0, -1, 0, 1274027, -3699111],
    [2, 0, 0, 0, 658314, -2955968], [0, 0, 2, 0, 213618, -569925],
    [0, 1, 0, 0, -185116, 48888], [0, 0, 0, 2, -114332, -3149],
    [2, 0, -2, 0, 58793, 246158], [2, -1, -1, 0, 57066, -152138],
    [2, 0, 1, 0, 53322, -170733], [2, -1, 0, 0, 45758, -204586],
    [0, 1, -1, 0, -40923, -129620], [1, 0, 0, 0, -34720, 108743],
    [0, 1, 1, 0, -30383, 104755], [2, 0, 0, -2, 15327, 10321],
    [0, 0, 1, 2, -12528, 0], [0, 0, 1, -2, 10980, 79661],
    [4, 0, -1, 0, 10675, -34782], [0, 0, 3, 0, 10034, -23210],
    [4, 0, -2, 0, 8548, -21636], [2, 1, -1, 0, -7888, 24208],
    [2, 1, 0, 0, -6766, 30824], [1, 0, -1, 0, -5163, -8379],
    [1, 1, 0, 0, 4987, -16675], [2, -1, 1, 0, 4036, -12831],
    [2, 0, 2, 0, 3994, -10445], [4, 0, 0, 0, 3861, -11650],
    [2, 0, -3, 0, 3665, 14403], [0, 1, -2, 0, -2689, -7003],
    [2, 0, -1, 2, -2602, 0], [2, -1, -2, 0, 2390, 10056],
    [1, 0, 1, 0, -2348, 6322], [2, -2, 0, 0, 2236, -9884],
    [0, 1, 2, 0, -2120, 5751], [0, 2, 0, 0, -2069, 0],
    [2, -2, -1, 0, 2048, -4950], [2, 0, 1, -2, -1773, 4130],
    [2, 0, 0, 2, -1595, 0], [4, -1, -1, 0, 1215, -3958],
    [0, 0, 2, 2, -1110, 0], [3, 0, -1, 0, -892, 3258],
    [2, 1, 1, 0, -810, 2616], [4, -1, -2, 0, 759, -1897],
    [0, 2, -1, 0, -713, -2117], [2, 2, -1, 0, -700, 2354],
    [2, 1, -2, 0, 691, 0], [2, -1, 0, -2, 596, 0],
    [4, 0, 1, 0, 549, -1423], [0, 0, 4, 0, 537, -1117],
];
// Rows: [D, M, M', F, Σb coef (1e-6 deg)]
const _B_TERMS = [
    [0, 0, 0, 1, 5128122], [0, 0, 1, 1, 280602], [0, 0, 1, -1, 277693],
    [2, 0, 0, -1, 173237], [2, 0, -1, 1, 55413], [2, 0, -1, -1, 46271],
    [2, 0, 0, 1, 32573], [0, 0, 2, 1, 17198], [2, 0, 1, -1, 9266],
    [0, 0, 2, -1, 8822], [2, -1, 0, -1, 8216], [2, 0, -2, -1, 4324],
    [2, 0, 1, 1, 4200], [2, 1, 0, -1, -3359], [2, -1, -1, 1, 2463],
    [2, -1, 0, 1, 2211], [2, -1, -1, -1, 2065], [0, 1, -1, -1, -1870],
    [4, 0, -1, -1, 1828], [0, 1, 0, 1, -1794], [0, 0, 0, 3, -1749],
    [0, 1, -1, 1, -1565], [1, 0, 0, 1, -1491], [0, 1, 1, 1, -1475],
    [0, 1, 1, -1, -1410], [0, 1, 0, -1, -1344], [1, 0, 0, -1, -1335],
    [0, 0, 3, 1, 1107], [4, 0, 0, -1, 1021], [4, 0, -1, 1, 833],
];

function _moonFundamentals(T) {
    return {
        Lp: _norm360(218.3164477 + 481267.88123421 * T - 0.0015786 * T * T + T * T * T / 538841),
        D: _norm360(297.8501921 + 445267.1114034 * T - 0.0018819 * T * T + T * T * T / 545868),
        M: _norm360(357.5291092 + 35999.0502909 * T - 0.0001536 * T * T),
        Mp: _norm360(134.9633964 + 477198.8675055 * T + 0.0087414 * T * T + T * T * T / 69699),
        F: _norm360(93.2720950 + 483202.0175233 * T - 0.0036539 * T * T - T * T * T / 3526000),
        Om: _norm360(125.0445479 - 1934.1362891 * T + 0.0020754 * T * T),
        E: 1 - 0.002516 * T - 0.0000074 * T * T,
    };
}

/** Geocentric ecliptic longitude/latitude (deg) + distance (km) of the Moon. */
export function moonEcliptic(ms) {
    const T = _msToT(ms);
    const { Lp, D, M, Mp, F, E } = _moonFundamentals(T);
    let sl = 0, sr = 0, sb = 0;
    for (const [d, m, mp, f, cl, cr] of _LR_TERMS) {
        const arg = (d * D + m * M + mp * Mp + f * F) * D2R;
        const e = m === 0 ? 1 : (Math.abs(m) === 1 ? E : E * E);
        sl += cl * e * Math.sin(arg);
        sr += cr * e * Math.cos(arg);
    }
    for (const [d, m, mp, f, cb] of _B_TERMS) {
        const arg = (d * D + m * M + mp * Mp + f * F) * D2R;
        const e = m === 0 ? 1 : (Math.abs(m) === 1 ? E : E * E);
        sb += cb * e * Math.sin(arg);
    }
    // Additive terms (Venus, Jupiter, flattening — Meeus 47)
    const A1 = _norm360(119.75 + 131.849 * T);
    const A2 = _norm360(53.09 + 479264.290 * T);
    const A3 = _norm360(313.45 + 481266.484 * T);
    sl += 3958 * Math.sin(A1 * D2R) + 1962 * Math.sin((Lp - F) * D2R) + 318 * Math.sin(A2 * D2R);
    sb += -2235 * Math.sin(Lp * D2R) + 382 * Math.sin(A3 * D2R)
        + 175 * Math.sin((A1 - F) * D2R) + 175 * Math.sin((A1 + F) * D2R)
        + 127 * Math.sin((Lp - Mp) * D2R) - 115 * Math.sin((Lp + Mp) * D2R);
    return {
        lonDeg: _norm360(Lp + sl / 1e6),
        latDeg: sb / 1e6,
        distKm: 385000.56 + sr / 1e3,
    };
}

// ── Sun position — Meeus ch. 25, low precision ──────────────────────────────
export const AU_KM = 149597870.7;

/** Geometric ecliptic longitude (deg) + distance (km) of the Sun. */
export function sunEcliptic(ms) {
    const T = _msToT(ms);
    const L0 = _norm360(280.46646 + 36000.76983 * T + 0.0003032 * T * T);
    const M = _norm360(357.52911 + 35999.05029 * T - 0.0001537 * T * T);
    const C = (1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(M * D2R)
        + (0.019993 - 0.000101 * T) * Math.sin(2 * M * D2R)
        + 0.000289 * Math.sin(3 * M * D2R);
    const e = 0.016708634 - 0.000042037 * T;
    const nu = (M + C) * D2R;
    const rAU = 1.000001018 * (1 - e * e) / (1 + e * Math.cos(nu));
    return { lonDeg: _norm360(L0 + C), distKm: rAU * AU_KM };
}

// ── Phase — Meeus ch. 48 ────────────────────────────────────────────────────
export const SYNODIC_MONTH_DAYS = 29.530588861;
export const MEAN_DISTANCE_KM = 384399;
export const R_MOON_KM_EPH = 1737.4;

/**
 * Name from illumination + direction, not from age thresholds — at 68% lit
 * and waxing the Moon IS a waxing gibbous regardless of the calendar.
 * Quarter/New/Full get a ±3% window around their exact geometry.
 */
function _phaseName(k, waxing) {
    if (k < 0.03) return 'New Moon';
    if (k > 0.97) return 'Full Moon';
    if (Math.abs(k - 0.5) < 0.03) return waxing ? 'First Quarter' : 'Last Quarter';
    if (k < 0.5) return waxing ? 'Waxing Crescent' : 'Waning Crescent';
    return waxing ? 'Waxing Gibbous' : 'Waning Gibbous';
}

/** Phase angle, illuminated fraction, age, and name — from real positions. */
export function moonPhase(ms) {
    const moon = moonEcliptic(ms);
    const sun = sunEcliptic(ms);
    // Geocentric elongation ψ and phase angle i (48.2, 48.3)
    const cosPsi = Math.cos(moon.latDeg * D2R) * Math.cos((moon.lonDeg - sun.lonDeg) * D2R);
    const psi = Math.acos(Math.min(1, Math.max(-1, cosPsi)));
    const i = Math.atan2(sun.distKm * Math.sin(psi), moon.distKm - sun.distKm * Math.cos(psi));
    const illuminatedFraction = (1 + Math.cos(i)) / 2;
    const elong = _norm360(moon.lonDeg - sun.lonDeg);   // Moon east of Sun
    const ageDays = elong / 360 * SYNODIC_MONTH_DAYS;
    const waxing = elong < 180;
    return {
        phaseAngleDeg: i / D2R,
        illuminatedFraction,
        ageDays,
        waxing,
        phaseName: _phaseName(illuminatedFraction, waxing),
    };
}

/** Earth–Moon distance in km. */
export function distanceKm(ms) { return moonEcliptic(ms).distKm; }

/** Apparent angular diameter of the Moon, arcminutes (mean ≈ 31.1′). */
export function apparentDiameterArcmin(ms) {
    return 2 * Math.asin(R_MOON_KM_EPH / distanceKm(ms)) / D2R * 60;
}

// ── Libration + sub-solar point — Meeus ch. 53 (optical only) ───────────────
const _INCLINATION_I = 1.54242;   // lunar equator vs ecliptic

/** Selenographic (lat, lon) of the surface point facing direction (λ, β). */
function _selenographic(lamDeg, betDeg, F, Om) {
    const W = (lamDeg - Om) * D2R;
    const b = betDeg * D2R, I = _INCLINATION_I * D2R;
    const A = Math.atan2(
        Math.sin(W) * Math.cos(b) * Math.cos(I) - Math.sin(b) * Math.sin(I),
        Math.cos(W) * Math.cos(b));
    const lp = _norm180(A / D2R - F);
    const bp = Math.asin(-Math.sin(W) * Math.cos(b) * Math.sin(I) - Math.sin(b) * Math.cos(I)) / D2R;
    return { latDeg: bp, lonDeg: lp };
}

/**
 * Sub-Earth point = the optical libration (l′, b′). This IS the wobble:
 * over a month the point wanders up to ~±8° in longitude (elliptical
 * orbit, constant spin) and ~±6.9° in latitude (the 6.7° axial tilt to
 * the orbit) — which is how we've mapped 59% of the surface from home.
 */
export function subEarthPoint(ms) {
    const T = _msToT(ms);
    const { F, Om } = _moonFundamentals(T);
    const m = moonEcliptic(ms);
    return _selenographic(m.lonDeg, m.latDeg, F, Om);
}

/**
 * Sub-solar point — where lunar noon is. Drives the terminator. The
 * Sun→Moon direction is built vectorially from both ephemerides, then run
 * through the same selenographic machinery as the sub-Earth point.
 */
export function subSolarPoint(ms) {
    const T = _msToT(ms);
    const { F, Om } = _moonFundamentals(T);
    const m = moonEcliptic(ms);
    const s = sunEcliptic(ms);
    // Ecliptic rectangular: Sun→Moon = moonVec − sunVec (geocentric frame)
    const mb = m.latDeg * D2R, ml = m.lonDeg * D2R, sl = s.lonDeg * D2R;
    const x = m.distKm * Math.cos(mb) * Math.cos(ml) - s.distKm * Math.cos(sl);
    const y = m.distKm * Math.cos(mb) * Math.sin(ml) - s.distKm * Math.sin(sl);
    const z = m.distKm * Math.sin(mb);
    const lam = Math.atan2(y, x) / D2R;
    const bet = Math.atan2(z, Math.hypot(x, y)) / D2R;
    return _selenographic(lam, bet, F, Om);
}

// ── Orbit & precession — everything DERIVED from the theory's own rates ─────
// The five lunar months and both precession periods are not quoted numbers:
// they fall out of the linear rates in the fundamental arguments above
// (360° / rate). The tests pin them against the textbook values AND against
// the interior kernel's ANOMALISTIC_MONTH_DAYS — the moonquake tidal clock
// and this ephemeris must be the same clock.
const _DEG_PER_CY = {
    Lp: 481267.88123421,    // mean longitude        → sidereal month
    D: 445267.1114034,     // elongation            → synodic month
    Mp: 477198.8675055,     // mean anomaly          → anomalistic month
    F: 483202.0175233,     // argument of latitude  → draconic month
    Om: -1934.1362891,       // node                  → nodal precession
    sun: 36000.76983,        // solar mean longitude
    Pi: 4069.0137287,       // mean perigee          → apsidal precession
};
const _CY_DAYS = 36525;
const _period = (rateDegPerCy) => 360 / Math.abs(rateDegPerCy) * _CY_DAYS;

export const MONTHS = Object.freeze({
    synodicDays: _period(_DEG_PER_CY.D),                    // 29.5306 — the phase clock
    siderealDays: _period(_DEG_PER_CY.Lp),                   // 27.3217 — return to the stars
    anomalisticDays: _period(_DEG_PER_CY.Mp),                // 27.5546 — perigee-to-perigee
    draconicDays: _period(_DEG_PER_CY.F),                    // 27.2122 — node-to-node
});

export const PRECESSION = Object.freeze({
    /** The node regresses once around in 18.61 yr — standstills, eclipse seasons. */
    nodalPeriodYr: _period(_DEG_PER_CY.Om) / 365.25,
    /** The perigee advances once around in 8.85 yr — the supermoon clock. */
    apsidalPeriodYr: _period(_DEG_PER_CY.Pi) / 365.25,
    /** Sun returns to the same node every 346.62 d — the eclipse year. */
    eclipseYearDays: 360 / (_DEG_PER_CY.sun - _DEG_PER_CY.Om) * _CY_DAYS,
    /**
     * The Saros: 223 synodic ≈ 242 draconic ≈ 239 anomalistic months all
     * land within hours of 6585.3 d — same phase, same node distance,
     * same perigee distance — so each eclipse returns 18 yr 11 d later.
     */
    sarosSynodicDays: 223 * _period(_DEG_PER_CY.D),
    sarosDraconicDays: 242 * _period(_DEG_PER_CY.F),
    sarosAnomalisticDays: 239 * _period(_DEG_PER_CY.Mp),
});

/** Longitude of the ascending node Ω (deg) — regressing 19.34°/yr. */
export function nodeLongitudeDeg(ms) {
    return _moonFundamentals(_msToT(ms)).Om;
}

/** Longitude of the mean perigee Π (deg) — advancing 40.7°/yr. */
export function perigeeLongitudeDeg(ms) {
    const T = _msToT(ms);
    return _norm360(83.3532465 + 4069.0137287 * T - 0.0103200 * T * T - T * T * T / 80053);
}

/**
 * The Moon's maximum monthly declination (deg) — the STANDSTILL state.
 * The lunar orbit's tilt to the EQUATOR swings between ε−i (18.3°) and
 * ε+i (28.6°) as the node regresses: cos i_eq = cos i cos ε − sin i sin ε cos Ω.
 * Major standstill (Ω≈0): moonrise sweeps its widest range in 18.6 years.
 */
export const LUNAR_INCLINATION_DEG = 5.145;
export function maxMonthlyDeclinationDeg(ms) {
    const T = _msToT(ms);
    const eps = (23.4393 - 0.0130 * T) * D2R;
    const i = LUNAR_INCLINATION_DEG * D2R;
    const Om = _moonFundamentals(T).Om * D2R;
    return Math.acos(Math.cos(i) * Math.cos(eps) - Math.sin(i) * Math.sin(eps) * Math.cos(Om)) / D2R;
}

/** Next lunar standstill after ms: node at Ω=0 (major) or Ω=180 (minor). */
export function nextStandstill(ms) {
    const T = _msToT(ms);
    const Om = _moonFundamentals(T).Om;                       // deg, decreasing
    const rateDegPerMs = _DEG_PER_CY.Om / (_CY_DAYS * 86400000);
    const yearsTo = (target) => {
        let d = _norm360(Om - target);                        // Ω regresses toward target
        if (d < 1e-9) d = 360;
        return d / Math.abs(rateDegPerMs) / (365.25 * 86400000);
    };
    const toMajor = yearsTo(0), toMinor = yearsTo(180);
    return toMajor < toMinor
        ? { kind: 'major', ms: ms + toMajor * 365.25 * 86400000, maxDeclinationDeg: 23.44 + LUNAR_INCLINATION_DEG }
        : { kind: 'minor', ms: ms + toMinor * 365.25 * 86400000, maxDeclinationDeg: 23.44 - LUNAR_INCLINATION_DEG };
}

// ── Syzygies — Meeus ch. 49 ─────────────────────────────────────────────────
// k integer → new moon, k + 0.5 → full moon.
function _syzygyFundamentals(k) {
    const T = k / 1236.85;
    return {
        T,
        jdeMean: 2451550.09766 + 29.530588861 * k
            + 0.00015437 * T * T - 0.000000150 * T * T * T + 0.00000000073 * T ** 4,
        E: 1 - 0.002516 * T - 0.0000074 * T * T,
        M: _norm360(2.5534 + 29.10535670 * k - 0.0000014 * T * T),
        Mp: _norm360(201.5643 + 385.81693528 * k + 0.0107582 * T * T + 0.00001238 * T * T * T),
        F: _norm360(160.7108 + 390.67050284 * k - 0.0016118 * T * T - 0.00000227 * T * T * T),
        Om: _norm360(124.7746 - 1.56375588 * k + 0.0020672 * T * T),
    };
}

// ── Eclipses — Meeus ch. 54 ─────────────────────────────────────────────────
/**
 * Examine syzygy k for an eclipse. Returns null, or
 *   { kind: 'solar'|'lunar', type, tMs, gamma, u, magnitude,
 *     penumbralMagnitude? (lunar only), nodeDistanceDeg }
 * Types — solar: 'total'|'annular'|'hybrid'|'partial';
 *         lunar: 'total'|'partial'|'penumbral'.
 * γ is the classic geometry number: how far the shadow axis misses
 * (Earth radii for solar / Earth-shadow axis offset for lunar). The node
 * distance readout is |F mod 180 − 0| — the "how close to the node" that
 * decides everything.
 */
export function eclipseAtSyzygy(k) {
    const isSolar = Math.abs(k - Math.round(k)) < 0.25;
    const { T, jdeMean, E, M, Mp, F, Om } = _syzygyFundamentals(k);
    const absF = Math.abs(_norm180(F));
    const nodeDist = absF > 90 ? 180 - absF : absF;
    if (Math.abs(Math.sin(F * D2R)) > 0.36) return null;   // too far from the node

    const F1 = F - 0.02665 * Math.sin(Om * D2R);
    const A1 = _norm360(299.77 + 0.107408 * k - 0.009173 * T * T);
    const s = (d) => Math.sin(d * D2R), c = (d) => Math.cos(d * D2R);

    // Time of greatest eclipse
    let dJde = (isSolar ? -0.4075 * s(Mp) + 0.1721 * E * s(M)
                        : -0.4065 * s(Mp) + 0.1727 * E * s(M));
    dJde += 0.0161 * s(2 * Mp) - 0.0097 * s(2 * F1) + 0.0073 * E * s(Mp - M)
        - 0.0050 * E * s(Mp + M) - 0.0023 * s(Mp - 2 * F1) + 0.0021 * E * s(2 * M)
        + 0.0012 * s(Mp + 2 * F1) + 0.0006 * E * s(2 * Mp + M) - 0.0004 * s(3 * Mp)
        - 0.0003 * E * s(M + 2 * F1) + 0.0003 * s(A1) - 0.0002 * E * s(M - 2 * F1)
        - 0.0002 * E * s(2 * Mp - M) - 0.0002 * s(Om);

    const P = 0.2070 * E * s(M) + 0.0024 * E * s(2 * M) - 0.0392 * s(Mp)
        + 0.0116 * s(2 * Mp) - 0.0073 * E * s(Mp + M) + 0.0067 * E * s(Mp - M)
        + 0.0118 * s(2 * F1);
    const Q = 5.2207 - 0.0048 * E * c(M) + 0.0020 * E * c(2 * M) - 0.3299 * c(Mp)
        - 0.0060 * E * c(Mp + M) + 0.0041 * E * c(Mp - M);
    const W = Math.abs(c(F1));
    const gamma = (P * c(F1) + Q * s(F1)) * (1 - 0.0048 * W);
    const u = 0.0059 + 0.0046 * E * c(M) - 0.0182 * c(Mp)
        + 0.0004 * c(2 * Mp) - 0.0005 * c(M + Mp);
    const g = Math.abs(gamma);

    const base = {
        kind: isSolar ? 'solar' : 'lunar',
        tMs: _jdeToMs(jdeMean + dJde),
        gamma, u, nodeDistanceDeg: nodeDist,
    };

    if (isSolar) {
        if (g > 1.5433 + u) return null;
        if (g > 0.9972) {
            return { ...base, type: 'partial', magnitude: (1.5433 + u - g) / (0.5461 + 2 * u) };
        }
        let type;
        if (u < 0) type = 'total';
        else if (u > 0.0047) type = 'annular';
        else type = (u < 0.00464 * Math.sqrt(1 - gamma * gamma)) ? 'hybrid' : 'annular';
        return { ...base, type, magnitude: 1 };
    }

    // Lunar
    const magPen = (1.5573 + u - g) / 0.5450;
    const magUmb = (1.0128 - u - g) / 0.5450;
    if (magPen <= 0) return null;
    const type = magUmb >= 1 ? 'total' : magUmb > 0 ? 'partial' : 'penumbral';
    return { ...base, type, magnitude: magUmb, penumbralMagnitude: magPen };
}

/**
 * The next `count` eclipses at/after `fromMs`, in time order — solar and
 * lunar interleaved as they come. This IS the calendar: computed from the
 * node geometry, not a hard-coded list (the test pins it against the
 * canonical catalog anyway).
 */
export function upcomingEclipses(fromMs, count = 6) {
    const year = 2000 + (fromMs / 86400000 + JD_UNIX_EPOCH - 2451545.0) / 365.25;
    let k = Math.floor((year - 2000) * 12.3685) - 2;   // start safely before `fromMs`
    const out = [];
    let guard = 0;
    while (out.length < count && guard++ < 400) {
        for (const kk of [k, k + 0.5]) {
            const e = eclipseAtSyzygy(kk);
            if (e && e.tMs >= fromMs) out.push(e);
        }
        k += 1;
    }
    out.sort((a, b) => a.tMs - b.tMs);
    return out.slice(0, count);
}
