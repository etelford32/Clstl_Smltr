/**
 * Vercel Edge Function: /api/horizons
 *
 * Transparent CORS proxy for NASA JPL Horizons Web API.
 * The browser cannot call ssd.jpl.nasa.gov directly (no CORS headers),
 * so this edge function forwards the request server-side and relays
 * the JSON response back to the browser with CORS headers attached.
 *
 * All query parameters are forwarded as-is to Horizons.
 *
 * Typical callers: js/horizons.js  _fetchVec()
 */
import { jsonError, fetchWithTimeout, CORS_HEADERS } from './_lib/responses.js';

export const config = { runtime: 'edge' };

const HORIZONS_BASE = 'https://ssd.jpl.nasa.gov/api/horizons.api';
const CACHE_TTL     = 3600;  // 1 hr — ephemeris changes slowly
const CACHE_SWR     = 300;
// JPL Horizons is the slowest upstream we proxy — ephemeris queries touch
// large SPK files. Give it more room than the 10 s default.
const HORIZONS_TIMEOUT_MS = 20000;

export default async function handler(request) {
    const incoming  = new URL(request.url);
    const upstreamURL = `${HORIZONS_BASE}?${incoming.searchParams.toString()}`;

    let upstreamRes;
    try {
        upstreamRes = await fetchWithTimeout(upstreamURL, {
            headers:   { Accept: 'application/json' },
            timeoutMs: HORIZONS_TIMEOUT_MS,
        });
    } catch (e) {
        return jsonError('upstream_unavailable', e.message, { source: 'JPL Horizons' });
    }

    if (!upstreamRes.ok) {
        const text = await upstreamRes.text().catch(() => '');
        // Preserve upstream status code so clients can distinguish a 4xx
        // (bad query) from a 5xx (Horizons down). Use the shared error
        // helper for cache-control + CORS consistency.
        return jsonError('upstream_error', text?.slice(0, 500) || `HTTP ${upstreamRes.status}`, {
            status: upstreamRes.status,
            source: 'JPL Horizons',
        });
    }

    const body = await upstreamRes.text();
    return new Response(body, {
        status:  200,
        headers: {
            'Content-Type':  upstreamRes.headers.get('Content-Type') ?? 'application/json',
            'Cache-Control': `public, s-maxage=${CACHE_TTL}, stale-while-revalidate=${CACHE_SWR}`,
            ...CORS_HEADERS,
        },
    });
}
