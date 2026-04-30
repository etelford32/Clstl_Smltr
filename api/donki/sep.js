/**
 * Vercel Edge Function: /api/donki/sep
 *
 * Proxies NASA DONKI Solar Energetic Particle (SEP) event endpoint.
 * Provides event-based SEP records complementing the continuous GOES proton
 * flux measurement at /api/noaa/protons.
 * NASA API key is server-side only (NASA_API_KEY env var).
 *
 * T3 endpoint (15-minute cadence).
 *
 * Query params:
 *   ?days=N   Lookback window in days (default: 7, max: 30)
 *
 * SEP events indicate that the particle environment crossed threshold —
 * useful for event-based detection vs. the continuous flux measurement.
 * A `recent_event` within 24 hr signals an active radiation storm.
 */
import { jsonOk, jsonError, fetchWithTimeout, isoTag } from '../_lib/responses.js';

export const config = { runtime: 'edge' };

const DONKI_SEP_BASE = 'https://api.nasa.gov/DONKI/SEP';
const CACHE_TTL      = 900;   // 15 min
const CACHE_SWR      = 120;
const DEFAULT_DAYS   = 7;
const MAX_DAYS       = 30;

export default async function handler(request) {
    const nasaKey = (typeof process !== 'undefined' && process.env?.NASA_API_KEY) || 'DEMO_KEY';

    const url    = new URL(request.url);
    const rawDay = parseInt(url.searchParams.get('days') ?? DEFAULT_DAYS, 10);
    const days   = Math.max(1, Math.min(isNaN(rawDay) ? DEFAULT_DAYS : rawDay, MAX_DAYS));

    const now   = new Date();
    const start = new Date(now.getTime() - days * 86_400_000);
    const fmt   = d => d.toISOString().slice(0, 10);

    const donkiURL = `${DONKI_SEP_BASE}?startDate=${fmt(start)}&endDate=${fmt(now)}&api_key=${nasaKey}`;

    let raw;
    try {
        const res = await fetchWithTimeout(donkiURL, { headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        raw = await res.json();
    } catch (e) {
        return jsonError('upstream_unavailable', e.message, { source: 'NASA DONKI' });
    }

    if (!Array.isArray(raw)) {
        return jsonError('parse_error', 'Unexpected DONKI SEP format', { source: 'NASA DONKI' });
    }

    const events = raw
        .filter(s => s?.eventTime)
        .map(s => {
            const linked = Array.isArray(s.linkedEvents) ? s.linkedEvents : [];
            return {
                id:            s.sepID        ?? null,
                event_time:    isoTag(s.eventTime),
                instruments:   (s.instruments ?? []).map(i => i.displayName ?? i).filter(Boolean),
                linked_flare:  linked.some(e => String(e.activityID ?? '').includes('FLR')),
                linked_cme:    linked.some(e => String(e.activityID ?? '').includes('CME')),
                linked_events: linked.map(e => e.activityID ?? null).filter(Boolean),
            };
        })
        .sort((a, b) => (b.event_time ?? '').localeCompare(a.event_time ?? ''));

    // Flag if any SEP event started within the last 24 hours
    const activeWindow  = 24 * 3_600_000;
    const now_ms        = Date.now();
    const recentEvent   = events.find(e => {
        const t = e.event_time ? new Date(e.event_time).getTime() : 0;
        return (now_ms - t) < activeWindow;
    }) ?? null;
    const radiationStormActive = !!recentEvent;

    return jsonOk({
        source: 'NASA DONKI SEP via Vercel Edge',
        data: {
            updated:                new Date().toISOString(),
            event_count:            events.length,
            radiation_storm_active: radiationStormActive,
            recent_event:           recentEvent,
            events,
        },
    }, { maxAge: CACHE_TTL, swr: CACHE_SWR });
}
