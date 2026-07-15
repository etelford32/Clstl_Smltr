/**
 * Vercel Edge Function: /api/weather/extremes
 *
 * Global extreme-weather watch list — the analysis layer over the 30-day
 * weather_grid_cache archive.
 *
 * The heavy lifting (per-cell percentiles across ~240 sampled frames) runs
 * INSIDE Postgres, hourly, via pg_cron → compute_weather_extremes()
 * (supabase-weather-extremes-migration.sql). This endpoint only reads the
 * latest ~2 KB result row, clusters adjacent flagged cells into events, and
 * attaches human-readable region names.
 *
 * Semantics (mirrors the SQL): a cell is flagged when its CURRENT value
 * crosses its own per-cell 30-day distribution —
 *   sev 1 ≥ p95 · sev 2 ≥ p99 · sev 3 = beyond the 30-day window record
 * with absolute floors so the list reads as human-relevant events
 * (heat ≥ 25 °C, cold ≤ 0 °C, wind ≥ 15 m/s, precip ≥ 2 mm).
 *
 * Response:
 *   {
 *     updated, frame_time, window_days, frames_sampled,
 *     categories: {
 *       heat:   [{ region, lat, lon, value, p95, p99, wmax, mean, sev, cells }],
 *       cold:   [{ region, lat, lon, value, p05, p01, wmin, mean, sev, cells }],
 *       wind:   [{ region, lat, lon, value, p95, p99, wmax, sev, cells }],
 *       precip: [{ region, lat, lon, value, p95, p99, wmax, sev, cells }],
 *     },
 *     summary: { cells, heat_p95_cells, cold_p05_cells, wind_p95_cells,
 *                precip_p95_cells, record_cells },
 *     units: { t:'°C', wind:'m/s', precip:'mm' },
 *   }
 *
 * CDN cache: 15 min (the SQL job refreshes hourly at :20).
 */

import { jsonOk, jsonError, fetchWithTimeout } from '../_lib/responses.js';

export const config = { runtime: 'edge' };

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
// Unlike the raw-pipeline readers (grid.js), this table carries derived
// PUBLIC analysis and has an anon SELECT policy (migration
// weather_extremes_public_read) — so the publishable key is a valid
// fallback. That keeps local dev working without the sensitive service
// secret, which `vercel env pull` writes as an empty string.
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY
    || process.env.SUPABASE_SECRET_KEY
    || process.env.SUPABASE_PUBLISHABLE_KEY
    || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY
    || '';

const CACHE_TTL = 900;    // 15 min
const CACHE_SWR = 300;

// ── Region labelling ─────────────────────────────────────────────────────────
// Coarse named boxes, FIRST MATCH WINS — specific seas/regions before the
// broad ocean/continent fallbacks. [latMin, latMax, lonMin, lonMax, name];
// a box with lonMin > lonMax wraps the antimeridian. 5° grid cells only —
// this is event labelling ("Gran Chaco heat"), not geocoding.
const REGIONS = [
    // Specific seas / basins first
    [15,  30, -100, -80, 'Gulf of Mexico'],
    [10,  25,  -90, -60, 'Caribbean'],
    [30,  46,  -10,  40, 'Mediterranean'],
    [5,   25,   80, 100, 'Bay of Bengal'],
    [0,   25,  100, 122, 'South China Sea'],
    [-50, -30, 150, 175, 'Tasman Sea'],
    // Land regions
    [15,  35, -120, -95, 'Mexico & US Southwest'],
    [30,  50, -105, -85, 'US Great Plains & Midwest'],
    [25,  47,  -85, -65, 'Eastern North America'],
    [35,  60, -130, -105, 'Western North America'],
    [50,  72, -170, -130, 'Alaska & Yukon'],
    [45,  70, -105, -55, 'Central & Eastern Canada'],
    [59,  84,  -75, -10, 'Greenland'],
    [-5,  12,  -80, -50, 'Amazon Basin (N)'],
    [-20,  -5, -75, -45, 'Amazon & Gran Chaco'],
    [-35, -20, -70, -50, 'Gran Chaco & Pampas'],
    [-56, -35, -76, -60, 'Patagonia'],
    [-20,   5, -82, -68, 'Andes'],
    [35,  60,  -12,  20, 'Western Europe'],
    [42,  60,   20,  45, 'Eastern Europe'],
    [55,  72,    4,  42, 'Scandinavia & Baltics'],
    [18,  35,  -18,  35, 'Sahara & North Africa'],
    [8,   18,  -18,  40, 'Sahel'],
    [-5,  12,  -18,  32, 'West & Central Africa'],
    [-12,  8,   28,  52, 'East Africa'],
    [-35, -12,  10,  42, 'Southern Africa'],
    [12,  40,   35,  62, 'Middle East & Arabia'],
    [35,  55,   45,  90, 'Central Asia'],
    [48,  75,   60, 180, 'Siberia'],
    [20,  48,  100, 132, 'East Asia'],
    [30,  46,  128, 146, 'Japan & Korea'],
    [5,   32,   62, 92, 'South Asia'],
    [-11,  22,   92, 130, 'Southeast Asia'],
    [-25, -10,  112, 155, 'Northern Australia'],
    [-40, -25,  112, 155, 'Southern Australia'],
    [-48, -33,  165, 180, 'New Zealand'],
    [-90, -60, -180, 180, 'Antarctica'],
    // Broad ocean fallbacks
    [66,  90, -180, 180, 'Arctic'],
    [-60, -40, -180, 180, 'Southern Ocean'],
    [30,  66,  -75,  -5, 'North Atlantic'],
    [0,   30,  -75, -15, 'Tropical Atlantic'],
    [-40,   0, -50,  15, 'South Atlantic'],
    [30,  62,  140, -120, 'North Pacific'],          // wraps antimeridian
    [-5,  30, -180, -95, 'Eastern Tropical Pacific'],
    [-5,  30,  130, 180, 'Western Tropical Pacific'],
    [-40,  -5,  150, -80, 'South Pacific'],          // wraps antimeridian
    [-40,  25,   42, 110, 'Indian Ocean'],
];

function lonInBox(lon, lonMin, lonMax) {
    if (lonMin <= lonMax) return lon >= lonMin && lon <= lonMax;
    return lon >= lonMin || lon <= lonMax;            // antimeridian wrap
}

function labelRegion(lat, lon) {
    for (const [a, b, c, d, name] of REGIONS) {
        if (lat >= a && lat <= b && lonInBox(lon, c, d)) return name;
    }
    return `${Math.abs(lat).toFixed(1)}°${lat >= 0 ? 'N' : 'S'} ` +
           `${Math.abs(lon).toFixed(1)}°${lon >= 0 ? 'E' : 'W'}`;
}

// ── Clustering ───────────────────────────────────────────────────────────────

function lonDelta(a, b) {
    const d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
}

/**
 * Greedy merge of flagged cells into events. Items arrive sorted by
 * exceedance (the SQL orders them), so the first cell of each cluster is
 * its peak; neighbours within `radiusDeg` fold in as extent.
 */
function clusterCells(items, radiusDeg = 8, maxClusters = 6) {
    const clusters = [];
    for (const it of items ?? []) {
        const home = clusters.find(cl =>
            Math.abs(cl.lat - it.lat) <= radiusDeg &&
            lonDelta(cl.lon, it.lon) <= radiusDeg);
        if (home) {
            home.cells += 1;
            home.sev = Math.max(home.sev, it.sev);
        } else {
            clusters.push({ ...it, cells: 1, region: labelRegion(it.lat, it.lon) });
        }
    }
    return clusters.slice(0, maxClusters);
}

// ── Handler ──────────────────────────────────────────────────────────────────

async function readLatest() {
    const url = `${SUPABASE_URL}/rest/v1/weather_extremes_cache` +
                `?select=computed_at,frame_time,window_days,frames_sampled,payload` +
                `&order=computed_at.desc&limit=1`;
    const res = await fetchWithTimeout(url, {
        headers: {
            apikey:        SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
        },
    });
    if (!res.ok) throw new Error(`Supabase ${res.status}`);
    const rows = await res.json();
    return Array.isArray(rows) && rows.length ? rows[0] : null;
}

export default async function handler() {
    if (!SUPABASE_URL || !SUPABASE_KEY) {
        return jsonError('supabase_not_configured',
            'SUPABASE_URL / SUPABASE_SERVICE_KEY (or SUPABASE_SECRET_KEY) missing',
            { status: 500 });
    }

    let row;
    try {
        row = await readLatest();
    } catch (err) {
        return jsonError('upstream_unavailable', err.message,
            { status: 503, source: 'Supabase weather_extremes_cache' });
    }

    if (!row) {
        // Fresh deploy before the first hourly pg_cron run — structured,
        // cache-briefly, so clients can show "warming up" rather than error.
        return jsonOk({
            updated: new Date().toISOString(),
            status:  'warming_up',
            hint:    'compute_weather_extremes() has not produced a row yet; the pg_cron job runs hourly at :20',
            categories: { heat: [], cold: [], wind: [], precip: [] },
        }, { maxAge: 60, swr: 60 });
    }

    const p = row.payload ?? {};
    return jsonOk({
        updated:        row.computed_at,
        frame_time:     row.frame_time,
        window_days:    row.window_days,
        frames_sampled: row.frames_sampled,
        categories: {
            heat:   clusterCells(p.heat),
            cold:   clusterCells(p.cold),
            wind:   clusterCells(p.wind),
            precip: clusterCells(p.precip),
        },
        summary: p.summary ?? {},
        units:   p.units   ?? { t: '°C', wind: 'm/s', precip: 'mm' },
        method:  'per-cell percentile vs 30-day archive; sev 1=p95, 2=p99, 3=window record',
    }, { maxAge: CACHE_TTL, swr: CACHE_SWR });
}
