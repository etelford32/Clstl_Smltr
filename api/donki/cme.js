/**
 * Vercel Edge Function: /api/donki/cme
 *
 * Source:     NASA DONKI CMEAnalysis
 * Cadence:    T3 (15-minute)
 * Plan gate:  FREE — all CME data is public
 * Params:     ?days=N — lookback window (1-30, default 7)
 *
 * Filters for complete cone-model analyses only and adds an
 * `earth_directed` boolean based on latitude/longitude cone half-angle.
 */
export const config = { runtime: 'edge' };

import {
    jsonResp, errorResp, ErrorCodes,
    fetchJSON, createValidator, fmt,
} from '../_lib/middleware.js';

const DONKI_CME_BASE = 'https://api.nasa.gov/DONKI/CMEAnalysis';
const CACHE_TTL      = 900;

/** Earth is at lat=0, lon=0 in HEE; CME is Earth-directed when
 *  angular distance from (0,0) is within the cone half-angle. */
function isEarthDirected(lat, lon, halfAngle) {
    if (lat == null || lon == null || halfAngle == null) return false;
    return Math.sqrt(lat * lat + lon * lon) <= halfAngle;
}

export default async function handler(request) {
    const nasaKey = (typeof process !== 'undefined' && process.env?.NASA_API_KEY) || 'DEMO_KEY';
    const url = new URL(request.url);
    const v   = createValidator();

    // ── 1. Input validation ──────────────────────────────────────────────
    const days = v.clampInt(url.searchParams.get('days'), 1, 30, 7);

    const now   = new Date();
    const start = new Date(now.getTime() - days * 86_400_000);
    const fmtD  = d => d.toISOString().slice(0, 10);

    // ── 2. Fetch upstream ────────────────────────────────────────────────
    let raw;
    try {
        raw = await fetchJSON(
            `${DONKI_CME_BASE}?startDate=${fmtD(start)}&endDate=${fmtD(now)}&api_key=${nasaKey}`,
            { timeout: 15000 }
        );
    } catch (e) {
        if (e.message === 'request_timeout') {
            return errorResp(ErrorCodes.REQUEST_TIMEOUT, 'NASA DONKI did not respond in time');
        }
        return errorResp(ErrorCodes.UPSTREAM_UNAVAILABLE, 'NASA DONKI is unreachable');
    }

    // ── 3. Parse & transform ─────────────────────────────────────────────
    if (!Array.isArray(raw)) {
        return errorResp(ErrorCodes.PARSE_ERROR, 'Unexpected DONKI CMEAnalysis format');
    }

    const cmes = raw
        .filter(c => c?.time21_5)
        .map(c => {
            const lat       = fmt.safeNum(c.latitude);
            const lon       = fmt.safeNum(c.longitude);
            const halfAngle = fmt.safeNum(c.halfAngle);
            const speed     = fmt.safeNum(c.speed);
            return {
                time:           fmt.isoTag(c.time21_5),
                speed_km_s:     speed,
                latitude_deg:   lat,
                longitude_deg:  lon,
                half_angle_deg: halfAngle,
                type:           c.type ?? null,
                note:           c.note ? String(c.note).slice(0, 500) : null,
                earth_directed: isEarthDirected(lat, lon, halfAngle),
            };
        })
        .sort((a, b) => (b.time ?? '').localeCompare(a.time ?? ''));

    const earthCme = cmes.find(c => c.earth_directed) ?? null;

    // ── 4. Build response ────────────────────────────────────────────────
    return jsonResp({
        source: 'NASA DONKI CMEAnalysis via Parker Physics API',
        data: {
            updated:          new Date().toISOString(),
            cme_count:        cmes.length,
            earth_directed:   !!earthCme,
            latest_earth_cme: earthCme,
            cmes,
        },
    }, 200, CACHE_TTL);
}
