#!/usr/bin/env node
/**
 * setup-auth-healthcheck-user.mjs
 *
 * One-time (idempotent) provisioner for the dedicated account the daily
 * sign-in health check (api/cron/auth-healthcheck.js) signs in as. Creates a
 * low-privilege, email-confirmed Supabase auth user with a known password —
 * or, if it already exists, resets that password so the cron's env matches.
 *
 * The handle_new_user trigger creates the matching public.user_profiles row
 * (plan 'free', role 'user'); we verify it landed so the profile/RLS probe
 * has something to read.
 *
 * Run it from a trusted shell — it needs the SERVICE key, which bypasses RLS.
 * Never commit the password; it lives only in env + Vercel/GitHub secrets.
 *
 *   SUPABASE_URL=...                  (or NEXT_PUBLIC_SUPABASE_URL)
 *   SUPABASE_SERVICE_KEY=...          (or SUPABASE_SECRET_KEY)
 *   AUTH_HEALTHCHECK_EMAIL=signin-healthcheck@parkersphysics.com
 *   AUTH_HEALTHCHECK_PASSWORD=...     (generate a strong one)
 *   node scripts/setup-auth-healthcheck-user.mjs
 */

const URL_BASE = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SERVICE  = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY || '';
const EMAIL    = process.env.AUTH_HEALTHCHECK_EMAIL || '';
const PASSWORD = process.env.AUTH_HEALTHCHECK_PASSWORD || '';

function die(msg) { console.error(`✗ ${msg}`); process.exit(1); }

const missing = [
    !URL_BASE ? 'SUPABASE_URL' : null,
    !SERVICE  ? 'SUPABASE_SERVICE_KEY' : null,
    !EMAIL    ? 'AUTH_HEALTHCHECK_EMAIL' : null,
    !PASSWORD ? 'AUTH_HEALTHCHECK_PASSWORD' : null,
].filter(Boolean);
if (missing.length) die(`missing env: ${missing.join(', ')}`);
if (PASSWORD.length < 12) die('AUTH_HEALTHCHECK_PASSWORD should be at least 12 chars');

const adminHeaders = {
    apikey: SERVICE,
    Authorization: `Bearer ${SERVICE}`,
    'Content-Type': 'application/json',
};

async function findUserByEmail(email) {
    // The admin list endpoint paginates; the test project is small so one page
    // (default 50) is plenty. Bump perPage if you ever outgrow it.
    const res = await fetch(`${URL_BASE}/auth/v1/admin/users?per_page=200`, { headers: adminHeaders });
    if (!res.ok) die(`admin list users ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = await res.json();
    const users = body.users || body;
    return (users || []).find(u => (u.email || '').toLowerCase() === email.toLowerCase()) || null;
}

async function main() {
    console.log(`→ ensuring health-check user ${EMAIL} on ${URL_BASE}`);

    // Try to create first (the common first-run path).
    const createRes = await fetch(`${URL_BASE}/auth/v1/admin/users`, {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({
            email: EMAIL,
            password: PASSWORD,
            email_confirm: true,
            user_metadata: { full_name: 'Sign-in Healthcheck' },
        }),
    });

    let userId;
    if (createRes.ok) {
        const u = await createRes.json();
        userId = u.id;
        console.log(`✓ created user ${userId}`);
    } else {
        const errText = await createRes.text();
        // 422 = already registered. Fall through to find + password reset so
        // the script stays idempotent and can rotate the password.
        if (createRes.status !== 422 && !/already.*registered|exists/i.test(errText)) {
            die(`create user ${createRes.status}: ${errText.slice(0, 200)}`);
        }
        const existing = await findUserByEmail(EMAIL);
        if (!existing) die('user reported as existing but not found in admin list');
        userId = existing.id;
        const upd = await fetch(`${URL_BASE}/auth/v1/admin/users/${userId}`, {
            method: 'PUT',
            headers: adminHeaders,
            body: JSON.stringify({ password: PASSWORD, email_confirm: true }),
        });
        if (!upd.ok) die(`password reset ${upd.status}: ${(await upd.text()).slice(0, 200)}`);
        console.log(`✓ user ${userId} already existed — password reset`);
    }

    // Verify the profile row exists (handle_new_user trigger). Read via REST
    // with the service key (bypasses RLS).
    const profRes = await fetch(
        `${URL_BASE}/rest/v1/user_profiles?select=id,plan,role&id=eq.${userId}`,
        { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } },
    );
    const profile = profRes.ok ? await profRes.json() : [];
    if (Array.isArray(profile) && profile.length === 1) {
        console.log(`✓ user_profiles row present (plan=${profile[0].plan}, role=${profile[0].role})`);
    } else {
        console.warn('⚠ no user_profiles row found — confirm the handle_new_user trigger is applied');
        console.warn('  (the profile/RLS probe will fail until a row exists for this user)');
    }

    console.log('\nDone. Now set these as env vars in Vercel (and GitHub secrets if used):');
    console.log(`  AUTH_HEALTHCHECK_EMAIL=${EMAIL}`);
    console.log('  AUTH_HEALTHCHECK_PASSWORD=********  (the value you just used)');
    console.log('  ALERT_OPS_EMAIL=<your inbox>   RESEND_API_KEY=<key>   CRON_SECRET=<secret>');
}

main().catch(e => die(e.message));
