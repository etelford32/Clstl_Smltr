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
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    -- Location for aurora/pass predictions
    location_lat DOUBLE PRECISION,
    location_lon DOUBLE PRECISION,
    location_city TEXT,
    -- Notification preferences
    notify_aurora BOOLEAN DEFAULT true,
    notify_conjunction BOOLEAN DEFAULT true,
    notify_storm BOOLEAN DEFAULT true,
    aurora_kp_threshold INTEGER DEFAULT 5,
    conjunction_threshold_km DOUBLE PRECISION DEFAULT 25.0,
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

-- Trigger: auto-create profile on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO public.user_profiles (id, email, display_name)
    VALUES (
        NEW.id,
        NEW.email,
        COALESCE(NEW.raw_user_meta_data->>'name', split_part(NEW.email, '@', 1))
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
-- Done! Tables created with Row Level Security enabled.
--
-- Next steps:
--   1. Enable Email Auth: Dashboard → Authentication → Providers → Email
--   2. Set SUPABASE_ANON_KEY in js/supabase-config.js
--   3. Set SUPABASE_SERVICE_KEY in Vercel env vars
--   4. Test: create a user via signup.html → check user_profiles table
-- ══════════════════════════════════════════════════════════════════
