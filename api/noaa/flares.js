/**
 * Vercel Edge Function: /api/noaa/flares
 *
 * Source: NOAA SWPC GOES solar flare events — last 7 days
 *   json/goes/primary/xray-flares-7-day.json
 *
 * T3 endpoint (15-minute cadence).
 *
 * Plan gating:
 *   FREE — last 3 flare events only
 *   PRO  — full 7-day list
 *          Pass Authorization: Bearer <token> to unlock.
 */
export const config = { runtime: 'edge' };

import { ErrorCodes, errorResp, fetchJSON, fmt, jsonResp, validateProToken } from '../../_lib/middleware.js';

const NOAA_FLARES  = 'https://services.swpc.noaa.gov/json/goes/primary/xray-flares-7-day.json';
const CACHE_TTL    = 900;   // 15 min — T3 cadence
const FREE_LIMIT   = 3;


function fluxLetter(cls) {
    if (!cls) return 'A';
    return cls[0].toUpperCase();
}

export default async function handler(request) {
    const pro = validateProToken(request);

    let raw;
    try {
        raw = await fetchJSON(NOAA_FLARES, { timeout: 15000 });
    } catch (e) {
        return errorResp(ErrorCodes.UPSTREAM_UNAVAILABLE, 'Data source temporarily unavailable');
    }

    if (!Array.isArray(raw)) {
        return errorResp(ErrorCodes.PARSE_ERROR, 'Unexpected upstream response format');
    }

    // Parse flare objects — NOAA returns JSON objects (not a 2-D array)
    const flares = raw
        .filter(f => f?.begin_time || f?.peak_time)
        .map(f => ({
            begin_time:    fmt.isoTag(f.begin_time),
            peak_time:     fmt.isoTag(f.peak_time),
            end_time:      fmt.isoTag(f.end_time),
            flare_class:   f.max_class ?? f.class ?? null,
            flare_letter:  fluxLetter(f.max_class ?? f.class),
            location:      f.goes_location ?? f.location ?? null,
            region:        f.noaa_active_region ?? f.region ?? null,
        }))
        .sort((a, b) => (b.peak_time ?? '').localeCompare(a.peak_time ?? ''));

    const limited = pro ? flares : flares.slice(0, FREE_LIMIT);

    return jsonResp({
        source:    'NOAA SWPC GOES xray-flares-7-day via Vercel Edge',
        plan:      pro ? 'pro' : 'free',
        data: {
            updated:      new Date().toISOString(),
            total_count:  flares.length,
            shown_count:  limited.length,
            flares:       limited,
        },
    });
}
