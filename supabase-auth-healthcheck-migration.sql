-- ─────────────────────────────────────────────────────────────────────────────
-- supabase-auth-healthcheck-migration.sql
--
-- Storage + admin read surface for the daily synthetic sign-in health check
-- (api/cron/auth-healthcheck.js).
--
-- The cron signs a dedicated test account into Supabase once a day, confirms
-- the session can read its own user_profiles row (i.e. a signed-in user can
-- actually reach gated data), probes that the Google OAuth provider is still
-- enabled, and records the result here. The existing pipeline-watchdog cron
-- handles streak-based email alerting via record_pipeline_success/failure
-- against the shared pipeline_heartbeat table (pipeline name 'auth_signin'),
-- so this migration only adds the rich per-run history + the admin read RPC.
--
-- Apply:  psql "$SUPABASE_DB_URL" -f supabase-auth-healthcheck-migration.sql
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Per-run log ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.auth_healthcheck_log (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ran_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    source        TEXT        NOT NULL DEFAULT 'cron',   -- cron | manual
    ok            BOOLEAN     NOT NULL,                  -- overall verdict
    password_ok   BOOLEAN,                               -- email+password sign-in minted a session
    profile_ok    BOOLEAN,                               -- signed-in user could read its own profile (RLS)
    google_ok     BOOLEAN,                               -- Google OAuth provider enabled in Auth settings
    magiclink_ok  BOOLEAN,                               -- magic-link/OTP path alive (NULL when probe disabled)
    latency_ms    INTEGER,                               -- end-to-end wall time of the run
    detail        JSONB       NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS auth_healthcheck_log_ran_at_idx
    ON public.auth_healthcheck_log (ran_at DESC);

-- Service-role-only table. Written by the cron with the service key (which
-- bypasses RLS); read by admins through the SECURITY DEFINER summary RPC
-- below. RLS is ON with NO policies on purpose — same pattern as forecast_log
-- and solar_wind_samples. Adding a permissive policy would expose internal
-- ops timing to anon/authenticated. (See CLAUDE.md §4.2.)
ALTER TABLE public.auth_healthcheck_log ENABLE ROW LEVEL SECURITY;

-- ── Admin read: latest verdict + recent pass-rate ─────────────────────────────
-- SECURITY DEFINER so an admin's authenticated JWT can read the service-role
-- table; gated by public.is_admin() so only admins/superadmins get rows.
-- Returns a single summary row (or zero rows for non-admins / no data).
CREATE OR REPLACE FUNCTION public.auth_healthcheck_summary(p_limit INT DEFAULT 30)
RETURNS TABLE(
    last_ran_at        TIMESTAMPTZ,
    last_ok            BOOLEAN,
    last_password_ok   BOOLEAN,
    last_profile_ok    BOOLEAN,
    last_google_ok     BOOLEAN,
    last_magiclink_ok  BOOLEAN,
    last_latency_ms    INTEGER,
    last_detail        JSONB,
    runs               BIGINT,
    passes             BIGINT,
    pass_rate          NUMERIC
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    WITH recent AS (
        SELECT *
          FROM public.auth_healthcheck_log
         ORDER BY ran_at DESC
         LIMIT GREATEST(p_limit, 1)
    ),
    latest AS (
        SELECT * FROM recent ORDER BY ran_at DESC LIMIT 1
    )
    SELECT
        l.ran_at,
        l.ok,
        l.password_ok,
        l.profile_ok,
        l.google_ok,
        l.magiclink_ok,
        l.latency_ms,
        l.detail,
        (SELECT count(*) FROM recent)                              AS runs,
        (SELECT count(*) FILTER (WHERE ok) FROM recent)            AS passes,
        ROUND(
            100.0 * (SELECT count(*) FILTER (WHERE ok) FROM recent)
                  / GREATEST((SELECT count(*) FROM recent), 1)
        , 1)                                                       AS pass_rate
      FROM latest l
     WHERE public.is_admin();
$$;

-- Only signed-in admins call this from the dashboard. Lock out anon outright;
-- the is_admin() gate inside handles the authenticated-but-not-admin case.
REVOKE ALL ON FUNCTION public.auth_healthcheck_summary(INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.auth_healthcheck_summary(INT) TO authenticated;

-- ── Seed a heartbeat row so the pipeline-watchdog + admin heartbeat card
--    show 'auth_signin' immediately, before the first cron run. Idempotent.
INSERT INTO public.pipeline_heartbeat (pipeline_name, last_success_at, consecutive_fail)
VALUES ('auth_signin', now(), 0)
ON CONFLICT (pipeline_name) DO NOTHING;
