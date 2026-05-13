-- supabase-auth-funnel-dropoffs-migration.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- Adds an "auth funnel drop-offs" RPC so the admin Onboarding tab can answer
-- the only question that matters when a user files a "sign-in is broken"
-- ticket: where did the most recent failures stall?
--
-- Method:
--   For each funnel_id in the window, find its LATEST auth_funnel stage.
--   Exclude funnels whose latest stage is a known success terminal
--   (signin_succeeded, auth_callback_succeeded, signup_succeeded) and
--   funnels that are clearly still in-flight (last event < grace seconds
--   ago — keeps a user mid-form from showing up as a drop-off).
--   Return the remaining funnels ordered by last_seen DESC.
--
-- This is intentionally narrow — it shows individual session journeys, not
-- aggregate counts, so an operator can copy a funnel_id and feed it to
-- telemetry_auth_funnel_replay() for a stage-by-stage replay.
--
-- Idempotent. Re-run safe.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.telemetry_auth_funnel_dropoffs(
    p_days        INTEGER DEFAULT 7,
    p_limit       INTEGER DEFAULT 50,
    p_grace_secs  INTEGER DEFAULT 120   -- ignore funnels whose last event is fresher than this
)
RETURNS TABLE (
    funnel_id   TEXT,
    last_stage  TEXT,
    last_reason TEXT,
    last_code   TEXT,
    last_route  TEXT,
    last_method TEXT,
    last_provider TEXT,
    last_seen   TIMESTAMPTZ,
    stage_count BIGINT
) AS $$
BEGIN
    IF NOT public.is_superadmin() THEN
        RAISE EXCEPTION 'forbidden: superadmin only' USING ERRCODE = '42501';
    END IF;
    p_days       := LEAST(GREATEST(COALESCE(p_days, 7), 1), 90);
    p_limit      := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 500);
    p_grace_secs := LEAST(GREATEST(COALESCE(p_grace_secs, 120), 0), 3600);

    RETURN QUERY
    WITH window_rows AS (
        SELECT
            (t.metadata->>'funnel_id')::text AS funnel_id,
            (t.metadata->>'stage')::text     AS stage,
            t.metadata,
            t.route,
            t.created_at
        FROM public.client_telemetry t
        WHERE t.kind = 'auth_funnel'
          AND t.created_at > now() - (p_days || ' days')::interval
          AND t.metadata->>'funnel_id' IS NOT NULL
          AND t.metadata->>'stage'     IS NOT NULL
    ),
    latest AS (
        -- One row per funnel_id: the most recent stage event observed.
        SELECT DISTINCT ON (w.funnel_id)
            w.funnel_id,
            w.stage,
            w.metadata,
            w.route,
            w.created_at
        FROM window_rows w
        ORDER BY w.funnel_id, w.created_at DESC
    ),
    counts AS (
        SELECT funnel_id, COUNT(*)::BIGINT AS stage_count
        FROM window_rows
        GROUP BY funnel_id
    )
    SELECT
        l.funnel_id,
        l.stage                                        AS last_stage,
        LEFT(COALESCE(l.metadata->>'reason', ''), 200) AS last_reason,
        LEFT(COALESCE(l.metadata->>'code',   ''),  80) AS last_code,
        l.route                                        AS last_route,
        LEFT(COALESCE(l.metadata->>'method', ''),  40) AS last_method,
        LEFT(COALESCE(l.metadata->>'provider', ''),40) AS last_provider,
        l.created_at                                   AS last_seen,
        c.stage_count
    FROM latest l
    JOIN counts c USING (funnel_id)
    WHERE l.stage NOT IN (
            'signin_succeeded',
            'auth_callback_succeeded',
            'signup_succeeded',
            'signin_already_signed_in',
            'signup_already_signed_in',
            'auth_callback_signup'
        )
      AND l.created_at < now() - (p_grace_secs || ' seconds')::interval
    ORDER BY l.created_at DESC
    LIMIT p_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

REVOKE ALL ON FUNCTION public.telemetry_auth_funnel_dropoffs(INTEGER, INTEGER, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.telemetry_auth_funnel_dropoffs(INTEGER, INTEGER, INTEGER) TO authenticated;

-- ── Smoke test ───────────────────────────────────────────────────────────
-- As a superadmin:
--   SELECT * FROM public.telemetry_auth_funnel_dropoffs(7, 50, 120);
-- Expect rows ordered newest-first, none ending in *_succeeded, none
-- with last_seen < 2 minutes old.
