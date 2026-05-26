-- supabase-experiment-ab-migration.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- A/B results RPC for the admin dashboard. Reads the `experiment_exposure`
-- and `landing_cta_click` stages that js/experiments.js already writes to
-- client_telemetry (kind = 'auth_funnel'), and returns one row per variant
-- with exposures, CTA-click conversions, and the conversion rate.
--
-- Why client_telemetry and not analytics_events?
--   Same reasoning as supabase-auth-funnel-migration.sql: funnel/exposure
--   events fire before the consent banner is answered, so the consent-gated
--   analytics_events table is blind to most of them. client_telemetry is
--   first-party operational telemetry (no PII, no cookies, no IP) written
--   through the anon-allowed /api/telemetry/log path.
--
-- Variant attribution:
--   A funnel (per-tab UUID) is pinned to the variant of its FIRST
--   `experiment_exposure` row for the experiment. A conversion is that
--   same funnel later emitting `landing_cta_click`. This makes the rate
--   immune to a funnel that somehow logged two arms (it can't — the
--   pp_home_v cookie + experiments.js cookie source keep it stable — but
--   the query is defensive anyway).
--
-- Access: public.is_admin() (admin OR superadmin), matching the admin.html
-- card this backs. Window is clamped to 1..180 days.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Index: experiment-key lookups on exposure rows ───────────────────────────
-- Complements idx_client_telemetry_funnel_stage (stage, created_at) from
-- supabase-auth-funnel-migration.sql. Partial so it stays small.
CREATE INDEX IF NOT EXISTS idx_client_telemetry_experiment
    ON public.client_telemetry ((metadata->>'experiment'), created_at DESC)
    WHERE metadata->>'stage' = 'experiment_exposure';

-- ── RPC: telemetry_experiment_ab_summary ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public.telemetry_experiment_ab_summary(
    p_experiment TEXT,
    p_days       INTEGER DEFAULT 30
)
RETURNS TABLE (
    variant          TEXT,
    exposures        BIGINT,
    conversions      BIGINT,
    conversion_rate  NUMERIC,
    first_seen       TIMESTAMPTZ,
    last_seen        TIMESTAMPTZ
) AS $$
BEGIN
    IF NOT public.is_admin() THEN
        RAISE EXCEPTION 'forbidden: admin only' USING ERRCODE = '42501';
    END IF;
    IF p_experiment IS NULL
       OR length(p_experiment) = 0
       OR length(p_experiment) > 64 THEN
        RAISE EXCEPTION 'invalid experiment key' USING ERRCODE = '22023';
    END IF;
    p_days := LEAST(GREATEST(COALESCE(p_days, 30), 1), 180);

    RETURN QUERY
    -- NB: variant aliased to `arm` inside the body to avoid colliding with
    -- the RETURNS TABLE OUT-param `variant` ("column reference is ambiguous").
    WITH exposure AS (
        -- First exposure per funnel pins it to a single arm.
        SELECT DISTINCT ON (t.metadata->>'funnel_id')
               t.metadata->>'funnel_id' AS fid,
               t.metadata->>'variant'   AS arm,
               t.created_at             AS seen_at
        FROM public.client_telemetry t
        WHERE t.kind = 'auth_funnel'
          AND t.metadata->>'stage'      = 'experiment_exposure'
          AND t.metadata->>'experiment' = p_experiment
          AND t.metadata->>'funnel_id'  IS NOT NULL
          AND t.metadata->>'variant'    IS NOT NULL
          AND t.created_at > now() - (p_days || ' days')::interval
        ORDER BY t.metadata->>'funnel_id', t.created_at
    ),
    converted AS (
        SELECT DISTINCT t.metadata->>'funnel_id' AS fid
        FROM public.client_telemetry t
        WHERE t.kind = 'auth_funnel'
          AND t.metadata->>'stage'     = 'landing_cta_click'
          AND t.metadata->>'funnel_id' IS NOT NULL
          AND t.created_at > now() - (p_days || ' days')::interval
    )
    SELECT
        e.arm                                               AS variant,
        COUNT(*)::BIGINT                                    AS exposures,
        COUNT(*) FILTER (WHERE c.fid IS NOT NULL)::BIGINT   AS conversions,
        ROUND(
            COUNT(*) FILTER (WHERE c.fid IS NOT NULL)::NUMERIC
            / NULLIF(COUNT(*), 0) * 100, 2
        )                                                   AS conversion_rate,
        MIN(e.seen_at)                                      AS first_seen,
        MAX(e.seen_at)                                      AS last_seen
    FROM exposure e
    LEFT JOIN converted c ON c.fid = e.fid
    GROUP BY e.arm
    ORDER BY e.arm;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE
   SET search_path = public, pg_temp;

REVOKE ALL    ON FUNCTION public.telemetry_experiment_ab_summary(TEXT, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.telemetry_experiment_ab_summary(TEXT, INTEGER) TO authenticated;
