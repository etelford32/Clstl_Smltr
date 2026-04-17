/**
 * earth-feeds.js — Additional real-time Earth data feeds
 *
 * USGS Earthquakes  M2.5+ past 30 days   15-minute poll
 * ISS Position      live lat/lon/alt      10-second poll
 *
 * Both sources are free, CORS-enabled, require no API key.
 *
 * Dispatches on window:
 *   'earthquake-update'  detail: EarthquakeFeature[]
 *   'iss-update'         detail: { lat, lon, alt, vel }
 *   'feeds-status'       detail: { source, status, error? }
 */

const USGS_URL = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_month.geojson';
const ISS_URL  = 'https://api.wheretheiss.at/v1/satellites/25544';

const EQ_POLL_MS  = 15 * 60 * 1000;   // 15 min  (USGS updates every ~5 min)
const ISS_POLL_MS = 10 * 1000;         // 10 s    (ISS moves ~77 km in 10 s)

// ── Earthquake feed ───────────────────────────────────────────────────────────

async function fetchEarthquakes() {
    _dispatch('feeds-status', { source: 'USGS', status: 'fetching' });
    try {
        const res = await fetch(USGS_URL, { signal: AbortSignal.timeout(20000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const gj = await res.json();

        const quakes = (gj.features ?? [])
            .filter(f =>
                f.properties?.mag >= 2.5 &&
                f.geometry?.coordinates?.length >= 3
            )
            .map(f => ({
                id:    f.id,
                lat:   f.geometry.coordinates[1],
                lon:   f.geometry.coordinates[0],
                depth: f.geometry.coordinates[2],         // km
                mag:   f.properties.mag,
                place: f.properties.place ?? '—',
                time:  new Date(f.properties.time),
                alert: f.properties.alert ?? null,        // null/green/yellow/orange/red
                sig:   f.properties.sig ?? 0,             // significance 0-1000
            }))
            .sort((a, b) => b.mag - a.mag)                // largest first
            .slice(0, 300);

        _dispatch('earthquake-update', quakes);
        _dispatch('feeds-status', { source: 'USGS', status: 'ok', count: quakes.length });
    } catch (err) {
        console.warn('[EarthFeeds] USGS earthquake fetch failed:', err.message);
        _dispatch('feeds-status', { source: 'USGS', status: 'error', error: err.message });
    }
}

// ── ISS feed ──────────────────────────────────────────────────────────────────

async function fetchISS() {
    try {
        const res = await fetch(ISS_URL, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const d = await res.json();
        _dispatch('iss-update', {
            lat:       parseFloat(d.latitude),
            lon:       parseFloat(d.longitude),
            alt:       parseFloat(d.altitude),   // km above Earth
            vel:       parseFloat(d.velocity),   // km/h
            timestamp: new Date(),
        });
    } catch (err) {
        // ISS API can be flaky; debug-log but surface status event so UI can react
        console.debug('[EarthFeeds] ISS fetch failed:', err.message);
        _dispatch('feeds-status', { source: 'ISS', status: 'error', error: err.message });
    }
}

// ── EarthFeeds class ──────────────────────────────────────────────────────────

export class EarthFeeds {
    constructor() {
        this._timers = {};
    }

    start() {
        // Earthquakes: immediate + polling
        fetchEarthquakes();
        this._timers.eq = setInterval(fetchEarthquakes, EQ_POLL_MS);

        // ISS: immediate + polling
        fetchISS();
        this._timers.iss = setInterval(fetchISS, ISS_POLL_MS);

        return this;
    }

    stop() {
        Object.values(this._timers).forEach(clearInterval);
        this._timers = {};
    }

    refreshEarthquakes() { return fetchEarthquakes(); }
    refreshISS()         { return fetchISS(); }
}

// ── Helper ────────────────────────────────────────────────────────────────────

function _dispatch(type, detail) {
    window.dispatchEvent(new CustomEvent(type, { detail }));
}

// ── Magnitude → display helpers (exported for use in earth.html) ──────────────

/** Returns a hex colour string for a given earthquake magnitude. */
export function eqMagColor(mag) {
    if (mag >= 7.0) return '#ff00aa';   // magenta  — major
    if (mag >= 6.0) return '#ff2200';   // red      — strong
    if (mag >= 5.0) return '#ff6600';   // orange   — moderate
    if (mag >= 4.0) return '#ffcc00';   // yellow   — light
    return '#55aaff';                   // blue     — minor
}

/** Returns a Three.js Color instance for a given magnitude. */
export function eqMagColorTHREE(THREE, mag) {
    return new THREE.Color(eqMagColor(mag));
}

/**
 * Marker radius (scene units) with strong per-magnitude differentiation.
 * M2.5 stays a pinprick; M8+ reads as a dominant event without eating the globe.
 * A floor of 0.003 keeps small events clickable by the raycaster.
 *
 * Approximate curve:
 *   M2.5 → 0.0030   M4 → 0.013   M5 → 0.025
 *   M6   → 0.040    M7 → 0.060   M8 → 0.085   M9 → 0.115
 */
export function eqMarkerRadius(mag) {
    const m = Math.max(2.5, mag);
    const r = 0.0012 * Math.pow(m - 1.0, 2.2);
    return Math.min(0.12, Math.max(0.003, r));
}

/**
 * Pulse frequency in Hz keyed to magnitude.
 * Small quakes flicker; big quakes throb slowly.
 *   M2.5 → 1.4 Hz   M5 → 0.98 Hz   M7 → 0.63 Hz   M9 → 0.30 Hz
 */
export function eqPulseFreq(mag) {
    const f = 1.4 - 0.17 * Math.max(0, mag - 2.5);
    return Math.max(0.18, f);
}

/**
 * Pulse amplitude (fraction of baseRadius). Bigger quakes "breathe" deeper.
 *   M2.5 → 0.22   M5 → 0.44   M7 → 0.62   M9 → 0.80
 */
export function eqPulseAmp(mag) {
    const a = 0.22 + 0.09 * Math.max(0, mag - 2.5);
    return Math.min(0.90, a);
}

/**
 * Brightness multiplier as a function of age. Fresh events flash bright,
 * older ones fade toward a dim floor so the globe stops looking uniformly
 * noisy after an active day.
 *   <1min   → 1.3  (arrival flash)
 *   <1h     → 1.0
 *   1–6h    → 1.0 → 0.55  (linear)
 *   6–24h   → 0.55 → 0.25
 *   24–72h  → 0.25 → 0.08
 *   >72h    → 0.08  (ghost floor)
 */
export function eqAgeFactor(ageHours) {
    if (ageHours < 1 / 60) return 1.3;
    if (ageHours < 1)      return 1.0;
    if (ageHours < 6)      return 1.0  - (ageHours - 1)  * 0.09;
    if (ageHours < 24)     return 0.55 - (ageHours - 6)  * 0.01875;
    if (ageHours < 72)     return 0.25 - (ageHours - 24) * 0.00354;
    return 0.08;
}
