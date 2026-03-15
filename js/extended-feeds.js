/**
 * extended-feeds.js — SOHO/SDO live imagery catalog, JPL Horizons real-time
 *                     planetary ephemeris (including STEREO-A position),
 *                     and NASA NeoWs near-Earth asteroid close-approach feed.
 *
 * THREE INDEPENDENT CLASSES — use any combination:
 * ─────────────────────────────────────────────────────────────────────────────
 *  SohoFeed      No polling — emits 'soho-update' once with a catalog of
 *                the latest SOHO/LASCO and SDO/AIA image URLs, ready to drop
 *                straight into <img src="..."> or a WebGL texture loader.
 *
 *  HorizonsFeed  Polls the JPL HORIZONS REST API for real-time heliocentric
 *                XYZ positions (AU) of all 8 planets, the Moon, and STEREO-A.
 *                Emits 'horizons-update'. No API key required.
 *                Poll default: 60 min (positions change slowly).
 *
 *  NeoFeed       Polls the NASA NeoWs API for near-Earth object close
 *                approaches over a configurable window (default: next 7 days).
 *                Emits 'neo-update'. Requires a NASA API key (free).
 *                Poll default: 6 hours (NeoWs data is updated daily).
 *
 * API KEYS
 * ─────────────────────────────────────────────────────────────────────────────
 *  HorizonsFeed — no key needed (public JPL REST API, no rate limit stated).
 *  NeoFeed      — free NASA key from https://api.nasa.gov/.
 *                 Use 'DEMO_KEY' for development (30 req/hr, 50 req/day).
 *                 Each NeoFeed poll uses 1 request.
 *
 * SOHO / SDO IMAGE SOURCES
 * ─────────────────────────────────────────────────────────────────────────────
 *  SDO (Solar Dynamics Observatory) — updates every ~12 minutes:
 *    AIA 171Å  coronal loops, ~600 000 K          latest_1024_0171.jpg
 *    AIA 193Å  Fe XII corona, ~1.5 MK             latest_1024_0193.jpg
 *    AIA 211Å  active regions, ~2 MK              latest_1024_0211.jpg
 *    AIA 304Å  He II chromosphere, ~50 000 K      latest_1024_0304.jpg
 *    AIA 1600Å UV continuum, transition region     latest_1024_1600.jpg
 *    AIA 131Å  flare plasma, ~10 MK               latest_1024_0131.jpg
 *    HMI IC    continuum (sunspot photosphere)     latest_1024_HMIIC.jpg
 *    HMI Mag   line-of-sight magnetogram           latest_1024_HMIB.jpg
 *
 *  SOHO LASCO (coronagraphs) — updates every ~20–30 minutes:
 *    C2  inner corona,  2–6  solar radii           latest.jpg (c2/1024)
 *    C3  outer corona,  3–30 solar radii           latest.jpg (c3/1024)
 *
 *  STEREO-A SECCHI (behind-the-limb view) — updates ~1–2 hrs:
 *    COR2  outer coronagraph, 2–15 solar radii     (beacon image URL)
 *    EUVI 195Å  EUV full-disk                     (beacon image URL)
 *
 * HOW TO ADD MORE BODIES TO HorizonsFeed
 * ─────────────────────────────────────────────────────────────────────────────
 *  Add an entry to HORIZONS_BODIES with any valid Horizons COMMAND string:
 *    Planets:   199=Mercury  299=Venus  499=Mars  599=Jupiter  …
 *    Spacecraft: -234=STEREO-A  -227=STEREO-B  -82=Cassini  -159=JWST
 *    Comets:    'DES=1995 O1' (Hale-Bopp)   'NAME=Halley'
 *    Asteroids: '1;' (Ceres)  '2;' (Pallas)  '433;' (Eros)
 *
 * HOW TO ADD MORE NEO FILTERS
 * ─────────────────────────────────────────────────────────────────────────────
 *  NeoFeed returns the raw NeoWs near_earth_objects object as-is plus a
 *  pre-filtered `hazardous` array and a `closest` array sorted by miss distance.
 *  Add your own filters inside _buildState() or post-process the 'neo-update' event.
 *
 * STATE EVENTS
 * ─────────────────────────────────────────────────────────────────────────────
 *  'soho-update'     { images, stereo_images }
 *  'horizons-update' { bodies: { mercury, venus, earth, … stereo_a }, status, lastUpdated }
 *  'neo-update'      { neos_by_date, hazardous, closest, element_count, status, lastUpdated }
 *
 * USAGE
 * ─────────────────────────────────────────────────────────────────────────────
 *  import { SohoFeed, HorizonsFeed, NeoFeed } from './js/extended-feeds.js';
 *
 *  // SOHO/SDO imagery — fires once immediately, no polling
 *  new SohoFeed().start();
 *  window.addEventListener('soho-update', e => {
 *      document.getElementById('sun-img').src = e.detail.images.sdo_aia193;
 *  });
 *
 *  // Planetary positions — polls every 60 min, no key needed
 *  new HorizonsFeed().start();
 *  window.addEventListener('horizons-update', e => {
 *      const { mars, stereo_a } = e.detail.bodies;
 *      console.log(`Mars: ${mars.x.toFixed(3)} AU from Sun`);
 *  });
 *
 *  // Near-Earth objects — polls every 6 hours
 *  new NeoFeed({ apiKey: 'YOUR_KEY' }).start();
 *  window.addEventListener('neo-update', e => {
 *      console.log(`${e.detail.element_count} NEOs in window`);
 *      e.detail.hazardous.forEach(neo => console.log(neo.name, neo.miss_km, 'km'));
 *  });
 */

'use strict';

// ── Shared helpers ─────────────────────────────────────────────────────────────

function isoDate(d) { return d.toISOString().slice(0, 10); }
function dateOffset(days) { return isoDate(new Date(Date.now() + days * 86400e3)); }

async function fetchJSON(url) {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
    return res.json();
}

// ══════════════════════════════════════════════════════════════════════════════
// 1.  SohoFeed — SOHO/SDO + STEREO image URL catalog
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Static latest-image URL catalog for SDO/AIA, SOHO/LASCO, and STEREO-A/SECCHI.
 * All URLs point to NASA's public "latest.jpg" / "latest.png" endpoints — no
 * CORS issues, no authentication, no rate limits.  Updated every 12–60 minutes
 * by NASA servers; just reload the <img> src to get a fresh frame.
 */
export const SOHO_IMAGES = {
    // ── SDO / AIA ────────────────────────────────────────────────────────────
    /** AIA 171Å — coronal loops, Fe IX, ~600 000 K (yellow/gold glow) */
    sdo_aia171:  'https://sdo.gsfc.nasa.gov/assets/img/latest/latest_1024_0171.jpg',
    /** AIA 193Å — Fe XII corona, ~1.5 MK + flare Fe XXIV (green tones) */
    sdo_aia193:  'https://sdo.gsfc.nasa.gov/assets/img/latest/latest_1024_0193.jpg',
    /** AIA 211Å — active region corona, Fe XIV, ~2 MK (purple/magenta) */
    sdo_aia211:  'https://sdo.gsfc.nasa.gov/assets/img/latest/latest_1024_0211.jpg',
    /** AIA 304Å — He II chromosphere / transition region, ~50 000 K (red) */
    sdo_aia304:  'https://sdo.gsfc.nasa.gov/assets/img/latest/latest_1024_0304.jpg',
    /** AIA 1600Å — UV continuum / C IV, ~100 000 K (white/UV) */
    sdo_aia1600: 'https://sdo.gsfc.nasa.gov/assets/img/latest/latest_1024_1600.jpg',
    /** AIA 131Å — flare plasma, Fe VIII + Fe XXI, ~10 MK (teal) */
    sdo_aia131:  'https://sdo.gsfc.nasa.gov/assets/img/latest/latest_1024_0131.jpg',
    /** HMI Intensitygram — photospheric continuum, shows sunspots clearly */
    sdo_hmi_ic:  'https://sdo.gsfc.nasa.gov/assets/img/latest/latest_1024_HMIIC.jpg',
    /** HMI Magnetogram — line-of-sight Bfield (black=south, white=north) */
    sdo_hmi_mag: 'https://sdo.gsfc.nasa.gov/assets/img/latest/latest_1024_HMIB.jpg',

    // ── SOHO / LASCO coronagraphs ─────────────────────────────────────────────
    /** LASCO C2 — inner corona, 2–6 solar radii, ~20-min cadence */
    lasco_c2:    'https://soho.nascom.nasa.gov/data/realtime/c2/1024/latest.jpg',
    /** LASCO C3 — outer corona, 3.7–30 solar radii, CME detection */
    lasco_c3:    'https://soho.nascom.nasa.gov/data/realtime/c3/1024/latest.jpg',

    // ── SOHO / EIT (legacy, 12-min) ───────────────────────────────────────────
    /** EIT 195Å — Fe XII corona (same channel as AIA 193 but lower res) */
    eit_195:     'https://soho.nascom.nasa.gov/data/realtime/eit_195/1024/latest.jpg',
    /** EIT 304Å — He II chromosphere */
    eit_304:     'https://soho.nascom.nasa.gov/data/realtime/eit_304/1024/latest.jpg',
};

/**
 * STEREO-A SECCHI beacon images — transmitted daily from the spacecraft.
 * Lower cadence than SDO (~1–4 hrs between frames).
 */
export const STEREO_IMAGES = {
    /** COR2 outer coronagraph — 2–15 solar radii, CMEs visible from L4 vantage */
    cor2:    'https://stereo-ssc.nascom.nasa.gov/browse/2025/cor2a_latest.jpg',
    /** EUVI 195Å — full-disk EUV from STEREO-A vantage point */
    euvi195: 'https://stereo-ssc.nascom.nasa.gov/browse/2025/euvia_195_latest.jpg',
};

export class SohoFeed {
    /**
     * Emits 'soho-update' once on start() with a catalog of the latest image
     * URLs — no polling needed since the URLs themselves are always "latest".
     * Call refresh() to re-emit the catalog (e.g. to force texture reload).
     */
    start() {
        this._emit();
        return this;
    }

    refresh() { this._emit(); }

    get state() {
        return { images: { ...SOHO_IMAGES }, stereo_images: { ...STEREO_IMAGES } };
    }

    _emit() {
        window.dispatchEvent(new CustomEvent('soho-update', {
            detail: { images: { ...SOHO_IMAGES }, stereo_images: { ...STEREO_IMAGES } },
        }));
    }
}


// ══════════════════════════════════════════════════════════════════════════════
// 2.  HorizonsFeed — JPL Horizons real-time ephemeris (planets + STEREO-A)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Solar-system bodies to fetch.  Key = friendly name used in event.detail.bodies.
 * Value = Horizons COMMAND string (integer body IDs, or quoted strings for names).
 *
 * Horizons body ID reference:
 *   10   Sun          199  Mercury     299  Venus      399  Earth
 *   499  Mars         599  Jupiter     699  Saturn     799  Uranus
 *   899  Neptune      301  Moon        -234 STEREO-A   -159 JWST
 *   1;   Ceres (dwarf planet)          -82  Cassini
 */
export const HORIZONS_BODIES = {
    mercury:  '199',
    venus:    '299',
    earth:    '399',
    mars:     '499',
    jupiter:  '599',
    saturn:   '699',
    uranus:   '799',
    neptune:  '899',
    moon:     '301',
    stereo_a: '-234',  // STEREO-A spacecraft — gives its position relative to Sun
};

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
            /** Keyed by body name (e.g. 'mars', 'stereo_a').
             *  Each value: { x, y, z (AU), r (AU from Sun), lon_deg, lat_deg } */
            bodies:      { ...this._raw },
            status:      this.status,
            lastUpdated: this.lastUpdated,
        };
    }
}


// ══════════════════════════════════════════════════════════════════════════════
// 3.  NeoFeed — NASA NeoWs Near-Earth Object close-approach feed
// ══════════════════════════════════════════════════════════════════════════════

const NEOWS_BASE = 'https://api.nasa.gov/neo/rest/v1/feed';

/** Convert km string to number */
const km = s => parseFloat(s ?? 0);

/** Parse a single NEO object from NeoWs into a flat, usable record. */
function parseNeo(neo) {
    const approach = (neo.close_approach_data ?? [])[0] ?? {};
    const diam     = neo.estimated_diameter?.kilometers ?? {};
    return {
        id:              neo.id,
        name:            neo.name,
        /** Diameter range in km */
        diam_min_km:     diam.estimated_diameter_min  ?? null,
        diam_max_km:     diam.estimated_diameter_max  ?? null,
        diam_mid_km:     ((diam.estimated_diameter_min ?? 0) + (diam.estimated_diameter_max ?? 0)) / 2,
        hazardous:       neo.is_potentially_hazardous_asteroid ?? false,
        close_date:      approach.close_approach_date ?? null,
        /** Miss distance — how close it comes to Earth */
        miss_km:         km(approach.miss_distance?.kilometers),
        miss_lunar:      km(approach.miss_distance?.lunar),       // lunar distances (1 LD ≈ 384 400 km)
        miss_au:         km(approach.miss_distance?.astronomical),
        /** Relative velocity at closest approach */
        velocity_kms:    km(approach.relative_velocity?.kilometers_per_second),
        /** Direct link to JPL SSD small-body database */
        jpl_url:         neo.links?.self ?? null,
    };
}

export class NeoFeed {
    /**
     * @param {object} opts
     * @param {string} opts.apiKey      NASA API key (default: 'DEMO_KEY')
     * @param {number} opts.windowDays  Look-ahead window in days (1–7, NeoWs max)
     * @param {number} opts.pollInterval ms between polls (default 6 hours)
     */
    constructor({
        apiKey       = 'DEMO_KEY',
        windowDays   = 7,
        pollInterval = 6 * 60 * 60 * 1000,
    } = {}) {
        this.apiKey       = apiKey;
        this.windowDays   = Math.min(7, Math.max(1, windowDays));
        this.pollInterval = pollInterval;
        this._timer       = null;
        this.status       = 'connecting';
        this.lastUpdated  = null;
        this.failStreak   = 0;
        this._raw         = { neos_by_date: {}, element_count: 0 };
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
        const start = dateOffset(0);
        const end   = dateOffset(this.windowDays);
        const url   = `${NEOWS_BASE}?start_date=${start}&end_date=${end}&api_key=${this.apiKey}`;

        try {
            const data = await fetchJSON(url);
            // Flatten all NEOs across dates into per-date arrays of parsed records
            const byDate = {};
            for (const [date, neos] of Object.entries(data.near_earth_objects ?? {})) {
                byDate[date] = neos.map(parseNeo).sort((a, b) => a.miss_km - b.miss_km);
            }
            this._raw.neos_by_date   = byDate;
            this._raw.element_count  = data.element_count ?? 0;
            this.status              = 'live';
            this.lastUpdated         = new Date();
            this.failStreak          = 0;
        } catch (err) {
            this.failStreak++;
            this.status = this.failStreak > 2 ? 'offline' : 'stale';
            console.debug(`[NeoFeed] ${err.message}`);
        }

        window.dispatchEvent(new CustomEvent('neo-update', { detail: this._buildState() }));
    }

    _buildState() {
        const byDate = this._raw.neos_by_date;

        // All NEOs flattened, closest first
        const all = Object.values(byDate).flat().sort((a, b) => a.miss_km - b.miss_km);

        return {
            /** { 'YYYY-MM-DD': [ ...parsedNeos sorted by miss distance ] } */
            neos_by_date:  byDate,
            /** Number of NEOs in the window */
            element_count: this._raw.element_count,
            /** Potentially Hazardous Asteroids only (PHAs), sorted closest first */
            hazardous:     all.filter(n => n.hazardous),
            /** All NEOs sorted closest to Earth, top 20 */
            closest:       all.slice(0, 20),
            status:        this.status,
            lastUpdated:   this.lastUpdated,
        };
    }
}


// ══════════════════════════════════════════════════════════════════════════════
// 4.  Convenience — start all three feeds at once
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Start all three feeds with a single call.
 *
 * @param {object} opts
 * @param {string} opts.nasaApiKey       For NeoFeed (default: 'DEMO_KEY')
 * @param {number} opts.neoWindowDays    Look-ahead days for NEO window (default: 7)
 * @param {object} opts.horizonsBodies   Override HORIZONS_BODIES if desired
 * @returns {{ soho: SohoFeed, horizons: HorizonsFeed, neo: NeoFeed }}
 */
export function startExtendedFeeds({
    nasaApiKey     = 'DEMO_KEY',
    neoWindowDays  = 7,
    horizonsBodies = HORIZONS_BODIES,
} = {}) {
    const soho     = new SohoFeed().start();
    const horizons = new HorizonsFeed({ bodies: horizonsBodies }).start();
    const neo      = new NeoFeed({ apiKey: nasaApiKey, windowDays: neoWindowDays }).start();
    return { soho, horizons, neo };
}

export default { SohoFeed, HorizonsFeed, NeoFeed, startExtendedFeeds, SOHO_IMAGES, STEREO_IMAGES, HORIZONS_BODIES };

/* ── FULL INTEGRATION EXAMPLE ───────────────────────────────────────────────
 *
 *  import { startExtendedFeeds }   from './js/extended-feeds.js';
 *  import { SpaceWeatherFeed }      from './js/swpc-feed.js';
 *  import { NasaFeed }              from './js/nasa-feed.js';
 *
 *  // Start all live feeds
 *  const { soho, horizons, neo } = startExtendedFeeds({ nasaApiKey: 'YOUR_KEY' });
 *  const noaa = new SpaceWeatherFeed().start();
 *  const donki = new NasaFeed({ apiKey: 'YOUR_KEY' }).start();
 *
 *  // SOHO/SDO — use image URLs directly in textures or <img> tags
 *  window.addEventListener('soho-update', e => {
 *      solarTexture.src = e.detail.images.sdo_aia193;   // green corona
 *      coronaImg.src    = e.detail.images.lasco_c3;     // outer corona / CMEs
 *      stereoImg.src    = e.detail.stereo_images.euvi195;
 *  });
 *
 *  // Planetary positions — drive orbital mechanics with real ephemeris
 *  window.addEventListener('horizons-update', e => {
 *      const { mars, jupiter, stereo_a } = e.detail.bodies;
 *      // mars.x, mars.y, mars.z  → heliocentric AU (ecliptic J2000)
 *      // mars.r                  → distance from Sun in AU
 *      // mars.lon_deg            → ecliptic longitude
 *      updatePlanetMesh('mars',    mars);
 *      updatePlanetMesh('jupiter', jupiter);
 *      updateSTEREO(stereo_a);  // show STEREO-A's current vantage point
 *  });
 *
 *  // Near-Earth asteroids — show close approaches as sim objects
 *  window.addEventListener('neo-update', e => {
 *      const { hazardous, closest, element_count } = e.detail;
 *      console.log(`${element_count} NEOs tracked, ${hazardous.length} hazardous`);
 *      closest.slice(0, 5).forEach(neo => {
 *          console.log(`${neo.name}: ${(neo.miss_lunar).toFixed(1)} LD away, `
 *                    + `${neo.velocity_kms.toFixed(1)} km/s, `
 *                    + `~${neo.diam_mid_km.toFixed(2)} km diameter`);
 *          spawnAsteroidAt(neo);
 *      });
 *  });
 *
 *  // NOAA space weather
 *  window.addEventListener('swpc-update', e => {
 *      const { solar_wind, kp, xray_class, aurora_activity } = e.detail;
 *      updateSolarWindShader(solar_wind.speed, solar_wind.bz);
 *  });
 *
 *  // NASA DONKI — CME propagation trigger
 *  window.addEventListener('nasa-update', e => {
 *      if (e.detail.latest_cme?.speed > 1500) triggerCMEAnimation(e.detail.latest_cme);
 *  });
 *
 * ─────────────────────────────────────────────────────────────────────────── */
