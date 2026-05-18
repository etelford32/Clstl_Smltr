-- ═══════════════════════════════════════════════════════════════
-- Parker Physics — analytics_unique_counts() RPC
-- Run in Supabase Dashboard → SQL Editor → New Query (idempotent).
-- ═══════════════════════════════════════════════════════════════
--
-- Why this exists
-- ---------------
-- The admin Overview "Visitors" KPIs used to compute distinct
-- session_id / user_id client-side by SELECT-ing every matching
-- analytics_events row and de-duping in JS. analytics_events is the
-- highest-volume table in the app (hundreds of rows per session:
-- page_view, scroll_depth, click, page_close…). Over a 30-day window
-- that easily exceeds PostgREST's default max-rows cap (1000), so the
-- client only ever saw the first page of rows and the KPI silently
-- under-counted as traffic grew. Filtering user_id IS NOT NULL used to
-- mask this (few rows came back); removing that filter to count
-- anonymous visitors makes the cap bite immediately.
--
-- The correct fix is to count on the server. COUNT(DISTINCT …) runs
-- against the idx_analytics_events_created index and returns six
-- integers instead of streaming N thousand rows to the browser.
--
-- Security
-- --------
-- SECURITY DEFINER so it can read analytics_events (admin-only under
-- RLS) regardless of caller, with an explicit is_admin() guard inside
-- so a non-admin authenticated user can't call it for a traffic
-- read-out. Only aggregate counts are returned — no row-level data,
-- no PII. Mirrors the posture of supabase-analytics-views-rls-fix.sql.
-- ═══════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.analytics_unique_counts()
RETURNS TABLE(
    window_label    TEXT,
    unique_visitors BIGINT,
    signed_in_users BIGINT
) AS $$
BEGIN
    IF NOT public.is_admin() THEN
        RAISE EXCEPTION 'analytics_unique_counts: admin only';
    END IF;

    RETURN QUERY
        -- COUNT(DISTINCT col) already ignores NULLs, so a blank
        -- session_id / pre-identify user_id does not create a bogus
        -- bucket. Each window is an independent index-assisted scan.
        SELECT 'day'::TEXT,
               COUNT(DISTINCT e.session_id),
               COUNT(DISTINCT e.user_id)
          FROM public.analytics_events e
         WHERE e.created_at > now() - INTERVAL '1 day'
        UNION ALL
        SELECT 'week'::TEXT,
               COUNT(DISTINCT e.session_id),
               COUNT(DISTINCT e.user_id)
          FROM public.analytics_events e
         WHERE e.created_at > now() - INTERVAL '7 days'
        UNION ALL
        SELECT 'month'::TEXT,
               COUNT(DISTINCT e.session_id),
               COUNT(DISTINCT e.user_id)
          FROM public.analytics_events e
         WHERE e.created_at > now() - INTERVAL '30 days';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

GRANT EXECUTE ON FUNCTION public.analytics_unique_counts() TO authenticated;

-- ═══════════════════════════════════════════════════════════════
-- Smoke test (run after applying, as an admin user):
--
--   SELECT * FROM public.analytics_unique_counts();
--
-- Expect three rows (day / week / month) with monotonically
-- non-decreasing unique_visitors and signed_in_users.
-- ═══════════════════════════════════════════════════════════════
