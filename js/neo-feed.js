/**
 * neo-feed.js — NASA NeoWs near-Earth object close-approach feed
 *
 * Polls the NASA NeoWs API for near-Earth object close approaches over a
 * configurable window (default: next 7 days).  Requires a free NASA API key.
 * Poll default: 6 hours (NeoWs data is updated daily).
 *
 * API KEY
 * ─────────────────────────────────────────────────────────────────────────────
 *  Free NASA key from https://api.nasa.gov/
 *  Use 'DEMO_KEY' for development (30 req/hr, 50 req/day).
 *  Each NeoFeed poll uses 1 request.
 *
 * STATE EVENT
 * ─────────────────────────────────────────────────────────────────────────────
 *  'neo-update'  { neos_by_date, hazardous, closest, element_count,
 *                  status, lastUpdated }
 *
 * USAGE
 * ─────────────────────────────────────────────────────────────────────────────
 *  import { NeoFeed } from './js/neo-feed.js';
 *
 *  new NeoFeed({ apiKey: 'YOUR_KEY' }).start();
 *  window.addEventListener('neo-update', e => {
 *      console.log(`${e.detail.element_count} NEOs in window`);
 *      e.detail.hazardous.forEach(neo => console.log(neo.name, neo.miss_km, 'km'));
 *  });
 *
 * HOW TO ADD MORE NEO FILTERS
 * ─────────────────────────────────────────────────────────────────────────────
 *  NeoFeed returns the raw NeoWs near_earth_objects object as-is plus a
 *  pre-filtered `hazardous` array and a `closest` array sorted by miss distance.
 *  Add your own filters inside _buildState() or post-process the 'neo-update' event.
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

// ── Export ────────────────────────────────────────────────────────────────────

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

export default NeoFeed;
