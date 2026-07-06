-- supabase-retention-depth-migration.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- Retention depth: daily retention curve from signup, DAU/WAU/MAU stickiness,
-- and per-feature return rates. Backs the "Retention Depth" card in
-- admin.html.
--
-- Three RPCs, all SECURITY DEFINER STABLE, all is_admin()-gated, all reading
-- existing tables (activation_events for signup cohorts, analytics_events
-- for return activity + anon traffic + feature use). No schema changes.
--
-- Consent gating notes:
--   - retention_daily_curve cohort source is activation_events.event='signup',
--     and the "active on day N" check reads analytics_events with user_id.
--     Both are consent-gated for anon traffic, but the cohort is signed-in
--     users by construction so consent rate is effectively 100%.
--   - retention_stickiness reports both user_id (signed-in) and visitor_id
--     (anon) DAU/WAU/MAU. Anon numbers are deflated by consent rate. Show
--     them anyway — the trend is what matters for stickiness, not the
--     absolute level.
--   - feature_return_rates reads analytics_events. Same consent caveat
--     applies, biases all features equally so rankings stay valid.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Index: visitor_id stickiness lookups ─────────────────────────────────────
-- The functional index added in supabase-experiment-ab-v2-migration.sql
-- (idx_analytics_events_visitor_id) already covers visitor-id-keyed scans.
-- No new index needed here — stickiness queries match its partial WHERE.


-- ── RPC: retention_daily_curve ───────────────────────────────────────────────
-- Day-N retention for the signup cohort over the past p_cohort_days days.
--   exposed   = # signups at least N+1 days old
--   returned  = # of those who had ANY analytics_events row with their
--               user_id in the (signup+N day, signup+(N+1) day] bucket
-- Day buckets fixed at {1, 2, 3, 7, 14, 28}.
CREATE OR REPLACE FUNCTION public.retention_daily_curve(
    p_cohort_days INTEGER DEFAULT 60
)
RETURNS TABLE (
    day_n     INTEGER,
    exposed   BIGINT,
    returned  BIGINT
) AS $$
DECLARE
    day_buckets INTEGER[] := ARRAY[1, 2, 3, 7, 14, 28];
BEGIN
    IF NOT public.is_admin() THEN
        RAISE EXCEPTION 'forbidden: admin only' USING ERRCODE = '42501';
    END IF;
    p_cohort_days := LEAST(GREATEST(COALESCE(p_cohort_days, 60), 7), 365);

    RETURN QUERY
    WITH signups AS (
        -- First signup event per user pins the cohort start. activation_events
        -- can carry multiple rows per user; DISTINCT ON keeps the earliest.
        SELECT DISTINCT ON (ae.user_id)
               ae.user_id,
               ae.created_at AS signup_at
        FROM public.activation_events ae
        WHERE ae.event = 'signup'
          AND ae.created_at > now() - (p_cohort_days || ' days')::interval
        ORDER BY ae.user_id, ae.created_at
    ),
    cohort AS (
        SELECT s.user_id, s.signup_at, b.day_n
        FROM signups s
        CROSS JOIN unnest(day_buckets) AS b(day_n)
        WHERE s.signup_at <= now() - ((b.day_n + 1) || ' days')::interval
    )
    SELECT c.day_n,
           COUNT(*)::BIGINT AS exposed,
           COUNT(*) FILTER (WHERE EXISTS (
               SELECT 1 FROM public.analytics_events e
               WHERE e.user_id    = c.user_id
                 AND e.created_at >  c.signup_at + (c.day_n     || ' days')::interval
                 AND e.created_at <= c.signup_at + ((c.day_n+1) || ' days')::interval
           ))::BIGINT AS returned
    FROM cohort c
    GROUP BY c.day_n
    ORDER BY c.day_n;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

REVOKE ALL    ON FUNCTION public.retention_daily_curve(INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.retention_daily_curve(INTEGER) TO authenticated;


-- ── RPC: retention_stickiness ────────────────────────────────────────────────
-- Single-row report of DAU / WAU / MAU for both signed-in users and
-- anonymous visitors, plus the DAU/MAU stickiness ratio. "Active" means a
-- row in analytics_events within the trailing N days.
--
-- The standard SaaS read of DAU/MAU stickiness:
--   < 10%  → low engagement, users come back rarely
--   10-20% → healthy
--   > 20%  → strong daily habit (consumer-app territory)
--   > 50%  → exceptional (Slack/Zoom-style)
CREATE OR REPLACE FUNCTION public.retention_stickiness()
RETURNS TABLE (
    dau              BIGINT,
    wau              BIGINT,
    mau              BIGINT,
    anon_dau         BIGINT,
    anon_wau         BIGINT,
    anon_mau         BIGINT,
    stickiness       NUMERIC,
    anon_stickiness  NUMERIC
) AS $$
BEGIN
    IF NOT public.is_admin() THEN
        RAISE EXCEPTION 'forbidden: admin only' USING ERRCODE = '42501';
    END IF;

    RETURN QUERY
    WITH signed AS (
        SELECT
            COUNT(DISTINCT user_id) FILTER (
                WHERE created_at > now() - interval '1 day')  AS dau,
            COUNT(DISTINCT user_id) FILTER (
                WHERE created_at > now() - interval '7 days') AS wau,
            COUNT(DISTINCT user_id) FILTER (
                WHERE created_at > now() - interval '30 days') AS mau
        FROM public.analytics_events
        WHERE user_id IS NOT NULL
          AND created_at > now() - interval '30 days'
    ),
    anon AS (
        SELECT
            COUNT(DISTINCT properties->>'visitor_id') FILTER (
                WHERE created_at > now() - interval '1 day')  AS dau,
            COUNT(DISTINCT properties->>'visitor_id') FILTER (
                WHERE created_at > now() - interval '7 days') AS wau,
            COUNT(DISTINCT properties->>'visitor_id') FILTER (
                WHERE created_at > now() - interval '30 days') AS mau
        FROM public.analytics_events
        WHERE properties->>'visitor_id' IS NOT NULL
          AND created_at > now() - interval '30 days'
    )
    SELECT
        s.dau::BIGINT,
        s.wau::BIGINT,
        s.mau::BIGINT,
        a.dau::BIGINT,
        a.wau::BIGINT,
        a.mau::BIGINT,
        CASE WHEN s.mau > 0 THEN ROUND(s.dau::NUMERIC / s.mau * 100, 2) ELSE NULL END,
        CASE WHEN a.mau > 0 THEN ROUND(a.dau::NUMERIC / a.mau * 100, 2) ELSE NULL END
    FROM signed s, anon a;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

REVOKE ALL    ON FUNCTION public.retention_stickiness() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.retention_stickiness() TO authenticated;


-- ── RPC: feature_return_rates ────────────────────────────────────────────────
-- Per-feature (page_path) return-within-N-days rate. For each top-K page
-- by use volume in the window:
--   first_users  = # distinct visitor_ids whose FIRST use of this page is
--                  in the window AND old enough for the follow-up window
--                  to have elapsed
--   returners    = # of those visitors who used the page AGAIN within
--                  p_window_days after their first use
--   return_rate  = returners / first_users (computed client-side from the
--                  raw counts so the dashboard can render Wilson CIs)
--
-- This is the "second-use rate" for each feature — the cleanest signal for
-- which features actually pull people back vs. which are one-shot tries.
CREATE OR REPLACE FUNCTION public.feature_return_rates(
    p_days        INTEGER DEFAULT 30,
    p_limit       INTEGER DEFAULT 20,
    p_window_days INTEGER DEFAULT 7
)
RETURNS TABLE (
    feature       TEXT,
    first_users   BIGINT,
    returners     BIGINT,
    total_uses    BIGINT
) AS $$
BEGIN
    IF NOT public.is_admin() THEN
        RAISE EXCEPTION 'forbidden: admin only' USING ERRCODE = '42501';
    END IF;
    p_days        := LEAST(GREATEST(COALESCE(p_days, 30), 7), 180);
    p_limit       := LEAST(GREATEST(COALESCE(p_limit, 20), 1), 50);
    p_window_days := LEAST(GREATEST(COALESCE(p_window_days, 7), 1), 30);

    RETURN QUERY
    -- NB: page_path aliased to `page` inside the body to avoid colliding with
    -- the RETURNS TABLE OUT-param `feature` ("column reference is ambiguous").
    WITH uses AS (
        SELECT ae.page_path                  AS page,
               ae.properties->>'visitor_id'  AS vid,
               ae.created_at                 AS created_at
        FROM public.analytics_events ae
        WHERE ae.event_type             = 'page_view'
          AND ae.properties->>'visitor_id' IS NOT NULL
          AND ae.page_path              IS NOT NULL
          AND ae.created_at > now() - (p_days || ' days')::interval
    ),
    first_use AS (
        SELECT DISTINCT ON (u.page, u.vid)
               u.page, u.vid, u.created_at AS first_at
        FROM uses u
        WHERE u.created_at <= now() - (p_window_days || ' days')::interval
        ORDER BY u.page, u.vid, u.created_at
    ),
    top_pages AS (
        SELECT u.page
        FROM uses u
        GROUP BY u.page
        ORDER BY COUNT(*) DESC
        LIMIT p_limit
    ),
    counts AS (
        SELECT f.page,
               COUNT(DISTINCT fu.vid)::BIGINT AS first_users,
               COUNT(DISTINCT fu.vid) FILTER (WHERE EXISTS (
                   SELECT 1 FROM uses u
                   WHERE u.page       = fu.page
                     AND u.vid        = fu.vid
                     AND u.created_at >  fu.first_at
                     AND u.created_at <= fu.first_at + (p_window_days || ' days')::interval
               ))::BIGINT AS returners,
               (SELECT COUNT(*) FROM uses u WHERE u.page = f.page)::BIGINT AS total_uses
        FROM top_pages f
        LEFT JOIN first_use fu ON fu.page = f.page
        GROUP BY f.page
    )
    SELECT c.page AS feature, c.first_users, c.returners, c.total_uses
    FROM counts c
    ORDER BY c.total_uses DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

REVOKE ALL    ON FUNCTION public.feature_return_rates(INTEGER, INTEGER, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.feature_return_rates(INTEGER, INTEGER, INTEGER) TO authenticated;
