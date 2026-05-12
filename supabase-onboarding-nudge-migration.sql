-- ─────────────────────────────────────────────────────────────────────────────
-- supabase-onboarding-nudge-migration.sql
--
-- T+24h onboarding-nudge automation. Adds the schema + RPC the daily
-- cron at /api/cron/onboarding-nudge needs:
--
--   * 'nudge_sent' added to activation_events.event allow-list and
--     to the unique partial index — the cron is idempotent at the
--     DB layer; double-runs can never produce two emails per user.
--   * pending_onboarding_nudges(p_min_hours, p_max_days) RPC: returns
--     the (user_id, email, display_name, plan) tuples that have a
--     'signup' event between p_min_hours and p_max_days ago AND
--     no 'wizard_completed' AND no 'nudge_sent'. The cron passes
--     defaults (24h, 7d) so we don't nudge ancient stale signups.
--   * Refreshed auth_flow_metrics to include 'nudge_sent' in the
--     event filter so the admin Onboarding > Auth flow card shows
--     send count + per-signup ratio without a separate fetcher.
--
-- Idempotent. Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Recreate the CHECK constraint with the full superset ───────────────
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
        -- Original event set
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
        -- Onboarding
        'wizard_shown',
        'wizard_step_completed',
        'wizard_skipped',
        'wizard_completed',
        'tour_started',
        'tour_completed',
        'tour_skipped',
        'demo_entered',
        'demo_signup_clicked',
        'signin_succeeded',
        'signin_failed',
        'returning_user_session',
        -- Lifecycle email automation
        'welcome_email_sent',
        'nudge_sent'
    ));


-- ── 2. Refresh the unique partial index ───────────────────────────────────
-- nudge_sent is one-shot per user (we don't want to spam users who
-- skipped the wizard on purpose). The index is the authoritative gate;
-- the cron's pre-filter is a courtesy.
DROP INDEX IF EXISTS public.uq_activation_events_first;

CREATE UNIQUE INDEX uq_activation_events_first
    ON public.activation_events(user_id, event)
    WHERE event IN (
        'signup',
        'profile_completed',
        'location_saved',
        'first_sim_opened',
        'first_alert_configured',
        'first_email_alert_sent',
        'welcome_email_sent',
        'nudge_sent'
    );


-- ── 3. pending_onboarding_nudges RPC ──────────────────────────────────────
-- Returns one row per user who needs a nudge today. SECURITY DEFINER
-- so the cron (running with the service-role key but no auth.uid())
-- can read auth.users for the email — the edge function then renders
-- the email + sends via Resend + logs nudge_sent.
--
-- Eligibility:
--   * user signed up between p_min_hours ago and p_max_days ago
--   * user does NOT have a wizard_completed event (they skipped or
--     never opened the wizard)
--   * user does NOT have a nudge_sent event yet (idempotency belt;
--     suspenders is the unique index above)
--   * auth.users.email is non-null AND confirmed (no nudges to
--     unverified or deleted accounts)
--
-- The nudge fires regardless of plan — even paid signups can drop
-- the wizard mid-step, and getting them back into setup is at least
-- as valuable as the free-tier case.

CREATE OR REPLACE FUNCTION public.pending_onboarding_nudges(
    p_min_hours INT DEFAULT 24,
    p_max_days  INT DEFAULT 7,
    p_limit     INT DEFAULT 200
) RETURNS TABLE(
    user_id      UUID,
    email        TEXT,
    display_name TEXT,
    plan         TEXT,
    signed_up_at TIMESTAMPTZ
) AS $$
    SELECT
        s.user_id,
        au.email,
        COALESCE(up.display_name, split_part(au.email, '@', 1)) AS display_name,
        COALESCE(up.plan, 'free')                                AS plan,
        s.created_at                                             AS signed_up_at
      FROM public.activation_events s
      JOIN auth.users      au ON au.id = s.user_id
      LEFT JOIN public.user_profiles up ON up.id = s.user_id
     WHERE s.event = 'signup'
       AND s.created_at < now() - (p_min_hours || ' hours')::interval
       AND s.created_at > now() - (p_max_days || ' days')::interval
       AND au.email IS NOT NULL
       AND au.email_confirmed_at IS NOT NULL
       AND NOT EXISTS (
            SELECT 1 FROM public.activation_events x
             WHERE x.user_id = s.user_id
               AND x.event   = 'wizard_completed'
       )
       AND NOT EXISTS (
            SELECT 1 FROM public.activation_events x
             WHERE x.user_id = s.user_id
               AND x.event   = 'nudge_sent'
       )
     ORDER BY s.created_at ASC
     LIMIT p_limit;
$$ LANGUAGE sql SECURITY DEFINER STABLE;

REVOKE ALL ON FUNCTION public.pending_onboarding_nudges(INT, INT, INT) FROM PUBLIC;
-- Service-role calls bypass GRANTs; no need to GRANT to authenticated.


-- ── 4. Refresh auth_flow_metrics() to include nudge_sent ──────────────────
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
     WHERE event IN ('signup',
                     'signin_succeeded',
                     'returning_user_session',
                     'welcome_email_sent',
                     'nudge_sent')
       AND created_at > now() - (p_days || ' days')::interval
     GROUP BY event
    UNION ALL
    SELECT 'signin_failed'                  AS event,
           COUNT(DISTINCT email_hash)       AS user_count,
           COUNT(*)                         AS event_count
      FROM public.auth_failures
     WHERE created_at > now() - (p_days || ' days')::interval
    ORDER BY event;
$$ LANGUAGE sql SECURITY DEFINER STABLE;

GRANT EXECUTE ON FUNCTION public.auth_flow_metrics(INT) TO authenticated;


-- Smoke test (run after applying):
--   -- Should list users who signed up >24h ago and never finished the wizard.
--   SELECT * FROM public.pending_onboarding_nudges(24, 7, 50);
--   -- After the cron runs, the same query returns fewer rows — anyone
--   -- it nudged now has a 'nudge_sent' row that excludes them.
--   SELECT * FROM public.auth_flow_metrics(30);
