/**
 * api/air-quality/stations-intl.js — international ground-station PM2.5
 * observations via OpenAQ v3.
 *
 * GET /api/air-quality/stations-intl
 *
 * WHY THIS EXISTS: the station-observation half of the air-quality surface
 * (/api/air-quality/stations, EPA AirNow) is US-only; everything
 * international is currently CAMS *model* data. OpenAQ aggregates
 * government/reference monitors worldwide under CC BY 4.0 — the one free,
 * licensing-clean source of international ground truth. (WAQI/aqicn is
 * redistribution-restricted; INTERMAGNET-style CC BY-NC concerns don't
 * apply here, but attribution does — keep the `attribution` field intact.)
 *
 * KEY: OpenAQ v3 requires a free API key (https://explore.openaq.org/register)
 * in the `OPENAQ_API_KEY` Vercel env var. Until it is configured this route
 * answers 200 + freshness:'stale' + configured:false with an actionable
 * reason — the status board shows amber with "key not configured", which is
 * the deliberate nag to finish the setup. No key is ever exposed client-side.
 *
 * UPSTREAM: one request — GET /v3/parameters/2/latest?limit=1000
 * (parameter 2 = PM2.5) — returns the newest value per sensor globally with
 * coordinates. Sensors whose "latest" is older than 48 h are dropped as
 * dead. Response shape:
 *   {
 *     updated, count, freshness: 'live'|'stale', configured: bool,
 *     attribution: 'OpenAQ · CC BY 4.0',
 *     stations: [{ id, lat, lon, pm25, utc }]
 *   }
 *
 * CDN cache: 15 min (OpenAQ reference monitors report hourly).
 */

import { jsonOk, fetchWithTimeout } from '../_lib/responses.js';

export const config = { runtime: 'edge' };

const OPENAQ_LATEST_PM25 = 'https://api.openaq.org/v3/parameters/2/latest?limit=1000';
const MAX_AGE_MS = 48 * 3600 * 1000;
export const OPENAQ_ATTRIBUTION = 'OpenAQ · CC BY 4.0';

/** Normalize one /v3/parameters/2/latest payload. Exported for the fixture
 *  test — OpenAQ has already shipped one breaking API rev (v2→v3); when v4
 *  moves the fields this is where it fails loudly instead of silently. */
export function normalizeOpenAq(payload, nowMs = Date.now()) {
    const results = Array.isArray(payload?.results) ? payload.results : [];
    const out = [];
    // Coerce via a null-guard: Number(null) is 0, which would silently park
    // a coordinate-less sensor on Null Island instead of dropping it.
    const num = v => (v == null || v === '' ? NaN : Number(v));
    for (const row of results) {
        const lat = num(row?.coordinates?.latitude);
        const lon = num(row?.coordinates?.longitude);
        const pm25 = num(row?.value);
        const utcMs = Date.parse(row?.datetime?.utc ?? '');
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        if (!Number.isFinite(pm25) || pm25 < 0) continue;       // -999 sentinels
        if (!Number.isFinite(utcMs) || nowMs - utcMs > MAX_AGE_MS) continue;
        out.push({
            id: `${row.locationsId ?? 'loc'}:${row.sensorsId ?? out.length}`,
            lat, lon,
            pm25,
            utc: new Date(utcMs).toISOString(),
        });
    }
    return out;
}

function staleBody(nowMs, configured, reason) {
    return {
        updated: new Date(nowMs).toISOString(),
        count: 0,
        freshness: 'stale',
        configured,
        reason,
        attribution: OPENAQ_ATTRIBUTION,
        stations: [],
    };
}

export default async function handler() {
    const nowMs = Date.now();
    const key = process.env.OPENAQ_API_KEY;
    if (!key) {
        return jsonOk(
            staleBody(nowMs, false, 'OPENAQ_API_KEY not configured — free key at explore.openaq.org/register'),
            { maxAge: 300, swr: 60 });
    }

    try {
        const res = await fetchWithTimeout(OPENAQ_LATEST_PM25, {
            timeoutMs: 15_000,
            headers: { Accept: 'application/json', 'X-API-Key': key },
        });
        if (!res.ok) throw new Error(`OpenAQ HTTP ${res.status}`);
        const stations = normalizeOpenAq(await res.json(), nowMs);
        if (!stations.length) throw new Error('OpenAQ returned no live PM2.5 sensors');
        return jsonOk({
            updated: new Date(nowMs).toISOString(),
            count: stations.length,
            freshness: 'live',
            configured: true,
            attribution: OPENAQ_ATTRIBUTION,
            stations,
        }, { maxAge: 900, swr: 300 });
    } catch (e) {
        return jsonOk(
            staleBody(nowMs, true, e?.message ?? 'unknown'),
            { maxAge: 120, swr: 60 });
    }
}
