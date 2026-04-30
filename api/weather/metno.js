/**
 * Vercel Edge Function: /api/weather/metno
 *
 * Source: MET Norway Locationforecast 2.0 (compact)
 *   https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=…&lon=…
 *
 * Why this exists
 * ---------------
 * Open-Meteo is a unified GRIB2-decoding cache that re-hosts NOAA GFS / ECMWF
 * IFS / DWD ICON. When Open-Meteo's edge is rate-limited or has an outage we
 * lose every weather endpoint at once. MET Norway publishes the EU/Nordic
 * blend (MEPS + ECMWF) directly as JSON with no key, no decode step, and no
 * rate-limit shared with other tenants. That makes it a clean Edge fallback
 * for any "point forecast" use case.
 *
 * Constraints we have to respect (per https://api.met.no/doc/TermsOfService)
 *   • User-Agent MUST identify the app + contact email/URL. They will block
 *     anonymous traffic.
 *   • Coordinates limited to 4 decimal places. Higher precision returns 403.
 *   • 20 req/s per app cap. We Edge-cache aggressively to stay well below.
 *   • Must honor Expires / If-Modified-Since for backoff. The Edge cache
 *     headers we set here are how we comply — every POP serves cached bytes
 *     for s-maxage seconds before any new upstream hit.
 *
 * Query params
 * ------------
 *   ?lat=<num>, ?lon=<num>   Required. Quantized to 4 decimals before forward.
 *
 * Response
 * --------
 * Raw MET Norway JSON, unmodified — same shape they document at
 *   https://api.met.no/weatherapi/locationforecast/2.0/documentation
 * Cache-Control: 30 min fresh / 30 min SWR. MET Norway publishes a new run
 * roughly hourly; 30 min is half the cadence so the POP refreshes mid-cycle.
 */

import { jsonError, fetchWithTimeout, CORS_HEADERS } from '../_lib/responses.js';

export const config = { runtime: 'edge' };

const METNO_URL = 'https://api.met.no/weatherapi/locationforecast/2.0/compact';

// MET Norway requires a UA with contact info — they explicitly block requests
// missing this. Override at deploy time via METNO_USER_AGENT if the contact
// changes (we don't want this string drifting from the actual contact).
const METNO_USER_AGENT = process.env.METNO_USER_AGENT
    || 'ParkerPhysics/1.0 (+https://parkersphysics.com; ops@parkersphysics.com)';

const CACHE_TTL = 1800;   // 30 min
const CACHE_SWR = 1800;
const UPSTREAM_TIMEOUT_MS = 8000;

// MET Norway rejects coords with >4 decimals as 403. Truncate (don't round —
// round can push us to a 5th-decimal representation in floating-point).
function quantize4(n) {
    return Math.round(n * 10000) / 10000;
}

export default async function handler(request) {
    const url = new URL(request.url);

    const latStr = url.searchParams.get('lat');
    const lonStr = url.searchParams.get('lon');
    if (latStr == null || latStr === '' || lonStr == null || lonStr === '') {
        return jsonError('invalid_coordinates',
            'lat and lon query params are required',
            { status: 400, maxAge: 300 });
    }
    const lat = Number(latStr);
    const lon = Number(lonStr);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)
        || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
        return jsonError('invalid_coordinates',
            'lat (−90…90) and lon (−180…180) must be finite numbers',
            { status: 400, maxAge: 300 });
    }

    const upstreamUrl = `${METNO_URL}?lat=${quantize4(lat)}&lon=${quantize4(lon)}`;

    let upstream;
    try {
        upstream = await fetchWithTimeout(upstreamUrl, {
            timeoutMs: UPSTREAM_TIMEOUT_MS,
            headers: {
                'User-Agent': METNO_USER_AGENT,
                Accept:       'application/json',
            },
        });
    } catch (e) {
        return jsonError('upstream_unavailable', e.message, { source: 'MET Norway' });
    }

    if (!upstream.ok) {
        const text = await upstream.text().catch(() => '');
        // 429: respect their throttle by caching the error briefly so we
        // don't keep hammering. 403 here usually means UA was rejected —
        // surface it loudly so an operator can fix METNO_USER_AGENT.
        const errorMaxAge = upstream.status === 429 ? 120 : 60;
        return jsonError(
            upstream.status === 429 ? 'upstream_rate_limited' : 'upstream_error',
            text?.slice(0, 500) || `HTTP ${upstream.status}`,
            { status: upstream.status === 429 ? 503 : 502, maxAge: errorMaxAge, source: 'MET Norway' },
        );
    }

    const body = await upstream.text();
    return new Response(body, {
        status:  200,
        headers: {
            'Content-Type':  'application/json',
            'Cache-Control': `public, s-maxage=${CACHE_TTL}, stale-while-revalidate=${CACHE_SWR}`,
            ...CORS_HEADERS,
        },
    });
}
