-- ─────────────────────────────────────────────────────────────────────────────
-- supabase-welcome-email-migration.sql
--
-- Adds the welcome-email automation surface:
--
--   * Extends activation_events.event with 'welcome_email_sent'.
--   * Adds it to the unique partial index so the edge function's "send
--     at most once per user" gate is enforced at the DB layer (defense
--     in depth — the edge function also pre-checks).
--   * Refreshes auth_flow_metrics() to surface the welcome-email send
--     count in the admin Onboarding card.
--
-- Idempotent. Safe to re-run alongside the earlier migrations:
--   supabase-class-seats-migration.sql       (created the table + RPCs)
--   supabase-onboarding-events-migration.sql (wizard / tour / demo events)
--
-- The CHECK + unique-index recreation drops + adds rather than ALTERing
-- in place because Postgres doesn't support adding values to a list-style
-- CHECK without a full constraint swap. Existing rows are unaffected
-- because the new constraint is a strict superset.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Recreate the CHECK constraint with the full superset ────────────────
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
        -- Onboarding migration
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
        -- This migration
        'welcome_email_sent'
    ));


-- ── 2. Extend the unique partial index ─────────────────────────────────────
-- Drop and recreate so welcome_email_sent gets the same one-row-per-user
-- guarantee as the other "first_*" events. The edge function's idempotency
-- pre-check is a courtesy; this constraint is the authoritative gate.
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
        'welcome_email_sent'
    );


-- ── 3. Refresh auth_flow_metrics so the welcome_email_sent rate is
--      visible on the admin Onboarding > Auth flow card without a
--      separate fetcher.
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
                     'signin_failed',
                     'returning_user_session',
                     'welcome_email_sent')
       AND created_at > now() - (p_days || ' days')::interval
     GROUP BY event
     ORDER BY event;
$$ LANGUAGE sql SECURITY DEFINER STABLE;

GRANT EXECUTE ON FUNCTION public.auth_flow_metrics(INT) TO authenticated;


-- Smoke test (run after applying):
--   SELECT * FROM public.auth_flow_metrics(30);
--   -- Manually fire a welcome event for yourself and confirm idempotency:
--   SELECT public.log_activation_event('welcome_email_sent', NULL, '{}'::jsonb);
--   SELECT public.log_activation_event('welcome_email_sent', NULL, '{}'::jsonb); -- false (dedupe)
