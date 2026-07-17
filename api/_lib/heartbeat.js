/**
 * api/_lib/heartbeat.js — shared pipeline_heartbeat writer
 *
 * Every cron under /api/cron/* should call recordPipelineSuccess on
 * a successful tick and recordPipelineFailure on a failing one. The
 * status page (/status) reads pipeline_heartbeat to surface "is this
 * cron actually firing?" — without these calls every new cron is a
 * silent gap in the dashboard.
 *
 * Design choices:
 *   • SHARED — every cron picks up the same auth + RPC + error
 *     handling. No more per-cron `supabaseCallRpc` copies.
 *   • NO-OP WHEN UNCONFIGURED — if Supabase env vars aren't set,
 *     the calls quietly do nothing. Cron logic still runs and
 *     succeeds; the status page just shows "no heartbeat" until
 *     the env is set. Better than failing the whole cron.
 *   • SWALLOW NETWORK ERRORS — heartbeat is observability, not
 *     control. A heartbeat write failing must not roll back the
 *     real work the cron just did. Errors go to console.warn for
 *     CloudWatch / Vercel logs, but the cron returns success.
 *
 * Naming convention for cron heartbeats:
 *   pipeline_name should match the pattern existing entries use
 *   (snake_case kebab-flat):
 *     'solar_wind'      — refresh-solar-wind cron
 *     'weather_grid'    — refresh-weather-grid cron
 *     'prewarm_hot'     — prewarm-hot cron       (new in PR-D)
 *     'prewarm_medium'  — prewarm-medium cron    (new in PR-D)
 *     'prewarm_cold'    — prewarm-cold cron      (new in PR-D)
 *
 * Required Supabase RPCs (already defined in
 * supabase-pipeline-heartbeat-migration.sql):
 *   record_pipeline_success(p_name TEXT, p_source TEXT)
 *   record_pipeline_failure(p_name TEXT, p_reason TEXT)
 */

import { fetchWithTimeout } from './responses.js';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY || '';

const RPC_TIMEOUT_MS = 5000;

/**
 * Mark a pipeline as having just succeeded. Resets consecutive_fail
 * counter and updates last_success_at, last_source.
 *
 * @param {string} pipelineName  Stable key, e.g. 'prewarm_hot'.
 * @param {string} source        Origin label for diagnostics, e.g.
 *                               'cron-fanout' or 'noaa-rtsw-cron'.
 */
export async function recordPipelineSuccess(pipelineName, source) {
    return _rpc('record_pipeline_success', {
        p_name:   pipelineName,
        p_source: source ?? null,
    });
}

/**
 * Mark a pipeline as having failed this tick. Increments
 * consecutive_fail and updates last_failure_at + last_failure_reason.
 *
 * @param {string} pipelineName
 * @param {string} reason       Human-readable failure description —
 *                              what the status page surfaces in the
 *                              hover tooltip on the failure cell.
 */
export async function recordPipelineFailure(pipelineName, reason) {
    return _rpc('record_pipeline_failure', {
        p_name:   pipelineName,
        p_reason: typeof reason === 'string' ? reason.slice(0, 500) : String(reason ?? ''),
    });
}

// ── Internal ───────────────────────────────────────────────────────────────

async function _rpc(fnName, args) {
    if (!SUPABASE_URL || !SUPABASE_KEY) {
        // No Supabase configured — silently no-op. The status page
        // surfaces this state via the "Supabase not configured" banner.
        return;
    }
    try {
        const res = await fetchWithTimeout(
            `${SUPABASE_URL}/rest/v1/rpc/${fnName}`,
            {
                method:    'POST',
                timeoutMs: RPC_TIMEOUT_MS,
                headers: {
                    apikey:        SUPABASE_KEY,
                    Authorization: `Bearer ${SUPABASE_KEY}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(args),
            },
        );
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            console.warn(`[heartbeat] ${fnName} HTTP ${res.status}: ${text.slice(0, 200)}`);
        }
    } catch (e) {
        // Network / timeout — heartbeat is observability, not control.
        console.warn(`[heartbeat] ${fnName} threw: ${e?.message ?? e}`);
    }
}
