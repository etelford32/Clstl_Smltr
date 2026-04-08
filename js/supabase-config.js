/**
 * supabase-config.js — Supabase client configuration
 *
 * Uses the Supabase JS client (@supabase/supabase-js) loaded from CDN.
 * The publishable key is safe to include in frontend code — it only grants
 * access permitted by Row Level Security (RLS) policies.
 *
 * ── Setup Required ──────────────────────────────────────────────────────────
 *   1. Set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY below
 *      (from Supabase Dashboard → Settings → API Keys)
 *   2. Add SUPABASE_SECRET_KEY to Vercel env vars (for server-side API routes)
 *      — NEVER expose the secret key in frontend code
 *   3. Enable Email Auth in Supabase Dashboard → Authentication → Providers
 *   4. Run the SQL migrations in order:
 *      supabase-schema.sql → supabase-admin.sql → supabase-analytics.sql → supabase-billing.sql
 *
 * ── Key Types (New Supabase API Keys) ───────────────────────────────────────
 *   Publishable key (sb_publishable_...):
 *     Safe for browser/frontend. Respects RLS policies.
 *     Used here for: auth, user profile reads, analytics inserts.
 *
 *   Secret key (sb_secret_...):
 *     Bypasses RLS — full access to all tables.
 *     Used ONLY in Vercel Edge Functions (api/_lib/stripe.js, webhook handler).
 *     Set as SUPABASE_SECRET_KEY env var in Vercel — never in code.
 *
 * ── Security ─────────────────────────────────────────────────────────────────
 *   - Publishable key + RLS = safe for frontend. Users can only access their own data.
 *   - Secret key bypasses RLS — NEVER expose it to the browser.
 *   - Password hashing is handled by Supabase Auth (bcrypt, server-side).
 *   - JWT tokens are stored in localStorage by the Supabase client, with
 *     automatic refresh before expiry.
 */

// ── Supabase Project Credentials ─────────────────────────────────────────────
// From Supabase Dashboard → Settings → API Keys

export const SUPABASE_URL  = 'https://aijsboodkivnhzfstvdq.supabase.co';

/** Publishable key — safe for frontend (enforces RLS). */
export const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_1cC1HAb6xTdX3ZafOM-_mg_DrftgLA5';

// Legacy alias — some modules still reference SUPABASE_ANON_KEY
export const SUPABASE_ANON_KEY = SUPABASE_PUBLISHABLE_KEY;

// CDN URL for the Supabase JS client
const SUPABASE_CDN = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

let _client = null;

/**
 * Get the Supabase client (singleton, lazily created).
 * @returns {Promise<import('@supabase/supabase-js').SupabaseClient>}
 */
export async function getSupabase() {
    if (_client) return _client;

    try {
        const { createClient } = await import(SUPABASE_CDN);
        _client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
            auth: {
                autoRefreshToken: true,
                persistSession: true,
                detectSessionInUrl: true,  // for OAuth redirects
                flowType: 'pkce',          // Use PKCE flow (more secure than implicit)
            },
            global: {
                headers: {
                    'X-Client-Info': 'parker-physics-web',
                },
            },
            // DB query defaults
            db: {
                schema: 'public',
            },
        });
        console.info('[Supabase] Client initialized');
        return _client;
    } catch (err) {
        console.error('[Supabase] Failed to load client:', err.message);
        throw err;
    }
}

/**
 * Check if Supabase is configured (anon key is not placeholder).
 */
export function isConfigured() {
    const key = SUPABASE_PUBLISHABLE_KEY;
    if (!key || key.length < 20) return false;
    if (key === 'YOUR_ANON_KEY_HERE' || key === 'YOUR_PUBLISHABLE_KEY_HERE') return false;
    return true;
}

/**
 * Test the Supabase connection and return a detailed status report.
 * Checks: client init, auth service, database (user_profiles table), latency.
 * @returns {Promise<{ ok: boolean, checks: Array<{ name: string, ok: boolean, ms: number, detail?: string }> }>}
 */
export async function testConnection() {
    const checks = [];

    // 1. Client initialization
    let client = null;
    const t0 = performance.now();
    try {
        client = await getSupabase();
        checks.push({ name: 'Client Init', ok: true, ms: Math.round(performance.now() - t0) });
    } catch (err) {
        checks.push({ name: 'Client Init', ok: false, ms: Math.round(performance.now() - t0), detail: err.message });
        return { ok: false, checks };
    }

    // 2. Auth service health (getSession should always respond, even with no session)
    const t1 = performance.now();
    try {
        const { error } = await client.auth.getSession();
        if (error) throw error;
        checks.push({ name: 'Auth Service', ok: true, ms: Math.round(performance.now() - t1) });
    } catch (err) {
        checks.push({ name: 'Auth Service', ok: false, ms: Math.round(performance.now() - t1), detail: err.message });
    }

    // 3. Database connectivity (query user_profiles — RLS will scope it, but the request itself tests the DB)
    const t2 = performance.now();
    try {
        const { error } = await client.from('user_profiles').select('id').limit(1);
        if (error) throw error;
        checks.push({ name: 'Database', ok: true, ms: Math.round(performance.now() - t2) });
    } catch (err) {
        checks.push({ name: 'Database', ok: false, ms: Math.round(performance.now() - t2), detail: err.message });
    }

    // 4. REST endpoint reachability (lightweight ping to the PostgREST root)
    const t3 = performance.now();
    try {
        const resp = await fetch(`${SUPABASE_URL}/rest/v1/`, {
            method: 'HEAD',
            headers: { 'apikey': SUPABASE_PUBLISHABLE_KEY },
        });
        checks.push({ name: 'REST API', ok: resp.ok, ms: Math.round(performance.now() - t3), detail: resp.ok ? undefined : `HTTP ${resp.status}` });
    } catch (err) {
        checks.push({ name: 'REST API', ok: false, ms: Math.round(performance.now() - t3), detail: err.message });
    }

    const ok = checks.every(c => c.ok);
    return { ok, checks };
}
