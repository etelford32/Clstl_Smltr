-- ═══════════════════════════════════════════════════════════════
-- Parker Physics — Schema-hardening follow-up
-- ═══════════════════════════════════════════════════════════════
--
-- Run in Supabase Dashboard → SQL Editor → New Query (idempotent).
--
-- Closes a regression introduced by `supabase-oauth-trigger-migration
-- .sql` and a stale comment in earlier drafts of this codebase.
--
-- THE BUG
-- ───────
-- `supabase-plan-lockdown-migration.sql` (April 2026) hard-coded
-- `plan='free'` inside `handle_new_user()` to close a metadata
-- injection path:
--
--     supabase.auth.signUp({
--         email, password,
--         options: { data: { plan: 'advanced' } }
--     });
--
-- A few weeks later, `supabase-oauth-trigger-migration.sql` re-defined
-- `handle_new_user()` to add OAuth-aware display-name extraction —
-- but the new version reverted the hard-code to:
--
--     COALESCE(v_meta->>'plan', 'free')
--
-- Because the OAuth migration runs AFTER the plan-lockdown one in
-- production, this CREATE OR REPLACE silently re-opened the
-- injection: any signup with `options.data.plan` set landed with
-- that plan in user_profiles, bypassing Stripe.
--
-- THE FIX
-- ───────
-- This migration replays `handle_new_user()` with the correct
-- hard-coded `plan='free'` while preserving the OAuth-aware display
-- name extraction. Idempotent — safe to apply on top of any prior
-- version.
--
-- HOW TO TELL IF YOU WERE AFFECTED
-- ────────────────────────────────
-- Run the verification query at the bottom of this file. If it
-- returns any rows, those accounts were created with a non-free plan
-- via metadata injection and need a remediation review (probably
-- nothing more than `UPDATE user_profiles SET plan='free' WHERE …`
-- once you've confirmed they don't have legitimate Stripe
-- subscriptions backing the plan).
-- ═══════════════════════════════════════════════════════════════


-- ── 1. Replay handle_new_user() with the correct hard-code ──────────
-- This block is byte-identical to supabase-oauth-trigger-migration.sql
-- EXCEPT for the hard-coded `'free'` literal where the original had
-- `COALESCE(v_meta->>'plan', 'free')`.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
DECLARE
    v_meta JSONB := COALESCE(NEW.raw_user_meta_data, '{}'::jsonb);
    v_first TEXT := NULLIF(TRIM(v_meta->>'given_name'),  '');
    v_last  TEXT := NULLIF(TRIM(v_meta->>'family_name'), '');
    v_full  TEXT;
    v_name  TEXT;
BEGIN
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
        'user'    -- HARD-CODED. Admin grants happen post-signup via SQL editor.
    )
    ON CONFLICT (id) DO NOTHING;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- The trigger itself is unchanged; CREATE OR REPLACE on the function
-- alone is enough to put the corrected logic in front of new signups.


-- ═══════════════════════════════════════════════════════════════
-- Verification queries
-- ═══════════════════════════════════════════════════════════════
-- 1. New signup with malicious metadata MUST land as plan='free':
--      await supabase.auth.signUp({
--          email: 'test+inject@example.com',
--          password: '...',
--          options: { data: { plan: 'advanced' } },
--      });
--      -- Then in SQL Editor:
--      SELECT plan, role FROM public.user_profiles
--       WHERE email = 'test+inject@example.com';
--    Expected:  plan='free', role='user'.
--
-- 2. Identify pre-fix accounts that may have been minted with
--    non-free plans via the metadata-injection path:
--
--      SELECT u.id, u.email, p.plan, u.created_at,
--             p.stripe_customer_id, p.subscription_status
--        FROM auth.users u
--        JOIN public.user_profiles p ON p.id = u.id
--       WHERE p.plan <> 'free'
--         AND p.stripe_customer_id IS NULL    -- not a real Stripe sub
--         AND p.subscription_status IN ('none', NULL)
--         AND u.created_at > '2026-04-01'     -- after OAuth migration shipped
--       ORDER BY u.created_at DESC;
--
--    Any rows here are candidates for `UPDATE user_profiles SET
--    plan='free'` — but check first whether they were comp'd via
--    `set_user_plan_override` (look in user_profiles_audit) or via
--    apply_invite_plan, both of which leave audit trails.
--
-- 3. The OAuth display-name fallback chain still works:
--      INSERT INTO auth.users (id, email, raw_user_meta_data)
--        VALUES (gen_random_uuid(), 'name-test@example.com',
--                '{"full_name":"Jane Doe"}'::jsonb);
--      SELECT display_name FROM public.user_profiles
--       WHERE email = 'name-test@example.com';
--    Expected:  'Jane Doe'.
-- ═══════════════════════════════════════════════════════════════
