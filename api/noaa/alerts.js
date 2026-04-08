/**
 * Vercel Edge Function: /api/noaa/alerts
 *
 * Source: NOAA SWPC space weather alerts / warnings / watches
 *   products/alerts.json
 *
 * T2 endpoint (5-minute cadence).
 * Returns the list of active alerts parsed into a clean, flat structure.
 * Only alerts/watches/warnings issued within the last 24 hours are returned.
 */
export const config = { runtime: 'edge' };

import { ErrorCodes, errorResp, fetchJSON, fmt, jsonResp } from '../_lib/middleware.js';

const NOAA_ALERTS = 'https://services.swpc.noaa.gov/products/alerts.json';
const CACHE_TTL   = 300;
const MAX_AGE_MS  = 24 * 60 * 60 * 1000;   // 24 hr


export default async function handler() {
    let raw;
    try {
        raw = await fetchJSON(NOAA_ALERTS, { timeout: 15000 });
    } catch (e) {
        return errorResp(ErrorCodes.UPSTREAM_UNAVAILABLE, 'Data source temporarily unavailable');
    }

    if (!Array.isArray(raw)) {
        return errorResp(ErrorCodes.PARSE_ERROR, 'Unexpected upstream response format');
    }

    const now     = Date.now();
    const cutoff  = now - MAX_AGE_MS;

    const alerts = raw
        .filter(a => a?.issue_datetime)
        .map(a => {
            const iso     = fmt.isoTag(a.issue_datetime);
            const issued  = iso ? new Date(iso).getTime() : 0;
            return {
                product_id:   a.product_id ?? null,
                issue_time:   iso,
                message:      (a.message ?? '').trim(),
                issued_ms:    issued,
            };
        })
        .filter(a => a.issued_ms >= cutoff)
        .sort((a, b) => b.issued_ms - a.issued_ms)
        .map(({ issued_ms: _drop, ...rest }) => rest);  // strip internal sort key

    return jsonResp({
        source:    'NOAA SWPC products/alerts via Vercel Edge',
        data: {
            updated:       new Date(now).toISOString(),
            active_count:  alerts.length,
            alerts,
        },
    });
}
