/**
 * hek-feed.js — HEK coronal-hole catalog client
 * ═════════════════════════════════════════════════════════════════════════
 *
 * Polls /api/hek/coronal-holes (HEK proxy) on a 30-minute cadence and emits
 * a `hek-update` event with the latest detections.  The corona shader's
 * `setRealHoles` consumer applies Carrington rotation when rendering, so
 * holes track the live SDO 193 Å view as solar time advances.
 *
 * STATE EVENT
 * ─────────────────────────────────────────────────────────────────────────
 *   'hek-update'   detail = { holes: [{ lat_deg, lon_carrington_deg, ... }],
 *                              source, updated }
 *
 * USAGE
 * ─────────────────────────────────────────────────────────────────────────
 *   import { HekFeed } from './js/hek-feed.js';
 *   new HekFeed().start();
 *   window.addEventListener('hek-update', e => {
 *       _globe.setRealHoles(e.detail.holes);
 *   });
 *
 * Falls back gracefully — on network error the existing synthetic holes
 * remain, and the next refresh cycle retries.
 */

const ENDPOINT          = '/api/hek/coronal-holes';
const REFRESH_MS_OK     = 30 * 60 * 1000;     // 30 min on success
const REFRESH_MS_ERROR  = 5  * 60 * 1000;     //  5 min on transient error

export class HekFeed {
    constructor(opts = {}) {
        this._endpoint = opts.endpoint ?? ENDPOINT;
        this._timer    = null;
        this._lastOk   = 0;
        this._lastHoles = [];
    }

    start() {
        this._fetchOnce();
        return this;
    }

    stop() {
        if (this._timer) clearTimeout(this._timer);
        this._timer = null;
    }

    /** Last received hole list (read-only). */
    get holes() { return this._lastHoles.slice(); }

    /** Force an immediate refetch (e.g. after a long-tab-suspend). */
    refresh() { this._fetchOnce(); }

    async _fetchOnce() {
        if (this._timer) clearTimeout(this._timer);
        let okMs = REFRESH_MS_ERROR;
        try {
            const res = await fetch(this._endpoint, {
                headers: { Accept: 'application/json' },
                cache:   'no-store',
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const json  = await res.json();
            const data  = json?.data ?? json;
            const holes = Array.isArray(data?.holes) ? data.holes : [];
            this._lastHoles = holes;
            this._lastOk    = Date.now();
            okMs = REFRESH_MS_OK;
            window.dispatchEvent(new CustomEvent('hek-update', {
                detail: {
                    holes,
                    source:  json?.source ?? 'HEK',
                    updated: data?.updated ?? new Date().toISOString(),
                },
            }));
        } catch (e) {
            // Stay quiet — synthetic holes remain in place.  Log once for
            // diagnostics; downstream consumers can listen for a separate
            // 'hek-error' if they want to surface a banner.
            console.warn('[hek-feed]', e?.message ?? e);
            window.dispatchEvent(new CustomEvent('hek-error', {
                detail: { message: String(e?.message ?? e) },
            }));
        }
        // Schedule the next refresh (success → 30 min, error → 5 min retry)
        this._timer = setTimeout(() => this._fetchOnce(), okMs);
    }
}
