/**
 * Vercel Edge Cron: /api/cron/refresh-weather-grid
 *
 * Hourly writer for weather_grid_cache. Replaces the Supabase pg_cron job
 * because Supabase's shared egress IP keeps hitting Open-Meteo's per-IP
 * 10 000 calls/day free-tier limit (exhausted by other tenants, not us —
 * observed in pipeline_heartbeat as
 * "open-meteo-gfs chunk 0 upstream error: Daily API request limit
 * exceeded"). Vercel edge POPs have a much wider egress-IP pool that
 * doesn't share the same saturation.
 *
 * Behavior mirrors the pg_cron function we're retiring (which is left in
 * place as a manually-invokable fallback):
 *
 *   - 648-point grid (-85…85 lat × -175…175 lon, 10° spacing)
 *   - 4 chunks × 162 locations — keeps each URL under ~1 KB and each
 *     response under ~130 KB, well inside any TLS / timeout budget.
 *   - Primary attempt on Open-Meteo's default seamless blend; fallback
 *     on &models=gfs_seamless. First success wins.
 *   - Surfaces Open-Meteo {"error":true,"reason":"..."} bodies directly
 *     so future failures self-diagnose.
 *   - Writes the 648-item payload into weather_grid_cache and records
 *     success/failure in pipeline_heartbeat (same table the admin UI
 *     reads — no consumer changes required).
 *
 * ── Auth ────────────────────────────────────────────────────────────
 * Vercel Cron sends every invocation with the `x-vercel-cron: 1` header.
 * When CRON_SECRET is set in the project env, Vercel also attaches
 * `Authorization: Bearer <CRON_SECRET>`. This endpoint accepts either:
 *   - matching Bearer token (preferred), OR
 *   - x-vercel-cron header (fallback when CRON_SECRET isn't set yet)
 * Otherwise 401.
 *
 * ── Env vars ────────────────────────────────────────────────────────
 *   SUPABASE_URL           (or NEXT_PUBLIC_SUPABASE_URL)
 *   SUPABASE_SERVICE_KEY   (or SUPABASE_SECRET_KEY)   — service_role
 *   CRON_SECRET            (optional but recommended)
 */

import { fetchWithTimeout } from '../_lib/responses.js';

export const config = { runtime: 'edge' };

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY || '';
const CRON_SECRET  = process.env.CRON_SECRET || '';

const OPEN_METEO_BASE = 'https://api.open-meteo.com/v1/forecast';

// MET Norway fallback. Free, JSON, no-key — but point-only (no multi-location
// URL), so 648 sequential calls with bounded concurrency. Their ToS says
// 20 req/s/app cap; we run 4 workers and pace by upstream RTT, which lands
// around ~16 req/s well inside the limit.
const METNO_BASE       = 'https://api.met.no/weatherapi/locationforecast/2.0/compact';
const METNO_USER_AGENT = process.env.METNO_USER_AGENT
    || 'ParkerPhysics/1.0 (+https://parkersphysics.com; ops@parkersphysics.com)';
// 8 workers × ~2 req/s/worker ≈ 16 req/s — under MET Norway's 20 req/s ToS
// cap. The 4-wide setting was tuned for a 648-point grid; bumping to 8
// keeps the worst-case fallback time bounded as we densify the grid.
const METNO_CONCURRENCY = 8;

// Grid resolution. Bumped from 10° (36×18=648) to 5° (72×36=2592) to give
// the cloud / temp / pressure textures four pixels where they used to have
// one. The downstream consumer (js/weather-feed.js) infers W and H from
// payload length (sqrt(N/2)·2), so a denser cron row drops in without a
// coordinated frontend deploy. To go denser later (e.g. 2.5° = 144×72),
// bump GRID_W/H here and adjust CHUNK_SIZE / CHUNK_CONCURRENCY only.
const GRID_W           = 72;
const GRID_H           = 36;
const GRID_N           = GRID_W * GRID_H;   // 2592
const CHUNK_SIZE       = 162;                // 16 chunks @ 162 each
// Run chunks in parallel so the 4× location bump doesn't 4× the wallclock.
// Open-Meteo absorbs ~20 concurrent requests per source IP before throttling;
// 4-wide stays well inside that and matches the MET Norway worker count.
const CHUNK_CONCURRENCY = 4;
const GRID_DEG          = 180 / GRID_H;       // 5° latitude step (also longitude)
// Centered-cell origin: half a step inside each pole so cells are symmetric
// about lat 0 (the equator falls on a cell edge, not a centre, which keeps
// equatorial averages honest).
const LAT_ORIGIN        = -90 + GRID_DEG / 2;  // -87.5 for 5° grid
const LON_ORIGIN        = -180 + GRID_DEG / 2; // -177.5 for 5° grid

// Open-Meteo `current=` variables. `cape` is hourly-only upstream — keeping
// it here returned an 86-byte error body and masqueraded as a timeout.
const CURRENT_VARS = [
    'temperature_2m', 'relative_humidity_2m', 'surface_pressure',
    'wind_speed_10m', 'wind_direction_10m',
    'cloud_cover_low', 'cloud_cover_mid', 'cloud_cover_high',
    'precipitation',
].join(',');

// Source attempts in order. First one that returns a complete 648-item set
// wins; on any failure we move to the next. MET Norway is the cross-provider
// fallback — Open-Meteo's unrelated rate-limits/outages won't take it down
// because it's a different upstream entirely.
const ATTEMPTS = [
    { src: 'open-meteo',     fetcher: 'openmeteo', modelQuery: '' },
    { src: 'open-meteo-gfs', fetcher: 'openmeteo', modelQuery: '&models=gfs_seamless' },
    { src: 'met-norway',     fetcher: 'metno' },
];

// Per-chunk upstream timeout. Open-Meteo p99 for 162-location current-only
// requests is ~3 s; 8 s gives comfortable headroom without pinning the
// edge worker on a globally-degraded upstream.
const UPSTREAM_TIMEOUT_MS = 8000;

function isAuthorized(request) {
    const hdr = request.headers.get('authorization') ?? '';
    if (CRON_SECRET && hdr === `Bearer ${CRON_SECRET}`) return true;
    // Vercel cron always sends this header, and it cannot be set by an
    // external client (Vercel strips it at the edge). Treat as proof-of-
    // cron when CRON_SECRET hasn't been configured yet.
    if (request.headers.get('x-vercel-cron')) return true;
    return false;
}

// Chunk [start..end] inclusive → CSV lat/lon in row-major order (lat slow).
function chunkCoords(start, end) {
    const lats = [];
    const lons = [];
    for (let idx = start; idx <= end; idx++) {
        const j = Math.floor(idx / GRID_W);
        const i = idx % GRID_W;
        lats.push(LAT_ORIGIN + j * GRID_DEG);
        lons.push(LON_ORIGIN + i * GRID_DEG);
    }
    return { lat: lats.join(','), lon: lons.join(',') };
}

function chunkUrl(start, end, modelQuery) {
    const { lat, lon } = chunkCoords(start, end);
    return `${OPEN_METEO_BASE}`
        + `?latitude=${lat}`
        + `&longitude=${lon}`
        + `&current=${CURRENT_VARS}`
        + `&wind_speed_unit=ms`
        + `&timezone=UTC`
        + modelQuery;
}

/**
 * Fetch one chunk and parse it into a per-location array. Returns either
 * { items } on success or { failureReason } on any failure. Used by the
 * concurrent worker pool below.
 */
async function fetchOneChunk(src, modelQuery, start, end) {
    const url = chunkUrl(start, end, modelQuery);
    let body;
    try {
        const res = await fetchWithTimeout(url, {
            timeoutMs: UPSTREAM_TIMEOUT_MS,
            headers:   { Accept: 'application/json' },
        });
        body = await res.text();
        if (!res.ok) {
            return {
                failureReason: `${src} chunk ${start} HTTP ${res.status}: ${body.slice(0, 300)}`,
            };
        }
    } catch (e) {
        return { failureReason: `${src} chunk ${start} fetch: ${e.message}` };
    }
    if (!body || body.length === 0) {
        return { failureReason: `${src} chunk ${start} empty response` };
    }

    let parsed;
    try {
        parsed = JSON.parse(body);
    } catch (e) {
        return {
            failureReason: `${src} chunk ${start} parse: ${e.message} | body[0..300]=${body.slice(0, 300)}`,
        };
    }
    // Open-Meteo error envelope: {"error":true,"reason":"..."}
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.error === true) {
        return {
            failureReason: `${src} chunk ${start} upstream error: ${parsed.reason ?? 'unknown'}`,
        };
    }
    const items = Array.isArray(parsed) ? parsed : [parsed];
    if (items.length === 0) {
        return { failureReason: `${src} chunk ${start} zero-length array` };
    }
    return { items };
}

/**
 * One attempt: fetch all chunks with bounded concurrency, slot results back
 * into row-major order. Bails on the first failure (returns null) so the
 * caller can move down the ATTEMPTS list to the next source.
 *
 * Concurrency keeps wallclock close to single-chunk latency even as GRID_N
 * grows — e.g. 16 chunks at 4-wide ≈ 4 batches × ~2-3 s each.
 */
async function fetchAllChunks(src, modelQuery) {
    const chunkRanges = [];
    for (let start = 0; start < GRID_N; start += CHUNK_SIZE) {
        const end = Math.min(start + CHUNK_SIZE - 1, GRID_N - 1);
        chunkRanges.push({ start, end });
    }
    const results  = new Array(chunkRanges.length).fill(null);
    let cursor     = 0;
    let earlyFail  = null;

    async function worker() {
        while (earlyFail === null) {
            const idx = cursor++;
            if (idx >= chunkRanges.length) return;
            const { start, end } = chunkRanges[idx];
            const r = await fetchOneChunk(src, modelQuery, start, end);
            if (r.failureReason) {
                if (earlyFail === null) earlyFail = r.failureReason;
                return;
            }
            results[idx] = r.items;
        }
    }
    await Promise.all(Array.from({ length: CHUNK_CONCURRENCY }, worker));

    if (earlyFail) {
        return { merged: null, failureReason: earlyFail };
    }
    const merged = [];
    for (const items of results) merged.push(...items);

    if (merged.length !== GRID_N) {
        return {
            merged: null,
            failureReason: `${src} merged length ${merged.length} != ${GRID_N}`,
        };
    }
    return { merged, failureReason: null };
}

// ── MET Norway fetcher (fallback, point-only) ─────────────────────────────
//
// MET Norway has no multi-location endpoint — 648 separate calls, paced by
// METNO_CONCURRENCY. We translate each point's response into the same
// per-location envelope Open-Meteo returns so downstream readers see a
// consistent shape regardless of which source won.

function gridLatLon(idx) {
    const j = Math.floor(idx / GRID_W);
    const i = idx % GRID_W;
    return { lat: LAT_ORIGIN + j * GRID_DEG, lon: LON_ORIGIN + i * GRID_DEG };
}

function translateMetnoPoint(metno) {
    const first = metno?.properties?.timeseries?.[0];
    if (!first) return null;
    const inst  = first?.data?.instant?.details ?? {};
    const next1 = first?.data?.next_1_hours?.details ?? {};
    const coord = metno?.geometry?.coordinates ?? [];
    return {
        latitude:  coord[1],
        longitude: coord[0],
        elevation: coord[2] ?? null,
        current_units: {
            temperature_2m:       '°C',
            relative_humidity_2m: '%',
            surface_pressure:     'hPa',
            wind_speed_10m:       'm/s',
            wind_direction_10m:   '°',
            cloud_cover_low:      '%',
            cloud_cover_mid:      '%',
            cloud_cover_high:     '%',
            precipitation:        'mm',
        },
        current: {
            time:                 first.time,
            // MET Norway compact gives sea-level pressure, not surface;
            // close enough for the dashboard heatmap which only renders a
            // colour ramp. Mark via __pressure_kind for future readers.
            temperature_2m:       Number.isFinite(inst.air_temperature) ? inst.air_temperature : null,
            relative_humidity_2m: Number.isFinite(inst.relative_humidity) ? inst.relative_humidity : null,
            surface_pressure:     Number.isFinite(inst.air_pressure_at_sea_level) ? inst.air_pressure_at_sea_level : null,
            wind_speed_10m:       Number.isFinite(inst.wind_speed) ? inst.wind_speed : null,
            wind_direction_10m:   Number.isFinite(inst.wind_from_direction) ? inst.wind_from_direction : null,
            cloud_cover_low:      Number.isFinite(inst.cloud_area_fraction_low)    ? inst.cloud_area_fraction_low    : null,
            cloud_cover_mid:      Number.isFinite(inst.cloud_area_fraction_medium) ? inst.cloud_area_fraction_medium : null,
            cloud_cover_high:     Number.isFinite(inst.cloud_area_fraction_high)   ? inst.cloud_area_fraction_high   : null,
            precipitation:        Number.isFinite(next1.precipitation_amount) ? next1.precipitation_amount : null,
        },
        __pressure_kind: 'mean_sea_level',  // (Open-Meteo gives surface_pressure)
    };
}

async function fetchOneMetnoPoint(idx) {
    const { lat, lon } = gridLatLon(idx);
    // 4 decimals max — MET Norway returns 403 on higher precision.
    const url = `${METNO_BASE}?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`;
    let res;
    try {
        res = await fetchWithTimeout(url, {
            timeoutMs: 6000,
            headers: {
                'User-Agent': METNO_USER_AGENT,
                Accept:       'application/json',
            },
        });
    } catch (e) {
        return { idx, point: null, err: `fetch: ${e.message}` };
    }
    if (!res.ok) {
        return { idx, point: null, err: `HTTP ${res.status}` };
    }
    let body;
    try {
        body = await res.json();
    } catch (e) {
        return { idx, point: null, err: `parse: ${e.message}` };
    }
    const point = translateMetnoPoint(body);
    if (!point) return { idx, point: null, err: 'translate: empty timeseries' };
    return { idx, point, err: null };
}

async function fetchAllMetno(src) {
    // Fixed-output array so positional ordering matches the grid index even
    // though we fan out concurrently. A small fraction of points may end up
    // null (transient upstream errors over 30+ s) — we tolerate up to 1%
    // missing before declaring the attempt a failure.
    const out = new Array(GRID_N).fill(null);
    let nextIdx = 0;
    let errCount = 0;
    let lastErr = null;
    const MAX_MISSING = Math.floor(GRID_N * 0.01);  // ≤ 6 missing of 648

    async function worker() {
        while (true) {
            const idx = nextIdx++;
            if (idx >= GRID_N) return;
            const { point, err } = await fetchOneMetnoPoint(idx);
            if (point) {
                out[idx] = point;
            } else {
                errCount++;
                lastErr = err;
                if (errCount > MAX_MISSING) return;  // abort early
            }
        }
    }

    await Promise.all(Array.from({ length: METNO_CONCURRENCY }, worker));

    if (errCount > MAX_MISSING) {
        return {
            merged: null,
            failureReason: `${src} too many failures (${errCount}/${GRID_N}); last: ${lastErr ?? 'unknown'}`,
        };
    }

    // Backfill any small number of missing points with neighbour values so
    // the array length stays exactly GRID_N. Heatmap consumers tolerate
    // small-cell gaps; what they can't tolerate is a length mismatch.
    for (let i = 0; i < GRID_N; i++) {
        if (!out[i]) {
            const fallback = out[Math.max(0, i - 1)] || out[Math.min(GRID_N - 1, i + 1)];
            out[i] = fallback ? { ...fallback, __backfilled: true } : null;
        }
    }
    if (out.some(p => p === null)) {
        return { merged: null, failureReason: `${src} backfill failed (all-null neighbour run)` };
    }
    return { merged: out, failureReason: null };
}

// ── Supabase writes ────────────────────────────────────────────────────
// Both use service_role to bypass RLS. We hit PostgREST for the cache
// insert (simple row create) and the heartbeat RPCs (they're SECURITY
// DEFINER helpers that upsert pipeline_heartbeat).

async function supabaseInsertGridRow(source, payload) {
    const res = await fetchWithTimeout(
        `${SUPABASE_URL}/rest/v1/weather_grid_cache`,
        {
            method:  'POST',
            timeoutMs: 10000,
            headers: {
                apikey:         SUPABASE_KEY,
                Authorization:  `Bearer ${SUPABASE_KEY}`,
                'Content-Type': 'application/json',
                Prefer:         'return=representation',
            },
            body: JSON.stringify({ source, payload }),
        },
    );
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Supabase insert ${res.status}: ${text.slice(0, 300)}`);
    }
    const rows = await res.json().catch(() => []);
    return Array.isArray(rows) && rows[0]?.id ? rows[0].id : null;
}

async function supabaseCallRpc(fnName, args) {
    try {
        await fetchWithTimeout(
            `${SUPABASE_URL}/rest/v1/rpc/${fnName}`,
            {
                method:    'POST',
                timeoutMs: 5000,
                headers: {
                    apikey:         SUPABASE_KEY,
                    Authorization:  `Bearer ${SUPABASE_KEY}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(args),
            },
        );
    } catch {
        // Heartbeat / trim failures are non-fatal — swallow so a Supabase
        // hiccup doesn't mask the primary refresh result.
    }
}

// ── Handler ─────────────────────────────────────────────────────────────

export default async function handler(request) {
    if (!isAuthorized(request)) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
        });
    }

    if (!SUPABASE_URL || !SUPABASE_KEY) {
        return new Response(JSON.stringify({
            error:   'supabase_not_configured',
            missing: [
                !SUPABASE_URL ? 'SUPABASE_URL' : null,
                !SUPABASE_KEY ? 'SUPABASE_SERVICE_KEY' : null,
            ].filter(Boolean),
        }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }

    let winSource = null;
    let merged    = null;
    let lastErr   = null;
    for (const { src, fetcher, modelQuery } of ATTEMPTS) {
        const attempt = fetcher === 'metno'
            ? await fetchAllMetno(src)
            : await fetchAllChunks(src, modelQuery);
        if (attempt.merged) {
            winSource = src;
            merged    = attempt.merged;
            break;
        }
        lastErr = attempt.failureReason;
    }

    if (!merged) {
        const reason = lastErr || 'all weather sources exhausted';
        await supabaseCallRpc('record_pipeline_failure', {
            p_name:   'weather_grid',
            p_reason: reason,
        });
        return new Response(JSON.stringify({ ok: false, reason }), {
            status: 502,
            headers: { 'Content-Type': 'application/json' },
        });
    }

    // Tag the source with the grid dimensions so the frontend (and the
    // admin-side pipeline_heartbeat panel) can show "open-meteo:72x36"
    // verbatim in provenance overlays. The reader keeps `source` opaque,
    // so the frontend regex-parses `:WxH` to surface grid resolution.
    const sourceWithGrid = `${winSource}:${GRID_W}x${GRID_H}`;

    let insertedId;
    try {
        insertedId = await supabaseInsertGridRow(sourceWithGrid, merged);
    } catch (e) {
        await supabaseCallRpc('record_pipeline_failure', {
            p_name:   'weather_grid',
            p_reason: e.message,
        });
        return new Response(JSON.stringify({ ok: false, reason: e.message }), {
            status: 502,
            headers: { 'Content-Type': 'application/json' },
        });
    }

    // Opportunistic retention trim + heartbeat update. Neither is fatal.
    await supabaseCallRpc('trim_weather_grid_cache', {});
    await supabaseCallRpc('record_pipeline_success', {
        p_name:   'weather_grid',
        p_source: sourceWithGrid,
    });

    return new Response(JSON.stringify({
        ok:        true,
        id:        insertedId,
        source:    sourceWithGrid,
        locations: merged.length,
        grid:      { w: GRID_W, h: GRID_H, deg: GRID_DEG },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
