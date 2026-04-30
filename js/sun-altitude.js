/**
 * sun-altitude.js — Local solar position for a ground observer
 * ═══════════════════════════════════════════════════════════════════════════════
 * Small zero-network module. Given (date, lat, lon) it returns the sun's
 * altitude + azimuth from that vantage, plus sunrise / solar noon / sunset
 * for the UTC day.
 *
 * Exports:
 *   solarPosition(date, lat, lon)  → { altitudeDeg, azimuthDeg,
 *                                       declinationDeg, hourAngleDeg, jd }
 *   sunTimes(date, lat, lon)       → { sunrise, solarNoon, sunset,
 *                                       dayLengthH, polar }
 *   subSolarPoint(date)            → { lat, lon }  (degrees)
 *
 * Conventions:
 *   altitude  ∈ [-90°, +90°]    0° = horizon, +90° = zenith
 *   azimuth   ∈ [0°,   360°)   0° = north, 90° = east  (astronomical)
 *   hourAngle ∈ [-180°,+180°]  0° at meridian, + = past noon (west)
 *
 * Formulas follow NOAA's Solar Calculator (simplified Meeus Ch. 25) and are
 * accurate to ~1 arcminute for 1800–2200 — good enough for sunrise tables,
 * solar-noon pins, and sky-angle arrows. If you need sub-arcsecond
 * precision (e.g. astrophotography planning) use a VSOP87 module instead.
 *
 * The `julianDay` scheme is days-since-J2000.0 (matches earth.html inline
 * helpers) so the two code paths can be cross-checked against each other.
 */

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

const J2000_MS = Date.parse('2000-01-01T12:00:00Z');

function julianDay(date) {
    return (date.getTime() - J2000_MS) / 86400000;
}

function mod360(x) { return ((x % 360) + 360) % 360; }
function mod180(x) { return mod360(x + 180) - 180; }

// Mean obliquity of the ecliptic, Meeus 22.2 low-precision form (degrees).
function obliquityDeg(jd) {
    const T = jd / 36525;
    return 23.439291 - 0.0130042 * T;
}

// Geometric mean longitude L0, mean anomaly M, and apparent ecliptic
// longitude λ of the Sun, all in degrees. Apparent longitude folds in the
// equation of centre through third-order in eccentricity — enough for an
// observer at a glance.
function sunEcliptic(jd) {
    const L = mod360(280.46646 + 0.9856474 * jd);
    const M = mod360(357.52911 + 0.9856003 * jd);
    const Mr = M * DEG;
    const C = 1.914602 * Math.sin(Mr)
            + 0.019993 * Math.sin(2 * Mr)
            + 0.000289 * Math.sin(3 * Mr);
    return { L, M, lambda: L + C };
}

function solarDeclinationDeg(jd) {
    const { lambda } = sunEcliptic(jd);
    const eps = obliquityDeg(jd);
    return Math.asin(Math.sin(eps * DEG) * Math.sin(lambda * DEG)) * RAD;
}

function solarRightAscensionDeg(jd) {
    const { lambda } = sunEcliptic(jd);
    const eps = obliquityDeg(jd);
    const a = Math.atan2(
        Math.cos(eps * DEG) * Math.sin(lambda * DEG),
        Math.cos(lambda * DEG),
    ) * RAD;
    return mod360(a);
}

// Greenwich mean sidereal time (degrees). Same expression used in
// earth.html so terminator + sunrise tables stay internally consistent.
function gmstDeg(jd) {
    return mod360(280.46061837 + 360.98564736629 * jd);
}

// Equation of time in minutes (positive = sundial ahead of mean clock).
// EoT = 4·(L − α) reduced to [−180°, +180°] before scaling — avoids the
// 360°-wrap glitch that bites naive implementations twice a year.
function equationOfTimeMin(jd) {
    const { L } = sunEcliptic(jd);
    const alpha = solarRightAscensionDeg(jd);
    return 4 * mod180(L - alpha);
}

/**
 * Sun altitude + azimuth from an observer on the ground.
 *
 * @param {Date}   date — observation moment (wall clock time).
 * @param {number} lat  — observer latitude,  degrees +N.
 * @param {number} lon  — observer longitude, degrees +E.
 */
export function solarPosition(date, lat, lon) {
    const jd  = julianDay(date);
    const dec = solarDeclinationDeg(jd);
    const ra  = solarRightAscensionDeg(jd);
    const ha  = mod180(gmstDeg(jd) + lon - ra);   // local hour angle, deg

    const latR = lat * DEG, decR = dec * DEG, haR = ha * DEG;

    const sinAlt = Math.sin(latR) * Math.sin(decR)
                 + Math.cos(latR) * Math.cos(decR) * Math.cos(haR);
    const alt = Math.asin(Math.max(-1, Math.min(1, sinAlt))) * RAD;

    const altR = alt * DEG;
    const cosAzDen = Math.cos(altR) * Math.cos(latR);
    let az;
    if (Math.abs(cosAzDen) < 1e-9) {
        // Observer at a pole: azimuth is undefined geometrically; return 0.
        az = 0;
    } else {
        const cosAz = (Math.sin(decR) - Math.sin(altR) * Math.sin(latR)) / cosAzDen;
        az = Math.acos(Math.max(-1, Math.min(1, cosAz))) * RAD;
        if (Math.sin(haR) > 0) az = 360 - az;   // afternoon → west half
    }

    return {
        altitudeDeg:    alt,
        azimuthDeg:     az,
        declinationDeg: dec,
        hourAngleDeg:   ha,
        jd,
    };
}

/**
 * Sunrise, solar noon, and sunset for the UTC calendar day containing
 * `date`, as seen from (lat, lon). All times returned as Date objects.
 *
 *   polar = 'day'   — sun above horizon the entire UTC day
 *   polar = 'night' — sun never crosses horizon
 *   polar = null    — normal rise/set pair
 *
 * `solarNoon` is always populated — even during polar day/night it's the
 * transit time of the meridian, useful for placing the "highest sun" pip.
 */
export function sunTimes(date, lat, lon) {
    const dayStart = new Date(Date.UTC(
        date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(),
    ));
    // Anchor solar quantities at local solar noon of the day — keeps the
    // declination representative of the transit interval rather than the
    // instant the user happens to load the page.
    const jdMid = julianDay(dayStart) + 0.5;
    const eot   = equationOfTimeMin(jdMid);
    const dec   = solarDeclinationDeg(jdMid);

    // Solar noon in minutes past 00:00 UTC.
    const noonMin = 720 - 4 * lon - eot;
    const toDate  = (minUtc) => new Date(dayStart.getTime() + minUtc * 60000);
    const solarNoon = toDate(noonMin);

    const latR = lat * DEG, decR = dec * DEG;
    // Standard sunrise/sunset altitude: -0.833° (refraction + disc radius).
    const zenithR = 90.833 * DEG;
    const denom   = Math.cos(latR) * Math.cos(decR);
    const cosHA   = Math.abs(denom) < 1e-9
        ? 2  // polar singularity — fall through to the cosHA > 1 branch
        : (Math.cos(zenithR) - Math.sin(latR) * Math.sin(decR)) / denom;

    if (cosHA >  1) return { sunrise: null, solarNoon, sunset: null, dayLengthH: 0,  polar: 'night' };
    if (cosHA < -1) return { sunrise: null, solarNoon, sunset: null, dayLengthH: 24, polar: 'day'   };

    const haDeg = Math.acos(cosHA) * RAD;
    return {
        sunrise:    toDate(noonMin - 4 * haDeg),
        solarNoon,
        sunset:     toDate(noonMin + 4 * haDeg),
        dayLengthH: (8 * haDeg) / 60,
        polar:      null,
    };
}

/** Sub-solar surface point (degrees). */
export function subSolarPoint(date) {
    const jd  = julianDay(date);
    const dec = solarDeclinationDeg(jd);
    const ra  = solarRightAscensionDeg(jd);
    return { lat: dec, lon: mod180(ra - gmstDeg(jd)) };
}

/**
 * Sun direction unit vector in the astronomical inertial frame
 * (+x = vernal equinox, +z = geographic north pole). Safe to use with
 * SGP4 TEME positions — the mean-equinox drift is <0.02°/decade, well
 * below the precision we care about for shadow tests and look angles.
 * Returns a plain {x, y, z} literal so callers don't need to adopt any
 * particular vector class.
 */
export function sunDirectionEci(date) {
    const jd  = julianDay(date);
    const dec = solarDeclinationDeg(jd) * DEG;
    const ra  = solarRightAscensionDeg(jd) * DEG;
    const cd  = Math.cos(dec);
    return { x: cd * Math.cos(ra), y: cd * Math.sin(ra), z: Math.sin(dec) };
}

// Compass cardinal from an azimuth (N/NNE/NE/ENE/E/…) — handy for HUD.
const COMPASS_16 = ['N','NNE','NE','ENE','E','ESE','SE','SSE',
                    'S','SSW','SW','WSW','W','WNW','NW','NNW'];
export function compass16(azimuthDeg) {
    return COMPASS_16[Math.round(mod360(azimuthDeg) / 22.5) % 16];
}
