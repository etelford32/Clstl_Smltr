/**
 * Vercel Edge Function: /api/cron/warm-forecasts
 *
 * Runs every 10 min via Vercel cron (vercel.json). For each launch pad
 * with an upcoming launch, fires a warmup request to /api/weather/forecast
 * so the edge cache is primed when the first real visitor arrives.
 *
 * Why pre-warm?
 *   /api/weather/forecast edge-caches for 15 min (s-maxage=900). Without
 *   warming, the FIRST user to hit a cold cache pays the full Open-Meteo
 *   round-trip (1–3 s p99, up to 8 s if upstream is loaded). With warming,
 *   every visitor hits an edge cache entry directly (~20 ms).
 *
 *   The 10-min cadence is deliberately shorter than the 15-min cache TTL:
 *   it keeps stale-while-revalidate windows narrow (users never see data
 *   older than ~25 min) and ensures a cache miss is always followed by a
 *   warm window, never a persistent cold period.
 *
 * Auth:
 *   Vercel sends `x-vercel-cron: 1` header on cron invocations. In
 *   production we ALSO check the Authorization header against CRON_SECRET
 *   (set via Vercel env vars) so a manual curl from outside can't trigger
 *   warming and burn our Open-Meteo quota. Either marker is accepted so
 *   local testing works without configuring CRON_SECRET.
 *
 * Self-fetch:
 *   The cron handler calls /api/weather/forecast via the site's public URL
 *   (VERCEL_URL for preview, parkersphysics.com for prod). Going through
 *   the CDN is what populates the edge cache; a direct handler invocation
 *   would warm Open-Meteo but leave our own cache cold.
 */

import { jsonOk, jsonError, fetchWithTimeout } from '../_lib/responses.js';

export const config = { runtime: 'edge' };

// Public site URL for self-fetches. Production points at the canonical
// domain (consistent edge cache partition); preview deploys fall back to
// VERCEL_URL, which is unique per deploy — that's fine for preview since
// we're just smoke-testing there.
const PRODUCTION_URL = 'https://parkersphysics.com';
function siteUrl() {
    if (process.env.VERCEL_ENV === 'production') return PRODUCTION_URL;
    if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
    // Local dev fallback — cron won't run locally under Vercel but the
    // endpoint itself is hit by the dev server.
    return 'http://localhost:3000';
}

const CRON_SECRET      = process.env.CRON_SECRET || '';
const WARM_LIMIT       = 30;     // top N pads to warm per run
const WARM_BATCH_SIZE  = 5;      // parallel requests per batch (Open-Meteo courtesy)
const WARM_ITEM_TIMEOUT_MS = 8000;
// 90-day window matches the launch-planner's default filter — warming
// anything further out would waste cycles on pads that aren't on deck yet.
const LAUNCH_WINDOW_DAYS = 90;

/** Accept a cron request iff it carries one of the two known markers. */
function isAuthorizedCron(request) {
    // Vercel's built-in cron header — can't be spoofed from the outside
    // because Vercel strips inbound x-vercel-* headers.
    if (request.headers.get('x-vercel-cron') === '1') return true;
    // Fallback: explicit bearer secret, for curl / local dev / alternative
    // schedulers. Skip the comparison if CRON_SECRET is empty (local dev
    // with no secret configured → allow).
    if (!CRON_SECRET) return true;
    const auth = request.headers.get('authorization') || '';
    return auth === `Bearer ${CRON_SECRET}`;
}

/**
 * Fetch the upcoming-launches list from our own /api/launches/upcoming.
 * Uses `window_days=90` to match the launch planner's default view.
 * Falls back to an empty list on failure so the cron doesn't crash the
 * whole warming run over one bad upstream.
 */
async function fetchUpcomingLaunches(base) {
    const url = `${base}/api/launches/upcoming?limit=100&window_days=${LAUNCH_WINDOW_DAYS}`;
    try {
        const res = await fetchWithTimeout(url, { timeoutMs: 10000 });
        if (!res.ok) return [];
        const data = await res.json();
        return Array.isArray(data.launches) ? data.launches : [];
    } catch (e) {
        console.warn('[cron/warm] launches fetch failed:', e.message);
        return [];
    }
}

/**
 * Dedupe launches by quantized pad lat/lon (matches the proxy's 3dp
 * quantization). Multiple launches from the same pad → one warmup.
 * Returns an array of { lat, lon, label } sorted by soonest NET so the
 * most time-sensitive pads get warmed first (important if the batch
 * processing runs out of budget mid-run).
 */
function dedupePads(launches) {
    const byKey = new Map();   // key = "lat,lon" quantized
    for (const l of launches) {
        const lat = Number(l?.pad?.lat);
        const lon = Number(l?.pad?.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        const qLat = Number(lat.toFixed(3));
        const qLon = Number(lon.toFixed(3));
        const key  = `${qLat},${qLon}`;
        if (byKey.has(key)) continue;
        byKey.set(key, {
            lat:    qLat,
            lon:    qLon,
            label:  l.pad?.name || l.pad?.location || key,
            net_ms: Date.parse(l.net_iso) || Infinity,
        });
    }
    return [...byKey.values()]
        .sort((a, b) => a.net_ms - b.net_ms)
        .slice(0, WARM_LIMIT);
}

/**
 * Fire a GET against our own /api/weather/forecast so the edge caches the
 * response for the next real visitor. Returns a structured result for the
 * cron summary; never throws.
 */
async function warmForecast(base, pad) {
    const url = `${base}/api/weather/forecast?type=launch&lat=${pad.lat}&lon=${pad.lon}&days=7`;
    const t0  = Date.now();
    try {
        const res = await fetchWithTimeout(url, {
            timeoutMs: WARM_ITEM_TIMEOUT_MS,
            // Hint to any intermediate caches that this is a normal
            // request — don't use cache: 'no-store' here, we WANT the
            // response to be cacheable.
        });
        return {
            label:      pad.label,
            status:     res.ok ? 'ok' : 'failed',
            http:       res.status,
            cache:      res.headers.get('x-vercel-cache') || 'unknown',
            ms:         Date.now() - t0,
        };
    } catch (e) {
        return {
            label:  pad.label,
            status: 'error',
            detail: e.message,
            ms:     Date.now() - t0,
        };
    }
}

/** Warm the global NWS convective-alerts endpoint — one fetch, shared cache. */
async function warmNws(base) {
    const t0 = Date.now();
    try {
        const res = await fetchWithTimeout(`${base}/api/nws/convective`, {
            timeoutMs: WARM_ITEM_TIMEOUT_MS,
        });
        return {
            label:  'nws/convective',
            status: res.ok ? 'ok' : 'failed',
            http:   res.status,
            cache:  res.headers.get('x-vercel-cache') || 'unknown',
            ms:     Date.now() - t0,
        };
    } catch (e) {
        return { label: 'nws/convective', status: 'error', detail: e.message, ms: Date.now() - t0 };
    }
}

/**
 * Process warm targets in batches so we don't fan out 30 parallel requests
 * to Open-Meteo in one burst (which their rate limiter would interpret as
 * a scraper). 5 at a time × ~1 s each = ~6 s wall time for 30 pads.
 */
async function warmInBatches(base, pads) {
    const results = [];
    for (let i = 0; i < pads.length; i += WARM_BATCH_SIZE) {
        const batch = pads.slice(i, i + WARM_BATCH_SIZE);
        const batchResults = await Promise.all(batch.map(p => warmForecast(base, p)));
        results.push(...batchResults);
    }
    return results;
}

export default async function handler(request) {
    if (!isAuthorizedCron(request)) {
        return jsonError('unauthorized',
            'cron invocations require x-vercel-cron or bearer CRON_SECRET',
            { status: 401, maxAge: 0 });
    }

    const base = siteUrl();
    const startedAt = Date.now();

    // Pull the upcoming-launches list (itself edge-cached, so this is cheap).
    const launches = await fetchUpcomingLaunches(base);
    const pads     = dedupePads(launches);

    // Warm forecasts (batched) + the single global NWS cache entry in
    // parallel — different upstreams, no contention.
    const [forecastResults, nwsResult] = await Promise.all([
        warmInBatches(base, pads),
        warmNws(base),
    ]);

    const summary = {
        site:          base,
        started_at:    new Date(startedAt).toISOString(),
        duration_ms:   Date.now() - startedAt,
        launches_seen: launches.length,
        pads_warmed:   forecastResults.length,
        forecast: {
            ok:     forecastResults.filter(r => r.status === 'ok').length,
            failed: forecastResults.filter(r => r.status !== 'ok').length,
            // Per-pad detail is useful for debugging but also modest in
            // size (~30 items). Include it so an operator hitting this
            // endpoint manually gets a full picture without digging into
            // Vercel logs.
            items:  forecastResults,
        },
        nws: nwsResult,
    };

    // Never cache cron results — each invocation is its own diagnostic
    // snapshot. s-maxage=0 + private explicitly marks this non-cacheable.
    return jsonOk(summary, { maxAge: 0, swr: 0 });
}
