/**
 * Vercel Edge Function: /api/nws/convective
 *
 * Backend proxy for the NWS active-alerts endpoint, filtered to the four
 * event types that gate LLCC Rule 9 (triggered-lightning) scoring:
 *   Severe Thunderstorm Warning / Watch, Tornado Warning / Watch.
 *
 * Why a backend proxy instead of direct browser → api.weather.gov?
 *
 *   • CACHE DEDUP: a single launch-planner pageview checks 30+ pads for
 *     alert proximity. Direct calls were one-fetch-per-session per client
 *     (good) but every NEW session hit api.weather.gov separately. With
 *     100 concurrent users that's 100 upstream calls; through this proxy,
 *     those 100 sessions collapse to ONE upstream call per 5-min cache
 *     window.
 *   • NO PREFLIGHT: same-origin /api/* calls skip the CORS OPTIONS hop
 *     (saves ~150 ms per session's first call).
 *   • UNIFORM UA: NWS requests a descriptive User-Agent; centralizing here
 *     means every alert fetch presents a consistent, contactable identity
 *     regardless of which page initiated it.
 *   • STALE-WHILE-REVALIDATE: brief upstream blips don't cascade into every
 *     tab seeing "fetch failed" at the same moment.
 *
 * Response is the raw NWS GeoJSON FeatureCollection, passed through so
 * nws-proximity.js keeps its existing polygon-test logic unchanged.
 *
 * Cache:
 *   s-maxage=180  — 3 min. NWS itself updates ~1–2 min; this gives a fresh
 *                   reading every 2–3 pages-views without hammering.
 *   swr=120       — 2 min stale tolerance during upstream refresh.
 */

import { jsonError, fetchWithTimeout, CORS_HEADERS } from '../_lib/responses.js';

export const config = { runtime: 'edge' };

const NWS_API = 'https://api.weather.gov/alerts/active';
// NWS's rate-limiting is lenient, but their ToS asks for a descriptive UA
// with a contact address. This one identifies the service; if they ever
// need to reach us about bad traffic they have an email address that's
// on our site's public support channels.
const NWS_USER_AGENT = 'ParkerPhysics/1.0 (contact@parkersphysics.com)';

const CONVECTIVE_EVENTS = [
    'Severe Thunderstorm Warning',
    'Severe Thunderstorm Watch',
    'Tornado Warning',
    'Tornado Watch',
];

const CACHE_TTL = 180;   // 3 min
const CACHE_SWR = 120;   // 2 min stale tolerance

const UPSTREAM_TIMEOUT_MS = 8000;

export default async function handler() {
    const params = new URLSearchParams({
        status:       'actual',
        message_type: 'alert',
        event:        CONVECTIVE_EVENTS.join(','),
    });
    const url = `${NWS_API}?${params}`;

    let upstream;
    try {
        upstream = await fetchWithTimeout(url, {
            timeoutMs: UPSTREAM_TIMEOUT_MS,
            headers: {
                'User-Agent': NWS_USER_AGENT,
                'Accept':     'application/geo+json',
            },
        });
    } catch (e) {
        return jsonError('upstream_unavailable', e.message, { source: 'NWS api.weather.gov' });
    }

    if (!upstream.ok) {
        const text = await upstream.text().catch(() => '');
        return jsonError('upstream_error',
            text?.slice(0, 300) || `HTTP ${upstream.status}`,
            { status: 502, source: 'NWS api.weather.gov' });
    }

    // Passthrough the raw GeoJSON body. nws-proximity.js already parses
    // features[] directly, so preserving the shape keeps the client-side
    // logic (point-in-polygon + vertex-distance) unchanged.
    const body = await upstream.text();
    return new Response(body, {
        status:  200,
        headers: {
            'Content-Type':  'application/geo+json',
            'Cache-Control': `public, s-maxage=${CACHE_TTL}, stale-while-revalidate=${CACHE_SWR}`,
            ...CORS_HEADERS,
        },
    });
}
