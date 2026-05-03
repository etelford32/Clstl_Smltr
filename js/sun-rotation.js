/**
 * sun-rotation.js — Carrington solar-rotation helpers
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * NOAA SWPC reports active-region positions in Carrington longitude — a
 * Sun-fixed coordinate that rotates with the surface (synodic period
 * 27.2753 d).  To make synthetic AR positions match what SDO sees right
 * *now*, we need to convert Carrington longitude → "apparent" heliographic
 * longitude (Earth-relative, central meridian at 0°) using the live
 * sub-Earth Carrington longitude L₀(t).
 *
 * ── Reference epoch ──────────────────────────────────────────────────────
 *   Carrington Rotation 1 began at JD 2 398 167.4 with L₀ = 360° (≡ 0°).
 *   L₀ *decreases* with time at the synodic rate (per the IAU convention,
 *   Carrington longitude is measured westward, so as the sun rotates
 *   eastward in the sky, L₀ — the Carrington longitude *currently
 *   pointing at Earth* — moves backward through the Carrington system).
 *
 *       L₀(JD) = − (JD − 2 398 167.4) · 360° / 27.2753   (mod 360°)
 *
 * ── Apparent longitude ──────────────────────────────────────────────────
 *   For an active region at fixed Carrington longitude φ_c, the
 *   apparent (Earth-frame) heliographic longitude — measured east-positive
 *   from the central meridian — is
 *
 *       φ_app = φ_c − L₀(t)         (wrap to (−180°, +180°])
 *
 *   When φ_app = 0 the AR sits on the central meridian (sub-Earth).
 *   Positive φ_app → east of central meridian (just-rotating-on-disk).
 *   Negative      → west (heading toward limb / off-disk).
 *
 * ── Scene-coordinate convention ──────────────────────────────────────────
 *   The space-weather globe places the sun at world (+55, 0, 0) and Earth
 *   at the origin.  A point on the photosphere at sun-local position
 *   (−1, 0, 0) is the sub-Earth point, and our setRegions code uses the
 *   convention
 *
 *       x = cos(lat) cos(lon)
 *       y = sin(lat)
 *       z = cos(lat) sin(lon)
 *
 *   so lon = π maps to the sub-Earth point.  Combining gives
 *
 *       scene_lon = π + (L₀ − φ_c)         in radians, wrapped to [0, 2π)
 *
 *   which `carringtonToSceneLon` returns directly.  Use this everywhere
 *   we render an AR or a coronal hole that's been published in Carrington
 *   coordinates so they track the live SDO image.
 */

const CARRINGTON_PERIOD_DAYS = 27.2753;
const J_CR1                  = 2398167.4;       // JD at the start of CR 1
const UNIX_TO_JD             = 2440587.5;       // JD at Unix epoch 0
const DEG2RAD                = Math.PI / 180;

/** Convert a JS Date (or default = now) to Julian Day. */
export function julianDay(date = new Date()) {
    return date.getTime() / 86400000 + UNIX_TO_JD;
}

/**
 * Sub-Earth Carrington longitude L₀(t) in degrees, normalised to [0, 360).
 *
 * This decreases by ≈13.2 °/day as the Sun rotates forward.
 *
 * @param {Date|number} [date=now]  Date object or ms-since-epoch
 * @returns {number}                degrees, [0, 360)
 */
export function subEarthCarringtonLongitude(date = new Date()) {
    const jd   = julianDay(date instanceof Date ? date : new Date(date));
    const days = jd - J_CR1;
    let L0 = -days * 360 / CARRINGTON_PERIOD_DAYS;
    L0 = ((L0 % 360) + 360) % 360;
    return L0;
}

/**
 * Convert a Carrington longitude → scene-coordinate longitude (radians).
 *
 * Result is in [0, 2π); π corresponds to the sub-Earth point on the sun
 * (matching the space-weather globe's photosphere convention).
 *
 * @param {number} lon_carrington_deg  Carrington longitude (degrees)
 * @param {Date|number} [date=now]
 * @returns {number} scene longitude in radians
 */
export function carringtonToSceneLon(lon_carrington_deg, date = new Date()) {
    const L0 = subEarthCarringtonLongitude(date);
    let scene_deg = 180 + (L0 - lon_carrington_deg);
    scene_deg = ((scene_deg % 360) + 360) % 360;
    return scene_deg * DEG2RAD;
}

/**
 * Apparent heliographic longitude (Earth-relative, central meridian = 0°,
 * east positive, west negative) — useful for non-scene usages like HUD
 * labels ("AR12345 at +14° east").
 *
 * @param {number} lon_carrington_deg
 * @param {Date|number} [date=now]
 * @returns {number} degrees in (−180, +180]
 */
export function carringtonToApparentLonDeg(lon_carrington_deg, date = new Date()) {
    const L0 = subEarthCarringtonLongitude(date);
    let app = lon_carrington_deg - L0;
    app = ((app + 540) % 360) - 180;
    return app;
}

/**
 * Carrington Rotation Number (CR#) for a given date.  Useful for matching
 * SDO synoptic-map filenames and hek time-window queries.
 */
export function carringtonRotationNumber(date = new Date()) {
    const jd = julianDay(date instanceof Date ? date : new Date(date));
    return 1 + (jd - J_CR1) / CARRINGTON_PERIOD_DAYS;
}
