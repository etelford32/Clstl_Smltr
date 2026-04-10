-- ═══════════════════════════════════════════════════════════════
-- Parker Physics — Production Migration (run in Supabase SQL Editor)
-- ═══════════════════════════════════════════════════════════════
-- Run this ONCE to bring an existing database up to date with the
-- latest schema. Safe to re-run (uses IF NOT EXISTS / OR REPLACE).
-- ═══════════════════════════════════════════════════════════════

-- ── 1. Role column + tester role ─────────────────────────────────────────────

-- Drop old constraint if it exists (to widen the allowed values)
DO $$
BEGIN
    ALTER TABLE public.user_profiles DROP CONSTRAINT IF EXISTS user_profiles_role_check;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

ALTER TABLE public.user_profiles
    ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'user';

ALTER TABLE public.user_profiles
    ADD CONSTRAINT user_profiles_role_check
    CHECK (role IN ('user', 'tester', 'admin', 'superadmin'));

-- ── 2. Stripe billing fields ─────────────────────────────────────────────────

ALTER TABLE public.user_profiles
    ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;

ALTER TABLE public.user_profiles
    ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;

ALTER TABLE public.user_profiles
    ADD COLUMN IF NOT EXISTS stripe_price_id TEXT;

-- Drop old constraint before adding new one
DO $$
BEGIN
    ALTER TABLE public.user_profiles DROP CONSTRAINT IF EXISTS user_profiles_subscription_status_check;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

ALTER TABLE public.user_profiles
    ADD COLUMN IF NOT EXISTS subscription_status TEXT DEFAULT 'none';

ALTER TABLE public.user_profiles
    ADD CONSTRAINT user_profiles_subscription_status_check
    CHECK (subscription_status IN ('none', 'trialing', 'active', 'past_due', 'canceled', 'unpaid'));

ALTER TABLE public.user_profiles
    ADD COLUMN IF NOT EXISTS subscription_period_end TIMESTAMPTZ;

-- ── 3. Alert preference fields ───────────────────────────────────────────────

ALTER TABLE public.user_profiles ADD COLUMN IF NOT EXISTS notify_aurora BOOLEAN DEFAULT false;
ALTER TABLE public.user_profiles ADD COLUMN IF NOT EXISTS notify_conjunction BOOLEAN DEFAULT false;
ALTER TABLE public.user_profiles ADD COLUMN IF NOT EXISTS notify_storm BOOLEAN DEFAULT false;
ALTER TABLE public.user_profiles ADD COLUMN IF NOT EXISTS notify_flare BOOLEAN DEFAULT false;
ALTER TABLE public.user_profiles ADD COLUMN IF NOT EXISTS notify_cme BOOLEAN DEFAULT false;
ALTER TABLE public.user_profiles ADD COLUMN IF NOT EXISTS notify_temperature BOOLEAN DEFAULT false;
ALTER TABLE public.user_profiles ADD COLUMN IF NOT EXISTS notify_sat_pass BOOLEAN DEFAULT false;
ALTER TABLE public.user_profiles ADD COLUMN IF NOT EXISTS notify_radio_blackout BOOLEAN DEFAULT false;
ALTER TABLE public.user_profiles ADD COLUMN IF NOT EXISTS notify_gps BOOLEAN DEFAULT false;
ALTER TABLE public.user_profiles ADD COLUMN IF NOT EXISTS notify_power_grid BOOLEAN DEFAULT false;
ALTER TABLE public.user_profiles ADD COLUMN IF NOT EXISTS notify_collision BOOLEAN DEFAULT false;
ALTER TABLE public.user_profiles ADD COLUMN IF NOT EXISTS notify_recurrence BOOLEAN DEFAULT false;

ALTER TABLE public.user_profiles ADD COLUMN IF NOT EXISTS aurora_kp_threshold INTEGER DEFAULT 5;
ALTER TABLE public.user_profiles ADD COLUMN IF NOT EXISTS storm_g_threshold INTEGER DEFAULT 1;
ALTER TABLE public.user_profiles ADD COLUMN IF NOT EXISTS flare_class_threshold TEXT DEFAULT 'M';
ALTER TABLE public.user_profiles ADD COLUMN IF NOT EXISTS conjunction_threshold_km DOUBLE PRECISION DEFAULT 25.0;
ALTER TABLE public.user_profiles ADD COLUMN IF NOT EXISTS temp_high_f DOUBLE PRECISION;
ALTER TABLE public.user_profiles ADD COLUMN IF NOT EXISTS temp_low_f DOUBLE PRECISION;

ALTER TABLE public.user_profiles ADD COLUMN IF NOT EXISTS email_alerts BOOLEAN DEFAULT false;
ALTER TABLE public.user_profiles ADD COLUMN IF NOT EXISTS email_min_severity TEXT DEFAULT 'warning';
ALTER TABLE public.user_profiles ADD COLUMN IF NOT EXISTS alert_cooldown_min INTEGER DEFAULT 60;

-- ── 4. Helper functions ──────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.user_profiles
        WHERE id = auth.uid() AND role IN ('admin', 'superadmin')
    );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION public.is_tester()
RETURNS BOOLEAN AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.user_profiles
        WHERE id = auth.uid() AND role IN ('tester', 'admin', 'superadmin')
    );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- ── 5. Admin RLS policies (safe to re-run, uses IF NOT EXISTS via DO block) ──

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE policyname = 'Admins can view all profiles'
    ) THEN
        CREATE POLICY "Admins can view all profiles"
            ON public.user_profiles FOR SELECT
            USING (auth.uid() = id OR public.is_admin());
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE policyname = 'Admins can view all alerts'
    ) THEN
        CREATE POLICY "Admins can view all alerts"
            ON public.alert_history FOR SELECT
            USING (auth.uid() = user_id OR public.is_admin());
    END IF;
END $$;

-- ── 6. Update signup trigger to include plan ─────────────────────────────────

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO public.user_profiles (id, email, display_name, plan, role)
    VALUES (
        NEW.id,
        NEW.email,
        COALESCE(NEW.raw_user_meta_data->>'name', split_part(NEW.email, '@', 1)),
        COALESCE(NEW.raw_user_meta_data->>'plan', 'free'),
        'user'
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ═══════════════════════════════════════════════════════════════
-- DONE! Verify by running:
--   SELECT column_name, data_type FROM information_schema.columns
--   WHERE table_name = 'user_profiles' ORDER BY ordinal_position;
--
-- Then make yourself superadmin:
--   UPDATE public.user_profiles
--   SET role = 'superadmin', plan = 'advanced'
--   WHERE email = 'YOUR_EMAIL@example.com';
--
-- Create testers:
--   UPDATE public.user_profiles
--   SET role = 'tester', plan = 'advanced'
--   WHERE email = 'tester@example.com';
-- ═══════════════════════════════════════════════════════════════
