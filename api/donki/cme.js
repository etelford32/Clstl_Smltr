/**
 * Vercel Edge Function: /api/donki/cme
 *
 * Proxies NASA DONKI CMEAnalysis endpoint.
 * The NASA API key is injected server-side from the NASA_API_KEY environment
 * variable — it is never exposed in browser JavaScript.
 *
 * T3 endpoint (15-minute cadence).
 *
 * Query modes (two; explicit range wins):
 *   ?days=N                              recent lookback (default 7, max 30)
 *   ?start=YYYY-MM-DD&end=YYYY-MM-DD     explicit historical window (max 60 d)
 *
 * Filters for complete cone-model analyses only and adds an
 * `earth_directed` boolean based on latitude/longitude cone half-angle.
 *
 * Historical windows are immutable; the response is cached on the
 * CDN for 24 h (recent-lookback stays at 15 min so the live page
 * picks up new events promptly).
 */
import { jsonOk, jsonError, fetchWithTimeout, isoTag } from '../_lib/responses.js';

export const config = { runtime: 'edge' };

const DONKI_CME_BASE = 'https://api.nasa.gov/DONKI/CMEAnalysis';
const CACHE_TTL      = 900;   // 15 min
const CACHE_SWR      = 120;
const DEFAULT_DAYS   = 7;
const MAX_DAYS       = 30;

/** Earth is at lat=0, lon=0 in HEE; an Earth-directed CME has a small
 *  half-width cone that intersects Earth's position. */
function isEarthDirected(lat, lon, halfAngle) {
    if (lat == null || lon == null || halfAngle == null) return false;
    // Approximate: angular distance from (0,0) must be <= halfAngle
    const dist = Math.sqrt(lat * lat + lon * lon);
    return dist <= halfAngle;
}

// Maximum width of an explicit date range. DONKI itself doesn't gate
// historical windows, but a sane ceiling protects the cache + budget.
const MAX_RANGE_DAYS = 60;

function _parseISODate(s) {
    if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    const d = new Date(s + 'T00:00:00Z');
    return isNaN(d) ? null : d;
}

export default async function handler(request) {
    const nasaKey = (typeof process !== 'undefined' && process.env?.NASA_API_KEY) || 'DEMO_KEY';

    const url    = new URL(request.url);

    // Two query modes:
    //   ?days=N (legacy, recent-lookback, default)
    //   ?start=YYYY-MM-DD&end=YYYY-MM-DD (explicit historical window)
    // If both are supplied, the explicit window wins.
    const explicitStart = _parseISODate(url.searchParams.get('start'));
    const explicitEnd   = _parseISODate(url.searchParams.get('end'));

    let start, end;
    if (explicitStart && explicitEnd) {
        if (explicitEnd <= explicitStart) {
            return jsonError('bad_request', 'end must be after start',
                { source: 'NASA DONKI' });
        }
        const rangeDays = (explicitEnd - explicitStart) / 86_400_000;
        if (rangeDays > MAX_RANGE_DAYS) {
            return jsonError('bad_request',
                `range exceeds ${MAX_RANGE_DAYS}-day cap (got ${rangeDays.toFixed(1)} d)`,
                { source: 'NASA DONKI' });
        }
        start = explicitStart;
        end   = explicitEnd;
    } else {
        const rawDay = parseInt(url.searchParams.get('days') ?? DEFAULT_DAYS, 10);
        const days   = Math.max(1, Math.min(isNaN(rawDay) ? DEFAULT_DAYS : rawDay, MAX_DAYS));
        end   = new Date();
        start = new Date(end.getTime() - days * 86_400_000);
    }

    const fmt   = d => d.toISOString().slice(0, 10);

    const donkiURL = `${DONKI_CME_BASE}?startDate=${fmt(start)}&endDate=${fmt(end)}&api_key=${nasaKey}`;

    let raw;
    try {
        const res = await fetchWithTimeout(donkiURL, { headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        raw = await res.json();
    } catch (e) {
        return jsonError('upstream_unavailable', e.message, { source: 'NASA DONKI' });
    }

    if (!Array.isArray(raw)) {
        return jsonError('parse_error', 'Unexpected DONKI CMEAnalysis format', { source: 'NASA DONKI' });
    }

    const cmes = raw
        .filter(c => c?.time21_5)
        .map(c => {
            const lat       = c.latitude   != null ? parseFloat(c.latitude)   : null;
            const lon       = c.longitude  != null ? parseFloat(c.longitude)  : null;
            const halfAngle = c.halfAngle  != null ? parseFloat(c.halfAngle)  : null;
            const speed     = c.speed      != null ? parseFloat(c.speed)      : null;
            return {
                time:           isoTag(c.time21_5),
                speed_km_s:     speed,
                latitude_deg:   lat,
                longitude_deg:  lon,
                half_angle_deg: halfAngle,
                type:           c.type     ?? null,
                note:           c.note     ?? null,
                earth_directed: isEarthDirected(lat, lon, halfAngle),
            };
        })
        .sort((a, b) => (b.time ?? '').localeCompare(a.time ?? ''));

    const earthCme = cmes.find(c => c.earth_directed) ?? null;
    const isHistorical = !!(explicitStart && explicitEnd);

    return jsonOk({
        source:    'NASA DONKI CMEAnalysis via Vercel Edge',
        data: {
            updated:         new Date().toISOString(),
            window:          {
                start:        fmt(start) + 'T00:00:00Z',
                end:          fmt(end)   + 'T00:00:00Z',
                historical:   isHistorical,
            },
            cme_count:       cmes.length,
            earth_directed:  !!earthCme,
            latest_earth_cme: earthCme,
            cmes,
        },
        // Historical windows are immutable — let CDN cache long.
    }, isHistorical
        ? { maxAge: 86_400, swr: 3600 }
        : { maxAge: CACHE_TTL, swr: CACHE_SWR });
}
