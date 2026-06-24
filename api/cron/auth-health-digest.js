/**
 * Vercel Edge Cron: /api/cron/auth-health-digest
 *
 * Daily auth-health roll-up email so the operator gets one proactive "auth is
 * healthy / here's what moved" message instead of having to open the admin
 * dashboard. Scheduled for 13:00 UTC ≈ 6am Pacific (see vercel.json; the
 * winter/standard-time alignment is intentional — in DST it lands at 6am PDT
 * one hour earlier relative to clock, which is fine for a morning digest).
 *
 * Pulls three service-role-readable sources (no admin gate needed):
 *   1. synthetic_journey_log (7d)        — per-journey verdict + pass-rate
 *      (the backend robots; the headline "can users sign up + sign in?")
 *   2. activation_events (24h)           — signup / sign-in / welcome funnel
 *   3. telemetry_top_auth_failures (24h) — top failure reasons (includes the
 *      Phase-0 oauth_redirect_misland + profile_fetch_failed signals)
 *
 * The subject line flips to ⚠️ when any synthetic journey's latest run failed,
 * so the digest doubles as a daily heartbeat: no email = cron itself is down.
 */

import { fetchWithTimeout } from '../_lib/responses.js';
import {
    SUPABASE_URL, svcHeaders, callRpc,
    requireCron, missingCoreConfig, sendOpsEmail,
} from '../_lib/synthetic-auth.js';

export const config = { runtime: 'edge' };

const FUNNEL_EVENTS = ['signup', 'signin_succeeded', 'signin_failed', 'welcome_email_sent', 'magic_link_sent'];

const sinceISO = (ms) => new Date(Date.now() - ms).toISOString();

function fmtRel(iso) {
    if (!iso) return 'never';
    const m = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m ago`;
    if (m < 1440) return `${Math.round(m / 60)}h ago`;
    return `${Math.round(m / 1440)}d ago`;
}

const JOURNEY_LABEL = {
    daily_free:             'daily_free',
    weekly_full:            'weekly_full',
    weekly_direct_basic:    'weekly_direct_basic',
    weekly_direct_advanced: 'weekly_direct_advanced',
};

async function getJson(path) {
    const res = await fetchWithTimeout(`${SUPABASE_URL}${path}`, { timeoutMs: 9000, headers: svcHeaders() });
    if (!res.ok) throw new Error(`${path.split('?')[0]} ${res.status}`);
    return res.json();
}

// Per-journey: latest verdict + pass-rate over the window.
async function loadSynthetic() {
    const rows = await getJson(
        `/rest/v1/synthetic_journey_log?select=journey,ok,ran_at,latency_ms&ran_at=gte.${sinceISO(7 * 864e5)}&order=ran_at.desc&limit=2000`,
    );
    const byJourney = {};
    for (const r of rows) {
        const j = (byJourney[r.journey] ||= { journey: r.journey, runs: 0, passes: 0, last: null });
        j.runs++; if (r.ok) j.passes++;
        if (!j.last) j.last = r; // rows are desc-ordered → first seen is latest
    }
    return Object.values(byJourney);
}

async function loadFunnel() {
    const rows = await getJson(
        `/rest/v1/activation_events?select=event&created_at=gte.${sinceISO(864e5)}&limit=10000`,
    );
    const counts = Object.fromEntries(FUNNEL_EVENTS.map(e => [e, 0]));
    for (const r of rows) if (r.event in counts) counts[r.event]++;
    return counts;
}

async function loadTopFailures() {
    const { status, data } = await callRpc('telemetry_top_auth_failures', { p_days: 1, p_limit: 8 });
    if (status !== 200 || !Array.isArray(data)) return [];
    return data;
}

function buildDigest({ synthetic, funnel, failures }) {
    const order = Object.keys(JOURNEY_LABEL);
    synthetic.sort((a, b) => (order.indexOf(a.journey) + 1 || 99) - (order.indexOf(b.journey) + 1 || 99));

    const issues = synthetic.filter(j => j.last && !j.last.ok).length;

    const synthLines = synthetic.length
        ? synthetic.map(j => {
            const rate = j.runs ? Math.round((100 * j.passes) / j.runs) : 0;
            const mark = j.last?.ok ? '✓' : '✗';
            return `  ${mark} ${(JOURNEY_LABEL[j.journey] || j.journey).padEnd(24)} ${String(rate + '%').padStart(4)} (${j.passes}/${j.runs})   last: ${fmtRel(j.last?.ran_at)}`;
        }).join('\n')
        : '  (no synthetic runs recorded in the last 7 days)';

    const signin = funnel.signin_succeeded + funnel.signin_failed;
    const successRate = signin ? Math.round((100 * funnel.signin_succeeded) / signin) : null;
    const funnelLines = [
        `  Signups:            ${funnel.signup}`,
        `  Sign-in success:    ${funnel.signin_succeeded}`,
        `  Sign-in failures:   ${funnel.signin_failed}${successRate == null ? '' : `   (${successRate}% success)`}`,
        `  Welcome emails:     ${funnel.welcome_email_sent}`,
        `  Magic links:        ${funnel.magic_link_sent}`,
    ].join('\n');

    const failLines = failures.length
        ? failures.map(f => `  ${String(f.occurrences ?? 0).padStart(4)} × ${f.reason}${f.source ? ` (${f.source})` : ''}   ${fmtRel(f.last_seen)}`).join('\n')
        : '  none 🎉';

    const status = issues > 0 ? `⚠️ ${issues} issue${issues === 1 ? '' : 's'}` : '✅ all green';
    const date = new Date().toISOString().slice(0, 10);

    const text = [
        `Auth Health Digest · ${date} · ${status}`,
        '',
        'SYNTHETIC ROBOTS (last 7d)',
        synthLines,
        '',
        'LAST 24H FUNNEL',
        funnelLines,
        '',
        'TOP AUTH FAILURES (24h)',
        failLines,
        '',
        '—',
        'Admin: https://parkersphysics.com/admin#onboarding',
    ].join('\n');

    return { subject: `Auth health · ${date} · ${status}`, text, issues };
}

export default async function handler(request) {
    if (!requireCron(request)) return Response.json({ error: 'unauthorized' }, { status: 401 });
    const missing = missingCoreConfig();
    if (missing.length) return Response.json({ error: 'not_configured', missing }, { status: 500 });

    let synthetic = [], funnel = Object.fromEntries(FUNNEL_EVENTS.map(e => [e, 0])), failures = [];
    const errors = {};
    try { synthetic = await loadSynthetic(); } catch (e) { errors.synthetic = e.message; }
    try { funnel = await loadFunnel(); } catch (e) { errors.funnel = e.message; }
    try { failures = await loadTopFailures(); } catch (e) { errors.failures = e.message; }

    const { subject, text, issues } = buildDigest({ synthetic, funnel, failures });
    const sent = await sendOpsEmail(subject, text);

    return Response.json({
        ok: true, issues, subject,
        sent: sent.sent, ...(sent.skipped ? { email_skipped: 'RESEND_API_KEY / ALERT_OPS_EMAIL not set' } : {}),
        ...(sent.error ? { email_error: sent.error } : {}),
        ...(Object.keys(errors).length ? { source_errors: errors } : {}),
        as_of: new Date().toISOString(),
    }, { status: 200, headers: { 'Cache-Control': 'no-store' } });
}
