/**
 * nws-proximity.js — "is an active convective NWS alert near this point?"
 *
 * A narrow, launch-planner-focused companion to js/nws-alerts.js. Where the
 * full NWSAlerts pipeline is a long-running subscriber that hydrates the
 * Earth globe with every active alert, this module does the opposite:
 *
 *   1. Fetch active *convective* alerts once per page session.
 *   2. For any (lat, lon) — e.g. a launch pad — measure proximity to each
 *      alert polygon, returning alerts whose edge is within `radiusKm`.
 *   3. Stay silent outside CONUS / US territories. The NWS API only covers
 *      US geography, so a pad in Kourou / Wenchang / Baikonur simply gets
 *      zero matches — which is the right semantics, not an error.
 *
 * Cached single-flight fetch means calling this for 30 pads in a row is
 * ONE network hit, not 30. The 5-minute TTL matches NWS's ~1–2 min refresh
 * cadence without hammering the endpoint.
 *
 * Polygon test is explicit two-part:
 *   • ray-cast point-in-polygon in (lon, lat) plane — NWS county polygons
 *     are small enough that planar PIP is correct, and they never cross
 *     the antimeridian, so we skip the spherical complexity.
 *   • nearest-vertex great-circle distance — catches the common case of a
 *     pad just outside a warning polygon where the edge passes within the
 *     buffer distance but the centroid is far away.
 *
 * Exported surface is deliberately tiny:
 *   fetchConvectiveAlerts()                 → cached array of raw alerts
 *   alertsNearPoint(lat, lon, alerts, opts) → filtered + distance-tagged
 *   convectiveAlertsNearPad(lat, lon, opts) → convenience wrapper
 */

import { geo } from './geo/coords.js';

// Backend proxy that fetches + filters NWS active alerts. The proxy
// adds an edge-cache layer shared across ALL visitors (api/nws/convective.js
// s-maxage=180) so a launch-planner pageview with 30 pads is ONE upstream
// hit — even across different user sessions — not one per cold client
// cache. See the proxy source for the full "why" rationale.
const NWS_PROXY = '/api/nws/convective';

// Client-side TTL is shorter than the edge cache because the edge is
// already dedup'd; the in-module cache exists to dedup within a single
// page load (multiple pads checked simultaneously), not across hours.
const CACHE_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10000;

// The four NWS event names that mean "active lightning risk near this point."
// Deliberately narrow — a Flood Warning or Winter Storm Watch doesn't gate
// LLCC Rule 9. Severe Thunderstorm Watch is included because a launch scrubs
// for *forecast* thunder as well as ongoing thunder; tower ops don't care
// about the warning-vs-watch legal distinction.
// Exported for callers who want to assert expected behavior in tests.
export const CONVECTIVE_EVENTS = Object.freeze([
    'Severe Thunderstorm Warning',
    'Severe Thunderstorm Watch',
    'Tornado Warning',
    'Tornado Watch',
]);

let _cache    = null;    // { fetchedAt: number, alerts: Alert[] }
let _inflight = null;    // dedupe concurrent callers

/**
 * Fetch the active convective-alert set via the backend proxy. Single-
 * flight, 5-minute client cache. Returns [] on failure rather than
 * throwing — a convection scorer shouldn't become an error path just
 * because the proxy or upstream is briefly slow.
 */
export async function fetchConvectiveAlerts() {
    const now = Date.now();
    if (_cache && now - _cache.fetchedAt < CACHE_TTL_MS) return _cache.alerts;
    if (_inflight) return _inflight;

    _inflight = (async () => {
        try {
            const res = await fetch(NWS_PROXY, {
                headers: { Accept: 'application/geo+json' },
                signal:  AbortSignal.timeout(FETCH_TIMEOUT_MS),
            });
            if (!res.ok) throw new Error(`proxy HTTP ${res.status}`);
            const gj = await res.json();
            const alerts = (gj.features ?? [])
                .map(_projectFeature)
                .filter(Boolean);
            _cache = { fetchedAt: now, alerts };
            return alerts;
        } catch (e) {
            console.warn('[NWSProximity] fetch failed:', e.message);
            // Keep stale cache if we have one — a transient error shouldn't
            // wipe a just-fetched set. Return empty as last resort.
            return _cache?.alerts ?? [];
        } finally {
            _inflight = null;
        }
    })();

    return _inflight;
}

/** Force the cache to be invalidated — useful for tests / manual refresh. */
export function _resetCache() { _cache = null; _inflight = null; }

/**
 * Filter `alerts` to those within `radiusKm` of (padLat, padLon), tagged
 * with the computed distance. Returns an array sorted nearest-first.
 *
 * A pad sitting INSIDE an alert polygon is distance 0 with inside=true.
 * A pad outside the polygon but near its edge reports the great-circle
 * distance to the nearest polygon vertex — a slight overestimate (edge
 * vertices are sampled, not the continuous edge), but for NWS county-line
 * polygons that overestimate is < 10 km at worst. We'd rather over-flag
 * than miss; LLCC scrubs are a lot cheaper than post-launch surprise.
 */
export function alertsNearPoint(padLat, padLon, alerts, { radiusKm = 50 } = {}) {
    if (!Number.isFinite(padLat) || !Number.isFinite(padLon) || !Array.isArray(alerts)) return [];
    const hits = [];
    for (const a of alerts) {
        const prox = _proximity(padLat, padLon, a);
        if (prox && prox.distanceKm <= radiusKm) {
            hits.push({ ...a, distanceKm: prox.distanceKm, inside: prox.inside });
        }
    }
    hits.sort((x, y) => x.distanceKm - y.distanceKm);
    return hits;
}

/** One-call convenience: fetch the alert set, then filter to near-pad matches. */
export async function convectiveAlertsNearPad(padLat, padLon, opts = {}) {
    if (!Number.isFinite(padLat) || !Number.isFinite(padLon)) return [];
    const alerts = await fetchConvectiveAlerts();
    return alertsNearPoint(padLat, padLon, alerts, opts);
}

// ── Internals ───────────────────────────────────────────────────────────────

/**
 * Project a GeoJSON feature from the NWS alerts endpoint into the shape
 * the proximity scorer consumes. Keeps the raw geometry so we can do
 * polygon testing, not just centroid distance.
 * Returns null if the feature has no resolvable geometry — a state-level
 * SAME-geocode alert (no polygon) can't be distance-tested at the
 * per-kilometre granularity this module exists for.
 */
function _projectFeature(feat) {
    const p = feat.properties;
    if (!p || p.status !== 'Actual') return null;
    const g = feat.geometry;
    if (!g) return null;
    if (g.type !== 'Polygon' && g.type !== 'MultiPolygon' && g.type !== 'Point') return null;
    return {
        id:        p.id,
        event:     p.event,
        severity:  p.severity ?? 'Unknown',
        urgency:   p.urgency  ?? 'Unknown',
        headline:  p.headline ?? p.event,
        area:      p.areaDesc ?? '',
        effective: p.effective,
        expires:   p.expires,
        geometry:  g,
    };
}

/**
 * Proximity of (lat, lon) to an alert's geometry.
 * Returns { distanceKm, inside } or null if geometry is unusable.
 */
function _proximity(lat, lon, alert) {
    const g = alert.geometry;
    if (!g) return null;
    if (g.type === 'Point') {
        const [plon, plat] = g.coordinates;
        return {
            distanceKm: geo.deg.distanceKm({ lat, lon }, { lat: plat, lon: plon }),
            inside:     false,
        };
    }
    if (g.type === 'Polygon') {
        const ring = g.coordinates[0];
        if (_pointInRing(lat, lon, ring)) return { distanceKm: 0, inside: true };
        return { distanceKm: _minVertexDistanceKm(lat, lon, ring), inside: false };
    }
    if (g.type === 'MultiPolygon') {
        // Any sub-polygon can trigger. Take the one with the smallest
        // effective distance (0 if any contains the point).
        let bestInside = false;
        let bestDist   = Infinity;
        for (const poly of g.coordinates) {
            const ring = poly[0];
            if (_pointInRing(lat, lon, ring)) return { distanceKm: 0, inside: true };
            const d = _minVertexDistanceKm(lat, lon, ring);
            if (d < bestDist) { bestDist = d; bestInside = false; }
        }
        return Number.isFinite(bestDist) ? { distanceKm: bestDist, inside: bestInside } : null;
    }
    return null;
}

/**
 * Standard 2D ray-cast point-in-polygon in (lon, lat) plane. NWS county
 * polygons are small — degenerate case of spherical PIP reduces cleanly to
 * planar — and never cross the antimeridian, so we don't need the full
 * spherical machinery. Horizontal ray cast to the right; odd crossings
 * means inside.
 */
function _pointInRing(lat, lon, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i][0], yi = ring[i][1];
        const xj = ring[j][0], yj = ring[j][1];
        const crosses = (yi > lat) !== (yj > lat);
        if (crosses) {
            const xIntersect = (xj - xi) * (lat - yi) / (yj - yi) + xi;
            if (lon < xIntersect) inside = !inside;
        }
    }
    return inside;
}

/**
 * Minimum great-circle distance from (lat, lon) to any vertex of a ring.
 * This overestimates the true edge distance by up to the local vertex
 * spacing — for NWS polygons that's typically < 10 km, which is acceptable
 * given the >= 50 km buffer this module is used with.
 */
function _minVertexDistanceKm(lat, lon, ring) {
    let min = Infinity;
    const from = { lat, lon };
    for (let i = 0; i < ring.length; i++) {
        const [vx, vy] = ring[i];
        const d = geo.deg.distanceKm(from, { lat: vy, lon: vx });
        if (d < min) min = d;
    }
    return min;
}
