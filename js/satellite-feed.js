/**
 * satellite-feed.js — Real-time cloud imagery from NASA GIBS & GOES
 *
 * Fetches global cloud imagery from two sources and composites them:
 *
 *   GOES-East FullDisk (NOAA/NASA GIBS)
 *     ~10-minute cadence, covers Americas + W Europe/Africa
 *     Band 02 (0.64 μm visible) — white cloud tops, clear surface shows through
 *     Coverage: roughly lon -135° to -15° (geostationary at ~75°W)
 *
 *   MODIS Terra Cloud Fraction (NASA GIBS, daily composite)
 *     Global coverage, ~1-day latency.  Grayscale: 0 = clear, 1 = fully cloudy.
 *     Used as global baseline; GOES overlaid where it has valid data.
 *
 * Compositing strategy:
 *   GOES-East only covers ~1/3 of the globe.  Outside its footprint the
 *   equirectangular image is black (pixel ≈ 0).  Naively feeding that to the
 *   cloud shader treats "no data" as "clear sky", creating visible strips.
 *
 *   When both sources are available we composite on a canvas:
 *     - Start with MODIS as the global baseline
 *     - Overlay GOES pixels where brightness > threshold (valid data)
 *     - Feather the GOES coverage edge to avoid a hard seam
 *
 * Fires: CustomEvent 'satellite-update' on window
 *   detail: {
 *     goesTex:      THREE.Texture | null,
 *     modisTex:     THREE.Texture | null,
 *     compositeTex: THREE.Texture | null,   composited global cloud texture
 *     source:       string,
 *     time:         Date,
 *     goesTime:     Date | null,
 *     modisDate:    string | null,
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

// GOES-East coverage: approximate longitude bounds in UV space [0,1]
// GOES-East sits at ~75°W, full disk spans roughly -135° to -15° lon
// In UV: u = (lon + 180) / 360
const GOES_UV_LEFT  = (-135 + 180) / 360;   // 0.125
const GOES_UV_RIGHT = ( -15 + 180) / 360;   // 0.458
const GOES_FEATHER  = 0.03;                  // UV width of blend feather at edges

// Brightness threshold: GOES pixels below this are "no data" (black background)
const GOES_DATA_THRESH = 12;   // out of 255 — very dim pixels are background

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

/** Load a URL as an Image (for canvas compositing). Resolves null on error. */
function loadImage(url) {
    return new Promise(resolve => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload  = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = url;
    });
}

/** Load a URL as a THREE.Texture with CORS enabled. Resolves null on error. */
function loadTexture(url) {
    return new Promise(resolve => {
        const loader = new THREE.TextureLoader();
        loader.setCrossOrigin('anonymous');
        loader.load(
            url,
            tex => {
                tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
                tex.minFilter = THREE.LinearFilter;
                tex.magFilter = THREE.LinearFilter;
                tex.needsUpdate = true;
                resolve(tex);
            },
            undefined,
            () => resolve(null),
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
        this._goesTimer    = null;
        this._modisTimer   = null;
        this._goesTex      = null;
        this._modisTex     = null;
        this._goesImg      = null;    // raw Image for compositing
        this._modisImg     = null;    // raw Image for compositing
        this._compositeTex = null;
        this._goesTime     = null;
        this._modisDate    = null;

        // Off-screen canvas for compositing
        this._canvas = null;
        this._ctx    = null;
    }

    start() {
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

    get goesTex()      { return this._goesTex; }
    get modisTex()     { return this._modisTex; }
    get compositeTex() { return this._compositeTex; }

    // ── GOES-East full-disk visible (Band 02) ──────────────────────────────────
    async _fetchGOES() {
        const t = floorMinutes(new Date(Date.now() - 10 * 60_000), 10);
        const url = gibsUrl('GOES_East_FullDisk_Band02', t);

        // Load both as Image (for compositing) and Texture (for standalone use)
        const [img, tex] = await Promise.all([loadImage(url), loadTexture(url)]);

        if (tex && img) {
            if (this._goesTex) this._goesTex.dispose();
            this._goesTex  = tex;
            this._goesImg  = img;
            this._goesTime = t;
            console.info(`[SatelliteFeed] GOES-East loaded: ${isoTime(t)}`);
            this._composite();
            this._dispatch();
        } else {
            console.debug('[SatelliteFeed] GOES fetch failed — retaining previous');
        }
    }

    // ── Global cloud imagery (VIIRS → MODIS Terra → MODIS Aqua fallback chain) ──
    // VIIRS has wider swath than MODIS → fewer orbital gaps → less visible strips.
    // Falls back through the chain until one succeeds.
    async _fetchMODIS() {
        const yesterday = new Date(Date.now() - 86_400_000);
        const dateStr   = yesterday.toISOString().split('T')[0];

        if (this._modisDate === dateStr && this._modisTex) return;

        // Fallback chain: VIIRS (widest swath, fewest gaps) → MODIS Terra → MODIS Aqua
        const layers = [
            'VIIRS_SNPP_CorrectedReflectance_TrueColor',
            'MODIS_Terra_CorrectedReflectance_TrueColor',
            'MODIS_Aqua_CorrectedReflectance_TrueColor',
        ];

        for (const layer of layers) {
            try {
                const url = gibsUrl(layer, new Date(`${dateStr}T00:00:00Z`));
                const [img, tex] = await Promise.all([loadImage(url), loadTexture(url)]);
                if (tex && img) {
                    if (this._modisTex) this._modisTex.dispose();
                    this._modisTex  = tex;
                    this._modisImg  = img;
                    this._modisDate = dateStr;
                    console.info(`[SatelliteFeed] ${layer.split('_')[0]} loaded: ${dateStr}`);
                    this._composite();
                    this._dispatch();
                    return;  // success — stop trying
                }
            } catch { /* try next layer */ }
        }
        console.debug('[SatelliteFeed] All cloud sources failed — retaining previous');
    }

    // ── Composite GOES + MODIS into a single global texture ───────────────────
    _composite() {
        // Lazy-create off-screen canvas
        if (!this._canvas) {
            this._canvas = document.createElement('canvas');
            this._canvas.width  = SAT_W;
            this._canvas.height = SAT_H;
            this._ctx = this._canvas.getContext('2d', { willReadFrequently: true });
        }

        const ctx = this._ctx;
        ctx.clearRect(0, 0, SAT_W, SAT_H);

        // If only one source available, use it directly
        if (this._modisImg && !this._goesImg) {
            ctx.drawImage(this._modisImg, 0, 0, SAT_W, SAT_H);
        } else if (this._goesImg && !this._modisImg) {
            // GOES-only: still better than nothing, but won't fix the strip issue
            ctx.drawImage(this._goesImg, 0, 0, SAT_W, SAT_H);
        } else if (this._goesImg && this._modisImg) {
            // Both available: MODIS as global base, GOES overlaid with feathered mask
            ctx.drawImage(this._modisImg, 0, 0, SAT_W, SAT_H);

            // Read MODIS base pixels
            const baseData = ctx.getImageData(0, 0, SAT_W, SAT_H);

            // Draw GOES on top (temporarily)
            ctx.drawImage(this._goesImg, 0, 0, SAT_W, SAT_H);
            const goesData = ctx.getImageData(0, 0, SAT_W, SAT_H);

            // Composite: per-pixel blend
            const out = baseData;  // we'll write result into baseData
            for (let y = 0; y < SAT_H; y++) {
                for (let x = 0; x < SAT_W; x++) {
                    const i = (y * SAT_W + x) * 4;

                    const gR = goesData.data[i];
                    const gG = goesData.data[i + 1];
                    const gB = goesData.data[i + 2];
                    const gBright = (gR + gG + gB) / 3;

                    // Compute GOES coverage weight based on UV position + brightness
                    const u = x / SAT_W;

                    // Longitude feather: 1.0 inside GOES footprint, fades to 0 at edges
                    let lonWeight = 1.0;
                    if (u < GOES_UV_LEFT + GOES_FEATHER) {
                        lonWeight = Math.max(0, (u - GOES_UV_LEFT) / GOES_FEATHER);
                    } else if (u > GOES_UV_RIGHT - GOES_FEATHER) {
                        lonWeight = Math.max(0, (GOES_UV_RIGHT - u) / GOES_FEATHER);
                    } else if (u < GOES_UV_LEFT || u > GOES_UV_RIGHT) {
                        lonWeight = 0;
                    }

                    // Latitude feather: GOES loses quality near poles (limb distortion)
                    const v = y / SAT_H;  // 0=top(N), 1=bottom(S)
                    const latAbs = Math.abs(v - 0.5) * 2;  // 0 at equator, 1 at poles
                    const latWeight = 1.0 - Math.pow(Math.max(0, (latAbs - 0.65) / 0.25), 2);

                    // Data presence: above brightness threshold = valid GOES data
                    const dataWeight = gBright > GOES_DATA_THRESH ? 1.0 : 0.0;

                    // Final GOES blend weight
                    const w = Math.max(0, Math.min(1,
                        lonWeight * Math.max(0, latWeight) * dataWeight
                    ));

                    if (w > 0) {
                        // Blend: GOES where valid, MODIS elsewhere
                        out.data[i]     = Math.round(out.data[i]     * (1 - w) + gR * w);
                        out.data[i + 1] = Math.round(out.data[i + 1] * (1 - w) + gG * w);
                        out.data[i + 2] = Math.round(out.data[i + 2] * (1 - w) + gB * w);
                    }
                    // else: keep MODIS base pixel as-is
                }
            }

            ctx.putImageData(out, 0, 0);
        } else {
            return;  // nothing to composite
        }

        // Create THREE.Texture from the composited canvas
        if (this._compositeTex) this._compositeTex.dispose();
        const tex = new THREE.CanvasTexture(this._canvas);
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.needsUpdate = true;
        this._compositeTex = tex;
    }

    _dispatch() {
        const hasBoth = !!(this._goesImg && this._modisImg);
        const source  = hasBoth ? 'GOES-East + MODIS composite'
                      : this._goesTex  ? 'GOES-East GIBS'
                      : 'MODIS Terra GIBS';
        const time    = this._goesTime ?? (this._modisDate ? new Date(this._modisDate) : new Date());

        window.dispatchEvent(new CustomEvent('satellite-update', {
            detail: {
                goesTex:      this._goesTex,
                modisTex:     this._modisTex,
                compositeTex: this._compositeTex,
                source,
                time,
                goesTime:  this._goesTime,
                modisDate: this._modisDate,
            },
        }));
    }
}
