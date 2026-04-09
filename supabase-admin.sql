-- ═══════════════════════════════════════════════════════════════
-- Parker Physics — Admin Role Migration
-- ═══════════════════════════════════════════════════════════════
-- NOTE: The role column and is_admin() function are now included in
-- supabase-schema.sql for new deployments. This file is only needed
-- if your existing database was created BEFORE the role column was
-- added to the main schema. Safe to re-run (uses IF NOT EXISTS).
--
-- Run this in Supabase Dashboard → SQL Editor if you get
-- "Role column missing" errors in the admin dashboard.

-- Add role column if it doesn't exist
ALTER TABLE public.user_profiles
    ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'user'
    CHECK (role IN ('user', 'tester', 'admin', 'superadmin'));

-- Helper function: check if the current user is an admin
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.user_profiles
        WHERE id = auth.uid() AND role IN ('admin', 'superadmin')
    );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Admin policy: admins can read ALL user profiles (for admin dashboard)
CREATE POLICY "Admins can view all profiles"
    ON public.user_profiles FOR SELECT
    USING (
        auth.uid() = id  -- users can always see their own
        OR public.is_admin()  -- admins can see everyone
    );

-- Admin policy: admins can view all alerts
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

-- ═══════════════════════════════════════════════════════════════
-- MAKE YOURSELF ADMIN
-- ═══════════════════════════════════════════════════════════════
-- After you sign up on the site, run this with YOUR email:
--
--   UPDATE public.user_profiles
--   SET role = 'superadmin', plan = 'advanced'
--   WHERE email = 'YOUR_EMAIL@example.com';
--
-- Or by user ID (find it in Supabase Auth → Users):
--
--   UPDATE public.user_profiles
--   SET role = 'superadmin', plan = 'advanced'
--   WHERE id = 'YOUR_USER_UUID';
--
-- ═══════════════════════════════════════════════════════════════
