/**
 * satellite-feed.js — Real-time global cloud imagery (GIBS mosaic)
 *
 * Polling wrapper around js/cloud-imagery.js. The mosaic compositor stitches
 * four geostationary satellites (GOES-East, GOES-West, Himawari, Meteosat)
 * with MODIS Cloud_Optical_Thickness as polar fill, all reprojected by GIBS
 * to equirectangular and merged on a single canvas with alpha-encoded no-
 * data masking.
 *
 * Why this replaced the legacy implementation:
 *   - The legacy feed pulled GOES-East alone over MODIS, which left visible
 *     west-Pacific / Indian-Ocean strips on the globe whenever GOES couldn't
 *     see those regions (always — they're outside its disc).
 *   - The mosaic gives full inter-tropical coverage at ~10-min cadence; the
 *     polar caps are honestly marked alpha = 0 so the cloud shader paints
 *     either procedural / data-driven cover (default) or a hatched no-data
 *     overlay (research mode) instead of synthesising plausible cloud.
 *
 * Event API (unchanged for back-compat with earth.html):
 *   window dispatches 'satellite-update' with detail {
 *     compositeTex: THREE.Texture,    // the mosaic
 *     goesTex:      null,             // legacy fields kept for the
 *     modisTex:     null,             //   shape-stable consumer at
 *     source:       string,           // earth.html:3356
 *     time:         Date,
 *     goesTime:     Date | null,      // mosaic acquisition time
 *     modisDate:    string | null,    // YYYY-MM-DD of polar fill
 *     mosaic:       boolean,          // new: false = MODIS fallback
 *     regions:      string[],         // new: ['GOES-East','Himawari',...]
 *     layers:       string[],         // new: full GIBS layer IDs used
 *   }
 */

import * as THREE from 'three';
import { fetchCloudImagery } from './cloud-imagery.js';

// Refresh cadence — GOES, Himawari and Meteosat all publish ~10-min frames,
// so polling more often wastes bytes; less often risks stale clouds during
// fast-evolving weather. Matches the legacy 10-min GOES poll.
const REFRESH_MS = 10 * 60_000;
// Snapshot resolution. 2048×1024 ≈ 0.18°/px equirectangular — resolves
// hurricane bands and cold fronts without exceeding the GIBS server-side
// reprojection limits.
const SAT_W = 2048;

export class SatelliteFeed {
    constructor() {
        this._timer        = null;
        this._compositeTex = null;
        this._lastHit      = null;   // metadata from the most recent fetch
    }

    start() {
        this._refresh();
        this._timer = setInterval(() => this._refresh(), REFRESH_MS);
        return this;
    }

    stop() {
        clearInterval(this._timer);
        this._timer = null;
    }

    // Read-accessors retained for any external probe that pre-dates this
    // refactor. compositeTex is the only one that's actually populated now.
    get goesTex()      { return null; }
    get modisTex()     { return null; }
    get compositeTex() { return this._compositeTex; }

    async _refresh() {
        // fetchCloudImagery handles the date/layer fallback chain internally
        // and returns null only when EVERY source fails. On null we keep the
        // previous texture (if any) — stale beats a black globe.
        const hit = await fetchCloudImagery(THREE, { width: SAT_W });
        if (!hit) {
            console.debug('[SatelliteFeed] mosaic + MODIS fallback both failed; retaining previous');
            return;
        }

        // Replace texture. Dispose the old one so we don't leak GPU memory
        // across long-running pages (research dashboards, kiosk displays).
        if (this._compositeTex) this._compositeTex.dispose();
        this._compositeTex = hit.texture;
        this._lastHit      = hit;

        const label = hit.mosaic
            ? `mosaic · ${hit.regions.join('+')}${hit.polar ? '+polar' : ''}`
            : `MODIS · ${hit.layers[0]?.replace(/^MODIS=/, '') ?? 'fallback'}`;
        console.info(`[SatelliteFeed] cloud texture refreshed — ${label} ${hit.date}`);

        this._dispatch();
    }

    _dispatch() {
        const hit = this._lastHit;
        if (!hit) return;
        const source = hit.mosaic
            ? `Mosaic: ${hit.regions.join(' + ')}${hit.polar ? ' + polar' : ''}`
            : 'MODIS Terra GIBS';
        // ISO date → real Date for downstream "minutes ago" formatters.
        const time = hit.date ? new Date(`${hit.date}T00:00:00Z`) : new Date();

        window.dispatchEvent(new CustomEvent('satellite-update', {
            detail: {
                compositeTex: this._compositeTex,
                goesTex:      null,
                modisTex:     null,
                source,
                time,
                goesTime:     hit.mosaic ? time : null,
                modisDate:    hit.polar  || !hit.mosaic ? hit.date : null,
                mosaic:       hit.mosaic,
                regions:      hit.regions,
                layers:       hit.layers,
            },
        }));
    }
}
