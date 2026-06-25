/**
 * Vercel Edge Cron: /api/cron/synthetic-auth-weekly
 *
 * Tier-2 synthetic robot — the weekly DEEP journeys the daily robot skips.
 * Each journey creates its own throwaway account, drives it through a richer
 * flow, asserts, then deletes the account (+ activation_events).
 *
 *   weekly_full            — signup → free profile → login →
 *                            WELCOME EMAIL (real Resend send to a no-bounce
 *                            sink) → welcome_email_sent activation event logged
 *   weekly_direct_basic    — signup → provision plan=basic (simulating the
 *                            Stripe webhook) → login → entitlement resolves to
 *                            basic via RLS self-read AND effective_plan_for
 *   weekly_direct_advanced — same, plan=advanced
 *
 * The welcome step repoints the recipient at Resend's `delivered@resend.dev`
 * sink so a real send is exercised without bouncing a fake mailbox (which would
 * harm sender reputation). The user's *auth* email stays synthetic so sweep +
 * cleanup still find it.
 *
 * Each journey → its own synthetic_journey_log row (the admin card already
 * renders weekly_*). Aggregate verdict → pipeline_heartbeat
 * ('synthetic_auth_weekly'); any failure → one Resend email to ops.
 */

import { fetchWithTimeout } from '../_lib/responses.js';
import {
    SUPABASE_URL, EMAIL_DOMAIN, EMAIL_PREFIX, svcHeaders,
    requireCron, missingCoreConfig, adminCreateUser, adminDeleteUser,
    deleteActivationEvents, profileServiceRead, profileServicePatch,
    passwordLogin, profileRlsRead, callRpc, sweepOrphans, makeStepRunner,
    recordLog, recordHeartbeat, sendOpsEmail,
} from '../_lib/synthetic-auth.js';

export const config = { runtime: 'edge' };

const PIPELINE = 'synthetic_auth_weekly';
const SITE_URL = process.env.SITE_URL || 'https://parkersphysics.com';
// Resend's documented test sink: accepts + reports delivered, never bounces.
const WELCOME_SINK = 'delivered@resend.dev';

// ── Journey-specific assertion blocks ────────────────────────────────────────
async function welcomeExtra({ step, uid, getToken }) {
    let attempted = false;
    await step('welcome_email', async () => {
        const token = getToken();
        if (!token) throw new Error('skipped (no session)');
        // Point the welcome recipient at the no-bounce sink before sending.
        await profileServicePatch(uid, { email: WELCOME_SINK });
        const res = await fetchWithTimeout(`${SITE_URL}/api/welcome/send`, {
            method: 'POST', timeoutMs: 12_000,
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: '{}',
        });
        const body = await res.json().catch(() => ({}));
        // 501 = Resend/service key not configured in this env → soft skip, not
        // a red alarm (the daily robot's alert path would also be dark).
        if (res.status === 501) return `skipped — welcome endpoint not_configured (${body.detail || ''})`.trim();
        if (!res.ok || body.ok !== true) throw new Error(`welcome send ${res.status}: ${body.error || body.detail || 'no ok'}`);
        attempted = true;
        return body.sent === false ? 'endpoint ok (already_sent)' : `sent to sink (${body.recipient || WELCOME_SINK})`;
    });
    if (attempted) {
        await step('welcome_logged', async () => {
            const res = await fetchWithTimeout(
                `${SUPABASE_URL}/rest/v1/activation_events?user_id=eq.${uid}&event=eq.welcome_email_sent&select=id&limit=1`,
                { timeoutMs: 8000, headers: svcHeaders() },
            );
            const rows = await res.json().catch(() => []);
            if (!Array.isArray(rows) || rows.length < 1) throw new Error('welcome_email_sent activation event not logged');
            return 'activation event present';
        });
    }
}

async function tierExtra({ step, uid, getToken, provisionPlan }) {
    await step('entitlement_rls', async () => {
        const token = getToken();
        if (!token) throw new Error('skipped (no session)');
        const { status, rows } = await profileRlsRead(uid, token, 'id,plan');
        if (status !== 200 || rows?.[0]?.plan !== provisionPlan) {
            throw new Error(`expected own plan=${provisionPlan}, got status ${status} / plan ${rows?.[0]?.plan}`);
        }
        return `own plan=${provisionPlan}`;
    });
    await step('entitlement_rpc', async () => {
        const { status, data } = await callRpc('effective_plan_for', { p_user_id: uid });
        if (status !== 200) return `skipped — effective_plan_for ${status}`;
        if (data !== provisionPlan) throw new Error(`effective_plan_for returned ${JSON.stringify(data)}, expected ${provisionPlan}`);
        return `effective_plan=${provisionPlan}`;
    });
}

// ── Generic journey runner: create → free profile → [provision] → login →
//    [journey-specific extra] → cleanup → log. Returns the verdict. ───────────
async function runJourney({ journey, label, provisionPlan = null, extra = null, source }) {
    const t0 = Date.now();
    const runId = crypto.randomUUID();
    const { steps, step } = makeStepRunner();
    const email = `${EMAIL_PREFIX}weekly-${label}-${Date.now()}-${runId.slice(0, 8)}@${EMAIL_DOMAIN}`;
    const password = `Synth-${crypto.randomUUID()}`;
    let uid = null, token = null;

    try {
        if (!await step('create', async () => { uid = await adminCreateUser(email, password, { full_name: `Synthetic ${label}` }); return `uid=${uid}`; })) {
            throw new Error('create failed — aborting journey');
        }

        await step('profile_free', async () => {
            for (let i = 0; i < 10; i++) {
                const { rows } = await profileServiceRead(uid);
                if (Array.isArray(rows) && rows.length === 1) {
                    if (rows[0].plan !== 'free') throw new Error(`expected plan=free, got ${rows[0].plan}`);
                    return 'plan=free';
                }
                await new Promise(r => setTimeout(r, 300));
            }
            throw new Error('no user_profiles row after signup (stranded user / trigger failed)');
        });

        if (provisionPlan) {
            await step('provision', async () => {
                // Simulate the Stripe webhook provisioning a paid plan.
                await profileServicePatch(uid, { plan: provisionPlan, subscription_status: 'active' });
                const { rows } = await profileServiceRead(uid, 'id,plan,subscription_status');
                if (rows?.[0]?.plan !== provisionPlan) throw new Error(`provision did not stick (plan=${rows?.[0]?.plan})`);
                return `plan→${provisionPlan}`;
            });
        }

        await step('login', async () => {
            const { status, body } = await passwordLogin(email, password);
            if (status !== 200 || !body.access_token) throw new Error(`token ${status}: ${body.error_description || body.error || 'no token'}`);
            token = body.access_token;
            return 'session minted';
        });

        if (extra) await extra({ step, uid, getToken: () => token, provisionPlan });
    } catch (e) {
        // step() recorded the failure.
    } finally {
        if (uid) {
            await step('cleanup', async () => {
                await deleteActivationEvents(uid);
                await adminDeleteUser(uid);
                return 'events + user deleted';
            });
        }
    }

    const ok = steps.length > 0 && steps.every(s => s.ok);
    const latency_ms = Date.now() - t0;
    const failReason = ok ? null : steps.filter(s => !s.ok).map(s => `${s.name}: ${s.detail}`).join(' | ').slice(0, 480);
    try {
        await recordLog({ journey, source, ok, steps, latency_ms, detail: { run_id: runId, ...(failReason ? { first_failures: failReason } : {}) } });
    } catch { /* log insert is best-effort */ }
    return { journey, ok, steps, latency_ms, failReason };
}

export default async function handler(request) {
    if (!requireCron(request)) return Response.json({ error: 'unauthorized' }, { status: 401 });
    const missing = missingCoreConfig();
    if (missing.length) return Response.json({ error: 'not_configured', missing }, { status: 500 });

    const source = new URL(request.url).searchParams.get('source') === 'manual' ? 'manual' : 'cron';
    const swept = await sweepOrphans();

    // Run journeys sequentially — keeps Admin-API + Resend load gentle and
    // makes the log ordering deterministic.
    const results = [];
    results.push(await runJourney({ journey: 'weekly_full', label: 'full', extra: welcomeExtra, source }));
    results.push(await runJourney({ journey: 'weekly_direct_basic', label: 'basic', provisionPlan: 'basic', extra: tierExtra, source }));
    results.push(await runJourney({ journey: 'weekly_direct_advanced', label: 'advanced', provisionPlan: 'advanced', extra: tierExtra, source }));

    const ok = results.every(r => r.ok);
    const failing = results.filter(r => !r.ok);

    let alerted = false, emailError = null;
    if (!ok) {
        const subject = `[ALERT] Weekly synthetic auth FAILED — ${failing.map(r => r.journey).join(', ')}`;
        const text = [
            'The weekly deep synthetic auth robot failed. A paid-tier or welcome-email path may be broken.',
            '', 'Failing journeys:',
            ...failing.map(r => `  • ${r.journey}: ${r.failReason}`),
            '', 'Admin dashboard:  https://parkersphysics.com/admin#onboarding',
            '', '— synthetic-auth-weekly cron',
        ].join('\n');
        const r = await sendOpsEmail(subject, text);
        alerted = r.sent; emailError = r.error || null;
    }

    await recordHeartbeat(
        PIPELINE, ok,
        failing.map(r => `${r.journey}: ${r.failReason}`).join(' || ').slice(0, 480) || 'weekly synthetic failed',
        'synthetic-auth-weekly',
    );

    return Response.json({
        ok, source, swept_orphans: swept, alerted,
        journeys: results.map(r => ({ journey: r.journey, ok: r.ok, latency_ms: r.latency_ms, failReason: r.failReason, steps: r.steps })),
        ...(emailError ? { email_error: emailError } : {}),
        as_of: new Date().toISOString(),
    }, { status: ok ? 200 : 207, headers: { 'Cache-Control': 'no-store' } });
}
