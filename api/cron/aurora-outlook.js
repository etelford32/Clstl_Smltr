/**
 * Vercel Edge Cron: /api/cron/aurora-outlook   (every 6 hours)
 *
 * Sole writer for `aurora_outlook_cache` — the historically-driven 30-day Kp
 * outlook (AURORACLE_ML_PLAN.md §6, Phase 1). Computes once per cycle and
 * caches a single JSONB document so every visitor reads one shared row through
 * /api/aurora/outlook instead of each browser re-deriving it from NOAA.
 *
 * The outlook is global (Kp is not per-user), so this belongs on a cron, not in
 * the request path — and it's where the Phase 3 daily Kp-LSTM inference will
 * later slot in, scored on the existing forecast_log leaderboard.
 *
 * Auth: Vercel Cron sends `x-vercel-cron: 1`; with CRON_SECRET set it also
 * sends `Authorization: Bearer <secret>`. Either is accepted; manual runs need
 * the Bearer secret.  Dry run: GET /api/cron/aurora-outlook?dry=1 (compute, no
 * write).
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_KEY (service_role), CRON_SECRET (optional).
 *
 * Graceful pre-provision: until supabase-aurora-outlook-cache-migration.sql is
 * run, the insert 404s — we report `skipped: table_missing` as a 200 (not a
 * pipeline failure) so the watchdog doesn't alert, and /api/aurora/outlook
 * keeps serving via its live-compute fallback in the meantime.
 */
import { fetchWithTimeout } from '../_lib/responses.js';
import { computeOutlook } from '../_lib/aurora-outlook.js';

export const config = { runtime: 'edge' };

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY || '';
const CRON_SECRET  = process.env.CRON_SECRET || '';
const PIPELINE     = 'aurora_outlook';
const SOURCE_TAG   = 'noaa-45d+recurrence';

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

async function rpc(name, args) {
    const res = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
        method: 'POST',
        timeoutMs: 8000,
        headers: {
            apikey: SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(args || {}),
    });
    if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new Error(`rpc ${name} HTTP ${res.status}: ${t.slice(0, 240)}`);
    }
    return res.json().catch(() => null);
}

async function recordFailure(reason) {
    try { await rpc('record_pipeline_failure', { p_name: PIPELINE, p_reason: String(reason).slice(0, 500) }); }
    catch { /* heartbeat is best-effort */ }
}

async function insertOutlook(outlook) {
    const res = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/aurora_outlook_cache`, {
        method: 'POST',
        timeoutMs: 8000,
        headers: {
            apikey: SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json',
            Prefer: 'return=minimal',
        },
        body: JSON.stringify({ source: SOURCE_TAG, payload: outlook }),
    });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        const err = new Error(`insert HTTP ${res.status}: ${body.slice(0, 200)}`);
        err.status = res.status; err.body = body;
        throw err;
    }
}

const isTableMissing = e =>
    e?.status === 404 || /PGRST205|does not exist|could not find the table/i.test(`${e?.body || ''} ${e?.message || ''}`);

export default async function handler(req) {
    if (!isAuthorized(req)) return jsonResp({ error: 'unauthorized' }, 401);
    const dry = new URL(req.url).searchParams.get('dry') === '1';

    // 1) Compute (the only step that can hard-fail meaningfully).
    let outlook;
    try {
        outlook = await computeOutlook(Date.now());
    } catch (e) {
        if (!dry) await recordFailure(`compute failed: ${e.message}`);
        return jsonResp({ error: 'compute_failed', detail: e.message }, 502);
    }

    if (dry) {
        return jsonResp({ ok: true, dryRun: true, made_at: outlook.made_at,
            days: outlook.days.length, meta: outlook.meta, sample: outlook.days.slice(0, 3) });
    }
    if (!SUPABASE_URL || !SUPABASE_KEY) return jsonResp({ error: 'supabase_not_configured' }, 500);

    // 2) Write the single cache document.
    try {
        await insertOutlook(outlook);
    } catch (e) {
        if (isTableMissing(e)) {
            return jsonResp({ ok: false, skipped: 'table_missing',
                hint: 'run supabase-aurora-outlook-cache-migration.sql' }, 200);
        }
        await recordFailure(`insert failed: ${e.message}`);
        return jsonResp({ error: 'insert_failed', detail: e.message }, 502);
    }

    // 3) Bounded ring + heartbeat (best-effort).
    try { await rpc('trim_aurora_outlook_cache', {}); } catch { /* next run catches up */ }
    try { await rpc('record_pipeline_success', { p_name: PIPELINE, p_source: SOURCE_TAG }); } catch { /* swallow */ }

    return jsonResp({ ok: true, made_at: outlook.made_at, days: outlook.days.length,
        recurrence_days: outlook.meta.recurrence_days });
}
