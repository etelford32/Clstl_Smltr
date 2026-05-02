-- ─────────────────────────────────────────────────────────────────────────────
-- supabase-onboarding-events-migration.sql
--
-- Extends public.activation_events with the event types needed to measure
-- the new onboarding surface (welcome wizard, demo mode, guided tour) and
-- the auth flow (signin success/failure). Adds:
--
--   * wizard_shown, wizard_step_completed, wizard_skipped, wizard_completed
--   * tour_started, tour_completed, tour_skipped
--   * demo_entered, demo_signup_clicked
--   * signin_succeeded, signin_failed
--   * returning_user_session  (fired on the first dashboard render of a
--                              session for a user whose previous activity
--                              is > 24 h old)
--
-- Also installs three RPCs the admin dashboard's Onboarding section
-- consumes:
--   * onboarding_funnel(p_days INT)        — wizard step funnel + drop-off
--   * tour_metrics(p_days INT)             — start / complete / skip rates
--   * auth_flow_metrics(p_days INT)        — signup / signin success rates
--
-- Idempotent. Safe to re-run. Mirrors the JS allow-list in
-- js/activation.js — keep the two in lockstep.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Drop + recreate the CHECK constraint with the expanded event set ────
-- Postgres won't let us "ALTER ... ADD CHECK" on an existing constraint
-- with the same name; the only way to add new allowed values is to drop
-- and recreate. Existing rows are unaffected because the new constraint
-- is a strict superset of the old one.

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_schema = 'public'
           AND table_name   = 'activation_events'
           AND constraint_name = 'activation_events_event_check'
    ) THEN
        ALTER TABLE public.activation_events
            DROP CONSTRAINT activation_events_event_check;
    END IF;
END $$;

ALTER TABLE public.activation_events
    ADD CONSTRAINT activation_events_event_check
    CHECK (event IN (
        -- Original (pre-onboarding) events. KEEP THESE.
        'signup',
        'profile_completed',
        'location_saved',
        'first_sim_opened',
        'first_alert_configured',
        'first_email_alert_sent',
        'invite_sent',
        'student_joined',
        'subscription_started',
        'subscription_canceled',
        -- Welcome wizard
        'wizard_shown',
        'wizard_step_completed',
        'wizard_skipped',
        'wizard_completed',
        -- Guided tour (js/onboarding-tour.js)
        'tour_started',
        'tour_completed',
        'tour_skipped',
        -- Anonymous demo path
        'demo_entered',
        'demo_signup_clicked',
        -- Auth flow telemetry
        'signin_succeeded',
        'signin_failed',
        'returning_user_session'
    ));


-- ── 2. Funnel RPC: wizard step drop-off ─────────────────────────────────────
-- Reports, for each wizard event, the number of distinct users that hit it
-- in the window. Frontend computes the drop-off rates from these counts.

CREATE OR REPLACE FUNCTION public.onboarding_funnel(p_days INT DEFAULT 30)
RETURNS TABLE(
    event       TEXT,
    user_count  BIGINT
) AS $$
    SELECT event, COUNT(DISTINCT user_id) AS user_count
      FROM public.activation_events
     WHERE event IN ('wizard_shown', 'wizard_step_completed',
                     'wizard_completed', 'wizard_skipped')
       AND created_at > now() - (p_days || ' days')::interval
     GROUP BY event
     ORDER BY event;
$$ LANGUAGE sql SECURITY DEFINER STABLE;

GRANT EXECUTE ON FUNCTION public.onboarding_funnel(INT) TO authenticated;


-- ── 3. Tour metrics RPC ─────────────────────────────────────────────────────
-- Distinct users who started, completed, or skipped the guided tour.

CREATE OR REPLACE FUNCTION public.tour_metrics(p_days INT DEFAULT 30)
RETURNS TABLE(
    event       TEXT,
    user_count  BIGINT
) AS $$
    SELECT event, COUNT(DISTINCT user_id) AS user_count
      FROM public.activation_events
     WHERE event IN ('tour_started', 'tour_completed', 'tour_skipped')
       AND created_at > now() - (p_days || ' days')::interval
     GROUP BY event
     ORDER BY event;
$$ LANGUAGE sql SECURITY DEFINER STABLE;

GRANT EXECUTE ON FUNCTION public.tour_metrics(INT) TO authenticated;


-- ── 4. Auth flow RPC ────────────────────────────────────────────────────────
-- Counts of successful + failed signins, signups, and returning-user
-- sessions. Useful for catching auth regressions without opening Supabase
-- logs.

CREATE OR REPLACE FUNCTION public.auth_flow_metrics(p_days INT DEFAULT 30)
RETURNS TABLE(
    event       TEXT,
    user_count  BIGINT,
    event_count BIGINT
) AS $$
    SELECT event,
           COUNT(DISTINCT user_id)  AS user_count,
           COUNT(*)                 AS event_count
      FROM public.activation_events
     WHERE event IN ('signup', 'signin_succeeded', 'signin_failed',
                     'returning_user_session')
       AND created_at > now() - (p_days || ' days')::interval
     GROUP BY event
     ORDER BY event;
$$ LANGUAGE sql SECURITY DEFINER STABLE;

GRANT EXECUTE ON FUNCTION public.auth_flow_metrics(INT) TO authenticated;


-- ── 5. New vs returning users RPC ───────────────────────────────────────────
-- "New" = first activation event in the window is recent (signup
-- happened inside the window). "Returning" = signed up before the window
-- and has any event inside it.

CREATE OR REPLACE FUNCTION public.new_vs_returning(p_days INT DEFAULT 30)
RETURNS TABLE(
    bucket      TEXT,
    user_count  BIGINT
) AS $$
    WITH signups AS (
        SELECT user_id, MIN(created_at) AS first_at
          FROM public.activation_events
         WHERE event = 'signup'
         GROUP BY user_id
    ),
    active AS (
        SELECT DISTINCT user_id
          FROM public.activation_events
         WHERE created_at > now() - (p_days || ' days')::interval
    )
    SELECT CASE
               WHEN s.first_at > now() - (p_days || ' days')::interval THEN 'new'
               ELSE 'returning'
           END AS bucket,
           COUNT(*) AS user_count
      FROM active a
      LEFT JOIN signups s USING (user_id)
     GROUP BY 1;
$$ LANGUAGE sql SECURITY DEFINER STABLE;

GRANT EXECUTE ON FUNCTION public.new_vs_returning(INT) TO authenticated;


-- Smoke test (run after applying):
--   SELECT * FROM public.onboarding_funnel(30);
--   SELECT * FROM public.tour_metrics(30);
--   SELECT * FROM public.auth_flow_metrics(30);
--   SELECT * FROM public.new_vs_returning(30);
