-- ═══════════════════════════════════════════════════════════════
-- Parker Physics App — Supabase Database Schema
-- ═══════════════════════════════════════════════════════════════
--
-- Run this in Supabase Dashboard → SQL Editor → New Query
--
-- This creates:
--   1. user_profiles — extended user info (plan, location, preferences)
--   2. satellite_alerts — conjunction alert subscriptions
--   3. alert_history — log of triggered alerts
--   4. user_locations — saved locations for aurora/pass predictions
--
-- Supabase Auth handles the core auth tables (auth.users) automatically.
-- These tables extend it with app-specific data.

-- ── 1. User Profiles ─────────────────────────────────────────────────────────
-- Extends auth.users with app-specific data.
-- Automatically created on signup via a trigger.

CREATE TABLE IF NOT EXISTS public.user_profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email TEXT,
    display_name TEXT,
    plan TEXT DEFAULT 'free' CHECK (plan IN ('free', 'basic', 'advanced')),
    role TEXT DEFAULT 'user' CHECK (role IN ('user', 'tester', 'admin', 'superadmin')),
    -- Stripe billing
    stripe_customer_id TEXT,
    stripe_subscription_id TEXT,
    stripe_price_id TEXT,
    subscription_status TEXT DEFAULT 'none' CHECK (subscription_status IN ('none', 'trialing', 'active', 'past_due', 'canceled', 'unpaid')),
    subscription_period_end TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    -- Location for aurora/pass predictions
    location_lat DOUBLE PRECISION,
    location_lon DOUBLE PRECISION,
    location_city TEXT,
    -- Notification preferences (basic tier)
    notify_aurora BOOLEAN DEFAULT false,
    notify_conjunction BOOLEAN DEFAULT false,
    notify_storm BOOLEAN DEFAULT false,
    notify_flare BOOLEAN DEFAULT false,
    notify_cme BOOLEAN DEFAULT false,
    notify_temperature BOOLEAN DEFAULT false,
    notify_sat_pass BOOLEAN DEFAULT false,
    -- Notification preferences (advanced tier)
    notify_radio_blackout BOOLEAN DEFAULT false,
    notify_gps BOOLEAN DEFAULT false,
    notify_power_grid BOOLEAN DEFAULT false,
    notify_collision BOOLEAN DEFAULT false,
    notify_recurrence BOOLEAN DEFAULT false,
    -- Alert thresholds
    aurora_kp_threshold INTEGER DEFAULT 5,
    storm_g_threshold INTEGER DEFAULT 1,
    flare_class_threshold TEXT DEFAULT 'M',
    conjunction_threshold_km DOUBLE PRECISION DEFAULT 25.0,
    temp_high_f DOUBLE PRECISION,
    temp_low_f DOUBLE PRECISION,
    -- Alert delivery
    email_alerts BOOLEAN DEFAULT false,
    email_min_severity TEXT DEFAULT 'warning' CHECK (email_min_severity IN ('info', 'warning', 'critical')),
    alert_cooldown_min INTEGER DEFAULT 60,
    -- Usage tracking
    api_calls_today INTEGER DEFAULT 0,
    last_api_call TIMESTAMPTZ
);

-- RLS: users can only read/update their own profile
ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own profile"
    ON public.user_profiles FOR SELECT
    USING (auth.uid() = id);

CREATE POLICY "Users can update own profile"
    ON public.user_profiles FOR UPDATE
    USING (auth.uid() = id);

CREATE POLICY "Users can insert own profile"
    ON public.user_profiles FOR INSERT
    WITH CHECK (auth.uid() = id);

-- Helper function: check if the current user is an admin (used by RLS policies)
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.user_profiles
        WHERE id = auth.uid() AND role IN ('admin', 'superadmin')
    );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Helper function: check if the current user is a tester
-- Testers get full feature access (advanced plan equivalent) for testing purposes
CREATE OR REPLACE FUNCTION public.is_tester()
RETURNS BOOLEAN AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.user_profiles
        WHERE id = auth.uid() AND role IN ('tester', 'admin', 'superadmin')
    );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Admin policy: admins can read ALL user profiles (for admin dashboard)
CREATE POLICY "Admins can view all profiles"
    ON public.user_profiles FOR SELECT
    USING (
        auth.uid() = id
        OR public.is_admin()
    );

-- Admin policy: admins can view all alert history
CREATE POLICY "Admins can view all alerts"
    ON public.alert_history FOR SELECT
    USING (auth.uid() = user_id OR public.is_admin());

-- Trigger: auto-create profile on signup
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

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ── 2. Satellite Alert Subscriptions ─────────────────────────────────────────
-- Users can monitor specific satellites for conjunction alerts.

CREATE TABLE IF NOT EXISTS public.satellite_alerts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    norad_id INTEGER NOT NULL,
    satellite_name TEXT,
    threshold_km DOUBLE PRECISION DEFAULT 25.0,
    active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(user_id, norad_id)
);

ALTER TABLE public.satellite_alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own alerts"
    ON public.satellite_alerts FOR ALL
    USING (auth.uid() = user_id);

-- ── 3. Alert History ─────────────────────────────────────────────────────────
-- Log of triggered alerts (conjunction events, aurora visibility, storms).

CREATE TABLE IF NOT EXISTS public.alert_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    alert_type TEXT NOT NULL CHECK (alert_type IN ('conjunction', 'aurora', 'storm', 'flare', 'pass')),
    severity TEXT CHECK (severity IN ('info', 'warning', 'critical')),
    title TEXT NOT NULL,
    body TEXT,
    metadata JSONB,
    read BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.alert_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own alerts"
    ON public.alert_history FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can mark alerts read"
    ON public.alert_history FOR UPDATE
    USING (auth.uid() = user_id);

-- Index for efficient alert queries
CREATE INDEX IF NOT EXISTS idx_alert_history_user_created
    ON public.alert_history(user_id, created_at DESC);

-- ── 4. User Saved Locations ──────────────────────────────────────────────────
-- Multiple locations per user (home, office, cabin, etc.)

CREATE TABLE IF NOT EXISTS public.user_locations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    label TEXT NOT NULL DEFAULT 'Home',
    lat DOUBLE PRECISION NOT NULL,
    lon DOUBLE PRECISION NOT NULL,
    city TEXT,
    is_primary BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.user_locations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own locations"
    ON public.user_locations FOR ALL
    USING (auth.uid() = user_id);

-- ══════════════════════════════════════════════════════════════════
-- 5. invite_codes — admin-generated invite codes for plan upgrades
-- ══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.invite_codes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code TEXT UNIQUE NOT NULL,
    plan TEXT DEFAULT 'free' CHECK (plan IN ('free', 'basic', 'advanced')),
    max_uses INTEGER DEFAULT 1,
    used_count INTEGER DEFAULT 0,
    expires_at TIMESTAMPTZ,
    created_by UUID REFERENCES auth.users(id),
    created_at TIMESTAMPTZ DEFAULT now(),
    active BOOLEAN DEFAULT true
);

ALTER TABLE public.invite_codes ENABLE ROW LEVEL SECURITY;

-- Admins can do everything with invite codes
CREATE POLICY "Admins manage invites"
    ON public.invite_codes FOR ALL
    USING (public.is_admin());

-- Anyone can read a specific active invite code (for validation during signup)
CREATE POLICY "Public can validate invite codes"
    ON public.invite_codes FOR SELECT
    USING (active = true);

-- Atomic redeem function: increment used_count safely
CREATE OR REPLACE FUNCTION public.redeem_invite(invite_id UUID)
RETURNS VOID AS $$
    UPDATE public.invite_codes
    SET used_count = used_count + 1
    WHERE id = invite_id
      AND active = true
      AND used_count < max_uses
      AND (expires_at IS NULL OR expires_at > now());
$$ LANGUAGE sql SECURITY DEFINER;

-- ══════════════════════════════════════════════════════════════════
-- Done! Tables created with Row Level Security enabled.
--
-- Next steps:
--   1. Enable Email Auth: Dashboard → Authentication → Providers → Email
--   2. Set SUPABASE_ANON_KEY in js/supabase-config.js
--   3. Set SUPABASE_SERVICE_KEY in Vercel env vars
--   4. Test: create a user via signup.html → check user_profiles table
--   5. Grant admin: UPDATE user_profiles SET role='superadmin' WHERE email='you@example.com';
-- ══════════════════════════════════════════════════════════════════
