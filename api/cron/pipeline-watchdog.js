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
 *   ALERT_FROM_EMAIL       (optional, default 'Parkers Physics Alerts
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
const FROM_EMAIL   = process.env.ALERT_FROM_EMAIL || 'Parkers Physics Alerts <alerts@parkersphysics.com>';
const OPS_EMAIL    = process.env.ALERT_OPS_EMAIL  || '';
// Slack webhook URL (incoming-webhook integration). When set the
// watchdog mirrors heartbeat alerts to Slack and uses Slack as the
// preferred channel for perf alerts. Without it, perf alerts still
// fire via email if RESEND_KEY + OPS_EMAIL are configured.
const SLACK_URL    = process.env.SLACK_WEBHOOK_URL || '';

// Perf-alert tuning. Defaults match the original ticket: LCP p95
// > 4 s. Override via env without redeploying SQL.
const PERF_METRIC          = process.env.PERF_ALERT_METRIC          || 'LCP';
const PERF_THRESHOLD_MS    = Number(process.env.PERF_ALERT_THRESHOLD_MS    || 4000);
const PERF_WINDOW_HOURS    = Number(process.env.PERF_ALERT_WINDOW_HOURS    || 6);
const PERF_MIN_SAMPLES     = Number(process.env.PERF_ALERT_MIN_SAMPLES     || 30);
const PERF_COOLDOWN_HOURS  = Number(process.env.PERF_ALERT_COOLDOWN_HOURS  || 6);
const PERF_RESOLVE_STREAK  = Number(process.env.PERF_ALERT_RESOLVE_STREAK  || 3);

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

// ── Slack helper ────────────────────────────────────────────────────
// Posts a single message to the configured incoming-webhook URL. The
// payload is the simplest Slack format (text only) plus an optional
// "blocks" rich layout for perf alerts that benefit from a table.
// Network failures bubble up so the caller can choose to fall back
// to email or surface the error in the response.
async function sendSlack({ text, blocks = null }) {
    if (!SLACK_URL) throw new Error('SLACK_WEBHOOK_URL not configured');
    const body = blocks ? { text, blocks } : { text };
    const res = await fetchWithTimeout(SLACK_URL, {
        method:    'POST',
        timeoutMs: 8000,
        headers:   { 'Content-Type': 'application/json' },
        body:      JSON.stringify(body),
    });
    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Slack ${res.status}: ${detail.slice(0, 300)}`);
    }
    // Slack returns "ok" as plain text body, not JSON.
    return await res.text().catch(() => 'ok');
}

// ── Perf alert RPC helpers ──────────────────────────────────────────
async function fetchPerfCandidates() {
    const url = `${SUPABASE_URL}/rest/v1/rpc/telemetry_perf_alert_candidates`;
    const res = await fetchWithTimeout(url, {
        method:    'POST',
        timeoutMs: 8000,
        headers: {
            apikey:         SUPABASE_KEY,
            Authorization:  `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            p_metric:         PERF_METRIC,
            p_threshold_ms:   PERF_THRESHOLD_MS,
            p_window_hours:   PERF_WINDOW_HOURS,
            p_min_samples:    PERF_MIN_SAMPLES,
            p_cooldown_hours: PERF_COOLDOWN_HOURS,
            p_route_limit:    20,
        }),
    });
    if (!res.ok) {
        throw new Error(`perf_candidates RPC ${res.status}: ${await res.text().catch(() => '').slice(0, 200)}`);
    }
    return await res.json();
}

async function fetchPerfResolved() {
    const url = `${SUPABASE_URL}/rest/v1/rpc/telemetry_perf_alert_resolved`;
    const res = await fetchWithTimeout(url, {
        method:    'POST',
        timeoutMs: 8000,
        headers: {
            apikey:         SUPABASE_KEY,
            Authorization:  `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ p_resolve_streak: PERF_RESOLVE_STREAK }),
    });
    if (!res.ok) return [];
    return await res.json();
}

async function recordPerfAlertSent(metric, route, p95) {
    try {
        await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/rpc/record_perf_alert_sent`, {
            method:    'POST',
            timeoutMs: 5000,
            headers: {
                apikey:         SUPABASE_KEY,
                Authorization:  `Bearer ${SUPABASE_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                p_metric_name: metric,
                p_route:       route,
                p_p95:         p95,
            }),
        });
    } catch { /* non-fatal */ }
}

async function recordPerfAlertResolved(metric, route) {
    try {
        await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/rpc/record_perf_alert_resolved`, {
            method:    'POST',
            timeoutMs: 5000,
            headers: {
                apikey:         SUPABASE_KEY,
                Authorization:  `Bearer ${SUPABASE_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ p_metric_name: metric, p_route: route }),
        });
    } catch { /* non-fatal */ }
}

async function tickPerfAlertHealth(offending) {
    try {
        await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/rpc/tick_perf_alert_health`, {
            method:    'POST',
            timeoutMs: 5000,
            headers: {
                apikey:         SUPABASE_KEY,
                Authorization:  `Bearer ${SUPABASE_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ p_offending: offending }),
        });
    } catch { /* non-fatal */ }
}

// Perf alert message-building helpers. Slack gets a rich blocks
// layout; email reuses the existing template style.
function buildPerfSlackBlocks(rows) {
    return [
        {
            type: 'header',
            text: { type: 'plain_text', text: `🐢 ${PERF_METRIC} regression on ${rows.length} route${rows.length === 1 ? '' : 's'}` },
        },
        {
            type: 'section',
            text: {
                type: 'mrkdwn',
                text:
                    `*Window:* last ${PERF_WINDOW_HOURS}h · *Threshold:* ${PERF_THRESHOLD_MS} ms · *Min samples:* ${PERF_MIN_SAMPLES}\n` +
                    rows.map(r => `• \`${r.route}\` — p95 *${Math.round(r.p95)} ms* (${r.samples} samples)`).join('\n'),
            },
        },
        {
            type: 'context',
            elements: [{ type: 'mrkdwn', text: `Cooldown: ${PERF_COOLDOWN_HOURS}h · resolves after ${PERF_RESOLVE_STREAK} healthy ticks` }],
        },
    ];
}

function buildPerfResolvedSlackBlocks(rows) {
    return [
        {
            type: 'header',
            text: { type: 'plain_text', text: `✅ ${PERF_METRIC} recovered on ${rows.length} route${rows.length === 1 ? '' : 's'}` },
        },
        {
            type: 'section',
            text: {
                type: 'mrkdwn',
                text: rows.map(r => `• \`${r.route}\` — back below ${PERF_THRESHOLD_MS} ms (was p95 ${r.last_p95 ? Math.round(r.last_p95) : '?'} ms)`).join('\n'),
            },
        },
    ];
}

async function sendPerfEmailFallback(rows, isResolved = false) {
    if (!RESEND_KEY || !OPS_EMAIL) return null;
    const subject = isResolved
        ? `[Parkers Physics] ${PERF_METRIC} recovered on ${rows.length} route${rows.length === 1 ? '' : 's'}`
        : `[Parkers Physics] ${PERF_METRIC} regression on ${rows.length} route${rows.length === 1 ? '' : 's'}`;
    const lines = isResolved
        ? rows.map(r => `  ${r.route}  (was p95 ${r.last_p95 ? Math.round(r.last_p95) : '?'} ms)`)
        : rows.map(r => `  ${r.route}  p95 ${Math.round(r.p95)} ms  (${r.samples} samples)`);
    const text = `${subject}\n\n${lines.join('\n')}\n\nWindow: last ${PERF_WINDOW_HOURS}h · Threshold: ${PERF_THRESHOLD_MS} ms`;
    const res = await fetchWithTimeout(RESEND_API, {
        method:    'POST',
        timeoutMs: 10_000,
        headers: {
            Authorization:  `Bearer ${RESEND_KEY}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ from: FROM_EMAIL, to: OPS_EMAIL, subject, text }),
    });
    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Resend ${res.status}: ${detail.slice(0, 300)}`);
    }
    return await res.json().catch(() => ({}));
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

    // ── Perf-regression alerts ──────────────────────────────────────
    // Runs alongside the heartbeat loop above. Pulls offending routes
    // from telemetry_perf_alert_candidates, fans out a single
    // consolidated Slack/email message, then ticks the health table so
    // resolved routes close the loop on subsequent runs.
    const perf = { offending: [], resolved: [], alertSent: false, resolveSent: false, errors: [] };
    try {
        const offending = await fetchPerfCandidates();
        perf.offending = Array.isArray(offending) ? offending : [];
        const resolved = await fetchPerfResolved();
        perf.resolved  = Array.isArray(resolved) ? resolved : [];

        // Send the breach alert (if any). Prefer Slack; fall back to
        // email; both is fine if both are configured but for now we
        // pick one channel to avoid duplicate noise.
        if (perf.offending.length) {
            try {
                if (SLACK_URL) {
                    await sendSlack({
                        text: `${PERF_METRIC} regression on ${perf.offending.length} route(s)`,
                        blocks: buildPerfSlackBlocks(perf.offending),
                    });
                    perf.alertSent = true;
                } else if (RESEND_KEY && OPS_EMAIL) {
                    await sendPerfEmailFallback(perf.offending, false);
                    perf.alertSent = true;
                }
            } catch (e) {
                perf.errors.push({ stage: 'breach_send', detail: e.message });
            }
            // Stamp last_alerted_at regardless of channel success — a
            // failed Slack call shouldn't trigger an immediate retry on
            // the next minute's tick. The cooldown will let the next
            // window pass naturally.
            for (const r of perf.offending) {
                await recordPerfAlertSent(r.metric_name, r.route, r.p95);
            }
        }

        // Send the resolved alert (if any). Same channel preference.
        if (perf.resolved.length) {
            try {
                if (SLACK_URL) {
                    await sendSlack({
                        text: `${PERF_METRIC} recovered on ${perf.resolved.length} route(s)`,
                        blocks: buildPerfResolvedSlackBlocks(perf.resolved),
                    });
                    perf.resolveSent = true;
                } else if (RESEND_KEY && OPS_EMAIL) {
                    await sendPerfEmailFallback(perf.resolved, true);
                    perf.resolveSent = true;
                }
            } catch (e) {
                perf.errors.push({ stage: 'resolve_send', detail: e.message });
            }
            for (const r of perf.resolved) {
                await recordPerfAlertResolved(r.metric_name, r.route);
            }
        }

        // Tick health for everything currently being tracked. Always
        // run, even if no breaches/resolutions this tick — that's how
        // healthy_streak builds up across consecutive ticks.
        await tickPerfAlertHealth(
            perf.offending.map(r => ({ metric: r.metric_name, route: r.route }))
        );
    } catch (e) {
        perf.errors.push({ stage: 'fetch', detail: e.message });
    }

    return Response.json({
        ok:         true,
        candidates,
        alerted:    alerted.length,
        skipped:    skipped.length,
        errors:     errors.length,
        details:    { alerted, skipped, errors },
        perf:       {
            metric:      PERF_METRIC,
            threshold_ms: PERF_THRESHOLD_MS,
            window_h:    PERF_WINDOW_HOURS,
            offending:   perf.offending.length,
            resolved:    perf.resolved.length,
            alertSent:   perf.alertSent,
            resolveSent: perf.resolveSent,
            channel:     SLACK_URL ? 'slack' : (RESEND_KEY && OPS_EMAIL ? 'email' : 'none'),
            errors:      perf.errors,
        },
        dur_ms:     Date.now() - t0,
        as_of:      new Date().toISOString(),
    }, {
        status: (errors.length + perf.errors.length) > 0 ? 207 : 200,
        headers: { 'Cache-Control': 'no-store' },
    });
}
