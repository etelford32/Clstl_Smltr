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
 * Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, SUPABASE_ANON_KEY (falls back to the
 * publishable key), SYNTHETIC_EMAIL_DOMAIN (default synthetic.parkersphysics.com),
 * RESEND_API_KEY + ALERT_OPS_EMAIL (failure email), CRON_SECRET.
 */

import { fetchWithTimeout } from '../_lib/responses.js';

export const config = { runtime: 'edge' };

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY || '';
const ANON_KEY     = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY
                   || 'sb_publishable_1cC1HAb6xTdX3ZafOM-_mg_DrftgLA5';
const EMAIL_DOMAIN = process.env.SYNTHETIC_EMAIL_DOMAIN || 'synthetic.parkersphysics.com';
const CRON_SECRET  = process.env.CRON_SECRET || '';
const RESEND_KEY   = process.env.RESEND_API_KEY || '';
const FROM_EMAIL   = process.env.ALERT_FROM_EMAIL || 'Parkers Physics Alerts <alerts@parkersphysics.com>';
const OPS_EMAIL    = process.env.ALERT_OPS_EMAIL || '';

const PIPELINE   = 'synthetic_auth_daily';
const JOURNEY    = 'daily_free';
const RESEND_API = 'https://api.resend.com/emails';
const EMAIL_PREFIX = 'synthetic+';   // every robot account starts with this

const svcHeaders = () => ({ apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' });
const anonHeaders = () => ({ apikey: ANON_KEY, 'Content-Type': 'application/json' });

function isAuthorized(request) {
    const hdr = request.headers.get('authorization') ?? '';
    if (CRON_SECRET && hdr === `Bearer ${CRON_SECRET}`) return true;
    if (request.headers.get('x-vercel-cron')) return true;
    return false;
}

// ── Supabase helpers (service role bypasses RLS) ────────────────────────────
async function adminCreateUser(email, password) {
    const res = await fetchWithTimeout(`${SUPABASE_URL}/auth/v1/admin/users`, {
        method: 'POST', timeoutMs: 10_000, headers: svcHeaders(),
        body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { full_name: 'Synthetic Daily' } }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.id) throw new Error(`create ${res.status}: ${body.msg || body.error_description || body.error || 'no id'}`);
    return body.id;
}

async function adminDeleteUser(uid) {
    const res = await fetchWithTimeout(`${SUPABASE_URL}/auth/v1/admin/users/${uid}`, {
        method: 'DELETE', timeoutMs: 8000, headers: svcHeaders(),
    });
    if (!res.ok && res.status !== 404) throw new Error(`delete user ${res.status}`);
}

async function deleteActivationEvents(uid) {
    const res = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/activation_events?user_id=eq.${uid}`, {
        method: 'DELETE', timeoutMs: 8000, headers: { ...svcHeaders(), Prefer: 'return=minimal' },
    });
    if (!res.ok) throw new Error(`delete events ${res.status}`);
}

async function profileServiceRead(uid) {
    const res = await fetchWithTimeout(
        `${SUPABASE_URL}/rest/v1/user_profiles?select=id,plan,role&id=eq.${uid}`,
        { timeoutMs: 8000, headers: svcHeaders() },
    );
    return { status: res.status, rows: await res.json().catch(() => []) };
}

async function passwordLogin(email, password) {
    const res = await fetchWithTimeout(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
        method: 'POST', timeoutMs: 10_000, headers: anonHeaders(),
        body: JSON.stringify({ email, password }),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function profileRlsRead(uid, accessToken) {
    const res = await fetchWithTimeout(
        `${SUPABASE_URL}/rest/v1/user_profiles?select=id,plan,role&id=eq.${uid}`,
        { timeoutMs: 8000, headers: { apikey: ANON_KEY, Authorization: `Bearer ${accessToken}` } },
    );
    return { status: res.status, rows: await res.json().catch(() => []) };
}

// Delete synthetic users left behind by a prior crashed run so test accounts
// never accumulate. Bounded to one admin page.
async function sweepOrphans() {
    try {
        const res = await fetchWithTimeout(`${SUPABASE_URL}/auth/v1/admin/users?per_page=200`, {
            timeoutMs: 10_000, headers: svcHeaders(),
        });
        if (!res.ok) return 0;
        const body = await res.json().catch(() => ({}));
        const users = body.users || body || [];
        const orphans = users.filter(u => (u.email || '').startsWith(EMAIL_PREFIX) && (u.email || '').endsWith(`@${EMAIL_DOMAIN}`));
        let swept = 0;
        for (const u of orphans) {
            try { await deleteActivationEvents(u.id); await adminDeleteUser(u.id); swept++; } catch { /* keep going */ }
        }
        return swept;
    } catch {
        return 0;
    }
}

// ── Persistence ─────────────────────────────────────────────────────────────
async function recordLog(row) {
    const res = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/synthetic_journey_log`, {
        method: 'POST', timeoutMs: 8000, headers: { ...svcHeaders(), Prefer: 'return=minimal' },
        body: JSON.stringify(row),
    });
    if (!res.ok) throw new Error(`log insert ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
}

async function recordHeartbeat(ok, reason) {
    const fn = ok ? 'record_pipeline_success' : 'record_pipeline_failure';
    const body = ok ? { p_name: PIPELINE, p_source: 'synthetic-auth-daily' } : { p_name: PIPELINE, p_reason: reason };
    try {
        await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
            method: 'POST', timeoutMs: 5000, headers: svcHeaders(), body: JSON.stringify(body),
        });
    } catch { /* non-fatal */ }
}

async function sendFailureEmail(steps, runId) {
    const failed = steps.filter(s => !s.ok).map(s => `  • ${s.name}: ${s.detail}`).join('\n');
    const subject = `[ALERT] Synthetic signup/login FAILED — ${steps.filter(s => !s.ok).map(s => s.name).join(', ')}`;
    const text = [
        'The daily synthetic free-account robot failed. New users may be unable to sign up or sign in.',
        '', `Run: ${runId}`, '', 'Failing steps:', failed || '  (none captured)',
        '', 'Admin dashboard:  https://parkersphysics.com/admin#onboarding',
        '', '— synthetic-auth-daily cron',
    ].join('\n');
    const res = await fetchWithTimeout(RESEND_API, {
        method: 'POST', timeoutMs: 10_000,
        headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: FROM_EMAIL, to: OPS_EMAIL, subject, text }),
    });
    if (!res.ok) throw new Error(`Resend ${res.status}`);
}

export default async function handler(request) {
    if (!isAuthorized(request)) return Response.json({ error: 'unauthorized' }, { status: 401 });
    const missing = [
        !SUPABASE_URL ? 'SUPABASE_URL' : null,
        !SERVICE_KEY  ? 'SUPABASE_SERVICE_KEY' : null,
    ].filter(Boolean);
    if (missing.length) return Response.json({ error: 'not_configured', missing }, { status: 500 });

    const source = new URL(request.url).searchParams.get('source') === 'manual' ? 'manual' : 'cron';
    const t0 = Date.now();
    const runId = crypto.randomUUID();
    const email = `${EMAIL_PREFIX}daily-${Date.now()}-${runId.slice(0, 8)}@${EMAIL_DOMAIN}`;
    const password = `Synth-${crypto.randomUUID()}`;
    const steps = [];

    // Step runner: time a probe, capture {name, ok, ms, detail}, never throw.
    async function step(name, fn) {
        const s0 = Date.now();
        try {
            const detail = await fn();
            steps.push({ name, ok: true, ms: Date.now() - s0, detail: detail || 'ok' });
            return true;
        } catch (e) {
            steps.push({ name, ok: false, ms: Date.now() - s0, detail: String(e.message || e).slice(0, 240) });
            return false;
        }
    }

    const sweptOrphans = await sweepOrphans();
    let uid = null;

    try {
        // 1. create
        if (!await step('create', async () => { uid = await adminCreateUser(email, password); return `uid=${uid}`; })) {
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
    if (!ok && RESEND_KEY && OPS_EMAIL) {
        try { await sendFailureEmail(steps, runId); alerted = true; } catch (e) { emailError = e.message; }
    }

    let logError = null;
    try {
        await recordLog({
            journey: JOURNEY, source, ok, steps, latency_ms,
            detail: { run_id: runId, swept_orphans: sweptOrphans, ...(failReason ? { first_failures: failReason } : {}), ...(emailError ? { email_error: emailError } : {}) },
        });
    } catch (e) { logError = e.message; }
    await recordHeartbeat(ok, failReason || 'synthetic daily failed');

    return Response.json({
        ok, journey: JOURNEY, source, steps, latency_ms, swept_orphans: sweptOrphans, alerted,
        ...(emailError ? { email_error: emailError } : {}),
        ...(logError ? { log_error: logError } : {}),
        as_of: new Date().toISOString(),
    }, { status: ok ? 200 : 207, headers: { 'Cache-Control': 'no-store' } });
}
