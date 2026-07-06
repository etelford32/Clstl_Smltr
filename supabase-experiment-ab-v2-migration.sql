-- supabase-experiment-ab-v2-migration.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- A/B testing v2: per-experiment multi-goal conversion and per-variant
-- retention curves. Backs the "Experiments — Deep View" card in admin.html.
--
-- The original v1 RPC (telemetry_experiment_ab_summary in
-- supabase-experiment-ab-migration.sql) reads client_telemetry — exposure +
-- the single hard-coded landing_cta_click goal — and stays in place for
-- back-compat. These v2 RPCs read analytics_events instead, joining on the
-- new properties->>'visitor_id' field that js/analytics.js stamps onto
-- every event and js/experiments.js stamps onto each exposure.
--
-- Why analytics_events and not client_telemetry?
--   v2 needs to measure (a) arbitrary goal events that already flow through
--   analytics.event() and (b) cross-day retention — i.e. "did this visitor
--   come back N days later for ANY interaction". client_telemetry only
--   captures declared funnel steps; analytics_events captures everything.
--
-- Consent caveat:
--   analytics_events is consent-gated, so the cohort is implicitly
--   consented users. Both exposure and retention numerators read from the
--   same table, so the bias affects all variants equally and the LIFT
--   measurement remains valid — only absolute rates are deflated.
--
-- Visitor id provenance:
--   `pp_vid` is a random opaque UUID stored in localStorage by
--   js/experiments.js, no PII tie. Including it on events is what makes
--   cross-day stitching possible without a server-side user_id.
--
-- Access: public.is_admin() (admin OR superadmin).
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Index: visitor-id lookups across analytics_events ────────────────────────
-- Partial so it only indexes rows that actually carry a visitor_id
-- (rows written before this migration won't have it).
CREATE INDEX IF NOT EXISTS idx_analytics_events_visitor_id
    ON public.analytics_events ((properties->>'visitor_id'), created_at DESC)
    WHERE properties->>'visitor_id' IS NOT NULL;

-- ── Index: experiment-key lookups on exposure events in analytics_events ─────
CREATE INDEX IF NOT EXISTS idx_analytics_events_exp_exposure
    ON public.analytics_events ((properties->>'experiment'), created_at DESC)
    WHERE event_name = 'experiment_exposure'
      AND properties->>'visitor_id' IS NOT NULL;


-- ── RPC: telemetry_experiment_goals_summary ──────────────────────────────────
-- Per-variant × per-goal exposures & conversions for an experiment. The
-- client computes Wilson 95% CI bounds and the two-proportion z-test on
-- the returned counts — keeping the RPC simple and letting the dashboard
-- iterate on stats without a re-deploy.
--
-- Conversion attribution: a visitor counts as converted on goal G if they
-- emitted ANY event with event_name = G *after* their first exposure to
-- the experiment. The same visitor is at most one conversion per
-- (variant, goal) cell — repeat goal events don't inflate the rate.
CREATE OR REPLACE FUNCTION public.telemetry_experiment_goals_summary(
    p_experiment TEXT,
    p_goals      TEXT[],
    p_days       INTEGER DEFAULT 30
)
RETURNS TABLE (
    variant      TEXT,
    goal         TEXT,
    exposures    BIGINT,
    conversions  BIGINT,
    first_seen   TIMESTAMPTZ,
    last_seen    TIMESTAMPTZ
) AS $$
BEGIN
    IF NOT public.is_admin() THEN
        RAISE EXCEPTION 'forbidden: admin only' USING ERRCODE = '42501';
    END IF;
    IF p_experiment IS NULL OR length(p_experiment) = 0 OR length(p_experiment) > 64 THEN
        RAISE EXCEPTION 'invalid experiment key' USING ERRCODE = '22023';
    END IF;
    IF p_goals IS NULL OR array_length(p_goals, 1) IS NULL OR array_length(p_goals, 1) > 20 THEN
        RAISE EXCEPTION 'invalid goals array' USING ERRCODE = '22023';
    END IF;
    p_days := LEAST(GREATEST(COALESCE(p_days, 30), 1), 180);

    RETURN QUERY
    WITH exposures AS (
        -- First exposure per visitor pins them to one arm. DISTINCT ON
        -- by visitor_id keeps the earliest row, so the goal join below
        -- never accidentally counts a goal that happened BEFORE exposure.
        SELECT DISTINCT ON (ae.properties->>'visitor_id')
               ae.properties->>'visitor_id' AS vid,
               ae.properties->>'variant'    AS variant,
               ae.created_at                AS exposed_at
        FROM public.analytics_events ae
        WHERE ae.event_name = 'experiment_exposure'
          AND ae.properties->>'experiment' = p_experiment
          AND ae.properties->>'visitor_id' IS NOT NULL
          AND ae.properties->>'variant'    IS NOT NULL
          AND ae.created_at > now() - (p_days || ' days')::interval
        ORDER BY ae.properties->>'visitor_id', ae.created_at
    ),
    goal_hits AS (
        SELECT e.variant,
               ae.event_name AS goal,
               e.vid
        FROM exposures e
        JOIN public.analytics_events ae
          ON ae.properties->>'visitor_id' = e.vid
         AND ae.created_at > e.exposed_at
         AND ae.event_name = ANY(p_goals)
        GROUP BY e.variant, ae.event_name, e.vid
    )
    SELECT
        e.variant,
        g.goal,
        COUNT(DISTINCT e.vid)::BIGINT          AS exposures,
        COUNT(DISTINCT gh.vid)::BIGINT         AS conversions,
        MIN(e.exposed_at)                      AS first_seen,
        MAX(e.exposed_at)                      AS last_seen
    FROM exposures e
    CROSS JOIN unnest(p_goals) AS g(goal)
    LEFT JOIN goal_hits gh
           ON gh.variant = e.variant AND gh.goal = g.goal AND gh.vid = e.vid
    GROUP BY e.variant, g.goal
    ORDER BY e.variant, g.goal;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

REVOKE ALL    ON FUNCTION public.telemetry_experiment_goals_summary(TEXT, TEXT[], INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.telemetry_experiment_goals_summary(TEXT, TEXT[], INTEGER) TO authenticated;


-- ── RPC: telemetry_experiment_retention ──────────────────────────────────────
-- Per-variant Day-N retention curve. For each day-bucket N in {1,3,7,14,28}
-- we report:
--   exposed       = # distinct visitors exposed at least N+1 days ago
--                   (so the day-N follow-up window has fully elapsed)
--   returned      = # of those visitors who had ANY analytics_events row
--                   in the 24-hour window (T+N day, T+(N+1) day]
--
-- The client computes retention_rate = returned / exposed and Wilson CI.
CREATE OR REPLACE FUNCTION public.telemetry_experiment_retention(
    p_experiment TEXT,
    p_days       INTEGER DEFAULT 60
)
RETURNS TABLE (
    variant   TEXT,
    day_n     INTEGER,
    exposed   BIGINT,
    returned  BIGINT
) AS $$
DECLARE
    day_buckets INTEGER[] := ARRAY[1, 3, 7, 14, 28];
BEGIN
    IF NOT public.is_admin() THEN
        RAISE EXCEPTION 'forbidden: admin only' USING ERRCODE = '42501';
    END IF;
    IF p_experiment IS NULL OR length(p_experiment) = 0 OR length(p_experiment) > 64 THEN
        RAISE EXCEPTION 'invalid experiment key' USING ERRCODE = '22023';
    END IF;
    p_days := LEAST(GREATEST(COALESCE(p_days, 60), 30), 180);

    RETURN QUERY
    -- NB: variant aliased to `arm` inside the body to avoid colliding with
    -- the RETURNS TABLE OUT-param `variant` ("column reference is ambiguous").
    WITH exposures AS (
        SELECT DISTINCT ON (ae.properties->>'visitor_id')
               ae.properties->>'visitor_id' AS vid,
               ae.properties->>'variant'    AS arm,
               ae.created_at                AS exposed_at
        FROM public.analytics_events ae
        WHERE ae.event_name = 'experiment_exposure'
          AND ae.properties->>'experiment' = p_experiment
          AND ae.properties->>'visitor_id' IS NOT NULL
          AND ae.properties->>'variant'    IS NOT NULL
          AND ae.created_at > now() - (p_days || ' days')::interval
        ORDER BY ae.properties->>'visitor_id', ae.created_at
    ),
    cohort AS (
        SELECT e.arm, b.bucket_n AS day_n, e.vid, e.exposed_at
        FROM exposures e
        CROSS JOIN unnest(day_buckets) AS b(bucket_n)
        -- Need a full follow-up window to score the bucket fairly: a
        -- visitor exposed yesterday can't possibly be a Day-7 returner.
        WHERE e.exposed_at <= now() - ((b.bucket_n + 1) || ' days')::interval
    ),
    returns AS (
        SELECT c.arm,
               c.day_n,
               COUNT(*)::BIGINT AS exposed,
               COUNT(*) FILTER (WHERE EXISTS (
                   SELECT 1
                   FROM public.analytics_events ae
                   WHERE ae.properties->>'visitor_id' = c.vid
                     AND ae.created_at >  c.exposed_at + (c.day_n     || ' days')::interval
                     AND ae.created_at <= c.exposed_at + ((c.day_n+1) || ' days')::interval
               ))::BIGINT AS returned
        FROM cohort c
        GROUP BY c.arm, c.day_n
    )
    SELECT r.arm AS variant, r.day_n, r.exposed, r.returned
    FROM returns r
    ORDER BY r.arm, r.day_n;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

REVOKE ALL    ON FUNCTION public.telemetry_experiment_retention(TEXT, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.telemetry_experiment_retention(TEXT, INTEGER) TO authenticated;
