/**
 * satellite-feed.js — Real-time global cloud imagery (GIBS mosaic)
 *
 * Polling wrapper around js/cloud-imagery.js. The mosaic compositor stitches
 * four geostationary satellites (GOES-East, GOES-West, Himawari, Meteosat)
 * with MODIS Cloud_Optical_Thickness as polar/gap fill. Every product is
 * normalized to cloudiness+confidence BEFORE compositing and disc edges are
 * feathered (see cloud-imagery.js header for the seam post-mortem), so the
 * texture handed to the shader has one physical meaning everywhere.
 *
 * Telemetry: each refresh emits one 'data_pipeline' event (name
 * 'cloud_mosaic') carrying which layers loaded, fallback depth, imagery
 * age, composite coverage, and the widest residual coverage gap. This is
 * the evidence trail for diagnosing seam/staleness reports from the field
 * — the pipeline's failure modes (layer-ID rot, snapshot endpoint changes,
 * regional CDN issues) only manifest in real browsers, not in CI.
 *
 * Event API (unchanged for back-compat with earth.html):
 *   window dispatches 'satellite-update' with detail {
 *     compositeTex: THREE.Texture,    // the mosaic
 *     goesTex:      null,             // legacy fields kept for the
 *     modisTex:     null,             //   shape-stable consumer at
 *     source:       string,           // earth.html
 *     time:         Date,             // acquisition time (real timestamp
 *                                     //   when known, else composite date)
 *     goesTime:     Date | null,      // mosaic acquisition time
 *     modisDate:    string | null,    // YYYY-MM-DD of polar fill
 *     mosaic:       boolean,          // false = MODIS fallback
 *     regions:      string[],         // ['GOES-East','Himawari',...]
 *     layers:       string[],         // full GIBS layer IDs used
 *     diag:         object,           // fetch/composite diagnostics (v2)
 *   }
 */

import * as THREE from 'three';
import { fetchCloudImagery } from './cloud-imagery.js';
import { telemetry } from './telemetry.js';

// Refresh cadence — GOES, Himawari and Meteosat all publish ~10-min frames,
// so polling more often wastes bytes; less often risks stale clouds during
// fast-evolving weather. Matches the legacy 10-min GOES poll.
const REFRESH_MS = 10 * 60_000;
// Snapshot resolution. 2048×1024 ≈ 0.18°/px equirectangular — resolves
// hurricane bands and cold fronts without exceeding the GIBS server-side
// reprojection limits.
const SAT_W = 2048;

/** Squeeze a diag object into a telemetry-safe summary (<4 KB, no URLs). */
function diagToTelemetry(diag, gotTexture) {
    const failures = diag.attempts.filter(a => !a.ok);
    return {
        severity: gotTexture && diag.mode === 'mosaic' ? 'info' : 'warning',
        ok:       gotTexture,
        mode:     diag.mode,
        ms:       diag.ms,
        regions:  diag.regions.map(r =>
            `${r.name}=${r.layer}@${r.ageMin != null ? r.ageMin + 'm' : r.time}`),
        polar:    diag.polar ? `${diag.polar.layer}@${diag.polar.date}` : null,
        attempts: diag.attempts.length,
        failures: failures.length,
        // First few failures name the rotting layer/time directly; the
        // full list stays on window.__cloudDiag for interactive debugging.
        failed:   failures.slice(0, 5).map(a => `${a.region}:${a.layer}@${a.time}`),
        coverage:        diag.composite?.coverage ?? null,
        mean_cloudiness: diag.composite?.meanCloudiness ?? null,
        gap_max_deg:     diag.composite?.gapMaxDeg ?? null,
        gap_center_lon:  diag.composite?.gapCenterLon ?? null,
    };
}

export class SatelliteFeed {
    constructor() {
        this._timer        = null;
        this._compositeTex = null;
        this._lastHit      = null;   // metadata from the most recent fetch
        this.lastDiag      = null;   // full diagnostics, refreshed every poll
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
        // fetchCloudImagery handles the timestamp/layer fallback chain
        // internally and returns null only when EVERY source fails. On null
        // we keep the previous texture (if any) — stale beats a black globe.
        // onDiag fires even on total failure, so the telemetry event and
        // window.__cloudDiag exist precisely when things break.
        let diag = null;
        const hit = await fetchCloudImagery(THREE, {
            width: SAT_W,
            onDiag: d => { diag = d; },
        });

        this.lastDiag = diag;
        if (diag) {
            try {
                telemetry.recordPipeline('cloud_mosaic', diagToTelemetry(diag, !!hit));
            } catch { /* telemetry must never break the feed */ }
            // Fires on EVERY refresh, success or total failure — unlike
            // 'satellite-update', which only fires when there's a texture.
            // earth.html mirrors this onto window.__cloudDiag so a viewer
            // with a broken feed still has the evidence in the console.
            window.dispatchEvent(new CustomEvent('cloud-mosaic-diag', { detail: diag }));
        }

        if (!hit) {
            console.warn('[SatelliteFeed] mosaic + MODIS fallback both failed; retaining previous texture', diag);
            return;
        }

        // Replace texture. Dispose the old one so we don't leak GPU memory
        // across long-running pages (research dashboards, kiosk displays).
        if (this._compositeTex) this._compositeTex.dispose();
        this._compositeTex = hit.texture;
        this._lastHit      = hit;

        const cov   = diag?.composite ? ` cov ${(diag.composite.coverage * 100).toFixed(0)}%` : '';
        const label = hit.mosaic
            ? `mosaic · ${hit.regions.join('+')}${hit.polar ? '+polar' : ''}`
            : `MODIS · ${hit.layers[0]?.replace(/^MODIS=/, '') ?? 'fallback'}`;
        console.info(`[SatelliteFeed] cloud texture refreshed — ${label} ${hit.date}${cov}`);

        this._dispatch();
    }

    _dispatch() {
        const hit = this._lastHit;
        if (!hit) return;
        const source = hit.mosaic
            ? `Mosaic: ${hit.regions.join(' + ')}${hit.polar ? ' + polar' : ''}`
            : 'MODIS Terra GIBS';
        // Real acquisition timestamp when the snapshot carried one; date
        // midnight otherwise (daily composites) — downstream "minutes ago"
        // formatters need a Date either way.
        const time = hit.timestampMs != null
            ? new Date(hit.timestampMs)
            : hit.date ? new Date(`${hit.date}T00:00:00Z`) : new Date();

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
                diag:         hit.diag ?? this.lastDiag,
            },
        }));
    }
}
