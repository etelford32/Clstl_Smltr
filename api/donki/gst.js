/**
 * Vercel Edge Function: /api/donki/gst
 *
 * Proxies NASA DONKI Geomagnetic Storm (GST) endpoint.
 * Provides event-based storm records with Kp index arrays and CME linkage,
 * complementing the continuous NOAA Dst measurement at /api/noaa/dst.
 * NASA API key is server-side only (NASA_API_KEY env var).
 *
 * T3 endpoint (15-minute cadence).
 *
 * Query params:
 *   ?days=N   Lookback window in days (default: 7, max: 30)
 *
 * Kp → G-scale mapping:
 *   Kp < 5  → G0 (quiet)
 *   Kp 5    → G1
 *   Kp 6    → G2
 *   Kp 7    → G3
 *   Kp 8    → G4
 *   Kp ≥ 9  → G5
 */
export const config = { runtime: 'edge' };

const DONKI_GST_BASE = 'https://api.nasa.gov/DONKI/GST';
const CACHE_TTL      = 900;   // 15 min
const DEFAULT_DAYS   = 7;
const MAX_DAYS       = 30;

function isoTag(t) { return t ? String(t).replace(' ', 'T') + 'Z' : null; }

function kpToGScale(kp) {
    if (kp == null) return 0;
    if (kp >= 9)   return 5;
    if (kp >= 8)   return 4;
    if (kp >= 7)   return 3;
    if (kp >= 6)   return 2;
    if (kp >= 5)   return 1;
    return 0;
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

export default async function handler(request) {
    const nasaKey = (typeof process !== 'undefined' && process.env?.NASA_API_KEY) || 'DEMO_KEY';

    const url    = new URL(request.url);
    const rawDay = parseInt(url.searchParams.get('days') ?? DEFAULT_DAYS, 10);
    const days   = Math.max(1, Math.min(isNaN(rawDay) ? DEFAULT_DAYS : rawDay, MAX_DAYS));

    const now   = new Date();
    const start = new Date(now.getTime() - days * 86_400_000);
    const fmt   = d => d.toISOString().slice(0, 10);

    const donkiURL = `${DONKI_GST_BASE}?startDate=${fmt(start)}&endDate=${fmt(now)}&api_key=${nasaKey}`;

    let raw;
    try {
        const res = await fetch(donkiURL, { headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        raw = await res.json();
    } catch (e) {
        return jsonResp({ error: 'upstream_unavailable', detail: e.message, source: 'NASA DONKI' }, 503, 30);
    }

    if (!Array.isArray(raw)) {
        return jsonResp({ error: 'parse_error', detail: 'Unexpected DONKI GST format' }, 503, 30);
    }

    const events = raw
        .filter(g => g?.startTime)
        .map(g => {
            const kpReadings = Array.isArray(g.allKpIndex)
                ? g.allKpIndex
                    .filter(k => k?.kpIndex != null)
                    .map(k => ({
                        time:   isoTag(k.observedTime),
                        kp:     parseFloat(k.kpIndex),
                        source: k.source ?? null,
                    }))
                : [];

            const maxKp     = kpReadings.length > 0
                ? Math.max(...kpReadings.map(k => k.kp))
                : null;
            const gScale    = kpToGScale(maxKp);
            const linked    = Array.isArray(g.linkedEvents) ? g.linkedEvents : [];

            return {
                id:          g.gstID       ?? null,
                start_time:  isoTag(g.startTime),
                max_kp:      maxKp,
                g_scale:     gScale,
                kp_readings: kpReadings,
                linked_cme:  linked.some(e => String(e.activityID ?? '').includes('CME')),
                linked_events: linked.map(e => e.activityID ?? null).filter(Boolean),
            };
        })
        .sort((a, b) => (b.start_time ?? '').localeCompare(a.start_time ?? ''));

    // Most recent active or recent storm
    const now_ms       = Date.now();
    const recentWindow = 48 * 3_600_000;   // 48 hr
    const currentStorm = events.find(e => {
        const t = e.start_time ? new Date(e.start_time).getTime() : 0;
        return (now_ms - t) < recentWindow && e.g_scale >= 1;
    }) ?? null;

    return jsonResp({
        source: 'NASA DONKI GST via Vercel Edge',
        data: {
            updated:       new Date().toISOString(),
            event_count:   events.length,
            current_storm: currentStorm,
            events,
        },
    });
}
