/**
 * ocean-feed.js — Ocean data pipeline for Celestial Simulator
 * ═══════════════════════════════════════════════════════════════════════
 * Fetches buoy observations (wave height, SST, currents) from NDBC proxy
 * and provides data for 3D ocean visualization markers on the Earth globe.
 *
 * Fires: CustomEvent 'ocean-update' on document
 *   detail: { buoys, stats, currents }
 *
 * Usage:
 *   const ocean = new OceanFeed();
 *   ocean.start();
 *   document.addEventListener('ocean-update', e => { ... });
 */

const NDBC_ENDPOINT = '/api/ndbc/buoys';
const REFRESH_MS    = 10 * 60 * 1000;  // 10 minutes (matches proxy cache)

export class OceanFeed {
    constructor() {
        this._buoys = [];
        this._stats = {};
        this._timer = null;
    }

    start() {
        this._fetch();
        this._timer = setInterval(() => this._fetch(), REFRESH_MS);
    }
    stop() { clearInterval(this._timer); }

    get buoys() { return this._buoys; }
    get stats() { return this._stats; }

    async _fetch() {
        try {
            const res = await fetch(`${NDBC_ENDPOINT}?limit=800`, {
                signal: AbortSignal.timeout(15000),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();

            this._buoys = data.buoys ?? [];
            this._stats = data.stats ?? {};

            document.dispatchEvent(new CustomEvent('ocean-update', {
                detail: {
                    buoys: this._buoys,
                    stats: this._stats,
                    count: data.count ?? 0,
                },
            }));
        } catch (err) {
            console.warn('[OceanFeed] Fetch failed:', err.message);
        }
    }
}

/**
 * Wave height → color mapping for buoy markers.
 * Calm = blue, moderate = green/yellow, rough = orange/red, extreme = magenta.
 */
export function waveColor(wvht) {
    if (wvht == null) return 0x4488aa;
    if (wvht < 0.5) return 0x2266cc;   // calm
    if (wvht < 1.5) return 0x22aa66;   // slight
    if (wvht < 2.5) return 0x88cc22;   // moderate
    if (wvht < 4.0) return 0xffaa00;   // rough
    if (wvht < 6.0) return 0xff4400;   // very rough
    if (wvht < 9.0) return 0xff0044;   // high
    return 0xcc00ff;                    // phenomenal (>9m)
}

/**
 * Wave height → marker size (scene units).
 */
export function waveMarkerSize(wvht) {
    if (wvht == null) return 0.005;
    return 0.005 + Math.min(wvht / 12, 1) * 0.015;
}

/**
 * Sea state description from wave height (WMO scale).
 */
export function seaState(wvht) {
    if (wvht == null) return 'Unknown';
    if (wvht < 0.1) return 'Calm (glassy)';
    if (wvht < 0.5) return 'Calm (rippled)';
    if (wvht < 1.25) return 'Smooth';
    if (wvht < 2.5) return 'Slight';
    if (wvht < 4.0) return 'Moderate';
    if (wvht < 6.0) return 'Rough';
    if (wvht < 9.0) return 'Very rough';
    if (wvht < 14.0) return 'High';
    return 'Phenomenal';
}
