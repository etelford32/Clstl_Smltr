/**
 * Vercel Edge Function: GET /api/aurora/outlook
 *
 * Public reader for the historically-driven 30-day Kp outlook
 * (AURORACLE_ML_PLAN.md §6, Phase 1). js/auroracle.js consumes this to drive
 * the month chart + the back half of the 7-night week, replacing the synthetic
 * gaussians in buildMonth().
 *
 * Two layers:
 *   1. Supabase `aurora_outlook_cache` — the canonical row, written every 6 h
 *      by api/cron/aurora-outlook.js. One outlook is identical for every user
 *      (Kp is global; only the per-sky scoring is local), so it's computed once
 *      and shared via the CDN.
 *   2. Live-compute fallback — if the cache is empty (pre-first-cron), the table
 *      isn't provisioned yet, or Supabase is unconfigured, we compute the
 *      outlook inline from the same NOAA feeds. The feature therefore works the
 *      moment it deploys, before the migration/cron are wired.
 *
 * Response: { source, cached, generated_at, age_seconds, data: <outlook> }
 *   data = { made_at, version, days: [{ i, date, kp_p10, kp_p50, kp_p90, driver }], meta }
 *
 * Env: SUPABASE_URL / SUPABASE_SERVICE_KEY (service_role; both naming
 * conventions accepted). Neither is required — without them the endpoint
 * live-computes every time (CDN-cached), it just loses the durable cache.
 */
import { jsonOk, jsonError, fetchWithTimeout } from '../_lib/responses.js';
import { computeOutlook } from '../_lib/aurora-outlook.js';

export const config = { runtime: 'edge' };

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY || '';

const CACHE_TTL = 1800;   // 30 min — cron writes every 6 h, but the outlook
const CACHE_SWR = 600;    // shifts slowly; keep POPs warm and revalidating.
const LIVE_TTL  = 900;    // shorter when we had to compute inline (no cron row).
const LIVE_SWR  = 300;

async function readLatest() {
    const url = `${SUPABASE_URL}/rest/v1/aurora_outlook_cache` +
                `?select=generated_at,source,payload&order=generated_at.desc&limit=1`;
    const res = await fetchWithTimeout(url, {
        timeoutMs: 6000,
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    if (!res.ok) throw new Error(`Supabase ${res.status}`);
    const rows = await res.json();
    return Array.isArray(rows) && rows.length ? rows[0] : null;
}

export default async function handler() {
    // 1) Try the durable cache (best-effort — any failure falls through to live).
    if (SUPABASE_URL && SUPABASE_KEY) {
        try {
            const row = await readLatest();
            if (row) {
                const ageSec = Math.max(0, Math.floor((Date.now() - Date.parse(row.generated_at)) / 1000));
                return jsonOk({
                    source: row.source || 'aurora_outlook_cache',
                    cached: true,
                    generated_at: row.generated_at,
                    age_seconds: ageSec,
                    data: row.payload,
                }, { maxAge: CACHE_TTL, swr: CACHE_SWR });
            }
        } catch (_) { /* table missing / Supabase down → live-compute below */ }
    }

    // 2) Live-compute fallback from NOAA feeds.
    try {
        const outlook = await computeOutlook(Date.now());
        return jsonOk({
            source: 'live-compute',
            cached: false,
            generated_at: outlook.made_at,
            age_seconds: 0,
            data: outlook,
        }, { maxAge: LIVE_TTL, swr: LIVE_SWR });
    } catch (e) {
        return jsonError('outlook_unavailable', e.message,
            { source: 'NOAA SWPC 45-day Ap forecast + planetary-K' });
    }
}
