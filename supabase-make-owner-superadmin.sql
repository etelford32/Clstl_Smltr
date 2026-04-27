-- ═══════════════════════════════════════════════════════════════
-- Parker Physics — Promote owner account to superadmin + enterprise
-- ═══════════════════════════════════════════════════════════════
--
-- Idempotent one-shot script. Promotes etelford32@gmail.com to:
--   • role = 'superadmin'   → full admin dashboard + RLS bypass via is_admin()
--   • plan = 'enterprise'   → highest tier (every feature gate passes)
--   • classroom_seats = 1000 + attribution_required = false
--
-- The SQL Editor in the Supabase Dashboard runs as the database owner
-- (auth.uid() IS NULL), so the BEFORE UPDATE guards installed by
-- supabase-plan-lockdown-migration.sql and
-- supabase-invites-apply-plan-migration.sql both fall through to the
-- service-role bypass branch — no need to flip pp.privileged_update.
--
-- Run in: Supabase Dashboard → SQL Editor → New Query → Run.
-- Safe to re-run.
-- ═══════════════════════════════════════════════════════════════

DO $$
DECLARE
    v_uid UUID;
BEGIN
    SELECT id INTO v_uid
      FROM auth.users
     WHERE lower(email) = lower('etelford32@gmail.com')
     LIMIT 1;

    IF v_uid IS NULL THEN
        RAISE EXCEPTION
            'No auth.users row for etelford32@gmail.com — sign up at /signup.html first, then re-run this script.';
    END IF;

    -- Make sure a profile row exists (the on_auth_user_created trigger
    -- normally creates it, but ON CONFLICT DO NOTHING means a stale
    -- failure leaves the slot empty).
    INSERT INTO public.user_profiles (id, email, plan, role)
    VALUES (v_uid, 'etelford32@gmail.com', 'enterprise', 'superadmin')
    ON CONFLICT (id) DO NOTHING;

    UPDATE public.user_profiles
       SET role                 = 'superadmin',
           plan                 = 'enterprise',
           subscription_status  = 'active',
           classroom_seats      = 1000,
           seats_used           = COALESCE(seats_used, 0),
           attribution_required = FALSE,
           branding             = COALESCE(branding, '{}'::jsonb),
           updated_at           = now()
     WHERE id = v_uid;

    RAISE NOTICE 'Promoted % (uid=%) to superadmin / enterprise.',
        'etelford32@gmail.com', v_uid;
END $$;

-- Verify (should return one row: superadmin / enterprise / 1000):
SELECT id, email, role, plan, classroom_seats, attribution_required, subscription_status
  FROM public.user_profiles
 WHERE lower(email) = lower('etelford32@gmail.com');
