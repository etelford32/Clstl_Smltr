/**
 * horizons.js — Real-time planetary ephemeris for the Celestial Simulator
 *
 * Provides precise positions for Earth and Moon at the current instant.
 *
 * PRIMARY   NASA JPL Horizons Web API (state vectors, ECLIPJ2000 frame)
 *           https://ssd.jpl.nasa.gov/horizons/manual.html
 *           Fetches Earth heliocentric position (CENTER='500@10', COMMAND='399')
 *           and Moon geocentric position (CENTER='500@399', COMMAND='301').
 *           Response units: AU for heliocentric, km for geocentric.
 *
 * FALLBACK  On-device Meeus algorithms (Astronomical Algorithms, 2nd ed.)
 *           Earth Ch.25 — accurate to ~0.01° for 1950–2050
 *           Moon  Ch.47 — accurate to ~1° (16-term longitude series)
 *           Always works offline; no network latency.
 *
 * OUTPUT (ephemeris-ready CustomEvent on window)
 * ─────────────────────────────────────────────────────────────────
 *  detail.earth     { lon_rad, dist_AU }   — heliocentric ecliptic
 *  detail.moon      { lon_rad, lat_rad, dist_km, dist_AU }   — geocentric
 *  detail.jd        number — Julian Day of fetch
 *  detail.source    'horizons' | 'meeus'
 *  detail.timestamp Date
 *
 * USAGE
 * ─────────────────────────────────────────────────────────────────
 *  import { EphemerisService, jdNow, earthHeliocentric, moonGeocentric }
 *      from './js/horizons.js';
 *
 *  const svc = new EphemerisService();
 *  svc.load();   // fires 'ephemeris-ready' on window when done
 *
 *  window.addEventListener('ephemeris-ready', ev => {
 *      const { earth, moon, source } = ev.detail;
 *      // earth.lon_rad  → current heliocentric ecliptic longitude (radians)
 *      // moon.lon_rad   → current geocentric ecliptic longitude (radians)
 *  });
 */

// ── Julian Day helpers ────────────────────────────────────────────────────────

/** Julian Day Number from current UTC instant. */
export function jdNow() {
    return Date.now() / 86400000 + 2440587.5;
}

/** Julian Day Number from a Date object. */
export function jdFromDate(d) {
    return d.getTime() / 86400000 + 2440587.5;
}

/** Calendar date from Julian Day Number (UTC). */
export function dateFromJD(jd) {
    return new Date((jd - 2440587.5) * 86400000);
}

// ── Meeus on-device algorithms ────────────────────────────────────────────────

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

/**
 * Earth's heliocentric ecliptic longitude (degrees, radians) and
 * distance from the Sun (AU).
 *
 * Source: Meeus, "Astronomical Algorithms" 2nd ed., Chapter 25.
 * Accuracy: ~0.01° for years 1950–2050.
 *
 * @param {number} jd  Julian Day Number (default: now)
 * @returns {{ lon: number, lon_rad: number, dist_AU: number }}
 */
export function earthHeliocentric(jd = jdNow()) {
    const T = (jd - 2451545.0) / 36525.0;  // Julian centuries since J2000.0

    // ── Mean longitude of the Sun (geometric, degrees) ────────────────────
    const L0 = 280.46646 + 36000.76983 * T + 0.0003032 * T * T;

    // ── Mean anomaly of the Sun (degrees → radians) ───────────────────────
    const M_deg = 357.52911 + 35999.05029 * T - 0.0001537 * T * T;
    const M     = M_deg * D2R;

    // ── Equation of center (degrees) ─────────────────────────────────────
    const C = (1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(M)
            + (0.019993 - 0.000101 * T)                     * Math.sin(2 * M)
            + 0.000289                                       * Math.sin(3 * M);

    // ── Sun's true longitude (degrees) ───────────────────────────────────
    const sunTrue = L0 + C;

    // ── Apparent longitude — nutation + aberration (degrees) ─────────────
    const omega  = (125.04 - 1934.136 * T) * D2R;
    const sunApp = sunTrue - 0.00569 - 0.00478 * Math.sin(omega);

    // ── Earth's heliocentric ecliptic longitude = sunApp + 180° ──────────
    const lon = ((sunApp + 180) % 360 + 360) % 360;

    // ── Earth–Sun distance (AU) ────────────────────────────────────────────
    // Orbit eccentricity
    const e = 0.016708634 - 0.000042037 * T - 0.0000001267 * T * T;
    // Semi-major axis × (1 − e²) / (1 + e·cos M)
    const dist_AU = (1.000001018 * (1 - e * e)) / (1 + e * Math.cos(M));

    return { lon, lon_rad: lon * D2R, dist_AU };
}

/**
 * Moon's geocentric ecliptic longitude, latitude, and distance.
 *
 * Source: Meeus, "Astronomical Algorithms" 2nd ed., Chapter 47 (top terms).
 * Accuracy: ~1° longitude, ~0.1° latitude, ~100 km distance.
 *
 * @param {number} jd  Julian Day Number (default: now)
 * @returns {{ lon: number, lon_rad: number, lat: number, lat_rad: number,
 *             dist_km: number, dist_AU: number }}
 */
export function moonGeocentric(jd = jdNow()) {
    const T = (jd - 2451545.0) / 36525.0;

    // ── Fundamental arguments (degrees) ──────────────────────────────────
    // Lp: Moon's mean longitude
    // D:  Mean elongation (Moon − Sun)
    // M:  Sun's mean anomaly
    // Mp: Moon's mean anomaly
    // F:  Moon's argument of latitude
    const Lp_deg = 218.3164477 + 481267.88123421 * T;
    const D_deg  = 297.8501921 + 445267.1114034  * T;
    const M_deg  = 357.5291092 +  35999.0502909  * T;
    const Mp_deg = 134.9633964 + 477198.8675055  * T;
    const F_deg  =  93.2720950 + 483202.0175233  * T;

    // Convert to radians (mod 360 first to reduce trig errors)
    const Lr  = (Lp_deg % 360) * D2R;
    const Dr  = (D_deg  % 360) * D2R;
    const Mr  = (M_deg  % 360) * D2R;
    const Mpr = (Mp_deg % 360) * D2R;
    const Fr  = (F_deg  % 360) * D2R;

    // ── Longitude perturbations (units: 10⁻⁶ °) — 16 dominant terms ─────
    const dL =
          6288774 * Math.sin(Mpr)
        + 1274027 * Math.sin(2*Dr - Mpr)
        +  658314 * Math.sin(2*Dr)
        +  213618 * Math.sin(2*Mpr)
        -  185116 * Math.sin(Mr)
        -  114332 * Math.sin(2*Fr)
        +   58793 * Math.sin(2*Dr - 2*Mpr)
        +   57066 * Math.sin(2*Dr - Mr - Mpr)
        +   53322 * Math.sin(2*Dr + Mpr)
        +   45758 * Math.sin(2*Dr - Mr)
        -   40923 * Math.sin(Mr  - Mpr)
        -   34720 * Math.sin(Dr)
        -   30383 * Math.sin(Mr  + Mpr)
        +   15327 * Math.sin(2*Dr - 2*Fr)
        -   12528 * Math.sin(Mpr + 2*Fr)
        +   10980 * Math.sin(Mpr - 2*Fr);

    const lon = ((Lp_deg + dL / 1e6) % 360 + 360) % 360;

    // ── Latitude perturbations (units: 10⁻⁶ °) — 8 dominant terms ───────
    const dB =
          5128122 * Math.sin(Fr)
        +  280602 * Math.sin(Mpr + Fr)
        +  277693 * Math.sin(Mpr - Fr)
        +  173237 * Math.sin(2*Dr - Fr)
        +   55413 * Math.sin(2*Dr - Mpr + Fr)
        +   46271 * Math.sin(2*Dr - Mpr - Fr)
        +   32573 * Math.sin(2*Dr + Fr)
        +   17198 * Math.sin(2*Mpr + Fr);

    const lat = dB / 1e6;   // geocentric ecliptic latitude (°)

    // ── Distance from Earth center (km) — 10 dominant terms ──────────────
    const dR =
        -20905355 * Math.cos(Mpr)
        - 3699111 * Math.cos(2*Dr - Mpr)
        - 2955968 * Math.cos(2*Dr)
        -  569925 * Math.cos(2*Mpr)
        +   48888 * Math.cos(Mr)
        -    3149 * Math.cos(2*Fr)
        +  246158 * Math.cos(2*Dr - 2*Mpr)
        -  152138 * Math.cos(2*Dr - Mr - Mpr)
        -  170733 * Math.cos(2*Dr + Mpr)
        -  204586 * Math.cos(2*Dr - Mr);

    const dist_km = 385000.56 + dR / 1000;   // m → km

    return {
        lon,      lon_rad: lon     * D2R,
        lat,      lat_rad: lat     * D2R,
        dist_km,  dist_AU: dist_km / 149597870.7,
    };
}

// ── NASA JPL Horizons REST API ────────────────────────────────────────────────
// Public API, no auth required.  Base URL:
const HORIZONS_URL = 'https://ssd.jpl.nasa.gov/api/horizons.api';

/**
 * Build a Horizons vector-table query.
 * @param {string} command  Body number e.g. "'399'" (Earth), "'301'" (Moon)
 * @param {string} center   Center body e.g. "'500@10'" (helio), "'500@399'" (geocentric)
 */
function _horizonsParams(command, center) {
    const now   = new Date();
    const start = now.toISOString().slice(0, 10);
    const stop  = new Date(now.getTime() + 86400e3).toISOString().slice(0, 10);
    return new URLSearchParams({
        format:     'json',
        COMMAND:    command,
        EPHEM_TYPE: 'VECTORS',
        CENTER:     center,
        START_TIME: start,
        STOP_TIME:  stop,
        STEP_SIZE:  '1d',
        VEC_TABLE:  '2',          // positions only (no vel header clutter)
        VEC_LABELS: 'YES',
        OBJ_DATA:   'NO',
        REF_FRAME:  'ECLIPJ2000',
        CAL_FORMAT: 'BOTH',
    });
}

/**
 * Parse X/Y/Z values from the Horizons $$SOE…$$EOE text block.
 * Returns { x, y, z } in whatever units Horizons used for this query.
 */
function _parseVec(text) {
    const soe = text.indexOf('$$SOE');
    const eoe = text.indexOf('$$EOE');
    if (soe < 0 || eoe < 0) throw new Error('Missing $$SOE/$$EOE markers');
    const block = text.slice(soe + 5, eoe);
    // Match "X = <value>" — Horizons may pad with spaces and use + or − sign
    const xm = block.match(/X\s*=\s*([-+]?[\d.E+\-]+)/i);
    const ym = block.match(/Y\s*=\s*([-+]?[\d.E+\-]+)/i);
    const zm = block.match(/Z\s*=\s*([-+]?[\d.E+\-]+)/i);
    if (!xm || !ym || !zm) throw new Error('Cannot parse X/Y/Z from block');
    return { x: parseFloat(xm[1]), y: parseFloat(ym[1]), z: parseFloat(zm[1]) };
}

/**
 * Fetch a state vector from Horizons.
 * @returns {{ x, y, z }}  in AU (heliocentric) or km (geocentric)
 */
async function _fetchVec(command, center) {
    const params = _horizonsParams(command, center);
    const url    = `${HORIZONS_URL}?${params}`;
    const resp   = await fetch(url, { mode: 'cors', cache: 'no-cache' });
    if (!resp.ok) throw new Error(`Horizons HTTP ${resp.status}`);
    const json = await resp.json();
    if (typeof json.result !== 'string') throw new Error('Horizons: no result string');
    return _parseVec(json.result);
}

// ── EphemerisService ──────────────────────────────────────────────────────────

export class EphemerisService {
    constructor() {
        this.source    = 'pending';
        this.data      = null;
        this._loaded   = false;
    }

    /**
     * Asynchronously load current ephemeris.
     * 1. Attempts JPL Horizons API (best accuracy, ~km for Earth)
     * 2. Falls back to on-device Meeus if Horizons is unavailable
     *
     * Fires 'ephemeris-ready' on window when complete.
     */
    async load() {
        const jd = jdNow();
        let earth, moon, source;

        // ── Attempt Horizons ──────────────────────────────────────────────
        try {
            console.log('[Horizons] Fetching Earth + Moon vectors…');

            // Earth heliocentric (AU), Moon geocentric (km)
            const [ev, mv] = await Promise.all([
                _fetchVec("'399'", "'500@10'"),    // Earth, Sun-centered, ECLIPJ2000
                _fetchVec("'301'", "'500@399'"),   // Moon, Earth-centered, ECLIPJ2000
            ]);

            // ECLIPJ2000 frame: X = vernal equinox (♈︎ direction), Y = 90° along ecliptic,
            // Z = ecliptic north pole.  Simulation XZ plane IS the ecliptic, Y = north.
            // Mapping: Horizons X → sim X,  Y → sim Z,  Z → sim Y.

            // Earth (AU) — z is tiny (Earth barely deviates from ecliptic)
            const eR = Math.sqrt(ev.x**2 + ev.y**2 + ev.z**2);
            earth = {
                lon_rad:  Math.atan2(ev.y, ev.x),        // ecliptic longitude
                lat_rad:  Math.asin( Math.max(-1, Math.min(1, ev.z / eR))),
                dist_AU:  eR,
                x_AU: ev.x, y_AU: ev.y, z_AU: ev.z,
                source: 'horizons',
            };

            // Moon (km → AU)
            const km2AU = 1 / 149597870.7;
            const mx = mv.x * km2AU, my = mv.y * km2AU, mz = mv.z * km2AU;
            const mR = Math.sqrt(mx**2 + my**2 + mz**2);
            moon = {
                lon_rad:  Math.atan2(my, mx),
                lat_rad:  Math.asin( Math.max(-1, Math.min(1, mz / mR))),
                dist_km:  Math.sqrt(mv.x**2 + mv.y**2 + mv.z**2),
                dist_AU:  mR,
                source: 'horizons',
            };

            source = 'horizons';
            console.log(
                `[Horizons] Earth lon=${(earth.lon_rad * R2D).toFixed(3)}° r=${earth.dist_AU.toFixed(6)} AU`,
                `| Moon lon=${(moon.lon_rad * R2D).toFixed(3)}° r=${moon.dist_km.toFixed(0)} km`
            );

        } catch (err) {
            console.warn('[Horizons] Unavailable — using Meeus fallback:', err.message);
        }

        // ── Meeus fallback ────────────────────────────────────────────────
        if (!earth) {
            const e = earthHeliocentric(jd);
            earth = { lon_rad: e.lon_rad, lat_rad: 0, dist_AU: e.dist_AU, source: 'meeus' };
        }
        if (!moon) {
            const m = moonGeocentric(jd);
            moon = {
                lon_rad: m.lon_rad, lat_rad: m.lat_rad,
                dist_km: m.dist_km, dist_AU: m.dist_AU,
                source: 'meeus',
            };
            if (!source) source = 'meeus';
        }

        this.source  = source;
        this._loaded = true;
        this.data    = { jd, earth, moon, timestamp: new Date(), source };

        window.dispatchEvent(new CustomEvent('ephemeris-ready', {
            detail: this.data,
        }));

        return this.data;
    }

    /** Re-fetch (e.g. on page re-focus or manual refresh). */
    refresh() { return this.load(); }
}

export default EphemerisService;
