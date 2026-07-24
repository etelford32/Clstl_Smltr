/**
 * Vercel Edge Function: /api/noaa/passthrough?path=<allowlisted-path>
 *
 * Same-origin FALLBACK mirror for the browser-direct SWPC feeds. The
 * house rule stands: NOAA endpoints are fetched browser-direct (CORS is
 * enabled and it spares our egress). But some client networks — VPNs,
 * corporate filters — block services.swpc.noaa.gov outright, and for
 * those users every live tier died at once (the "no successful update
 * yet" banner). js/swpc-feed.js and js/flux-rope-live.js now retry
 * through this mirror after a direct failure.
 *
 * NOAA's WAF has historically 403'd some server-side fetchers (see the
 * js/swpc-feed.js header). If that applies to this deployment, the
 * mirror fails exactly like the direct path did — strictly additive,
 * never worse. Do NOT flip the house default to server-side on the back
 * of this file.
 *
 * STRICT allowlist — this is not an open proxy. The response body is the
 * RAW upstream payload (no jsonOk envelope) so client parsers see the
 * byte-identical shape they'd get from NOAA directly.
 */

export const config = { runtime: 'edge' };

const UPSTREAM = 'https://services.swpc.noaa.gov/';

// Exactly the products the client tiers consume (js/config.js NOAA table
// + the RTSW pair js/flux-rope-live.js uses + the two inline pulls + the
// Geospace propagated feed the Shielding Lab's LIVE mode drives from).
const ALLOW = new Set([
    'products/geospace/propagated-solar-wind-1-hour.json',
    'json/rtsw/rtsw_wind_1m.json',
    'json/rtsw/rtsw_mag_1m.json',
    'json/planetary_k_index_1m.json',
    'products/noaa-planetary-k-index-forecast.json',
    'json/goes/primary/xrays-1-day.json',
    'json/goes/primary/integral-protons-1-day.json',
    'json/goes/primary/integral-electrons-1-day.json',
    'json/ovation_aurora_latest.json',
    'products/alerts.json',
    'products/kyoto-dst.json',
    'json/solar_regions.json',
    'json/f107_cm_flux.json',
    'text/daily-geomagnetic-indices.txt',
]);

export default async function handler(request) {
    const path = new URL(request.url).searchParams.get('path') || '';
    if (!ALLOW.has(path)) {
        return new Response(JSON.stringify({ error: 'path_not_allowed' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
        });
    }
    try {
        const upstream = await fetch(UPSTREAM + path, {
            signal: AbortSignal.timeout(12_000),
            headers: { 'User-Agent': 'parkersphysics.com fallback mirror' },
        });
        if (!upstream.ok) {
            return new Response(JSON.stringify({ error: 'upstream', status: upstream.status }), {
                status: 502,
                headers: { 'Content-Type': 'application/json' },
            });
        }
        return new Response(upstream.body, {
            status: 200,
            headers: {
                'Content-Type': upstream.headers.get('content-type')
                    ?? (path.endsWith('.txt') ? 'text/plain' : 'application/json'),
                'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120',
                'Access-Control-Allow-Origin': '*',
            },
        });
    } catch (e) {
        return new Response(JSON.stringify({ error: 'fetch_failed', message: String(e?.message ?? e) }), {
            status: 502,
            headers: { 'Content-Type': 'application/json' },
        });
    }
}
