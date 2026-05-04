/**
 * Vercel Node Cron: /api/cron/refresh-weather-grid
 *
 * Hourly writer for weather_grid_cache. Replaces the Supabase pg_cron job
 * because Supabase's shared egress IP keeps hitting Open-Meteo's per-IP
 * 10 000 calls/day free-tier limit (exhausted by other tenants, not us —
 * observed in pipeline_heartbeat as "Daily API request limit exceeded").
 * Vercel's edge IP pool is wider but shares the same risk; the chunk
 * collapse below cuts our daily call count from 384/day → 72/day.
 *
 * Behavior:
 *
 *   - 2592-point grid (-87.5…87.5 lat × -177.5…177.5 lon, 5° spacing)
 *   - 3 chunks × 864 locations — collapsed from 16×162 to minimise daily
 *     upstream calls. URL ~10 KB, response ~700 KB; fan out 3-wide.
 *   - Primary attempt on Open-Meteo's default seamless blend; fallback
 *     on &models=gfs_seamless. If the first attempt sees a "Daily API
 *     request limit" envelope, the gfs_seamless retry is skipped (same
 *     IP, same exhausted quota) and we jump to MET Norway.
 *   - MET Norway fallback fetches a coarse 36×18 grid (648 points, 10°
 *     spacing) and bilinear-upsamples to 72×36 server-side. The full
 *     2592-point fetch can't fit Vercel's 60 s Node ceiling at the
 *     20 rps ToS cap; the coarse fallback finishes in ~30-40 s.
 *   - Surfaces Open-Meteo {"error":true,"reason":"..."} bodies directly
 *     so future failures self-diagnose.
 *   - Writes the 2592-item payload into weather_grid_cache and records
 *     success/failure in pipeline_heartbeat. Wraps the whole flow in a
 *     watchdog that fires record_pipeline_failure if the worker is about
 *     to be killed for over-budget — without it, a timed-out worker
 *     leaves the heartbeat frozen (the "4-day silent stall" mode).
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

// Node runtime (not Edge). Edge has a hard 25 s per-invocation cap which the
// MET Norway fallback can't fit inside on a 2592-point grid (sequential point
// fetches at the 20 rps ToS cap). Node serverless on Pro can run up to 300 s;
// 60 s is enough headroom for the metno fallback to complete (~30-40 s) and
// the watchdog to fire a structured failure-write on the few-percent of runs
// that still go long.
export const config = { runtime: 'nodejs', maxDuration: 60 };

// Watchdog deadline. A few seconds shorter than maxDuration so the failure-
// write to pipeline_heartbeat finishes before Vercel kills the invocation.
// Without this, a timed-out worker leaves the heartbeat frozen at the last
// failure it recorded — which is exactly how this pipeline went 4 days stale
// without anyone noticing.
const WATCHDOG_MS = 57_000;

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY || '';
const CRON_SECRET  = process.env.CRON_SECRET || '';

const OPEN_METEO_BASE = 'https://api.open-meteo.com/v1/forecast';

// MET Norway fallback. Free, JSON, no-key — but point-only (no multi-location
// URL). We sample the coarse FALLBACK_GRID (648 points, 10° spacing) rather
// than the full 2592-point grid so the fan-out fits inside Vercel's 60 s
// Node budget; the result is bilinear-upsampled to GRID_W×GRID_H before
// insert. ToS caps clients at 20 req/s/app; METNO_CONCURRENCY pegs us at
// ~16 req/s.
const METNO_BASE       = 'https://api.met.no/weatherapi/locationforecast/2.0/compact';
const METNO_USER_AGENT = process.env.METNO_USER_AGENT
    || 'ParkerPhysics/1.0 (+https://parkersphysics.com; ops@parkersphysics.com)';
// 16 workers × ~1 req/s/worker ≈ 16 req/s — at MET Norway's 20 req/s ToS
// ceiling but inside it. Bumped from 8 because the fallback now has to
// finish inside Vercel Node's maxDuration (60 s) rather than Edge's 25 s.
// Even at 16-wide, fetching the full 2592-point grid takes ~160 s; that's
// why fetchAllMetno() samples a coarser 36×18 (10°) grid and bilinear-
// upsamples to 72×36 server-side. Metno is the safety net, not the
// preferred provider — slight resolution loss in fallback mode is fine.
const METNO_CONCURRENCY = 16;

// Grid resolution. Bumped from 10° (36×18=648) to 5° (72×36=2592) to give
// the cloud / temp / pressure textures four pixels where they used to have
// one. The downstream consumer (js/weather-feed.js) infers W and H from
// payload length (sqrt(N/2)·2), so a denser cron row drops in without a
// coordinated frontend deploy. To go denser later (e.g. 2.5° = 144×72),
// bump GRID_W/H here and adjust CHUNK_SIZE / CHUNK_CONCURRENCY only.
const GRID_W           = 72;
const GRID_H           = 36;
const GRID_N           = GRID_W * GRID_H;   // 2592
// Three big chunks of 864 points instead of 16 small chunks of 162. Cuts the
// daily Open-Meteo call count from 384/day to 72/day, which matters because
// Open-Meteo's 10 000/day limit is per-IP, and Vercel's edge IP pool is shared
// with other tenants — the fewer calls we make, the less likely we'll trip a
// shared-IP "Daily API request limit exceeded" envelope. URL length at
// CHUNK_SIZE=864 is ~10 KB, well inside Open-Meteo's accepted range and below
// the 16 KB upper bound common across CDNs / origin servers.
const CHUNK_SIZE       = 864;                // 3 chunks @ 864 each
// All three chunks fan out at once. Open-Meteo absorbs ~20 concurrent reqs
// per source IP before throttling; 3-wide is conservative.
const CHUNK_CONCURRENCY = 3;
const GRID_DEG          = 180 / GRID_H;       // 5° latitude step (also longitude)
// Centered-cell origin: half a step inside each pole so cells are symmetric
// about lat 0 (the equator falls on a cell edge, not a centre, which keeps
// equatorial averages honest).
const LAT_ORIGIN        = -90 + GRID_DEG / 2;  // -87.5 for 5° grid
const LON_ORIGIN        = -180 + GRID_DEG / 2; // -177.5 for 5° grid

// Coarse fallback grid for MET Norway. 36×18 = 648 points, 10° spacing.
// Sized to fit the 60 s Node budget at 16 concurrent workers and ~1 req/s/
// worker (≈ 40 s wallclock). Bilinear-upsampled to GRID_W × GRID_H before
// insert so cache consumers see the same array length regardless of which
// upstream won.
const FALLBACK_GRID_W      = 36;
const FALLBACK_GRID_H      = 18;
const FALLBACK_GRID_N      = FALLBACK_GRID_W * FALLBACK_GRID_H;   // 648
const FALLBACK_GRID_DEG    = 180 / FALLBACK_GRID_H;                // 10°
const FALLBACK_LAT_ORIGIN  = -90 + FALLBACK_GRID_DEG / 2;          // -85
const FALLBACK_LON_ORIGIN  = -180 + FALLBACK_GRID_DEG / 2;         // -175

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

// Per-chunk upstream timeout. Open-Meteo p99 for 864-location current-only
// requests is ~6 s; 12 s gives comfortable headroom without pinning the
// worker on a globally-degraded upstream.
const UPSTREAM_TIMEOUT_MS = 12000;

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
        const reason = parsed.reason ?? 'unknown';
        // Daily-limit exhaustion is per-IP. Retrying gfs_seamless against the
        // same exhausted Vercel edge IP costs 8 s and never succeeds — flag
        // the failure as `dailyLimitHit: true` so fetchAllChunks() can short-
        // circuit straight to the MET Norway fallback (a different upstream
        // entirely, no shared limit).
        const dailyLimitHit = /daily api request limit/i.test(reason);
        return {
            failureReason: `${src} chunk ${start} upstream error: ${reason}`,
            dailyLimitHit,
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
    const results        = new Array(chunkRanges.length).fill(null);
    let cursor           = 0;
    let earlyFail        = null;
    let dailyLimitHit    = false;

    async function worker() {
        while (earlyFail === null) {
            const idx = cursor++;
            if (idx >= chunkRanges.length) return;
            const { start, end } = chunkRanges[idx];
            const r = await fetchOneChunk(src, modelQuery, start, end);
            if (r.failureReason) {
                if (earlyFail === null) earlyFail = r.failureReason;
                if (r.dailyLimitHit) dailyLimitHit = true;
                return;
            }
            results[idx] = r.items;
        }
    }
    await Promise.all(Array.from({ length: CHUNK_CONCURRENCY }, worker));

    if (earlyFail) {
        return { merged: null, failureReason: earlyFail, dailyLimitHit };
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
// MET Norway has no multi-location endpoint — every cell is a separate HTTP
// call, paced by METNO_CONCURRENCY. To fit Vercel's 60 s Node ceiling we
// fetch the coarse 36×18 grid (648 points, 10° spacing) and bilinear-upsample
// to the canonical 72×36 grid before insert. Consumers see the same array
// length regardless of which source won; rows from this fallback are tagged
// __upsampled: true so analytics can flag the lower spatial resolution.

function fallbackGridLatLon(idx) {
    const j = Math.floor(idx / FALLBACK_GRID_W);
    const i = idx % FALLBACK_GRID_W;
    return {
        lat: FALLBACK_LAT_ORIGIN + j * FALLBACK_GRID_DEG,
        lon: FALLBACK_LON_ORIGIN + i * FALLBACK_GRID_DEG,
    };
}

// Numeric fields that participate in bilinear upsample. Anything outside this
// list is copied from the nearest source cell verbatim (units, time, flags).
const METNO_NUMERIC_FIELDS = [
    'temperature_2m', 'relative_humidity_2m', 'surface_pressure',
    'wind_speed_10m', 'wind_direction_10m',
    'cloud_cover_low', 'cloud_cover_mid', 'cloud_cover_high',
    'precipitation',
];

// Bilinear interpolate one numeric field over the 4 corners. Skips any null/
// non-finite corner so a single missing point doesn't poison the whole 2×2
// upsampled patch — falls back to the mean of the finite corners.
function _blendField(corners, weights, field) {
    let acc = 0;
    let wsum = 0;
    for (let k = 0; k < 4; k++) {
        const v = corners[k]?.current?.[field];
        if (Number.isFinite(v)) {
            acc  += v * weights[k];
            wsum += weights[k];
        }
    }
    return wsum > 0 ? acc / wsum : null;
}

/**
 * Bilinear-upsample a coarse (FALLBACK_GRID_W × FALLBACK_GRID_H) array of
 * per-location MET Norway points to the canonical (GRID_W × GRID_H) layout.
 * Cell-centre alignment: target cell (I, J) maps to fractional source
 * (i_s = (I + 0.5) * FALLBACK_GRID_W / GRID_W − 0.5,
 *  j_s = (J + 0.5) * FALLBACK_GRID_H / GRID_H − 0.5)
 * so corner cells end up partially extrapolated rather than awkwardly NaN.
 */
function upsampleToGrid(coarse) {
    const out = new Array(GRID_N);
    const fwRatio = FALLBACK_GRID_W / GRID_W;   // 0.5 for 36→72
    const fhRatio = FALLBACK_GRID_H / GRID_H;   // 0.5 for 36→72
    for (let J = 0; J < GRID_H; J++) {
        const jSrc   = (J + 0.5) * fhRatio - 0.5;
        const j0     = Math.max(0, Math.min(FALLBACK_GRID_H - 1, Math.floor(jSrc)));
        const j1     = Math.max(0, Math.min(FALLBACK_GRID_H - 1, j0 + 1));
        const fj     = Math.max(0, Math.min(1, jSrc - j0));
        for (let I = 0; I < GRID_W; I++) {
            const iSrc   = (I + 0.5) * fwRatio - 0.5;
            const i0     = Math.max(0, Math.min(FALLBACK_GRID_W - 1, Math.floor(iSrc)));
            const i1     = Math.max(0, Math.min(FALLBACK_GRID_W - 1, i0 + 1));
            const fi     = Math.max(0, Math.min(1, iSrc - i0));
            const corners = [
                coarse[j0 * FALLBACK_GRID_W + i0],   // top-left
                coarse[j0 * FALLBACK_GRID_W + i1],   // top-right
                coarse[j1 * FALLBACK_GRID_W + i0],   // bottom-left
                coarse[j1 * FALLBACK_GRID_W + i1],   // bottom-right
            ];
            const weights = [
                (1 - fi) * (1 - fj),
                fi       * (1 - fj),
                (1 - fi) * fj,
                fi       * fj,
            ];
            const current = {};
            // Anchor metadata (time, units) from the nearest source corner —
            // pick whichever weight is biggest. Numeric fields blend.
            const anchorIdx = weights.indexOf(Math.max(...weights));
            const anchor    = corners[anchorIdx];
            current.time    = anchor?.current?.time ?? null;
            for (const f of METNO_NUMERIC_FIELDS) {
                current[f] = _blendField(corners, weights, f);
            }
            out[J * GRID_W + I] = {
                latitude:        LAT_ORIGIN + J * GRID_DEG,
                longitude:       LON_ORIGIN + I * GRID_DEG,
                elevation:       anchor?.elevation ?? null,
                current_units:   anchor?.current_units ?? null,
                current,
                __pressure_kind: 'mean_sea_level',
                __upsampled:     true,
            };
        }
    }
    return out;
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
    const { lat, lon } = fallbackGridLatLon(idx);
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
    // Fixed-output array so positional ordering matches the coarse grid index
    // even though we fan out concurrently. A small fraction of points may end
    // up null (transient upstream errors) — we tolerate up to 1% missing
    // before declaring the attempt a failure.
    const coarse = new Array(FALLBACK_GRID_N).fill(null);
    let nextIdx  = 0;
    let errCount = 0;
    let lastErr  = null;
    const MAX_MISSING = Math.floor(FALLBACK_GRID_N * 0.01);  // ≤ 6 of 648

    async function worker() {
        while (true) {
            const idx = nextIdx++;
            if (idx >= FALLBACK_GRID_N) return;
            const { point, err } = await fetchOneMetnoPoint(idx);
            if (point) {
                coarse[idx] = point;
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
            failureReason: `${src} too many failures (${errCount}/${FALLBACK_GRID_N}); last: ${lastErr ?? 'unknown'}`,
        };
    }

    // Backfill the few missing coarse cells from a neighbour so the upsample
    // step doesn't have to special-case nulls in every corner blend.
    for (let i = 0; i < FALLBACK_GRID_N; i++) {
        if (!coarse[i]) {
            const neighbour = coarse[Math.max(0, i - 1)] || coarse[Math.min(FALLBACK_GRID_N - 1, i + 1)];
            coarse[i] = neighbour ? { ...neighbour, __backfilled: true } : null;
        }
    }
    if (coarse.some(p => p === null)) {
        return { merged: null, failureReason: `${src} backfill failed (all-null neighbour run)` };
    }

    // Bilinear-upsample to canonical 72×36. Result has GRID_N entries and
    // the same per-location envelope shape as Open-Meteo paths produce.
    const merged = upsampleToGrid(coarse);
    return { merged, failureReason: null };
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

// Core refresh logic, separate from the watchdog wrapper. Returns the
// finished Response so the wrapper can race it against the deadline.
async function runRefresh(request) {
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

    let winSource    = null;
    let merged       = null;
    let lastErr      = null;
    let skipOpenMeteo = false;
    for (const { src, fetcher, modelQuery } of ATTEMPTS) {
        // If the first Open-Meteo attempt hit the daily IP limit, skip the
        // gfs_seamless retry — it's the same provider on the same exhausted
        // edge IP and would just burn 8 s of our budget. Jump straight to
        // MET Norway, which is a different upstream entirely.
        if (fetcher === 'openmeteo' && skipOpenMeteo) {
            lastErr = `${src} skipped (daily-limit short-circuit)`;
            continue;
        }
        const attempt = fetcher === 'metno'
            ? await fetchAllMetno(src)
            : await fetchAllChunks(src, modelQuery);
        if (attempt.merged) {
            winSource = src;
            merged    = attempt.merged;
            break;
        }
        lastErr = attempt.failureReason;
        if (attempt.dailyLimitHit) skipOpenMeteo = true;
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

// Public handler. Races runRefresh against a watchdog so an over-budget
// invocation still records a structured failure to pipeline_heartbeat —
// without this, the four-day silent freeze that prompted this rewrite can
// recur the next time an upstream goes globally degraded.
export default async function handler(request) {
    let timer;
    const watchdog = new Promise((resolve) => {
        timer = setTimeout(async () => {
            await supabaseCallRpc('record_pipeline_failure', {
                p_name:   'weather_grid',
                p_reason: `worker_timeout: exceeded ${WATCHDOG_MS} ms before any source completed`,
            });
            resolve(new Response(JSON.stringify({
                ok:     false,
                reason: 'worker_timeout',
                budget_ms: WATCHDOG_MS,
            }), { status: 504, headers: { 'Content-Type': 'application/json' } }));
        }, WATCHDOG_MS);
    });
    try {
        return await Promise.race([runRefresh(request), watchdog]);
    } finally {
        clearTimeout(timer);
    }
}
