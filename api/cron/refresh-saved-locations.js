/**
 * Vercel Edge Cron: /api/cron/refresh-saved-locations
 *
 * Pre-warms the hourly forecast cache for every saved location flagged
 * `daily_digest_enabled`. Fired every 30 minutes (vercel.json), aligned
 * with the hourly-tier cache TTL on /api/weather/forecast — when this
 * cron writes the entry the CDN holds it for the next 30 min, so the
 * dashboard's hourly strip reads warm cache continuously instead of
 * paying first-load latency on every cold coord.
 *
 * Scope is the tightest set on purpose: only digest-enabled rows, the
 * users who've opted into the daily forecast email. Hourly-strip cold
 * misses for everyone else fall back to the existing on-demand path
 * (one user-visible 1-2s latency on first load, then warm).
 *
 * ── Sizing & cost ──────────────────────────────────────────────────────
 *   ~600 distinct active coords (after 2dp dedupe ≈ 1.1km grid)
 *   × 48 runs/day = 28.8k upstream calls/day
 *   Within Vercel Pro's 1M-included monthly invocations and well under
 *   Open-Meteo's 10k/day-per-egress-IP free tier (Vercel's IP pool
 *   distributes calls across regions). Resend: untouched.
 *
 * ── Auth ───────────────────────────────────────────────────────────────
 *   `x-vercel-cron: 1` header (Vercel-stripped from external requests
 *   when this path is registered in vercel.json crons), or
 *   `Authorization: Bearer ${CRON_SECRET}` when CRON_SECRET is set.
 *
 * ── Env ────────────────────────────────────────────────────────────────
 *   SUPABASE_URL          (or NEXT_PUBLIC_SUPABASE_URL)
 *   SUPABASE_SERVICE_KEY  (or SUPABASE_SECRET_KEY) — service_role
 *   CRON_SECRET           (optional but recommended)
 *   REFRESH_ORIGIN        (optional override, defaults to req-derived
 *                          origin so the warmed cache key matches the
 *                          host users hit)
 */

import { fetchWithTimeout } from '../_lib/responses.js';

export const config = { runtime: 'edge' };

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY || '';
const CRON_SECRET  = process.env.CRON_SECRET || '';
const ORIGIN_OVERRIDE = process.env.REFRESH_ORIGIN || '';

// Concurrency: 6 workers fits Vercel Pro's 60s edge-cron ceiling. At
// ~2s/coord upstream p99, 6 workers process ~180 coords/min. The
// digest-enabled set is opt-in and tiny in practice (likely < 100
// unique coords for the foreseeable future); the time-budget guard
// below covers the pathological case.
const CONCURRENCY = 6;

// Per-coord upstream timeout. The forecast endpoint itself has an 8s
// upstream budget; we add a 2s margin for our internal hop.
const WARM_TIMEOUT_MS = 10_000;

// Hard wall-clock budget. Vercel Pro's edge-cron ceiling is 60s; we
// stop accepting new coords at 50s so in-flight work has time to
// complete and the heartbeat write still succeeds. A degraded Open-
// Meteo could otherwise hang every worker on its 10s timeout and
// run us right up to the hard limit.
const TIME_BUDGET_MS = 50_000;

// Quantize Supabase-stored coords to 2dp (~1.1 km). Two saved locations
// in the same neighbourhood collapse to one warm-up request — and the
// quantized coord matches what /api/weather/forecast computes anyway
// (its own 3dp quantization rounds the same precision range identically
// at this granularity, so cache keys still align).
const COORD_DECIMALS = 2;

// Defensive cap on the row count we'll fetch from Supabase, in case a
// future migration adds digest-enabled rows en masse. Beyond this we'd
// outrun the edge worker's runtime budget.
const MAX_ROWS = 5000;

function isAuthorized(req) {
    const hdr = req.headers.get('authorization') || '';
    if (CRON_SECRET && hdr === `Bearer ${CRON_SECRET}`) return true;
    if (req.headers.get('x-vercel-cron')) return true;
    return false;
}

function jsonResp(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
}

// ── Eligible coord set ─────────────────────────────────────────────────

async function fetchEligibleCoords() {
    // Tightest scope: rows where the user has opted into the digest. We
    // do NOT also filter notify_enabled / email_alerts_enabled — the
    // hourly strip is a separate UX surface (visible whether email is on
    // or not), and the user explicitly said "smallest set =
    // daily_digest_enabled". This single boolean column is exactly that.
    const url = `${SUPABASE_URL}/rest/v1/user_locations`
        + `?select=lat,lon`
        + `&daily_digest_enabled=eq.true`
        + `&limit=${MAX_ROWS}`;
    const res = await fetchWithTimeout(url, {
        timeoutMs: 12_000,
        headers: {
            apikey:        SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
            Accept:        'application/json',
        },
    });
    if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new Error(`fetchEligibleCoords HTTP ${res.status}: ${t.slice(0, 200)}`);
    }
    const rows = await res.json();
    if (!Array.isArray(rows)) return [];

    // Quantize + dedupe in one pass.
    const factor = 10 ** COORD_DECIMALS;
    const seen = new Map();
    for (const r of rows) {
        const lat = r?.lat;
        const lon = r?.lon;
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        const qLat = Math.round(lat * factor) / factor;
        const qLon = Math.round(lon * factor) / factor;
        const key  = `${qLat},${qLon}`;
        if (!seen.has(key)) seen.set(key, { lat: qLat, lon: qLon });
    }
    return [...seen.values()];
}

// ── Same-origin warm-up ────────────────────────────────────────────────

async function warmOne(origin, lat, lon) {
    // Same-origin GET writes the cache entry under the exact host the
    // dashboard reads — different hosts (vercel.app preview vs custom
    // domain) have separate edge caches, so this matters.
    const url = `${origin}/api/weather/forecast?type=hourly`
        + `&lat=${encodeURIComponent(lat)}`
        + `&lon=${encodeURIComponent(lon)}`;
    try {
        const res = await fetchWithTimeout(url, {
            timeoutMs: WARM_TIMEOUT_MS,
            headers:   { Accept: 'application/json' },
        });
        return { ok: res.ok, status: res.status };
    } catch (e) {
        return { ok: false, status: 0, err: e.message };
    }
}

/**
 * Bounded-concurrency worker pool with a wall-clock budget. Once the
 * budget is exceeded, no new work starts (in-flight work finishes).
 * Returns the results array and a `skipped` count for ops visibility.
 */
async function processWithBudget(items, limit, budgetMs, worker) {
    const results = new Array(items.length);
    const deadline = Date.now() + budgetMs;
    let next = 0;
    let skipped = 0;
    async function pump() {
        while (true) {
            if (Date.now() >= deadline) {
                // Count remaining as skipped so the heartbeat reflects truth.
                while (next < items.length) { skipped++; next++; }
                return;
            }
            const idx = next++;
            if (idx >= items.length) return;
            results[idx] = await worker(items[idx], idx);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, pump));
    return { results, skipped };
}

// ── Heartbeat (best-effort) ────────────────────────────────────────────

async function reportHeartbeat(success, payload) {
    if (!SUPABASE_KEY) return;
    const fn = success ? 'record_pipeline_success' : 'record_pipeline_failure';
    try {
        await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
            method:    'POST',
            timeoutMs: 5_000,
            headers: {
                apikey:         SUPABASE_KEY,
                Authorization:  `Bearer ${SUPABASE_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
        });
    } catch {
        /* swallow — heartbeat is non-fatal */
    }
}

// ── Handler ────────────────────────────────────────────────────────────

export default async function handler(req) {
    if (!isAuthorized(req)) {
        return jsonResp({ error: 'unauthorized' }, 401);
    }
    if (!SUPABASE_URL || !SUPABASE_KEY) {
        return jsonResp({ error: 'supabase_not_configured' }, 500);
    }

    const origin = ORIGIN_OVERRIDE || new URL(req.url).origin;

    let coords;
    try {
        coords = await fetchEligibleCoords();
    } catch (e) {
        await reportHeartbeat(false, {
            p_name:   'refresh_saved_locations',
            p_reason: e.message,
        });
        return jsonResp({ error: 'fetch_eligible_failed', detail: e.message }, 502);
    }

    if (!coords.length) {
        await reportHeartbeat(true, {
            p_name:   'refresh_saved_locations',
            p_source: 'no-coords',
        });
        return jsonResp({ ok: true, scanned: 0, warmed: 0, failed: 0 });
    }

    const t0 = Date.now();
    const { results, skipped } = await processWithBudget(
        coords, CONCURRENCY, TIME_BUDGET_MS,
        ({ lat, lon }) => warmOne(origin, lat, lon),
    );
    const elapsedMs = Date.now() - t0;

    const warmed = results.filter(r => r?.ok).length;
    const failed = results.length - warmed - skipped;

    await reportHeartbeat(true, {
        p_name:   'refresh_saved_locations',
        p_source: `${warmed}/${coords.length} warmed in ${elapsedMs}ms`
            + (skipped ? ` (${skipped} skipped: time budget)` : ''),
    });

    return jsonResp({
        ok:        true,
        scanned:   coords.length,
        warmed,
        failed,
        skipped,
        elapsedMs,
    });
}
