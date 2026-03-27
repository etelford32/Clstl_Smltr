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

/** Returns radius scale for an earthquake marker (scene units). */
export function eqMarkerRadius(mag) {
    // M2.5 → 0.008,  M5 → 0.018,  M7 → 0.038,  M9 → 0.075
    return 0.004 * Math.pow(1.65, Math.max(0, mag - 2.5));
}
