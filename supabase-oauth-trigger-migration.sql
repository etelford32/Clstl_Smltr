-- ─────────────────────────────────────────────────────────────────────────────
-- supabase-oauth-trigger-migration.sql
--
-- Refreshes public.handle_new_user() so OAuth signups land with a
-- usable display_name. Each provider hands raw_user_meta_data back in
-- a different shape; the original trigger only checked `name` (the
-- shape we set ourselves in supabase.auth.signUp() from signup.html),
-- so OAuth users were getting NULL display names and the welcome
-- email defaulted to "Hi Explorer".
--
-- Lookup chain (first non-empty wins):
--   1. raw_user_meta_data->>'name'         — our manual signup shape
--   2. raw_user_meta_data->>'full_name'    — Google
--   3. raw_user_meta_data->>'display_name' — Apple
--   4. given_name + ' ' + family_name      — Google fallback when
--                                             full_name is missing
--   5. email local-part                    — last resort (also what
--                                             Apple privaterelay users
--                                             land on when name isn't
--                                             shared)
--
-- Email-password signups continue to work because (1) is unchanged.
-- Idempotent. Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
DECLARE
    v_meta JSONB := COALESCE(NEW.raw_user_meta_data, '{}'::jsonb);
    v_first TEXT := NULLIF(TRIM(v_meta->>'given_name'),  '');
    v_last  TEXT := NULLIF(TRIM(v_meta->>'family_name'), '');
    v_full  TEXT;
    v_name  TEXT;
BEGIN
    -- Compose given+family if both present (most common Google fallback
    -- when full_name isn't populated, e.g. minimal-scope OAuth grants).
    v_full := CASE
        WHEN v_first IS NOT NULL AND v_last IS NOT NULL THEN v_first || ' ' || v_last
        WHEN v_first IS NOT NULL                         THEN v_first
        WHEN v_last  IS NOT NULL                         THEN v_last
        ELSE NULL
    END;

    v_name := COALESCE(
        NULLIF(TRIM(v_meta->>'name'),         ''),     -- our manual signup
        NULLIF(TRIM(v_meta->>'full_name'),    ''),     -- Google
        NULLIF(TRIM(v_meta->>'display_name'), ''),     -- Apple (rare)
        v_full,                                        -- Google fallback
        split_part(NEW.email, '@', 1)                  -- last resort
    );

    INSERT INTO public.user_profiles (id, email, display_name, plan, role)
    VALUES (
        NEW.id,
        NEW.email,
        v_name,
        'free',   -- HARD-CODED. Stripe webhook is the only path to a paid plan.
                  -- Earlier drafts of this migration coalesced from
                  -- raw_user_meta_data, which silently re-opened the
                  -- signup-metadata injection that
                  -- supabase-plan-lockdown-migration.sql had closed.
                  -- See supabase-schema-hardening-followup-migration.sql.
        'user'    -- HARD-CODED. Admin grants happen post-signup via SQL editor.
    )
    ON CONFLICT (id) DO NOTHING;
    -- ON CONFLICT guard: re-running this trigger on a user that
    -- already has a profile (manual replay, restored backup) becomes
    -- a no-op instead of a constraint error. The trigger is AFTER
    -- INSERT on auth.users so the conflict path only fires in those
    -- recovery scenarios — not normal traffic.

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- The trigger itself is unchanged from supabase-bootstrap-fresh.sql,
-- but recreating it idempotently ensures a fresh project that ran
-- this migration WITHOUT the bootstrap will still have the trigger
-- wired up.
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Smoke test (run after applying):
--   -- The OAuth signup path will exercise this; for a manual check:
--   SELECT public.handle_new_user.proname FROM pg_proc
--    WHERE proname = 'handle_new_user';
--   -- Inspect a known-good auth.users row's metadata + the profile it
--   -- created to confirm the display_name resolution did the right
--   -- thing for that provider.
