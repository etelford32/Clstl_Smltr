/**
 * Vercel Edge Cron: /api/cron/synthetic-auth-daily
 *
 * Tier-1 synthetic robot — the daily "can a real person sign up for a free
 * account and sign in?" test. It drives a THROWAWAY account through the real
 * Supabase auth surface, asserts the outcome (including negative/error cases),
 * then deletes the account + its activation_events so nothing pollutes real
 * metrics.
 *
 * Journey "daily_free":
 *   1. create        — Admin API creates a confirmed free user
 *   2. profile_free  — the handle_new_user trigger created a user_profiles
 *                      row with plan='free' (also catches the "stranded user,
 *                      no profile" failure mode)
 *   3. login         — email+password mints a session
 *   4. profile_rls   — that session can read its OWN profile row (the
 *                      "signed-in user can actually reach the site" signal)
 *   5. neg_badpass   — a WRONG password is correctly rejected
 *   6. neg_dupe      — signing up the SAME email again is correctly rejected
 *   7. cleanup       — activation_events purged + user deleted (always runs)
 *
 * Before the journey it sweeps any orphaned synthetic users left by a prior
 * crashed run, so test accounts never accumulate.
 *
 * Results → synthetic_journey_log (journey='daily_free') + pipeline_heartbeat
 * ('synthetic_auth_daily'). On failure: immediate Resend email to ops.
 *
 * Shared plumbing lives in ../_lib/synthetic-auth.js.
 */

import { fetchWithTimeout } from '../_lib/responses.js';
import {
    SUPABASE_URL, EMAIL_DOMAIN, EMAIL_PREFIX, svcHeaders,
    requireCron, missingCoreConfig, adminCreateUser, adminDeleteUser,
    deleteActivationEvents, profileServiceRead, passwordLogin, profileRlsRead,
    sweepOrphans, makeStepRunner, recordLog, recordHeartbeat, sendOpsEmail,
} from '../_lib/synthetic-auth.js';

export const config = { runtime: 'edge' };

const PIPELINE = 'synthetic_auth_daily';
const JOURNEY  = 'daily_free';

export default async function handler(request) {
    if (!requireCron(request)) return Response.json({ error: 'unauthorized' }, { status: 401 });
    const missing = missingCoreConfig();
    if (missing.length) return Response.json({ error: 'not_configured', missing }, { status: 500 });

    const source = new URL(request.url).searchParams.get('source') === 'manual' ? 'manual' : 'cron';
    const t0 = Date.now();
    const runId = crypto.randomUUID();
    const email = `${EMAIL_PREFIX}daily-${Date.now()}-${runId.slice(0, 8)}@${EMAIL_DOMAIN}`;
    const password = `Synth-${crypto.randomUUID()}`;
    const { steps, step } = makeStepRunner();

    const sweptOrphans = await sweepOrphans();
    let uid = null;

    try {
        // 1. create
        if (!await step('create', async () => { uid = await adminCreateUser(email, password, { full_name: 'Synthetic Daily' }); return `uid=${uid}`; })) {
            throw new Error('create failed — aborting journey');
        }

        // 2. profile_free — poll briefly for the handle_new_user trigger row
        await step('profile_free', async () => {
            for (let i = 0; i < 10; i++) {
                const { rows } = await profileServiceRead(uid);
                if (Array.isArray(rows) && rows.length === 1) {
                    if (rows[0].plan !== 'free') throw new Error(`expected plan=free, got ${rows[0].plan}`);
                    return `plan=${rows[0].plan} role=${rows[0].role}`;
                }
                await new Promise(r => setTimeout(r, 300));
            }
            throw new Error('no user_profiles row after signup (stranded user / trigger failed)');
        });

        // 3. login
        let accessToken = null;
        await step('login', async () => {
            const { status, body } = await passwordLogin(email, password);
            if (status !== 200 || !body.access_token) throw new Error(`token ${status}: ${body.error_description || body.error || 'no token'}`);
            accessToken = body.access_token;
            return 'session minted';
        });

        // 4. profile_rls — the signed-in user reads its own row
        await step('profile_rls', async () => {
            if (!accessToken) throw new Error('skipped (no session)');
            const { status, rows } = await profileRlsRead(uid, accessToken);
            if (status !== 200 || !Array.isArray(rows) || rows.length !== 1) {
                throw new Error(`expected 1 own-profile row, got status ${status} / ${Array.isArray(rows) ? rows.length : 'non-array'}`);
            }
            return 'self-read ok';
        });

        // 5. neg_badpass — a wrong password MUST be rejected
        await step('neg_badpass', async () => {
            const { status } = await passwordLogin(email, `${password}-WRONG`);
            if (status === 200) throw new Error('wrong password was ACCEPTED (security regression)');
            return `correctly rejected (${status})`;
        });

        // 6. neg_dupe — re-registering the same email MUST be rejected
        await step('neg_dupe', async () => {
            const res = await fetchWithTimeout(`${SUPABASE_URL}/auth/v1/admin/users`, {
                method: 'POST', timeoutMs: 8000, headers: svcHeaders(),
                body: JSON.stringify({ email, password, email_confirm: true }),
            });
            if (res.ok) throw new Error('duplicate signup was ACCEPTED');
            return `correctly rejected (${res.status})`;
        });
    } catch (e) {
        // step() already recorded the failure; nothing else to do here.
    } finally {
        // 7. cleanup — ALWAYS runs so a partial failure never leaks a user.
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

    let alerted = false, emailError = null;
    if (!ok) {
        const subject = `[ALERT] Synthetic signup/login FAILED — ${steps.filter(s => !s.ok).map(s => s.name).join(', ')}`;
        const text = [
            'The daily synthetic free-account robot failed. New users may be unable to sign up or sign in.',
            '', `Run: ${runId}`, '', 'Failing steps:',
            steps.filter(s => !s.ok).map(s => `  • ${s.name}: ${s.detail}`).join('\n') || '  (none captured)',
            '', 'Admin dashboard:  https://parkersphysics.com/admin#onboarding',
            '', '— synthetic-auth-daily cron',
        ].join('\n');
        const r = await sendOpsEmail(subject, text);
        alerted = r.sent; emailError = r.error || null;
    }

    let logError = null;
    try {
        await recordLog({
            journey: JOURNEY, source, ok, steps, latency_ms,
            detail: { run_id: runId, swept_orphans: sweptOrphans, ...(failReason ? { first_failures: failReason } : {}), ...(emailError ? { email_error: emailError } : {}) },
        });
    } catch (e) { logError = e.message; }
    await recordHeartbeat(PIPELINE, ok, failReason || 'synthetic daily failed', 'synthetic-auth-daily');

    return Response.json({
        ok, journey: JOURNEY, source, steps, latency_ms, swept_orphans: sweptOrphans, alerted,
        ...(emailError ? { email_error: emailError } : {}),
        ...(logError ? { log_error: logError } : {}),
        as_of: new Date().toISOString(),
    }, { status: ok ? 200 : 207, headers: { 'Cache-Control': 'no-store' } });
}
