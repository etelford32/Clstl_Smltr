/**
 * Vercel Edge Function: /api/weather/grid
 *
 * Public reader. Returns the newest row from Supabase's weather_grid_cache —
 * a 648-location Open-Meteo snapshot.
 *
 * Cache strategy (two layers):
 *   1. Vercel Edge CDN fronts this route with s-maxage=3600. Once a POP has
 *      served one response, every subsequent visitor in that region gets
 *      the cached bytes — zero DB hits, zero upstream calls.
 *   2. Supabase persists the row so a cold POP (or redeploy) still serves
 *      fresh data without waiting for the next refresh tick.
 *
 * stale-while-revalidate=600 lets the CDN keep serving a ~1 hr old copy for
 * up to 10 extra minutes while it refreshes in the background.
 *
 * Refresher: Supabase pg_cron — hourly, sole writer. Defined in
 * supabase-weather-pgcron-migration.sql. Runs entirely inside Postgres; no
 * Vercel cron, no GitHub Actions. Staleness is surfaced to the UI via the
 * `age_seconds` field on responses so a silent pg_cron failure is visible
 * to visitors within one reload.
 *
 * Response shape (consumed by js/weather-feed.js):
 *   {
 *     source:      "open-meteo",
 *     fetched_at:  "2025-…Z",
 *     age_seconds: 1234,
 *     data:        [ { current: { temperature_2m, … } }, … ]   // 648 items
 *   }
 *
 * ── Env vars ────────────────────────────────────────────────────────
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_KEY   — service_role (bypasses RLS)
 */

export const config = { runtime: 'edge' };

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || '';

const CACHE_TTL        = 3600;   // 1 hour — matches pg_cron cadence
const CACHE_SWR        = 600;    // serve stale up to 10 min while refreshing
const ERROR_CACHE_TTL  = 30;     // brief cache on upstream failure

function json(body, status = 200, maxAge = CACHE_TTL) {
    const cache = status === 200
        ? `public, s-maxage=${maxAge}, stale-while-revalidate=${CACHE_SWR}`
        : `public, s-maxage=${ERROR_CACHE_TTL}`;
    return Response.json(body, {
        status,
        headers: {
            'Cache-Control':               cache,
            'Access-Control-Allow-Origin': '*',
        },
    });
}

async function readLatest() {
    const url = `${SUPABASE_URL}/rest/v1/weather_grid_cache` +
                `?select=fetched_at,source,payload` +
                `&order=fetched_at.desc&limit=1`;
    const res = await fetch(url, {
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
        return json({ error: 'supabase_not_configured' }, 500);
    }
    let row;
    try {
        row = await readLatest();
    } catch (e) {
        return json({ error: 'cache_unavailable', detail: e.message }, 503);
    }
    if (!row) {
        // Cache never populated yet — shorten TTL so clients retry quickly
        // once the first refresh (pg_cron or Vercel daily) completes.
        return json({ error: 'cache_empty' }, 503);
    }

    const fetchedMs = Date.parse(row.fetched_at);
    const ageSec    = Number.isFinite(fetchedMs)
        ? Math.max(0, Math.floor((Date.now() - fetchedMs) / 1000))
        : null;

    return json({
        source:      row.source ?? 'open-meteo',
        fetched_at:  row.fetched_at,
        age_seconds: ageSec,
        data:        row.payload,
    });
}
