/**
 * gfs-feed.js — High-resolution GFS weather data pipeline
 * ═══════════════════════════════════════════════════════════════════════
 * Fetches NOAA GFS 0.25° data via the NOMADS proxy for higher-resolution
 * weather fields that Open-Meteo doesn't expose:
 *   - Jet stream winds (250hPa U/V)
 *   - Upper atmosphere temperature (10hPa stratosphere)
 *   - Full pressure-level wind profiles
 *
 * Complements the existing WeatherFeed (Open-Meteo) which handles
 * surface weather. This module handles upper-atmosphere layers.
 *
 * Fires: CustomEvent 'gfs-update' on document
 *   detail: { jetStream, upperAtm, level, grid }
 *
 * Usage:
 *   const gfs = new GFSFeed();
 *   gfs.start();
 *   document.addEventListener('gfs-update', e => { ... });
 */

const GFS_ENDPOINT = '/api/nomads/gfs';
const REFRESH_MS   = 60 * 60 * 1000;  // 1 hour (GFS runs every 6h)

export class GFSFeed {
    constructor() {
        this._jetStream = null;
        this._upperAtm = null;
        this._timer = null;
    }

    start() {
        this._fetchJetStream();
        this._timer = setInterval(() => this._fetchJetStream(), REFRESH_MS);
    }
    stop() { clearInterval(this._timer); }

    get jetStream() { return this._jetStream; }
    get upperAtm() { return this._upperAtm; }

    /** Fetch 250hPa wind field (jet stream) at 2° resolution */
    async _fetchJetStream() {
        try {
            const res = await fetch(
                `${GFS_ENDPOINT}?var=UGRD,VGRD&level=250&resolution=2&region=global`,
                { signal: AbortSignal.timeout(25000) }
            );
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();

            if (data.grid?.values) {
                const { lats, lons, values, nLat, nLon } = data.grid;
                const uArr = values.UGRD ?? [];
                const vArr = values.VGRD ?? [];

                // Build structured jet stream data
                const points = [];
                for (let j = 0; j < nLat && j < lats.length; j++) {
                    for (let i = 0; i < nLon && i < lons.length; i++) {
                        const idx = j * nLon + i;
                        const u = uArr[idx];
                        const v = vArr[idx];
                        if (u == null || v == null) continue;
                        const speed = Math.sqrt(u * u + v * v);
                        // Only include jet stream core (>30 m/s ≈ 108 km/h)
                        if (speed < 30) continue;
                        points.push({
                            lat: lats[j],
                            lon: lons[i] > 180 ? lons[i] - 360 : lons[i],
                            u, v, speed,
                            dir: (Math.atan2(-u, -v) * 180 / Math.PI + 360) % 360,
                        });
                    }
                }

                this._jetStream = {
                    points,
                    run: data.run,
                    maxSpeed: points.length > 0 ? Math.max(...points.map(p => p.speed)) : 0,
                };

                document.dispatchEvent(new CustomEvent('gfs-update', {
                    detail: {
                        jetStream: this._jetStream,
                        level: '250hPa',
                        source: data.source,
                    },
                }));
            }
        } catch (err) {
            console.warn('[GFSFeed] Jet stream fetch failed:', err.message);
        }
    }
}

/**
 * Jet stream speed → color for visualization.
 * Moderate jet = blue, strong = cyan, extreme = yellow/white.
 */
export function jetColor(speed) {
    if (speed < 40) return 0x2244aa;   // moderate
    if (speed < 60) return 0x22aadd;   // strong
    if (speed < 80) return 0x44ddaa;   // very strong
    if (speed < 100) return 0xdddd44;  // extreme
    return 0xffffff;                    // exceptional (>100 m/s ≈ 360 km/h)
}

/**
 * Jet stream speed category.
 */
export function jetCategory(speed) {
    if (speed < 30) return 'Below threshold';
    if (speed < 50) return 'Moderate jet';
    if (speed < 75) return 'Strong jet';
    if (speed < 100) return 'Extreme jet';
    return 'Exceptional (>360 km/h)';
}
