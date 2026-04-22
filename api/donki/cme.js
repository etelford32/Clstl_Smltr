/**
 * Vercel Edge Function: /api/donki/cme
 *
 * Proxies NASA DONKI CMEAnalysis endpoint.
 * The NASA API key is injected server-side from the NASA_API_KEY environment
 * variable — it is never exposed in browser JavaScript.
 *
 * T3 endpoint (15-minute cadence).
 *
 * Query params forwarded to DONKI:
 *   ?days=N   Lookback window in days (default: 7, max: 30)
 *
 * Filters for complete cone-model analyses only and adds an
 * `earth_directed` boolean based on latitude/longitude cone half-angle.
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

export default async function handler(request) {
    const nasaKey = (typeof process !== 'undefined' && process.env?.NASA_API_KEY) || 'DEMO_KEY';

    const url    = new URL(request.url);
    const rawDay = parseInt(url.searchParams.get('days') ?? DEFAULT_DAYS, 10);
    const days   = Math.max(1, Math.min(isNaN(rawDay) ? DEFAULT_DAYS : rawDay, MAX_DAYS));

    const now   = new Date();
    const start = new Date(now.getTime() - days * 86_400_000);
    const fmt   = d => d.toISOString().slice(0, 10);

    const donkiURL = `${DONKI_CME_BASE}?startDate=${fmt(start)}&endDate=${fmt(now)}&api_key=${nasaKey}`;

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

    return jsonOk({
        source:    'NASA DONKI CMEAnalysis via Vercel Edge',
        data: {
            updated:         new Date().toISOString(),
            cme_count:       cmes.length,
            earth_directed:  !!earthCme,
            latest_earth_cme: earthCme,
            cmes,
        },
    }, { maxAge: CACHE_TTL, swr: CACHE_SWR });
}
