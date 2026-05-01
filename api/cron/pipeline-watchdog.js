/**
 * Vercel Edge Cron: /api/cron/pipeline-watchdog
 *
 * Watches pipeline_heartbeat for any pipeline whose consecutive_fail
 * has reached the alert threshold and sends a Resend email to the
 * configured ops address. Without this, a quietly failing cron
 * (the 4-day weather_grid stall is the canonical case) is invisible
 * until a user notices the UI has stopped updating.
 *
 * ── Triggering ────────────────────────────────────────────────────
 * Fires when ALL of the following hold for a pipeline_heartbeat row:
 *   - consecutive_fail >= ALERT_STREAK_THRESHOLD (default 3)
 *   - last_alert_at IS NULL  OR  last_alert_at < now() - ALERT_COOLDOWN
 *
 * The cooldown stops a long-running outage from emailing every 30 min.
 * On a successful Resend send we call record_pipeline_alert_sent(),
 * which stamps last_alert_at so the next 30-min tick correctly skips.
 *
 * ── Auth ──────────────────────────────────────────────────────────
 *   - Vercel cron `x-vercel-cron: 1` header, OR
 *   - Bearer CRON_SECRET (preferred when set)
 *
 * ── Env vars ──────────────────────────────────────────────────────
 *   SUPABASE_URL           (or NEXT_PUBLIC_SUPABASE_URL)
 *   SUPABASE_SERVICE_KEY   (or SUPABASE_SECRET_KEY)
 *   RESEND_API_KEY         (optional — when missing, the watchdog
 *                            still runs and reports who would have
 *                            been alerted, but doesn't send mail.
 *                            Useful for verifying the threshold logic
 *                            in staging without fanning out emails.)
 *   ALERT_FROM_EMAIL       (optional, default 'Parker Physics Alerts
 *                            <alerts@parkersphysics.com>')
 *   ALERT_OPS_EMAIL        (required for sends — operator inbox)
 *   CRON_SECRET            (optional but recommended)
 *
 * ── Response ──────────────────────────────────────────────────────
 *   200 { ok: true, candidates, alerted, skipped, errors, dur_ms }
 *
 *   `candidates` = rows over the streak threshold
 *   `alerted`    = where a Resend send was attempted and accepted
 *   `skipped`    = where the cooldown short-circuited the send
 *   `errors`     = where a Resend send failed (with detail)
 */

import { fetchWithTimeout } from '../_lib/responses.js';

export const config = { runtime: 'edge' };

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY || '';
const CRON_SECRET  = process.env.CRON_SECRET || '';
const RESEND_KEY   = process.env.RESEND_API_KEY || '';
const FROM_EMAIL   = process.env.ALERT_FROM_EMAIL || 'Parker Physics Alerts <alerts@parkersphysics.com>';
const OPS_EMAIL    = process.env.ALERT_OPS_EMAIL  || '';

const RESEND_API   = 'https://api.resend.com/emails';

// 3 consecutive failures = ~3 hourly cron ticks for weather_grid, ~3 minutes
// for solar_wind. Both are clear "this isn't transient" signals; lower than
// that and we'd alert on every passing 502 from a flaky upstream.
const ALERT_STREAK_THRESHOLD = 3;

// Suppress further emails for this long after a send. Long enough that an
// hours-long outage doesn't spam, short enough that a recovery → re-fail
// transition gets a fresh notification rather than going silent.
const ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000;   // 6 hours

async function fetchHeartbeats() {
    const url = `${SUPABASE_URL}/rest/v1/pipeline_heartbeat`
              + `?select=pipeline_name,last_success_at,last_failure_at,`
              +   `last_failure_reason,last_source,consecutive_fail,last_alert_at`
              + `&consecutive_fail=gte.${ALERT_STREAK_THRESHOLD}`;
    const res = await fetchWithTimeout(url, {
        timeoutMs: 8000,
        headers: {
            apikey:        SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
        },
    });
    if (!res.ok) throw new Error(`heartbeat read ${res.status}`);
    return await res.json();
}

async function recordAlertSent(pipelineName) {
    try {
        await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/rpc/record_pipeline_alert_sent`, {
            method:    'POST',
            timeoutMs: 5000,
            headers: {
                apikey:         SUPABASE_KEY,
                Authorization:  `Bearer ${SUPABASE_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ p_name: pipelineName }),
        });
    } catch {
        // Non-fatal — if this fails the next watchdog tick may emit a
        // duplicate alert, but better that than silently swallowing the
        // primary failure signal.
    }
}

function buildAlertEmail(row) {
    const sinceFailure = row.last_failure_at
        ? Math.round((Date.now() - new Date(row.last_failure_at).getTime()) / 60_000)
        : null;
    const sinceSuccess = row.last_success_at
        ? Math.round((Date.now() - new Date(row.last_success_at).getTime()) / 60_000)
        : null;

    const reason = row.last_failure_reason || 'no reason recorded';
    const source = row.last_source || '—';

    const subject = `[ALERT] Pipeline ${row.pipeline_name} failing — streak ${row.consecutive_fail}`;
    const text = [
        `Pipeline ${row.pipeline_name} has failed ${row.consecutive_fail} times in a row.`,
        `Last success: ${row.last_success_at ?? 'never'} (${sinceSuccess ?? '—'} min ago)`,
        `Last failure: ${row.last_failure_at ?? 'never'} (${sinceFailure ?? '—'} min ago)`,
        `Last upstream that worked: ${source}`,
        '',
        'Failure reason:',
        reason,
        '',
        'Check the admin dashboard:',
        '  https://parkersphysics.com/admin#pipeline-heartbeat',
        '',
        '— pipeline-watchdog cron',
    ].join('\n');

    const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:24px;background:#0a0a14;color:#e8f4ff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
  <div style="max-width:560px;margin:0 auto">
    <div style="background:#12111a;border:1px solid #ff5555;border-radius:12px;padding:20px">
      <div style="color:#ff5555;font-size:.75rem;text-transform:uppercase;letter-spacing:.08em;font-weight:700;margin-bottom:8px">Pipeline Failure</div>
      <h2 style="margin:0 0 12px;font-size:1.1rem">${escHtml(row.pipeline_name)} · streak ${row.consecutive_fail}</h2>
      <table style="width:100%;font-size:.85rem;color:#aab" cellpadding="4" cellspacing="0">
        <tr><td style="color:#667">Last success</td><td>${escHtml(row.last_success_at ?? 'never')} <span style="color:#667">(${sinceSuccess ?? '—'} min ago)</span></td></tr>
        <tr><td style="color:#667">Last failure</td><td>${escHtml(row.last_failure_at ?? 'never')} <span style="color:#667">(${sinceFailure ?? '—'} min ago)</span></td></tr>
        <tr><td style="color:#667">Last source</td><td><code>${escHtml(source)}</code></td></tr>
      </table>
      <pre style="background:#0a0a14;border:1px solid #222;border-radius:6px;padding:12px;margin-top:16px;font-size:.75rem;color:#ffaa66;white-space:pre-wrap;word-break:break-word">${escHtml(reason)}</pre>
    </div>
    <p style="margin:16px 0 0;font-size:.7rem;color:#556;text-align:center">
      <a href="https://parkersphysics.com/admin" style="color:#88a">Open admin dashboard</a>
      &middot; pipeline-watchdog cron
    </p>
  </div>
</body></html>`;

    return { subject, text, html };
}

function escHtml(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function sendOneAlert(row) {
    const { subject, text, html } = buildAlertEmail(row);
    const res = await fetchWithTimeout(RESEND_API, {
        method:    'POST',
        timeoutMs: 10_000,
        headers: {
            Authorization:  `Bearer ${RESEND_KEY}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            from:    FROM_EMAIL,
            to:      OPS_EMAIL,
            subject,
            text,
            html,
        }),
    });
    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Resend ${res.status}: ${detail.slice(0, 300)}`);
    }
    return await res.json().catch(() => ({}));
}

function isAuthorized(request) {
    const hdr = request.headers.get('authorization') ?? '';
    if (CRON_SECRET && hdr === `Bearer ${CRON_SECRET}`) return true;
    if (request.headers.get('x-vercel-cron')) return true;
    return false;
}

export default async function handler(request) {
    if (!isAuthorized(request)) {
        return Response.json({ error: 'unauthorized' }, { status: 401 });
    }
    if (!SUPABASE_URL || !SUPABASE_KEY) {
        return Response.json({
            error: 'supabase_not_configured',
            missing: [
                !SUPABASE_URL ? 'SUPABASE_URL' : null,
                !SUPABASE_KEY ? 'SUPABASE_SERVICE_KEY' : null,
            ].filter(Boolean),
        }, { status: 500 });
    }

    const t0 = Date.now();
    let rows;
    try {
        rows = await fetchHeartbeats();
    } catch (e) {
        return Response.json({
            error: 'heartbeat_read_failed',
            detail: e.message,
        }, { status: 502 });
    }

    const candidates = rows.length;
    const alerted    = [];
    const skipped    = [];
    const errors     = [];

    for (const row of rows) {
        // Cooldown: skip if we already alerted recently for this pipeline.
        if (row.last_alert_at) {
            const sinceAlertMs = Date.now() - new Date(row.last_alert_at).getTime();
            if (sinceAlertMs < ALERT_COOLDOWN_MS) {
                skipped.push({
                    pipeline: row.pipeline_name,
                    reason:   'cooldown',
                    since_alert_min: Math.round(sinceAlertMs / 60_000),
                });
                continue;
            }
        }

        // Without RESEND_API_KEY / OPS_EMAIL, we record what would have been
        // sent but don't actually fire. Lets staging/dev environments
        // confirm the threshold logic without spraying email.
        if (!RESEND_KEY || !OPS_EMAIL) {
            skipped.push({
                pipeline: row.pipeline_name,
                reason:   !RESEND_KEY ? 'no_resend_key' : 'no_ops_email',
                streak:   row.consecutive_fail,
            });
            continue;
        }

        try {
            const result = await sendOneAlert(row);
            await recordAlertSent(row.pipeline_name);
            alerted.push({
                pipeline:   row.pipeline_name,
                streak:     row.consecutive_fail,
                resend_id:  result?.id ?? null,
            });
        } catch (e) {
            errors.push({
                pipeline: row.pipeline_name,
                detail:   e.message,
            });
        }
    }

    return Response.json({
        ok:         true,
        candidates,
        alerted:    alerted.length,
        skipped:    skipped.length,
        errors:     errors.length,
        details:    { alerted, skipped, errors },
        dur_ms:     Date.now() - t0,
        as_of:      new Date().toISOString(),
    }, {
        status: errors.length > 0 ? 207 : 200,
        headers: { 'Cache-Control': 'no-store' },
    });
}
