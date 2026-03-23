/**
 * Vercel Edge Function: /api/donki/notifications
 *
 * Proxies NASA DONKI all-event notifications endpoint.
 * NASA API key is server-side only (NASA_API_KEY env var).
 *
 * T3 endpoint (15-minute cadence).
 *
 * Returns the last 7 days of notifications, sorted newest-first.
 * FREE plan: last 5 notifications.
 * PRO plan:  full list.
 */
export const config = { runtime: 'edge' };

const DONKI_NOTIFY_BASE = 'https://api.nasa.gov/DONKI/notifications';
const CACHE_TTL         = 900;
const DEFAULT_DAYS      = 7;
const FREE_LIMIT        = 5;

function isoTag(t) { return t ? String(t).replace(' ', 'T') + 'Z' : null; }

function jsonResp(body, status = 200, maxAge = CACHE_TTL) {
    return Response.json(body, {
        status,
        headers: {
            'Cache-Control':               `public, s-maxage=${maxAge}, stale-while-revalidate=120`,
            'Access-Control-Allow-Origin': '*',
        },
    });
}

function isPro(request) {
    const auth   = request.headers.get('Authorization') ?? '';
    const token  = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const secret = (typeof process !== 'undefined' && process.env?.PRO_SECRET) ?? '';
    return secret.length > 0 && token === secret;
}

export default async function handler(request) {
    const nasaKey = (typeof process !== 'undefined' && process.env?.NASA_API_KEY) || 'DEMO_KEY';
    const pro     = isPro(request);

    const now   = new Date();
    const start = new Date(now.getTime() - DEFAULT_DAYS * 86_400_000);
    const fmt   = d => d.toISOString().slice(0, 10);

    const donkiURL = `${DONKI_NOTIFY_BASE}?type=all&startDate=${fmt(start)}&endDate=${fmt(now)}&api_key=${nasaKey}`;

    let raw;
    try {
        const res = await fetch(donkiURL, { headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        raw = await res.json();
    } catch (e) {
        return jsonResp({ error: 'upstream_unavailable', detail: e.message, source: 'NASA DONKI' }, 503, 30);
    }

    if (!Array.isArray(raw)) {
        return jsonResp({ error: 'parse_error', detail: 'Unexpected DONKI notifications format' }, 503, 30);
    }

    const notes = raw
        .filter(n => n?.messageIssueTime)
        .map(n => ({
            type:        n.messageType   ?? null,
            issue_time:  isoTag(n.messageIssueTime),
            id:          n.messageID     ?? null,
            url:         n.messageURL    ?? null,
            body:        (n.messageBody ?? '').slice(0, 400),   // trim verbose bodies
        }))
        .sort((a, b) => (b.issue_time ?? '').localeCompare(a.issue_time ?? ''));

    const limited = pro ? notes : notes.slice(0, FREE_LIMIT);

    return jsonResp({
        source:    'NASA DONKI notifications via Vercel Edge',
        plan:      pro ? 'pro' : 'free',
        data: {
            updated:       new Date().toISOString(),
            total_count:   notes.length,
            shown_count:   limited.length,
            notifications: limited,
        },
    });
}
