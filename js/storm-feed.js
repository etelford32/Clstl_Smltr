/**
 * storm-feed.js — Active tropical cyclone data pipeline
 * ═══════════════════════════════════════════════════════
 * Polls /api/storms (Vercel edge function → NHC CurrentStorms.json) and
 * dispatches a 'storm-update' CustomEvent on window each time data arrives.
 *
 * EVENT DETAIL  (storm-update)
 * ────────────────────────────
 *   status    'live' | 'stale' | 'offline'
 *   storms    Array of storm objects:
 *     id           string   e.g. 'al012025'
 *     name         string   e.g. 'TROPICAL STORM ALPHA'
 *     basin        string   'ATLANTIC' | 'EPAC' | 'CPAC' | 'WPAC' | 'IO' | 'SH'
 *     classification string 'TD'|'TS'|'HU'|'TY'|'STY'|'MH' (TD=tropical depression)
 *     lat          number   degrees N (negative = S hemisphere)
 *     lon          number   degrees E (negative = W hemisphere)
 *     intensityKt  number   sustained wind speed (knots)
 *     pressureHpa  number   minimum central pressure (hPa), or null
 *     movementDir  number   movement direction (degrees, 0=N, 90=E)
 *     movementKt   number   movement speed (knots)
 *     hemisphere   'N'|'S'
 *
 * USAGE
 * ─────
 *   import { StormFeed } from './js/storm-feed.js';
 *   new StormFeed().start();
 *   window.addEventListener('storm-update', e => console.log(e.detail.storms));
 */

const ENDPOINT       = '/api/storms';
const DEFAULT_POLL   = 30 * 60 * 1000;   // 30 min — NHC advisories every 3–6 hrs

export class StormFeed {
    /**
     * @param {object} opts
     * @param {number} [opts.pollInterval]  ms between polls (default 30 min)
     */
    constructor({ pollInterval = DEFAULT_POLL } = {}) {
        this.pollInterval = pollInterval;
        this._timer       = null;
        this._failStreak  = 0;
        this.storms       = [];
        this.status       = 'connecting';
    }

    start() {
        this._poll();
        this._timer = setInterval(() => this._poll(), this.pollInterval);
        return this;
    }

    stop() {
        clearInterval(this._timer);
        this._timer = null;
    }

    refresh() { return this._poll(); }

    async _poll() {
        try {
            const r = await fetch(ENDPOINT, { cache: 'no-cache' });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const data = await r.json();
            this.storms       = data.storms ?? [];
            this._failStreak  = 0;
            this.status       = 'live';
            this._dispatch();
        } catch (err) {
            this._failStreak++;
            this.status = this._failStreak > 2 ? 'offline' : 'stale';
            console.debug('[StormFeed] poll failed:', err.message);
            // Re-dispatch last known storms with degraded status
            this._dispatch();
        }
    }

    _dispatch() {
        window.dispatchEvent(new CustomEvent('storm-update', {
            detail: {
                status: this.status,
                storms: this.storms,
            },
        }));
    }
}

export default StormFeed;
