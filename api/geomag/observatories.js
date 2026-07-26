/**
 * Vercel Edge Function: /api/geomag/observatories
 *
 * Source: USGS Geomagnetism Program magnetometer web service
 *   https://geomag.usgs.gov/ws/data/
 *
 * Feeds the External layer of tiga.html — the real-time TIGA nowcast.
 *
 * ── WHY USGS AND NOT INTERMAGNET ─────────────────────────────────────────
 * This is a LICENSING decision, not a physics one, and it is deliberate.
 *
 *   • INTERMAGNET is CC BY-NC 4.0. Fine for a free research index; a problem
 *     for anything commercial, and clearing it means written permission from
 *     roughly fifty operating institutes.
 *   • SuperMAG prohibits redistribution outright.
 *   • USGS observatory data is a work of the US federal government and is
 *     effectively public domain. No permission needed, and these are among
 *     the fastest and most reliable feeds in the network.
 *
 * A USGS-only fit is a HARDER problem than a global one — fourteen stations
 * with poor longitude coverage instead of seventy-five — which makes the
 * dropout result more impressive, not less. See TIGA_PLAN.md §Licensing.
 *
 * ── THIS PROXY DOES NOT RESELL DATA ──────────────────────────────────────
 * It passes public-domain observations through so the browser can run the
 * estimator on them. The product is the ESTIMATE and its posterior, not the
 * observations. Nothing here caches for redistribution beyond the ordinary
 * edge TTL, and the upstream attribution travels with the payload.
 *
 * ── NO STATION COORDINATE IS HARD-CODED HERE ─────────────────────────────
 * Only IAGA codes are sent upstream. Every geodetic latitude and longitude in
 * the response is read out of the USGS payload itself. That is the operational
 * form of the rule in js/geomag/observatories.js: a coordinate typed from
 * memory once cost 9.35° of dipole latitude and presented as a model error.
 */
import { jsonOk, jsonError, fetchWithTimeout } from '../_lib/responses.js';

export const config = { runtime: 'edge' };

const USGS_DATA = 'https://geomag.usgs.gov/ws/data/';

/**
 * IAGA codes only — identifiers, not data. The high-latitude USGS stations
 * (BRW, CMO, DED, SHU, SIT) are requested too; the CLIENT drops them on a
 * COMPUTED dipole latitude rather than on a hard-coded annotation, so the
 * ring-current cut stays honest as the pole drifts.
 */
const STATION_IDS = ['BOU', 'BRW', 'BSL', 'CMO', 'DED', 'FRD', 'FRN',
    'GUA', 'HON', 'NEW', 'SHU', 'SIT', 'SJG', 'TUC'];

const CACHE_TTL = 60;          // 1-minute data; no point caching harder
const CACHE_SWR = 120;
const WINDOW_MIN = 180;        // enough history for the filter to spin up

/** ISO string for a whole minute, `n` minutes before `now`. */
function isoMinute(now, minutesBefore) {
    const t = new Date(now - minutesBefore * 60000);
    t.setUTCSeconds(0, 0);
    return t.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * One station's variation data. `type=variation` is the raw 1-minute
 * observatory record — the quantity the estimator needs. Adjusted/quasi-defin-
 * itive products are not real-time and would defeat the point.
 */
async function fetchStation(id, startTime, endTime) {
    const url = `${USGS_DATA}?id=${encodeURIComponent(id)}`
        + `&type=variation&elements=X,Y,Z,F&sampling_period=60&format=json`
        + `&starttime=${encodeURIComponent(startTime)}`
        + `&endtime=${encodeURIComponent(endTime)}`;
    const res = await fetchWithTimeout(url, {
        headers: { Accept: 'application/json' },
        timeoutMs: 9000,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

/**
 * Normalise one IAGA-JSON payload.
 *
 * USGS returns `times` plus a `values` array of typed series. Gaps arrive as
 * null, and NOT filling them is the point — TIGA's whole dropout story is that
 * a missing observation is simply absent from H that epoch. Interpolating here
 * would manufacture data and quietly destroy the property being demonstrated.
 */
function normalise(payload, id) {
    const times = payload?.times;
    if (!Array.isArray(times) || !times.length) return null;

    const meta = payload?.metadata?.station ?? {};
    const coords = meta.geometry?.coordinates ?? null;
    // GeoJSON order is [longitude, latitude, elevation].
    const lonRaw = coords ? Number(coords[0]) : Number(meta.longitude);
    const lat = coords ? Number(coords[1]) : Number(meta.latitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lonRaw)) return null;
    // Normalise to east longitude in [0, 360).
    const lon = ((lonRaw % 360) + 360) % 360;

    const series = Array.isArray(payload?.values) ? payload.values : [];
    const pick = (name) => series.find((s) =>
        (s?.id || s?.metadata?.element || '').toUpperCase() === name)?.values ?? null;

    const X = pick('X') ?? pick('H');   // H is the horizontal proxy some sites report
    if (!Array.isArray(X)) return null;

    return {
        iaga: id,
        name: meta.name ?? meta.properties?.name ?? id,
        geodeticLatitude: lat,
        geodeticLongitude: lon,
        elevationM: coords && Number.isFinite(Number(coords[2])) ? Number(coords[2]) : null,
        times,
        x: X.map((v) => (Number.isFinite(v) ? v : null)),
    };
}

export default async function handler(req) {
    const url = new URL(req.url);
    const windowMin = Math.min(Math.max(
        Number(url.searchParams.get('minutes')) || WINDOW_MIN, 10), 1440);

    const now = Date.now();
    const endTime = isoMinute(now, 0);
    const startTime = isoMinute(now, windowMin);

    // Fan out. A station that fails is a DROPOUT, not an error — the estimator
    // is built for exactly this, so one dead observatory must never fail the
    // request. That is why these are settled, not awaited as a group.
    const settled = await Promise.allSettled(
        STATION_IDS.map((id) => fetchStation(id, startTime, endTime)
            .then((p) => normalise(p, id))));

    const stations = [];
    const missing = [];
    settled.forEach((r, i) => {
        if (r.status === 'fulfilled' && r.value) stations.push(r.value);
        else missing.push(STATION_IDS[i]);
    });

    if (!stations.length) {
        return jsonError('upstream_unavailable',
            'No USGS observatory returned data', { source: 'USGS Geomagnetism Program' });
    }

    return jsonOk({
        source: 'USGS Geomagnetism Program (ws/data) via Vercel Edge',
        attribution: 'Data courtesy of the USGS Geomagnetism Program, '
            + 'https://geomag.usgs.gov/ — a work of the US federal government.',
        license: 'public-domain',
        data: {
            updated: new Date(now).toISOString(),
            startTime,
            endTime,
            samplingPeriodSec: 60,
            requested: STATION_IDS.length,
            returned: stations.length,
            missing,
            stations,
        },
    }, { maxAge: CACHE_TTL, swr: CACHE_SWR });
}
