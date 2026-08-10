/**
 * api/air-quality/stations-intl.js — international ground-station air-quality
 * observations via OpenAQ v3, per species.
 *
 * GET /api/air-quality/stations-intl?species=pm25|pm10|o3|no2|so2|co|bc
 *
 * WHY THIS EXISTS: the station-observation half of the air-quality surface
 * (/api/air-quality/stations, EPA AirNow) is US-only; everything
 * international is CAMS *model* data. OpenAQ aggregates government/reference
 * monitors worldwide under CC BY 4.0 — the one free, licensing-clean source
 * of international ground truth (WAQI/aqicn is redistribution-restricted).
 * Keep the `attribution` field intact everywhere.
 *
 * KEY: OpenAQ v3 requires a free API key (https://explore.openaq.org/register)
 * in the `OPENAQ_API_KEY` Vercel env var. Until it is configured this route
 * answers 200 + freshness:'stale' + configured:false with an actionable
 * reason — the status board shows amber with "key not configured". No key is
 * ever exposed client-side.
 *
 * SELF-VALIDATING PARAMETER IDS: OpenAQ addresses parameters by numeric id,
 * and the id table below for the gas/BC species is transcribed from docs
 * that could not be verified live when this shipped. Serving mislabeled or
 * mis-united data would be worse than serving none, so every request first
 * fetches /v3/parameters/{id} and checks the returned name AND units against
 * the registry; a mismatch degrades to stale with a reason that NAMES the
 * actual parameter served — fixing a wrong id is then a one-number edit
 * guided by the status page, never a silent relabeling.
 *
 * UPSTREAM: GET /v3/parameters/{id}/latest?limit=1000 — newest value per
 * sensor globally with coordinates. Sensors whose "latest" is older than
 * 48 h are dropped as dead. Response:
 *   {
 *     updated, count, freshness: 'live'|'stale', configured: bool,
 *     species, label, unit, attribution: 'OpenAQ · CC BY 4.0',
 *     stations: [{ id, lat, lon, value, utc }]
 *   }
 *
 * CDN cache: 15 min per species (the query string keys the CDN entry).
 */

import { jsonOk, fetchWithTimeout } from '../_lib/responses.js';

export const config = { runtime: 'edge' };

const OPENAQ_BASE = 'https://api.openaq.org/v3';
const MAX_AGE_MS = 48 * 3600 * 1000;
export const OPENAQ_ATTRIBUTION = 'OpenAQ · CC BY 4.0';

/**
 * Species registry. `id` is the OpenAQ v3 parameters_id, `upstreamName` the
 * name /v3/parameters/{id} must report, `unit` the units it must serve —
 * both are enforced per request (see header). µg/m³ variants are chosen on
 * purpose: the client color ramps are µg/m³-shaped, and OpenAQ registers
 * ppm-based readings under separate parameter ids.
 */
export const STATION_SPECIES = Object.freeze({
    pm25: Object.freeze({ id: 2,  upstreamName: 'pm25', unit: 'µg/m³', label: 'PM2.5' }),
    pm10: Object.freeze({ id: 1,  upstreamName: 'pm10', unit: 'µg/m³', label: 'PM10' }),
    o3:   Object.freeze({ id: 10, upstreamName: 'o3',   unit: 'µg/m³', label: 'O₃' }),
    no2:  Object.freeze({ id: 7,  upstreamName: 'no2',  unit: 'µg/m³', label: 'NO₂' }),
    so2:  Object.freeze({ id: 9,  upstreamName: 'so2',  unit: 'µg/m³', label: 'SO₂' }),
    co:   Object.freeze({ id: 8,  upstreamName: 'co',   unit: 'µg/m³', label: 'CO' }),
    bc:   Object.freeze({ id: 11, upstreamName: 'bc',   unit: 'µg/m³', label: 'Black carbon' }),
});

/**
 * Validate one /v3/parameters/{id} metadata payload against a registry spec.
 * Returns null when it matches, else a human-readable mismatch reason.
 * Unit comparison is tolerant of ASCII/Unicode µ and casing but strict about
 * ppm-vs-mass — that distinction is what keeps the color ramps honest.
 */
export function checkParameterMeta(payload, spec) {
    const meta = Array.isArray(payload?.results) ? payload.results[0] : payload?.results;
    if (!meta) return `parameter ${spec.id}: no metadata returned`;
    const name = String(meta.name ?? '').toLowerCase();
    if (name !== spec.upstreamName) {
        return `parameter ${spec.id} is "${meta.name}", expected "${spec.upstreamName}" — fix STATION_SPECIES`;
    }
    const norm = u => String(u ?? '').toLowerCase()
        .replace('µ', 'u').replace('³', '3').replace(/\s/g, '');
    if (norm(meta.units) !== norm(spec.unit)) {
        return `parameter ${spec.id} (${meta.name}) serves "${meta.units}", expected "${spec.unit}" — fix STATION_SPECIES`;
    }
    return null;
}

/** Normalize one /v3/parameters/{id}/latest payload. Exported for the
 *  fixture test — OpenAQ has already shipped one breaking API rev (v2→v3);
 *  when v4 moves the fields this is where it fails loudly. */
export function normalizeOpenAq(payload, nowMs = Date.now()) {
    const results = Array.isArray(payload?.results) ? payload.results : [];
    const out = [];
    // Coerce via a null-guard: Number(null) is 0, which would silently park
    // a coordinate-less sensor on Null Island instead of dropping it.
    const num = v => (v == null || v === '' ? NaN : Number(v));
    for (const row of results) {
        const lat = num(row?.coordinates?.latitude);
        const lon = num(row?.coordinates?.longitude);
        const value = num(row?.value);
        const utcMs = Date.parse(row?.datetime?.utc ?? '');
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        if (!Number.isFinite(value) || value < 0) continue;     // -999 sentinels
        if (!Number.isFinite(utcMs) || nowMs - utcMs > MAX_AGE_MS) continue;
        out.push({
            id: `${row.locationsId ?? 'loc'}:${row.sensorsId ?? out.length}`,
            lat, lon,
            value,
            utc: new Date(utcMs).toISOString(),
        });
    }
    return out;
}

function staleBody(nowMs, configured, reason, spec, speciesKey) {
    return {
        updated: new Date(nowMs).toISOString(),
        count: 0,
        freshness: 'stale',
        configured,
        reason,
        species: speciesKey,
        label: spec.label,
        unit: spec.unit,
        attribution: OPENAQ_ATTRIBUTION,
        stations: [],
    };
}

/** Fetch OpenAQ latest values for one registry species. Shared with the
 *  residuals route so the two surfaces can never disagree on what an
 *  "observation" is. Throws with `.configured = false` when the key is
 *  absent; validates the parameter id before trusting a single value. */
export async function fetchOpenAqLatest(speciesKey, key, nowMs = Date.now()) {
    const spec = STATION_SPECIES[speciesKey] ?? STATION_SPECIES.pm25;
    if (!key) {
        const err = new Error('OPENAQ_API_KEY not configured — free key at explore.openaq.org/register');
        err.configured = false;
        throw err;
    }
    const headers = { Accept: 'application/json', 'X-API-Key': key };
    const metaRes = await fetchWithTimeout(`${OPENAQ_BASE}/parameters/${spec.id}`, {
        timeoutMs: 10_000, headers,
    });
    if (!metaRes.ok) throw new Error(`OpenAQ meta HTTP ${metaRes.status}`);
    const mismatch = checkParameterMeta(await metaRes.json(), spec);
    if (mismatch) throw new Error(mismatch);

    const res = await fetchWithTimeout(`${OPENAQ_BASE}/parameters/${spec.id}/latest?limit=1000`, {
        timeoutMs: 15_000, headers,
    });
    if (!res.ok) throw new Error(`OpenAQ HTTP ${res.status}`);
    const stations = normalizeOpenAq(await res.json(), nowMs);
    if (!stations.length) throw new Error(`OpenAQ returned no live ${spec.label} sensors`);
    return { spec, stations };
}

export default async function handler(request) {
    const nowMs = Date.now();
    const url = new URL(request.url);
    const speciesParam = url.searchParams.get('species') ?? 'pm25';
    const speciesKey = STATION_SPECIES[speciesParam] ? speciesParam : 'pm25';
    const spec = STATION_SPECIES[speciesKey];

    try {
        const { stations } = await fetchOpenAqLatest(speciesKey, process.env.OPENAQ_API_KEY, nowMs);
        return jsonOk({
            updated: new Date(nowMs).toISOString(),
            count: stations.length,
            freshness: 'live',
            configured: true,
            species: speciesKey,
            label: spec.label,
            unit: spec.unit,
            attribution: OPENAQ_ATTRIBUTION,
            stations,
        }, { maxAge: 900, swr: 300 });
    } catch (e) {
        return jsonOk(
            staleBody(nowMs, e?.configured !== false, e?.message ?? 'unknown', spec, speciesKey),
            { maxAge: e?.configured === false ? 300 : 120, swr: 60 });
    }
}
