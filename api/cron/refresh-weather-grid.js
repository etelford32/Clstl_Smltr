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

const GRID_W     = 36;
const GRID_H     = 18;
const GRID_N     = GRID_W * GRID_H;   // 648
const CHUNK_SIZE = 162;                // GRID_N / 4

// Open-Meteo `current=` variables. `cape` is hourly-only upstream — keeping
// it here returned an 86-byte error body and masqueraded as a timeout.
const CURRENT_VARS = [
    'temperature_2m', 'relative_humidity_2m', 'surface_pressure',
    'wind_speed_10m', 'wind_direction_10m',
    'cloud_cover_low', 'cloud_cover_mid', 'cloud_cover_high',
    'precipitation',
].join(',');

// Primary = default seamless blend. Fallback = GFS-only via the same
// provider. If Open-Meteo is globally unreachable both fail and we record
// the reason; the next scheduled tick retries automatically.
const ATTEMPTS = [
    { src: 'open-meteo',     modelQuery: '' },
    { src: 'open-meteo-gfs', modelQuery: '&models=gfs_seamless' },
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
        lats.push(-85  + j * 10);
        lons.push(-175 + i * 10);
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
 * One attempt: fetch all chunks sequentially, concatenate in order.
 * Returns { merged, failureReason }. `merged` is an array of exactly
 * GRID_N items on success, null on any failure.
 */
async function fetchAllChunks(src, modelQuery) {
    const merged = [];
    for (let start = 0; start < GRID_N; start += CHUNK_SIZE) {
        const end = Math.min(start + CHUNK_SIZE - 1, GRID_N - 1);
        const url = chunkUrl(start, end, modelQuery);

        let body, parsed;
        try {
            const res = await fetchWithTimeout(url, {
                timeoutMs: UPSTREAM_TIMEOUT_MS,
                headers:   { Accept: 'application/json' },
            });
            body = await res.text();
            if (!res.ok) {
                // Surface the body snippet so rate-limit / WAF pages are
                // distinguishable from real JSON errors.
                return {
                    merged: null,
                    failureReason: `${src} chunk ${start} HTTP ${res.status}: ${body.slice(0, 300)}`,
                };
            }
        } catch (e) {
            return {
                merged: null,
                failureReason: `${src} chunk ${start} fetch: ${e.message}`,
            };
        }

        if (!body || body.length === 0) {
            return { merged: null, failureReason: `${src} chunk ${start} empty response` };
        }

        try {
            parsed = JSON.parse(body);
        } catch (e) {
            return {
                merged: null,
                failureReason: `${src} chunk ${start} parse: ${e.message} | body[0..300]=${body.slice(0, 300)}`,
            };
        }

        // Open-Meteo error envelope: {"error":true,"reason":"..."}
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.error === true) {
            return {
                merged: null,
                failureReason: `${src} chunk ${start} upstream error: ${parsed.reason ?? 'unknown'}`,
            };
        }

        const items = Array.isArray(parsed) ? parsed : [parsed];
        if (items.length === 0) {
            return { merged: null, failureReason: `${src} chunk ${start} zero-length array` };
        }
        merged.push(...items);
    }

    if (merged.length !== GRID_N) {
        return {
            merged: null,
            failureReason: `${src} merged length ${merged.length} != ${GRID_N}`,
        };
    }
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
    for (const { src, modelQuery } of ATTEMPTS) {
        const attempt = await fetchAllChunks(src, modelQuery);
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

    let insertedId;
    try {
        insertedId = await supabaseInsertGridRow(winSource, merged);
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
        p_source: winSource,
    });

    return new Response(JSON.stringify({
        ok:        true,
        id:        insertedId,
        source:    winSource,
        locations: merged.length,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
