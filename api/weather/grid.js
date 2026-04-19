/**
 * Vercel Edge Function: /api/weather/grid
 *
 * Public reader. Returns the newest row from Supabase's weather_grid_cache
 * — a 648-location Open-Meteo snapshot.
 *
 * Three-layer freshness strategy (Hobby-plan friendly):
 *   1. Vercel Edge CDN fronts this route with s-maxage=3600. Once a POP
 *      has served one response, every subsequent visitor in that region
 *      gets the cached bytes — zero DB hits, zero upstream calls.
 *   2. Supabase persists the row so a cold POP (or redeploy) still serves
 *      data without waiting for the next scheduler tick.
 *   3. LAZY REFRESH: when the function runs and sees a row older than
 *      STALE_THRESHOLD_S, it fires performRefresh() via ctx.waitUntil()
 *      while returning the stale row immediately. First visitor of each
 *      hour pays zero latency; the next visitor (within ~5 s) gets fresh
 *      data. This makes the endpoint self-healing even if no cron runs.
 *
 * stale-while-revalidate=600 lets the CDN keep serving a ~1 hr old copy
 * for up to 10 extra minutes while it refreshes in the background.
 *
 * Scheduled refreshers (ranked by cadence):
 *   - GitHub Actions Cron — hourly, primary (requires CRON_SECRET).
 *   - Vercel Cron — daily, Hobby-plan safety net (vercel.json).
 *   - The lazy-refresh path above handles the gap if traffic is steady.
 *
 * Response shape (consumed by js/weather-feed.js):
 *   {
 *     source:      "open-meteo",
 *     fetched_at:  "2025-…Z",
 *     age_seconds: 1234,
 *     data:        [ { current: { temperature_2m, … } }, … ]  // 648 items
 *   }
 *
 * ── Env vars ────────────────────────────────────────────────────────
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_KEY   — service_role (bypasses RLS)
 */

export const config = { runtime: 'edge' };

import { performRefresh } from './refresh.js';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || '';

const CACHE_TTL         = 3600;   // 1 hour — matches target cron cadence
const CACHE_SWR         = 600;    // serve stale up to 10 min while refreshing
const ERROR_CACHE_TTL   = 30;     // brief cache on upstream failure
const EMPTY_CACHE_TTL   = 15;     // even briefer when cache is empty — prod just deployed
const STALE_THRESHOLD_S = 3000;   // 50 min — trigger lazy refresh just before CDN cache expires

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

// Fire a lazy refresh without blocking the response. Errors are swallowed —
// the next visitor (or the next cron) will try again. Deduplication isn't
// necessary: parallel refreshes insert two nearly-identical rows and
// readLatest() picks the newest one.
function kickOffLazyRefresh(ctx) {
    if (!ctx || typeof ctx.waitUntil !== 'function') return;
    ctx.waitUntil(
        performRefresh().catch((e) => {
            console.warn('[weather/grid] lazy refresh failed:', e.message);
        })
    );
}

export default async function handler(_req, ctx) {
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
        // Cache never populated yet — trigger a refresh IN FOREGROUND so this
        // very request can return fresh data instead of 503'ing. Happens once
        // per deployment; subsequent requests go through the fast path.
        try {
            const r = await performRefresh();
            return json({
                source:      r.source,
                fetched_at:  r.refreshed_at,
                age_seconds: 0,
                data:        (await readLatest())?.payload ?? [],
            });
        } catch (e) {
            return json({ error: 'cache_empty', detail: e.message }, 503, EMPTY_CACHE_TTL);
        }
    }

    const fetchedMs = Date.parse(row.fetched_at);
    const ageSec    = Number.isFinite(fetchedMs)
        ? Math.max(0, Math.floor((Date.now() - fetchedMs) / 1000))
        : null;

    // Lazy-refresh path: if the row is getting stale, kick off an async
    // refresh while we return the current (still acceptable) data. The
    // next function invocation will read the freshly-written row.
    if (ageSec !== null && ageSec >= STALE_THRESHOLD_S) {
        kickOffLazyRefresh(ctx);
    }

    return json({
        source:      row.source ?? 'open-meteo',
        fetched_at:  row.fetched_at,
        age_seconds: ageSec,
        data:        row.payload,
    });
}
