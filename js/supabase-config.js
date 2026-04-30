/**
 * supabase-config.js — Supabase client configuration
 *
 * Uses the Supabase JS client (@supabase/supabase-js) loaded from CDN.
 * The anon key is safe to include in frontend code — it only grants
 * access permitted by Row Level Security (RLS) policies.
 *
 * ── Setup Required ──────────────────────────────────────────────────────────
 *   1. Set SUPABASE_URL and SUPABASE_ANON_KEY below (from Supabase dashboard)
 *   2. Add SUPABASE_SERVICE_KEY to Vercel env vars (for server-side API routes)
 *   3. Enable Email Auth in Supabase Dashboard → Authentication → Providers
 *   4. Run the SQL migration in supabase-schema.sql to create tables
 *
 * ── Architecture ─────────────────────────────────────────────────────────────
 *   Frontend (js/auth.js):
 *     Uses supabase.auth.signInWithPassword() — handles JWT, refresh tokens
 *     Session stored in localStorage by Supabase client automatically
 *
 *   Edge Functions (api/auth/*):
 *     Use SUPABASE_SERVICE_KEY for admin operations (user management)
 *     Never exposed to the browser
 *
 * ── Security ─────────────────────────────────────────────────────────────────
 *   - The anon key + RLS = safe for frontend. Users can only access their own data.
 *   - The service_role key bypasses RLS — NEVER expose it to the browser.
 *   - Password hashing is handled by Supabase Auth (bcrypt, server-side).
 *   - JWT tokens are stored in localStorage by the Supabase client, with
 *     automatic refresh before expiry.
 */

// ── Supabase Project Credentials ─────────────────────────────────────────────
// Replace these with your project's values from:
//   Supabase Dashboard → Settings → API

export const SUPABASE_URL  = 'https://aijsboodkivnhzfstvdq.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_1cC1HAb6xTdX3ZafOM-_mg_DrftgLA5';

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
        _client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
            auth: {
                autoRefreshToken: true,
                persistSession: true,
                detectSessionInUrl: true,  // for OAuth redirects
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
    return SUPABASE_ANON_KEY !== 'YOUR_ANON_KEY_HERE' && SUPABASE_ANON_KEY.length > 20;
}

/**
 * Test Supabase connection health — checks auth, database, and schema status.
 * Used by admin dashboard System tab to verify configuration.
 *
 * @returns {{ ok: boolean, checks: Array<{ name: string, ok: boolean, ms: number, detail?: string }> }}
 */
export async function testConnection() {
    const checks = [];

    // 1. Client initialization
    let client;
    const t0 = performance.now();
    try {
        client = await getSupabase();
        checks.push({ name: 'Supabase client', ok: true, ms: Math.round(performance.now() - t0) });
    } catch (err) {
        checks.push({ name: 'Supabase client', ok: false, ms: Math.round(performance.now() - t0), detail: err.message });
        return { ok: false, checks };
    }

    // 2. Auth service
    const t1 = performance.now();
    try {
        const { data, error } = await client.auth.getSession();
        checks.push({
            name: 'Auth service',
            ok: !error,
            ms: Math.round(performance.now() - t1),
            detail: error?.message || (data?.session ? `Session active (${data.session.user.email})` : 'No active session'),
        });
    } catch (err) {
        checks.push({ name: 'Auth service', ok: false, ms: Math.round(performance.now() - t1), detail: err.message });
    }

    // 3. Database: user_profiles table
    const t2 = performance.now();
    try {
        const { data, error } = await client.from('user_profiles').select('id', { count: 'exact', head: true });
        checks.push({
            name: 'Database (user_profiles)',
            ok: !error,
            ms: Math.round(performance.now() - t2),
            detail: error?.message,
        });
    } catch (err) {
        checks.push({ name: 'Database (user_profiles)', ok: false, ms: Math.round(performance.now() - t2), detail: err.message });
    }

    // 4. Role column exists
    const t3 = performance.now();
    try {
        const { error } = await client.from('user_profiles').select('role').limit(1);
        const hasRole = !error;
        checks.push({
            name: 'Role column (admin schema)',
            ok: hasRole,
            ms: Math.round(performance.now() - t3),
            detail: hasRole ? 'role column exists' : 'Missing — run supabase-admin.sql',
        });
    } catch (err) {
        checks.push({ name: 'Role column (admin schema)', ok: false, ms: Math.round(performance.now() - t3), detail: err.message });
    }

    // 5. invite_codes table
    const t4 = performance.now();
    try {
        const { error } = await client.from('invite_codes').select('id', { count: 'exact', head: true });
        checks.push({
            name: 'Invite codes table',
            ok: !error,
            ms: Math.round(performance.now() - t4),
            detail: error?.message,
        });
    } catch (err) {
        checks.push({ name: 'Invite codes table', ok: false, ms: Math.round(performance.now() - t4), detail: err.message });
    }

    const allOk = checks.every(c => c.ok);
    return { ok: allOk, checks };
}
