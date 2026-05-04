-- ═══════════════════════════════════════════════════════════════
-- Parker Physics — signup_confirmed activation event migration
-- ═══════════════════════════════════════════════════════════════
--
-- Run in Supabase Dashboard → SQL Editor → New Query (idempotent).
--
-- Closes the email-confirmation telemetry hole identified in the
-- April 2026 auth-flow audit:
--
--   Today: signup.html logs 'signup' on the auto-confirm branch only.
--          When Supabase requires email confirmation, the success view
--          shows "Check your email" and the user navigates away —
--          no 'signup' event ever fires. The funnel under-counts
--          email-gated sign-ups by however many of them never click
--          the link AND by every email-gated user generally (we have
--          no signal at all on whether they confirmed).
--
--   After: an AFTER trigger on auth.users captures the moment
--          confirmed_at transitions from NULL → NOT NULL (or arrives
--          already-set on INSERT, the auto-confirm + OAuth case).
--          Two activation events are upserted:
--            * 'signup'           — guarantees every confirmed user
--                                    appears in the funnel base, even
--                                    if the client-side log dropped.
--            * 'signup_confirmed' — distinguishes confirmed-via-email
--                                    accounts from the auto-confirm
--                                    population for forensics.
--
-- Both inserts use ON CONFLICT DO NOTHING against the existing
-- uq_activation_events_first partial index, so the trigger is safe to
-- run alongside the client-side log without double-counting.
--
-- Idempotent — safe to re-run. Doesn't backfill historical events
-- (the trigger only fires on new INSERT/UPDATE activity).
-- ═══════════════════════════════════════════════════════════════


-- ── 1. Extend activation_events.event CHECK constraint ──────────────
-- Drop + re-add (the event check is the only way to add new allowed
-- values; rows that already exist are unaffected because the new
-- list is a strict superset).
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
        'signup_confirmed',          -- NEW (this migration)
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
        'returning_user_session',
        'welcome_email_sent',
        'nudge_sent'
    ));


-- ── 2. Extend the first-event unique partial index ──────────────────
-- 'signup_confirmed' is a once-per-user event by definition (Supabase
-- never un-confirms a user), so it joins the dedup list. The trigger
-- below relies on this for ON CONFLICT DO NOTHING.
DROP INDEX IF EXISTS public.uq_activation_events_first;
CREATE UNIQUE INDEX uq_activation_events_first
    ON public.activation_events(user_id, event)
    WHERE event IN (
        'signup',
        'signup_confirmed',          -- NEW (this migration)
        'profile_completed',
        'location_saved',
        'first_sim_opened',
        'first_alert_configured',
        'first_email_alert_sent',
        'welcome_email_sent',
        'nudge_sent'
    );


-- ── 3. Trigger function — fires on confirmation completion ──────────
-- Three scenarios it has to cover:
--
--   A. Email/password, auto-confirm OFF (the email-gate case):
--      INSERT auth.users with confirmed_at = NULL → no event yet.
--      Later, UPDATE auth.users SET confirmed_at = now() when the
--      user clicks the link → trigger fires (UPDATE branch), inserts
--      both 'signup' and 'signup_confirmed'.
--
--   B. Email/password, auto-confirm ON:
--      INSERT auth.users with confirmed_at = now() → trigger fires
--      (INSERT branch), inserts both events. The client-side log of
--      'signup' from signup.html is harmless (ON CONFLICT DO NOTHING).
--
--   C. OAuth (Google / Apple):
--      INSERT auth.users with confirmed_at = now() (provider-asserted
--      email) → INSERT branch, same as B. The client-side log fires
--      from auth-callback.html with the same dedup behaviour.
--
-- Provider attribution is captured from raw_app_meta_data->>'provider'
-- so the funnel can slice signup_confirmed by 'email' / 'google' /
-- 'apple' in the future without a schema change.
CREATE OR REPLACE FUNCTION public.log_signup_confirmation()
RETURNS TRIGGER AS $$
DECLARE
    v_provider TEXT;
    v_path     TEXT;
BEGIN
    -- INSERT branch — confirmed_at already set at row creation
    IF TG_OP = 'INSERT' THEN
        IF NEW.confirmed_at IS NULL THEN
            RETURN NEW;  -- email-gate case; wait for the UPDATE
        END IF;
        v_path := CASE
            WHEN NEW.raw_app_meta_data->>'provider' IS NOT NULL
                 AND NEW.raw_app_meta_data->>'provider' <> 'email'
                THEN 'oauth_immediate'
            ELSE 'auto_confirm'
        END;
    -- UPDATE branch — confirmed_at just transitioned NULL → NOT NULL
    ELSIF TG_OP = 'UPDATE' THEN
        IF OLD.confirmed_at IS NOT NULL OR NEW.confirmed_at IS NULL THEN
            RETURN NEW;  -- already counted, or still pending
        END IF;
        v_path := 'email_link';
    ELSE
        RETURN NEW;
    END IF;

    v_provider := COALESCE(NEW.raw_app_meta_data->>'provider', 'email');

    -- Backfill 'signup' if the client-side log dropped (the email-gate
    -- case never fires it from the browser). Dedup via the unique
    -- partial index is authoritative; the rare race with a concurrent
    -- client-side log is handled by ON CONFLICT DO NOTHING.
    INSERT INTO public.activation_events (user_id, event, plan, metadata)
    VALUES (
        NEW.id, 'signup', NULL,
        jsonb_build_object(
            'source',   'trigger_signup_confirmed',
            'provider', v_provider,
            'path',     v_path
        )
    )
    ON CONFLICT DO NOTHING;

    -- The new signal: explicit "they confirmed" event.
    INSERT INTO public.activation_events (user_id, event, plan, metadata)
    VALUES (
        NEW.id, 'signup_confirmed', NULL,
        jsonb_build_object(
            'provider', v_provider,
            'path',     v_path
        )
    )
    ON CONFLICT DO NOTHING;

    RETURN NEW;
EXCEPTION
    -- The trigger MUST NOT fail the underlying auth.users mutation.
    -- A constraint violation, RLS hiccup, or anything else here gets
    -- swallowed so confirmation completes regardless of telemetry.
    WHEN OTHERS THEN
        RAISE WARNING 'log_signup_confirmation: % (sqlstate %)', SQLERRM, SQLSTATE;
        RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- ── 4. Wire the trigger on auth.users ───────────────────────────────
-- Sorts after `on_auth_user_created` (the handle_new_user trigger that
-- creates the user_profiles row), so by the time we run the row exists
-- in user_profiles. Both triggers are AFTER, so neither blocks the
-- mutation.
DROP TRIGGER IF EXISTS on_auth_user_confirmed ON auth.users;
CREATE TRIGGER on_auth_user_confirmed
    AFTER INSERT OR UPDATE OF confirmed_at ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.log_signup_confirmation();


-- ── 5. Refresh auth_flow_metrics() to expose signup_confirmed ───────
-- Widens the event allow-list so the admin Auth flow card can compute
-- a confirmation rate alongside signup / signin counts.
--
-- The UNION-with-auth_failures branch is conditional on the
-- auth_failures table existing — if you haven't applied
-- supabase-auth-failures-migration.sql yet, this migration still
-- succeeds and the function returns activation_events rows only.
-- The signin_failed metric on the admin card will read 0 until
-- auth-failures is applied; re-run THIS migration after that to
-- pull in the UNION branch.
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
-- 1. New OAuth signup fires both events on INSERT:
--      INSERT INTO auth.users (id, email, confirmed_at, raw_app_meta_data)
--        VALUES (gen_random_uuid(), 'oauth-test@example.com', now(),
--                '{"provider":"google"}'::jsonb);
--      SELECT event, metadata FROM public.activation_events
--       WHERE user_id = (SELECT id FROM auth.users WHERE email = 'oauth-test@example.com');
--    Expected: two rows, signup + signup_confirmed, both with provider='google'.
--
-- 2. Email-gate signup: INSERT with confirmed_at NULL, then UPDATE later:
--      INSERT INTO auth.users (id, email, confirmed_at, raw_app_meta_data)
--        VALUES (gen_random_uuid(), 'email-test@example.com', NULL,
--                '{"provider":"email"}'::jsonb);
--      -- Should produce no events yet.
--      UPDATE auth.users SET confirmed_at = now()
--        WHERE email = 'email-test@example.com';
--      -- Now signup + signup_confirmed appear with path='email_link'.
--
-- 3. Auto-confirm path: client logs 'signup', then trigger fires.
--    Expect ONE 'signup' row (not two) thanks to ON CONFLICT DO NOTHING.
--
-- 4. Trigger MUST NOT block the underlying mutation:
--    Force a check failure (drop the unique index, insert duplicate
--    events). Confirm auth.users INSERT still succeeds; the warning
--    surfaces in pg logs but the user lands correctly.
--
-- 5. auth_flow_metrics now reports signup_confirmed:
--      SELECT * FROM public.auth_flow_metrics(30);
--    Expected row: event='signup_confirmed', user_count, event_count.
-- ═══════════════════════════════════════════════════════════════
