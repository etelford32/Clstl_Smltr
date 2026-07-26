/**
 * dipole.js — centred-dipole coordinates, the SM frame, and the dipole tilt.
 * ═══════════════════════════════════════════════════════════════════════════
 * Pure geometry. No DOM, no fetch, no ambient time — every entry point that
 * depends on the clock takes an explicit Date.
 *
 * ── "POLE" IS A DEFINITION, NOT AN OBJECT ─────────────────────────────────
 * Four incompatible definitions are in circulation and this module implements
 * exactly ONE of them:
 *
 *   • CENTRED DIPOLE (geomagnetic)  ← what this file computes, and what the
 *     cos-λ weighting inside Dst / SYM-H is built on. Antipodal by
 *     construction: the south pole is exactly opposite the north.
 *   • DIP pole — where the field is vertical. NOT antipodal; wanders
 *     independently; this is the "magnetic north pole" of the newspapers.
 *   • ECCENTRIC dipole — best-fit dipole allowed to sit off-centre.
 *   • INVARIANT latitude — real-field L-shell mapping. A different physical
 *     quantity entirely.
 *
 * Taking the wrong one of these cost 9.35° at Hermanus in the research that
 * preceded this port, and the error masqueraded as a model error for a while.
 * The signature was diagnostic: invariant minus dipole is +9.5° at Hermanus
 * and +4.5° at San Juan — both near the South Atlantic Anomaly where the field
 * is weak — but −4.1° at Chambon-la-Forêt over strong-field Europe. The sign
 * tracks the field-strength anomaly. If you ever see a latitude disagreement
 * with that pattern, you have the wrong column, not the wrong code.
 *
 * `tests/geomag-dipole.mjs` isolates the transform against analytic anchors
 * (pole → +90°, antipode → −90°, 90° away → 0°) so a future failure can be
 * attributed to the DATA rather than to the math within one test run.
 */

import { coeffsAt, dipole } from './igrf.js';

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

/** Earth rotation in the SM frame, degrees per minute. */
export const OMEGA_DEG_PER_MIN = 360 / 1440;

/**
 * Centred-dipole basis vectors in the Earth-fixed geographic frame.
 * ẑ points at the north geomagnetic pole; x̂ is the projection of the
 * geographic pole perpendicular to ẑ (so dipole longitude 0 is the meridian
 * containing the geographic pole).
 */
export function dipoleBasis(poleLatDeg, poleLonDeg) {
    const pla = poleLatDeg * DEG;
    const plo = poleLonDeg * DEG;
    const z = [Math.cos(pla) * Math.cos(plo), Math.cos(pla) * Math.sin(plo), Math.sin(pla)];
    const zg = [0, 0, 1];
    const dot = zg[0] * z[0] + zg[1] * z[1] + zg[2] * z[2];
    let x = [zg[0] - dot * z[0], zg[1] - dot * z[1], zg[2] - dot * z[2]];
    const nx = Math.hypot(x[0], x[1], x[2]);
    x = [x[0] / nx, x[1] / nx, x[2] / nx];
    const y = [
        z[1] * x[2] - z[2] * x[1],
        z[2] * x[0] - z[0] * x[2],
        z[0] * x[1] - z[1] * x[0],
    ];
    return { x, y, z };
}

/**
 * Geographic (lat, east lon) → centred-dipole (lat, lon), both degrees.
 * Pass a basis from dipoleBasis(), or a year to derive it from IGRF-14.
 */
export function toDipole(latDeg, lonDeg, basisOrYear = 2026.0) {
    const basis = typeof basisOrYear === 'number'
        ? dipoleBasisForYear(basisOrYear)
        : basisOrYear;
    const la = latDeg * DEG;
    const lo = lonDeg * DEG;
    const r = [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
    const dz = r[0] * basis.z[0] + r[1] * basis.z[1] + r[2] * basis.z[2];
    const dx = r[0] * basis.x[0] + r[1] * basis.x[1] + r[2] * basis.x[2];
    const dy = r[0] * basis.y[0] + r[1] * basis.y[1] + r[2] * basis.y[2];
    return {
        latDeg: Math.asin(Math.max(-1, Math.min(1, dz))) * RAD,
        lonDeg: Math.atan2(dy, dx) * RAD,
    };
}

const _basisCache = new Map();

/** Cached centred-dipole basis for a decimal year, from IGRF-14 degree 1. */
export function dipoleBasisForYear(year) {
    const key = Math.round(year * 100);
    let b = _basisCache.get(key);
    if (!b) {
        const d = dipole(coeffsAt(year));
        b = dipoleBasis(d.poleLatDeg, d.poleLonDeg);
        b.pole = d;
        _basisCache.set(key, b);
    }
    return b;
}

/**
 * Station longitude in the Sun-referenced (SM) frame at a given minute.
 *
 * TIGA's state lives in SM, not in Earth-fixed dipole longitude, and that is a
 * physics choice rather than a convenience: the partial ring current is
 * organised by magnetic LOCAL TIME. In an Earth-fixed frame the order-1
 * coefficients would rotate at one cycle per day, and the temporal prior would
 * spend all its effort fighting a rotation that is not physical.
 */
export function smLongitude(dipoleLonDeg, minute) {
    return ((dipoleLonDeg + OMEGA_DEG_PER_MIN * minute) % 360 + 360) % 360;
}

const J2000 = 2451545.0;

/**
 * Sub-solar point in geographic coordinates at a given instant.
 * Uses the same low-precision Almanac series as `dipoleTilt` (~0.01°).
 */
export function subsolarPointGeo(date) {
    const n = julianDate(date) - J2000;
    const s = sunGei(n);
    const th = gmstRad(n);
    // GEI → Earth-fixed is a rotation by −GMST about the spin axis.
    const x = s[0] * Math.cos(th) + s[1] * Math.sin(th);
    const y = -s[0] * Math.sin(th) + s[1] * Math.cos(th);
    const z = s[2];
    return {
        latDeg: Math.asin(Math.max(-1, Math.min(1, z))) * RAD,
        lonDeg: Math.atan2(y, x) * RAD,
    };
}

/**
 * A station's longitude in the Sun-referenced (SM) frame at a real instant.
 *
 * The convention matches `smLongitude` and the OSSE truth field: SM longitude
 * in DEGREES equals magnetic local time in HOURS × 15. So 0° is magnetic
 * midnight, 180° is magnetic noon, and 270° is DUSK — which is where a partial
 * ring current actually peaks, and where the OSSE puts it.
 *
 * @param {number} dipLonDeg station's centred-dipole longitude
 * @param {Date}   date
 */
export function smLongitudeAt(dipLonDeg, date) {
    const sun = subsolarPointGeo(date);
    const sunDip = toDipole(sun.latDeg, sun.lonDeg, dipoleBasisForYear(decimalYear(date)));
    return ((180 + dipLonDeg - sunDip.lonDeg) % 360 + 360) % 360;
}

/** Magnetic local time in hours, from an SM longitude in degrees. */
export function mltFromSmLongitude(smLonDeg) {
    return (((smLonDeg % 360) + 360) % 360) / 15;
}

/** Decimal year for IGRF interpolation. */
export function decimalYear(date) {
    const y = date.getUTCFullYear();
    const start = Date.UTC(y, 0, 1);
    const end = Date.UTC(y + 1, 0, 1);
    return y + (date.getTime() - start) / (end - start);
}

// ── Dipole tilt ──────────────────────────────────────────────────────────────


/** Julian Date from a UTC Date. */
export function julianDate(date) {
    return date.getTime() / 86400000 + 2440587.5;
}

/** Unit vector to the Sun in GEI. Low-precision Almanac series, ~0.01°. */
export function sunGei(daysSinceJ2000) {
    const n = daysSinceJ2000;
    const L = (((280.460 + 0.9856474 * n) % 360) + 360) % 360 * DEG;
    const g = (((357.528 + 0.9856003 * n) % 360) + 360) % 360 * DEG;
    const lam = L + 1.915 * DEG * Math.sin(g) + 0.020 * DEG * Math.sin(2 * g);
    const eps = (23.439 - 4e-7 * n) * DEG;
    return [Math.cos(lam), Math.cos(eps) * Math.sin(lam), Math.sin(eps) * Math.sin(lam)];
}

/** Greenwich Mean Sidereal Time, radians. */
export function gmstRad(daysSinceJ2000) {
    const h = ((18.697374558 + 24.06570982441908 * daysSinceJ2000) % 24 + 24) % 24;
    return h * 15 * DEG;
}

/**
 * Dipole tilt ψ — the angle between the dipole axis and the plane
 * perpendicular to the Earth–Sun line. Positive means the northern magnetic
 * pole is tipped TOWARD the Sun.
 *
 * This is the real mechanism behind "the Sun sets a daily rhythm in Earth's
 * magnetism", and the rhythm is geometric, not core-driven: the dipole sits
 * ~9.2° off the spin axis, so rotation swings the dipole–Sun angle through
 * about 18.4° every day — exactly twice that offset — with an annual envelope
 * of roughly ±33°. The phase locks to ~17 UT because the geomagnetic pole sits
 * near 73°W and that is local noon there.
 *
 * Nothing from the core gets through at a one-day period: see
 * core-model.js `mantleScreening`.
 */
export function dipoleTilt(date, year = null) {
    const n = julianDate(date) - J2000;
    const basis = dipoleBasisForYear(year ?? decimalYear(date));
    const th = gmstRad(n);
    const m = basis.z;
    // Earth-fixed → GEI is a rotation by GMST about the spin axis.
    const M = [
        m[0] * Math.cos(th) - m[1] * Math.sin(th),
        m[0] * Math.sin(th) + m[1] * Math.cos(th),
        m[2],
    ];
    const s = sunGei(n);
    return Math.asin(Math.max(-1, Math.min(1, M[0] * s[0] + M[1] * s[1] + M[2] * s[2]))) * RAD;
}

/**
 * Dipole tilt over one UT day at 15-minute steps.
 * @returns {{utHours:Float64Array, tiltDeg:Float64Array, minDeg:number,
 *            maxDeg:number, rangeDeg:number, utOfMax:number}}
 */
export function dipoleTiltDay(dateUtcMidnight, stepMinutes = 15) {
    const n = Math.round((24 * 60) / stepMinutes);
    const utHours = new Float64Array(n);
    const tiltDeg = new Float64Array(n);
    let minDeg = Infinity, maxDeg = -Infinity, utOfMax = 0;
    for (let i = 0; i < n; i++) {
        const t = new Date(dateUtcMidnight.getTime() + i * stepMinutes * 60000);
        const psi = dipoleTilt(t);
        utHours[i] = (i * stepMinutes) / 60;
        tiltDeg[i] = psi;
        if (psi < minDeg) minDeg = psi;
        if (psi > maxDeg) { maxDeg = psi; utOfMax = utHours[i]; }
    }
    return { utHours, tiltDeg, minDeg, maxDeg, rangeDeg: maxDeg - minDeg, utOfMax };
}
