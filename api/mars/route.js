/**
 * Vercel Edge Function: /api/mars/route
 *
 * Live NASA/JPL MMGIS Perseverance traverse, normalized into the same shape as
 * the bundled snapshot at /data/mars/perseverance-route.json.
 *
 * ── Why this route exists ─────────────────────────────────────────────────
 * The globe used to read the traverse ONLY from the bundled file, which is a
 * human-baked snapshot. That made every rover position on the page as old as
 * the last time someone ran the baker — the page said "checked 2026-08-05" and
 * meant it. MMGIS is the same endpoint NASA's own "Where is Perseverance?" map
 * reads, so there is no reason for the position to be stale.
 *
 * ── Contract with the client ──────────────────────────────────────────────
 * This route ALWAYS answers 200. `live: true` means the payload came from
 * MMGIS this request; `live: false` carries a `reason` and no points, and the
 * client falls back to the bundled snapshot and says so in the provenance line.
 * A 5xx here would be indistinguishable from "the whole site is down" to a
 * client whose fallback is a static file, so the failure is data, not status.
 *
 * mars.nasa.gov has been intermittent through 2024–26. Treat an outage as
 * normal operation, not an exception.
 *
 * Cache-Control: s-maxage=1800 / swr=1800. Perseverance localizations land at
 * most once per sol (24h 39m); a 30-minute edge cache is far finer than the
 * data changes and keeps MMGIS from seeing per-visitor traffic.
 */

import { jsonOk, fetchWithTimeout } from '../_lib/responses.js';
import { MARS_ROUTE_MAP_URL, MARS_ROUTE_SOURCE_URL, normalizeMarsRoute } from '../../js/mars-route-normalize.js';

export const config = { runtime: 'edge' };

const CACHE_TTL = 1800;
const CACHE_SWR = 1800;
// MMGIS serves the full waypoint collection (~700 features, a few hundred kB)
// in one shot. Slower than a NOAA JSON, so it gets more room than the 10 s
// default — but still bounded, because the client has a working fallback and
// waiting is worse than falling back.
const UPSTREAM_TIMEOUT_MS = 12000;

function unavailable(reason) {
    return jsonOk({
        live: false,
        reason,
        // Read by status.html's _rtProxyHealth(): a 200 carrying
        // freshness:'stale' renders amber rather than green. This route
        // deliberately never 5xx's (the client has a working fallback), so
        // without this the status page would report a dead MMGIS as healthy.
        freshness: 'stale',
        source_name: 'NASA/JPL MMGIS Rover Waypoints',
        source_url: MARS_ROUTE_SOURCE_URL,
        map_url: MARS_ROUTE_MAP_URL,
        fallback: '/data/mars/perseverance-route.json',
        generated_at: new Date().toISOString(),
    }, { maxAge: 300, swr: 300 });
}

export default async function handler() {
    let response;
    try {
        response = await fetchWithTimeout(MARS_ROUTE_SOURCE_URL, {
            headers: { Accept: 'application/json' },
            timeoutMs: UPSTREAM_TIMEOUT_MS,
        });
    } catch (error) {
        return unavailable(`MMGIS unreachable: ${error.message || 'fetch failed'}`);
    }
    if (!response.ok) return unavailable(`MMGIS HTTP ${response.status}`);

    let payload;
    try {
        payload = await response.json();
    } catch (error) {
        return unavailable(`MMGIS payload is not JSON: ${error.message || 'parse failed'}`);
    }

    let route;
    try {
        // normalizeMarsRoute throws on a sol or odometer regression. That is a
        // structural change in NASA's payload, not a transient outage — falling
        // back to the verified snapshot is the correct response either way.
        route = normalizeMarsRoute(payload, { checkedAt: new Date().toISOString().slice(0, 10) });
    } catch (error) {
        return unavailable(`MMGIS payload rejected: ${error.message}`);
    }

    return jsonOk({
        live: true,
        generated_at: new Date().toISOString(),
        ...route,
    }, { maxAge: CACHE_TTL, swr: CACHE_SWR });
}
