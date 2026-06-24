-- ─────────────────────────────────────────────────────────────────────────────
-- supabase-synthetic-auth-migration.sql
--
-- Storage + admin read surface for the Tier-1 synthetic auth robots
-- (api/cron/synthetic-auth-daily.js and, later, the weekly journey robot).
--
-- Each robot run creates a THROWAWAY user, drives it through a real flow
-- (signup → login → profile/RLS → upgrade …), asserts the outcome, then
-- deletes the user + its activation_events so nothing pollutes real metrics.
-- The per-run verdict + per-step detail land here.
--
-- Applied to project aijsboodkivnhzfstvdq via MCP; this file is the
-- version-controlled copy.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Per-run log ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.synthetic_journey_log (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ran_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    journey     TEXT        NOT NULL,             -- daily_free | weekly_full | weekly_direct_basic | weekly_direct_advanced
    source      TEXT        NOT NULL DEFAULT 'cron',
    ok          BOOLEAN     NOT NULL,             -- overall verdict
    steps       JSONB       NOT NULL DEFAULT '[]'::jsonb,   -- [{name, ok, ms, detail}]
    latency_ms  INTEGER,
    detail      JSONB       NOT NULL DEFAULT '{}'::jsonb    -- summary / first failure / cleanup notes
);

CREATE INDEX IF NOT EXISTS synthetic_journey_log_journey_ran_idx
    ON public.synthetic_journey_log (journey, ran_at DESC);

-- Service-role-only table: written by the cron with the service key (bypasses
-- RLS), read by admins through the SECURITY DEFINER summary RPC below. RLS ON
-- with NO policies — same pattern as forecast_log / solar_wind_samples.
ALTER TABLE public.synthetic_journey_log ENABLE ROW LEVEL SECURITY;

-- ── Admin read: latest verdict + recent pass-rate, per journey ────────────────
CREATE OR REPLACE FUNCTION public.synthetic_journey_summary(p_limit INT DEFAULT 20)
RETURNS TABLE(
    journey         TEXT,
    last_ran_at     TIMESTAMPTZ,
    last_ok         BOOLEAN,
    last_latency_ms INTEGER,
    last_steps      JSONB,
    last_detail     JSONB,
    runs            BIGINT,
    passes          BIGINT,
    pass_rate       NUMERIC
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    WITH recent AS (
        SELECT l.*,
               row_number() OVER (PARTITION BY l.journey ORDER BY l.ran_at DESC) AS rn
          FROM public.synthetic_journey_log l
    ),
    capped AS (
        SELECT * FROM recent WHERE rn <= GREATEST(p_limit, 1)
    )
    SELECT
        c.journey,
        (SELECT ran_at     FROM capped x WHERE x.journey = c.journey AND x.rn = 1),
        (SELECT ok         FROM capped x WHERE x.journey = c.journey AND x.rn = 1),
        (SELECT latency_ms FROM capped x WHERE x.journey = c.journey AND x.rn = 1),
        (SELECT steps      FROM capped x WHERE x.journey = c.journey AND x.rn = 1),
        (SELECT detail     FROM capped x WHERE x.journey = c.journey AND x.rn = 1),
        count(*)                          AS runs,
        count(*) FILTER (WHERE c.ok)      AS passes,
        ROUND(100.0 * count(*) FILTER (WHERE c.ok) / GREATEST(count(*), 1), 1) AS pass_rate
      FROM capped c
     WHERE public.is_admin()
     GROUP BY c.journey;
$$;

REVOKE ALL ON FUNCTION public.synthetic_journey_summary(INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.synthetic_journey_summary(INT) TO authenticated;

-- ── Seed heartbeat rows so the pipeline-watchdog + admin heartbeat card show
--    the robots immediately, before their first run. Idempotent.
INSERT INTO public.pipeline_heartbeat (pipeline_name, last_success_at, consecutive_fail)
VALUES ('synthetic_auth_daily', now(), 0)
ON CONFLICT (pipeline_name) DO NOTHING;

INSERT INTO public.pipeline_heartbeat (pipeline_name, last_success_at, consecutive_fail)
VALUES ('synthetic_auth_weekly', now(), 0)
ON CONFLICT (pipeline_name) DO NOTHING;
