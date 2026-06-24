/**
 * api/_lib/synthetic-auth.js
 *
 * Shared toolkit for the synthetic auth robots (synthetic-auth-daily,
 * synthetic-auth-weekly). Each robot creates THROWAWAY accounts, drives them
 * through a real auth journey, asserts the outcome, then deletes them so
 * nothing pollutes real metrics. This module holds the low-level Supabase
 * plumbing + result plumbing those robots share; the per-journey assertions
 * live in each cron file.
 *
 * Every account is `synthetic+…@<SYNTHETIC_EMAIL_DOMAIN>`; sweepOrphans() reaps
 * any left behind by a crashed run so test users never accumulate.
 */

import { fetchWithTimeout } from './responses.js';

export const SUPABASE_URL  = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://aijsboodkivnhzfstvdq.supabase.co';
export const SERVICE_KEY   = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY || '';
export const ANON_KEY      = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY
                           || 'sb_publishable_1cC1HAb6xTdX3ZafOM-_mg_DrftgLA5';
export const EMAIL_DOMAIN  = process.env.SYNTHETIC_EMAIL_DOMAIN || 'synthetic.parkersphysics.com';
export const EMAIL_PREFIX  = 'synthetic+';

const CRON_SECRET = process.env.CRON_SECRET || '';
const RESEND_API  = 'https://api.resend.com/emails';
const RESEND_KEY  = process.env.RESEND_API_KEY || '';
const FROM_EMAIL  = process.env.ALERT_FROM_EMAIL || 'Parkers Physics Alerts <alerts@parkersphysics.com>';
const OPS_EMAIL   = process.env.ALERT_OPS_EMAIL || '';

export const svcHeaders  = () => ({ apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' });
export const anonHeaders = () => ({ apikey: ANON_KEY, 'Content-Type': 'application/json' });

/** Cron auth: matches the Vercel cron header or an explicit Bearer CRON_SECRET. */
export function requireCron(request) {
    const hdr = request.headers.get('authorization') ?? '';
    if (CRON_SECRET && hdr === `Bearer ${CRON_SECRET}`) return true;
    if (request.headers.get('x-vercel-cron')) return true;
    return false;
}

export function missingCoreConfig() {
    return [
        !SUPABASE_URL ? 'SUPABASE_URL' : null,
        !SERVICE_KEY  ? 'SUPABASE_SERVICE_KEY' : null,
    ].filter(Boolean);
}

// ── Account lifecycle (service role bypasses RLS) ────────────────────────────
export async function adminCreateUser(email, password, userMetadata = {}) {
    const res = await fetchWithTimeout(`${SUPABASE_URL}/auth/v1/admin/users`, {
        method: 'POST', timeoutMs: 10_000, headers: svcHeaders(),
        body: JSON.stringify({ email, password, email_confirm: true, user_metadata: userMetadata }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.id) throw new Error(`create ${res.status}: ${body.msg || body.error_description || body.error || 'no id'}`);
    return body.id;
}

export async function adminDeleteUser(uid) {
    const res = await fetchWithTimeout(`${SUPABASE_URL}/auth/v1/admin/users/${uid}`, {
        method: 'DELETE', timeoutMs: 8000, headers: svcHeaders(),
    });
    if (!res.ok && res.status !== 404) throw new Error(`delete user ${res.status}`);
}

export async function deleteActivationEvents(uid) {
    const res = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/activation_events?user_id=eq.${uid}`, {
        method: 'DELETE', timeoutMs: 8000, headers: { ...svcHeaders(), Prefer: 'return=minimal' },
    });
    if (!res.ok) throw new Error(`delete events ${res.status}`);
}

/** Service-role read of a profile (bypasses RLS — used to assert the trigger). */
export async function profileServiceRead(uid, columns = 'id,plan,role') {
    const res = await fetchWithTimeout(
        `${SUPABASE_URL}/rest/v1/user_profiles?select=${columns}&id=eq.${uid}`,
        { timeoutMs: 8000, headers: svcHeaders() },
    );
    return { status: res.status, rows: await res.json().catch(() => []) };
}

/** Service-role patch of a profile (e.g. simulate a Stripe upgrade webhook). */
export async function profileServicePatch(uid, patch) {
    const res = await fetchWithTimeout(
        `${SUPABASE_URL}/rest/v1/user_profiles?id=eq.${uid}`,
        { method: 'PATCH', timeoutMs: 8000, headers: { ...svcHeaders(), Prefer: 'return=minimal' }, body: JSON.stringify(patch) },
    );
    if (!res.ok) throw new Error(`profile patch ${res.status}: ${(await res.text().catch(() => '')).slice(0, 160)}`);
}

export async function passwordLogin(email, password) {
    const res = await fetchWithTimeout(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
        method: 'POST', timeoutMs: 10_000, headers: anonHeaders(),
        body: JSON.stringify({ email, password }),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
}

/** RLS read as the user (their own JWT) — proves a signed-in user reaches data. */
export async function profileRlsRead(uid, accessToken, columns = 'id,plan,role') {
    const res = await fetchWithTimeout(
        `${SUPABASE_URL}/rest/v1/user_profiles?select=${columns}&id=eq.${uid}`,
        { timeoutMs: 8000, headers: { apikey: ANON_KEY, Authorization: `Bearer ${accessToken}` } },
    );
    return { status: res.status, rows: await res.json().catch(() => []) };
}

/** Call a SECURITY DEFINER RPC with the service role. Returns parsed JSON. */
export async function callRpc(fn, body = {}) {
    const res = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
        method: 'POST', timeoutMs: 8000, headers: svcHeaders(), body: JSON.stringify(body),
    });
    return { status: res.status, data: await res.json().catch(() => null) };
}

/** Reap synthetic users left behind by a crashed run. Bounded to one page. */
export async function sweepOrphans() {
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

// ── Result plumbing ──────────────────────────────────────────────────────────

/** A step runner that times each probe and never throws. */
export function makeStepRunner() {
    const steps = [];
    async function step(name, fn) {
        const s0 = Date.now();
        try {
            const detail = await fn();
            steps.push({ name, ok: true, ms: Date.now() - s0, detail: detail || 'ok' });
            return true;
        } catch (e) {
            steps.push({ name, ok: false, ms: Date.now() - s0, detail: String(e?.message || e).slice(0, 240) });
            return false;
        }
    }
    return { steps, step };
}

export async function recordLog(row) {
    const res = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/synthetic_journey_log`, {
        method: 'POST', timeoutMs: 8000, headers: { ...svcHeaders(), Prefer: 'return=minimal' },
        body: JSON.stringify(row),
    });
    if (!res.ok) throw new Error(`log insert ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
}

export async function recordHeartbeat(pipeline, ok, reason, source = 'synthetic') {
    const fn = ok ? 'record_pipeline_success' : 'record_pipeline_failure';
    const body = ok ? { p_name: pipeline, p_source: source } : { p_name: pipeline, p_reason: reason };
    try {
        await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
            method: 'POST', timeoutMs: 5000, headers: svcHeaders(), body: JSON.stringify(body),
        });
    } catch { /* non-fatal */ }
}

/** Send an ops email via Resend. Returns {sent, error, skipped}. */
export async function sendOpsEmail(subject, text) {
    if (!RESEND_KEY || !OPS_EMAIL) return { sent: false, skipped: true };
    try {
        const res = await fetchWithTimeout(RESEND_API, {
            method: 'POST', timeoutMs: 10_000,
            headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ from: FROM_EMAIL, to: OPS_EMAIL, subject, text }),
        });
        if (!res.ok) return { sent: false, error: `Resend ${res.status}` };
        return { sent: true };
    } catch (e) {
        return { sent: false, error: e.message };
    }
}
