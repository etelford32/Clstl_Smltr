/**
 * js/farside/carrington.js — Carrington-frame solar geometry helpers.
 *
 * The far-side seismic maps live in Carrington longitude (a frame that
 * co-rotates with the solar surface, so a fixed active region keeps a roughly
 * constant Carrington longitude). To turn a far-side detection into an
 * "emerges at the east limb in N days" forecast we need two things:
 *
 *   1. The synodic rotation rate (how fast the sub-Earth point sweeps across
 *      Carrington longitude as seen from Earth).
 *   2. L0 — the Carrington longitude of the central meridian (the sub-Earth
 *      point) at a given instant.
 *
 * L0 is computed with the low-precision algorithm from Meeus, "Astronomical
 * Algorithms" (ch. 29), good to ~0.1° — far better than the ~13°/day rotation
 * resolution we need. This module is intentionally dependency-free and pure so
 * the Sun and Space-Weather engines can reuse it later (see ../farside/index.js).
 */

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

/**
 * Synodic rotation rate of the sub-Earth point across Carrington longitude.
 * The Carrington (sidereal) period is 25.38 d; the synodic period seen from
 * Earth is ~27.2753 d → 360 / 27.2753 ≈ 13.199 °/day. L0 *decreases* with
 * time, so the central-meridian distance of a fixed feature *increases*.
 */
export const SYNODIC_DEG_PER_DAY = 13.199;
export const SYNODIC_PERIOD_DAYS = 360 / SYNODIC_DEG_PER_DAY; // ≈ 27.2753

/** Normalize an angle (deg) to (-180, 180]. */
export function wrap180(a) {
    let x = ((a + 180) % 360 + 360) % 360 - 180;
    if (x === -180) x = 180;
    return x;
}

/** Normalize an angle (deg) to [0, 360). */
export function wrap360(a) {
    return ((a % 360) + 360) % 360;
}

/** Calendar date → Julian Day (UT). Accepts a Date or ms epoch. */
export function toJulianDay(date) {
    const ms = date instanceof Date ? date.getTime() : Number(date);
    return ms / 86400000 + 2440587.5;
}

/**
 * Carrington longitude of the central meridian (sub-Earth point), in degrees.
 * Meeus ch. 29 low-precision method.
 *
 * @param {Date|number} date - instant (Date or ms epoch). Defaults to now.
 * @returns {{ L0: number, B0: number, jd: number }}
 *   L0 in [0,360), B0 (heliographic latitude of disc centre) in degrees.
 */
export function carringtonL0(date = new Date()) {
    const jd = toJulianDay(date);
    const D = jd - 2451545.0; // days since J2000.0

    // Sun's apparent ecliptic longitude (low precision).
    const g = (357.529 + 0.98560028 * D) * DEG;           // mean anomaly
    const Lsun = 280.459 + 0.98564736 * D;                // mean longitude
    const lambda = wrap360(
        Lsun + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)
    ) * DEG;                                              // apparent longitude

    // Inclination of solar equator and longitude of its ascending node.
    const I = 7.25 * DEG;
    const K = (73.6667 + 1.3958333 * (jd - 2396758.0) / 36525.0) * DEG;

    // Axial-rotation term (Carrington reference epoch 1853-11-09).
    const theta = (jd - 2398220.0) * (360.0 / 25.38);

    const dLK = lambda - K;
    // Heliographic latitude of disc centre.
    const B0 = Math.asin(Math.sin(dLK) * Math.sin(I)) * RAD;

    // eta: position of the central meridian in the rotation frame.
    let eta = Math.atan2(-Math.sin(dLK) * Math.cos(I), -Math.cos(dLK)) * RAD;

    const L0 = wrap360(eta - theta);
    return { L0, B0, jd };
}

/**
 * Days until a feature at fixed Carrington longitude `lonFeat` next crosses
 * the EAST limb into Earth-side view, given the central-meridian longitude
 * `L0` at the reference instant.
 *
 * Sign convention: central-meridian distance CMD = wrap180(lonFeat - L0).
 * The visible disc is CMD ∈ [-90, +90]; features appear at the east limb
 * (CMD = -90) and exit at the west limb (CMD = +90). Because L0 decreases at
 * the synodic rate, CMD *increases* over time, so the next east-limb crossing
 * is reached by advancing CMD up to -90 (mod 360).
 *
 * @returns {{ cmd:number, days:number, onDisc:boolean }}
 *   `days` is the lead time to emergence; ~0 means right at the limb.
 *   `onDisc` is true if the feature is already Earth-facing.
 */
export function emergenceETA(lonFeat, L0, rate = SYNODIC_DEG_PER_DAY) {
    const cmd = wrap180(lonFeat - L0);
    const onDisc = cmd >= -90 && cmd <= 90;
    // Forward angular distance for CMD to reach -90, in [0,360).
    let dCmd = ((-90 - cmd) % 360 + 360) % 360;
    // If essentially at the limb already, treat as 0 rather than a full lap.
    if (dCmd > 359.999) dCmd = 0;
    return { cmd, days: dCmd / rate, onDisc };
}

/**
 * The four cardinal Carrington longitudes for a given L0, used to draw the
 * flat-map and top-down "horizon" markers.
 */
export function limbLongitudes(L0) {
    return {
        centralMeridian: wrap360(L0),
        eastLimb:        wrap360(L0 - 90),   // features emerge here
        westLimb:        wrap360(L0 + 90),   // features exit here
        antiMeridian:    wrap360(L0 + 180),  // deep far-side centre
    };
}
