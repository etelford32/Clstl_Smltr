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

const NOAA_FLARES  = 'https://services.swpc.noaa.gov/json/goes/primary/xray-flares-7-day.json';
const CACHE_TTL    = 900;   // 15 min — T3 cadence
const FREE_LIMIT   = 3;

function isoTag(t) { return t ? String(t).replace(' ', 'T') + 'Z' : null; }

function fluxLetter(cls) {
    if (!cls) return 'A';
    return cls[0].toUpperCase();
}

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
    // Constant-time comparison to prevent timing attacks
    if (!secret.length || secret.length !== token.length) return false;
    let r = 0; for (let i = 0; i < secret.length; i++) r |= secret.charCodeAt(i) ^ token.charCodeAt(i);
    return r === 0;
}

export default async function handler(request) {
    const pro = isPro(request);

    let raw;
    try {
        const res = await fetch(NOAA_FLARES, { headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        raw = await res.json();
    } catch (e) {
        return jsonResp({ error: 'upstream_unavailable', detail: e.message, source: 'NOAA SWPC' }, 503, 30);
    }

    if (!Array.isArray(raw)) {
        return jsonResp({ error: 'parse_error', detail: 'Unexpected xray-flares format' }, 503, 30);
    }

    // Parse flare objects — NOAA returns JSON objects (not a 2-D array)
    const flares = raw
        .filter(f => f?.begin_time || f?.peak_time)
        .map(f => ({
            begin_time:    isoTag(f.begin_time),
            peak_time:     isoTag(f.peak_time),
            end_time:      isoTag(f.end_time),
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
