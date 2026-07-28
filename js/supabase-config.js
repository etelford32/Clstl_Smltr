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

// CDN sources for the Supabase JS client, tried in order.
//
// WHY A CHAIN: production telemetry (client_telemetry kind='auth_failure',
// 2026-06-29 → 2026-07-26) recorded 950 "Failed to fetch dynamically
// imported module: …jsdelivr…" events across 811 of 1,595 sessions —
// roughly HALF of all visits could not load the auth client from the
// single jsDelivr URL (ad blockers, corporate proxies, regional CDN
// blocks). Each entry below serves a browser-ready ESM bundle of the
// same package; the first one that imports wins. jsDelivr stays primary
// (fastest, historically the canonical source).
//
// This is deliberately NOT a switch to a bundled/vendored import —
// CLAUDE.md §9 reserves that decision for the author.
const SUPABASE_CDNS = [
    'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm',
    'https://esm.sh/@supabase/supabase-js@2',
    'https://unpkg.com/@supabase/supabase-js@2?module',
];

// Per-attempt cap so one hung CDN can't stall auth init for the whole
// chain. A raced-out import may still resolve later; we simply stop
// waiting for it and move on.
const CDN_ATTEMPT_TIMEOUT_MS = 8000;

// sessionStorage key remembering which CDN index worked last, so later
// page loads in the same session skip straight past a blocked primary
// instead of re-paying the timeout on every navigation.
const CDN_MEMO_KEY = 'pp_sb_cdn';

let _client = null;
let _loadInfo = null;   // { cdn, index, attempts, ms } for the successful load

/** How the client was loaded (null until getSupabase() succeeds).
 *  Consumed by js/auth.js to emit fallback telemetry — a rising
 *  fallback rate is the early-warning that the primary CDN is dying. */
export function getSupabaseLoadInfo() {
    return _loadInfo;
}

function _importWithTimeout(url, ms) {
    return Promise.race([
        import(url),
        new Promise((_, reject) => setTimeout(
            () => reject(new Error(`CDN import timed out after ${ms}ms: ${url}`)), ms)),
    ]);
}

/**
 * Get the Supabase client (singleton, lazily created).
 * Tries each CDN in SUPABASE_CDNS (last-known-good first) and throws
 * only when every source has failed — callers treat that as
 * "auth service unreachable", not as "run without auth".
 * @returns {Promise<import('@supabase/supabase-js').SupabaseClient>}
 */
export async function getSupabase() {
    if (_client) return _client;

    // Try the CDN that worked last time first (falls back to list order).
    let order = SUPABASE_CDNS.map((_, i) => i);
    try {
        const memo = +sessionStorage.getItem(CDN_MEMO_KEY);
        if (Number.isInteger(memo) && memo > 0 && memo < SUPABASE_CDNS.length) {
            order = [memo, ...order.filter(i => i !== memo)];
        }
    } catch (_) {}

    const t0 = Date.now();
    const failures = [];
    for (let attempt = 0; attempt < order.length; attempt++) {
        const idx = order[attempt];
        const url = SUPABASE_CDNS[idx];
        try {
            const { createClient } = await _importWithTimeout(url, CDN_ATTEMPT_TIMEOUT_MS);
            _client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
                auth: {
                    autoRefreshToken: true,
                    persistSession: true,
                    detectSessionInUrl: true,  // for OAuth redirects
                },
            });
            _loadInfo = { cdn: url, index: idx, attempts: attempt + 1, ms: Date.now() - t0 };
            try { sessionStorage.setItem(CDN_MEMO_KEY, String(idx)); } catch (_) {}
            if (idx !== 0) {
                console.warn(`[Supabase] Primary CDN unavailable — loaded client from fallback: ${url}`);
            } else {
                console.info('[Supabase] Client initialized');
            }
            return _client;
        } catch (err) {
            failures.push(`${url} → ${err?.message || err}`);
            console.warn(`[Supabase] CDN attempt ${attempt + 1}/${order.length} failed:`, err?.message || err);
        }
    }

    const summary = new Error(
        `Failed to load Supabase client from all ${order.length} CDNs: ${failures.join(' | ')}`.slice(0, 500));
    console.error('[Supabase]', summary.message);
    throw summary;
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
