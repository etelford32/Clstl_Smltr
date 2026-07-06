// units.js — constants and conversions for the Storm Observatory
// (storm-observatory.html). SI at the physics layer; km/deg at the UI layer.
//
// Sibling of js/abell85/units.js — same role, different regime: here the
// system is Earth + thermosphere + LEO catalog, so the natural units are
// kilometres, seconds, kg/m³ and hours-of-storm-time.

export const MU_EARTH = 3.986004418e14;   // m³/s² — WGS-84 gravitational parameter
export const R_EARTH_KM = 6378.137;       // km — equatorial radius (WGS-84)
export const J2 = 1.08262668e-3;          // Earth oblateness harmonic
export const SEC_PER_HOUR = 3600;
export const OMEGA_EARTH = 7.2921159e-5;  // rad/s — Earth rotation (for ground tracks)

/** Mean motion (rad/s) for semi-major axis a in km. */
export function meanMotion(aKm) {
    const a = aKm * 1e3;
    return Math.sqrt(MU_EARTH / (a * a * a));
}

/** Orbital period in minutes for a in km. */
export function periodMin(aKm) {
    return (2 * Math.PI / meanMotion(aKm)) / 60;
}

/** J2 secular nodal regression rate (rad/s). a in km, i in rad. */
export function raanDot(aKm, e, incl) {
    const n = meanMotion(aKm);
    const p = aKm * (1 - e * e);
    const f = R_EARTH_KM / p;
    return -1.5 * n * J2 * f * f * Math.cos(incl);
}

/** J2 secular apsidal rate (rad/s). */
export function argpDot(aKm, e, incl) {
    const n = meanMotion(aKm);
    const p = aKm * (1 - e * e);
    const f = R_EARTH_KM / p;
    const c = Math.cos(incl);
    return 0.75 * n * J2 * f * f * (5 * c * c - 1);
}

/** Circular-orbit speed (m/s) at radius r_km. */
export function vCirc(rKm) {
    return Math.sqrt(MU_EARTH / (rKm * 1e3));
}

/** Speed at radius r on an orbit with semi-major axis a (vis-viva, m/s). */
export function visViva(rKm, aKm) {
    return Math.sqrt(MU_EARTH * (2 / (rKm * 1e3) - 1 / (aKm * 1e3)));
}

/** Solve Kepler's equation M = E − e·sinE (rad). Newton, 6 iterations. */
export function keplerE(M, e) {
    let E = e < 0.8 ? M : Math.PI;
    for (let k = 0; k < 6; k++) {
        E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    }
    return E;
}

// ── formatters ────────────────────────────────────────────────────────────────

export function fmtAlt(hKm) {
    return hKm >= 1000 ? (hKm / 1000).toFixed(2) + ' Mm' : hKm.toFixed(0) + ' km';
}

export function fmtRho(rho) {
    return Number.isFinite(rho) ? rho.toExponential(2) + ' kg/m³' : '—';
}

export function fmtHours(h) {
    const sign = h < 0 ? '−' : '+';
    const ah = Math.abs(h);
    if (ah < 48) return `${sign}${ah.toFixed(1)} h`;
    return `${sign}${(ah / 24).toFixed(1)} d`;
}
