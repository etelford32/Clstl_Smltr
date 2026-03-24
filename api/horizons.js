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
export const config = { runtime: 'edge' };

const HORIZONS_BASE = 'https://ssd.jpl.nasa.gov/api/horizons.api';
const CACHE_TTL     = 3600;  // 1 hr — ephemeris changes slowly

export default async function handler(request) {
    const incoming  = new URL(request.url);
    const upstreamURL = `${HORIZONS_BASE}?${incoming.searchParams.toString()}`;

    let upstreamRes;
    try {
        upstreamRes = await fetch(upstreamURL, {
            headers: { Accept: 'application/json' },
            cf: { cacheTtl: CACHE_TTL },   // Vercel/CF edge cache
        });
    } catch (e) {
        return Response.json(
            { error: 'upstream_unavailable', detail: e.message, source: 'JPL Horizons' },
            { status: 503, headers: { 'Access-Control-Allow-Origin': '*' } },
        );
    }

    if (!upstreamRes.ok) {
        const text = await upstreamRes.text().catch(() => '');
        return Response.json(
            { error: 'upstream_error', status: upstreamRes.status, body: text },
            { status: upstreamRes.status, headers: { 'Access-Control-Allow-Origin': '*' } },
        );
    }

    const body = await upstreamRes.text();
    return new Response(body, {
        status:  200,
        headers: {
            'Content-Type':                upstreamRes.headers.get('Content-Type') ?? 'application/json',
            'Cache-Control':               `public, s-maxage=${CACHE_TTL}, stale-while-revalidate=300`,
            'Access-Control-Allow-Origin': '*',
        },
    });
}
