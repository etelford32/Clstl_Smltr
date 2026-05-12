-- ═══════════════════════════════════════════════════════════════
-- Parker Physics — Analytics views: switch to security_invoker
-- ═══════════════════════════════════════════════════════════════
-- Run in Supabase Dashboard → SQL Editor → New Query (idempotent).
--
-- What the Supabase Database Linter flagged
-- -----------------------------------------
--   Rule 0007_security_definer_view, severity ERROR:
--     "View public.analytics_daily is defined with the SECURITY
--      DEFINER property"
--
-- A view created with the default options runs as the view's owner
-- (typically `postgres`) — which means it bypasses RLS on the tables
-- it reads, regardless of who's querying. Even though
-- analytics_events itself has been locked down to admins-only by
-- supabase-security-tighten-migration.sql, the SECURITY DEFINER
-- view re-exposes the same rows to anyone holding the anon key.
--
-- The fix is two PostgreSQL 15+ view options:
--
--   security_invoker = on   →  the view is evaluated with the
--                              caller's permissions, so RLS on the
--                              underlying tables applies as expected.
--   security_barrier = on   →  hardens the view against information
--                              leaks via cleverly-crafted user
--                              functions in WHERE clauses.
--
-- We apply both. Pure metadata change; no data is moved.
--
-- These views were created via the Supabase dashboard rather than
-- in a checked-in migration, so the SQL files don't have a CREATE
-- VIEW to amend — we ALTER in place. The DO blocks make the
-- migration safe to run on environments where one or both views
-- don't exist (you'll get a NOTICE instead of a failed migration).
--
-- After this migration the underlying table is the only thing
-- gating access:
--
--   public.analytics_events
--     RLS:  ENABLED
--     SELECT policy:  "Admins can view all analytics" (admin-only)
--     INSERT policy:  "Users insert own events (anon as null)"
--                     (auth.uid() match or NULL)
--
-- So with security_invoker = on, the views return:
--   * admin / superadmin                → all rows
--   * authenticated non-admin            → 0 rows
--   * anon                               → 0 rows
--   * service_role (Edge Functions)     → all rows (bypasses RLS)
--
-- That's the intended behaviour and matches what the admin
-- dashboard already assumes.
-- ═══════════════════════════════════════════════════════════════


-- ── 1. public.analytics_daily ──────────────────────────────────
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_views
         WHERE schemaname = 'public'
           AND viewname   = 'analytics_daily'
    ) THEN
        ALTER VIEW public.analytics_daily
            SET (security_invoker = on, security_barrier = on);
        RAISE NOTICE 'analytics_daily: security_invoker + security_barrier = on';
    ELSE
        RAISE NOTICE 'analytics_daily: view not present in this environment — skipping';
    END IF;
END $$;


-- ── 2. public.user_analytics ───────────────────────────────────
-- Same shape as analytics_daily and read by js/admin-analytics.js
-- (fetchTopSimsByPlan). If the linter flags it next, we've already
-- closed the gap.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_views
         WHERE schemaname = 'public'
           AND viewname   = 'user_analytics'
    ) THEN
        ALTER VIEW public.user_analytics
            SET (security_invoker = on, security_barrier = on);
        RAISE NOTICE 'user_analytics: security_invoker + security_barrier = on';
    ELSE
        RAISE NOTICE 'user_analytics: view not present in this environment — skipping';
    END IF;
END $$;


-- ── 3. Belt-and-braces RLS assertion on the underlying table ───
-- The lint warning is about the view, but the actual access gate
-- is RLS on analytics_events. If a future migration disables RLS
-- here by accident, the view would silently start returning more.
-- Re-asserting is idempotent.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_class
         WHERE relname   = 'analytics_events'
           AND relnamespace = 'public'::regnamespace
           AND NOT relrowsecurity
    ) THEN
        RAISE EXCEPTION
            'analytics_events has RLS DISABLED — refusing to switch views to invoker-mode while the underlying table is open.';
    END IF;
END $$;


-- ═══════════════════════════════════════════════════════════════
-- Verification queries — paste after running
-- ═══════════════════════════════════════════════════════════════
-- 1. Confirm the view options are set:
--
--      SELECT c.relname AS view,
--             c.reloptions
--        FROM pg_class c
--        JOIN pg_namespace n ON n.oid = c.relnamespace
--       WHERE n.nspname = 'public'
--         AND c.relkind = 'v'
--         AND c.relname IN ('analytics_daily', 'user_analytics');
--
--    Expect each row's reloptions to contain
--      {security_invoker=on, security_barrier=on}
--
-- 2. The Supabase Linter (Database → Advisors → Security) should
--    no longer report 0007_security_definer_view for these views.
--
-- 3. End-to-end: signed in as a non-admin, run from the JS console:
--
--      const { data, error } = await supabase
--          .from('analytics_daily').select('*').limit(1);
--
--    Expect: data is [] (RLS denies via the underlying table's
--    "Admins can view all analytics" policy). Same for user_analytics.
--    The admin dashboard, called as an admin user, continues to
--    return rows.
-- ═══════════════════════════════════════════════════════════════
