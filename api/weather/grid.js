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
 *     source:      "open-meteo:72x36",          // optional :WxH grid suffix
 *     fetched_at:  "2025-…Z",
 *     age_seconds: 1234,
 *     grid:        { w: 72, h: 36, deg: 5 },    // null for legacy rows
 *     data:        [ { current: { temperature_2m, … } }, … ]   // 2592 items
 *   }
 *
 * The `grid` object is parsed out of the `source` column's `:WxH` suffix the
 * cron writer attaches (see api/cron/refresh-weather-grid.js). For older rows
 * written by the previous cron build the suffix is absent — frontend infers
 * dims from data.length in that case.
 *
 * ── Env vars ────────────────────────────────────────────────────────
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_KEY   — service_role (bypasses RLS)
 */

import { jsonOk, jsonError, fetchWithTimeout, CORS_HEADERS } from '../_lib/responses.js';

export const config = { runtime: 'edge' };

// Accept both the server-only naming (SUPABASE_URL / SUPABASE_SERVICE_KEY)
// and Supabase/Vercel's current convention (NEXT_PUBLIC_SUPABASE_URL,
// SUPABASE_SECRET_KEY — "secret key" replaced "service_role key" in
// Supabase's 2024 rename). This removes a whole class of "I set the var
// but it still 500s" bugs on fresh deploys.
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY || '';

const CACHE_TTL = 3600;   // 1 hour — matches pg_cron cadence
const CACHE_SWR = 600;    // serve stale up to 10 min while refreshing

async function readLatest() {
    const url = `${SUPABASE_URL}/rest/v1/weather_grid_cache` +
                `?select=fetched_at,source,payload` +
                `&order=fetched_at.desc&limit=1`;
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
    // Explicit per-var reporting so an operator hitting the endpoint in a
    // browser (or the frontend's devtools Network tab) sees exactly which
    // env var Vercel is missing in the current environment — no more "why
    // is it 500?" detective work. Cache this briefly so a misconfigured
    // environment doesn't get hammered on every pageview.
    const missing = [];
    if (!SUPABASE_URL) missing.push('SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL)');
    if (!SUPABASE_KEY) missing.push('SUPABASE_SERVICE_KEY (or SUPABASE_SECRET_KEY)');
    if (missing.length) {
        return Response.json({
            error:   'supabase_not_configured',
            missing,
            hint:    'Vercel → Project Settings → Environment Variables → Production. Add missing vars, redeploy.',
        }, {
            status: 500,
            headers: {
                'Cache-Control': `public, s-maxage=60`,
                ...CORS_HEADERS,
            },
        });
    }
    let row;
    try {
        row = await readLatest();
    } catch (e) {
        return jsonError('cache_unavailable', e.message, { source: 'supabase/weather_grid_cache' });
    }
    if (!row) {
        // Cache never populated yet — shorten TTL so clients retry quickly
        // once the first refresh (pg_cron or Vercel daily) completes.
        return jsonError('cache_empty', 'weather_grid_cache is empty', {
            source: 'supabase/weather_grid_cache',
            maxAge: 30,
        });
    }

    const fetchedMs = Date.parse(row.fetched_at);
    const ageSec    = Number.isFinite(fetchedMs)
        ? Math.max(0, Math.floor((Date.now() - fetchedMs) / 1000))
        : null;

    // Source format: "<provider>" or "<provider>:<W>x<H>" — the grid suffix
    // the cron writer adds when it knows the resolution. Old rows lack the
    // suffix; clients fall back to inferring W,H from data.length.
    const rawSource = row.source ?? 'open-meteo';
    let grid = null;
    const m = /:(\d+)x(\d+)$/.exec(rawSource);
    if (m) {
        const w = parseInt(m[1], 10);
        const h = parseInt(m[2], 10);
        if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
            grid = { w, h, deg: 180 / h };
        }
    }

    return jsonOk({
        source:      rawSource,
        fetched_at:  row.fetched_at,
        age_seconds: ageSec,
        grid,
        data:        row.payload,
    }, { maxAge: CACHE_TTL, swr: CACHE_SWR });
}
