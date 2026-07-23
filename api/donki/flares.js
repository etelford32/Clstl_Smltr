/**
 * Vercel Edge Function: /api/donki/flares
 *
 * Proxies NASA DONKI Solar Flare (FLR) endpoint.
 * Enriches each flare with CME linkage info not available in the NOAA flare feed.
 * NASA API key is server-side only (NASA_API_KEY env var).
 *
 * T3 endpoint (15-minute cadence) for recent-lookback mode; 24-hour CDN
 * cache on historical-range mode.
 *
 * Query modes (two; explicit range wins):
 *   ?days=N                              recent lookback (default 7, max 30)
 *   ?start=YYYY-MM-DD&end=YYYY-MM-DD     explicit historical window (max 60 d)
 *
 * FREE plan: 3 most-recent flares (recent-lookback only).
 * PRO plan:  full list. Historical ranges always return the full list
 *            (case studies need the complete catalog).
 */
import { jsonOk, jsonError, fetchWithTimeout, isoTag } from '../_lib/responses.js';

export const config = { runtime: 'edge' };

const DONKI_FLR_BASE = 'https://api.nasa.gov/DONKI/FLR';
const CACHE_TTL      = 900;   // 15 min
const CACHE_SWR      = 120;
const DEFAULT_DAYS   = 7;
const MAX_DAYS       = 30;
const MAX_RANGE_DAYS = 60;
const FREE_LIMIT     = 3;

function _parseISODate(s) {
    if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    const d = new Date(s + 'T00:00:00Z');
    return isNaN(d) ? null : d;
}

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

function isPro(request) {
    const auth   = request.headers.get('Authorization') ?? '';
    const token  = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const secret = (typeof process !== 'undefined' && process.env?.PRO_SECRET) ?? '';
    return secret.length > 0 && token === secret;
}

export default async function handler(request) {
    const nasaKey = (typeof process !== 'undefined' && process.env?.NASA_API_KEY) || 'DEMO_KEY';
    const pro     = isPro(request);

    const url           = new URL(request.url);
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

    const isHistorical = !!(explicitStart && explicitEnd);
    const fmt   = d => d.toISOString().slice(0, 10);

    const donkiURL = `${DONKI_FLR_BASE}?startDate=${fmt(start)}&endDate=${fmt(end)}&api_key=${nasaKey}`;

    let raw;
    try {
        const res = await fetchWithTimeout(donkiURL, { headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        raw = await res.json();
    } catch (e) {
        return jsonError('upstream_unavailable', e.message, { source: 'NASA DONKI' });
    }

    if (!Array.isArray(raw)) {
        return jsonError('parse_error', 'Unexpected DONKI FLR format', { source: 'NASA DONKI' });
    }

    const flares = raw
        .filter(f => f?.beginTime)
        .map(f => {
            const linked = Array.isArray(f.linkedEvents) ? f.linkedEvents : [];
            const { letter, number } = parseClass(f.classType);
            return {
                id:            f.flrID           ?? null,
                begin_time:    isoTag(f.beginTime),
                peak_time:     isoTag(f.peakTime)  ?? null,
                end_time:      isoTag(f.endTime)   ?? null,
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

    // Historical-range queries always return the full list (case studies
    // need the whole catalog and the data is immutable). Recent-lookback
    // honours the FREE/PRO gate.
    const limited = (isHistorical || pro) ? flares : flares.slice(0, FREE_LIMIT);

    return jsonOk({
        source:    'NASA DONKI FLR via Vercel Edge',
        key_mode:  nasaKey === 'DEMO_KEY' ? 'demo' : 'configured',
        plan:      pro ? 'pro' : 'free',
        data: {
            updated:     new Date().toISOString(),
            window:      {
                start:        fmt(start) + 'T00:00:00Z',
                end:          fmt(end)   + 'T00:00:00Z',
                historical:   isHistorical,
            },
            flare_count: flares.length,
            shown_count: limited.length,
            flares:      limited,
        },
    }, isHistorical
        ? { maxAge: 86_400, swr: 3600 }
        : { maxAge: CACHE_TTL, swr: CACHE_SWR });
}
