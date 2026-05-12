-- ═══════════════════════════════════════════════════════════════
-- Parker Physics — Invite "apply plan" + self-update guard
-- ═══════════════════════════════════════════════════════════════
--
-- Two related fixes that together make the admin invite flow usable:
--
-- 1. apply_invite_plan() RPC — the existing redeem_invite() only bumps
--    used_count. It never set the user's plan, so an admin-issued
--    Educator/Advanced/etc. invite quietly lands the recipient on
--    'free'. This RPC is the atomic "redeem + upgrade" replacement.
--
-- 2. user_profiles UPDATE guard — the schema's "Users can update own
--    profile" policy is wide-open: any signed-in user could UPDATE
--    their own row from the browser console and self-promote to any
--    plan or role. The new BEFORE UPDATE trigger pins plan, role, and
--    Stripe columns so they can only be mutated through trusted paths
--    (this RPC, the Stripe webhook via service-role, or by an admin).
--
-- Idempotent: CREATE OR REPLACE FUNCTION + DROP TRIGGER IF EXISTS.
-- Run AFTER supabase-invites-email-migration.sql and AFTER
-- supabase-tier-expansion-migration.sql.
-- ═══════════════════════════════════════════════════════════════


-- ── 1. Self-update guard ─────────────────────────────────────────
-- Locks privileged columns when a non-admin user UPDATEs their own
-- row. Trusted callers (Stripe webhook, apply_invite_plan) flip the
-- session-local 'pp.privileged_update' flag to bypass.
--
-- auth.uid() is NULL when called via the service-role key, so
-- background webhooks naturally pass through.

CREATE OR REPLACE FUNCTION public.guard_user_profile_self_update()
RETURNS TRIGGER AS $$
DECLARE
    v_role TEXT;
BEGIN
    -- Trusted SECURITY DEFINER paths set this flag for the duration
    -- of the transaction. Cleared automatically at COMMIT.
    IF current_setting('pp.privileged_update', true) = '1' THEN
        RETURN NEW;
    END IF;

    -- Service-role context (no auth.uid()) bypasses entirely. The
    -- Stripe webhook runs as service_role through PostgREST.
    IF auth.uid() IS NULL THEN
        RETURN NEW;
    END IF;

    -- Admins can comp users freely.
    SELECT role INTO v_role
      FROM public.user_profiles
     WHERE id = auth.uid();
    IF v_role IN ('admin', 'superadmin') THEN
        RETURN NEW;
    END IF;

    -- Non-admins must keep these privileged columns identical across
    -- an UPDATE. Each comparison uses IS DISTINCT FROM so NULL-ish
    -- transitions count too.
    IF NEW.plan                   IS DISTINCT FROM OLD.plan                   THEN RAISE EXCEPTION 'plan_change_forbidden'        USING ERRCODE = 'check_violation'; END IF;
    IF NEW.role                   IS DISTINCT FROM OLD.role                   THEN RAISE EXCEPTION 'role_change_forbidden'        USING ERRCODE = 'check_violation'; END IF;
    IF NEW.stripe_customer_id     IS DISTINCT FROM OLD.stripe_customer_id     THEN RAISE EXCEPTION 'stripe_change_forbidden'      USING ERRCODE = 'check_violation'; END IF;
    IF NEW.stripe_subscription_id IS DISTINCT FROM OLD.stripe_subscription_id THEN RAISE EXCEPTION 'stripe_change_forbidden'      USING ERRCODE = 'check_violation'; END IF;
    IF NEW.stripe_price_id        IS DISTINCT FROM OLD.stripe_price_id        THEN RAISE EXCEPTION 'stripe_change_forbidden'      USING ERRCODE = 'check_violation'; END IF;
    IF NEW.subscription_status    IS DISTINCT FROM OLD.subscription_status    THEN RAISE EXCEPTION 'subscription_change_forbidden' USING ERRCODE = 'check_violation'; END IF;
    IF NEW.subscription_period_end IS DISTINCT FROM OLD.subscription_period_end THEN RAISE EXCEPTION 'subscription_change_forbidden' USING ERRCODE = 'check_violation'; END IF;
    IF NEW.classroom_seats        IS DISTINCT FROM OLD.classroom_seats        THEN RAISE EXCEPTION 'seats_change_forbidden'       USING ERRCODE = 'check_violation'; END IF;
    IF NEW.attribution_required   IS DISTINCT FROM OLD.attribution_required   THEN RAISE EXCEPTION 'seats_change_forbidden'       USING ERRCODE = 'check_violation'; END IF;
    IF NEW.parent_account_id      IS DISTINCT FROM OLD.parent_account_id      THEN RAISE EXCEPTION 'seats_change_forbidden'       USING ERRCODE = 'check_violation'; END IF;
    IF NEW.branding               IS DISTINCT FROM OLD.branding               THEN RAISE EXCEPTION 'branding_change_forbidden'    USING ERRCODE = 'check_violation'; END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_guard_user_profile_self_update ON public.user_profiles;
CREATE TRIGGER trg_guard_user_profile_self_update
    BEFORE UPDATE ON public.user_profiles
    FOR EACH ROW EXECUTE FUNCTION public.guard_user_profile_self_update();


-- ── 2. apply_invite_plan() — atomic redeem + plan upgrade ────────
-- Replaces the redeem_invite() call in signup.html. Returns BOTH
-- whether the invite was applied AND the resulting plan, so the
-- client can branch on it (skip Stripe checkout when an invite
-- already comped a paid tier).
--
-- Email-targeted invites still require the matching email (same
-- 2-factor token semantics as validate_invite / redeem_invite).
--
-- The plan is written to user_profiles for the calling user
-- (auth.uid()) under a session-local privileged flag so the
-- guard trigger above lets it through.

CREATE OR REPLACE FUNCTION public.apply_invite_plan(
    p_invite_id UUID,
    p_email     TEXT DEFAULT NULL
) RETURNS TABLE(applied BOOLEAN, plan TEXT) AS $$
DECLARE
    v_caller        UUID := auth.uid();
    v_active        BOOLEAN;
    v_max_uses      INT;
    v_used_count    INT;
    v_expires_at    TIMESTAMPTZ;
    v_invited_email TEXT;
    v_plan          TEXT;
BEGIN
    IF v_caller IS NULL THEN
        applied := FALSE; plan := 'free'; RETURN NEXT; RETURN;
    END IF;

    SELECT active, max_uses, used_count, expires_at, invited_email, plan
      INTO v_active, v_max_uses, v_used_count, v_expires_at, v_invited_email, v_plan
      FROM public.invite_codes
     WHERE id = p_invite_id
     FOR UPDATE;

    IF NOT FOUND
       OR NOT v_active
       OR v_used_count >= v_max_uses
       OR (v_expires_at IS NOT NULL AND v_expires_at <= now())
       OR (v_invited_email IS NOT NULL
           AND (p_email IS NULL
                OR lower(v_invited_email) <> lower(trim(p_email)))) THEN
        applied := FALSE; plan := 'free'; RETURN NEXT; RETURN;
    END IF;

    -- Mark the invite as redeemed.
    UPDATE public.invite_codes
       SET used_count  = used_count + 1,
           accepted_at = COALESCE(accepted_at, now())
     WHERE id = p_invite_id;

    -- Bypass the self-update guard for the duration of this UPDATE.
    -- The flag is transaction-local so it auto-clears on COMMIT.
    PERFORM set_config('pp.privileged_update', '1', true);
    UPDATE public.user_profiles
       SET plan       = v_plan,
           updated_at = now()
     WHERE id = v_caller;
    PERFORM set_config('pp.privileged_update', '', true);

    applied := TRUE; plan := v_plan; RETURN NEXT; RETURN;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.apply_invite_plan(UUID, TEXT) TO authenticated;


-- ═══════════════════════════════════════════════════════════════
-- Verify with:
--   -- 1. Guard rejects self-elevation:
--   --    UPDATE public.user_profiles SET plan = 'enterprise' WHERE id = auth.uid();
--   --    (run as a regular user → expect plan_change_forbidden)
--
--   -- 2. apply_invite_plan succeeds for a valid invite:
--   --    INSERT INTO public.invite_codes (code, plan) VALUES ('TESTINV1', 'educator');
--   --    SELECT * FROM public.apply_invite_plan(
--   --        (SELECT id FROM public.invite_codes WHERE code = 'TESTINV1'),
--   --        NULL
--   --    );
--   --    -- Expect (applied=true, plan='educator')
--   --    SELECT plan FROM public.user_profiles WHERE id = auth.uid();
--   --    -- Expect 'educator'
-- ═══════════════════════════════════════════════════════════════
