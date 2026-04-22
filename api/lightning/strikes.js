/**
 * Vercel Edge Function: /api/lightning/strikes
 *
 * Near-real-time lightning strike proximity for a point (launch pad, typically).
 * Returns strikes within `radius_km` / `window_min` of (lat, lon) — count,
 * distance to nearest, age of most recent — everything the launch-planner's
 * convection scorer needs to answer the LLCC-Rule-9-adjacent question
 * "is lightning actually firing near this pad RIGHT NOW?"
 *
 * The forecast-based convective band (CAPE + LI + CIN) answers "will storms
 * develop?" The NWS alert proximity check answers "has a human forecaster
 * called it?" This endpoint closes the loop with actual optically-detected
 * strike positions, so the planner can flag a launch that's about to hit
 * 18 km of active cloud-to-ground even when the NWS polygon hasn't been
 * issued yet.
 *
 * ── Upstream ────────────────────────────────────────────────────────────────
 *   Primary:  Blitzortung.org community lightning detection network
 *             (crowd-sourced VLF stations, global coverage, CORS-open
 *             map tile endpoint)
 *   Policy:   The map.blitzortung.org JSON endpoint is the same feed that
 *             powers their public map; we follow the same fair-use pattern
 *             (≤ 1 req / min per pad) and the Vercel edge cache collapses
 *             many visitors into one upstream hit.
 *
 *   Reality:  Blitzortung data access evolves — they've tightened their
 *             WebSocket stream against scraping several times. If the
 *             public tile endpoint stops returning JSON, this route
 *             degrades gracefully: strikes = [], source_status = 'unavailable',
 *             HTTP 200. The launch planner treats absence-of-data as
 *             "no lightning signal" rather than blocking the verdict.
 *
 *   Future:   NOAA GOES-R GLM (Geostationary Lightning Mapper) data is on
 *             AWS S3 as authoritative satellite-measured lightning. GLM
 *             ingest needs a server-side netCDF parser, which is a bigger
 *             lift than this proxy. Adapter pattern below keeps the HTTP
 *             contract swap-friendly when we want to bolt GLM in.
 *
 * ── Query params ────────────────────────────────────────────────────────────
 *   ?lat=<num>          Required. Pad latitude (−90 … 90).
 *   ?lon=<num>          Required. Pad longitude (−180 … 180).
 *   ?radius_km=<num>    Proximity buffer (default 50, max 500).
 *                       LLCC Rule 9 cites 10 nmi ≈ 18.5 km; we double and
 *                       round to absorb VLF localization uncertainty.
 *   ?window_min=<num>   Lookback window (default 60, max 180).
 *                       60 min is a reasonable "recent lightning nearby"
 *                       question; longer windows aren't the point of this
 *                       endpoint (Blitzortung's tile doesn't archive).
 *
 * ── Response (always 200 unless the CLIENT's request is malformed) ──────────
 *   {
 *     source:              "blitzortung.org/geojson" | "none",
 *     source_status:       "ok" | "unavailable" | "empty",
 *     fetched_at:          "2026-…Z",
 *     query:               { lat, lon, radius_km, window_min },
 *     count:               3,
 *     recent_count:        1,             // strikes in the last 15 min
 *     nearest_km:          12.4,          // min distance, or null
 *     last_strike_age_min: 3.5,           // age of most recent, or null
 *     strikes: [
 *       { ts: "…Z", lat, lon, distance_km, age_min }
 *     ]
 *   }
 *
 *   source_status === 'unavailable' means the Blitzortung fetch failed —
 *   clients should treat this as "no signal," not as "no strikes."
 *
 * ── Cache ───────────────────────────────────────────────────────────────────
 *   s-maxage=60 (lightning is ephemeral; caching longer than a minute
 *   defeats the point). stale-while-revalidate=30. Error responses cached
 *   briefly too so a transient Blitzortung hiccup doesn't spam retries.
 */

import { jsonOk, jsonError, fetchWithTimeout } from '../_lib/responses.js';

export const config = { runtime: 'edge' };

const CACHE_TTL = 60;   // 1 min — strikes age fast
const CACHE_SWR = 30;

const DEFAULT_RADIUS_KM   = 50;
const MAX_RADIUS_KM       = 500;
const DEFAULT_WINDOW_MIN  = 60;
const MAX_WINDOW_MIN      = 180;
const RECENT_WINDOW_MIN   = 15;   // what "recent_count" means

// Blitzortung public map-tile endpoint. This is the same request the
// map.blitzortung.org UI makes; the bounding box is computed from our
// pad location + radius, padded to cover the full great-circle circle
// (the endpoint expects a rectangular lat/lon box).
const BLITZORTUNG_URL = 'https://map.blitzortung.org/GEOjson/getjson.php';

// ── Geometry ────────────────────────────────────────────────────────────────

/** Great-circle distance in km between two (lat, lon) points in degrees. */
function distanceKm(lat1, lon1, lat2, lon2) {
    const R = 6371.0;
    const toRad = d => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2
            + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Bounding box around (lat, lon) that contains every point within
 * `radiusKm`. lon spread widens toward the poles (∝ 1/cos(lat)), which
 * this handles; beyond 85° the box wraps past 180°, but launch pads
 * never go there, so we clamp and move on.
 */
function bboxAround(lat, lon, radiusKm) {
    const DEG_PER_KM_LAT = 1 / 111.0;
    const dLat = radiusKm * DEG_PER_KM_LAT;
    const cosLat = Math.max(0.01, Math.cos(lat * Math.PI / 180));
    const dLon = radiusKm / (111.0 * cosLat);
    return {
        south: Math.max(-90,  lat - dLat),
        north: Math.min( 90,  lat + dLat),
        west:  Math.max(-180, lon - dLon),
        east:  Math.min( 180, lon + dLon),
    };
}

// ── Blitzortung adapter ─────────────────────────────────────────────────────

/**
 * Fetch recent strikes from Blitzortung's public JSON tile and normalize
 * to { ts (ISO), lat, lon }. Returns [] on any upstream failure; the
 * caller layer decides whether to annotate source_status.
 *
 * Blitzortung's response schema has drifted over time. We handle the
 * observed forms:
 *   - GeoJSON FeatureCollection: { type: 'FeatureCollection', features: [...] }
 *     Each feature: { geometry: { coordinates: [lon, lat] }, properties: { time | t } }
 *   - Flat array: [{ lat, lon, time }, ...]
 * Anything else → log once and return [].
 */
async function fetchBlitzortung(bbox) {
    const qs = new URLSearchParams({
        south: bbox.south.toFixed(3),
        north: bbox.north.toFixed(3),
        west:  bbox.west.toFixed(3),
        east:  bbox.east.toFixed(3),
        type:  'json',
    });
    const url = `${BLITZORTUNG_URL}?${qs}`;

    let body;
    try {
        // Blitzortung's server is fast when happy but sometimes stalls
        // under scraper load. 6s is enough for a fair fetch without
        // pinning our worker if it hangs.
        const res = await fetchWithTimeout(url, {
            timeoutMs: 6000,
            headers: {
                Accept:   'application/json,*/*',
                // Some Blitzortung edges refuse empty Origin; set a
                // plausible one so the request looks like it's coming
                // from a real page, not a headless scraper.
                Origin:   'https://map.blitzortung.org',
                Referer:  'https://map.blitzortung.org/',
            },
        });
        if (!res.ok) return { strikes: [], error: `HTTP ${res.status}` };
        const text = await res.text();
        if (!text || text.trim().length === 0) return { strikes: [] };
        try {
            body = JSON.parse(text);
        } catch {
            return { strikes: [], error: 'non-json upstream response' };
        }
    } catch (e) {
        return { strikes: [], error: e.message };
    }

    return { strikes: parseBlitzortungBody(body) };
}

function parseBlitzortungBody(body) {
    if (!body) return [];
    // GeoJSON FeatureCollection form
    if (body.type === 'FeatureCollection' && Array.isArray(body.features)) {
        const out = [];
        for (const f of body.features) {
            const coords = f?.geometry?.coordinates;
            if (!Array.isArray(coords) || coords.length < 2) continue;
            const [lon, lat] = coords;
            const p = f.properties || {};
            // Blitzortung timestamps can arrive as ISO-8601 or as an epoch
            // in seconds; normalize both.
            const tRaw = p.time ?? p.t ?? p.timestamp ?? null;
            const ts = normalizeTimestamp(tRaw);
            if (ts == null) continue;
            out.push({ ts, lat, lon });
        }
        return out;
    }
    // Flat-array form
    if (Array.isArray(body)) {
        const out = [];
        for (const s of body) {
            if (!s) continue;
            const lat = Number(s.lat ?? s.latitude);
            const lon = Number(s.lon ?? s.longitude);
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
            const ts = normalizeTimestamp(s.time ?? s.t ?? s.timestamp);
            if (ts == null) continue;
            out.push({ ts, lat, lon });
        }
        return out;
    }
    return [];
}

/** Normalize a Blitzortung timestamp (ISO string | epoch-seconds | epoch-ms) to ISO-8601 UTC. */
function normalizeTimestamp(raw) {
    if (raw == null) return null;
    if (typeof raw === 'string') {
        const d = new Date(raw);
        return isNaN(d) ? null : d.toISOString();
    }
    if (typeof raw === 'number') {
        // Heuristic: 10-digit = seconds, 13-digit = ms, 16+ digit = ns
        let ms = raw;
        if (raw < 1e11)      ms = raw * 1000;
        else if (raw > 1e14) ms = Math.floor(raw / 1e6);
        const d = new Date(ms);
        return isNaN(d) ? null : d.toISOString();
    }
    return null;
}

// ── Handler ─────────────────────────────────────────────────────────────────

export default async function handler(request) {
    const url = new URL(request.url);

    const lat = Number(url.searchParams.get('lat'));
    const lon = Number(url.searchParams.get('lon'));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)
        || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
        // Client-side mistake — 400, cache briefly so malformed
        // client loops don't hit edge cost.
        return jsonError('invalid_coordinates',
            'lat (−90…90) and lon (−180…180) query params are required',
            { status: 400, maxAge: 300 });
    }

    const rawRadius = Number(url.searchParams.get('radius_km') ?? DEFAULT_RADIUS_KM);
    const rawWindow = Number(url.searchParams.get('window_min') ?? DEFAULT_WINDOW_MIN);
    const radiusKm  = Math.max(1,  Math.min(MAX_RADIUS_KM,  Number.isFinite(rawRadius) ? rawRadius : DEFAULT_RADIUS_KM));
    const windowMin = Math.max(1,  Math.min(MAX_WINDOW_MIN, Number.isFinite(rawWindow) ? rawWindow : DEFAULT_WINDOW_MIN));

    const bbox = bboxAround(lat, lon, radiusKm);
    const { strikes: rawStrikes, error } = await fetchBlitzortung(bbox);

    const now        = Date.now();
    const windowMs   = windowMin * 60_000;
    const recentMs   = RECENT_WINDOW_MIN * 60_000;

    // Filter: within radius AND within window. Tag distance + age.
    const hits = [];
    for (const s of rawStrikes) {
        const strikeMs = Date.parse(s.ts);
        if (!Number.isFinite(strikeMs)) continue;
        const ageMs = now - strikeMs;
        if (ageMs < 0 || ageMs > windowMs) continue;
        const d = distanceKm(lat, lon, s.lat, s.lon);
        if (d > radiusKm) continue;
        hits.push({
            ts:          s.ts,
            lat:         Math.round(s.lat * 1000) / 1000,
            lon:         Math.round(s.lon * 1000) / 1000,
            distance_km: Math.round(d * 10) / 10,
            age_min:     Math.round(ageMs / 6000) / 10,  // 0.1 min precision
        });
    }

    // Sort nearest-first; UI overlays render in that order.
    hits.sort((a, b) => a.distance_km - b.distance_km);

    // Derived summary fields. nearest_km / last_strike_age_min are null
    // when no hits — easier for the convection scorer to guard on null
    // than to reason about "is 0 a real value or a fill?"
    const nearestKm =
        hits.length === 0 ? null :
        Math.min(...hits.map(h => h.distance_km));
    const lastStrikeAgeMin =
        hits.length === 0 ? null :
        Math.min(...hits.map(h => h.age_min));
    const recentCount = hits.filter(h => (h.age_min * 60_000) <= recentMs).length;

    const sourceStatus = error
        ? 'unavailable'
        : (rawStrikes.length === 0 ? 'empty' : 'ok');

    return jsonOk({
        source:              error ? 'none' : 'blitzortung.org/geojson',
        source_status:       sourceStatus,
        source_detail:       error || undefined,
        fetched_at:          new Date(now).toISOString(),
        query: {
            lat:          Math.round(lat * 10000) / 10000,
            lon:          Math.round(lon * 10000) / 10000,
            radius_km:    radiusKm,
            window_min:   windowMin,
        },
        count:               hits.length,
        recent_count:        recentCount,
        nearest_km:          nearestKm,
        last_strike_age_min: lastStrikeAgeMin,
        strikes:             hits,
        attribution:         'Lightning data © Blitzortung.org community (CC-BY-SA). Crowd-sourced VLF detection — not a substitute for LLCC field-mill data.',
    }, { maxAge: CACHE_TTL, swr: CACHE_SWR });
}
