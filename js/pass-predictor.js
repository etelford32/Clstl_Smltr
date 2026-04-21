/**
 * pass-predictor.js — Satellite overhead pass windows for a ground observer
 * ═══════════════════════════════════════════════════════════════════════════════
 * Given a TLE and a lat/lon observer, returns the next N passes where the
 * satellite rises above the observer's horizon. Piggy-backs on the same
 * SGP4 propagator the live tracker uses (Rust WASM when available, JS
 * Kepler fallback otherwise) so pass times agree with the dot on the globe.
 *
 * Exports:
 *   nextPasses(tle, obs, opts?)  → Array<Pass>
 *   lookAngle(teme, obs, gmstRad) → { elevationDeg, azimuthDeg, rangeKm }
 *
 *   obs = { lat, lon }          degrees, +N / +E. Altitude ignored (<0.1° err).
 *   opts = {
 *       from:           Date,    search start             (default: now)
 *       horizonH:       number,  search window in hours   (default: 24)
 *       stepMin:        number,  coarse scan step min     (default: 1)
 *       minPeakDeg:     number,  drop passes peaking <N° (default: 10)
 *       maxPasses:      number,  cap returned count       (default: 6)
 *   }
 *
 *   Pass = {
 *       rise: { time: Date, azDeg, elDeg, rangeKm },
 *       peak: { time: Date, azDeg, elDeg, rangeKm },
 *       set:  { time: Date, azDeg, elDeg, rangeKm },
 *       durationMin: number,
 *   }
 *
 * Algorithm:
 *   1. Scan (from .. from+horizonH) at stepMin intervals; record elevation.
 *   2. Every sign change on elevation brackets a rise or set; bisect to
 *      ~10 s resolution for crisp clock times.
 *   3. Between rise and set, take the sample with max elevation as the
 *      peak. (ISS passes are ≤10 min so a 1-min scan never misses one.)
 *
 * Not computed here:
 *   - Illumination / "visible naked eye" flag — requires Sun vector +
 *     Earth-shadow test. Easy add if the HUD wants it; skipped for now.
 *   - Doppler shift, range rate — add if a radio use case appears.
 */

import { geo, DEG, RAD } from './geo/coords.js';
import { propagate, tleEpochToJd } from './satellite-tracker.js';

const MIN_PER_DAY = 1440;
const R_EARTH_KM  = 6378.135;                      // WGS-72, matches SGP4
const JD_UNIX_0   = 2440587.5;                     // JD of 1970-01-01T00:00:00Z
const msToJd      = (ms) => ms / 86400000 + JD_UNIX_0;

// Scratch vectors reused across calls (modules are singletons; no aliasing
// across concurrent calls because JS is single-threaded).
const _teme = { x: 0, y: 0, z: 0 };

/**
 * Look angle (azimuth, elevation, range) from observer to a satellite
 * given its TEME position in km and the GMST (radians) at that instant.
 *
 * Frame: rotate TEME → astronomical ECEF (z=north), subtract observer
 * ECEF, rotate into local SEZ, then read off el/az.  Kept separate from
 * nextPasses() so tests and HUD code can call it directly.
 */
export function lookAngle(teme, obs, gmstRad) {
    // TEME → astronomical ECEF (z=north). Standard rotation: body-fixed
    // frame trails inertial by +GMST, so we undo it with −GMST about z.
    const c = Math.cos(gmstRad), s = Math.sin(gmstRad);
    const ex =  c * teme.x + s * teme.y;
    const ey = -s * teme.x + c * teme.y;
    const ez =  teme.z;

    const latR = obs.lat * DEG;
    const lonR = obs.lon * DEG;
    const cLat = Math.cos(latR), sLat = Math.sin(latR);
    const cLon = Math.cos(lonR), sLon = Math.sin(lonR);

    // Observer on a spherical Earth at 0 altitude. Geodetic vs geocentric
    // latitude matters only at the ~10 km level in range — negligible
    // for azimuth/elevation within a few tenths of a degree.
    const ox = R_EARTH_KM * cLat * cLon;
    const oy = R_EARTH_KM * cLat * sLon;
    const oz = R_EARTH_KM * sLat;

    // Range vector (sat − obs) in ECEF.
    const rx = ex - ox, ry = ey - oy, rz = ez - oz;

    // Local SEZ basis at observer, expressed in ECEF coords:
    //   south  S' = ( sin(lat)cos(lon),  sin(lat)sin(lon), -cos(lat) )
    //   east   E' = (−sin(lon),           cos(lon),          0       )
    //   zenith Z' = ( cos(lat)cos(lon),  cos(lat)sin(lon),  sin(lat) )
    const rS = rx *  sLat * cLon + ry *  sLat * sLon - rz * cLat;
    const rE = rx * -sLon        + ry *  cLon;
    const rZ = rx *  cLat * cLon + ry *  cLat * sLon + rz * sLat;

    const range = Math.sqrt(rx * rx + ry * ry + rz * rz);
    const elevationDeg = Math.asin(rZ / Math.max(range, 1e-9)) * RAD;

    // Azimuth from North, clockwise (0 = N, 90 = E, …):
    // atan2(east, −south) because +(−S') points north and East is our
    // +90° direction by convention.
    let azimuthDeg = Math.atan2(rE, -rS) * RAD;
    if (azimuthDeg < 0) azimuthDeg += 360;

    return { elevationDeg, azimuthDeg, rangeKm: range };
}

/**
 * Upcoming passes of a satellite over an observer.
 * Returns an empty array when the satellite is geostationary above the
 * observer's local horizon (never rises) or below it (never sets).
 */
export function nextPasses(tle, obs, opts = {}) {
    const from        = opts.from        ?? new Date();
    const horizonH    = opts.horizonH    ?? 24;
    const stepMin     = opts.stepMin     ?? 1;
    const minPeakDeg  = opts.minPeakDeg  ?? 10;
    const maxPasses   = opts.maxPasses   ?? 6;

    const epochJd = tleEpochToJd(tle);
    const startJd = msToJd(from.getTime());
    const totalSteps = Math.ceil(horizonH * 60 / stepMin);

    // Sample elevation at each coarse step.
    let prevEl = -Infinity;
    let prevJd = startJd;
    let pass   = null;
    const passes = [];

    for (let k = 0; k <= totalSteps; k++) {
        const jd  = startJd + (k * stepMin) / MIN_PER_DAY;
        const sample = _sampleEl(tle, epochJd, jd, obs);
        const el = sample.elevationDeg;

        // Rising edge — the last step was below horizon, this one is above.
        if (prevEl <= 0 && el > 0) {
            const riseJd = _bisectElevationZero(tle, epochJd, obs, prevJd, jd);
            pass = {
                rise: _sampleEl(tle, epochJd, riseJd, obs),
                peak: sample,            // initial peak guess; refined below
                set:  null,
            };
        }

        // Track peak while in-pass. Replace whenever we beat the current best.
        if (pass && el > pass.peak.elevationDeg) pass.peak = sample;

        // Setting edge — above last step, below now.
        if (pass && prevEl > 0 && el <= 0) {
            const setJd = _bisectElevationZero(tle, epochJd, obs, prevJd, jd);
            pass.set = _sampleEl(tle, epochJd, setJd, obs);
            if (pass.peak.elevationDeg >= minPeakDeg) {
                passes.push(_finalizePass(pass));
                if (passes.length >= maxPasses) return passes;
            }
            pass = null;
        }

        prevEl = el;
        prevJd = jd;
    }

    return passes;
}

// ── Internals ───────────────────────────────────────────────────────────────

function _sampleEl(tle, epochJd, jd, obs) {
    const gmstRad = geo.greenwichSiderealTimeFromJD(jd);
    const tsince  = (jd - epochJd) * MIN_PER_DAY;
    const t = propagate(tle, tsince);
    _teme.x = t.x; _teme.y = t.y; _teme.z = t.z;
    const la = lookAngle(_teme, obs, gmstRad);
    return {
        time:         new Date((jd - JD_UNIX_0) * 86400000),
        elevationDeg: la.elevationDeg,
        azimuthDeg:   la.azimuthDeg,
        rangeKm:      la.rangeKm,
    };
}

// Bisect between jdLo (el < 0) and jdHi (el > 0) to find the horizon crossing.
// ~10 s resolution = 10 iterations (covers most common scan step sizes).
function _bisectElevationZero(tle, epochJd, obs, jdLo, jdHi) {
    let lo = jdLo, hi = jdHi;
    for (let i = 0; i < 10; i++) {
        const mid = 0.5 * (lo + hi);
        const el  = _sampleEl(tle, epochJd, mid, obs).elevationDeg;
        if (el > 0) hi = mid;
        else        lo = mid;
    }
    return 0.5 * (lo + hi);
}

function _finalizePass(p) {
    return {
        rise: { time: p.rise.time, azDeg: p.rise.azimuthDeg, elDeg: p.rise.elevationDeg, rangeKm: p.rise.rangeKm },
        peak: { time: p.peak.time, azDeg: p.peak.azimuthDeg, elDeg: p.peak.elevationDeg, rangeKm: p.peak.rangeKm },
        set:  { time: p.set.time,  azDeg: p.set.azimuthDeg,  elDeg: p.set.elevationDeg,  rangeKm: p.set.rangeKm  },
        durationMin: (p.set.time - p.rise.time) / 60000,
    };
}
