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

const NOAA_ALERTS = 'https://services.swpc.noaa.gov/products/alerts.json';
const CACHE_TTL   = 300;
const MAX_AGE_MS  = 24 * 60 * 60 * 1000;   // 24 hr

function isoTag(t) { return t ? String(t).replace(' ', 'T') + 'Z' : null; }

function jsonResp(body, status = 200, maxAge = CACHE_TTL) {
    return Response.json(body, {
        status,
        headers: {
            'Cache-Control':               `public, s-maxage=${maxAge}, stale-while-revalidate=60`,
            'Access-Control-Allow-Origin': '*',
        },
    });
}

export default async function handler() {
    let raw;
    try {
        const res = await fetch(NOAA_ALERTS, { headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        raw = await res.json();
    } catch (e) {
        return jsonResp({ error: 'upstream_unavailable', detail: e.message, source: 'NOAA SWPC' }, 503, 30);
    }

    if (!Array.isArray(raw)) {
        return jsonResp({ error: 'parse_error', detail: 'Unexpected alerts format' }, 503, 30);
    }

    const now     = Date.now();
    const cutoff  = now - MAX_AGE_MS;

    const alerts = raw
        .filter(a => a?.issue_datetime)
        .map(a => {
            const iso     = isoTag(a.issue_datetime);
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
