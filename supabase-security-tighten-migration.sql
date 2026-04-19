-- ═══════════════════════════════════════════════════════════════
-- Parker Physics — Security tightening: analytics / session RLS
-- ═══════════════════════════════════════════════════════════════
-- Paste into the Supabase SQL Editor AFTER supabase-schema.sql has been
-- applied. Safe to re-run; uses DROP POLICY IF EXISTS / CREATE POLICY
-- and CREATE OR REPLACE FUNCTION.
--
-- Why this exists:
--
-- The original schema shipped with two RLS policies that effectively
-- disabled row security on write:
--
--   analytics_events.INSERT  →  WITH CHECK (true)
--   user_sessions.ALL        →  USING (true) WITH CHECK (true)
--
-- Any holder of the anon key (i.e. every visitor) could therefore
-- INSERT rows with arbitrary user_id values — letting someone pollute
-- another user's analytics timeline, inflate "active users" counts on
-- the admin dashboard, or burn the Supabase free-tier row quota.
--
-- This migration replaces those policies with auth.uid()-scoped ones
-- and adds a matching impersonation guard inside the session_heartbeat
-- SECURITY DEFINER RPC (which bypasses RLS and therefore needs its own
-- internal check).
--
-- Semantics after this migration:
--
--   Anon visitor (no JWT):
--     CAN insert analytics_events with user_id = NULL
--     CAN insert a session with user_id = NULL (or call the heartbeat RPC)
--     CANNOT tag rows with any specific user_id
--
--   Authenticated user X:
--     CAN insert analytics_events with user_id = X
--     CAN upsert their own session
--     CANNOT insert/update rows with user_id = Y for any Y ≠ X
--
--   Admin:
--     CAN read everything (existing "Admins can view all …" policies)
--
--   service_role (server-side API endpoints):
--     BYPASSES RLS entirely (standard Supabase behaviour), unchanged.
-- ═══════════════════════════════════════════════════════════════


-- ── 1. analytics_events ────────────────────────────────────────
-- Tighten INSERT: user_id must be NULL or match the JWT's auth.uid().
-- SELECT policy (admin-only) stays as defined in supabase-schema.sql.

DROP POLICY IF EXISTS "Anyone can insert analytics events"
    ON public.analytics_events;

CREATE POLICY "Users insert own events (anon as null)"
    ON public.analytics_events FOR INSERT
    WITH CHECK (user_id IS NULL OR user_id = auth.uid());


-- ── 2. user_sessions ───────────────────────────────────────────
-- Replace the FOR ALL wildcard with scoped INSERT + UPDATE policies.
-- DELETE and SELECT for non-admins remain implicitly blocked (no policy
-- covers them). The admin SELECT policy from supabase-schema.sql stays.

DROP POLICY IF EXISTS "Anyone can upsert sessions"
    ON public.user_sessions;

CREATE POLICY "Users insert own sessions (anon as null)"
    ON public.user_sessions FOR INSERT
    WITH CHECK (user_id IS NULL OR user_id = auth.uid());

CREATE POLICY "Users update own sessions"
    ON public.user_sessions FOR UPDATE
    USING      (user_id IS NULL OR user_id = auth.uid())
    WITH CHECK (user_id IS NULL OR user_id = auth.uid());


-- ── 3. session_heartbeat() impersonation guard ────────────────
-- The RPC is SECURITY DEFINER, which means it runs with the function
-- owner's privileges and BYPASSES RLS. Without a guard inside the
-- function body, a malicious client could pass any user_id and forge
-- a session row for another user:
--
--   supabase.rpc('session_heartbeat', {
--     p_session_id: 'forged',
--     p_user_id:    '<victim's uuid>',
--     ...
--   });
--
-- Even though auth.uid() still reflects the caller's JWT inside a
-- SECURITY DEFINER function (PostgREST sets request.jwt.claims per-
-- request, not per-function), nothing in the original body validated
-- p_user_id against it. This version does.
--
-- Signature unchanged — js/analytics.js#_heartbeat() works as-is.

CREATE OR REPLACE FUNCTION public.session_heartbeat(
    p_session_id TEXT,
    p_user_id    UUID    DEFAULT NULL,
    p_page_path  TEXT    DEFAULT NULL,
    p_user_agent TEXT    DEFAULT NULL
) RETURNS VOID AS $$
BEGIN
    -- Reject impersonation: a non-null p_user_id must equal the JWT
    -- caller's auth.uid(). Anon callers (auth.uid() IS NULL) can only
    -- pass p_user_id = NULL.
    IF p_user_id IS NOT NULL AND p_user_id <> auth.uid() THEN
        RAISE EXCEPTION 'session_heartbeat: p_user_id does not match caller';
    END IF;

    INSERT INTO public.user_sessions
        (session_id, user_id, page_path, user_agent,
         started_at, last_seen, ended)
    VALUES
        (p_session_id, p_user_id, p_page_path, p_user_agent,
         now(), now(), false)
    ON CONFLICT (session_id) DO UPDATE
    SET last_seen  = now(),
        user_id    = COALESCE(EXCLUDED.user_id,    user_sessions.user_id),
        page_path  = COALESCE(EXCLUDED.page_path,  user_sessions.page_path),
        duration_s = EXTRACT(EPOCH FROM (now() - user_sessions.started_at))::INTEGER;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- ═══════════════════════════════════════════════════════════════
-- Verification queries — paste after running to confirm
-- ═══════════════════════════════════════════════════════════════
-- 1. Confirm policies are in place with the expected scoping:
--
--      SELECT schemaname, tablename, policyname, cmd, qual, with_check
--        FROM pg_policies
--       WHERE schemaname = 'public'
--         AND tablename IN ('analytics_events', 'user_sessions')
--       ORDER BY tablename, cmd, policyname;
--
--    Expect three new rows named "Users insert own events …",
--    "Users insert own sessions …", "Users update own sessions".
--
-- 2. Attempted impersonation should fail. As a signed-in user with
--    JWT for user X, run from the JS SDK:
--
--      await supabase.from('analytics_events').insert({
--          event_type: 'test',
--          user_id:    '<other user's uuid>'
--      });
--
--    Expected: error 42501 (row violates row-level security policy).
--
-- 3. Legitimate anon inserts should still work:
--
--      await supabase.from('analytics_events').insert({
--          event_type: 'page_view', user_id: null
--      });
--
--    Expected: success.
-- ═══════════════════════════════════════════════════════════════
