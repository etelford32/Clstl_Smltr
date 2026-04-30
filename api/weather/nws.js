/**
 * Vercel Edge Function: /api/weather/nws
 *
 * Source: NOAA / National Weather Service api.weather.gov
 *   https://api.weather.gov/points/{lat},{lon}     → grid resolver
 *   https://api.weather.gov/gridpoints/{office}/{gx},{gy}/forecast
 *
 * Why this exists
 * ---------------
 * Authoritative US forecast data straight from the source — no key, no rate
 * limit you'll realistically hit, JSON. Used as a CONUS fallback when
 * Open-Meteo or MET Norway are unavailable, and as a primary for surface-
 * outlook composition where regional accuracy matters.
 *
 * CONUS only: api.weather.gov returns 404 for points outside the US/PR.
 * We surface that as a 404 from this proxy so the caller can fail over.
 *
 * Two-step protocol (handled server-side here):
 *   1. /points/{lat},{lon} → returns gridId / gridX / gridY + forecast URL
 *   2. /gridpoints/{office}/{gx},{gy}/forecast → the actual 7-day forecast
 *
 * Query params
 * ------------
 *   ?lat, ?lon   Required.
 *   ?type=daily  (default) — the multi-day "Tonight / Tomorrow / …" periods
 *   ?type=hourly           — hourly forecast (much larger, ~150 periods)
 *
 * Response
 * --------
 * Pass-through of the upstream gridpoints/forecast payload, plus a small
 * `__nws` envelope with the resolved gridId/gridX/gridY so callers can skip
 * the /points lookup on subsequent requests.
 *
 * Cache: 30 min fresh / 30 min SWR for daily; 15 min / 15 min for hourly
 * (NWS regenerates the gridpoint product roughly hourly).
 */

import { jsonError, fetchWithTimeout, CORS_HEADERS } from '../_lib/responses.js';

export const config = { runtime: 'edge' };

const NWS_BASE = 'https://api.weather.gov';

// NWS strongly recommends a contact User-Agent (they used to require it; now
// optional but they reserve the right to throttle anonymous traffic).
const NWS_USER_AGENT = process.env.NWS_USER_AGENT
    || 'ParkerPhysics/1.0 (+https://parkersphysics.com; ops@parkersphysics.com)';

const CACHE_TTL_DAILY  = 1800;    // 30 min
const CACHE_SWR_DAILY  = 1800;
const CACHE_TTL_HOURLY = 900;     // 15 min
const CACHE_SWR_HOURLY = 900;

const UPSTREAM_TIMEOUT_MS = 8000;

function quantize4(n) {
    return Math.round(n * 10000) / 10000;
}

async function nwsFetch(path) {
    return fetchWithTimeout(`${NWS_BASE}${path}`, {
        timeoutMs: UPSTREAM_TIMEOUT_MS,
        headers: {
            'User-Agent': NWS_USER_AGENT,
            Accept:       'application/geo+json',
        },
    });
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

    const type = (url.searchParams.get('type') || 'daily').toLowerCase();
    if (type !== 'daily' && type !== 'hourly') {
        return jsonError('invalid_type',
            'type must be one of: daily, hourly',
            { status: 400, maxAge: 300 });
    }

    // Step 1: resolve grid.
    let pointsRes;
    try {
        pointsRes = await nwsFetch(`/points/${quantize4(lat)},${quantize4(lon)}`);
    } catch (e) {
        return jsonError('upstream_unavailable', e.message, { source: 'NWS api.weather.gov' });
    }
    if (!pointsRes.ok) {
        // 404 = outside CONUS/PR/AK. Surface that explicitly so callers
        // know to try a different source instead of retrying.
        if (pointsRes.status === 404) {
            return jsonError('out_of_coverage',
                'NWS does not cover this location (CONUS/PR/AK only)',
                { status: 404, maxAge: 86400, source: 'NWS api.weather.gov' });
        }
        const text = await pointsRes.text().catch(() => '');
        return jsonError('upstream_error', text?.slice(0, 300) || `HTTP ${pointsRes.status}`,
            { status: 502, maxAge: 60, source: 'NWS api.weather.gov' });
    }

    let pointsBody;
    try {
        pointsBody = await pointsRes.json();
    } catch (e) {
        return jsonError('parse_error', `points: ${e.message}`,
            { source: 'NWS api.weather.gov' });
    }

    const props = pointsBody?.properties ?? {};
    const forecastUrl = type === 'hourly' ? props.forecastHourly : props.forecast;
    if (!forecastUrl) {
        return jsonError('parse_error', 'NWS /points response missing forecast URL',
            { source: 'NWS api.weather.gov' });
    }

    // Step 2: forecast. Use the absolute URL NWS gave us (already includes
    // query params for unit selection if any).
    let forecastRes;
    try {
        forecastRes = await fetchWithTimeout(forecastUrl, {
            timeoutMs: UPSTREAM_TIMEOUT_MS,
            headers: {
                'User-Agent': NWS_USER_AGENT,
                Accept:       'application/geo+json',
            },
        });
    } catch (e) {
        return jsonError('upstream_unavailable', e.message, { source: 'NWS api.weather.gov' });
    }
    if (!forecastRes.ok) {
        const text = await forecastRes.text().catch(() => '');
        return jsonError('upstream_error',
            text?.slice(0, 300) || `HTTP ${forecastRes.status}`,
            { status: 502, maxAge: 60, source: 'NWS api.weather.gov' });
    }

    let forecastBody;
    try {
        forecastBody = await forecastRes.json();
    } catch (e) {
        return jsonError('parse_error', `forecast: ${e.message}`,
            { source: 'NWS api.weather.gov' });
    }

    // Compose: the forecast payload + a small envelope with grid metadata
    // so callers don't have to re-resolve on subsequent requests.
    const out = {
        ...forecastBody,
        __nws: {
            gridId:   props.gridId,
            gridX:    props.gridX,
            gridY:    props.gridY,
            timeZone: props.timeZone,
            forecastOffice: props.forecastOffice,
        },
    };

    const ttl = type === 'hourly' ? CACHE_TTL_HOURLY : CACHE_TTL_DAILY;
    const swr = type === 'hourly' ? CACHE_SWR_HOURLY : CACHE_SWR_DAILY;
    return new Response(JSON.stringify(out), {
        status:  200,
        headers: {
            'Content-Type':  'application/json',
            'Cache-Control': `public, s-maxage=${ttl}, stale-while-revalidate=${swr}`,
            ...CORS_HEADERS,
        },
    });
}
