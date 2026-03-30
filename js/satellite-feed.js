/**
 * satellite-feed.js — Real-time cloud imagery from NASA GIBS & GOES
 *
 * Fetches global cloud imagery from two sources:
 *
 *   GOES-East FullDisk (NOAA/NASA GIBS)
 *     ~10-minute cadence, covers Americas + W Europe/Africa
 *     Band 02 (0.64 μm visible) — white cloud tops, clear surface shows through
 *
 *   MODIS Terra Cloud Fraction (NASA GIBS, daily composite)
 *     Global coverage, ~1-day latency.  Grayscale: 0 = clear, 1 = fully cloudy.
 *     Used as fallback or composited with GOES.
 *
 * Both are loaded as THREE.Texture objects via TextureLoader (CORS-enabled by NASA).
 *
 * Fires: CustomEvent 'satellite-update' on window
 *   detail: {
 *     goesTex:  THREE.Texture | null,   GOES-East latest (or null if unavailable)
 *     modisTex: THREE.Texture | null,   MODIS daily cloud fraction
 *     source:   string,                 human-readable source description
 *     time:     Date,                   image timestamp
 *   }
 */

import * as THREE from 'three';

// NASA GIBS snapshot endpoint (CORS-enabled, no API key required)
const GIBS_SNAPSHOT = 'https://wvs.earthdata.nasa.gov/api/v1/snapshot';

// Full equirectangular extent
const GLOBAL_BBOX = '-90,-180,90,180';
const CRS         = 'EPSG:4326';

// Texture resolution for cloud imagery.
// 2048×1024 gives ~0.18°/px — much better than the 360×180 weather texture.
const SAT_W = 2048;
const SAT_H = 1024;

// Update intervals
const GOES_POLL_MS  = 10 * 60_000;   // GOES updates every ~10 min
const MODIS_POLL_MS = 60 * 60_000;   // MODIS is daily; re-check hourly for new composites

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Round a Date down to the nearest N-minute interval. */
function floorMinutes(date, n) {
    const ms = n * 60_000;
    return new Date(Math.floor(date.getTime() / ms) * ms);
}

/** Format a Date as ISO string for GIBS TIME parameter. */
function isoTime(date) {
    return date.toISOString().replace(/\.\d+Z$/, 'Z');
}

/** Load a URL as a THREE.Texture with CORS enabled. Resolves null on error. */
function loadTexture(url) {
    return new Promise(resolve => {
        const loader = new THREE.TextureLoader();
        loader.setCrossOrigin('anonymous');
        loader.load(
            url,
            tex => {
                tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
                tex.minFilter = THREE.LinearFilter;
                tex.magFilter = THREE.LinearFilter;
                tex.needsUpdate = true;
                resolve(tex);
            },
            undefined,
            () => resolve(null),   // silently return null on error
        );
    });
}

/** Build a GIBS snapshot URL for a given layer and time. */
function gibsUrl(layer, time) {
    const params = new URLSearchParams({
        REQUEST: 'GetSnapshot',
        TIME:    isoTime(time),
        BBOX:    GLOBAL_BBOX,
        CRS,
        LAYERS:  layer,
        FORMAT:  'image/jpeg',
        WIDTH:   SAT_W,
        HEIGHT:  SAT_H,
    });
    return `${GIBS_SNAPSHOT}?${params}`;
}

// ── SatelliteFeed ─────────────────────────────────────────────────────────────

export class SatelliteFeed {
    constructor() {
        this._goesTimer  = null;
        this._modisTimer = null;
        this._goesTex    = null;
        this._modisTex   = null;
        this._goesTime   = null;
        this._modisDate  = null;
    }

    start() {
        // Fetch immediately, then on interval
        this._fetchGOES();
        this._fetchMODIS();
        this._goesTimer  = setInterval(() => this._fetchGOES(),  GOES_POLL_MS);
        this._modisTimer = setInterval(() => this._fetchMODIS(), MODIS_POLL_MS);
        return this;
    }

    stop() {
        clearInterval(this._goesTimer);
        clearInterval(this._modisTimer);
    }

    get goesTex()  { return this._goesTex;  }
    get modisTex() { return this._modisTex; }

    // ── GOES-East full-disk visible (Band 02) ──────────────────────────────────
    async _fetchGOES() {
        // GOES images lag ~5 minutes from observation time.
        // Round down to nearest 10-min slot and subtract 10 min to ensure availability.
        const t = floorMinutes(new Date(Date.now() - 10 * 60_000), 10);

        const url = gibsUrl('GOES_East_FullDisk_Band02', t);
        const tex = await loadTexture(url);

        if (tex) {
            if (this._goesTex) this._goesTex.dispose();
            this._goesTex  = tex;
            this._goesTime = t;
            console.info(`[SatelliteFeed] GOES-East loaded: ${isoTime(t)}`);
            this._dispatch();
        } else {
            console.debug('[SatelliteFeed] GOES fetch failed — retaining previous');
        }
    }

    // ── MODIS Terra Cloud Fraction (daily composite) ───────────────────────────
    async _fetchMODIS() {
        // MODIS daily composites are available with ~24-hr latency.
        // Use yesterday's date to ensure the product exists.
        const yesterday = new Date(Date.now() - 86_400_000);
        const dateStr   = yesterday.toISOString().split('T')[0];

        // Only reload if date changed (once per day is sufficient)
        if (this._modisDate === dateStr && this._modisTex) return;

        const url = gibsUrl('MODIS_Terra_Cloud_Fraction_Day', new Date(`${dateStr}T00:00:00Z`));
        const tex = await loadTexture(url);

        if (tex) {
            if (this._modisTex) this._modisTex.dispose();
            this._modisTex  = tex;
            this._modisDate = dateStr;
            console.info(`[SatelliteFeed] MODIS cloud fraction loaded: ${dateStr}`);
            this._dispatch();
        } else {
            // Try Aqua as backup
            const urlAqua = gibsUrl('MODIS_Aqua_Cloud_Fraction_Day', new Date(`${dateStr}T00:00:00Z`));
            const texAqua = await loadTexture(urlAqua);
            if (texAqua) {
                if (this._modisTex) this._modisTex.dispose();
                this._modisTex  = texAqua;
                this._modisDate = dateStr;
                console.info(`[SatelliteFeed] MODIS Aqua fallback loaded: ${dateStr}`);
                this._dispatch();
            } else {
                console.debug('[SatelliteFeed] MODIS fetch failed — retaining previous');
            }
        }
    }

    _dispatch() {
        const tex   = this._goesTex  ?? this._modisTex;
        const from  = this._goesTex  ? 'GOES-East GIBS' : 'MODIS Terra GIBS';
        const time  = this._goesTime ?? (this._modisDate ? new Date(this._modisDate) : new Date());

        window.dispatchEvent(new CustomEvent('satellite-update', {
            detail: {
                goesTex:  this._goesTex,
                modisTex: this._modisTex,
                primaryTex: tex,    // whichever is most recent
                source: from,
                time,
            },
        }));
    }
}
