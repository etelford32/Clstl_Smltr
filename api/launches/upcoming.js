/**
 * Vercel Edge Function: /api/launches/upcoming
 *
 * Proxies Launch Library 2 (The Space Devs) upcoming-launch feed and projects
 * its heavyweight response down to the fields the Launch Planner page needs:
 * id, vehicle, provider, pad coordinates, NET and window bounds, status, and
 * mission blurb.
 *
 * LL2 is free, CORS-friendly, and unauthenticated, but it rate-limits
 * anonymous traffic aggressively (≈15 req / hour per IP). This Edge proxy
 * fans out one upstream call to the Vercel CDN so visitors share a single
 * cached response for an hour.
 *
 * Query params:
 *   ?limit=<n>        Max launches (1-100, default 50)
 *   ?window_days=<n>  Only include launches with NET within N days (default 90)
 *
 * Response shape (consumed by js/launch-planner.js):
 *   {
 *     source:     "thespacedevs/ll2",
 *     fetched_at: "2026-…Z",
 *     count:      N,
 *     launches:   [ {
 *       id, name, slug, status, mission, vehicle, provider,
 *       pad: { name, lat, lon, location, country_code, wiki },
 *       net_iso, window_start_iso, window_end_iso, probability_pct,
 *       image, info_url
 *     } ]
 *   }
 */

import { jsonOk, jsonError, fetchWithTimeout } from '../_lib/responses.js';

export const config = { runtime: 'edge' };

const LL2_BASE  = 'https://ll.thespacedevs.com/2.3.0/launches/upcoming/';
const CACHE_TTL = 3600;  // 1 hour — launch schedules shift slowly
const CACHE_SWR = 300;   // launch feed tolerates a wider SWR than NOAA nowcasts

function project(l) {
    const pad      = l.pad || {};
    const location = pad.location || {};
    const lat = Number(pad.latitude);
    const lon = Number(pad.longitude);
    return {
        id:           l.id,
        name:         l.name || 'TBD',
        slug:         l.slug || '',
        status:       l.status?.abbrev || l.status?.name || 'TBD',
        status_name:  l.status?.name   || '',
        mission:      l.mission?.description || l.mission?.name || '',
        mission_type: l.mission?.type || '',
        orbit:        l.mission?.orbit?.abbrev || l.mission?.orbit?.name || '',
        vehicle:      l.rocket?.configuration?.name || l.rocket?.configuration?.full_name || 'Unknown',
        vehicle_family: l.rocket?.configuration?.family || '',
        provider:     l.launch_service_provider?.name || 'Unknown',
        provider_type: l.launch_service_provider?.type || '',
        pad: {
            name:         pad.name  || '',
            lat:          Number.isFinite(lat) ? lat : null,
            lon:          Number.isFinite(lon) ? lon : null,
            location:     location.name || '',
            country_code: location.country_code || '',
            wiki:         pad.wiki_url || '',
        },
        net_iso:          l.net || null,
        window_start_iso: l.window_start || null,
        window_end_iso:   l.window_end   || null,
        probability_pct:  Number.isFinite(l.probability) ? l.probability : null,
        image:            l.image?.image_url || l.image || '',
        info_url:         l.infoURL || l.info_url || l.url || '',
    };
}

export default async function handler(request) {
    const url = new URL(request.url);

    const rawLimit = parseInt(url.searchParams.get('limit') || '50', 10);
    const limit    = Math.max(1, Math.min(100, Number.isFinite(rawLimit) ? rawLimit : 50));

    const rawWindow = parseInt(url.searchParams.get('window_days') || '90', 10);
    const windowDays = Math.max(1, Math.min(365, Number.isFinite(rawWindow) ? rawWindow : 90));

    const upstream = `${LL2_BASE}?limit=${limit}&mode=normal&hide_recent_previous=true`;

    let payload;
    try {
        const res = await fetchWithTimeout(upstream, {
            // LL2 User-Agent is intentionally more specific than the shared
            // default — TheSpaceDevs recommend per-consumer UA strings so
            // abusive clients can be identified and throttled by fingerprint
            // rather than by blanket IP block.
            headers: { 'User-Agent': 'ParkerPhysics/1.0 (launch-planner)' },
            timeoutMs: 15000,   // LL2 p99 is slower than NOAA on first miss
        });
        if (!res.ok) throw new Error(`LL2 HTTP ${res.status}`);
        payload = await res.json();
    } catch (e) {
        return jsonError('upstream_unavailable', e.message, { source: 'thespacedevs/ll2' });
    }

    const now = Date.now();
    const maxMs = now + windowDays * 86400_000;

    const launches = (payload.results || [])
        .map(project)
        .filter(l => {
            if (!l.net_iso) return false;
            const t = Date.parse(l.net_iso);
            return Number.isFinite(t) && t <= maxMs;
        });

    return jsonOk({
        source:     'thespacedevs/ll2',
        fetched_at: new Date().toISOString(),
        window_days: windowDays,
        count:      launches.length,
        launches,
    }, { maxAge: CACHE_TTL, swr: CACHE_SWR });
}
