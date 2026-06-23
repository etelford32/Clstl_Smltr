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

// Phase 2 — skill leaderboard. Kp is planetary (not per-location), so we log
// every prediction at a single sentinel cell (0,0). Leads are capped at 6 days
// so each prediction matures and gets its observation back-filled while it's
// still in forecast_log's 7-day hot ring (archived to R2 after that).
const FIELD         = 'kp_planetary';
const LOG_LEAD_DAYS = 6;

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

// ── Phase 2: skill leaderboard (forecast_log via record_forecast_batch) ──────
// Log per-model daily-Kp predictions so the blend can be scored against its
// drivers and a persistence baseline. Models must exist in forecaster_registry
// (supabase-aurora-forecaster-registry-migration.sql) or the RPC rejects them —
// callers treat this as best-effort, so an un-seeded registry just no-ops.
async function logForecasts(outlook) {
    const persist = outlook.persistence_kp;
    const records = [];
    for (const day of outlook.days) {
        if (day.i > LOG_LEAD_DAYS) break;
        const base = { made_at: outlook.made_at, valid_at: `${day.date}T12:00:00Z`, lat: 0, lon: 0, field: FIELD };
        if (Number.isFinite(persist))       records.push({ ...base, model_id: 'AUR_PERSIST', value: persist,       p50: persist });
        if (Number.isFinite(day.kp_noaa45)) records.push({ ...base, model_id: 'AUR_NOAA45',  value: day.kp_noaa45, p50: day.kp_noaa45 });
        if (Number.isFinite(day.kp_recur))  records.push({ ...base, model_id: 'AUR_RECUR',   value: day.kp_recur,  p50: day.kp_recur });
        records.push({ ...base, model_id: 'AUR_BLEND', value: day.kp_p50, p10: day.kp_p10, p50: day.kp_p50, p90: day.kp_p90 });
    }
    let ingested = 0;
    for (let i = 0; i < records.length; i += 100) {
        const res = await rpc('record_forecast_batch', { payload: records.slice(i, i + 100) });
        ingested += (res?.ingested ?? 0);
    }
    return ingested;
}

// Attach observed daily-mean Kp to matured predictions. One narrow per-day
// window so each day's truth only lands on that day's rows (all share cell 0,0).
async function backfillObservations(outlook) {
    const obs = (outlook.observed || []).filter(o => Number.isFinite(o.kp_mean));
    if (!obs.length) return 0;
    const cutoff = Date.now() - (LOG_LEAD_DAYS + 8) * 86_400_000;   // only days that could still hold un-scored rows
    let updated = 0;
    for (const o of obs) {
        const dayMs = Date.parse(`${o.date}T12:00:00Z`);
        if (!Number.isFinite(dayMs) || dayMs < cutoff || dayMs > Date.now()) continue;
        const res = await rpc('backfill_forecast_observations', {
            p_field:        FIELD,
            p_window_start: `${o.date}T00:00:00Z`,
            p_window_end:   `${o.date}T23:59:59Z`,
            p_obs_payload:  [{ lat: 0, lon: 0, observation: o.kp_mean, obs_at: `${o.date}T12:00:00Z` }],
        });
        updated += (typeof res === 'number' ? res : 0);
    }
    return updated;
}

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

    // 3) Phase 2 — log predictions + back-fill matured observations to the skill
    //    leaderboard. Best-effort; never fail the cache write on a logging hiccup.
    let logged = 0, scored = 0;
    try { logged = await logForecasts(outlook); } catch { /* registry not seeded yet, etc. */ }
    try { scored = await backfillObservations(outlook); } catch { /* swallow */ }

    // 4) Bounded ring + heartbeat (best-effort).
    try { await rpc('trim_aurora_outlook_cache', {}); } catch { /* next run catches up */ }
    try { await rpc('record_pipeline_success', { p_name: PIPELINE, p_source: SOURCE_TAG }); } catch { /* swallow */ }

    return jsonResp({ ok: true, made_at: outlook.made_at, days: outlook.days.length,
        recurrence_days: outlook.meta.recurrence_days, logged, scored });
}
