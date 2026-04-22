/**
 * Vercel Edge Function: /api/weather/forecast
 *
 * Typed proxy for Open-Meteo. Replaces three direct browser → Open-Meteo
 * call sites in js/trip-planner.js (fetchPointForecast, fetchLaunchForecast,
 * fetchMarineForecast) so we get three wins at once:
 *
 *   1. Edge cache dedup — a launch-planner pageview triggers up to ~150 pad
 *      forecasts. With 1 000 concurrent users that was 150 000 calls/hr to
 *      Open-Meteo's free endpoint. Through this proxy, 1 000 users sharing
 *      the same pad coords collapse to ONE upstream hit per 15 min cache
 *      window. Roughly 1 000× reduction.
 *   2. No CORS preflight — direct browser → api.open-meteo.com with a long
 *      query string triggers an OPTIONS preflight on every unique URL
 *      (~150 ms tax each). Same-origin calls to /api/* skip preflight.
 *   3. Graceful degradation — stale-while-revalidate=600 serves 10-min-old
 *      cached data when Open-Meteo hiccups, instead of every tab seeing
 *      a fetch failure simultaneously.
 *
 * ── Why typed (vs. passthrough) ────────────────────────────────────────────
 * A passthrough proxy (forward arbitrary Open-Meteo params) would be simpler
 * to build but defeats cache dedup — every caller variation produces a new
 * cache key. Typed proxy means the client sends `?type=launch&lat=X&lon=Y`
 * and server expands that into the canonical parameter set. Short, stable
 * client URLs → high hit rate.
 *
 * ── Query params ────────────────────────────────────────────────────────────
 *   ?type=point|launch|marine   Required.
 *     point   — 3-day current + daily, for dashboard/trip cards
 *     launch  — 7-day current + hourly + daily, with pressure-level winds,
 *               convective indices, cloud-layer decomposition, freezing
 *               level. Feeds the launch-planner scorer.
 *     marine  — 5-day wave/swell/ocean-current. Recovery-zone scoring.
 *   ?lat=<num>, ?lon=<num>      Required. Quantized to 3dp on the way in
 *                               so near-duplicate coords share cache keys.
 *   ?days=<int>                 Optional. Forecast horizon. Clamped per type.
 *
 * ── Response ───────────────────────────────────────────────────────────────
 * Raw Open-Meteo JSON, unmodified. Trip-planner.js parses it directly.
 * Content-Type: application/json. Cache-Control: 15-min fresh / 10-min SWR.
 * On upstream failure: 503 with { error, detail, source } via shared helper.
 */

import { jsonError, fetchWithTimeout, CORS_HEADERS } from '../_lib/responses.js';

export const config = { runtime: 'edge' };

// Open-Meteo endpoints. Marine goes to a separate subdomain; everything
// else lives on the main forecast API.
const OPEN_METEO_FORECAST = 'https://api.open-meteo.com/v1/forecast';
const OPEN_METEO_MARINE   = 'https://marine-api.open-meteo.com/v1/marine';
// Historical archive is served from a separate subdomain — not the live
// forecast API. Data horizon reaches back ~80 years; we only ask for the
// last 90 days because that's what temp-forecast.js's regression needs.
const OPEN_METEO_ARCHIVE  = 'https://archive-api.open-meteo.com/v1/archive';

// Cache tuning — two tiers, chosen per type:
//   FORECAST tier (point / launch / marine): Open-Meteo's deterministic
//     models refresh hourly. 15 min s-maxage guarantees at least one
//     refresh per model cycle without hammering the upstream.
//   ARCHIVE tier (archive): historical daily temps are effectively
//     immutable for the last ~30 days — they don't change until the next
//     reanalysis run, days later. Cache 24 hr + long SWR window.
const CACHE_TTL_FORECAST = 900;    // 15 min
const CACHE_SWR_FORECAST = 600;    // 10 min stale tolerance
const CACHE_TTL_ARCHIVE  = 86400;  // 24 hr
const CACHE_SWR_ARCHIVE  = 43200;  // 12 hr — long SWR is free for historical

// Tight upstream timeout. Open-Meteo's p99 is ~2 s under healthy conditions;
// 8 s gives comfortable headroom for cold-region fetches without pinning
// an Edge worker when upstream is actually dead.
const UPSTREAM_TIMEOUT_MS = 8000;

// Lat/lon precision. 3dp ≈ 110 m, which is WAY under Open-Meteo's coarsest
// model grid (~11 km GFS, ~3 km high-res). Anything finer just fragments
// the cache without any forecast difference. Matches the quantization
// trip-planner.js applies on the client side.
const COORD_DECIMALS = 3;

// Per-type spec: default forecast horizon, max allowed, upstream endpoint,
// parameter builder, and which cache tier to apply. `archive` is the only
// non-forecast tier; everything else shares the 15-min forecast cache.
const TYPE_SPECS = Object.freeze({
    point: {
        defaultDays: 3,
        maxDays:     7,
        upstream:    OPEN_METEO_FORECAST,
        build:       buildPointParams,
        cacheTier:   'forecast',
    },
    launch: {
        defaultDays: 7,
        maxDays:     7,          // Open-Meteo free plan forecast horizon
        upstream:    OPEN_METEO_FORECAST,
        build:       buildLaunchParams,
        cacheTier:   'forecast',
    },
    marine: {
        defaultDays: 5,
        maxDays:     7,
        upstream:    OPEN_METEO_MARINE,
        build:       buildMarineParams,
        cacheTier:   'forecast',
    },
    // Historical daily temperatures — feeds temp-forecast.js's local
    // ridge-regression model. The client requests N days of lookback via
    // `days`; we clamp to [14, 365] because <14 days can't fit a
    // meaningful regression, and >365 exceeds what Open-Meteo's archive
    // returns in a single call without pagination.
    archive: {
        defaultDays: 90,
        maxDays:     365,
        minDays:     14,
        upstream:    OPEN_METEO_ARCHIVE,
        build:       buildArchiveParams,
        cacheTier:   'archive',
    },
});

// ── Parameter-set builders ──────────────────────────────────────────────────
// Kept separate per type. Adding fields here is the ONLY touchpoint when
// the scorer wants a new signal; trip-planner.js picks it up from the
// passthrough response.

function buildPointParams(lat, lon, days) {
    return new URLSearchParams({
        latitude:  lat.toFixed(COORD_DECIMALS),
        longitude: lon.toFixed(COORD_DECIMALS),
        current: [
            'temperature_2m', 'apparent_temperature',
            'relative_humidity_2m', 'cloud_cover', 'is_day', 'weather_code',
            'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m',
            'precipitation', 'pressure_msl',
        ].join(','),
        // cloud_cover_mean + wind_speed_10m_max are extra daily aggregates
        // temp-forecast.js's GFS ensemble reads; including them in the
        // default `point` response (a few kB of extra JSON) lets temp-
        // forecast share the same cache key as the dashboard card instead
        // of fragmenting cache with a near-duplicate request.
        daily: [
            'temperature_2m_max', 'temperature_2m_min',
            'precipitation_sum', 'precipitation_probability_max',
            'cloud_cover_mean',  'wind_speed_10m_max',
            'sunrise', 'sunset', 'uv_index_max',
        ].join(','),
        temperature_unit: 'fahrenheit',
        wind_speed_unit:  'mph',
        timezone:         'auto',
        forecast_days:    String(days),
    });
}

function buildLaunchParams(lat, lon, days) {
    return new URLSearchParams({
        latitude:  lat.toFixed(COORD_DECIMALS),
        longitude: lon.toFixed(COORD_DECIMALS),
        current: [
            'temperature_2m', 'apparent_temperature',
            'relative_humidity_2m', 'cloud_cover', 'is_day', 'weather_code',
            'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m',
            'precipitation', 'pressure_msl',
        ].join(','),
        // Hourly set includes everything the launch-planner scorer reads:
        // surface wind/precip/cloud, cloud-layer decomposition + freezing
        // level (LLCC anvil/thick-layer proxies), convective triplet
        // (CAPE/LI/CIN for lightning-risk), and pressure-level winds at
        // 200/300/500 hPa for max-Q shear analysis.
        hourly: [
            'temperature_2m',
            'wind_speed_10m', 'wind_gusts_10m', 'wind_direction_10m',
            'precipitation', 'precipitation_probability',
            'cloud_cover', 'weather_code',
            'cloud_cover_low', 'cloud_cover_mid', 'cloud_cover_high',
            'freezing_level_height',
            'relative_humidity_2m', 'visibility',
            'cape', 'lifted_index', 'convective_inhibition',
            'wind_speed_500hPa', 'wind_direction_500hPa',
            'wind_speed_300hPa', 'wind_direction_300hPa',
            'wind_speed_200hPa', 'wind_direction_200hPa',
        ].join(','),
        daily: [
            'temperature_2m_max', 'temperature_2m_min',
            'precipitation_sum', 'precipitation_probability_max',
            'sunrise', 'sunset', 'uv_index_max',
        ].join(','),
        temperature_unit: 'fahrenheit',
        wind_speed_unit:  'mph',
        timezone:         'auto',
        forecast_days:    String(days),
    });
}

/**
 * Historical daily temperatures for the last `days` days.
 * Endpoint differs from the forecast API — requires start_date + end_date
 * rather than forecast_days. Values are reanalysis-grade and don't change
 * for dates >30 days old, so this tier caches aggressively (24 hr).
 */
function buildArchiveParams(lat, lon, days) {
    // Query window ends yesterday (archive data lags 1–2 days behind real
    // time) and extends `days` back. ISO-date-only format is what the
    // archive API accepts.
    const end   = new Date(Date.now() - 86_400_000);   // yesterday
    const start = new Date(end.getTime() - days * 86_400_000);
    const fmt   = d => d.toISOString().slice(0, 10);
    return new URLSearchParams({
        latitude:   lat.toFixed(COORD_DECIMALS),
        longitude:  lon.toFixed(COORD_DECIMALS),
        start_date: fmt(start),
        end_date:   fmt(end),
        daily:      'temperature_2m_max,temperature_2m_min',
        temperature_unit: 'fahrenheit',
        timezone:   'auto',
    });
}

function buildMarineParams(lat, lon, days) {
    return new URLSearchParams({
        latitude:  lat.toFixed(COORD_DECIMALS),
        longitude: lon.toFixed(COORD_DECIMALS),
        current: [
            'wave_height', 'wave_direction', 'wave_period',
            'wind_wave_height', 'wind_wave_period',
            'swell_wave_height', 'swell_wave_period', 'swell_wave_direction',
            'ocean_current_velocity',
        ].join(','),
        hourly: [
            'wave_height', 'wave_direction', 'wave_period',
            'wind_wave_height', 'wind_wave_direction', 'wind_wave_period',
            'swell_wave_height', 'swell_wave_direction', 'swell_wave_period',
        ].join(','),
        timezone:      'auto',
        forecast_days: String(days),
    });
}

// ── Handler ─────────────────────────────────────────────────────────────────

export default async function handler(request) {
    const url = new URL(request.url);

    const type = url.searchParams.get('type') || '';
    const spec = TYPE_SPECS[type];
    if (!spec) {
        // Client bug — cache briefly to stop misconfigured loops from
        // hitting Open-Meteo via the proxy path.
        return jsonError('invalid_type',
            `type must be one of: ${Object.keys(TYPE_SPECS).join(', ')}`,
            { status: 400, maxAge: 300 });
    }

    // Explicit presence check — `Number('')` and `Number(null)` both return
    // 0, which would silently validate as the (legal) Null Island coords.
    // Reject missing params up front so debugging misses reports "lat missing"
    // instead of "Gulf of Guinea forecast is wrong."
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

    const rawDays = parseInt(url.searchParams.get('days') ?? String(spec.defaultDays), 10);
    const minDays = spec.minDays ?? 1;
    const days    = Math.max(minDays,
                             Math.min(spec.maxDays,
                                      Number.isFinite(rawDays) ? rawDays : spec.defaultDays));

    // Defensive quantization even if the client didn't already round —
    // keeps the upstream URL deterministic, which is what Open-Meteo
    // needs to return cacheable responses on its side too.
    const qLat = Number(lat.toFixed(COORD_DECIMALS));
    const qLon = Number(lon.toFixed(COORD_DECIMALS));

    const upstreamUrl = `${spec.upstream}?${spec.build(qLat, qLon, days)}`;

    let upstream;
    try {
        upstream = await fetchWithTimeout(upstreamUrl, {
            timeoutMs: UPSTREAM_TIMEOUT_MS,
            headers:   { Accept: 'application/json' },
        });
    } catch (e) {
        // Timeout / network error. Shared helper caches the error briefly
        // so a dead upstream doesn't amplify into retry storms.
        return jsonError('upstream_unavailable', e.message, { source: 'Open-Meteo' });
    }

    if (!upstream.ok) {
        // Open-Meteo signals rate-limit via 429. Cache 429s a bit longer
        // than generic errors so we back off automatically; the frontend
        // will fall back to session-storage snapshot during the window.
        const errorMaxAge = upstream.status === 429 ? 120 : 60;
        const text = await upstream.text().catch(() => '');
        return jsonError(
            upstream.status === 429 ? 'upstream_rate_limited' : 'upstream_error',
            text?.slice(0, 500) || `HTTP ${upstream.status}`,
            { status: upstream.status === 429 ? 503 : 502, maxAge: errorMaxAge, source: 'Open-Meteo' },
        );
    }

    // Passthrough the upstream body verbatim. No re-serialization cost,
    // and trip-planner.js keeps its existing parse logic.
    const body = await upstream.text();
    const ttl  = spec.cacheTier === 'archive' ? CACHE_TTL_ARCHIVE : CACHE_TTL_FORECAST;
    const swr  = spec.cacheTier === 'archive' ? CACHE_SWR_ARCHIVE : CACHE_SWR_FORECAST;
    return new Response(body, {
        status:  200,
        headers: {
            'Content-Type':  'application/json',
            'Cache-Control': `public, s-maxage=${ttl}, stale-while-revalidate=${swr}`,
            ...CORS_HEADERS,
        },
    });
}
