/**
 * NWSAlerts — NOAA National Weather Service active-alert pipeline
 *
 * Data source:  api.weather.gov (public, no API key, CORS-enabled)
 *               Covers US, US territories, and adjacent marine zones.
 *               International equivalents: Meteoalarm (EU), JMA (JP) — can be
 *               wired in via the same CustomEvent interface.
 *
 * Endpoint:  GET https://api.weather.gov/alerts/active
 *              ?status=actual
 *              &message_type=alert
 *              &severity=Extreme,Severe,Moderate,Minor
 *
 * Output:  CustomEvent 'nws-alerts-update' on document
 *   detail: { alerts: Alert[], meta: AlertMeta, error?: string }
 *
 *   Alert = {
 *     id, event, headline, severity, urgency,
 *     area, effective, expires, lat, lon
 *   }
 *
 *   AlertMeta = {
 *     count, bySeverity: { Extreme, Severe, Moderate, Minor },
 *     fetchTime: Date | null
 *   }
 *
 * Fires 'nws-status' with { status: 'fetching' } before each request.
 * Refreshes every REFRESH_MS (default 5 minutes).
 */

import { geo } from './geo/coords.js';

const NWS_API    = 'https://api.weather.gov/alerts/active';
const REFRESH_MS = 5 * 60 * 1000;   // 5 minutes (NWS updates ~1-2 min)
const USER_AGENT = '(CelestialSimulator/1.0, celestial@parker-physics.edu)';

// Severity rank — index 0 = most severe
export const SEVERITY_ORDER = ['Extreme', 'Severe', 'Moderate', 'Minor', 'Unknown'];

// Three.js hex colours per severity level
export const ALERT_COLORS = {
    Extreme:  0xff2200,
    Severe:   0xff8800,
    Moderate: 0xffdd00,
    Minor:    0x22aaff,
    Unknown:  0x888888,
};

// CSS hex strings for the analysis panel badges
export const ALERT_CSS_COLORS = {
    Extreme:  '#ff2200',
    Severe:   '#ff8800',
    Moderate: '#ffdd00',
    Minor:    '#22aaff',
    Unknown:  '#888',
};

// Pulse frequency (Hz) per severity — faster = more urgent
export const ALERT_PULSE_FREQ = {
    Extreme:  3.5,
    Severe:   2.2,
    Moderate: 1.2,
    Minor:    0.55,
    Unknown:  0.3,
};

// Event taxonomy — maps NWS event names onto a small set of visual "kinds"
// so each alert can render a distinct emergency icon (tornado, hurricane,
// lightning, flood, etc.) on the globe instead of a generic dot.
export const ALERT_KINDS = [
    'tornado', 'hurricane', 'thunder', 'flood', 'wind',
    'winter', 'heat', 'fire', 'fog', 'marine', 'generic',
];

/** Classify an NWS event string into one of ALERT_KINDS. */
export function classifyAlertEvent(event) {
    const e = String(event ?? '').toLowerCase();

    // Order matters — check most specific first
    if (/\btornado\b|\bfunnel\b/.test(e))                                       return 'tornado';
    if (/\bhurricane\b|\btropical\s*(storm|depression|cyclone)\b|\btyphoon\b/.test(e)) return 'hurricane';
    if (/\bblizzard\b|\bice\s*storm\b|\bwinter\s*(storm|weather)\b|\bfreezing\b|\bsnow\b|\bsleet\b|\bfrost\b|\bfreeze\b/.test(e)) return 'winter';
    if (/\bthunderstorm\b|\bthunder\b|\blightning\b|\bhail\b/.test(e))          return 'thunder';
    if (/\bfire\b|\bred\s*flag\b|\bsmoke\b/.test(e))                            return 'fire';
    if (/\bheat\b|\bhigh\s*temperature\b|\bexcessive\s*heat\b/.test(e))         return 'heat';
    if (/\bflood\b|\brain\b|\btsunami\b|\bstorm\s*surge\b/.test(e))             return 'flood';
    if (/\bwind\b|\bdust\s*storm\b/.test(e))                                    return 'wind';
    if (/\bfog\b|\bdense\s*smoke\b/.test(e))                                    return 'fog';
    if (/\bmarine\b|\bsmall\s*craft\b|\brip\s*current\b|\bsurf\b/.test(e))      return 'marine';

    return 'generic';
}

// ─────────────────────────────────────────────────────────────────────────────
export class NWSAlerts {
    constructor() {
        this._alerts = [];
        this._timer  = null;
        this._meta   = {
            count:       0,
            bySeverity:  {},
            fetchTime:   null,
            source:      'NWS api.weather.gov',
        };
    }

    // ── Public API ───────────────────────────────────────────────────────────
    start()   { this._fetchAndProcess(); this._timer = setInterval(() => this._fetchAndProcess(), REFRESH_MS); }
    stop()    { clearInterval(this._timer); }
    refresh() { this._fetchAndProcess(); }

    get alerts() { return this._alerts; }
    get meta()   { return this._meta; }

    // ── Fetch ────────────────────────────────────────────────────────────────
    async _fetchAndProcess() {
        this._dispatch('nws-status', { status: 'fetching' });
        try {
            const params = new URLSearchParams({
                status:       'actual',
                message_type: 'alert',
                severity:     'Extreme,Severe,Moderate,Minor',
            });
            const res = await fetch(`${NWS_API}?${params}`, {
                headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/geo+json' },
                signal:  AbortSignal.timeout(15000),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const gj = await res.json();
            this._process(gj.features ?? []);
        } catch (err) {
            console.warn('[NWSAlerts] Fetch failed:', err.message);
            // Keep previous alerts; surface the error via event
            this._dispatch('nws-alerts-update', {
                alerts: this._alerts, meta: this._meta, error: err.message,
            });
            return;
        }
        this._dispatch('nws-alerts-update', { alerts: this._alerts, meta: this._meta });
    }

    // ── Parse GeoJSON feature array ──────────────────────────────────────────
    _process(features) {
        const bySeverity = {};
        const alerts     = [];

        for (const feat of features) {
            const p = feat.properties;
            if (p.status !== 'Actual') continue;

            const severity = SEVERITY_ORDER.includes(p.severity) ? p.severity : 'Unknown';
            const centroid = this._centroid(feat);
            if (!centroid) continue;   // no geographic anchor → skip

            alerts.push({
                id:        p.id,
                event:     p.event,
                kind:      classifyAlertEvent(p.event),
                headline:  p.headline ?? p.description?.slice(0, 120) ?? p.event,
                severity,
                urgency:   p.urgency ?? 'Unknown',
                area:      p.areaDesc ?? '—',
                effective: p.effective,
                expires:   p.expires,
                lat:       centroid.lat,
                lon:       centroid.lon,
                areaKm2:   centroid.areaKm2 ?? 0,    // spherical polygon area (0 for Point / state-fallback anchors)
            });
            bySeverity[severity] = (bySeverity[severity] ?? 0) + 1;
        }

        // Sort: most severe first, then alphabetically by event
        alerts.sort((a, b) => {
            const si = SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity);
            return si !== 0 ? si : a.event.localeCompare(b.event);
        });

        this._alerts  = alerts;
        this._meta    = {
            count:      alerts.length,
            bySeverity,
            fetchTime:  new Date(),
            source:     'NWS api.weather.gov',
        };
    }

    // ── Centroid resolution ───────────────────────────────────────────────────
    // Priority: GeoJSON geometry → SAME geocode state lookup → null (skip)
    // Centroid + area are computed spherically via js/geo/coords.js, so large
    // polygons (winter-storm watches that cover several states) and polygons
    // straddling the antimeridian both get a correct anchor point.
    //
    // Returns: { lat, lon, areaKm2 } or null if no geography resolvable.
    _centroid(feat) {
        const g = feat.geometry;
        if (g) {
            switch (g.type) {
                case 'Point':
                    return {
                        lon: g.coordinates[0],
                        lat: g.coordinates[1],
                        areaKm2: 0,
                    };
                case 'Polygon': {
                    const ring = g.coordinates[0];
                    const c = geo.sphericalRingCentroid(ring);
                    if (!c) return null;
                    c.areaKm2 = geo.sphericalRingAreaKm2(ring);
                    return c;
                }
                case 'MultiPolygon': {
                    let best = null, bestArea = 0;
                    for (const poly of g.coordinates) {
                        const a = geo.sphericalRingAreaKm2(poly[0]);
                        if (a > bestArea) { bestArea = a; best = poly[0]; }
                    }
                    if (!best) return null;
                    const c = geo.sphericalRingCentroid(best);
                    if (!c) return null;
                    c.areaKm2 = bestArea;
                    return c;
                }
            }
        }
        return this._geocodeFallback(feat.properties);
    }

    // Map SAME geocode prefix (state FIPS 01–78) → approximate centroid
    _geocodeFallback(props) {
        const same = (props.geocode?.SAME ?? [])[0];
        if (!same) return null;
        const fips = same.slice(1, 3);   // SAME format: 0SSCCC (SS = state FIPS)
        return STATE_CENTROIDS[fips] ?? null;
    }

    _dispatch(type, detail) {
        document.dispatchEvent(new CustomEvent(type, { detail }));
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// FIPS-2 state code → approximate geographic centroid {lat, lon}
// Used as fallback when the alert has no polygon geometry.
// ─────────────────────────────────────────────────────────────────────────────
const STATE_CENTROIDS = {
    '01': { lat:  32.8, lon:  -86.8 },  // Alabama
    '02': { lat:  64.2, lon: -153.4 },  // Alaska
    '04': { lat:  34.3, lon: -111.1 },  // Arizona
    '05': { lat:  34.9, lon:  -92.4 },  // Arkansas
    '06': { lat:  37.2, lon: -119.6 },  // California
    '08': { lat:  39.0, lon: -105.5 },  // Colorado
    '09': { lat:  41.6, lon:  -72.7 },  // Connecticut
    '10': { lat:  39.0, lon:  -75.5 },  // Delaware
    '12': { lat:  28.6, lon:  -82.4 },  // Florida
    '13': { lat:  32.7, lon:  -83.4 },  // Georgia
    '15': { lat:  20.3, lon: -156.4 },  // Hawaii
    '16': { lat:  44.4, lon: -114.5 },  // Idaho
    '17': { lat:  40.0, lon:  -89.2 },  // Illinois
    '18': { lat:  39.9, lon:  -86.3 },  // Indiana
    '19': { lat:  42.1, lon:  -93.5 },  // Iowa
    '20': { lat:  38.5, lon:  -98.4 },  // Kansas
    '21': { lat:  37.5, lon:  -85.3 },  // Kentucky
    '22': { lat:  31.1, lon:  -91.9 },  // Louisiana
    '23': { lat:  44.7, lon:  -69.4 },  // Maine
    '24': { lat:  39.1, lon:  -76.8 },  // Maryland
    '25': { lat:  42.3, lon:  -71.8 },  // Massachusetts
    '26': { lat:  44.4, lon:  -85.4 },  // Michigan
    '27': { lat:  46.4, lon:  -93.3 },  // Minnesota
    '28': { lat:  32.7, lon:  -89.7 },  // Mississippi
    '29': { lat:  38.4, lon:  -92.5 },  // Missouri
    '30': { lat:  47.0, lon: -110.4 },  // Montana
    '31': { lat:  41.5, lon:  -99.8 },  // Nebraska
    '32': { lat:  39.3, lon: -116.6 },  // Nevada
    '33': { lat:  43.7, lon:  -71.6 },  // New Hampshire
    '34': { lat:  40.1, lon:  -74.5 },  // New Jersey
    '35': { lat:  34.8, lon: -106.2 },  // New Mexico
    '36': { lat:  42.9, lon:  -75.5 },  // New York
    '37': { lat:  35.5, lon:  -79.4 },  // North Carolina
    '38': { lat:  47.4, lon: -100.5 },  // North Dakota
    '39': { lat:  40.4, lon:  -82.8 },  // Ohio
    '40': { lat:  35.6, lon:  -96.9 },  // Oklahoma
    '41': { lat:  43.9, lon: -120.6 },  // Oregon
    '42': { lat:  40.6, lon:  -77.3 },  // Pennsylvania
    '44': { lat:  41.7, lon:  -71.6 },  // Rhode Island
    '45': { lat:  33.9, lon:  -80.9 },  // South Carolina
    '46': { lat:  44.4, lon: -100.2 },  // South Dakota
    '47': { lat:  35.9, lon:  -86.4 },  // Tennessee
    '48': { lat:  31.5, lon:  -99.3 },  // Texas
    '49': { lat:  39.3, lon: -111.1 },  // Utah
    '50': { lat:  44.1, lon:  -72.7 },  // Vermont
    '51': { lat:  37.5, lon:  -79.3 },  // Virginia
    '53': { lat:  47.4, lon: -120.5 },  // Washington
    '54': { lat:  38.6, lon:  -80.6 },  // West Virginia
    '55': { lat:  44.6, lon:  -89.9 },  // Wisconsin
    '56': { lat:  42.9, lon: -107.6 },  // Wyoming
    '60': { lat:  -14.3, lon: -170.7 }, // American Samoa
    '66': { lat:   13.4, lon:  144.8 }, // Guam
    '69': { lat:   15.2, lon:  145.8 }, // Northern Mariana Islands
    '72': { lat:   18.2, lon:  -66.5 }, // Puerto Rico
    '78': { lat:   18.0, lon:  -64.8 }, // U.S. Virgin Islands
};
