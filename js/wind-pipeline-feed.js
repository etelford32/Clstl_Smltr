/**
 * wind-pipeline-feed.js — Parker Physics live wind speed pipeline client
 * ========================================================================
 * Polls the local FastAPI results server (/v1/solar-wind/wind-speed) and
 * dispatches a 'wind-pipeline-update' CustomEvent on window each time fresh
 * data arrives.  Designed to complement swpc-feed.js — the pipeline feed
 * provides alert classification and trend direction derived from 24-hour
 * rolling history, whereas swpc-feed.js hits NOAA endpoints directly.
 *
 * USAGE
 * ─────
 *   import WindPipelineFeed from './js/wind-pipeline-feed.js';
 *   new WindPipelineFeed().start();
 *   window.addEventListener('wind-pipeline-update', e => console.log(e.detail));
 *
 * EVENT DETAIL  (wind-pipeline-update)
 * ─────────────────────────────────────
 *   status        'live' | 'stale' | 'offline'
 *   speed_km_s    float   e.g. 487.3
 *   speed_norm    float   0–1
 *   density_cc    float   protons/cm³
 *   bz_nT         float   IMF Bz in nT (negative = southward)
 *   alert_level   string  'QUIET' | 'MODERATE' | 'HIGH' | 'EXTREME'
 *   trend         object  { slope_km_s_per_min: float, direction: 'RISING'|'STEADY'|'FALLING' }
 *   series_count  int     number of data points in rolling window
 *   age_min       float   minutes since last ingest
 *   freshness     string  'fresh' | 'stale' | 'expired' | 'missing'
 *   updated       string  ISO timestamp of last reading
 */

// Default API base — empty string uses same origin (works with uvicorn on localhost:8000).
const DEFAULT_API_BASE = '';
const ENDPOINT         = '/v1/solar-wind/wind-speed';
const DEFAULT_INTERVAL = 60_000;   // 60 seconds — matches ingest_l1 cadence

export class WindPipelineFeed {
    /**
     * @param {object} opts
     * @param {string} [opts.apiBase]       Base URL, e.g. 'http://localhost:8000'
     * @param {number} [opts.pollInterval]  Milliseconds between polls (default 60 000)
     */
    constructor({ apiBase = DEFAULT_API_BASE, pollInterval = DEFAULT_INTERVAL } = {}) {
        this.apiBase      = apiBase;
        this.pollInterval = pollInterval;
        this._timer       = null;
        this._failStreak  = 0;
    }

    /** Start polling immediately and on the configured interval. */
    start() {
        this._poll();
        this._timer = setInterval(() => this._poll(), this.pollInterval);
        return this;
    }

    /** Stop polling. */
    stop() {
        clearInterval(this._timer);
        this._timer = null;
    }

    /** Trigger an out-of-band refresh. */
    refresh() { return this._poll(); }

    // ── Internal ────────────────────────────────────────────────────────────

    async _poll() {
        const url = `${this.apiBase}${ENDPOINT}`;
        try {
            const res = await fetch(url, { cache: 'no-cache' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const json = await res.json();
            this._failStreak = 0;
            this._dispatch(json);
        } catch (err) {
            this._failStreak++;
            console.debug('[wind-pipeline] poll failed:', err.message);
            this._dispatchOffline(err.message);
        }
    }

    _dispatch(json) {
        const curr = json?.data?.current ?? {};
        const trend = json?.data?.trend  ?? { slope_km_s_per_min: 0, direction: 'STEADY' };

        window.dispatchEvent(new CustomEvent('wind-pipeline-update', {
            detail: {
                status:       json.freshness === 'expired' ? 'stale' : 'live',
                speed_km_s:   curr.speed_km_s   ?? null,
                speed_norm:   curr.speed_norm   ?? null,
                density_cc:   curr.density_cc   ?? null,
                bz_nT:        curr.bz_nT        ?? null,
                alert_level:  curr.alert_level  ?? 'QUIET',
                trend,
                series_count: (json?.data?.series ?? []).length,
                age_min:      json.age_min      ?? null,
                freshness:    json.freshness    ?? 'missing',
                updated:      json?.data?.updated ?? null,
            },
        }));
    }

    _dispatchOffline(reason) {
        window.dispatchEvent(new CustomEvent('wind-pipeline-update', {
            detail: {
                status:       this._failStreak > 2 ? 'offline' : 'stale',
                alert_level:  null,
                trend:        null,
                error:        reason,
            },
        }));
    }
}

export default WindPipelineFeed;
