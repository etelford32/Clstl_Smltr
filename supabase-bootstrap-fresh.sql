-- ═══════════════════════════════════════════════════════════════
-- Parker Physics — One-Paste Bootstrap (FRESH OR EXISTING PROJECT)
-- ═══════════════════════════════════════════════════════════════
--
-- Apply this single file in the Supabase SQL Editor on ANY Parker
-- Physics project. Bundles every foundational migration in
-- dependency order, with idempotency wrappers so re-running on a
-- partially-deployed project is safe (each CREATE POLICY /
-- CREATE TRIGGER is preceded by a matching DROP IF EXISTS).
--
-- WHEN TO USE:
--   • Brand-new project — bootstraps from zero.
--   • Existing project missing a recent migration — adds the
--     missing pieces without conflicting with what's already there.
--   • You want to replay everything cleanly after a manual edit.
--
-- AT THE END:
--   • etelford32@gmail.com is promoted to superadmin / enterprise
--     (silently skipped if that account hasn't signed up yet).
-- ═══════════════════════════════════════════════════════════════


-- ══════════════════════════════════════════════════════════════
-- ▶ STEP: supabase-schema.sql
--   Foundational schema (user_profiles, invite_codes, alert_history, …)
-- ══════════════════════════════════════════════════════════════

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
    plan TEXT DEFAULT 'free' CHECK (plan IN ('free', 'basic', 'educator', 'advanced', 'institution', 'enterprise')),
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
    notify_iono_disturbance BOOLEAN DEFAULT false,
    -- Alert thresholds
    aurora_kp_threshold INTEGER DEFAULT 5,
    storm_g_threshold INTEGER DEFAULT 1,
    flare_class_threshold TEXT DEFAULT 'M',
    conjunction_threshold_km DOUBLE PRECISION DEFAULT 25.0,
    temp_high_f DOUBLE PRECISION,
    temp_low_f DOUBLE PRECISION,
    radio_r_threshold INTEGER DEFAULT 2,
    gnss_risk_threshold INTEGER DEFAULT 2,
    power_grid_g_threshold INTEGER DEFAULT 4,
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

DROP POLICY IF EXISTS "Users can view own profile" ON public.user_profiles;
CREATE POLICY "Users can view own profile"
    ON public.user_profiles FOR SELECT
    USING (auth.uid() = id);

DROP POLICY IF EXISTS "Users can update own profile" ON public.user_profiles;
CREATE POLICY "Users can update own profile"
    ON public.user_profiles FOR UPDATE
    USING (auth.uid() = id);

DROP POLICY IF EXISTS "Users can insert own profile" ON public.user_profiles;
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
DROP POLICY IF EXISTS "Admins can view all profiles" ON public.user_profiles;
CREATE POLICY "Admins can view all profiles"
    ON public.user_profiles FOR SELECT
    USING (
        auth.uid() = id
        OR public.is_admin()
    );

-- Admin policy: admins can view all alert history
DROP POLICY IF EXISTS "Admins can view all alerts" ON public.alert_history;
CREATE POLICY "Admins can view all alerts"
    ON public.alert_history FOR SELECT
    USING (auth.uid() = user_id OR public.is_admin());

-- Trigger: auto-create profile on signup.
--
-- This is the bootstrap copy. It's overridden later in this same file
-- by the lockdown version (search for "Replace handle_new_user() to
-- ignore client-supplied plan/role"). Both copies hard-code plan='free'
-- and role='user' — the COALESCE-from-metadata pattern in earlier
-- versions silently re-opened the signup-metadata injection that the
-- plan-lockdown migration was meant to close.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO public.user_profiles (id, email, display_name, plan, role)
    VALUES (
        NEW.id,
        NEW.email,
        COALESCE(NEW.raw_user_meta_data->>'name', split_part(NEW.email, '@', 1)),
        'free',   -- HARD-CODED. Stripe webhook is the only path to a paid plan.
        'user'    -- HARD-CODED. Admin grants happen post-signup via SQL editor.
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

DROP POLICY IF EXISTS "Users can manage own alerts" ON public.satellite_alerts;
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

DROP POLICY IF EXISTS "Users can view own alerts" ON public.alert_history;
CREATE POLICY "Users can view own alerts"
    ON public.alert_history FOR SELECT
    USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can mark alerts read" ON public.alert_history;
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

DROP POLICY IF EXISTS "Users can manage own locations" ON public.user_locations;
CREATE POLICY "Users can manage own locations"
    ON public.user_locations FOR ALL
    USING (auth.uid() = user_id);

-- ══════════════════════════════════════════════════════════════════
-- 5. invite_codes — admin-generated invite codes for plan upgrades
-- ══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.invite_codes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code TEXT UNIQUE NOT NULL,
    plan TEXT DEFAULT 'free' CHECK (plan IN ('free', 'basic', 'educator', 'advanced', 'institution', 'enterprise')),
    max_uses INTEGER DEFAULT 1,
    used_count INTEGER DEFAULT 0,
    expires_at TIMESTAMPTZ,
    created_by UUID REFERENCES auth.users(id),
    created_at TIMESTAMPTZ DEFAULT now(),
    active BOOLEAN DEFAULT true
);

ALTER TABLE public.invite_codes ENABLE ROW LEVEL SECURITY;

-- Admins can do everything with invite codes
DROP POLICY IF EXISTS "Admins manage invites" ON public.invite_codes;
CREATE POLICY "Admins manage invites"
    ON public.invite_codes FOR ALL
    USING (public.is_admin());

-- Anyone can read a specific active invite code (for validation during signup)
DROP POLICY IF EXISTS "Public can validate invite codes" ON public.invite_codes;
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

-- ── 6. Analytics Events ──────────────────────────────────────────────────────
-- First-party analytics: page views, custom events. Immune to ad blockers.
-- Written by js/analytics.js, queried by js/admin-analytics.js.

CREATE TABLE IF NOT EXISTS public.analytics_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type TEXT NOT NULL DEFAULT 'page_view',
    event_name TEXT,
    page_path TEXT,
    page_title TEXT,
    referrer TEXT,
    session_id TEXT,
    user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    properties JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.analytics_events ENABLE ROW LEVEL SECURITY;

-- Admins can read all events; regular inserts are allowed for any authenticated user
DROP POLICY IF EXISTS "Anyone can insert analytics events" ON public.analytics_events;
CREATE POLICY "Anyone can insert analytics events"
    ON public.analytics_events FOR INSERT
    WITH CHECK (true);

DROP POLICY IF EXISTS "Admins can view all analytics" ON public.analytics_events;
CREATE POLICY "Admins can view all analytics"
    ON public.analytics_events FOR SELECT
    USING (public.is_admin());

CREATE INDEX IF NOT EXISTS idx_analytics_events_created
    ON public.analytics_events(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_analytics_events_user
    ON public.analytics_events(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_analytics_events_session
    ON public.analytics_events(session_id);

-- ── 7. User Sessions ────────────────────────────────────────────────────────
-- Heartbeat-based session tracking. Updated every 60s by js/analytics.js.

CREATE TABLE IF NOT EXISTS public.user_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id TEXT UNIQUE NOT NULL,
    user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    page_path TEXT,
    user_agent TEXT,
    started_at TIMESTAMPTZ DEFAULT now(),
    last_seen TIMESTAMPTZ DEFAULT now(),
    duration_s INTEGER DEFAULT 0,
    ended BOOLEAN DEFAULT false
);

ALTER TABLE public.user_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can upsert sessions" ON public.user_sessions;
CREATE POLICY "Anyone can upsert sessions"
    ON public.user_sessions FOR ALL
    USING (true)
    WITH CHECK (true);

DROP POLICY IF EXISTS "Admins can view all sessions" ON public.user_sessions;
CREATE POLICY "Admins can view all sessions"
    ON public.user_sessions FOR SELECT
    USING (public.is_admin());

CREATE INDEX IF NOT EXISTS idx_user_sessions_active
    ON public.user_sessions(last_seen DESC) WHERE ended = false;

-- Session heartbeat RPC: upserts session row (insert or update last_seen).
-- Called every 60s by the client — single round-trip.
CREATE OR REPLACE FUNCTION public.session_heartbeat(
    p_session_id TEXT,
    p_user_id UUID DEFAULT NULL,
    p_page_path TEXT DEFAULT NULL,
    p_user_agent TEXT DEFAULT NULL
) RETURNS VOID AS $$
BEGIN
    INSERT INTO public.user_sessions (session_id, user_id, page_path, user_agent, started_at, last_seen, ended)
    VALUES (p_session_id, p_user_id, p_page_path, p_user_agent, now(), now(), false)
    ON CONFLICT (session_id) DO UPDATE
    SET last_seen = now(),
        user_id = COALESCE(EXCLUDED.user_id, user_sessions.user_id),
        page_path = COALESCE(EXCLUDED.page_path, user_sessions.page_path),
        duration_s = EXTRACT(EPOCH FROM (now() - user_sessions.started_at))::INTEGER;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

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


-- ══════════════════════════════════════════════════════════════
-- ▶ STEP: supabase-admin.sql
--   Admin role + is_admin() (idempotent overlay)
-- ══════════════════════════════════════════════════════════════

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
DROP POLICY IF EXISTS "Admins can view all profiles" ON public.user_profiles;
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
        DROP POLICY IF EXISTS "Admins can view all alerts" ON public.alert_history;
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


-- ══════════════════════════════════════════════════════════════
-- ▶ STEP: supabase-multi-location-migration.sql
--   Per-plan saved-location caps
-- ══════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════
-- Parker Physics — Multi-Location Alerts Migration
-- ═══════════════════════════════════════════════════════════════
--
-- Run this in Supabase Dashboard → SQL Editor → New Query
-- (idempotent — safe to re-run).
--
-- Extends user_locations so each saved location can carry its own
-- alert thresholds + per-type toggles. Per-location values override
-- the account-level defaults stored on user_profiles.
--
-- Plan limits enforced via BEFORE INSERT trigger:
--   free      → 0 saved locations   (upgrade prompt)
--   basic     → 5 saved locations
--   advanced  → 25 saved locations
--
-- Admins and testers bypass the limit.
-- ═══════════════════════════════════════════════════════════════

-- ── 1. Columns ────────────────────────────────────────────────────
ALTER TABLE public.user_locations
    ADD COLUMN IF NOT EXISTS notify_enabled       BOOLEAN DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS email_alerts_enabled BOOLEAN DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS alert_config         JSONB   DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS timezone             TEXT,
    ADD COLUMN IF NOT EXISTS updated_at           TIMESTAMPTZ DEFAULT now();

-- Index for fast per-user iteration by the alert engine
CREATE INDEX IF NOT EXISTS idx_user_locations_user
    ON public.user_locations(user_id, notify_enabled);

-- ── 2. Plan → location limit map ──────────────────────────────────
CREATE OR REPLACE FUNCTION public.plan_location_limit(p_plan TEXT)
RETURNS INTEGER AS $$
    SELECT CASE lower(coalesce(p_plan, 'free'))
        WHEN 'advanced' THEN 25
        WHEN 'basic'    THEN 5
        ELSE 0
    END;
$$ LANGUAGE sql IMMUTABLE;

-- ── 3. Enforce per-user cap on insert ─────────────────────────────
CREATE OR REPLACE FUNCTION public.enforce_location_limit()
RETURNS TRIGGER AS $$
DECLARE
    current_count INTEGER;
    max_allowed   INTEGER;
    user_plan     TEXT;
    user_role     TEXT;
BEGIN
    SELECT plan, role INTO user_plan, user_role
    FROM public.user_profiles
    WHERE id = NEW.user_id;

    -- Admins / testers bypass the cap
    IF user_role IN ('admin', 'superadmin', 'tester') THEN
        RETURN NEW;
    END IF;

    SELECT count(*) INTO current_count
    FROM public.user_locations
    WHERE user_id = NEW.user_id;

    max_allowed := public.plan_location_limit(user_plan);

    IF current_count >= max_allowed THEN
        RAISE EXCEPTION
            'location_limit_exceeded: % plan allows % saved locations',
            coalesce(user_plan, 'free'), max_allowed
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_enforce_location_limit ON public.user_locations;
CREATE TRIGGER trg_enforce_location_limit
    BEFORE INSERT ON public.user_locations
    FOR EACH ROW EXECUTE FUNCTION public.enforce_location_limit();

-- ── 4. Keep a single primary location per user ────────────────────
CREATE OR REPLACE FUNCTION public.enforce_single_primary_location()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.is_primary THEN
        UPDATE public.user_locations
           SET is_primary = FALSE
         WHERE user_id = NEW.user_id
           AND id <> NEW.id
           AND is_primary = TRUE;
    END IF;
    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_single_primary_location ON public.user_locations;
CREATE TRIGGER trg_single_primary_location
    BEFORE INSERT OR UPDATE ON public.user_locations
    FOR EACH ROW EXECUTE FUNCTION public.enforce_single_primary_location();

-- ── 5. Shape of alert_config (documentation only) ─────────────────
-- {
--   "notify_aurora":            boolean,
--   "notify_storm":             boolean,
--   "notify_flare":             boolean,
--   "notify_cme":               boolean,
--   "notify_temperature":       boolean,
--   "notify_radio_blackout":    boolean,
--   "notify_gps":               boolean,
--   "notify_power_grid":        boolean,
--   "notify_iono_disturbance":  boolean,
--
--   "aurora_kp_threshold":      integer (3–9),
--   "storm_g_threshold":        integer (1–5),
--   "flare_class_threshold":    text    ('C' | 'M' | 'X'),
--   "temp_high_f":              number,
--   "temp_low_f":               number,
--   "radio_r_threshold":        integer (1–5),
--   "gnss_risk_threshold":      integer (1–3),
--   "power_grid_g_threshold":   integer (2–5)
-- }
-- Any field left out / null → falls back to the account-level default
-- on user_profiles.
-- ═══════════════════════════════════════════════════════════════


-- ══════════════════════════════════════════════════════════════
-- ▶ STEP: supabase-invites-email-migration.sql
--   Email-targeted invites + validate_invite RPC
-- ══════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════
-- Parker Physics — Email-based invite flow
-- ═══════════════════════════════════════════════════════════════
-- Paste into the Supabase SQL Editor AFTER supabase-schema.sql.
-- Idempotent: ALTER TABLE … ADD COLUMN IF NOT EXISTS, DROP POLICY
-- IF EXISTS, CREATE OR REPLACE FUNCTION.
--
-- What this enables:
--   1. Admins can target a specific email with an invite code
--      (invited_email column).
--   2. Each invite tracks sent_at and accepted_at so the dashboard
--      can show conversion rates and resend history.
--   3. Invite codes are no longer publicly enumerable: the
--      "Public can validate invite codes" policy is dropped and
--      signup validation goes through a SECURITY DEFINER RPC
--      (validate_invite) that returns only the plan tier — never
--      max_uses, used_count, or the full row.
--   4. Email-targeted invites require a matching email at redeem
--      time; bulk codes (invited_email IS NULL) work as before.
-- ═══════════════════════════════════════════════════════════════


-- ── 1. Schema additions ───────────────────────────────────────
-- These columns are nullable so existing bulk codes remain valid
-- without backfill. created_by (already present) records who
-- issued the code; for email invites that's also the inviter.

ALTER TABLE public.invite_codes
    ADD COLUMN IF NOT EXISTS invited_email TEXT,
    ADD COLUMN IF NOT EXISTS sent_at       TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS accepted_at   TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_invite_codes_invited_email
    ON public.invite_codes (lower(invited_email))
 WHERE invited_email IS NOT NULL;


-- ── 2. Lock SELECT to admins ──────────────────────────────────
-- Drop the public SELECT policy. Anonymous signup validation now
-- uses validate_invite() (defined below). The admin "FOR ALL"
-- policy from supabase-schema.sql still grants admins full access.

DROP POLICY IF EXISTS "Public can validate invite codes"
    ON public.invite_codes;


-- ── 3. validate_invite() RPC ──────────────────────────────────
-- Replaces direct table SELECT during signup. Returns the invite
-- id, plan tier, and (if any) the targeted email — but NEVER the
-- usage counters or the inviter's id. SECURITY DEFINER lets it
-- read past the admin-only RLS policy on invite_codes.
--
-- For an email-targeted invite (invited_email IS NOT NULL), the
-- caller must pass a matching email. This makes invite links act
-- as a 2-factor token: holding the code is not enough, you also
-- need the email it was sent to.
--
-- For a bulk invite (invited_email IS NULL), email is ignored.

CREATE OR REPLACE FUNCTION public.validate_invite(
    p_code  TEXT,
    p_email TEXT DEFAULT NULL
)
RETURNS TABLE (
    invite_id     UUID,
    plan          TEXT,
    invited_email TEXT,
    is_targeted   BOOLEAN
) AS $$
    SELECT
        id,
        plan,
        invited_email,
        invited_email IS NOT NULL
      FROM public.invite_codes
     WHERE code = upper(trim(p_code))
       AND active = true
       AND used_count < max_uses
       AND (expires_at IS NULL OR expires_at > now())
       AND (
           invited_email IS NULL
        OR (p_email IS NOT NULL AND lower(invited_email) = lower(trim(p_email)))
       );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Anyone (including anon) can call this. The function itself is
-- the throttle: returns no rows for an invalid / expired / wrong-
-- email invite. Code space is 32^8 ≈ 10^12, brute-forcing is
-- infeasible at any reasonable RPC rate.
GRANT EXECUTE ON FUNCTION public.validate_invite(TEXT, TEXT) TO anon, authenticated;


-- ── 4. redeem_invite() — atomic, email-aware ───────────────────
-- Extended from the supabase-schema.sql version. Now:
--   * accepts an optional p_email to enforce email-targeted invites
--   * sets accepted_at on the FIRST successful redeem
--   * returns BOOLEAN (true = redeemed, false = rejected) instead
--     of VOID, so callers can detect the failure mode without
--     re-querying. Existing clients that ignore the return are
--     unaffected.

CREATE OR REPLACE FUNCTION public.redeem_invite(
    invite_id UUID,
    p_email   TEXT DEFAULT NULL
) RETURNS BOOLEAN AS $$
DECLARE
    v_active        BOOLEAN;
    v_max_uses      INT;
    v_used_count    INT;
    v_expires_at    TIMESTAMPTZ;
    v_invited_email TEXT;
BEGIN
    SELECT active, max_uses, used_count, expires_at, invited_email
      INTO v_active, v_max_uses, v_used_count, v_expires_at, v_invited_email
      FROM public.invite_codes
     WHERE id = invite_id
     FOR UPDATE;

    IF NOT FOUND THEN                                  RETURN false; END IF;
    IF NOT v_active THEN                               RETURN false; END IF;
    IF v_used_count >= v_max_uses THEN                 RETURN false; END IF;
    IF v_expires_at IS NOT NULL
       AND v_expires_at <= now() THEN                  RETURN false; END IF;
    IF v_invited_email IS NOT NULL
       AND (p_email IS NULL
         OR lower(v_invited_email) <> lower(trim(p_email))) THEN
                                                       RETURN false;
    END IF;

    UPDATE public.invite_codes
       SET used_count  = used_count + 1,
           accepted_at = COALESCE(accepted_at, now())
     WHERE id = invite_id;

    RETURN true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.redeem_invite(UUID, TEXT) TO anon, authenticated;


-- ═══════════════════════════════════════════════════════════════
-- Verification queries — paste after running
-- ═══════════════════════════════════════════════════════════════
-- 1. Confirm new columns exist:
--      SELECT column_name, data_type
--        FROM information_schema.columns
--       WHERE table_schema = 'public' AND table_name = 'invite_codes'
--       ORDER BY ordinal_position;
--    Expect invited_email / sent_at / accepted_at among the rows.
--
-- 2. Confirm the public SELECT policy is gone:
--      SELECT policyname FROM pg_policies
--       WHERE schemaname = 'public' AND tablename = 'invite_codes';
--    Expect ONLY "Admins manage invites" (no "Public can validate ...").
--
-- 3. Test validate_invite from the SQL editor (which runs as service
--    role, bypassing GRANTs but the function logic still applies):
--      INSERT INTO public.invite_codes (code, plan, invited_email)
--      VALUES ('TESTABCD', 'free', 'test@example.com');
--      SELECT * FROM public.validate_invite('TESTABCD', 'test@example.com');
--      -- Expect 1 row.
--      SELECT * FROM public.validate_invite('TESTABCD', 'wrong@example.com');
--      -- Expect 0 rows (email mismatch).
--      SELECT * FROM public.validate_invite('TESTABCD', NULL);
--      -- Expect 0 rows (targeted invite, no email).
--      DELETE FROM public.invite_codes WHERE code = 'TESTABCD';
-- ═══════════════════════════════════════════════════════════════


-- ══════════════════════════════════════════════════════════════
-- ▶ STEP: supabase-tier-expansion-migration.sql
--   Educator/Institution/Enterprise tiers + seat columns
-- ══════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════
-- Parker Physics — Tier Expansion Migration
-- ═══════════════════════════════════════════════════════════════
--
-- Adds three new subscription tiers:
--   educator     ($25/mo) — embed permission + classroom of 30 + "Powered by" attribution
--   institution  ($500/mo) — site license up to 200 seats, custom branding, priority support
--   enterprise   (contact for quote) — manually assigned by admin after sales
--
-- Idempotent — safe to re-run.
--
-- Run AFTER supabase-schema.sql, supabase-invites-email-migration.sql,
-- and supabase-multi-location-migration.sql.
-- ═══════════════════════════════════════════════════════════════

-- ── 1. Widen the user_profiles.plan CHECK constraint ──────────────
ALTER TABLE public.user_profiles
    DROP CONSTRAINT IF EXISTS user_profiles_plan_check;

ALTER TABLE public.user_profiles
    ADD CONSTRAINT user_profiles_plan_check
    CHECK (plan IN ('free', 'tester', 'basic', 'educator', 'advanced', 'institution', 'enterprise'));

-- ── 2. Widen the invite_codes.plan CHECK constraint ──────────────
ALTER TABLE public.invite_codes
    DROP CONSTRAINT IF EXISTS invite_codes_plan_check;

ALTER TABLE public.invite_codes
    ADD CONSTRAINT invite_codes_plan_check
    CHECK (plan IN ('free', 'tester', 'basic', 'educator', 'advanced', 'institution', 'enterprise'));

-- ── 3. Per-tier columns on user_profiles ─────────────────────────
ALTER TABLE public.user_profiles
    ADD COLUMN IF NOT EXISTS classroom_seats      INTEGER,
    ADD COLUMN IF NOT EXISTS seats_used           INTEGER DEFAULT 0,
    ADD COLUMN IF NOT EXISTS parent_account_id    UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS branding             JSONB DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS attribution_required BOOLEAN DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_user_profiles_parent
    ON public.user_profiles(parent_account_id)
    WHERE parent_account_id IS NOT NULL;

-- ── 4. Default seat counts + attribution per tier ────────────────
-- Server-side helper so client can't ask Stripe for "I bought educator,
-- give me 200 seats". Webhook calls this on subscription change.
CREATE OR REPLACE FUNCTION public.tier_default_seats(p_plan TEXT)
RETURNS INTEGER AS $$
    SELECT CASE lower(coalesce(p_plan, 'free'))
        WHEN 'institution' THEN 200
        WHEN 'educator'    THEN 30
        WHEN 'enterprise'  THEN 1000  -- placeholder; real value set by admin per contract
        WHEN 'advanced'    THEN 1
        WHEN 'basic'       THEN 1
        WHEN 'tester'      THEN 1
        ELSE 1
    END;
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION public.tier_attribution_required(p_plan TEXT)
RETURNS BOOLEAN AS $$
    -- Educator tier is the ONLY one where the "Powered by Parker Physics"
    -- badge is a licensing condition. Institution+ get to white-label.
    SELECT lower(coalesce(p_plan, 'free')) = 'educator';
$$ LANGUAGE sql IMMUTABLE;

-- ── 5. Update the location-limit map for new tiers ───────────────
-- Educator gets the basic-tier cap (5) — they're managing students, not
-- forecasting locations. Institution gets advanced-equivalent (25).
-- Enterprise gets 100 to leave headroom for site-wide deployments.
CREATE OR REPLACE FUNCTION public.plan_location_limit(p_plan TEXT)
RETURNS INTEGER AS $$
    SELECT CASE lower(coalesce(p_plan, 'free'))
        WHEN 'enterprise'  THEN 100
        WHEN 'institution' THEN 25
        WHEN 'advanced'    THEN 25
        WHEN 'tester'      THEN 25
        WHEN 'educator'    THEN 5
        WHEN 'basic'       THEN 5
        ELSE 0
    END;
$$ LANGUAGE sql IMMUTABLE;

-- ── 6. Maintain attribution_required + classroom_seats on plan change ─
-- Whenever the webhook patches user_profiles.plan, this trigger keeps the
-- derived columns in sync — so client code can trust the row without
-- re-deriving from the plan name. Only fires when plan actually changes,
-- so admin-issued bonus seats survive a renewal.
CREATE OR REPLACE FUNCTION public.sync_tier_derived_columns()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.plan IS DISTINCT FROM OLD.plan THEN
        -- Only auto-set seats if we're moving INTO a seated tier and the
        -- admin hasn't already overridden with a bespoke value.
        IF NEW.plan IN ('educator', 'institution', 'enterprise')
           AND (OLD.classroom_seats IS NULL OR OLD.plan IS NULL OR OLD.plan = 'free') THEN
            NEW.classroom_seats := public.tier_default_seats(NEW.plan);
        END IF;
        NEW.attribution_required := public.tier_attribution_required(NEW.plan);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_tier_derived ON public.user_profiles;
CREATE TRIGGER trg_sync_tier_derived
    BEFORE UPDATE ON public.user_profiles
    FOR EACH ROW EXECUTE FUNCTION public.sync_tier_derived_columns();

-- ── 7. Enterprise leads (contact-form lead capture) ──────────────
CREATE TABLE IF NOT EXISTS public.enterprise_leads (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name         TEXT NOT NULL,
    organization TEXT,
    email        TEXT NOT NULL,
    role_title   TEXT,
    use_case     TEXT[]           DEFAULT '{}'::text[],
    message      TEXT,
    source_ip    TEXT,
    user_agent   TEXT,
    status       TEXT DEFAULT 'new' CHECK (status IN ('new','contacted','qualified','closed_won','closed_lost')),
    contacted_at TIMESTAMPTZ,
    notes        TEXT,
    created_at   TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.enterprise_leads ENABLE ROW LEVEL SECURITY;

-- Public anonymous insert allowed (the contact form). Email/name length
-- caps + rate limiting enforced at the edge function. Server-side
-- validation reduces the worst-case spam volume; rejecting at write time
-- here is the second line of defense.
DROP POLICY IF EXISTS "Public can submit enterprise leads" ON public.enterprise_leads;
CREATE POLICY "Public can submit enterprise leads"
    ON public.enterprise_leads FOR INSERT
    WITH CHECK (
        length(coalesce(name, ''))  BETWEEN 1 AND 120
        AND length(email)           BETWEEN 5 AND 200
        AND email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'
        AND length(coalesce(message, '')) <= 4000
    );

DROP POLICY IF EXISTS "Admins read enterprise leads" ON public.enterprise_leads;
CREATE POLICY "Admins read enterprise leads"
    ON public.enterprise_leads FOR SELECT
    USING (public.is_admin());

DROP POLICY IF EXISTS "Admins update enterprise leads" ON public.enterprise_leads;
CREATE POLICY "Admins update enterprise leads"
    ON public.enterprise_leads FOR UPDATE
    USING (public.is_admin());

CREATE INDEX IF NOT EXISTS idx_enterprise_leads_created
    ON public.enterprise_leads(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_enterprise_leads_status
    ON public.enterprise_leads(status, created_at DESC);

-- ── 8. Drop the over-permissive "public can SELECT every active invite"
--      policy. The validate_invite RPC (SECURITY DEFINER) is now the
--      only path through which an unauthenticated visitor can resolve a
--      code → plan, and it requires the email match for targeted invites.
--      Leaving the SELECT policy in place defeats that protection.
-- ── (Integration-review finding #5 from TIER_EXPANSION_SPRINT.md)
DROP POLICY IF EXISTS "Public can validate invite codes" ON public.invite_codes;

-- ═══════════════════════════════════════════════════════════════
-- Done. Verify with:
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conrelid = 'public.user_profiles'::regclass
--      AND conname  = 'user_profiles_plan_check';
--
--   SELECT public.plan_location_limit('institution');   -- expect 25
--   SELECT public.tier_default_seats('educator');       -- expect 30
--   SELECT public.tier_attribution_required('educator'); -- expect true
-- ═══════════════════════════════════════════════════════════════


-- ══════════════════════════════════════════════════════════════
-- ▶ STEP: supabase-invites-apply-plan-migration.sql
--   apply_invite_plan + plan-update guard trigger
-- ══════════════════════════════════════════════════════════════

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


-- ══════════════════════════════════════════════════════════════
-- ▶ STEP: supabase-plan-lockdown-migration.sql
--   Block self-grant of paid plans
-- ══════════════════════════════════════════════════════════════

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


-- ══════════════════════════════════════════════════════════════
-- ▶ STEP: supabase-class-seats-migration.sql
--   Class-seat invite RPCs + activation_events table
-- ══════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════
-- Parker Physics — Class seats + activation events migration
-- ═══════════════════════════════════════════════════════════════
--
-- Two tightly-coupled additions that close the Educator/Institution
-- loop and give the team a measurable activation funnel.
--
-- 1. Class-seat invites
--    The Educator ($25/30 seats) and Institution ($500/200 seats)
--    plans were sold but never wired up — `parent_account_id` and
--    `seats_used` exist on user_profiles but no RPC populates them.
--    This migration adds:
--      * apply_class_invite(invite_id, email)  — student accepts a
--        class invite. Sets parent_account_id on the student's row,
--        increments parent's seats_used, leaves student.plan='free'
--        (they ride the parent's plan via parent_account_id).
--      * is_class_invite(invite_id)            — discriminator the
--        client uses to branch signup flow.
--      * effective_plan_for(uid)               — resolves a user's
--        effective plan (theirs OR their parent's) for feature-gate
--        decisions. View v_effective_plan exposes this for RLS.
--      * release_class_seat(student_uid)       — parent removes a
--        student from the roster, decrements seats_used.
--
-- 2. Activation events
--    Without an event log the team can't tell which features drive
--    happiness. This adds a narrow, append-only `activation_events`
--    table + a `log_activation_event()` RPC that any authenticated
--    user can call (with a hard event-name allow-list to prevent
--    tag-name explosion). 90-day retention via the existing
--    purge_old_logs cron.
--
-- Idempotent: CREATE OR REPLACE FUNCTION + CREATE TABLE IF NOT
-- EXISTS + DROP POLICY IF EXISTS. Run AFTER:
--   * supabase-schema.sql                          — invite_codes, user_profiles
--   * supabase-tier-expansion-migration.sql        — parent_account_id, seats columns
--   * supabase-invites-apply-plan-migration.sql    — privileged_update flag + guard
-- ═══════════════════════════════════════════════════════════════


-- ── 0. Preflight check ───────────────────────────────────────────
-- Surface a clear, actionable error when a prerequisite migration
-- hasn't been applied, instead of dying mid-migration with
-- "relation public.invite_codes does not exist" or similar.
-- Each missing piece points at the migration that defines it.

DO $preflight$
DECLARE
    missing TEXT := '';
BEGIN
    IF to_regclass('public.user_profiles') IS NULL THEN
        missing := missing || E'\n  • table public.user_profiles      — run supabase-schema.sql';
    END IF;

    IF to_regclass('public.invite_codes') IS NULL THEN
        missing := missing || E'\n  • table public.invite_codes       — run supabase-schema.sql';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name   = 'user_profiles'
           AND column_name  = 'parent_account_id'
    ) THEN
        missing := missing || E'\n  • column user_profiles.parent_account_id  — run supabase-tier-expansion-migration.sql';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name   = 'user_profiles'
           AND column_name  = 'classroom_seats'
    ) THEN
        missing := missing || E'\n  • column user_profiles.classroom_seats    — run supabase-tier-expansion-migration.sql';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name   = 'user_profiles'
           AND column_name  = 'seats_used'
    ) THEN
        missing := missing || E'\n  • column user_profiles.seats_used         — run supabase-tier-expansion-migration.sql';
    END IF;

    -- guard_user_profile_self_update isn't strictly required (the RPCs
    -- below set the privileged_update flag defensively), but flag its
    -- absence so the operator knows their schema is incomplete.
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc
         WHERE proname = 'guard_user_profile_self_update'
    ) THEN
        RAISE NOTICE 'guard_user_profile_self_update() trigger not present — supabase-invites-apply-plan-migration.sql is recommended for plan-tier integrity.';
    END IF;

    IF missing <> '' THEN
        -- Use 'feature_not_supported' (0A000) so the message is the
        -- prominent thing the operator sees. SQLSTATE 42P01 (undefined_table)
        -- would be misleading when the missing piece is a column or function.
        RAISE EXCEPTION
            E'supabase-class-seats-migration.sql cannot be applied — prerequisites missing:%\n\nApply the listed migrations (in order, idempotent so re-running is safe) and try again. See DEPLOYMENT.md for the full list.', missing
            USING ERRCODE = '0A000';
    END IF;
END
$preflight$ LANGUAGE plpgsql;


-- ─────────────────────────────────────────────────────────────────
-- PART A — Activation events
--
-- Doesn't depend on invite_codes / class seats, so we install it
-- first. A fresh project that hasn't run the tier-expansion migration
-- still benefits from the activation funnel (and the preflight above
-- would already have aborted before reaching here).
-- ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.activation_events (
    id          BIGSERIAL PRIMARY KEY,
    user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    event       TEXT NOT NULL CHECK (event IN (
        'signup',
        'profile_completed',
        'location_saved',
        'first_sim_opened',
        'first_alert_configured',
        'first_email_alert_sent',
        'invite_sent',
        'student_joined',
        'subscription_started',
        'subscription_canceled'
    )),
    plan        TEXT,
    metadata    JSONB DEFAULT '{}'::jsonb,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_activation_events_user
    ON public.activation_events(user_id, event, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_activation_events_event_time
    ON public.activation_events(event, created_at DESC);

ALTER TABLE public.activation_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users see own activation" ON public.activation_events;
CREATE POLICY "Users see own activation"
    ON public.activation_events FOR SELECT
    USING (user_id = auth.uid() OR public.is_admin());

DROP POLICY IF EXISTS "Admins manage activation" ON public.activation_events;
CREATE POLICY "Admins manage activation"
    ON public.activation_events FOR ALL
    USING (public.is_admin());

-- Idempotency for "first_*" events — at most one row per user per
-- event so a chatty client can't bloat the table.
CREATE UNIQUE INDEX IF NOT EXISTS uq_activation_events_first
    ON public.activation_events(user_id, event)
    WHERE event IN (
        'signup',
        'profile_completed',
        'location_saved',
        'first_sim_opened',
        'first_alert_configured',
        'first_email_alert_sent'
    );

CREATE OR REPLACE FUNCTION public.log_activation_event(
    p_event    TEXT,
    p_plan     TEXT DEFAULT NULL,
    p_metadata JSONB DEFAULT '{}'::jsonb
) RETURNS BOOLEAN AS $$
DECLARE
    v_caller UUID := auth.uid();
    v_inserted INT;
BEGIN
    IF v_caller IS NULL THEN RETURN FALSE; END IF;

    INSERT INTO public.activation_events (user_id, event, plan, metadata)
    VALUES (v_caller, p_event, p_plan, COALESCE(p_metadata, '{}'::jsonb))
    ON CONFLICT DO NOTHING;

    GET DIAGNOSTICS v_inserted = ROW_COUNT;
    RETURN v_inserted > 0;
EXCEPTION
    WHEN check_violation THEN
        RETURN FALSE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.log_activation_event(TEXT, TEXT, JSONB) TO authenticated;

-- Funnel summary RPC for the admin dashboard.
CREATE OR REPLACE FUNCTION public.activation_funnel(p_days INT DEFAULT 30)
RETURNS TABLE(
    plan         TEXT,
    event        TEXT,
    user_count   BIGINT,
    median_hours NUMERIC
) AS $$
    WITH signups AS (
        SELECT user_id, plan, created_at AS signed_up_at
          FROM public.activation_events
         WHERE event = 'signup'
           AND created_at > now() - (p_days || ' days')::interval
    )
    SELECT
        COALESCE(s.plan, ae.plan, 'free')                 AS plan,
        ae.event                                           AS event,
        COUNT(DISTINCT ae.user_id)                         AS user_count,
        ROUND(EXTRACT(EPOCH FROM
            percentile_cont(0.5) WITHIN GROUP (ORDER BY ae.created_at - s.signed_up_at)
        ) / 3600.0, 2)                                     AS median_hours
      FROM public.activation_events ae
      LEFT JOIN signups s USING (user_id)
     WHERE ae.created_at > now() - (p_days || ' days')::interval
     GROUP BY 1, 2
     ORDER BY 1, 2;
$$ LANGUAGE sql SECURITY DEFINER STABLE;

GRANT EXECUTE ON FUNCTION public.activation_funnel(INT) TO authenticated;


-- ─────────────────────────────────────────────────────────────────
-- PART B — Class-seat invites
--
-- All of these touch invite_codes / user_profiles / parent_account_id,
-- so the preflight above guarantees they'll succeed.
-- ─────────────────────────────────────────────────────────────────


-- ── 1. Mark class-seat invites with a flag on invite_codes ──────
-- A class-seat invite is just an invite_codes row with the new
-- `is_class_seat` flag and the inviter's user_id in `created_by`.
-- It carries no plan tier of its own (the student's effective plan
-- is the parent's). Storing it on invite_codes — rather than a
-- second table — means the existing email + magic-link flow,
-- expiry, and audit log apply unchanged.
ALTER TABLE public.invite_codes
    ADD COLUMN IF NOT EXISTS is_class_seat BOOLEAN DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_invite_codes_class_seat
    ON public.invite_codes(created_by, created_at DESC)
    WHERE is_class_seat = TRUE;


-- ── 2. is_class_invite() helper (anon-callable for signup branch) ─
-- Returns true if the code points at a class-seat invite. Mirrors
-- validate_invite()'s SECURITY DEFINER pattern so anon clients can
-- ask "is this a class invite?" without leaking the rest of the
-- row. Returns FALSE for unknown / expired / inactive codes —
-- callers that need the full picture should still call
-- validate_invite() first.
CREATE OR REPLACE FUNCTION public.is_class_invite(p_invite_id UUID)
RETURNS BOOLEAN AS $$
    SELECT COALESCE(
        (SELECT is_class_seat
           FROM public.invite_codes
          WHERE id = p_invite_id
            AND active = TRUE
            AND used_count < max_uses
            AND (expires_at IS NULL OR expires_at > now())),
        FALSE
    );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

GRANT EXECUTE ON FUNCTION public.is_class_invite(UUID) TO anon, authenticated;


-- ── 3. apply_class_invite() — student accepts a seat ─────────────
-- Atomically:
--   * Validates the invite (email match if targeted, not expired,
--     not exhausted, parent has seats remaining).
--   * Marks the invite redeemed (used_count + 1, accepted_at).
--   * Writes parent_account_id onto the calling user's row under
--     the privileged_update flag so the guard trigger lets it
--     through.
--   * Increments the parent's seats_used.
--
-- Returns (applied, parent_id, parent_plan). The student's own
-- plan stays 'free' — they ride the parent's plan via the
-- effective_plan_for() helper below. This means a class seat
-- doesn't hit billing at all.
CREATE OR REPLACE FUNCTION public.apply_class_invite(
    p_invite_id UUID,
    p_email     TEXT DEFAULT NULL
) RETURNS TABLE(applied BOOLEAN, parent_id UUID, parent_plan TEXT) AS $$
DECLARE
    v_caller        UUID := auth.uid();
    v_active        BOOLEAN;
    v_max_uses      INT;
    v_used_count    INT;
    v_expires_at    TIMESTAMPTZ;
    v_invited_email TEXT;
    v_is_class_seat BOOLEAN;
    v_created_by    UUID;
    v_parent_seats  INT;
    v_parent_used   INT;
    v_parent_plan   TEXT;
BEGIN
    IF v_caller IS NULL THEN
        applied := FALSE; parent_id := NULL; parent_plan := NULL; RETURN NEXT; RETURN;
    END IF;

    SELECT active, max_uses, used_count, expires_at, invited_email,
           is_class_seat, created_by
      INTO v_active, v_max_uses, v_used_count, v_expires_at, v_invited_email,
           v_is_class_seat, v_created_by
      FROM public.invite_codes
     WHERE id = p_invite_id
     FOR UPDATE;

    IF NOT FOUND
       OR NOT v_active
       OR NOT v_is_class_seat
       OR v_used_count >= v_max_uses
       OR (v_expires_at IS NOT NULL AND v_expires_at <= now())
       OR (v_invited_email IS NOT NULL
           AND (p_email IS NULL
                OR lower(v_invited_email) <> lower(trim(p_email))))
       OR v_created_by IS NULL THEN
        applied := FALSE; parent_id := NULL; parent_plan := NULL; RETURN NEXT; RETURN;
    END IF;

    -- Look up parent's seat budget. Lock the row so two concurrent
    -- students can't both slip in past the cap.
    SELECT classroom_seats, COALESCE(seats_used, 0), plan
      INTO v_parent_seats, v_parent_used, v_parent_plan
      FROM public.user_profiles
     WHERE id = v_created_by
     FOR UPDATE;

    IF NOT FOUND
       OR v_parent_seats IS NULL
       OR v_parent_used >= v_parent_seats THEN
        applied := FALSE; parent_id := v_created_by; parent_plan := v_parent_plan; RETURN NEXT; RETURN;
    END IF;

    -- Mark invite redeemed.
    UPDATE public.invite_codes
       SET used_count  = used_count + 1,
           accepted_at = COALESCE(accepted_at, now())
     WHERE id = p_invite_id;

    -- Bump parent's seat usage.
    UPDATE public.user_profiles
       SET seats_used = COALESCE(seats_used, 0) + 1,
           updated_at = now()
     WHERE id = v_created_by;

    -- Attach student to parent. Privileged-update flag bypasses the
    -- guard trigger that pins parent_account_id from regular UPDATEs.
    PERFORM set_config('pp.privileged_update', '1', true);
    UPDATE public.user_profiles
       SET parent_account_id = v_created_by,
           updated_at        = now()
     WHERE id = v_caller;
    PERFORM set_config('pp.privileged_update', '', true);

    applied := TRUE; parent_id := v_created_by; parent_plan := v_parent_plan;
    RETURN NEXT; RETURN;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.apply_class_invite(UUID, TEXT) TO authenticated;


-- ── 4. effective_plan_for() — resolves student → parent plan ─────
-- A student attached via parent_account_id gets the parent's plan
-- for feature-gate decisions. Falls back to the user's own plan
-- when there's no parent. Used by the dashboard, alert engine,
-- and any RLS check that needs "what tier is this user actually
-- on right now?".
CREATE OR REPLACE FUNCTION public.effective_plan_for(p_user_id UUID)
RETURNS TEXT AS $$
    SELECT COALESCE(p.plan, u.plan, 'free')
      FROM public.user_profiles u
      LEFT JOIN public.user_profiles p ON p.id = u.parent_account_id
     WHERE u.id = p_user_id;
$$ LANGUAGE sql SECURITY DEFINER STABLE;

GRANT EXECUTE ON FUNCTION public.effective_plan_for(UUID) TO authenticated;


-- ── 5. release_class_seat() — parent removes a student ───────────
-- Detaches a student from the roster and decrements seats_used.
-- Only callable by the parent (the student's parent_account_id
-- must equal the caller, OR caller is admin). Student's row
-- is NOT deleted — they keep the account, just lose the
-- parent-derived plan.
CREATE OR REPLACE FUNCTION public.release_class_seat(p_student_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
    v_caller    UUID := auth.uid();
    v_parent    UUID;
    v_role      TEXT;
BEGIN
    IF v_caller IS NULL THEN RETURN FALSE; END IF;

    SELECT parent_account_id INTO v_parent
      FROM public.user_profiles
     WHERE id = p_student_id
     FOR UPDATE;

    IF v_parent IS NULL THEN RETURN FALSE; END IF;

    -- Authorization: caller must be the parent OR an admin.
    SELECT role INTO v_role
      FROM public.user_profiles
     WHERE id = v_caller;

    IF v_parent <> v_caller AND v_role NOT IN ('admin', 'superadmin') THEN
        RETURN FALSE;
    END IF;

    -- Detach + decrement.
    PERFORM set_config('pp.privileged_update', '1', true);
    UPDATE public.user_profiles
       SET parent_account_id = NULL,
           updated_at        = now()
     WHERE id = p_student_id;
    UPDATE public.user_profiles
       SET seats_used = GREATEST(COALESCE(seats_used, 0) - 1, 0),
           updated_at = now()
     WHERE id = v_parent;
    PERFORM set_config('pp.privileged_update', '', true);

    RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.release_class_seat(UUID) TO authenticated;


-- ── 6. class_roster() — parent reads their students ──────────────
-- Returns one row per student attached to the calling user.
-- Display name + email + joined-at + last-activity timestamp.
-- The email comes from auth.users (a join non-admins can't normally
-- do); SECURITY DEFINER lets us return it ONLY for the calling
-- parent's own students.
CREATE OR REPLACE FUNCTION public.class_roster()
RETURNS TABLE(
    student_id    UUID,
    display_name  TEXT,
    email         TEXT,
    joined_at     TIMESTAMPTZ,
    last_active   TIMESTAMPTZ
) AS $$
    SELECT
        up.id,
        up.display_name,
        au.email,
        up.updated_at,
        up.updated_at
      FROM public.user_profiles up
      LEFT JOIN auth.users au ON au.id = up.id
     WHERE up.parent_account_id = auth.uid()
     ORDER BY up.updated_at DESC NULLS LAST;
$$ LANGUAGE sql SECURITY DEFINER STABLE;

GRANT EXECUTE ON FUNCTION public.class_roster() TO authenticated;


-- ═══════════════════════════════════════════════════════════════
-- Verify with:
--   -- 1. is_class_seat column exists:
--   --    SELECT column_name FROM information_schema.columns
--   --      WHERE table_name='invite_codes' AND column_name='is_class_seat';
--
--   -- 2. activation_events allow-list rejects unknown events:
--   --    INSERT INTO public.activation_events (user_id, event)
--   --    VALUES (auth.uid(), 'made_up_event');
--   --    -- Expect: 23514 check_violation
--
--   -- 3. apply_class_invite enforces seat cap:
--   --    Set parent.classroom_seats=2, redeem 3 invites — third fails.
--
--   -- 4. effective_plan_for resolves student → parent:
--   --    SELECT public.effective_plan_for(<student_uuid>);
--   --    -- Expect: parent's plan, not student's.
-- ═══════════════════════════════════════════════════════════════


-- ══════════════════════════════════════════════════════════════
-- ▶ STEP: superadmin bootstrap (etelford32@gmail.com)
--   Hardcoded so the founding admin doesn't need a separate paste.
--   Tolerates a not-yet-signed-up email — emits NOTICE and continues
--   instead of aborting the bootstrap.
-- ══════════════════════════════════════════════════════════════

DO $owner_promote$
DECLARE
    v_uid UUID;
    v_email TEXT := 'etelford32@gmail.com';
BEGIN
    SELECT id INTO v_uid
      FROM auth.users
     WHERE lower(email) = lower(v_email)
     LIMIT 1;

    IF v_uid IS NULL THEN
        RAISE NOTICE 'Skipping superadmin promotion: no auth.users row for %. Sign up at /signup.html, then re-run this bootstrap (idempotent).', v_email;
        RETURN;
    END IF;

    -- Ensure a profile row exists (auth trigger normally creates it).
    INSERT INTO public.user_profiles (id, email, plan, role)
    VALUES (v_uid, v_email, 'enterprise', 'superadmin')
    ON CONFLICT (id) DO NOTHING;

    -- The lockdown trigger pins privileged columns for non-admin self-
    -- updates. Service-role context (SQL editor) has auth.uid() IS NULL,
    -- which the trigger treats as a trusted bypass — but we set the flag
    -- explicitly anyway in case the bypass logic changes.
    PERFORM set_config('pp.privileged_update', '1', true);

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

    PERFORM set_config('pp.privileged_update', '', true);

    RAISE NOTICE 'Promoted % (uid=%) to superadmin / enterprise.', v_email, v_uid;
END
$owner_promote$;

-- ══════════════════════════════════════════════════════════════
-- ✅  Verification queries — paste after the run completes.
-- ══════════════════════════════════════════════════════════════
--
--   SELECT to_regclass('public.user_profiles')    AS user_profiles,
--          to_regclass('public.invite_codes')     AS invite_codes,
--          to_regclass('public.activation_events') AS activation_events;
--   -- Expect three non-NULL rows.
--
--   SELECT proname FROM pg_proc
--    WHERE proname IN (
--        'apply_class_invite', 'release_class_seat', 'class_roster',
--        'effective_plan_for', 'log_activation_event', 'activation_funnel'
--    ) ORDER BY proname;
--   -- Expect six rows.
--
--   SELECT email, role, plan FROM public.user_profiles
--    WHERE lower(email) = 'etelford32@gmail.com';
--   -- Expect role=superadmin, plan=enterprise (or zero rows if not signed up yet).