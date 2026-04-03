/**
 * horizons-extended.js — JPL Horizons spacecraft / small-body ephemeris
 *
 * ── OWNERSHIP SPLIT ──────────────────────────────────────────────────────────
 *  horizons.js / EphemerisService  owns all 8 planets (199–899) + Moon (301).
 *                                  Uses /api/horizons Vercel proxy + Meeus fallback.
 *                                  Fires: 'ephemeris-ready'
 *
 *  horizons-extended.js (this file) owns spacecraft and small bodies ONLY.
 *                                  Calls JPL Horizons directly (no API key).
 *                                  Do NOT add planet IDs (199–899) or Moon (301).
 *                                  Fires: 'horizons-update'
 *
 * Polls the JPL HORIZONS REST API for real-time heliocentric XYZ positions
 * (AU).  No API key required.  Poll default: 60 min (positions change slowly).
 *
 * STATE EVENT
 * ─────────────────────────────────────────────────────────────────────────────
 *  'horizons-update'  { bodies: { stereo_a, … spacecraft }, status, lastUpdated }
 *  Planets/Moon come via 'ephemeris-ready' from EphemerisService in horizons.js.
 *
 *  Each body: { x, y, z (AU), r (AU from Sun), lon_rad, lat_rad,
 *               lon_deg, lat_deg }
 *
 * USAGE
 * ─────────────────────────────────────────────────────────────────────────────
 *  import { HorizonsFeed } from './js/horizons-extended.js';
 *
 *  new HorizonsFeed().start();
 *  window.addEventListener('horizons-update', e => {
 *      const { stereo_a } = e.detail.bodies;
 *      console.log(`STEREO-A: ${stereo_a.r.toFixed(3)} AU from Sun`);
 *  });
 *
 * HOW TO ADD MORE BODIES
 * ─────────────────────────────────────────────────────────────────────────────
 *  Add spacecraft or small-body entries to HORIZONS_BODIES ONLY.
 *  Do NOT add planet IDs (199–899) or Moon (301) — use EphemerisService instead.
 *    Spacecraft: -234=STEREO-A  -227=STEREO-B  -82=Cassini  -159=JWST
 *    Comets:    'DES=1995 O1' (Hale-Bopp)   'NAME=Halley'
 *    Asteroids: '1;' (Ceres)  '2;' (Pallas)  '433;' (Eros)
 */

'use strict';

// ── Private helpers ────────────────────────────────────────────────────────────

function isoDate(d) { return d.toISOString().slice(0, 10); }
function dateOffset(days) { return isoDate(new Date(Date.now() + days * 86400e3)); }

async function fetchJSON(url) {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
    return res.json();
}

const HORIZONS_BASE = 'https://ssd.jpl.nasa.gov/api/horizons.api';

/**
 * Build a Horizons VECTORS query URL for a single body.
 * Returns heliocentric ecliptic XYZ in AU, valid for today's date.
 */
function horizonsURL(command) {
    const start = dateOffset(0);  // today
    const stop  = dateOffset(1);  // tomorrow (need at least 1-day window)
    const params = new URLSearchParams({
        format:      'json',
        COMMAND:     command,
        OBJ_DATA:    'NO',
        MAKE_EPHEM:  'YES',
        EPHEM_TYPE:  'VECTORS',
        CENTER:      '500@10',   // heliocentric — body center of Sun
        START_TIME:  start,
        STOP_TIME:   stop,
        STEP_SIZE:   '1 d',
        VEC_TABLE:   '1',        // position only (skip velocity columns)
        VEC_CORR:    'NONE',
        REF_PLANE:   'ECLIPTIC',
        REF_SYSTEM:  'J2000',
        OUT_UNITS:   'AU-D',
    });
    return `${HORIZONS_BASE}?${params.toString()}`;
}

/**
 * Parse the heliocentric XYZ (AU) and range (AU) from a Horizons VECTORS
 * `result` text blob.  Returns null if the block cannot be parsed.
 *
 * Expected format between $$SOE / $$EOE markers:
 *   <JD> = A.D. <date> TDB
 *    X = 1.23E+00 Y =-4.56E-01 Z = 7.89E-03
 *    VX= ...  VY= ...  VZ= ...  LT= ...  RG= 1.50E+00  RR= ...
 */
function parseHorizonsVectors(text) {
    const soe = text.indexOf('$$SOE');
    const eoe = text.indexOf('$$EOE');
    if (soe < 0 || eoe < 0) return null;

    const block = text.slice(soe + 5, eoe);

    // Match axis values — handles both "X = 1.23" and "X =-1.23" (no space before minus)
    const coord = axis => {
        const m = block.match(new RegExp(`\\b${axis}\\s*=\\s*([+-]?[\\d.]+(?:E[+-]?\\d+)?)`, 'i'));
        return m ? parseFloat(m[1]) : null;
    };

    const x = coord('X');
    const y = coord('Y');
    const z = coord('Z');
    if (x == null || y == null || z == null) return null;

    // RG = range from center (AU) — directly from Horizons, more accurate than √(x²+y²+z²)
    const rgm = block.match(/\bRG\s*=\s*([+-]?[\d.]+(?:E[+-]?\d+)?)/i);
    const r   = rgm ? parseFloat(rgm[1]) : Math.sqrt(x * x + y * y + z * z);

    // Ecliptic longitude and latitude from XYZ (radians)
    const lon_rad = Math.atan2(y, x);
    const lat_rad = Math.asin(Math.max(-1, Math.min(1, z / r)));

    return {
        x,             // AU, heliocentric ecliptic J2000
        y,             // AU
        z,             // AU
        r,             // AU, distance from Sun
        lon_rad,       // ecliptic longitude (radians)
        lat_rad,       // ecliptic latitude (radians)
        lon_deg: lon_rad * 180 / Math.PI,
        lat_deg: lat_rad * 180 / Math.PI,
    };
}

// ── Exports ───────────────────────────────────────────────────────────────────

/**
 * Spacecraft / small-body IDs for this feed.
 * Key = friendly name used in event.detail.bodies.
 * Value = Horizons COMMAND string.
 *
 * !! Do NOT add planet IDs (199–899) or Moon (301) here.
 * !! Those are owned exclusively by horizons.js / EphemerisService.
 *
 * Spacecraft ID reference:
 *   -234  STEREO-A      -227  STEREO-B     -159  JWST
 *   -82   Cassini        -48  Ulysses       -31  Voyager 1
 */
export const HORIZONS_BODIES = {
    stereo_a: '-234',  // STEREO-A spacecraft — heliocentric position relative to Sun
};

export class HorizonsFeed {
    /**
     * @param {object} opts
     * @param {number} opts.pollInterval  ms between polls (default 60 min)
     * @param {object} opts.bodies        Override HORIZONS_BODIES if you want
     *                                    a custom subset or additional spacecraft.
     */
    constructor({
        pollInterval = 60 * 60 * 1000,
        bodies       = HORIZONS_BODIES,
    } = {}) {
        this.pollInterval = pollInterval;
        this.bodies       = bodies;
        this._timer       = null;
        this.status       = 'connecting';
        this.lastUpdated  = null;
        this.failStreak   = 0;
        this._raw         = {};  // keyed by body name
    }

    start() {
        this._poll();
        this._timer = setInterval(() => this._poll(), this.pollInterval);
        return this;
    }

    stop() { clearInterval(this._timer); this._timer = null; }

    refresh() { return this._poll(); }

    get state() { return this._buildState(); }

    async _poll() {
        const entries = Object.entries(this.bodies);

        // Guard: planet IDs belong to EphemerisService in horizons.js — not this feed.
        const PLANET_IDS = new Set(['199','299','399','499','599','699','799','899','301']);
        entries.forEach(([name, cmd]) => {
            if (PLANET_IDS.has(String(cmd)))
                console.warn(`[HorizonsFeed] body '${name}' (${cmd}) is a planet/moon — use EphemerisService in horizons.js instead.`);
        });

        // Fetch all bodies in parallel — Horizons handles concurrent requests fine
        const results = await Promise.allSettled(
            entries.map(async ([name, command]) => {
                const data = await fetchJSON(horizonsURL(command));
                const pos  = parseHorizonsVectors(data.result ?? '');
                if (!pos) throw new Error(`parse failed for ${name} (${command})`);
                this._raw[name] = pos;
            })
        );

        const ok  = results.some(r => r.status === 'fulfilled');
        const all = results.every(r => r.status === 'rejected');

        if (ok) {
            this.status      = 'live';
            this.lastUpdated = new Date();
            this.failStreak  = 0;
        } else if (all) {
            this.failStreak++;
            this.status = this.failStreak > 2 ? 'offline' : 'stale';
        }

        results.forEach((r, i) => {
            if (r.status === 'rejected')
                console.debug(`[Horizons] ${entries[i][0]}: ${r.reason?.message ?? r.reason}`);
        });

        window.dispatchEvent(new CustomEvent('horizons-update', { detail: this._buildState() }));
    }

    _buildState() {
        return {
            /** Keyed by body name (e.g. 'stereo_a').
             *  Each value: { x, y, z (AU), r (AU from Sun), lon_deg, lat_deg } */
            bodies:      { ...this._raw },
            status:      this.status,
            lastUpdated: this.lastUpdated,
        };
    }
}

export default HorizonsFeed;
