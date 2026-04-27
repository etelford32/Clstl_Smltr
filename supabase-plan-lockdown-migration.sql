-- ═══════════════════════════════════════════════════════════════
-- Parker Physics — Plan / role lockdown migration
-- ═══════════════════════════════════════════════════════════════
--
-- Run in Supabase Dashboard → SQL Editor → New Query (idempotent).
--
-- Closes two privilege-escalation paths that were live in earlier
-- migrations:
--
--   1. SIGNUP-METADATA path: handle_new_user() previously coalesced
--      `plan` from NEW.raw_user_meta_data, which is attacker-controlled
--      via the public anon-key signUp endpoint:
--
--          supabase.auth.signUp({
--              email, password,
--              options: { data: { plan: 'advanced' } }
--          });
--
--      → user_profiles row created with plan='advanced' before any
--      Stripe interaction.
--
--   2. POST-SIGNUP UPDATE path: the "Users can update own profile"
--      RLS policy has no column restriction. Any signed-in user can:
--
--          await supabase.from('user_profiles')
--              .update({ plan: 'advanced' })
--              .eq('id', auth.uid());
--
--      → instant paid-tier without payment.
--
-- After this migration:
--   * handle_new_user() ignores the client's plan/role metadata and
--     hard-codes 'free' / 'user' for every new account. Display name
--     and other non-privileged metadata still flow through.
--   * A BEFORE UPDATE trigger blocks plan, role, and stripe_*
--     mutations from anyone but service_role. The Stripe webhook,
--     SQL editor, and any future /api/admin endpoint use service_role
--     and are unaffected. End-users see a 42501 (insufficient_privilege)
--     error if they try.
--
-- Idempotent — safe to re-run. Doesn't touch admins/superadmins or
-- existing plan grants; only constrains future writes.
-- ═══════════════════════════════════════════════════════════════


-- ── 1. Replace handle_new_user() to ignore client-supplied plan/role ──
-- Keeps the same function name so the existing trigger
-- `on_auth_user_created ON auth.users` (created in supabase-schema.sql)
-- continues to fire it without modification.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO public.user_profiles (id, email, display_name, plan, role)
    VALUES (
        NEW.id,
        NEW.email,
        NEW.raw_user_meta_data->>'display_name',
        'free',   -- HARD-CODED. The Stripe webhook is the only path to a paid plan.
        'user'    -- HARD-CODED. Admin grants happen post-signup via SQL editor.
    )
    ON CONFLICT (id) DO NOTHING;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- ── 2. Block users from changing their own plan/role/stripe_* ────────
-- service_role (Stripe webhook, SQL editor, future admin endpoints)
-- bypasses this guard. Detected via PostgREST's request.jwt.claims.role,
-- which the gateway sets on every request.
CREATE OR REPLACE FUNCTION public.lock_user_profile_protected_columns()
RETURNS TRIGGER AS $$
DECLARE
    caller_role TEXT;
BEGIN
    caller_role := current_setting('request.jwt.claims', true)::jsonb->>'role';

    -- service_role and the (rare) "no JWT at all" admin-script path
    -- both bypass. Anonymous calls don't reach this trigger because
    -- the underlying RLS policy "Users can update own profile" requires
    -- auth.uid() = id, which is NULL for anon → policy denies before
    -- the trigger fires.
    IF caller_role = 'service_role' OR caller_role IS NULL THEN
        RETURN NEW;
    END IF;

    IF NEW.plan IS DISTINCT FROM OLD.plan THEN
        RAISE EXCEPTION 'protected_column: user_profiles.plan is managed by the Stripe webhook'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.role IS DISTINCT FROM OLD.role THEN
        RAISE EXCEPTION 'protected_column: user_profiles.role is managed by service_role only'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.stripe_customer_id     IS DISTINCT FROM OLD.stripe_customer_id
       OR NEW.stripe_subscription_id IS DISTINCT FROM OLD.stripe_subscription_id
       OR NEW.stripe_price_id        IS DISTINCT FROM OLD.stripe_price_id
       OR NEW.subscription_status    IS DISTINCT FROM OLD.subscription_status
       OR NEW.subscription_period_end IS DISTINCT FROM OLD.subscription_period_end
    THEN
        RAISE EXCEPTION 'protected_column: stripe_* fields are managed by the Stripe webhook'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_lock_user_profile_protected ON public.user_profiles;
CREATE TRIGGER trg_lock_user_profile_protected
    BEFORE UPDATE ON public.user_profiles
    FOR EACH ROW EXECUTE FUNCTION public.lock_user_profile_protected_columns();


-- ═══════════════════════════════════════════════════════════════
-- Verification queries — paste after running, signed-in as a non-admin
-- ═══════════════════════════════════════════════════════════════
-- 1. Self-upgrade attempt MUST fail with 42501:
--      await supabase.from('user_profiles')
--          .update({ plan: 'advanced' }).eq('id', auth.uid());
--    Expected:  insufficient_privilege / "protected_column: ..."
--
-- 2. Display-name change MUST still succeed:
--      await supabase.from('user_profiles')
--          .update({ display_name: 'New Name' }).eq('id', auth.uid());
--    Expected:  success.
--
-- 3. Signup-metadata bypass MUST be neutralised:
--      await supabase.auth.signUp({
--          email: 'test+lockdown@example.com',
--          password: '...',
--          options: { data: { plan: 'advanced', role: 'admin' } },
--      });
--    Then SELECT plan, role FROM user_profiles WHERE email = 'test+lockdown@example.com';
--    Expected:  plan='free', role='user'.
--
-- 4. Stripe webhook (service_role) plan grant MUST still succeed.
--    Trigger a test webhook from the Stripe dashboard; the user's
--    plan should update normally. (No code change needed on the
--    webhook side — service_role bypasses the trigger.)
-- ═══════════════════════════════════════════════════════════════
