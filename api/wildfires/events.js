/**
 * api/wildfires/events.js — Vercel edge function: active wildfire event list.
 *
 * Single upstream: NASA EONET v3 `wildfires` category (open events). Keyless,
 * CORS-open, curated from GDACS / InciWeb / partner agencies — the only free
 * global JSON feed of *named* wildfire events (the GIBS "Active Fires" layer
 * on earth.html is thermal-anomaly IMAGERY; this feed is the discrete,
 * clickable event list that complements it).
 *
 * Response shape:
 *   {
 *     updated: ISO string,
 *     count,
 *     freshness: 'live' | 'stale',       // stale ⇒ upstream failed, empty list
 *     fires: [{
 *       id, name, lat, lon,              // latest geometry point
 *       startedAt, lastUpdate,           // first/last geometry timestamps
 *       areaAcres,                       // latest magnitude where unit=acres, else null
 *       ageDays,                         // days since lastUpdate (event recency)
 *       link                             // EONET event page
 *     }],
 *     sources: { eonet: { ok, count, error? } }
 *   }
 *
 * Failure mode: a 200 with `freshness: 'stale'` and an empty list — the layer
 * shows "no data" instead of the site looking broken, and the status page
 * scores the row amber instead of green (CLAUDE.md §8).
 *
 * CDN cache: 30 minutes (EONET updates roughly twice a day).
 */

import { jsonOk, fetchWithTimeout } from '../_lib/responses.js';

export const config = { runtime: 'edge' };

const EONET_URL = 'https://eonet.gsfc.nasa.gov/api/v3/events?category=wildfires&status=open';

// EONET keeps some events "open" long after the last geometry update. Cap the
// list to events updated in the last 60 days so the globe reflects fires that
// are plausibly still burning; ageDays lets the client fade older ones.
const MAX_AGE_DAYS = 60;

export function parseEvents(payload, nowMs) {
    const out = [];
    for (const ev of payload?.events ?? []) {
        const pts = (ev.geometry ?? [])
            .filter(g => g.type === 'Point' && Array.isArray(g.coordinates))
            .map(g => ({
                lon: Number(g.coordinates[0]),
                lat: Number(g.coordinates[1]),
                t: Date.parse(g.date),
                mag: Number.isFinite(g.magnitudeValue) ? g.magnitudeValue : null,
                unit: g.magnitudeUnit ?? null,
            }))
            .filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon) && Number.isFinite(p.t))
            .sort((a, b) => a.t - b.t);
        if (!pts.length) continue;

        const first = pts[0];
        const last = pts[pts.length - 1];
        const ageDays = (nowMs - last.t) / 86_400_000;
        if (ageDays > MAX_AGE_DAYS) continue;

        // Latest acreage anywhere on the track (some updates omit magnitude).
        let areaAcres = null;
        for (let i = pts.length - 1; i >= 0 && areaAcres == null; i--) {
            if (pts[i].mag != null && /acre/i.test(pts[i].unit ?? '')) areaAcres = pts[i].mag;
        }

        out.push({
            id: ev.id ?? `eonet-fire-${out.length}`,
            name: String(ev.title ?? 'Unnamed wildfire').trim(),
            lat: last.lat,
            lon: last.lon,
            startedAt: new Date(first.t).toISOString(),
            lastUpdate: new Date(last.t).toISOString(),
            areaAcres,
            ageDays: Math.max(0, Math.round(ageDays * 10) / 10),
            link: ev.link ?? null,
        });
    }
    // Biggest and freshest first: acreage desc where known, then recency.
    return out.sort((a, b) =>
        (b.areaAcres ?? -1) - (a.areaAcres ?? -1) || a.ageDays - b.ageDays);
}

export default async function handler() {
    const nowMs = Date.now();
    try {
        const res = await fetchWithTimeout(EONET_URL, {
            timeoutMs: 12_000,
            headers: { Accept: 'application/json' },
        });
        if (!res.ok) throw new Error(`EONET HTTP ${res.status}`);
        const fires = parseEvents(await res.json(), nowMs);
        return jsonOk({
            updated: new Date(nowMs).toISOString(),
            count: fires.length,
            freshness: 'live',
            fires,
            sources: { eonet: { ok: true, count: fires.length } },
        }, { maxAge: 1800, swr: 300 });
    } catch (e) {
        return jsonOk({
            updated: new Date(nowMs).toISOString(),
            count: 0,
            freshness: 'stale',
            fires: [],
            sources: { eonet: { ok: false, count: 0, error: e?.message ?? 'unknown' } },
        }, { maxAge: 120, swr: 60 });
    }
}
