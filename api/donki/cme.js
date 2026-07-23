/**
 * Vercel Edge Function: /api/donki/cme
 *
 * Proxies NASA DONKI CMEAnalysis endpoint.
 * The NASA API key is injected server-side from the NASA_API_KEY environment
 * variable — it is never exposed in browser JavaScript.
 *
 * T3 endpoint (15-minute cadence).
 *
 * Query modes (two; explicit range wins):
 *   ?days=N                              recent lookback (default 7, max 30)
 *   ?start=YYYY-MM-DD&end=YYYY-MM-DD     explicit historical window (max 60 d)
 *
 * Filters for complete cone-model analyses only and adds an
 * `earth_directed` boolean based on latitude/longitude cone half-angle.
 *
 * Historical windows are immutable; the response is cached on the
 * CDN for 24 h (recent-lookback stays at 15 min so the live page
 * picks up new events promptly).
 */
import { jsonOk, jsonError, fetchWithTimeout, isoTag } from '../_lib/responses.js';

export const config = { runtime: 'edge' };

const DONKI_CME_BASE = 'https://api.nasa.gov/DONKI/CMEAnalysis';
const CACHE_TTL      = 900;   // 15 min
// Long SWR (30 min, matching the prewarm-medium cron cadence): api.nasa.gov
// routinely takes 8-15 s cold. With SWR >= the prewarm interval the CDN can
// ALWAYS serve the previous body instantly and revalidate in background —
// visitors and the status probe never eat NASA's latency directly.
const CACHE_SWR      = 1800;
const DEFAULT_DAYS   = 7;
const MAX_DAYS       = 30;

/** Earth is at lat=0, lon=0 in HEE; an Earth-directed CME has a small
 *  half-width cone that intersects Earth's position. */
function isEarthDirected(lat, lon, halfAngle) {
    if (lat == null || lon == null || halfAngle == null) return false;
    // Approximate: angular distance from (0,0) must be <= halfAngle
    const dist = Math.sqrt(lat * lat + lon * lon);
    return dist <= halfAngle;
}

// Maximum width of an explicit date range. DONKI itself doesn't gate
// historical windows, but a sane ceiling protects the cache + budget.
const MAX_RANGE_DAYS = 60;

function _parseISODate(s) {
    if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    const d = new Date(s + 'T00:00:00Z');
    return isNaN(d) ? null : d;
}

export default async function handler(request) {
    const nasaKey = (typeof process !== 'undefined' && process.env?.NASA_API_KEY) || 'DEMO_KEY';

    const url    = new URL(request.url);

    // Two query modes:
    //   ?days=N (legacy, recent-lookback, default)
    //   ?start=YYYY-MM-DD&end=YYYY-MM-DD (explicit historical window)
    // If both are supplied, the explicit window wins.
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

    const fmt   = d => d.toISOString().slice(0, 10);

    const donkiURL = `${DONKI_CME_BASE}?startDate=${fmt(start)}&endDate=${fmt(end)}&api_key=${nasaKey}`;

    // WSA-ENLIL fetch starts NOW, in parallel with CMEAnalysis. It was
    // previously awaited sequentially after the CME parse, stacking two
    // slow NASA round-trips (10 s + 12 s worst case = 22 s) — enough to
    // blow the status probe's timeout and pin real visitors. Best-effort:
    // resolves to null on any failure, never rejects (an abandoned promise
    // after an early return below must not surface as unhandled).
    const enlilURL = `https://api.nasa.gov/DONKI/WSAEnlilSimulations?startDate=${fmt(start)}&endDate=${fmt(end)}&api_key=${nasaKey}`;
    const enlilPromise = (async () => {
        try {
            const eres = await fetchWithTimeout(enlilURL, {
                headers: { Accept: 'application/json' }, timeoutMs: 12_000,
            });
            if (!eres.ok) return null;
            const sims = await eres.json();
            return Array.isArray(sims) ? sims : null;
        } catch { return null; }
    })();

    let raw;
    try {
        const res = await fetchWithTimeout(donkiURL, { headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        raw = await res.json();
    } catch (e) {
        return jsonError('upstream_unavailable', e.message, { source: 'NASA DONKI' });
    }

    if (!Array.isArray(raw)) {
        return jsonError('parse_error', 'Unexpected DONKI CMEAnalysis format', { source: 'NASA DONKI' });
    }

    let cmes = raw
        .filter(c => c?.time21_5)
        .map(c => {
            const lat       = c.latitude   != null ? parseFloat(c.latitude)   : null;
            const lon       = c.longitude  != null ? parseFloat(c.longitude)  : null;
            const halfAngle = c.halfAngle  != null ? parseFloat(c.halfAngle)  : null;
            const speed     = c.speed      != null ? parseFloat(c.speed)      : null;
            return {
                time:           isoTag(c.time21_5),
                cme_id:         c.associatedCMEID ?? null,
                most_accurate:  c.isMostAccurate === true,
                speed_km_s:     speed,
                latitude_deg:   lat,
                longitude_deg:  lon,
                half_angle_deg: halfAngle,
                type:           c.type     ?? null,
                note:           c.note     ?? null,
                earth_directed: isEarthDirected(lat, lon, halfAngle),
            };
        })
        .sort((a, b) => (b.time ?? '').localeCompare(a.time ?? ''));

    // One row per PHYSICAL CME: DONKI publishes several analyses per event
    // (different fits/instruments). Keep isMostAccurate when present, else
    // the newest analysis; un-IDed rows pass through untouched. Without
    // this the in-flight layer rendered the same CME two or three times.
    {
        const byId = new Map();
        const unIded = [];
        for (const c of cmes) {
            if (!c.cme_id) { unIded.push(c); continue; }
            const prev = byId.get(c.cme_id);
            if (!prev || (c.most_accurate && !prev.most_accurate)) byId.set(c.cme_id, c);
        }
        cmes = [...byId.values(), ...unIded]
            .sort((a, b) => (b.time ?? '').localeCompare(a.time ?? ''));
    }

    // WSA-ENLIL modeled Earth arrivals for the same window — NOAA-grade
    // ETAs the client PREFERS over ballistic (which stays visible as the
    // cross-check). Fetched in parallel above; null on any failure means
    // we degrade to ballistic-only.
    {
        const sims = await enlilPromise;
        if (sims) {
            // cme_id → the newest simulation carrying an Earth shock arrival.
            const byCme = new Map();
            for (const s of sims) {
                if (!s?.estimatedShockArrivalTime) continue;
                for (const inp of s.cmeInputs ?? []) {
                    if (!inp?.cmeid) continue;
                    const prev = byCme.get(inp.cmeid);
                    if (!prev || String(s.modelCompletionTime ?? '') > String(prev.modelCompletionTime ?? '')) {
                        byCme.set(inp.cmeid, s);
                    }
                }
            }
            for (const c of cmes) {
                const s = c.cme_id ? byCme.get(c.cme_id) : null;
                if (!s) continue;
                c.enlil = {
                    shock_arrival: isoTag(s.estimatedShockArrivalTime),
                    duration_h:    s.estimatedDuration != null ? parseFloat(s.estimatedDuration) : null,
                    kp_90:         s.kp_90  ?? null,
                    kp_135:        s.kp_135 ?? null,
                    kp_180:        s.kp_180 ?? null,
                    earth_gb:      s.isEarthGB === true,
                    completed:     isoTag(s.modelCompletionTime),
                };
            }
        }
    }

    const earthCme = cmes.find(c => c.earth_directed) ?? null;
    const isHistorical = !!(explicitStart && explicitEnd);

    return jsonOk({
        source:    'NASA DONKI CMEAnalysis via Vercel Edge',
        // Diagnosability: 'demo' means the shared 30 req/hr DEMO_KEY quota —
        // the usual cause of intermittent 429s on this proxy. Never the key.
        key_mode:  nasaKey === 'DEMO_KEY' ? 'demo' : 'configured',
        data: {
            updated:         new Date().toISOString(),
            window:          {
                start:        fmt(start) + 'T00:00:00Z',
                end:          fmt(end)   + 'T00:00:00Z',
                historical:   isHistorical,
            },
            cme_count:       cmes.length,
            earth_directed:  !!earthCme,
            latest_earth_cme: earthCme,
            cmes,
        },
        // Historical windows are immutable — let CDN cache long.
    }, isHistorical
        ? { maxAge: 86_400, swr: 3600 }
        : { maxAge: CACHE_TTL, swr: CACHE_SWR });
}
