/**
 * Vercel Edge Function: /api/donki/flares
 *
 * Proxies NASA DONKI Solar Flare (FLR) endpoint.
 * Enriches each flare with CME linkage info not available in the NOAA flare feed.
 * NASA API key is server-side only (NASA_API_KEY env var).
 *
 * T3 endpoint (15-minute cadence).
 *
 * Query params:
 *   ?days=N   Lookback window in days (default: 7, max: 30)
 *
 * FREE plan: 3 most-recent flares.
 * PRO plan:  full list.
 */
export const config = { runtime: 'edge' };

import { ErrorCodes, createValidator, errorResp, fetchJSON, fmt, jsonResp, validateProToken } from '../_lib/middleware.js';

const DONKI_FLR_BASE = 'https://api.nasa.gov/DONKI/FLR';
const CACHE_TTL      = 900;   // 15 min
const DEFAULT_DAYS   = 7;
const MAX_DAYS       = 30;
const FREE_LIMIT     = 3;

const CLASS_ORDER = { X: 4, M: 3, C: 2, B: 1, A: 0 };


function parseClass(cls) {
    if (!cls || typeof cls !== 'string') return { letter: 'A', number: 1.0 };
    const letter = cls[0].toUpperCase();
    const number = parseFloat(cls.slice(1)) || 1.0;
    return { letter, number };
}

function classRank(cls) {
    const { letter, number } = parseClass(cls);
    return (CLASS_ORDER[letter] ?? 0) * 100 + number;
}

export default async function handler(request) {
    const nasaKey = (typeof process !== 'undefined' && process.env?.NASA_API_KEY) || 'DEMO_KEY';
    const pro     = validateProToken(request);

    const url    = new URL(request.url);
    const rawDay = parseInt(url.searchParams.get('days') ?? DEFAULT_DAYS, 10);
    const days   = Math.max(1, Math.min(isNaN(rawDay) ? DEFAULT_DAYS : rawDay, MAX_DAYS));

    const now   = new Date();
    const start = new Date(now.getTime() - days * 86_400_000);
    const fmt   = d => d.toISOString().slice(0, 10);

    const donkiURL = `${DONKI_FLR_BASE}?startDate=${fmt(start)}&endDate=${fmt(now)}&api_key=${nasaKey}`;

    let raw;
    try {
        raw = await fetchJSON(donkiURL, { timeout: 15000 });
    } catch (e) {
        return errorResp(ErrorCodes.UPSTREAM_UNAVAILABLE, 'Data source temporarily unavailable');
    }

    if (!Array.isArray(raw)) {
        return errorResp(ErrorCodes.PARSE_ERROR, 'Unexpected upstream response format');
    }

    const flares = raw
        .filter(f => f?.beginTime)
        .map(f => {
            const linked = Array.isArray(f.linkedEvents) ? f.linkedEvents : [];
            const { letter, number } = parseClass(f.classType);
            return {
                id:            f.flrID           ?? null,
                begin_time:    fmt.isoTag(f.beginTime),
                peak_time:     fmt.isoTag(f.peakTime)  ?? null,
                end_time:      fmt.isoTag(f.endTime)   ?? null,
                flare_class:   f.classType         ?? null,
                class_letter:  letter,
                class_number:  number,
                location:      f.sourceLocation    ?? null,
                active_region: f.activeRegionNum   ?? null,
                linked_cme:    linked.some(e => String(e.activityID ?? '').includes('CME')),
                linked_events: linked.map(e => e.activityID ?? null).filter(Boolean),
                instruments:   (f.instruments ?? []).map(i => i.displayName ?? i).filter(Boolean),
            };
        })
        .sort((a, b) => classRank(b.flare_class) - classRank(a.flare_class)
                     || (b.begin_time ?? '').localeCompare(a.begin_time ?? ''));

    const limited = pro ? flares : flares.slice(0, FREE_LIMIT);

    return jsonResp({
        source:    'NASA DONKI FLR via Vercel Edge',
        plan:      pro ? 'pro' : 'free',
        data: {
            updated:     new Date().toISOString(),
            flare_count: flares.length,
            shown_count: limited.length,
            flares:      limited,
        },
    });
}
