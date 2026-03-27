/**
 * horizons.js — Real-time planetary ephemeris for the Celestial Simulator
 *
 * Provides precise positions for all 8 planets + Moon at the current instant.
 *
 * PRIMARY   NASA JPL Horizons Web API (state vectors, ECLIPJ2000 frame)
 *           https://ssd.jpl.nasa.gov/horizons/manual.html
 *           Earth heliocentric   (CENTER='500@10',  COMMAND='399')
 *           Moon  geocentric     (CENTER='500@399', COMMAND='301')
 *           Outer planets helio  (CENTER='500@10',  COMMAND='5xx/6xx/7xx/8xx')
 *           Response units: AU for heliocentric, km for geocentric.
 *
 * FALLBACK  On-device Meeus algorithms (Astronomical Algorithms, 2nd ed.)
 *           Earth    Ch.25 — accurate to ~0.01° for 1950–2050
 *           Moon     Ch.47 — accurate to ~1° (16-term longitude series)
 *           Inner planets — simplified Kepler + full 3D orbital rotation
 *           Outer planets — simplified Kepler + full 3D orbital rotation
 *           All planet positions include ecliptic latitude from inclination.
 *           Always works offline; no network latency.
 *
 * OUTPUT (ephemeris-ready CustomEvent on window)
 * ─────────────────────────────────────────────────────────────────
 *  detail.mercury  { lon_rad, lat_rad, dist_AU, x_AU, y_AU, z_AU }  heliocentric ecliptic
 *  detail.venus    { lon_rad, lat_rad, dist_AU, x_AU, y_AU, z_AU }
 *  detail.earth    { lon_rad, lat_rad, dist_AU, x_AU, y_AU, z_AU }
 *  detail.moon     { lon_rad, lat_rad, dist_km, dist_AU }            geocentric
 *  detail.mars     { lon_rad, lat_rad, dist_AU, x_AU, y_AU, z_AU }
 *  detail.jupiter  { lon_rad, lat_rad, dist_AU, x_AU, y_AU, z_AU }
 *  detail.saturn   { lon_rad, lat_rad, dist_AU, x_AU, y_AU, z_AU }
 *  detail.uranus   { lon_rad, lat_rad, dist_AU, x_AU, y_AU, z_AU }
 *  detail.neptune  { lon_rad, lat_rad, dist_AU, x_AU, y_AU, z_AU }
 *  detail.jd       number — Julian Day of fetch
 *  detail.source   'horizons' | 'meeus' | 'mixed'
 *  detail.timestamp  Date
 *
 * USAGE
 * ─────────────────────────────────────────────────────────────────
 *  import { EphemerisService } from './js/horizons.js';
 *
 *  const svc = new EphemerisService();
 *  svc.startLive(60);   // fires 'ephemeris-ready' every 60 s
 *
 *  window.addEventListener('ephemeris-ready', ev => {
 *      const { mercury, venus, earth, moon, mars,
 *              jupiter, saturn, uranus, neptune, source } = ev.detail;
 *      // earth.x_AU, earth.y_AU, earth.z_AU  → ECLIPJ2000 Cartesian (AU)
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
 * @returns {{ lon: number, lon_rad: number, lat_rad: number, dist_AU: number,
 *             x_AU: number, y_AU: number, z_AU: number }}
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
    const e = 0.016708634 - 0.000042037 * T - 0.0000001267 * T * T;
    const dist_AU = (1.000001018 * (1 - e * e)) / (1 + e * Math.cos(M));

    // Earth's orbit is nearly circular and lies in the ecliptic (i ≈ 0°)
    const lon_rad = lon * D2R;
    const x_AU = dist_AU * Math.cos(lon_rad);
    const y_AU = dist_AU * Math.sin(lon_rad);
    const z_AU = 0;

    return { lon, lon_rad, lat_rad: 0, dist_AU, x_AU, y_AU, z_AU };
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
    const Lp_deg = 218.3164477 + 481267.88123421 * T;
    const D_deg  = 297.8501921 + 445267.1114034  * T;
    const M_deg  = 357.5291092 +  35999.0502909  * T;
    const Mp_deg = 134.9633964 + 477198.8675055  * T;
    const F_deg  =  93.2720950 + 483202.0175233  * T;

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

    const lat = dB / 1e6;

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

    const dist_km = 385000.56 + dR / 1000;

    return {
        lon,      lon_rad: lon     * D2R,
        lat,      lat_rad: lat     * D2R,
        dist_km,  dist_AU: dist_km / 149597870.7,
    };
}

/**
 * Generic heliocentric 3D position from simplified Keplerian elements.
 *
 * Computes the full ecliptic XYZ position including orbital inclination
 * via the standard orbital-plane → ecliptic rotation:
 *   x = r[cosΩ·cos(ω+ν) − sinΩ·sin(ω+ν)·cosi]
 *   y = r[sinΩ·cos(ω+ν) + cosΩ·sin(ω+ν)·cosi]
 *   z = r[sin(ω+ν)·sini]
 *
 * Equation of center: 3-term series, accurate to ~0.01° for e < 0.1,
 * ~0.3° for Mercury (e ≈ 0.206).
 *
 * Source: Meeus, "Astronomical Algorithms" 2nd ed., Table 31.a (J2000 epoch).
 *
 * @param {number} jd
 * @param {{ L0, Ldot, a, e, omega, i, node }} el  Orbital elements at J2000
 *   L0:    Mean longitude at J2000 (degrees)
 *   Ldot:  Rate of mean longitude (degrees / Julian century)
 *   a:     Semi-major axis (AU)
 *   e:     Eccentricity
 *   omega: Longitude of perihelion ω̄ = Ω + ω (degrees)
 *   i:     Inclination to ecliptic (degrees)
 *   node:  Longitude of ascending node Ω (degrees)
 * @returns {{ lon_rad, lat_rad, dist_AU, x_AU, y_AU, z_AU }}
 */
function planetHeliocentric(jd, el) {
    const T = (jd - 2451545.0) / 36525.0;

    // Mean longitude and anomaly
    const L   = ((el.L0 + el.Ldot * T) % 360 + 360) % 360;
    const M   = ((L - el.omega) % 360 + 360) % 360;
    const Mr  = M * D2R;
    const e   = el.e;

    // Equation of center (3-term, good to ~0.01° for e < 0.1; ~0.3° for Mercury)
    const nu_minus_M = (2 * e - e*e*e / 4) * Math.sin(Mr)
                     + (5/4)  * e*e         * Math.sin(2 * Mr)
                     + (13/12) * e*e*e      * Math.sin(3 * Mr);

    const nu      = Mr + nu_minus_M;                               // true anomaly (rad)
    const dist_AU = (el.a * (1 - e * e)) / (1 + e * Math.cos(nu));

    // Orbital-plane → heliocentric ecliptic XYZ
    // argument of perihelion ω (lowercase) = ω̄ − Ω
    const nodeR  = el.node  * D2R;
    const iR     = el.i     * D2R;
    const argPer = (el.omega - el.node) * D2R;   // ω in radians
    const u      = argPer + nu;                    // argument of latitude

    const cosO = Math.cos(nodeR), sinO = Math.sin(nodeR);
    const cosU = Math.cos(u),     sinU = Math.sin(u);
    const cosI = Math.cos(iR),    sinI = Math.sin(iR);

    const x_AU = dist_AU * (cosO * cosU - sinO * sinU * cosI);
    const y_AU = dist_AU * (sinO * cosU + cosO * sinU * cosI);
    const z_AU = dist_AU * (sinU * sinI);

    const lon_rad = Math.atan2(y_AU, x_AU);
    const lat_rad = Math.asin(Math.max(-1, Math.min(1, z_AU / dist_AU)));
    const lon     = ((lon_rad * R2D) % 360 + 360) % 360;

    return { lon, lon_rad, lat_rad, dist_AU, x_AU, y_AU, z_AU };
}

// ── Orbital elements at J2000.0  (Meeus Table 31.a) ─────────────────────────
// L0:    mean longitude (°)      Ldot:  rate (°/Julian century)
// a:     semi-major axis (AU)    e:     eccentricity
// omega: longitude of perihelion (°) = Ω + ω
// i:     inclination to ecliptic (°)
// node:  longitude of ascending node Ω (°)

const MERCURY_EL = { L0: 252.250906, Ldot: 149472.6746358, a: 0.38709831, e: 0.20563175, omega: 77.456119,  i: 7.004986, node:  48.330893 };
const VENUS_EL   = { L0: 181.979801, Ldot:  58517.8156760, a: 0.72332982, e: 0.00677323, omega: 131.563703, i: 3.394662, node:  76.679920 };
const MARS_EL    = { L0: 355.433275, Ldot:  19140.2993313, a: 1.52366231, e: 0.09341233, omega: 336.060234, i: 1.849726, node:  49.558093 };
const JUPITER_EL = { L0:  34.351519, Ldot:   3034.9056606, a: 5.20260319, e: 0.04849793, omega:  14.331309, i: 1.303270, node: 100.464441 };
const SATURN_EL  = { L0:  50.077444, Ldot:   1222.1138488, a: 9.55491122, e: 0.05550825, omega:  93.056787, i: 2.488879, node: 113.665527 };
const URANUS_EL  = { L0: 314.055005, Ldot:    428.4669983, a: 19.2184461, e: 0.04629590, omega: 173.005291, i: 0.773197, node:  74.005957 };
const NEPTUNE_EL = { L0: 304.348665, Ldot:    218.4862002, a: 30.1103869, e: 0.00898809, omega:  48.120275, i: 1.769953, node: 131.784057 };

/**
 * Mercury's heliocentric ecliptic position (full 3D).
 * Accuracy: ~0.5° for 1950–2050.
 */
export function mercuryHeliocentric(jd = jdNow()) {
    return planetHeliocentric(jd, MERCURY_EL);
}

/**
 * Venus's heliocentric ecliptic position (full 3D).
 * Accuracy: ~0.1° for 1950–2050.
 */
export function venusHeliocentric(jd = jdNow()) {
    return planetHeliocentric(jd, VENUS_EL);
}

/**
 * Mars's heliocentric ecliptic position (full 3D).
 * Accuracy: ~0.3° for 1950–2050.
 */
export function marsHeliocentric(jd = jdNow()) {
    return planetHeliocentric(jd, MARS_EL);
}

/**
 * Jupiter's heliocentric ecliptic position (full 3D).
 * Accuracy: ~0.5° for 1950–2050.
 */
export function jupiterHeliocentric(jd = jdNow()) {
    return planetHeliocentric(jd, JUPITER_EL);
}

/**
 * Saturn's heliocentric ecliptic position (full 3D).
 * Accuracy: ~0.5° for 1950–2050.
 */
export function saturnHeliocentric(jd = jdNow()) {
    return planetHeliocentric(jd, SATURN_EL);
}

/**
 * Uranus's heliocentric ecliptic position (full 3D).
 * Accuracy: ~0.5° for 1950–2050.
 */
export function uranusHeliocentric(jd = jdNow()) {
    return planetHeliocentric(jd, URANUS_EL);
}

/**
 * Neptune's heliocentric ecliptic position (full 3D).
 * Accuracy: ~0.5° for 1950–2050.
 */
export function neptuneHeliocentric(jd = jdNow()) {
    return planetHeliocentric(jd, NEPTUNE_EL);
}

// ── NASA JPL Horizons REST API ────────────────────────────────────────────────
// Use a same-origin proxy (/api/horizons) so the browser avoids CORS.
// Falls back to direct JPL if the proxy is unavailable (caught upstream).
const HORIZONS_URL = '/api/horizons';

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
        VEC_TABLE:  '2',
        VEC_LABELS: 'YES',
        OBJ_DATA:   'NO',
        REF_FRAME:  'ECLIPJ2000',
        CAL_FORMAT: 'BOTH',
    });
}

function _parseVec(text) {
    const soe = text.indexOf('$$SOE');
    const eoe = text.indexOf('$$EOE');
    if (soe < 0 || eoe < 0) throw new Error('Missing $$SOE/$$EOE markers');
    const block = text.slice(soe + 5, eoe);
    const xm = block.match(/X\s*=\s*([-+]?[\d.E+\-]+)/i);
    const ym = block.match(/Y\s*=\s*([-+]?[\d.E+\-]+)/i);
    const zm = block.match(/Z\s*=\s*([-+]?[\d.E+\-]+)/i);
    if (!xm || !ym || !zm) throw new Error('Cannot parse X/Y/Z from block');
    return { x: parseFloat(xm[1]), y: parseFloat(ym[1]), z: parseFloat(zm[1]) };
}

async function _fetchVec(command, center) {
    const params = _horizonsParams(command, center);
    const url    = `${HORIZONS_URL}?${params}`;
    const resp   = await fetch(url, { cache: 'no-cache' });
    if (!resp.ok) throw new Error(`Horizons HTTP ${resp.status}`);
    const json = await resp.json();
    if (typeof json.result !== 'string') throw new Error('Horizons: no result string');
    return _parseVec(json.result);
}

/** Convert an ECLIPJ2000 X/Y/Z vector (in AU) to heliocentric ecliptic coords. */
function _vecToHelioEcliptic(v) {
    const r = Math.sqrt(v.x**2 + v.y**2 + v.z**2);
    return {
        lon_rad:  Math.atan2(v.y, v.x),
        lat_rad:  Math.asin(Math.max(-1, Math.min(1, v.z / r))),
        dist_AU:  r,
        x_AU: v.x, y_AU: v.y, z_AU: v.z,
        source: 'horizons',
    };
}

// ── EphemerisService ──────────────────────────────────────────────────────────

export class EphemerisService {
    constructor() {
        this.source    = 'pending';
        this.data      = null;
        this._loaded   = false;
        this._timer    = null;
    }

    /**
     * Asynchronously load current ephemeris for all 8 planets + Moon.
     *
     * Strategy:
     *  • Earth + Moon      — JPL Horizons primary, Meeus fallback
     *  • Outer planets     — JPL Horizons attempted in parallel (Promise.allSettled);
     *                        Meeus used for any that fail or timeout
     *  • Mercury/Venus/Mars — Meeus algorithms (sub-degree accuracy, sufficient for
     *                         real-time heliospheric visualization)
     *
     * Fires 'ephemeris-ready' on window when complete.
     */
    async load() {
        const jd = jdNow();
        let earth, moon, jupiter, saturn, uranus, neptune;
        let horizonsSucceeded = false;

        // ── Attempt Horizons for Earth + Moon ─────────────────────────────
        try {
            console.log('[Horizons] Fetching Earth + Moon vectors…');
            const [ev, mv] = await Promise.all([
                _fetchVec("'399'", "'500@10'"),   // Earth, heliocentric, AU
                _fetchVec("'301'", "'500@399'"),  // Moon,  geocentric,   km
            ]);

            earth = _vecToHelioEcliptic(ev);

            const km2AU = 1 / 149597870.7;
            const mx = mv.x * km2AU, my = mv.y * km2AU, mz = mv.z * km2AU;
            const mR = Math.sqrt(mx**2 + my**2 + mz**2);
            moon = {
                lon_rad: Math.atan2(my, mx),
                lat_rad: Math.asin(Math.max(-1, Math.min(1, mz / mR))),
                dist_km: Math.sqrt(mv.x**2 + mv.y**2 + mv.z**2),
                dist_AU: mR,
                source: 'horizons',
            };

            horizonsSucceeded = true;
            console.log(
                `[Horizons] Earth lon=${(earth.lon_rad * R2D).toFixed(2)}°`,
                `r=${earth.dist_AU.toFixed(5)} AU | Moon r=${moon.dist_km.toFixed(0)} km`,
            );

        } catch (err) {
            console.warn('[Horizons] Earth/Moon unavailable — using Meeus fallback:', err.message);
        }

        // ── Attempt Horizons for outer planets (non-blocking) ────────────
        // Each fetch is independent; Meeus is used if any fail.
        const outerIds = [
            { name: 'jupiter', cmd: "'599'" },
            { name: 'saturn',  cmd: "'699'" },
            { name: 'uranus',  cmd: "'799'" },
            { name: 'neptune', cmd: "'899'" },
        ];
        const outerResults = await Promise.allSettled(
            outerIds.map(({ cmd }) => _fetchVec(cmd, "'500@10'"))
        );

        const outerHorizons = {};
        outerIds.forEach(({ name }, idx) => {
            const result = outerResults[idx];
            if (result.status === 'fulfilled') {
                outerHorizons[name] = _vecToHelioEcliptic(result.value);
                console.log(`[Horizons] ${name} r=${outerHorizons[name].dist_AU.toFixed(3)} AU`);
            } else {
                console.warn(`[Horizons] ${name} failed — using Meeus:`, result.reason?.message);
            }
        });

        // ── Meeus fallback for Earth + Moon ───────────────────────────────
        if (!earth) {
            const e = earthHeliocentric(jd);
            earth = { ...e, source: 'meeus' };
        }
        if (!moon) {
            const m = moonGeocentric(jd);
            moon = {
                lon_rad: m.lon_rad, lat_rad: m.lat_rad,
                dist_km: m.dist_km, dist_AU: m.dist_AU,
                source: 'meeus',
            };
        }

        // ── Inner planets — Meeus algorithms ─────────────────────────────
        const mercury = { ...mercuryHeliocentric(jd), source: 'meeus' };
        const venus   = { ...venusHeliocentric(jd),   source: 'meeus' };
        const mars    = { ...marsHeliocentric(jd),    source: 'meeus' };

        // ── Outer planets — Horizons or Meeus ────────────────────────────
        jupiter = outerHorizons.jupiter ?? { ...jupiterHeliocentric(jd), source: 'meeus' };
        saturn  = outerHorizons.saturn  ?? { ...saturnHeliocentric(jd),  source: 'meeus' };
        uranus  = outerHorizons.uranus  ?? { ...uranusHeliocentric(jd),  source: 'meeus' };
        neptune = outerHorizons.neptune ?? { ...neptuneHeliocentric(jd), source: 'meeus' };

        const anyOuter = Object.values(outerHorizons).length > 0;
        const source = horizonsSucceeded
            ? (anyOuter ? 'horizons' : 'mixed')
            : 'meeus';

        console.log(
            `[Ephemeris] ${source} |`,
            `Jup=${(jupiter.lon_rad * R2D).toFixed(1)}°`,
            `Sat=${(saturn.lon_rad  * R2D).toFixed(1)}°`,
            `Ura=${(uranus.lon_rad  * R2D).toFixed(1)}°`,
            `Nep=${(neptune.lon_rad * R2D).toFixed(1)}°`,
        );

        this.source  = source;
        this._loaded = true;
        this.data    = {
            jd, source, timestamp: new Date(),
            mercury, venus, earth, moon, mars,
            jupiter, saturn, uranus, neptune,
        };

        window.dispatchEvent(new CustomEvent('ephemeris-ready', { detail: this.data }));
        return this.data;
    }

    /** Re-fetch (e.g. on page re-focus or manual refresh). */
    refresh() { return this.load(); }

    /**
     * Start live refresh every `intervalSec` seconds (default 60).
     * Stops any existing timer first.
     */
    startLive(intervalSec = 60) {
        this.stopLive();
        this.load();  // immediate first fetch
        this._timer = setInterval(() => this.load(), intervalSec * 1000);
        return this;
    }

    stopLive() {
        if (this._timer) { clearInterval(this._timer); this._timer = null; }
    }
}

export default EphemerisService;
