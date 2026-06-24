/**
 * Vercel Edge Cron: /api/cron/auth-healthcheck
 *
 * Daily "can a real user actually sign in and reach the site?" probe. Runs a
 * dedicated, low-privilege test account through the real Supabase auth surface
 * and records the verdict. This is the automated answer to the recurring
 * "is sign-in broken?" question — instead of waiting for a user to report it.
 *
 * ── What it checks ────────────────────────────────────────────────────
 *   1. password   — POST /auth/v1/token?grant_type=password mints a session.
 *   2. profile    — that session can SELECT its own user_profiles row (RLS).
 *                    This is the "has access to the site" signal: a JWT that
 *                    can't read its profile can't pass the dashboard gate.
 *   3. google     — GET /auth/v1/settings reports external.google === true,
 *                    i.e. the Google OAuth provider is still enabled/wired.
 *   4. magiclink  — (opt-in, HEALTHCHECK_MAGICLINK=1) POST /auth/v1/otp is
 *                    accepted. OFF by default because it sends a real email
 *                    to the test inbox on every run.
 *
 * Overall ok = password && profile && google  (magiclink never fails the run;
 * it's reported but excluded from the verdict unless you want to wire it in).
 *
 * ── Where results go ──────────────────────────────────────────────────
 *   - auth_healthcheck_log         (rich per-run history; admin card reads it)
 *   - pipeline_heartbeat           (record_pipeline_success/failure for
 *                                   'auth_signin' → the existing
 *                                   pipeline-watchdog emails on a fail streak)
 *   - Resend email, immediately, on the FIRST failing run (same-day signal,
 *     not the watchdog's 3-strike streak). Cooldown via last logged email.
 *
 * ── Auth ──────────────────────────────────────────────────────────────
 *   - Vercel cron `x-vercel-cron: 1` header, OR Bearer CRON_SECRET.
 *   - `?source=manual` (with a valid auth header) tags a hand-triggered run.
 *
 * ── Env vars ──────────────────────────────────────────────────────────
 *   SUPABASE_URL            (or NEXT_PUBLIC_SUPABASE_URL)
 *   SUPABASE_SERVICE_KEY    (or SUPABASE_SECRET_KEY)   — writes the log/heartbeat
 *   SUPABASE_ANON_KEY       (or SUPABASE_PUBLISHABLE_KEY) — the public client key
 *   AUTH_HEALTHCHECK_EMAIL      — the dedicated test account
 *   AUTH_HEALTHCHECK_PASSWORD   — its password
 *   RESEND_API_KEY          (optional — no key ⇒ runs + records but no email)
 *   ALERT_FROM_EMAIL        (optional, default alerts@parkersphysics.com)
 *   ALERT_OPS_EMAIL         (required for the email alert)
 *   CRON_SECRET             (optional but recommended)
 *   HEALTHCHECK_MAGICLINK   (optional, '1' to enable the magic-link probe)
 *
 * ── Response ──────────────────────────────────────────────────────────
 *   200 { ok:true,  results, latency_ms } when everything passed
 *   207 { ok:false, results, latency_ms, alerted } when a check failed
 */

import { fetchWithTimeout } from '../_lib/responses.js';

export const config = { runtime: 'edge' };

const SUPABASE_URL  = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SERVICE_KEY   = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY || '';
// The publishable/anon key is public by design (it only grants RLS-permitted
// access). Fall back to the project's known publishable key so the probe still
// runs if the env var wasn't set, matching js/supabase-config.js.
const ANON_KEY      = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY
                    || 'sb_publishable_1cC1HAb6xTdX3ZafOM-_mg_DrftgLA5';
const TEST_EMAIL    = process.env.AUTH_HEALTHCHECK_EMAIL || '';
const TEST_PASSWORD = process.env.AUTH_HEALTHCHECK_PASSWORD || '';
const CRON_SECRET   = process.env.CRON_SECRET || '';
const RESEND_KEY    = process.env.RESEND_API_KEY || '';
const FROM_EMAIL    = process.env.ALERT_FROM_EMAIL || 'Parkers Physics Alerts <alerts@parkersphysics.com>';
const OPS_EMAIL     = process.env.ALERT_OPS_EMAIL || '';
const DO_MAGICLINK  = process.env.HEALTHCHECK_MAGICLINK === '1';

const RESEND_API = 'https://api.resend.com/emails';
const PIPELINE   = 'auth_signin';

// Don't re-email more than once per ~20h while a failure persists. The cron is
// daily, so this just guards against a manual re-trigger spamming the inbox.
const EMAIL_COOLDOWN_MS = 20 * 60 * 60 * 1000;

function isAuthorized(request) {
    const hdr = request.headers.get('authorization') ?? '';
    if (CRON_SECRET && hdr === `Bearer ${CRON_SECRET}`) return true;
    if (request.headers.get('x-vercel-cron')) return true;
    return false;
}

// ── Individual probes ───────────────────────────────────────────────────────
// Each returns { ok, detail, ...extra }. None throw; a thrown/timed-out fetch
// becomes { ok:false, detail }.

async function probePassword() {
    try {
        const res = await fetchWithTimeout(
            `${SUPABASE_URL}/auth/v1/token?grant_type=password`,
            {
                method: 'POST',
                timeoutMs: 10_000,
                headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
            },
        );
        const body = await res.json().catch(() => ({}));
        if (!res.ok || !body.access_token) {
            return { ok: false, detail: `token ${res.status}: ${body.error_description || body.msg || body.error || 'no access_token'}` };
        }
        return { ok: true, detail: 'session minted', accessToken: body.access_token, userId: body.user?.id || null };
    } catch (e) {
        return { ok: false, detail: `token request failed: ${e.message}` };
    }
}

async function probeProfile(accessToken, userId) {
    if (!accessToken || !userId) return { ok: false, detail: 'skipped (no session)' };
    try {
        const res = await fetchWithTimeout(
            `${SUPABASE_URL}/rest/v1/user_profiles?select=id,plan,role&id=eq.${userId}`,
            {
                timeoutMs: 8000,
                headers: { apikey: ANON_KEY, Authorization: `Bearer ${accessToken}` },
            },
        );
        const rows = await res.json().catch(() => []);
        if (!res.ok) return { ok: false, detail: `profile read ${res.status}` };
        if (!Array.isArray(rows) || rows.length !== 1) {
            return { ok: false, detail: `expected 1 own-profile row, got ${Array.isArray(rows) ? rows.length : 'non-array'} (RLS?)` };
        }
        return { ok: true, detail: `plan=${rows[0].plan} role=${rows[0].role}` };
    } catch (e) {
        return { ok: false, detail: `profile request failed: ${e.message}` };
    }
}

async function probeGoogle() {
    try {
        const res = await fetchWithTimeout(`${SUPABASE_URL}/auth/v1/settings`, {
            timeoutMs: 8000,
            headers: { apikey: ANON_KEY },
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) return { ok: false, detail: `settings ${res.status}` };
        const enabled = body?.external?.google === true;
        return { ok: enabled, detail: enabled ? 'provider enabled' : 'external.google is not true (provider disabled)' };
    } catch (e) {
        return { ok: false, detail: `settings request failed: ${e.message}` };
    }
}

async function probeMagicLink() {
    try {
        const res = await fetchWithTimeout(`${SUPABASE_URL}/auth/v1/otp`, {
            method: 'POST',
            timeoutMs: 10_000,
            headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: TEST_EMAIL, create_user: false }),
        });
        // Supabase returns 200 with an empty body on success (anti-enumeration).
        if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            return { ok: false, detail: `otp ${res.status}: ${body.error_description || body.msg || ''}` };
        }
        return { ok: true, detail: 'otp accepted' };
    } catch (e) {
        return { ok: false, detail: `otp request failed: ${e.message}` };
    }
}

async function bestEffortLogout(accessToken) {
    if (!accessToken) return;
    try {
        await fetchWithTimeout(`${SUPABASE_URL}/auth/v1/logout`, {
            method: 'POST',
            timeoutMs: 5000,
            headers: { apikey: ANON_KEY, Authorization: `Bearer ${accessToken}` },
        });
    } catch { /* non-fatal — the daily session expires on its own */ }
}

// ── Persistence (service key bypasses RLS) ──────────────────────────────────
async function recordLog(row) {
    const res = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/auth_healthcheck_log`, {
        method: 'POST',
        timeoutMs: 8000,
        headers: {
            apikey: SERVICE_KEY,
            Authorization: `Bearer ${SERVICE_KEY}`,
            'Content-Type': 'application/json',
            Prefer: 'return=minimal',
        },
        body: JSON.stringify(row),
    });
    if (!res.ok) throw new Error(`log insert ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
}

async function recordHeartbeat(ok, reason) {
    const fn   = ok ? 'record_pipeline_success' : 'record_pipeline_failure';
    const body = ok ? { p_name: PIPELINE, p_source: 'auth-healthcheck' }
                    : { p_name: PIPELINE, p_reason: reason };
    try {
        await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
            method: 'POST',
            timeoutMs: 5000,
            headers: {
                apikey: SERVICE_KEY,
                Authorization: `Bearer ${SERVICE_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
        });
    } catch { /* non-fatal — the log row is the primary record */ }
}

// Was an alert already emailed within the cooldown window? Reads the most
// recent log row's detail.emailed_at. Best-effort; a read failure just allows
// the send (better a possible dupe than silence).
async function recentlyEmailed() {
    try {
        const res = await fetchWithTimeout(
            `${SUPABASE_URL}/rest/v1/auth_healthcheck_log?select=detail,ran_at&order=ran_at.desc&limit=1`,
            {
                timeoutMs: 5000,
                headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
            },
        );
        const rows = await res.json().catch(() => []);
        const emailedAt = rows?.[0]?.detail?.emailed_at;
        if (!emailedAt) return false;
        return (Date.now() - new Date(emailedAt).getTime()) < EMAIL_COOLDOWN_MS;
    } catch {
        return false;
    }
}

async function sendFailureEmail(results) {
    const failed = Object.entries(results)
        .filter(([, v]) => v && v.ok === false)
        .map(([k, v]) => `  • ${k}: ${v.detail}`)
        .join('\n');

    const subject = `[ALERT] Sign-in health check FAILED — ${Object.keys(results).filter(k => results[k]?.ok === false).join(', ')}`;
    const text = [
        'The daily sign-in health check failed. A real user may be unable to sign in.',
        '',
        'Failing checks:',
        failed || '  (none captured)',
        '',
        'What each check means:',
        '  password — email+password sign-in could not mint a session',
        '  profile  — the session could not read its own user_profiles row (RLS / dashboard gate)',
        '  google   — the Google OAuth provider is not reported as enabled',
        '',
        'Admin dashboard:  https://parkersphysics.com/admin#onboarding',
        '',
        '— auth-healthcheck cron',
    ].join('\n');

    const res = await fetchWithTimeout(RESEND_API, {
        method: 'POST',
        timeoutMs: 10_000,
        headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: FROM_EMAIL, to: OPS_EMAIL, subject, text }),
    });
    if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    return await res.json().catch(() => ({}));
}

export default async function handler(request) {
    if (!isAuthorized(request)) {
        return Response.json({ error: 'unauthorized' }, { status: 401 });
    }
    const missing = [
        !SUPABASE_URL ? 'SUPABASE_URL' : null,
        !SERVICE_KEY  ? 'SUPABASE_SERVICE_KEY' : null,
        !TEST_EMAIL   ? 'AUTH_HEALTHCHECK_EMAIL' : null,
        !TEST_PASSWORD ? 'AUTH_HEALTHCHECK_PASSWORD' : null,
    ].filter(Boolean);
    if (missing.length) {
        return Response.json({ error: 'not_configured', missing }, { status: 500 });
    }

    const source = new URL(request.url).searchParams.get('source') === 'manual' ? 'manual' : 'cron';
    const t0 = Date.now();

    // 1–2: password sign-in → own-profile read (chained: profile needs the JWT).
    const password = await probePassword();
    const profile  = await probeProfile(password.accessToken, password.userId);
    // 3: provider enabled. 4: magic-link (opt-in).
    const google    = await probeGoogle();
    const magiclink = DO_MAGICLINK ? await probeMagicLink() : null;

    await bestEffortLogout(password.accessToken);

    const results = { password, profile, google, ...(magiclink ? { magiclink } : {}) };
    // Verdict excludes magiclink — it's informational and (by default) not even run.
    const ok = password.ok && profile.ok && google.ok;
    const latency_ms = Date.now() - t0;

    const failReason = ok
        ? null
        : Object.entries(results)
            .filter(([, v]) => v && v.ok === false)
            .map(([k, v]) => `${k}: ${v.detail}`)
            .join(' | ')
            .slice(0, 480);

    // Alert (immediate, same-day) — only on failure, with a cooldown.
    let alerted = false;
    let emailError = null;
    let emailedAt = null;
    if (!ok && RESEND_KEY && OPS_EMAIL) {
        try {
            if (!(await recentlyEmailed())) {
                await sendFailureEmail(results);
                alerted = true;
                emailedAt = new Date().toISOString();
            }
        } catch (e) {
            emailError = e.message;
        }
    }

    // Persist: strip the access token out of the stored detail.
    const safeDetail = {
        password:  { ok: password.ok, detail: password.detail },
        profile:   { ok: profile.ok,  detail: profile.detail },
        google:    { ok: google.ok,   detail: google.detail },
        ...(magiclink ? { magiclink: { ok: magiclink.ok, detail: magiclink.detail } } : {}),
        ...(emailError ? { email_error: emailError } : {}),
        ...(emailedAt ? { emailed_at: emailedAt } : {}),
    };
    let logError = null;
    try {
        await recordLog({
            source,
            ok,
            password_ok:  password.ok,
            profile_ok:   profile.ok,
            google_ok:    google.ok,
            magiclink_ok: magiclink ? magiclink.ok : null,
            latency_ms,
            detail: safeDetail,
        });
    } catch (e) {
        logError = e.message;
    }
    await recordHeartbeat(ok, failReason || 'auth healthcheck failed');

    return Response.json({
        ok,
        source,
        results: safeDetail,
        latency_ms,
        alerted,
        ...(emailError ? { email_error: emailError } : {}),
        ...(logError ? { log_error: logError } : {}),
        as_of: new Date().toISOString(),
    }, {
        status: ok ? 200 : 207,
        headers: { 'Cache-Control': 'no-store' },
    });
}
