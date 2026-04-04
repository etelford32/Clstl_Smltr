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

export const SUPABASE_URL  = 'https://osvrbwvxnbpwsmgvdmkm.supabase.co';
export const SUPABASE_ANON_KEY = 'YOUR_ANON_KEY_HERE';  // ← paste your anon key

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
