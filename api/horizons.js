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

// Allowed Horizons parameters (whitelist to prevent proxy abuse)
const ALLOWED_PARAMS = new Set([
    'format', 'COMMAND', 'OBJ_DATA', 'MAKE_EPHEM', 'EPHEM_TYPE',
    'CENTER', 'START_TIME', 'STOP_TIME', 'STEP_SIZE', 'QUANTITIES',
    'REF_PLANE', 'REF_SYSTEM', 'OUT_UNITS', 'VEC_TABLE', 'VEC_CORR',
    'CAL_FORMAT', 'ANG_FORMAT', 'APPARENT', 'TIME_DIGITS', 'RANGE_UNITS',
    'SUPPRESS_RANGE_RATE', 'ELEV_CUT', 'SKIP_DAYLT', 'SOLAR_ELONG',
    'AIRMASS', 'LHA_CUTOFF', 'EXTRA_PREC', 'CSV_FORMAT', 'VEC_LABELS',
    'ELM_LABELS', 'TP_TYPE', 'R_T_S_ONLY',
]);
const MAX_QUERY_LENGTH = 2000;

export default async function handler(request) {
    const incoming = new URL(request.url);

    // Input validation: reject oversized queries and non-whitelisted params
    if (incoming.search.length > MAX_QUERY_LENGTH) {
        return Response.json(
            { error: 'query_too_large', max: MAX_QUERY_LENGTH },
            { status: 400, headers: { 'Access-Control-Allow-Origin': '*' } },
        );
    }
    const filtered = new URLSearchParams();
    for (const [key, value] of incoming.searchParams) {
        if (ALLOWED_PARAMS.has(key)) filtered.set(key, value.slice(0, 200));
    }
    const upstreamURL = `${HORIZONS_BASE}?${filtered.toString()}`;

    let upstreamRes;
    try {
        upstreamRes = await fetch(upstreamURL, {
            headers: { Accept: 'application/json' },
            cf: { cacheTtl: CACHE_TTL },   // Vercel/CF edge cache
        });
    } catch (e) {
        return Response.json(
            { error: 'service_unavailable' },
            { status: 503, headers: { 'Access-Control-Allow-Origin': '*' } },
        );
    }

    if (!upstreamRes.ok) {
        return Response.json(
            { error: 'upstream_error', status: upstreamRes.status },
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
