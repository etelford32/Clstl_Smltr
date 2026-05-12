-- ═══════════════════════════════════════════════════════════════
-- Parker Physics — Magic-link sign-in telemetry migration
-- ═══════════════════════════════════════════════════════════════
--
-- Run in Supabase Dashboard → SQL Editor → New Query (idempotent).
--
-- Adds the `signin_magic_link_requested` activation event so the
-- admin Auth flow card can show how many users requested a magic
-- link in the window AND derive a "% of signins via magic link"
-- conversion rate alongside the existing signup / signin metrics.
--
-- The activation_events table is the funnel record. Magic-link
-- signin SUCCESSES already log as `signin_succeeded` (with
-- metadata.method = 'magic_link') from auth-callback.html — same
-- code path the OAuth callback uses. The request side needed its
-- own event so we can compute the click-through rate.
-- ═══════════════════════════════════════════════════════════════


-- ── 1. Extend activation_events.event CHECK constraint ──────────────
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_schema    = 'public'
           AND table_name      = 'activation_events'
           AND constraint_name = 'activation_events_event_check'
    ) THEN
        ALTER TABLE public.activation_events
            DROP CONSTRAINT activation_events_event_check;
    END IF;
END $$;

ALTER TABLE public.activation_events
    ADD CONSTRAINT activation_events_event_check
    CHECK (event IN (
        'signup',
        'signup_confirmed',
        'profile_completed',
        'location_saved',
        'first_sim_opened',
        'first_alert_configured',
        'first_email_alert_sent',
        'invite_sent',
        'student_joined',
        'subscription_started',
        'subscription_canceled',
        'subscription_trial_ending',
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
        'signin_magic_link_requested',     -- NEW (this migration)
        'returning_user_session',
        'welcome_email_sent',
        'nudge_sent'
    ));

-- The first-event uniqueness index is on a fixed list and intentionally
-- excludes signin_magic_link_requested — users can request the link
-- multiple times in a session, and each request is a distinct funnel
-- signal worth keeping (e.g., for "% of users who needed a 2nd link"
-- analysis later).


-- ── 2. Refresh auth_flow_metrics() to expose the new event ──────────
-- Same conditional shape as supabase-signup-confirmed-migration.sql:
-- the auth_failures UNION branch is included only if the table
-- exists, so this migration applies cleanly regardless of whether
-- supabase-auth-failures-migration.sql has been run.
DO $do$
BEGIN
    IF to_regclass('public.auth_failures') IS NOT NULL THEN
        EXECUTE $sql$
            CREATE OR REPLACE FUNCTION public.auth_flow_metrics(p_days INT DEFAULT 30)
            RETURNS TABLE(
                event       TEXT,
                user_count  BIGINT,
                event_count BIGINT
            ) AS $body$
                SELECT event,
                       COUNT(DISTINCT user_id)  AS user_count,
                       COUNT(*)                 AS event_count
                  FROM public.activation_events
                 WHERE event IN ('signup',
                                 'signup_confirmed',
                                 'signin_succeeded',
                                 'signin_magic_link_requested',
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
            $body$ LANGUAGE sql SECURITY DEFINER STABLE;
        $sql$;
    ELSE
        RAISE NOTICE 'auth_failures table missing — defining auth_flow_metrics WITHOUT the signin_failed UNION. Apply supabase-auth-failures-migration.sql then re-run this migration to enable it.';
        EXECUTE $sql$
            CREATE OR REPLACE FUNCTION public.auth_flow_metrics(p_days INT DEFAULT 30)
            RETURNS TABLE(
                event       TEXT,
                user_count  BIGINT,
                event_count BIGINT
            ) AS $body$
                SELECT event,
                       COUNT(DISTINCT user_id)  AS user_count,
                       COUNT(*)                 AS event_count
                  FROM public.activation_events
                 WHERE event IN ('signup',
                                 'signup_confirmed',
                                 'signin_succeeded',
                                 'signin_magic_link_requested',
                                 'returning_user_session',
                                 'welcome_email_sent',
                                 'nudge_sent')
                   AND created_at > now() - (p_days || ' days')::interval
                 GROUP BY event
                 ORDER BY event;
            $body$ LANGUAGE sql SECURITY DEFINER STABLE;
        $sql$;
    END IF;
END $do$;

GRANT EXECUTE ON FUNCTION public.auth_flow_metrics(INT) TO authenticated;


-- ═══════════════════════════════════════════════════════════════
-- Verification queries
-- ═══════════════════════════════════════════════════════════════
-- 1. Inserts of the new event type succeed:
--      INSERT INTO public.activation_events (user_id, event, plan, metadata)
--      VALUES (auth.uid(), 'signin_magic_link_requested', NULL,
--              '{"source":"signin_form"}'::jsonb);
--    Expected: success.
--
-- 2. Metrics RPC surfaces it:
--      SELECT * FROM public.auth_flow_metrics(30);
--    Expected: row with event='signin_magic_link_requested'.
--
-- 3. Click-through rate:
--      WITH m AS (SELECT event, user_count
--                    FROM public.auth_flow_metrics(30))
--      SELECT
--        (SELECT user_count FROM m WHERE event='signin_magic_link_requested') AS requested,
--        (SELECT user_count FROM m WHERE event='signin_succeeded')             AS succeeded,
--        ROUND(100.0 *
--          (SELECT user_count FROM m WHERE event='signin_succeeded')
--          / NULLIF((SELECT user_count FROM m WHERE event='signin_magic_link_requested'),0),
--          1) AS pct_of_succeeded_after_request;
--    Sanity check: pct should be ≤ 100 (some users request multiple
--    links before clicking; some never click). Above 100% means the
--    same user is counted once on the request side but multiple times
--    on the success side — investigate.
-- ═══════════════════════════════════════════════════════════════
