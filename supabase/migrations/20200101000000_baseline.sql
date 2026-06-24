-- ═══════════════════════════════════════════════════════════════
-- Parker Physics — full-schema baseline migration
-- ═══════════════════════════════════════════════════════════════
-- Reconstructs the COMPLETE public schema on an empty database so that
-- Supabase preview branches (the PR "database build" check) succeed.
--
-- Why this exists: the recorded migration history starts mid-stream
-- (first entry = session_heartbeat_fix) and assumes a base schema that
-- was applied by hand in the SQL editor and never recorded. On an empty
-- preview DB those base tables don't exist, so every preview build failed
-- with "relation ... does not exist". This file is that missing base.
--
-- Assembled VERBATIM from the repo's own migration SQL, plus five tables
-- that existed only in production (announcements, beta_invites,
-- beta_invite_uses, farside_truth, feedback). Safe to re-run.
-- See SUPABASE_BRANCHING_RUNBOOK.md.
-- ═══════════════════════════════════════════════════════════════

-- Don't validate function bodies at CREATE time: lets functions that
-- reference tables/objects defined later in this file install cleanly.
SET check_function_bodies = false;

-- pg_cron shim: two feature files call cron.schedule()/cron.unschedule()
-- at top level. Production has pg_cron; a throwaway preview DB may not.
-- If the extension is absent, install no-op stand-ins so the build can't
-- fail on scheduling calls (cron jobs are irrelevant on a preview DB).
DO $shim$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    CREATE SCHEMA IF NOT EXISTS cron;
    CREATE OR REPLACE FUNCTION cron.schedule(text, text, text) RETURNS bigint LANGUAGE sql AS 'SELECT 0::bigint';
    CREATE OR REPLACE FUNCTION cron.schedule(text, text) RETURNS bigint LANGUAGE sql AS 'SELECT 0::bigint';
    CREATE OR REPLACE FUNCTION cron.unschedule(text) RETURNS boolean LANGUAGE sql AS 'SELECT true';
    CREATE OR REPLACE FUNCTION cron.unschedule(bigint) RETURNS boolean LANGUAGE sql AS 'SELECT true';
  END IF;
END
$shim$;


-- ═══════════════ BOOTSTRAP: core schema ═══════════════

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

-- ═══════════════════════════════════════════════════════════════
-- HOISTED TABLE DEFINITIONS  (fresh-install ordering fix)
-- Every CREATE TABLE is pulled to the top so that policies, indexes
-- and RLS overlays later in this file always find their table on a
-- brand-new (preview) database. All are IF NOT EXISTS, so the original
-- definitions further down are harmless no-ops.
-- ═══════════════════════════════════════════════════════════════

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
    -- Account-level display timezone (IANA name); per-location
    -- overrides live on user_locations.timezone.
    timezone TEXT,
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

CREATE TABLE IF NOT EXISTS public.user_profiles_audit (
    id              BIGSERIAL PRIMARY KEY,
    target_user_id  UUID NOT NULL,                          -- the row that was changed
    changed_by_uid  UUID,                                   -- the actor (NULL for service_role / SQL Editor)
    changed_by_role TEXT,                                   -- captured at change time so demotion-after-the-fact stays attributable
    operation       TEXT NOT NULL CHECK (operation IN ('INSERT','UPDATE','DELETE')),
    source          TEXT NOT NULL CHECK (source IN (
                        'trigger',                          -- caught by the column trigger
                        'rpc_promote_user',                 -- explicit role-change RPC
                        'rpc_set_user_plan_override',       -- explicit plan-override RPC
                        'stripe_webhook',                   -- Stripe webhook (sets jwt_claim before mutating)
                        'system'                            -- bootstrap / migration (default catch-all)
                    )),
    changed_columns TEXT[] NOT NULL DEFAULT '{}',           -- e.g. {plan, subscription_status}
    old_values      JSONB,                                  -- only the changed columns, NULL for INSERT
    new_values      JSONB,                                  -- only the changed columns, NULL for DELETE
    reason          TEXT,                                   -- required for plan overrides; NULL for trigger-captured
    request_origin  TEXT,                                   -- e.g. PostgREST gateway / SQL Editor (best-effort)
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.solar_wind_samples (
    id            BIGSERIAL PRIMARY KEY,
    observed_at   TIMESTAMPTZ NOT NULL,
    ingested_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    source        TEXT        NOT NULL DEFAULT 'noaa-swpc',
    speed_km_s    DOUBLE PRECISION,
    density_cc    DOUBLE PRECISION,
    temperature_k DOUBLE PRECISION,
    bt_nt         DOUBLE PRECISION,
    bz_nt         DOUBLE PRECISION,
    bx_nt         DOUBLE PRECISION,
    by_nt         DOUBLE PRECISION,
    UNIQUE (observed_at, source)
);

CREATE TABLE IF NOT EXISTS public.weather_grid_cache (
    id          BIGSERIAL PRIMARY KEY,
    fetched_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    source      TEXT        NOT NULL DEFAULT 'open-meteo',
    payload     JSONB       NOT NULL
);

CREATE TABLE IF NOT EXISTS public.pipeline_heartbeat (
    pipeline_name        TEXT        PRIMARY KEY,
    last_success_at      TIMESTAMPTZ,
    last_failure_at      TIMESTAMPTZ,
    last_failure_reason  TEXT,
    last_source          TEXT,
    consecutive_fail     INT         NOT NULL DEFAULT 0,
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.client_telemetry (
    id          BIGSERIAL PRIMARY KEY,
    kind        TEXT NOT NULL CHECK (kind IN (
                    'error',          -- uncaught exception / unhandled rejection
                    'auth_failure',   -- post-auth or non-credential auth failure
                    'not_found',      -- 404.html load or broken-link click
                    'redirect',       -- requireAuth() bounced to signin
                    'web_vital',      -- LCP / FCP / CLS / INP
                    'app_perf'        -- custom mark (wasm_init, dashboard_mount, etc.)
                )),
    severity    TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warning','error')),
    route       TEXT,                                       -- pathname only — query string stripped client-side
    user_id     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    session_id  TEXT,                                       -- browser-generated, sessionStorage-scoped
    metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,         -- kind-specific payload (see below)
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.auth_failures (
    id          BIGSERIAL PRIMARY KEY,
    email_hash  TEXT NOT NULL,           -- HMAC-SHA-256(email, pepper)
    reason      TEXT,                    -- supabase error message, truncated to 200ch
    ua_short    TEXT,                    -- first 80 chars of User-Agent (for OS/browser bucket)
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.feedback_submissions (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kind         TEXT NOT NULL CHECK (kind IN ('feature_request','bug_report','general')),
    page         TEXT,
    subject      TEXT NOT NULL,
    message      TEXT NOT NULL,
    email        TEXT,
    url          TEXT,
    source_ip    TEXT,
    user_agent   TEXT,
    status       TEXT DEFAULT 'new' CHECK (status IN ('new','triaged','in_progress','shipped','wont_fix','duplicate')),
    notes        TEXT,
    triaged_at   TIMESTAMPTZ,
    created_at   TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.forecaster_registry (
    model_id      TEXT        PRIMARY KEY,
    name          TEXT        NOT NULL,
    version       TEXT        NOT NULL DEFAULT '1',
    code_hash     TEXT,
    family        TEXT        NOT NULL DEFAULT 'unknown'
                              CHECK (family IN (
                                  'persistence', 'diurnal', 'statistical',
                                  'nwp', 'blend', 'ml', 'analog', 'unknown'
                              )),
    deployed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    retired_at    TIMESTAMPTZ,
    notes         TEXT
);

CREATE TABLE IF NOT EXISTS public.forecast_log (
    id            BIGSERIAL    PRIMARY KEY,
    made_at       TIMESTAMPTZ  NOT NULL,
    valid_at      TIMESTAMPTZ  NOT NULL,
    lead_minutes  INTEGER      GENERATED ALWAYS AS
                               (GREATEST(0, EXTRACT(EPOCH FROM (valid_at - made_at))::INT / 60))
                               STORED,
    lat           REAL         NOT NULL,
    lon           REAL         NOT NULL,
    field         TEXT         NOT NULL,
    model_id      TEXT         NOT NULL REFERENCES public.forecaster_registry(model_id),
    value         REAL,
    p10           REAL,
    p50           REAL,
    p90           REAL,
    sim_time_ms   BIGINT,
    observation   REAL,
    obs_at        TIMESTAMPTZ,
    archived      BOOLEAN      NOT NULL DEFAULT FALSE,
    ingested_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CHECK (length(field) BETWEEN 1 AND 64),
    CHECK (lat >= -90 AND lat <= 90),
    CHECK (lon >= -180 AND lon <= 180)
);

CREATE TABLE IF NOT EXISTS public.forecast_archive_pointer (
    id           BIGSERIAL   PRIMARY KEY,
    day          DATE        NOT NULL,
    r2_key       TEXT        NOT NULL UNIQUE,
    row_count    INTEGER     NOT NULL,
    bytes        BIGINT      NOT NULL,
    sha256       TEXT        NOT NULL,
    written_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

create table if not exists public.aurora_subscribers (
    id              uuid primary key default gen_random_uuid(),
    email           text not null,
    status          text not null default 'pending'
                        check (status in ('pending','confirmed','unsubscribed')),
    confirm_token   uuid not null default gen_random_uuid(),
    source          text,                       -- capturing page, e.g. 'earth'
    utm             jsonb,                       -- {source,medium,campaign}
    created_at      timestamptz not null default now(),
    confirmed_at    timestamptz,
    unsubscribed_at timestamptz
);

create table if not exists public.aurora_broadcast_log (
    id                  uuid primary key default gen_random_uuid(),
    blasted_at          timestamptz not null default now(),
    kp                  numeric,
    storm_level         int,
    recipients          int,
    resend_broadcast_id text,
    metadata            jsonb
);

CREATE TABLE IF NOT EXISTS public.farside_maps (
    id             BIGSERIAL    PRIMARY KEY,
    source         TEXT         NOT NULL,                 -- gong | solo | stereo | hmi
    observed_at    TIMESTAMPTZ  NOT NULL,                 -- map timestamp (FITS DATE-OBS or slot)
    ingested_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    carrington_l0  DOUBLE PRECISION,                      -- sub-Earth Carrington longitude
    carrington_b0  DOUBLE PRECISION,                      -- heliographic latitude of disc centre
    grid_nlon      INT,
    grid_nlat      INT,
    lat_min        INT,
    image_url      TEXT,                                  -- resolved upstream URL
    raw_r2_key     TEXT,                                  -- archived original bytes (FITS/PNG)
    grid_b64       TEXT,                                  -- base64 Float32 LE z-score grid (nullable)
    grid_sha256    TEXT,
    detections     JSONB        NOT NULL DEFAULT '[]'::jsonb,
    n_detections   INT          NOT NULL DEFAULT 0,
    n_strong       INT          NOT NULL DEFAULT 0,
    synthetic      BOOLEAN      NOT NULL DEFAULT FALSE,    -- TRUE only if no real upstream resolved
    meta           JSONB,
    UNIQUE (source, observed_at)
);

CREATE TABLE IF NOT EXISTS public.spaceship_designs (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    description TEXT,
    design_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    is_public   BOOLEAN DEFAULT FALSE,
    best_score  DOUBLE PRECISION DEFAULT 0,
    created_at  TIMESTAMPTZ DEFAULT now(),
    updated_at  TIMESTAMPTZ DEFAULT now(),
    UNIQUE (user_id, name)
);

CREATE TABLE IF NOT EXISTS public.aurora_outlook_cache (
    id            BIGSERIAL    PRIMARY KEY,
    generated_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    source        TEXT         NOT NULL DEFAULT 'noaa-45d+recurrence',
    payload       JSONB        NOT NULL
);

CREATE TABLE IF NOT EXISTS public.announcements (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  title text NOT NULL,
  body text,
  severity text DEFAULT 'info'::text,
  target_plan text DEFAULT 'all'::text,
  published boolean DEFAULT false,
  published_at timestamp with time zone,
  expires_at timestamp with time zone,
  created_by uuid,
  created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.beta_invites (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  code text NOT NULL,
  label text,
  max_uses integer DEFAULT 1,
  use_count integer DEFAULT 0,
  created_by uuid,
  expires_at timestamp with time zone,
  active boolean DEFAULT true,
  created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.beta_invite_uses (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  invite_id uuid NOT NULL,
  user_id uuid,
  email text,
  redeemed_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.farside_truth (
  id bigint GENERATED BY DEFAULT AS IDENTITY,
  case_id text NOT NULL,
  noaa_region integer,
  label text NOT NULL,
  east_limb_crossing timestamp with time zone NOT NULL,
  carrington_lon double precision,
  carrington_lat double precision,
  flare_productive boolean,
  source text NOT NULL DEFAULT 'manual'::text,
  notes text,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.feedback (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid,
  email text,
  category text DEFAULT 'general'::text,
  page text,
  message text NOT NULL,
  metadata jsonb DEFAULT '{}'::jsonb,
  status text DEFAULT 'new'::text,
  created_at timestamp with time zone DEFAULT now()
);

-- ─── end hoisted tables ───

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
    -- Account-level display timezone (IANA name); per-location
    -- overrides live on user_locations.timezone.
    timezone TEXT,
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

-- Account-level display timezone (account.html → js/account.js writes
-- this when the user picks a timezone in the Profile card).
ALTER TABLE public.user_profiles
    ADD COLUMN IF NOT EXISTS timezone TEXT;

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

-- ═══════════════ FEATURE: role-plan-audit ═══════════════

-- ═══════════════════════════════════════════════════════════════
-- Parker Physics — Role / plan / Stripe-link audit migration
-- ═══════════════════════════════════════════════════════════════
--
-- Run in Supabase Dashboard → SQL Editor → New Query (idempotent).
--
-- Adds:
--   1. is_superadmin() helper            — distinguishes superadmin from admin
--   2. user_profiles_audit table         — every change to a tracked column
--   3. AFTER UPDATE/INSERT/DELETE trigger on user_profiles
--   4. promote_user(p_user_id, p_role)   — admin/superadmin role mutation
--   5. set_user_plan_override(p_user_id, p_plan, p_reason)
--                                          superadmin-only manual plan grant
--   6. recent_role_audit(p_limit)        — superadmin-only read RPC
--
-- Why this exists:
--   * The plan-lockdown migration blocks self-mutation of role/plan but
--     leaves no audit trail when service_role / Stripe webhook / future
--     admin RPC mutates them. With Stripe roles + comp accounts in play
--     we need a forensic record of who changed what, when, and why.
--   * superadmin minting stays SQL-only (no UI path) so a compromised
--     admin can't escalate. Every UI mutation runs through the audited
--     RPCs.
--
-- Idempotent — safe to re-run. Doesn't backfill historical changes
-- (the audit table starts empty by design — new changes only).
-- ═══════════════════════════════════════════════════════════════


-- ── 1. is_superadmin() helper ────────────────────────────────────────
-- Mirrors the existing is_admin() / is_tester() pattern. SECURITY
-- DEFINER + STABLE so RLS policies can call it without permission
-- recursion. Returns FALSE when auth.uid() is NULL (anon, service_role
-- bypassing RLS at the SQL Editor level).
CREATE OR REPLACE FUNCTION public.is_superadmin()
RETURNS BOOLEAN AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.user_profiles
        WHERE id = auth.uid() AND role = 'superadmin'
    );
$$ LANGUAGE sql SECURITY DEFINER STABLE;


-- ── 2. Audit table ──────────────────────────────────────────────────
-- One row per UPDATE statement that touches a tracked column, plus
-- one row each on INSERT (signup) and DELETE (account wipe). The
-- changed_columns array makes it cheap to filter ("show me all role
-- changes in the last 30 days") without parsing JSONB diffs.
--
-- Tracked columns are the four privilege-bearing buckets:
--   * role
--   * plan
--   * subscription_status / subscription_period_end
--   * stripe_customer_id / stripe_subscription_id / stripe_price_id
-- A change to any of those captures a row. Edits to display_name,
-- notification preferences, etc. are NOT logged here — they're not
-- privilege-bearing.
CREATE TABLE IF NOT EXISTS public.user_profiles_audit (
    id              BIGSERIAL PRIMARY KEY,
    target_user_id  UUID NOT NULL,                          -- the row that was changed
    changed_by_uid  UUID,                                   -- the actor (NULL for service_role / SQL Editor)
    changed_by_role TEXT,                                   -- captured at change time so demotion-after-the-fact stays attributable
    operation       TEXT NOT NULL CHECK (operation IN ('INSERT','UPDATE','DELETE')),
    source          TEXT NOT NULL CHECK (source IN (
                        'trigger',                          -- caught by the column trigger
                        'rpc_promote_user',                 -- explicit role-change RPC
                        'rpc_set_user_plan_override',       -- explicit plan-override RPC
                        'stripe_webhook',                   -- Stripe webhook (sets jwt_claim before mutating)
                        'system'                            -- bootstrap / migration (default catch-all)
                    )),
    changed_columns TEXT[] NOT NULL DEFAULT '{}',           -- e.g. {plan, subscription_status}
    old_values      JSONB,                                  -- only the changed columns, NULL for INSERT
    new_values      JSONB,                                  -- only the changed columns, NULL for DELETE
    reason          TEXT,                                   -- required for plan overrides; NULL for trigger-captured
    request_origin  TEXT,                                   -- e.g. PostgREST gateway / SQL Editor (best-effort)
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_profiles_audit_target
    ON public.user_profiles_audit (target_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_profiles_audit_actor
    ON public.user_profiles_audit (changed_by_uid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_profiles_audit_recent
    ON public.user_profiles_audit (created_at DESC);


-- ── 3. RLS — superadmin reads only; INSERT only via SECURITY DEFINER ──
ALTER TABLE public.user_profiles_audit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Superadmin can view audit log"  ON public.user_profiles_audit;
CREATE POLICY "Superadmin can view audit log"
    ON public.user_profiles_audit FOR SELECT
    USING (public.is_superadmin());

-- No INSERT/UPDATE/DELETE policies — all writes go through SECURITY
-- DEFINER functions. service_role bypasses RLS so the trigger below
-- can write regardless. Direct anon/authenticated writes are denied
-- by the absence of a permissive policy.


-- ── 4. AFTER trigger — captures every change to tracked columns ──────
-- Sits AFTER the existing BEFORE-UPDATE lockdown trigger
-- (lock_user_profile_protected_columns) so we only audit changes that
-- the lockdown ALLOWED through. service_role and the audited RPCs both
-- pass through the lockdown; everyone else is rejected before reaching
-- this trigger.
CREATE OR REPLACE FUNCTION public.audit_user_profile_changes()
RETURNS TRIGGER AS $$
DECLARE
    v_changed       TEXT[] := '{}';
    v_old           JSONB  := '{}'::jsonb;
    v_new           JSONB  := '{}'::jsonb;
    v_actor_uid     UUID;
    v_actor_role    TEXT;
    v_source        TEXT;
    v_reason        TEXT;
    v_origin        TEXT;
BEGIN
    -- Pull the actor + override hint set by the SECURITY DEFINER RPCs.
    -- Both are best-effort: NULL when called from service_role / SQL Editor.
    BEGIN v_actor_uid := auth.uid();                                    EXCEPTION WHEN OTHERS THEN v_actor_uid := NULL;  END;
    BEGIN v_actor_role := current_setting('request.jwt.claims', true)::jsonb->>'role'; EXCEPTION WHEN OTHERS THEN v_actor_role := NULL; END;
    BEGIN v_source     := current_setting('app.audit_source', true);    EXCEPTION WHEN OTHERS THEN v_source := NULL;     END;
    BEGIN v_reason     := current_setting('app.audit_reason', true);    EXCEPTION WHEN OTHERS THEN v_reason := NULL;     END;
    BEGIN v_origin     := current_setting('request.headers', true)::jsonb->>'host'; EXCEPTION WHEN OTHERS THEN v_origin := NULL; END;

    IF v_source IS NULL OR v_source = '' THEN
        v_source := CASE
            WHEN v_actor_role = 'service_role' THEN 'system'
            ELSE 'trigger'
        END;
    END IF;

    -- Per-operation diff.
    IF (TG_OP = 'INSERT') THEN
        v_new := jsonb_build_object(
            'role', NEW.role,
            'plan', NEW.plan,
            'subscription_status', NEW.subscription_status,
            'subscription_period_end', NEW.subscription_period_end,
            'stripe_customer_id', NEW.stripe_customer_id,
            'stripe_subscription_id', NEW.stripe_subscription_id,
            'stripe_price_id', NEW.stripe_price_id
        );
        v_changed := ARRAY['__insert__'];

        INSERT INTO public.user_profiles_audit (
            target_user_id, changed_by_uid, changed_by_role,
            operation, source, changed_columns,
            old_values, new_values, reason, request_origin
        ) VALUES (
            NEW.id, v_actor_uid, v_actor_role,
            'INSERT', v_source, v_changed,
            NULL, v_new, v_reason, v_origin
        );
        RETURN NEW;
    END IF;

    IF (TG_OP = 'DELETE') THEN
        v_old := jsonb_build_object(
            'role', OLD.role,
            'plan', OLD.plan,
            'subscription_status', OLD.subscription_status,
            'subscription_period_end', OLD.subscription_period_end,
            'stripe_customer_id', OLD.stripe_customer_id,
            'stripe_subscription_id', OLD.stripe_subscription_id,
            'stripe_price_id', OLD.stripe_price_id
        );
        v_changed := ARRAY['__delete__'];

        INSERT INTO public.user_profiles_audit (
            target_user_id, changed_by_uid, changed_by_role,
            operation, source, changed_columns,
            old_values, new_values, reason, request_origin
        ) VALUES (
            OLD.id, v_actor_uid, v_actor_role,
            'DELETE', v_source, v_changed,
            v_old, NULL, v_reason, v_origin
        );
        RETURN OLD;
    END IF;

    -- TG_OP = 'UPDATE': only audit if a tracked column actually changed.
    IF NEW.role IS DISTINCT FROM OLD.role THEN
        v_changed := array_append(v_changed, 'role');
        v_old := v_old || jsonb_build_object('role', OLD.role);
        v_new := v_new || jsonb_build_object('role', NEW.role);
    END IF;
    IF NEW.plan IS DISTINCT FROM OLD.plan THEN
        v_changed := array_append(v_changed, 'plan');
        v_old := v_old || jsonb_build_object('plan', OLD.plan);
        v_new := v_new || jsonb_build_object('plan', NEW.plan);
    END IF;
    IF NEW.subscription_status IS DISTINCT FROM OLD.subscription_status THEN
        v_changed := array_append(v_changed, 'subscription_status');
        v_old := v_old || jsonb_build_object('subscription_status', OLD.subscription_status);
        v_new := v_new || jsonb_build_object('subscription_status', NEW.subscription_status);
    END IF;
    IF NEW.subscription_period_end IS DISTINCT FROM OLD.subscription_period_end THEN
        v_changed := array_append(v_changed, 'subscription_period_end');
        v_old := v_old || jsonb_build_object('subscription_period_end', OLD.subscription_period_end);
        v_new := v_new || jsonb_build_object('subscription_period_end', NEW.subscription_period_end);
    END IF;
    IF NEW.stripe_customer_id IS DISTINCT FROM OLD.stripe_customer_id THEN
        v_changed := array_append(v_changed, 'stripe_customer_id');
        v_old := v_old || jsonb_build_object('stripe_customer_id', OLD.stripe_customer_id);
        v_new := v_new || jsonb_build_object('stripe_customer_id', NEW.stripe_customer_id);
    END IF;
    IF NEW.stripe_subscription_id IS DISTINCT FROM OLD.stripe_subscription_id THEN
        v_changed := array_append(v_changed, 'stripe_subscription_id');
        v_old := v_old || jsonb_build_object('stripe_subscription_id', OLD.stripe_subscription_id);
        v_new := v_new || jsonb_build_object('stripe_subscription_id', NEW.stripe_subscription_id);
    END IF;
    IF NEW.stripe_price_id IS DISTINCT FROM OLD.stripe_price_id THEN
        v_changed := array_append(v_changed, 'stripe_price_id');
        v_old := v_old || jsonb_build_object('stripe_price_id', OLD.stripe_price_id);
        v_new := v_new || jsonb_build_object('stripe_price_id', NEW.stripe_price_id);
    END IF;

    IF array_length(v_changed, 1) IS NULL THEN
        RETURN NEW;  -- nothing tracked changed; skip the audit row entirely
    END IF;

    INSERT INTO public.user_profiles_audit (
        target_user_id, changed_by_uid, changed_by_role,
        operation, source, changed_columns,
        old_values, new_values, reason, request_origin
    ) VALUES (
        NEW.id, v_actor_uid, v_actor_role,
        'UPDATE', v_source, v_changed,
        v_old, v_new, v_reason, v_origin
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_audit_user_profile_changes ON public.user_profiles;
CREATE TRIGGER trg_audit_user_profile_changes
    AFTER INSERT OR UPDATE OR DELETE ON public.user_profiles
    FOR EACH ROW EXECUTE FUNCTION public.audit_user_profile_changes();


-- ── 5. Patch the existing lockdown trigger to honour the audited RPCs ─
-- The original lockdown blocks plan/role/stripe_* changes from anyone
-- but service_role. We extend it so an authenticated request that has
-- explicitly opted in (via SET LOCAL app.allow_protected_update = 'true'
-- inside an audited RPC) is also allowed through. Outside of that path,
-- the lockdown is unchanged.
CREATE OR REPLACE FUNCTION public.lock_user_profile_protected_columns()
RETURNS TRIGGER AS $$
DECLARE
    caller_role         TEXT;
    explicit_allow      TEXT;
BEGIN
    caller_role := current_setting('request.jwt.claims', true)::jsonb->>'role';

    -- service_role + the rare "no JWT at all" admin-script path: bypass.
    IF caller_role = 'service_role' OR caller_role IS NULL THEN
        RETURN NEW;
    END IF;

    -- Audited-RPC bypass — the RPC body sets this flag inside the same
    -- transaction. The flag clears at COMMIT/ROLLBACK so it can't leak
    -- to subsequent statements on the same connection.
    BEGIN explicit_allow := current_setting('app.allow_protected_update', true);
    EXCEPTION WHEN OTHERS THEN explicit_allow := NULL; END;
    IF explicit_allow = 'true' THEN
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


-- ── 6. promote_user(p_user_id, p_new_role) ───────────────────────────
-- Role mutation RPC. Two callers:
--   * admin       → may set role IN ('user', 'tester') only.
--                   Cannot touch other admins. Cannot promote to admin.
--   * superadmin  → may set role IN ('user', 'tester', 'admin').
--                   Cannot mint new superadmins (SQL Editor only).
--                   Cannot demote themselves (last-superadmin guard).
--
-- Audit row is written by the AFTER trigger; this function just sets
-- the source/reason settings so the trigger captures attribution.
CREATE OR REPLACE FUNCTION public.promote_user(
    p_user_id   UUID,
    p_new_role  TEXT,
    p_reason    TEXT DEFAULT NULL
)
RETURNS TABLE (id UUID, role TEXT, updated_at TIMESTAMPTZ) AS $$
DECLARE
    v_caller_uid   UUID := auth.uid();
    v_caller_role  TEXT;
    v_target_role  TEXT;
    v_remaining_sa INTEGER;
BEGIN
    IF v_caller_uid IS NULL THEN
        RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
    END IF;

    SELECT up.role INTO v_caller_role
        FROM public.user_profiles up WHERE up.id = v_caller_uid;
    SELECT up.role INTO v_target_role
        FROM public.user_profiles up WHERE up.id = p_user_id;
    IF v_target_role IS NULL THEN
        RAISE EXCEPTION 'target user not found' USING ERRCODE = 'P0002';
    END IF;

    -- Only admins and superadmins can call.
    IF v_caller_role NOT IN ('admin', 'superadmin') THEN
        RAISE EXCEPTION 'forbidden: caller is not admin/superadmin'
            USING ERRCODE = '42501';
    END IF;

    -- Validate the requested role.
    IF p_new_role NOT IN ('user', 'tester', 'admin') THEN
        RAISE EXCEPTION 'invalid role: superadmin minting is SQL-only; allowed values are user, tester, admin'
            USING ERRCODE = '22023';
    END IF;

    -- Admin-scope: only user↔tester. Cannot touch admins/superadmins.
    IF v_caller_role = 'admin' THEN
        IF p_new_role NOT IN ('user', 'tester') THEN
            RAISE EXCEPTION 'forbidden: admin may only set role to user or tester'
                USING ERRCODE = '42501';
        END IF;
        IF v_target_role IN ('admin', 'superadmin') THEN
            RAISE EXCEPTION 'forbidden: admin may not demote another admin/superadmin'
                USING ERRCODE = '42501';
        END IF;
    END IF;

    -- Superadmin-scope: cannot demote themselves if they are the last superadmin.
    IF v_caller_role = 'superadmin'
       AND p_user_id = v_caller_uid
       AND p_new_role <> 'superadmin' THEN
        SELECT COUNT(*) INTO v_remaining_sa
            FROM public.user_profiles WHERE role = 'superadmin';
        IF v_remaining_sa <= 1 THEN
            RAISE EXCEPTION 'forbidden: cannot self-demote — you are the last superadmin'
                USING ERRCODE = '42501';
        END IF;
    END IF;

    -- No-op: return current state without touching the row.
    IF v_target_role = p_new_role THEN
        RETURN QUERY SELECT up.id, up.role, up.updated_at
            FROM public.user_profiles up WHERE up.id = p_user_id;
        RETURN;
    END IF;

    -- Mark the audit context so the AFTER trigger attributes correctly,
    -- then bypass the lockdown for this transaction only.
    PERFORM set_config('app.audit_source', 'rpc_promote_user', true);
    PERFORM set_config('app.audit_reason', COALESCE(p_reason, ''), true);
    PERFORM set_config('app.allow_protected_update', 'true', true);

    UPDATE public.user_profiles
       SET role = p_new_role, updated_at = now()
     WHERE id = p_user_id;

    -- Clear the override flag eagerly (also clears at COMMIT, but defensive).
    PERFORM set_config('app.allow_protected_update', 'false', true);

    RETURN QUERY SELECT up.id, up.role, up.updated_at
        FROM public.user_profiles up WHERE up.id = p_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION public.promote_user(UUID, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.promote_user(UUID, TEXT, TEXT) TO authenticated;


-- ── 7. set_user_plan_override(p_user_id, p_plan, p_reason) ───────────
-- Superadmin-only manual plan grant. Reason required (10–500 chars).
-- Used for comp accounts that didn't go through the invite flow, or
-- corrective action when Stripe state diverges from intent.
--
-- Does NOT touch stripe_customer_id / subscription_status — those stay
-- under Stripe-webhook control. The override only flips the `plan`
-- column. If Stripe later sends a webhook update for the same user, it
-- can overwrite this — so use this only for users without a Stripe
-- subscription.
CREATE OR REPLACE FUNCTION public.set_user_plan_override(
    p_user_id  UUID,
    p_new_plan TEXT,
    p_reason   TEXT
)
RETURNS TABLE (id UUID, plan TEXT, updated_at TIMESTAMPTZ) AS $$
DECLARE
    v_caller_uid  UUID := auth.uid();
    v_caller_role TEXT;
    v_target      RECORD;
BEGIN
    IF v_caller_uid IS NULL THEN
        RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
    END IF;

    SELECT up.role INTO v_caller_role
        FROM public.user_profiles up WHERE up.id = v_caller_uid;
    IF v_caller_role IS DISTINCT FROM 'superadmin' THEN
        RAISE EXCEPTION 'forbidden: superadmin only' USING ERRCODE = '42501';
    END IF;

    IF p_new_plan NOT IN ('free', 'basic', 'educator', 'advanced', 'institution', 'enterprise') THEN
        RAISE EXCEPTION 'invalid plan' USING ERRCODE = '22023';
    END IF;

    IF p_reason IS NULL OR length(btrim(p_reason)) < 10 OR length(p_reason) > 500 THEN
        RAISE EXCEPTION 'reason required (10–500 characters)' USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_target FROM public.user_profiles WHERE user_profiles.id = p_user_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'target user not found' USING ERRCODE = 'P0002';
    END IF;

    -- Refuse to override a user with an active Stripe subscription —
    -- that's a Stripe-side problem, not a manual override.
    IF v_target.stripe_subscription_id IS NOT NULL
       AND v_target.subscription_status IN ('active', 'trialing', 'past_due') THEN
        RAISE EXCEPTION 'refused: target has an active Stripe subscription (%) — cancel in Stripe first',
                        v_target.subscription_status
            USING ERRCODE = '0L000';  -- "invalid grantor" — closest fit
    END IF;

    PERFORM set_config('app.audit_source', 'rpc_set_user_plan_override', true);
    PERFORM set_config('app.audit_reason', p_reason, true);
    PERFORM set_config('app.allow_protected_update', 'true', true);

    UPDATE public.user_profiles
       SET plan = p_new_plan, updated_at = now()
     WHERE user_profiles.id = p_user_id;

    PERFORM set_config('app.allow_protected_update', 'false', true);

    RETURN QUERY SELECT up.id, up.plan, up.updated_at
        FROM public.user_profiles up WHERE up.id = p_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION public.set_user_plan_override(UUID, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_user_plan_override(UUID, TEXT, TEXT) TO authenticated;


-- ── 8. recent_role_audit(p_limit) ────────────────────────────────────
-- Superadmin-only read RPC. Joins audit rows to user emails so the
-- dashboard table can show who-did-what without the client running its
-- own auth.users join (which RLS blocks anyway).
CREATE OR REPLACE FUNCTION public.recent_role_audit(p_limit INTEGER DEFAULT 100)
RETURNS TABLE (
    id              BIGINT,
    target_user_id  UUID,
    target_email    TEXT,
    changed_by_uid  UUID,
    changed_by_email TEXT,
    changed_by_role TEXT,
    operation       TEXT,
    source          TEXT,
    changed_columns TEXT[],
    old_values      JSONB,
    new_values      JSONB,
    reason          TEXT,
    created_at      TIMESTAMPTZ
) AS $$
BEGIN
    IF NOT public.is_superadmin() THEN
        RAISE EXCEPTION 'forbidden: superadmin only' USING ERRCODE = '42501';
    END IF;

    p_limit := LEAST(GREATEST(COALESCE(p_limit, 100), 1), 1000);

    RETURN QUERY
        SELECT a.id,
               a.target_user_id,
               tu.email AS target_email,
               a.changed_by_uid,
               cu.email AS changed_by_email,
               a.changed_by_role,
               a.operation,
               a.source,
               a.changed_columns,
               a.old_values,
               a.new_values,
               a.reason,
               a.created_at
          FROM public.user_profiles_audit a
     LEFT JOIN auth.users tu ON tu.id = a.target_user_id
     LEFT JOIN auth.users cu ON cu.id = a.changed_by_uid
      ORDER BY a.created_at DESC
         LIMIT p_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

REVOKE ALL ON FUNCTION public.recent_role_audit(INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.recent_role_audit(INTEGER) TO authenticated;


-- ── 9. list_users_for_admin(p_limit, p_offset) ───────────────────────
-- Admin/superadmin user-management listing. Returns role + plan for
-- every user, so the management UI can render the table without each
-- row firing its own RLS-checked query. is_admin() already gates
-- SELECT on user_profiles for admins, but joining auth.users for
-- email is RLS-blocked from the client — this RPC bridges the gap.
CREATE OR REPLACE FUNCTION public.list_users_for_admin(
    p_limit  INTEGER DEFAULT 200,
    p_offset INTEGER DEFAULT 0,
    p_search TEXT    DEFAULT NULL
)
RETURNS TABLE (
    id           UUID,
    email        TEXT,
    display_name TEXT,
    role         TEXT,
    plan         TEXT,
    subscription_status TEXT,
    created_at   TIMESTAMPTZ,
    last_seen_at TIMESTAMPTZ
) AS $$
BEGIN
    IF NOT public.is_admin() THEN
        RAISE EXCEPTION 'forbidden: admin only' USING ERRCODE = '42501';
    END IF;

    p_limit  := LEAST(GREATEST(COALESCE(p_limit, 200), 1), 1000);
    p_offset := GREATEST(COALESCE(p_offset, 0), 0);

    RETURN QUERY
        SELECT up.id,
               up.email,
               up.display_name,
               up.role,
               up.plan,
               up.subscription_status,
               up.created_at,
               u.last_sign_in_at AS last_seen_at
          FROM public.user_profiles up
     LEFT JOIN auth.users u ON u.id = up.id
         WHERE p_search IS NULL
            OR up.email ILIKE '%' || p_search || '%'
            OR up.display_name ILIKE '%' || p_search || '%'
      ORDER BY up.created_at DESC
         LIMIT p_limit OFFSET p_offset;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

REVOKE ALL ON FUNCTION public.list_users_for_admin(INTEGER, INTEGER, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_users_for_admin(INTEGER, INTEGER, TEXT) TO authenticated;


-- ═══════════════════════════════════════════════════════════════
-- Verification queries
-- ═══════════════════════════════════════════════════════════════
-- 1. is_superadmin() returns the correct boolean for the calling user:
--      SELECT public.is_superadmin();
--
-- 2. Self-mutation of role still blocked for normal users:
--      UPDATE public.user_profiles SET role='admin' WHERE id = auth.uid();
--    Expected: 42501 / "protected_column: user_profiles.role …"
--
-- 3. Admin promoting a user → tester succeeds and writes one audit row:
--      SELECT public.promote_user('<some-user-uuid>'::uuid, 'tester',
--             'evaluating educator features');
--      SELECT * FROM public.recent_role_audit(5);  -- as superadmin
--
-- 4. Admin attempting to promote to admin is rejected:
--      SELECT public.promote_user('<user-uuid>'::uuid, 'admin', 'why');
--    Expected (called as admin): 42501 "admin may only set role to user or tester"
--
-- 5. Superadmin self-demotion attempt blocked when they are the last:
--      SELECT public.promote_user(auth.uid(), 'admin', 'rotating');
--    Expected (only one superadmin): 42501 "last superadmin"
--
-- 6. set_user_plan_override requires reason ≥ 10 chars:
--      SELECT public.set_user_plan_override('<uuid>'::uuid, 'educator', 'short');
--    Expected: 22023 "reason required (10–500 characters)"
--
-- 7. set_user_plan_override on a Stripe-active user is refused:
--      Run on someone with subscription_status='active' — expect 0L000.
--
-- 8. Stripe webhook plan grant (service_role) still succeeds and
--    writes one audit row with source='system'.
-- ═══════════════════════════════════════════════════════════════


-- ═══════════════ FEATURE: solar-wind ═══════════════

-- ═══════════════════════════════════════════════════════════════
-- Parker Physics — Solar Wind Samples (run in Supabase SQL Editor)
-- ═══════════════════════════════════════════════════════════════
-- Ring-buffer storage for NOAA DSCOVR/ACE real-time solar wind so
-- every visitor reads the same cached row instead of hammering
-- NOAA's WAF from their own browser. First instance of the shared
-- "time-series feed" template:
--
--     <feed>_samples     — ring buffer (this file)
--     trim_<feed>_samples()
--     refresh_<feed>()   — pg_cron writer  (separate file per feed)
--     record_pipeline_*  — shared heartbeat (pipeline-heartbeat migration)
--     /api/<feed>/latest — Vercel edge reader
--
-- Prerequisites (run in this order, one-time):
--   1. supabase-pipeline-heartbeat-migration.sql
--   2. THIS FILE
--   3. (pg_cron refresh job is scheduled at the bottom of this file)
--
-- Safe to re-run (CREATE … IF NOT EXISTS / CREATE OR REPLACE).
-- ═══════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pg_cron;   -- scheduled jobs
CREATE EXTENSION IF NOT EXISTS http;      -- synchronous HTTP from plpgsql

-- ═══════════════════════════════════════════════════════════════
-- solar_wind_samples
-- ═══════════════════════════════════════════════════════════════
-- One row = one 1-minute reading from NOAA rtsw_wind_1m.json.
-- `observed_at` is the timestamp NOAA reports for the sample (the
-- actual measurement time), not our insert time — so multiple inserts
-- of the same NOAA minute are harmlessly deduped by UNIQUE.
CREATE TABLE IF NOT EXISTS public.solar_wind_samples (
    id            BIGSERIAL PRIMARY KEY,
    observed_at   TIMESTAMPTZ NOT NULL,
    ingested_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    source        TEXT        NOT NULL DEFAULT 'noaa-swpc',
    speed_km_s    DOUBLE PRECISION,
    density_cc    DOUBLE PRECISION,
    temperature_k DOUBLE PRECISION,
    bt_nt         DOUBLE PRECISION,
    bz_nt         DOUBLE PRECISION,
    bx_nt         DOUBLE PRECISION,
    by_nt         DOUBLE PRECISION,
    UNIQUE (observed_at, source)
);

CREATE INDEX IF NOT EXISTS solar_wind_samples_observed_at_idx
    ON public.solar_wind_samples (observed_at DESC);

ALTER TABLE public.solar_wind_samples ENABLE ROW LEVEL SECURITY;
-- No policies = no direct anon/authenticated access. Browsers read via
-- /api/solar-wind/latest (service_role bypasses RLS) and write via the
-- record_solar_wind_sample RPC (SECURITY DEFINER, validates input).

-- ═══════════════════════════════════════════════════════════════
-- trim_solar_wind_samples()
-- ═══════════════════════════════════════════════════════════════
-- 7-day retention: at 1 sample/min that's ~10 080 rows. Called from
-- refresh_solar_wind() after each insert so we don't need a separate
-- cron job for cleanup.
CREATE OR REPLACE FUNCTION public.trim_solar_wind_samples()
RETURNS void AS $$
    DELETE FROM public.solar_wind_samples
     WHERE observed_at < now() - INTERVAL '7 days';
$$ LANGUAGE sql;

-- ═══════════════════════════════════════════════════════════════
-- record_solar_wind_sample(…)
-- ═══════════════════════════════════════════════════════════════
-- Browser write-through endpoint. js/wind-pipeline-feed.js calls this
-- via /api/solar-wind/ingest when pg_cron data ages out — any visitor
-- with the site open keeps the ring buffer warm for everyone. The
-- Vercel edge endpoint runs it with service_role, so no anon grant.
--
-- Validation is strict on purpose: a browser-callable write endpoint
-- without bounds is a free graffiti-board.
--   - observed_at must be within ±10 min of server time
--   - speed_km_s must be a plausible solar wind value (100-3000 km/s)
--   - density_cc, temperature_k, b*_nt accepted if finite & in range
--
-- Returns the inserted id, or NULL on ON CONFLICT DO NOTHING (same
-- minute already ingested by pg_cron — expected, not an error).
CREATE OR REPLACE FUNCTION public.record_solar_wind_sample(
    p_observed_at   TIMESTAMPTZ,
    p_source        TEXT,
    p_speed_km_s    DOUBLE PRECISION,
    p_density_cc    DOUBLE PRECISION  DEFAULT NULL,
    p_temperature_k DOUBLE PRECISION  DEFAULT NULL,
    p_bt_nt         DOUBLE PRECISION  DEFAULT NULL,
    p_bz_nt         DOUBLE PRECISION  DEFAULT NULL,
    p_bx_nt         DOUBLE PRECISION  DEFAULT NULL,
    p_by_nt         DOUBLE PRECISION  DEFAULT NULL
) RETURNS BIGINT AS $$
DECLARE
    inserted_id BIGINT;
    clean_src   TEXT;
BEGIN
    -- Bound the source label so a caller can't stuff arbitrary text.
    clean_src := COALESCE(NULLIF(substring(p_source FROM 1 FOR 32), ''), 'unknown');

    IF p_observed_at IS NULL
       OR p_observed_at > now() + INTERVAL '10 minutes'
       OR p_observed_at < now() - INTERVAL '10 minutes' THEN
        RAISE EXCEPTION 'observed_at out of plausible range: %', p_observed_at;
    END IF;

    IF p_speed_km_s IS NULL
       OR p_speed_km_s < 100
       OR p_speed_km_s > 3000 THEN
        RAISE EXCEPTION 'speed_km_s out of plausible range: %', p_speed_km_s;
    END IF;

    INSERT INTO public.solar_wind_samples
        (observed_at, source, speed_km_s, density_cc, temperature_k, bt_nt, bz_nt, bx_nt, by_nt)
    VALUES
        (p_observed_at, clean_src, p_speed_km_s, p_density_cc, p_temperature_k,
         p_bt_nt, p_bz_nt, p_bx_nt, p_by_nt)
    ON CONFLICT (observed_at, source) DO NOTHING
    RETURNING id INTO inserted_id;

    RETURN inserted_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION public.record_solar_wind_sample(
    TIMESTAMPTZ, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION,
    DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_solar_wind_sample(
    TIMESTAMPTZ, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION,
    DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION
) FROM anon, authenticated;

-- ═══════════════════════════════════════════════════════════════
-- refresh_solar_wind()
-- ═══════════════════════════════════════════════════════════════
-- Primary writer. Polls NOAA rtsw_wind_1m.json via the `http`
-- extension, parses the newest row, inserts it into
-- solar_wind_samples, and pokes the heartbeat.
--
-- Fails loudly (RAISE EXCEPTION) on any upstream hiccup so pg_cron
-- records the failure in cron.job_run_details AND the heartbeat
-- table via record_pipeline_failure(). The refresh function is the
-- only place that knows how to translate NOAA's fill sentinels, so
-- validation lives here rather than in the RPC.
CREATE OR REPLACE FUNCTION public.refresh_solar_wind()
RETURNS BIGINT AS $$
DECLARE
    NOAA_URL   constant text := 'https://services.swpc.noaa.gov/json/rtsw/rtsw_wind_1m.json';
    response_body  text;
    payload_json   jsonb;
    latest_row     jsonb;
    observed       timestamptz;
    speed_v        double precision;
    density_v      double precision;
    temperature_v  double precision;
    bt_v           double precision;
    bz_v           double precision;
    bx_v           double precision;
    by_v           double precision;
    inserted_id    bigint;
    i              int;
BEGIN
    BEGIN
        SELECT content INTO response_body
          FROM http_get(NOAA_URL);
    EXCEPTION WHEN OTHERS THEN
        PERFORM public.record_pipeline_failure('solar_wind', SQLERRM);
        RAISE;
    END;

    IF response_body IS NULL OR length(response_body) < 50 THEN
        PERFORM public.record_pipeline_failure(
            'solar_wind',
            format('empty NOAA response (len=%s)', COALESCE(length(response_body), 0))
        );
        RAISE EXCEPTION 'NOAA rtsw_wind_1m empty response';
    END IF;

    BEGIN
        payload_json := response_body::jsonb;
    EXCEPTION WHEN OTHERS THEN
        PERFORM public.record_pipeline_failure('solar_wind', 'JSON parse failed: ' || SQLERRM);
        RAISE;
    END;

    IF jsonb_typeof(payload_json) <> 'array' OR jsonb_array_length(payload_json) = 0 THEN
        PERFORM public.record_pipeline_failure('solar_wind', 'NOAA payload not a non-empty array');
        RAISE EXCEPTION 'NOAA rtsw_wind_1m: payload not a non-empty array';
    END IF;

    -- Walk backwards from the newest row until we find one with a valid,
    -- positive speed (NOAA sometimes trails a few fill rows at the end).
    FOR i IN REVERSE jsonb_array_length(payload_json) - 1 .. 0 LOOP
        latest_row := payload_json -> i;
        speed_v    := NULLIF((latest_row ->> 'proton_speed'), '')::double precision;
        IF speed_v IS NULL THEN
            speed_v := NULLIF((latest_row ->> 'speed'), '')::double precision;
        END IF;
        -- Filter NOAA fill sentinels
        IF speed_v IS NOT NULL AND speed_v > -9990 AND speed_v < 1e20 AND speed_v > 0 THEN
            EXIT;
        END IF;
        latest_row := NULL;
    END LOOP;

    IF latest_row IS NULL THEN
        PERFORM public.record_pipeline_failure('solar_wind', 'no valid speed in NOAA payload');
        RAISE EXCEPTION 'NOAA rtsw_wind_1m: all rows have fill/invalid speed';
    END IF;

    -- NOAA time_tag is "YYYY-MM-DD HH:MM:SS.ms" (space separator, no tz).
    observed := (replace(latest_row ->> 'time_tag', ' ', 'T') || 'Z')::timestamptz;

    density_v     := NULLIF(latest_row ->> 'proton_density',     '')::double precision;
    IF density_v IS NULL THEN density_v := NULLIF(latest_row ->> 'density', '')::double precision; END IF;
    temperature_v := NULLIF(latest_row ->> 'proton_temperature', '')::double precision;
    IF temperature_v IS NULL THEN temperature_v := NULLIF(latest_row ->> 'temperature', '')::double precision; END IF;
    bt_v          := NULLIF(latest_row ->> 'bt',     '')::double precision;
    bz_v          := NULLIF(latest_row ->> 'bz_gsm', '')::double precision;
    IF bz_v IS NULL THEN bz_v := NULLIF(latest_row ->> 'bz', '')::double precision; END IF;
    bx_v          := NULLIF(latest_row ->> 'bx_gsm', '')::double precision;
    IF bx_v IS NULL THEN bx_v := NULLIF(latest_row ->> 'bx', '')::double precision; END IF;
    by_v          := NULLIF(latest_row ->> 'by_gsm', '')::double precision;
    IF by_v IS NULL THEN by_v := NULLIF(latest_row ->> 'by', '')::double precision; END IF;

    -- Apply NOAA fill sentinel filter to optional fields (invalid → NULL).
    IF density_v     IS NOT NULL AND (density_v     <= -9990 OR density_v     > 1e20) THEN density_v     := NULL; END IF;
    IF temperature_v IS NOT NULL AND (temperature_v <= -9990 OR temperature_v > 1e20) THEN temperature_v := NULL; END IF;
    IF bt_v          IS NOT NULL AND (bt_v          <= -9990 OR bt_v          > 1e20) THEN bt_v          := NULL; END IF;
    IF bz_v          IS NOT NULL AND (bz_v          <= -9990 OR bz_v          > 1e20) THEN bz_v          := NULL; END IF;
    IF bx_v          IS NOT NULL AND (bx_v          <= -9990 OR bx_v          > 1e20) THEN bx_v          := NULL; END IF;
    IF by_v          IS NOT NULL AND (by_v          <= -9990 OR by_v          > 1e20) THEN by_v          := NULL; END IF;

    INSERT INTO public.solar_wind_samples
        (observed_at, source, speed_km_s, density_cc, temperature_k, bt_nt, bz_nt, bx_nt, by_nt)
    VALUES
        (observed, 'noaa-swpc', speed_v, density_v, temperature_v, bt_v, bz_v, bx_v, by_v)
    ON CONFLICT (observed_at, source) DO NOTHING
    RETURNING id INTO inserted_id;

    PERFORM public.trim_solar_wind_samples();
    PERFORM public.record_pipeline_success('solar_wind', 'noaa-swpc');

    RETURN inserted_id;  -- NULL on dedup (same minute already present) is fine
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION public.refresh_solar_wind() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.refresh_solar_wind() FROM anon, authenticated;

-- ═══════════════════════════════════════════════════════════════
-- Schedule: every minute  (NOAA's rtsw_wind_1m cadence)
-- ═══════════════════════════════════════════════════════════════
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'refresh-solar-wind') THEN
        PERFORM cron.unschedule('refresh-solar-wind');
    END IF;
END $$;

SELECT cron.schedule(
    'refresh-solar-wind',
    '* * * * *',
    $cron$ SELECT public.refresh_solar_wind(); $cron$
);

-- ═══════════════════════════════════════════════════════════════
-- Verification
-- ═══════════════════════════════════════════════════════════════
-- 1. Trigger one run manually:
--      SELECT public.refresh_solar_wind();
--
-- 2. Confirm schedule registered:
--      SELECT jobid, schedule, active
--        FROM cron.job WHERE jobname = 'refresh-solar-wind';
--
-- 3. Recent rows landing in the table:
--      SELECT observed_at, speed_km_s, density_cc, bz_nt
--        FROM public.solar_wind_samples
--       ORDER BY observed_at DESC LIMIT 10;
--
-- 4. Heartbeat status:
--      SELECT * FROM public.pipeline_heartbeat
--       WHERE pipeline_name = 'solar_wind';
-- ═══════════════════════════════════════════════════════════════


-- ═══════════════ FEATURE: weather-cache ═══════════════

-- ═══════════════════════════════════════════════════════════════
-- Parker Physics — Weather Grid Cache (run in Supabase SQL Editor)
-- ═══════════════════════════════════════════════════════════════
-- Creates a shared hourly cache of Open-Meteo grid data so every
-- visitor reads from one row instead of each browser hitting the
-- upstream API. Safe to re-run (IF NOT EXISTS).
--
--   weather_grid_cache — history of hourly grid snapshots
--     id           BIGSERIAL primary key
--     fetched_at   when the upstream fetch completed
--     source       provider label (open-meteo, etc.)
--     payload      JSONB array of 648 per-location current-weather objects
--                  (same shape as Open-Meteo's multi-location response)
--
-- Supabase pg_cron inserts one row/hour (see
-- supabase-weather-pgcron-migration.sql). /api/weather/grid returns
-- the newest row to browsers via the CDN.
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.weather_grid_cache (
    id          BIGSERIAL PRIMARY KEY,
    fetched_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    source      TEXT        NOT NULL DEFAULT 'open-meteo',
    payload     JSONB       NOT NULL
);

CREATE INDEX IF NOT EXISTS weather_grid_cache_fetched_at_idx
    ON public.weather_grid_cache (fetched_at DESC);

-- RLS: table is server-only. The refresh/grid edge functions use the
-- service_role key (bypasses RLS). Block all anon/authenticated access so
-- browsers must go through the cached edge endpoint.
ALTER TABLE public.weather_grid_cache ENABLE ROW LEVEL SECURITY;

-- No policies = no rows visible to anon/authenticated roles.
-- (service_role bypasses RLS entirely, so the edge fns still work.)

-- Retention: keep the last 720 hourly rows (30 days — bumped from 72
-- by supabase-weather-cache-retention-migration.sql so Phase 4 NN
-- training has history to learn from; keep the two files in lockstep).
-- Called opportunistically from the refresh endpoint after each insert.
CREATE OR REPLACE FUNCTION public.trim_weather_grid_cache()
RETURNS void AS $$
    DELETE FROM public.weather_grid_cache
    WHERE id NOT IN (
        SELECT id FROM public.weather_grid_cache
        ORDER BY fetched_at DESC
        LIMIT 720
    );
$$ LANGUAGE sql
SET search_path = public, pg_temp;


-- ═══════════════ FEATURE: pipeline-heartbeat ═══════════════

-- ═══════════════════════════════════════════════════════════════
-- Parker Physics — Pipeline Heartbeat (run in Supabase SQL Editor)
-- ═══════════════════════════════════════════════════════════════
-- Shared, modular health-check layer for every time-series pipeline
-- (weather grid, solar wind, and any future feed following the same
-- pattern). Each pg_cron refresh function updates a single row here
-- on success so an operator can answer "is the pipeline alive?" with
-- one query instead of spelunking through cron.job_run_details.
--
-- Why a table, not cron.job_run_details:
--   cron.job_run_details logs every run (success + failure) and is
--   unindexed on jobname. A `SELECT MAX(last_success)` over it scans
--   the whole table. This table stores one row per pipeline — O(1)
--   to query from the UI, easy to expose via RLS for read-only.
--
-- Shape:
--   pipeline_name       text primary key  — stable key, e.g. 'solar_wind'
--   last_success_at     timestamptz       — last successful upstream fetch
--   last_failure_at     timestamptz       — last failed attempt (nullable)
--   last_failure_reason text              — plpgsql error message (nullable)
--   last_source         text              — which upstream won (e.g. 'open-meteo')
--   consecutive_fail    int               — failure streak; resets on success
--   updated_at          timestamptz       — moved by trigger
--
-- Usage inside a refresh function:
--   PERFORM public.record_pipeline_success('solar_wind', 'noaa-swpc');
--   -- or, inside EXCEPTION block:
--   PERFORM public.record_pipeline_failure('solar_wind', SQLERRM);
--
-- Safe to re-run.
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.pipeline_heartbeat (
    pipeline_name        TEXT        PRIMARY KEY,
    last_success_at      TIMESTAMPTZ,
    last_failure_at      TIMESTAMPTZ,
    last_failure_reason  TEXT,
    last_source          TEXT,
    consecutive_fail     INT         NOT NULL DEFAULT 0,
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RLS: anon/authenticated readers get a safe view of health for any
-- public status page; service_role (cron jobs) writes. Nobody outside
-- the server can write.
ALTER TABLE public.pipeline_heartbeat ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pipeline_heartbeat_public_read ON public.pipeline_heartbeat;
CREATE POLICY pipeline_heartbeat_public_read
    ON public.pipeline_heartbeat
    FOR SELECT
    TO anon, authenticated
    USING (true);

-- ═══════════════════════════════════════════════════════════════
-- record_pipeline_success / record_pipeline_failure
-- Small helpers so refresh functions don't each reimplement upsert.
-- ═══════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.record_pipeline_success(
    p_name   TEXT,
    p_source TEXT DEFAULT NULL
) RETURNS void AS $$
    INSERT INTO public.pipeline_heartbeat AS h
        (pipeline_name, last_success_at, last_source, consecutive_fail, updated_at)
    VALUES
        (p_name, now(), p_source, 0, now())
    ON CONFLICT (pipeline_name) DO UPDATE SET
        last_success_at  = now(),
        last_source      = COALESCE(EXCLUDED.last_source, h.last_source),
        consecutive_fail = 0,
        updated_at       = now();
$$ LANGUAGE sql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION public.record_pipeline_failure(
    p_name   TEXT,
    p_reason TEXT DEFAULT NULL
) RETURNS void AS $$
    INSERT INTO public.pipeline_heartbeat AS h
        (pipeline_name, last_failure_at, last_failure_reason, consecutive_fail, updated_at)
    VALUES
        (p_name, now(), p_reason, 1, now())
    ON CONFLICT (pipeline_name) DO UPDATE SET
        last_failure_at     = now(),
        last_failure_reason = p_reason,
        consecutive_fail    = h.consecutive_fail + 1,
        updated_at          = now();
$$ LANGUAGE sql SECURITY DEFINER;

REVOKE ALL ON FUNCTION public.record_pipeline_success(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_pipeline_failure(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_pipeline_success(TEXT, TEXT) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.record_pipeline_failure(TEXT, TEXT) FROM anon, authenticated;

-- ═══════════════════════════════════════════════════════════════
-- Verification
-- ═══════════════════════════════════════════════════════════════
-- 1. After the weather + solar-wind migrations run once, confirm rows:
--      SELECT pipeline_name, last_success_at, last_source, consecutive_fail
--        FROM public.pipeline_heartbeat
--       ORDER BY pipeline_name;
--
-- 2. Health query for the UI / status page:
--      SELECT pipeline_name,
--             EXTRACT(EPOCH FROM (now() - last_success_at))::int AS age_seconds,
--             consecutive_fail,
--             last_failure_reason
--        FROM public.pipeline_heartbeat;
-- ═══════════════════════════════════════════════════════════════


-- ═══════════════ FEATURE: client-telemetry ═══════════════

-- ═══════════════════════════════════════════════════════════════
-- Parker Physics — Client telemetry migration
-- ═══════════════════════════════════════════════════════════════
--
-- Run in Supabase Dashboard → SQL Editor → New Query (idempotent).
--
-- Adds a unified telemetry pipeline so superadmins can see:
--   * JS errors (uncaught exceptions, unhandled rejections)
--   * Auth failures (broader than the existing auth_failures table —
--     OAuth callback errors, session refresh failures, dashboard-gate
--     redirects, RLS denials)
--   * 404s (paths users tried to reach that don't exist)
--   * Web Vitals (LCP, FCP, CLS, INP) per route
--   * App-specific perf marks (WASM init time, dashboard mount, etc.)
--
-- One table with a typed `kind` column, four read RPCs for the admin
-- card top-N panels, an hourly pg_cron pruner, and a SECURITY DEFINER
-- writer RPC the edge function calls.
--
-- The existing `auth_failures` table stays in place — it captures
-- pre-auth signin attempts (no JWT) where the email is HMAC-hashed.
-- This new table captures everything else (post-auth or non-auth
-- failures) where the user_id is known or the event is anonymous but
-- non-PII.
-- ═══════════════════════════════════════════════════════════════


-- ── 1. Table ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.client_telemetry (
    id          BIGSERIAL PRIMARY KEY,
    kind        TEXT NOT NULL CHECK (kind IN (
                    'error',          -- uncaught exception / unhandled rejection
                    'auth_failure',   -- post-auth or non-credential auth failure
                    'not_found',      -- 404.html load or broken-link click
                    'redirect',       -- requireAuth() bounced to signin
                    'web_vital',      -- LCP / FCP / CLS / INP
                    'app_perf'        -- custom mark (wasm_init, dashboard_mount, etc.)
                )),
    severity    TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warning','error')),
    route       TEXT,                                       -- pathname only — query string stripped client-side
    user_id     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    session_id  TEXT,                                       -- browser-generated, sessionStorage-scoped
    metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,         -- kind-specific payload (see below)
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- metadata shape per kind (informational; not enforced):
--   error        → { fingerprint, message, stack (scrubbed), source, line, col }
--   auth_failure → { reason, provider?, code?, source: 'oauth_callback' | 'refresh' | ... }
--   not_found    → { referrer? }
--   redirect     → { from, to, reason }
--   web_vital    → { name: 'LCP'|'FCP'|'CLS'|'INP', value, rating: 'good'|'ni'|'poor' }
--   app_perf     → { name, value_ms }

-- Hot-path indexes — admin card queries always filter by kind + window
-- and group by metadata->>'fingerprint' (errors) or route (404s, vitals).
CREATE INDEX IF NOT EXISTS idx_client_telemetry_kind_time
    ON public.client_telemetry (kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_client_telemetry_user
    ON public.client_telemetry (user_id, created_at DESC)
    WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_client_telemetry_route
    ON public.client_telemetry (route, kind, created_at DESC)
    WHERE route IS NOT NULL;
-- Errors deduplicate by fingerprint — separate functional index on the
-- JSONB key so the top-N query stays fast as the table grows.
CREATE INDEX IF NOT EXISTS idx_client_telemetry_error_fp
    ON public.client_telemetry ((metadata->>'fingerprint'), created_at DESC)
    WHERE kind = 'error';


-- ── 2. RLS — superadmin reads only; writes via SECURITY DEFINER RPC ──
ALTER TABLE public.client_telemetry ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Superadmin can view client telemetry" ON public.client_telemetry;
CREATE POLICY "Superadmin can view client telemetry"
    ON public.client_telemetry FOR SELECT
    USING (public.is_superadmin());

-- No INSERT/UPDATE/DELETE policies — direct writes denied. The edge
-- function calls log_client_telemetry() with service_role, which
-- bypasses RLS. Pruner is service_role too.


-- ── 3. log_client_telemetry() — batched writer for the edge endpoint ─
-- Accepts an array of events as JSONB. Returns the number of rows
-- inserted. Edge function is responsible for rate-limiting + JWT
-- verification BEFORE calling this — the RPC trusts its inputs.
--
-- Why an RPC instead of letting the edge function INSERT directly?
-- Two reasons:
--   1. Bounds-check the kind/severity values server-side so a buggy
--      client can't insert garbage that breaks downstream queries.
--   2. Truncate over-long fields (route 256 chars, metadata 4 KB).
CREATE OR REPLACE FUNCTION public.log_client_telemetry(
    p_events JSONB,           -- array of event objects
    p_user_id UUID DEFAULT NULL
)
RETURNS INTEGER AS $$
DECLARE
    v_event JSONB;
    v_inserted INTEGER := 0;
    v_kind TEXT;
    v_severity TEXT;
    v_route TEXT;
    v_session_id TEXT;
    v_metadata JSONB;
BEGIN
    IF jsonb_typeof(p_events) <> 'array' THEN
        RAISE EXCEPTION 'p_events must be a JSONB array' USING ERRCODE = '22023';
    END IF;

    FOR v_event IN SELECT * FROM jsonb_array_elements(p_events)
    LOOP
        v_kind := v_event->>'kind';
        IF v_kind NOT IN ('error','auth_failure','not_found','redirect','web_vital','app_perf') THEN
            CONTINUE;  -- skip silently; one bad event shouldn't fail the batch
        END IF;

        v_severity := COALESCE(v_event->>'severity', 'info');
        IF v_severity NOT IN ('info','warning','error') THEN
            v_severity := 'info';
        END IF;

        v_route := LEFT(COALESCE(v_event->>'route', ''), 256);
        IF v_route = '' THEN v_route := NULL; END IF;

        v_session_id := LEFT(COALESCE(v_event->>'session_id', ''), 64);
        IF v_session_id = '' THEN v_session_id := NULL; END IF;

        -- Truncate over-large metadata payloads. 4 KB is plenty for a
        -- scrubbed stack + fingerprint; anything bigger is suspicious.
        v_metadata := COALESCE(v_event->'metadata', '{}'::jsonb);
        IF length(v_metadata::text) > 4096 THEN
            v_metadata := jsonb_build_object(
                'truncated', true,
                'original_size', length(v_metadata::text),
                'fingerprint', COALESCE(v_metadata->>'fingerprint', 'unknown'),
                'message', LEFT(COALESCE(v_metadata->>'message', ''), 256)
            );
        END IF;

        INSERT INTO public.client_telemetry
            (kind, severity, route, user_id, session_id, metadata)
        VALUES
            (v_kind, v_severity, v_route, p_user_id, v_session_id, v_metadata);
        v_inserted := v_inserted + 1;
    END LOOP;

    RETURN v_inserted;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION public.log_client_telemetry(JSONB, UUID) FROM PUBLIC;
-- service_role only — granted via the edge function. authenticated
-- callers cannot invoke directly; they go through the rate-limited
-- /api/telemetry/log endpoint.
GRANT EXECUTE ON FUNCTION public.log_client_telemetry(JSONB, UUID) TO service_role;


-- ── 4. Read RPCs — top-N panels for the superadmin Telemetry tab ─────

-- 4a. Top-N JS error fingerprints in the window.
-- Returns count, first/last seen, sample message + stack for each
-- distinct fingerprint. Errors with NULL fingerprint are bucketed
-- together as "(unfingerprinted)".
CREATE OR REPLACE FUNCTION public.telemetry_top_errors(
    p_days  INTEGER DEFAULT 30,
    p_limit INTEGER DEFAULT 25
)
RETURNS TABLE (
    fingerprint    TEXT,
    occurrences    BIGINT,
    distinct_users BIGINT,
    distinct_routes BIGINT,
    first_seen     TIMESTAMPTZ,
    last_seen      TIMESTAMPTZ,
    sample_message TEXT,
    sample_route   TEXT,
    sample_stack   TEXT
) AS $$
BEGIN
    IF NOT public.is_superadmin() THEN
        RAISE EXCEPTION 'forbidden: superadmin only' USING ERRCODE = '42501';
    END IF;
    p_days  := LEAST(GREATEST(COALESCE(p_days, 30), 1), 180);
    p_limit := LEAST(GREATEST(COALESCE(p_limit, 25), 1), 200);

    RETURN QUERY
        SELECT COALESCE(t.metadata->>'fingerprint', '(unfingerprinted)') AS fingerprint,
               COUNT(*)                                AS occurrences,
               COUNT(DISTINCT t.user_id)               AS distinct_users,
               COUNT(DISTINCT t.route)                 AS distinct_routes,
               MIN(t.created_at)                       AS first_seen,
               MAX(t.created_at)                       AS last_seen,
               (array_agg(t.metadata->>'message' ORDER BY t.created_at DESC))[1]   AS sample_message,
               (array_agg(t.route                ORDER BY t.created_at DESC))[1]   AS sample_route,
               (array_agg(t.metadata->>'stack'   ORDER BY t.created_at DESC))[1]   AS sample_stack
          FROM public.client_telemetry t
         WHERE t.kind = 'error'
           AND t.created_at > now() - (p_days || ' days')::interval
         GROUP BY 1
         ORDER BY occurrences DESC
         LIMIT p_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

REVOKE ALL ON FUNCTION public.telemetry_top_errors(INTEGER, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.telemetry_top_errors(INTEGER, INTEGER) TO authenticated;


-- 4b. Top-N auth failure reasons in the window.
-- UNIONs the new client_telemetry auth_failure events WITH the
-- existing auth_failures table (signin failures), so the panel shows
-- a complete top-N across both pre-auth and post-auth failures.
CREATE OR REPLACE FUNCTION public.telemetry_top_auth_failures(
    p_days  INTEGER DEFAULT 30,
    p_limit INTEGER DEFAULT 15
)
RETURNS TABLE (
    reason          TEXT,
    source          TEXT,
    occurrences     BIGINT,
    distinct_actors BIGINT,
    last_seen       TIMESTAMPTZ
) AS $$
DECLARE
    v_has_auth_failures BOOLEAN := to_regclass('public.auth_failures') IS NOT NULL;
BEGIN
    IF NOT public.is_superadmin() THEN
        RAISE EXCEPTION 'forbidden: superadmin only' USING ERRCODE = '42501';
    END IF;
    p_days  := LEAST(GREATEST(COALESCE(p_days, 30), 1), 180);
    p_limit := LEAST(GREATEST(COALESCE(p_limit, 15), 1), 100);

    IF v_has_auth_failures THEN
        RETURN QUERY
        WITH combined AS (
            SELECT COALESCE(t.metadata->>'reason', '(no reason)')        AS reason,
                   COALESCE(t.metadata->>'source', 'client_telemetry')   AS source,
                   t.user_id::text                                       AS actor,
                   t.created_at
              FROM public.client_telemetry t
             WHERE t.kind = 'auth_failure'
               AND t.created_at > now() - (p_days || ' days')::interval
            UNION ALL
            SELECT COALESCE(af.reason, '(no reason)')                    AS reason,
                   'signin_endpoint'                                     AS source,
                   af.email_hash                                         AS actor,
                   af.created_at
              FROM public.auth_failures af
             WHERE af.created_at > now() - (p_days || ' days')::interval
        )
        SELECT c.reason,
               c.source,
               COUNT(*)                  AS occurrences,
               COUNT(DISTINCT c.actor)   AS distinct_actors,
               MAX(c.created_at)         AS last_seen
          FROM combined c
         GROUP BY 1, 2
         ORDER BY occurrences DESC
         LIMIT p_limit;
    ELSE
        RETURN QUERY
        SELECT COALESCE(t.metadata->>'reason', '(no reason)')        AS reason,
               COALESCE(t.metadata->>'source', 'client_telemetry')   AS source,
               COUNT(*)                  AS occurrences,
               COUNT(DISTINCT t.user_id::text) AS distinct_actors,
               MAX(t.created_at)         AS last_seen
          FROM public.client_telemetry t
         WHERE t.kind = 'auth_failure'
           AND t.created_at > now() - (p_days || ' days')::interval
         GROUP BY 1, 2
         ORDER BY occurrences DESC
         LIMIT p_limit;
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

REVOKE ALL ON FUNCTION public.telemetry_top_auth_failures(INTEGER, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.telemetry_top_auth_failures(INTEGER, INTEGER) TO authenticated;


-- 4c. Top-N 404 paths in the window.
CREATE OR REPLACE FUNCTION public.telemetry_top_404s(
    p_days  INTEGER DEFAULT 30,
    p_limit INTEGER DEFAULT 25
)
RETURNS TABLE (
    route       TEXT,
    occurrences BIGINT,
    distinct_sessions BIGINT,
    last_seen   TIMESTAMPTZ
) AS $$
BEGIN
    IF NOT public.is_superadmin() THEN
        RAISE EXCEPTION 'forbidden: superadmin only' USING ERRCODE = '42501';
    END IF;
    p_days  := LEAST(GREATEST(COALESCE(p_days, 30), 1), 180);
    p_limit := LEAST(GREATEST(COALESCE(p_limit, 25), 1), 200);

    RETURN QUERY
        SELECT t.route,
               COUNT(*)                          AS occurrences,
               COUNT(DISTINCT t.session_id)      AS distinct_sessions,
               MAX(t.created_at)                 AS last_seen
          FROM public.client_telemetry t
         WHERE t.kind = 'not_found'
           AND t.created_at > now() - (p_days || ' days')::interval
           AND t.route IS NOT NULL
         GROUP BY t.route
         ORDER BY occurrences DESC
         LIMIT p_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

REVOKE ALL ON FUNCTION public.telemetry_top_404s(INTEGER, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.telemetry_top_404s(INTEGER, INTEGER) TO authenticated;


-- 4d. Web Vitals + app perf summary — p50/p95 per metric per route.
-- Returns one row per (metric, route) pair with quantiles in ms.
-- LCP / FCP / INP / app_perf values are milliseconds; CLS is unitless
-- (multiplied by 1000 here so a single numeric column works).
CREATE OR REPLACE FUNCTION public.telemetry_perf_summary(
    p_days  INTEGER DEFAULT 7,
    p_limit INTEGER DEFAULT 50
)
RETURNS TABLE (
    metric_name TEXT,
    route       TEXT,
    samples     BIGINT,
    p50         NUMERIC,
    p95         NUMERIC,
    poor_count  BIGINT
) AS $$
BEGIN
    IF NOT public.is_superadmin() THEN
        RAISE EXCEPTION 'forbidden: superadmin only' USING ERRCODE = '42501';
    END IF;
    p_days  := LEAST(GREATEST(COALESCE(p_days, 7), 1), 90);
    p_limit := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 500);

    RETURN QUERY
        SELECT (t.metadata->>'name')                         AS metric_name,
               t.route                                       AS route,
               COUNT(*)                                      AS samples,
               ROUND(percentile_cont(0.50) WITHIN GROUP (
                   ORDER BY (t.metadata->>'value')::NUMERIC) * 1.0, 2)  AS p50,
               ROUND(percentile_cont(0.95) WITHIN GROUP (
                   ORDER BY (t.metadata->>'value')::NUMERIC) * 1.0, 2)  AS p95,
               COUNT(*) FILTER (WHERE t.metadata->>'rating' = 'poor')   AS poor_count
          FROM public.client_telemetry t
         WHERE t.kind IN ('web_vital','app_perf')
           AND t.created_at > now() - (p_days || ' days')::interval
           AND t.metadata->>'name'  IS NOT NULL
           AND t.metadata->>'value' IS NOT NULL
         GROUP BY 1, 2
         HAVING COUNT(*) >= 5  -- noise floor — single-sample rows aren't useful
         ORDER BY samples DESC
         LIMIT p_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

REVOKE ALL ON FUNCTION public.telemetry_perf_summary(INTEGER, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.telemetry_perf_summary(INTEGER, INTEGER) TO authenticated;


-- ── 5. Optional: pg_cron retention pruner ───────────────────────────
-- Errors / 404s / auth failures: 30 days. Web vitals / app perf: 14
-- days (high volume, low forensic value beyond a couple weeks).
-- Skipped if pg_cron isn't installed — apply
-- supabase-weather-pgcron-migration.sql first.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
        RAISE NOTICE 'pg_cron not installed — skipping client_telemetry retention schedule.';
        RETURN;
    END IF;

    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'prune-client-telemetry-vitals') THEN
        PERFORM cron.unschedule('prune-client-telemetry-vitals');
    END IF;
    PERFORM cron.schedule(
        'prune-client-telemetry-vitals',
        '47 * * * *',         -- 47 past every hour (off-peak from existing pruners)
        $cron$
            DELETE FROM public.client_telemetry
             WHERE kind IN ('web_vital','app_perf')
               AND created_at < now() - interval '14 days';
        $cron$
    );

    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'prune-client-telemetry-errors') THEN
        PERFORM cron.unschedule('prune-client-telemetry-errors');
    END IF;
    PERFORM cron.schedule(
        'prune-client-telemetry-errors',
        '52 * * * *',
        $cron$
            DELETE FROM public.client_telemetry
             WHERE kind IN ('error','auth_failure','not_found','redirect')
               AND created_at < now() - interval '30 days';
        $cron$
    );
END $$;


-- ═══════════════════════════════════════════════════════════════
-- Verification queries
-- ═══════════════════════════════════════════════════════════════
-- 1. Direct INSERT MUST be denied for authenticated users:
--      INSERT INTO public.client_telemetry (kind, route, metadata)
--        VALUES ('error', '/test', '{}'::jsonb);
--    Expected: 42501 / new row violates row-level security policy.
--
-- 2. log_client_telemetry rejects unauthenticated authenticated calls:
--      SELECT public.log_client_telemetry(
--          '[{"kind":"error","route":"/x","metadata":{}}]'::jsonb);
--    Expected from authenticated: permission denied (function execute).
--    Expected from service_role: returns 1.
--
-- 3. Top-N RPCs gated to superadmin:
--      As admin (not super):  SELECT public.telemetry_top_errors(7, 5);
--      Expected: 42501 / "forbidden: superadmin only".
--
-- 4. Round-trip via the edge function:
--      curl -X POST https://parkersphysics.com/api/telemetry/log \
--           -H "Content-Type: application/json" \
--           -d '{"events":[{"kind":"error","route":"/test",
--                "metadata":{"fingerprint":"E:test:1","message":"hello"}}]}'
--      → 200 { ok: true, accepted: 1 }
--      Then: SELECT * FROM public.telemetry_top_errors(1, 5);
--      → row with fingerprint='E:test:1'.
--
-- 5. Cron jobs registered (after running this migration once):
--      SELECT jobname, schedule FROM cron.job
--       WHERE jobname LIKE 'prune-client-telemetry-%';
--      → 2 rows.
-- ═══════════════════════════════════════════════════════════════


-- ═══════════════ FEATURE: auth-failures ═══════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- supabase-auth-failures-migration.sql
--
-- Captures failed sign-in attempts so the admin Onboarding > Auth flow
-- card can show a real failure rate instead of the retry-count proxy
-- it's been using.
--
-- Why a separate table?
--   activation_events has FK auth.users(id) and RLS that requires
--   auth.uid() = user_id for every insert. A failed sign-in has, by
--   definition, no auth.uid() — Supabase Auth never minted a JWT.
--   We can't just bend the RLS open because that would let any visitor
--   write to activation_events. The clean separation: a no-FK,
--   no-RLS-write table fed only by a SECURITY DEFINER RPC that the
--   edge function calls with the service-role key.
--
-- Privacy:
--   We never store the plaintext email. The edge function hashes the
--   email with a server-side pepper (HMAC-SHA-256) before calling the
--   RPC; the table only ever sees the digest. Operators can still
--   count "distinct emails that failed" via COUNT(DISTINCT email_hash)
--   because the same plaintext always produces the same digest, but
--   they cannot reverse-engineer who tried to log in.
--
-- Idempotent. Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.auth_failures (
    id          BIGSERIAL PRIMARY KEY,
    email_hash  TEXT NOT NULL,           -- HMAC-SHA-256(email, pepper)
    reason      TEXT,                    -- supabase error message, truncated to 200ch
    ua_short    TEXT,                    -- first 80 chars of User-Agent (for OS/browser bucket)
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_auth_failures_email_time
    ON public.auth_failures(email_hash, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_auth_failures_time
    ON public.auth_failures(created_at DESC);

ALTER TABLE public.auth_failures ENABLE ROW LEVEL SECURITY;

-- Read: admins only. The table is privacy-sensitive (it's a list of
-- failed login attempts) so locking SELECT down to admin is the safe
-- default; the edge function uses the service-role key for inserts so
-- no INSERT policy is needed.
DROP POLICY IF EXISTS "Admins read auth failures" ON public.auth_failures;
CREATE POLICY "Admins read auth failures"
    ON public.auth_failures FOR SELECT
    USING (public.is_admin());


-- ── log_auth_failure RPC ───────────────────────────────────────────────────
-- Called by the edge function api/auth/log-failure. Rate-limits per
-- email_hash to keep an attacker from flooding the table with garbage.
-- Returns true on insert, false on rate-limit or invalid input.
--
-- The rate limit is intentionally loose (10 / hour / hash) — we want
-- to capture genuine retry storms, not throttle them. Real abuse
-- patterns (one-attacker-many-emails) get caught at the edge by the
-- service-key + origin allow-list.

CREATE OR REPLACE FUNCTION public.log_auth_failure(
    p_email_hash TEXT,
    p_reason     TEXT DEFAULT NULL,
    p_ua_short   TEXT DEFAULT NULL,
    p_limit      INT  DEFAULT 10
) RETURNS BOOLEAN AS $$
DECLARE
    v_recent INT;
BEGIN
    IF p_email_hash IS NULL OR length(p_email_hash) < 16 THEN
        RETURN FALSE;
    END IF;

    SELECT COUNT(*) INTO v_recent
      FROM public.auth_failures
     WHERE email_hash = p_email_hash
       AND created_at > now() - INTERVAL '1 hour';

    IF v_recent >= p_limit THEN
        RETURN FALSE;
    END IF;

    INSERT INTO public.auth_failures (email_hash, reason, ua_short)
    VALUES (p_email_hash, LEFT(COALESCE(p_reason, ''), 200), LEFT(COALESCE(p_ua_short, ''), 80));
    RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Anon executes via the service-role key in the edge function, so we
-- don't grant authenticated EXECUTE here — only the service role can
-- call it (default for SECURITY DEFINER + REVOKE on PUBLIC).
REVOKE ALL ON FUNCTION public.log_auth_failure(TEXT, TEXT, TEXT, INT) FROM PUBLIC;


-- ── Refresh auth_flow_metrics() to UNION in the failure counts ─────────────
-- The activation_events branch keeps reading the same five events it
-- did before (signup, signin_succeeded, returning_user_session,
-- welcome_email_sent — and signin_failed, which never has rows there
-- but is harmless to keep in the IN-list). The auth_failures branch
-- is added below it so the JS fetcher sees a single 'signin_failed'
-- row with real numbers.
--
-- Distinct-user count for failures is COUNT(DISTINCT email_hash) —
-- so a user who failed five times and finally succeeded counts as
-- one in both signinSuccesses and signinFailures, which is exactly
-- what the admin card wants ("how many distinct people hit a failure?").

CREATE OR REPLACE FUNCTION public.auth_flow_metrics(p_days INT DEFAULT 30)
RETURNS TABLE(
    event       TEXT,
    user_count  BIGINT,
    event_count BIGINT
) AS $$
    SELECT event,
           COUNT(DISTINCT user_id)  AS user_count,
           COUNT(*)                 AS event_count
      FROM public.activation_events
     WHERE event IN ('signup',
                     'signin_succeeded',
                     'returning_user_session',
                     'welcome_email_sent')
       AND created_at > now() - (p_days || ' days')::interval
     GROUP BY event
    UNION ALL
    SELECT 'signin_failed'                  AS event,
           COUNT(DISTINCT email_hash)       AS user_count,
           COUNT(*)                         AS event_count
      FROM public.auth_failures
     WHERE created_at > now() - (p_days || ' days')::interval
    ORDER BY event;
$$ LANGUAGE sql SECURITY DEFINER STABLE;

GRANT EXECUTE ON FUNCTION public.auth_flow_metrics(INT) TO authenticated;


-- Smoke test (run after applying):
--   -- Manual fail row (replace HMAC_DIGEST with a 64-char hex string):
--   SELECT public.log_auth_failure('a'||repeat('b',63), 'invalid_credentials', 'Mozilla/5.0…');
--   -- Should populate the admin card with one user_count for signin_failed:
--   SELECT * FROM public.auth_flow_metrics(30);


-- ═══════════════ FEATURE: feedback ═══════════════

-- ──────────────────────────────────────────────────────────────────────
-- Feedback submissions — feature requests + bug reports from /feedback
-- Backs the public POST /api/contact/feedback endpoint. Anonymous insert
-- is allowed (the form is unauthenticated); admins read + update.
-- ──────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.feedback_submissions (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kind         TEXT NOT NULL CHECK (kind IN ('feature_request','bug_report','general')),
    page         TEXT,
    subject      TEXT NOT NULL,
    message      TEXT NOT NULL,
    email        TEXT,
    url          TEXT,
    source_ip    TEXT,
    user_agent   TEXT,
    status       TEXT DEFAULT 'new' CHECK (status IN ('new','triaged','in_progress','shipped','wont_fix','duplicate')),
    notes        TEXT,
    triaged_at   TIMESTAMPTZ,
    created_at   TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.feedback_submissions ENABLE ROW LEVEL SECURITY;

-- Public anonymous insert allowed (the feedback form is unauthenticated).
-- Length caps and email-shape validation are duplicated at the edge
-- function; this RLS check is the second line of defense.
DROP POLICY IF EXISTS "Public can submit feedback" ON public.feedback_submissions;
CREATE POLICY "Public can submit feedback"
    ON public.feedback_submissions FOR INSERT
    WITH CHECK (
        kind IN ('feature_request','bug_report','general')
        AND length(subject) BETWEEN 1 AND 160
        AND length(message) BETWEEN 1 AND 4000
        AND (page IS NULL OR length(page) <= 80)
        AND (email IS NULL OR (length(email) BETWEEN 5 AND 200 AND email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'))
        AND (url IS NULL OR length(url) <= 500)
        AND (user_agent IS NULL OR length(user_agent) <= 300)
    );

DROP POLICY IF EXISTS "Admins read feedback" ON public.feedback_submissions;
CREATE POLICY "Admins read feedback"
    ON public.feedback_submissions FOR SELECT
    USING (public.is_admin());

DROP POLICY IF EXISTS "Admins update feedback" ON public.feedback_submissions;
CREATE POLICY "Admins update feedback"
    ON public.feedback_submissions FOR UPDATE
    USING (public.is_admin());

CREATE INDEX IF NOT EXISTS idx_feedback_submissions_created
    ON public.feedback_submissions(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_feedback_submissions_kind_status
    ON public.feedback_submissions(kind, status, created_at DESC);


-- ═══════════════ FEATURE: forecast-accumulator ═══════════════

-- ═══════════════════════════════════════════════════════════════
-- Parker Physics — Forecast Accumulator (run in Supabase SQL Editor)
-- ═══════════════════════════════════════════════════════════════
-- Append-only event store for every prediction we make, paired with
-- the observation that arrived for that prediction. The "Phase 0
-- accumulator" from EARTH_ML_FIRST_PRINCIPLES.md, scoped to the
-- minimum needed to unblock analog forecasting, the NN residual-
-- correction track, and the skill leaderboard endpoint.
--
-- Three tables:
--   forecaster_registry          — model_id → human metadata
--   forecast_log                 — hot, 7-day ring; one row per
--                                  (made_at, valid_at, cell, field,
--                                   model). Backfilled with `observation`
--                                  when the validator sees the obs.
--   forecast_archive_pointer     — daily archives offloaded to R2,
--                                  one row per (day, file) so replay
--                                  knows where to look.
--
-- Privacy note: lat/lon are rounded to 0.5° at insert by the RPC.
-- A user pinning the picker at their house is logged at the nearest
-- 55 km grid cell, never the actual point.
--
-- Volume note: the writer-side throttle (one POST per 10 s per
-- client, batched ≤100 records) plus rounding to a 0.5° grid keeps
-- the hot table to a few thousand rows/day at expected usage. The
-- archive cron drains rows older than 7 d to R2; trim_forecast_log()
-- removes archived rows so the hot table stays bounded.
--
-- Prerequisites:
--   1. supabase-bootstrap-fresh.sql (or an existing public schema)
--   2. (optional) supabase-pipeline-heartbeat-migration.sql for
--      heartbeat integration in the archive cron (PR #2).
--
-- Safe to re-run (IF NOT EXISTS / CREATE OR REPLACE).
-- ═══════════════════════════════════════════════════════════════


-- ═══════════════════════════════════════════════════════════════
-- forecaster_registry
-- ═══════════════════════════════════════════════════════════════
-- One row per (model_id, version). We keep retired entries around
-- with `retired_at` set so historical forecast_log rows still resolve.
CREATE TABLE IF NOT EXISTS public.forecaster_registry (
    model_id      TEXT        PRIMARY KEY,
    name          TEXT        NOT NULL,
    version       TEXT        NOT NULL DEFAULT '1',
    code_hash     TEXT,
    family        TEXT        NOT NULL DEFAULT 'unknown'
                              CHECK (family IN (
                                  'persistence', 'diurnal', 'statistical',
                                  'nwp', 'blend', 'ml', 'analog', 'unknown'
                              )),
    deployed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    retired_at    TIMESTAMPTZ,
    notes         TEXT
);

ALTER TABLE public.forecaster_registry ENABLE ROW LEVEL SECURITY;

-- Public read so the UI can render model names in the leaderboard
-- without needing a server hop. Writes are service_role-only.
DROP POLICY IF EXISTS forecaster_registry_public_read ON public.forecaster_registry;
CREATE POLICY forecaster_registry_public_read
    ON public.forecaster_registry
    FOR SELECT
    TO anon, authenticated
    USING (true);

-- Seed the five members the Rust WASM blender already emits. Safe to
-- re-run; ON CONFLICT keeps existing notes/code_hash intact if a later
-- session updated them.
INSERT INTO public.forecaster_registry (model_id, name, family, notes) VALUES
    ('PERSIST',  'Persistence',                 'persistence', 'Last observed value; AR(1) bias drift.'),
    ('DIURNAL',  'Diurnal harmonic',            'diurnal',     '24h + 12h Fourier fit, sun-altitude phase.'),
    ('AR1',      'AR(1) residual',              'statistical', 'First-order autoregression on de-seasonalised obs.'),
    ('NWP',      'Open-Meteo raw NWP',          'nwp',         'GFS/ECMWF/ICON/GEM raw guidance.'),
    ('NWP_BC',   'Open-Meteo NWP bias-corrected','nwp',        'NWP with running-mean bias correction vs obs.'),
    ('BLEND',    'Skill-weighted blend',        'blend',       'Softmax(-RMSE/T) over the four base members.')
ON CONFLICT (model_id) DO NOTHING;


-- ═══════════════════════════════════════════════════════════════
-- forecast_log
-- ═══════════════════════════════════════════════════════════════
-- Hot table. Each row is a single (made_at, valid_at, cell, field,
-- model) prediction. `observation` and `obs_at` are NULL on insert
-- and backfilled by the validator when the truth arrives.
--
-- `lead_minutes` is a generated column so the leaderboard query
-- ("skill at lead ≤ N min") doesn't need to recompute it on every
-- aggregate.
--
-- `archived = TRUE` means the row has been written to R2 and is safe
-- for trim_forecast_log() to delete. The archive cron flips this in
-- the same transaction that writes forecast_archive_pointer.
CREATE TABLE IF NOT EXISTS public.forecast_log (
    id            BIGSERIAL    PRIMARY KEY,
    made_at       TIMESTAMPTZ  NOT NULL,
    valid_at      TIMESTAMPTZ  NOT NULL,
    lead_minutes  INTEGER      GENERATED ALWAYS AS
                               (GREATEST(0, EXTRACT(EPOCH FROM (valid_at - made_at))::INT / 60))
                               STORED,
    lat           REAL         NOT NULL,
    lon           REAL         NOT NULL,
    field         TEXT         NOT NULL,
    model_id      TEXT         NOT NULL REFERENCES public.forecaster_registry(model_id),
    value         REAL,
    p10           REAL,
    p50           REAL,
    p90           REAL,
    sim_time_ms   BIGINT,
    observation   REAL,
    obs_at        TIMESTAMPTZ,
    archived      BOOLEAN      NOT NULL DEFAULT FALSE,
    ingested_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CHECK (length(field) BETWEEN 1 AND 64),
    CHECK (lat >= -90 AND lat <= 90),
    CHECK (lon >= -180 AND lon <= 180)
);

-- Leaderboard query: rolled-up MAE/RMSE for a cell+field over a
-- recent window. The partial index makes that fast without paying
-- for archived rows we're about to delete.
CREATE INDEX IF NOT EXISTS forecast_log_skill_idx
    ON public.forecast_log (lat, lon, field, made_at DESC)
    WHERE archived = FALSE;

-- Archive cron query: "everything older than 7 d that hasn't moved
-- to R2 yet, grouped by day."
CREATE INDEX IF NOT EXISTS forecast_log_archive_idx
    ON public.forecast_log (made_at)
    WHERE archived = FALSE;

-- Observation backfill query: "rows whose valid_at matches the
-- observation timestamp." Narrow filter; covers the validator-side
-- UPDATE without scanning the whole table.
CREATE INDEX IF NOT EXISTS forecast_log_valid_at_idx
    ON public.forecast_log (valid_at, field)
    WHERE observation IS NULL;

ALTER TABLE public.forecast_log ENABLE ROW LEVEL SECURITY;
-- No SELECT policy = no anon/authenticated reads. Aggregates flow
-- through /api/weather/skill (service_role). Writes flow through
-- the SECURITY DEFINER RPC below, never raw INSERTs from clients.


-- ═══════════════════════════════════════════════════════════════
-- forecast_archive_pointer
-- ═══════════════════════════════════════════════════════════════
-- One row per archived day (or partial day if the archive cron
-- chunks). Replay reads this table to discover which R2 keys cover
-- a requested window.
CREATE TABLE IF NOT EXISTS public.forecast_archive_pointer (
    id           BIGSERIAL   PRIMARY KEY,
    day          DATE        NOT NULL,
    r2_key       TEXT        NOT NULL UNIQUE,
    row_count    INTEGER     NOT NULL,
    bytes        BIGINT      NOT NULL,
    sha256       TEXT        NOT NULL,
    written_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS forecast_archive_pointer_day_idx
    ON public.forecast_archive_pointer (day DESC);

ALTER TABLE public.forecast_archive_pointer ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS forecast_archive_pointer_public_read ON public.forecast_archive_pointer;
CREATE POLICY forecast_archive_pointer_public_read
    ON public.forecast_archive_pointer
    FOR SELECT
    TO anon, authenticated
    USING (true);


-- ═══════════════════════════════════════════════════════════════
-- trim_forecast_log()
-- ═══════════════════════════════════════════════════════════════
-- Delete rows that have been archived to R2 and are older than 7 d.
-- The archive cron calls this after each successful upload. We
-- DON'T delete un-archived rows even if they're older than 7 d —
-- the cron should have caught them; leaving them visible flags the
-- pipeline as broken rather than silently dropping data.
CREATE OR REPLACE FUNCTION public.trim_forecast_log()
RETURNS INTEGER AS $$
DECLARE
    rows_deleted INTEGER;
BEGIN
    DELETE FROM public.forecast_log
     WHERE archived = TRUE
       AND made_at  < now() - INTERVAL '7 days';
    GET DIAGNOSTICS rows_deleted = ROW_COUNT;
    RETURN rows_deleted;
END;
$$ LANGUAGE plpgsql;


-- ═══════════════════════════════════════════════════════════════
-- record_forecast_batch(payload JSONB)
-- ═══════════════════════════════════════════════════════════════
-- Browser write-through endpoint. /api/forecast/log calls this with
-- a JSONB array of records; we validate, round lat/lon to 0.5° for
-- privacy, and bulk-insert.
--
-- Validation rules (strict — this is a browser-callable endpoint):
--   - payload must be a JSONB array, 1..100 items
--   - each record: made_at, valid_at, lat, lon, field, model_id required
--   - model_id must exist in forecaster_registry and not be retired
--   - made_at within ±48h of now() (allow some clock skew + replay)
--   - valid_at within ±14d of now() (24h forecast horizon + slack)
--   - field length 1..64
--   - value/p10/p50/p90/observation: finite if present; else dropped
--
-- Returns: { ingested INT, rejected INT, reasons JSONB }
-- Idempotency: we don't dedup on insert — the same client posting the
-- same prediction twice yields two rows. The validator-side UPDATE
-- (observation backfill) is keyed on (made_at, valid_at, lat, lon,
-- field, model) and updates all matching rows, so duplicates don't
-- bias skill stats; they just waste storage. The 10s client throttle
-- keeps that waste small.
CREATE OR REPLACE FUNCTION public.record_forecast_batch(payload JSONB)
RETURNS JSONB AS $$
DECLARE
    rec            JSONB;
    ingested_count INTEGER := 0;
    rejected_count INTEGER := 0;
    reasons        JSONB   := '[]'::JSONB;
    v_made_at      TIMESTAMPTZ;
    v_valid_at     TIMESTAMPTZ;
    v_lat          REAL;
    v_lon          REAL;
    v_field        TEXT;
    v_model_id     TEXT;
    v_value        REAL;
    v_p10          REAL;
    v_p50          REAL;
    v_p90          REAL;
    v_sim_time_ms  BIGINT;
    v_known_model  BOOLEAN;
BEGIN
    IF payload IS NULL OR jsonb_typeof(payload) <> 'array' THEN
        RAISE EXCEPTION 'payload must be a JSONB array';
    END IF;

    IF jsonb_array_length(payload) = 0 OR jsonb_array_length(payload) > 100 THEN
        RAISE EXCEPTION 'payload must contain 1..100 records (got %)',
            jsonb_array_length(payload);
    END IF;

    FOR rec IN SELECT * FROM jsonb_array_elements(payload) LOOP
        BEGIN
            -- Required fields
            v_made_at  := (rec ->> 'made_at')::TIMESTAMPTZ;
            v_valid_at := (rec ->> 'valid_at')::TIMESTAMPTZ;
            v_lat      := (rec ->> 'lat')::REAL;
            v_lon      := (rec ->> 'lon')::REAL;
            v_field    := rec ->> 'field';
            v_model_id := rec ->> 'model_id';

            IF v_made_at IS NULL OR v_valid_at IS NULL
               OR v_lat IS NULL OR v_lon IS NULL
               OR v_field IS NULL OR v_model_id IS NULL THEN
                rejected_count := rejected_count + 1;
                reasons := reasons || jsonb_build_object('reason', 'missing_required', 'rec', rec);
                CONTINUE;
            END IF;

            IF v_made_at < now() - INTERVAL '48 hours'
               OR v_made_at > now() + INTERVAL '48 hours' THEN
                rejected_count := rejected_count + 1;
                reasons := reasons || jsonb_build_object('reason', 'made_at_out_of_range');
                CONTINUE;
            END IF;

            IF v_valid_at < now() - INTERVAL '14 days'
               OR v_valid_at > now() + INTERVAL '14 days' THEN
                rejected_count := rejected_count + 1;
                reasons := reasons || jsonb_build_object('reason', 'valid_at_out_of_range');
                CONTINUE;
            END IF;

            IF v_lat < -90 OR v_lat > 90 OR v_lon < -180 OR v_lon > 180 THEN
                rejected_count := rejected_count + 1;
                reasons := reasons || jsonb_build_object('reason', 'latlon_out_of_range');
                CONTINUE;
            END IF;

            IF length(v_field) = 0 OR length(v_field) > 64 THEN
                rejected_count := rejected_count + 1;
                reasons := reasons || jsonb_build_object('reason', 'field_length');
                CONTINUE;
            END IF;

            -- Registry check
            SELECT TRUE INTO v_known_model
              FROM public.forecaster_registry
             WHERE model_id = v_model_id
               AND retired_at IS NULL;

            IF v_known_model IS NOT TRUE THEN
                rejected_count := rejected_count + 1;
                reasons := reasons || jsonb_build_object('reason', 'unknown_model', 'model_id', v_model_id);
                CONTINUE;
            END IF;

            -- Optional numeric fields. Anything non-finite is dropped to NULL
            -- rather than failing the row.
            v_value := NULLIF(rec ->> 'value', '')::REAL;
            v_p10   := NULLIF(rec ->> 'p10',   '')::REAL;
            v_p50   := NULLIF(rec ->> 'p50',   '')::REAL;
            v_p90   := NULLIF(rec ->> 'p90',   '')::REAL;
            v_sim_time_ms := NULLIF(rec ->> 'sim_time_ms', '')::BIGINT;

            -- Privacy: round to 0.5° (~55 km at equator). Permanent and
            -- enforced server-side so a future careless caller can't ship
            -- raw user coordinates by accident.
            v_lat := ROUND(v_lat::NUMERIC * 2) / 2;
            v_lon := ROUND(v_lon::NUMERIC * 2) / 2;

            INSERT INTO public.forecast_log
                (made_at, valid_at, lat, lon, field, model_id,
                 value, p10, p50, p90, sim_time_ms)
            VALUES
                (v_made_at, v_valid_at, v_lat, v_lon, v_field, v_model_id,
                 v_value, v_p10, v_p50, v_p90, v_sim_time_ms);

            ingested_count := ingested_count + 1;
        EXCEPTION WHEN OTHERS THEN
            -- Any per-record parse/cast error: count and move on. Whole-batch
            -- failures (e.g. payload not an array) raise above, before this
            -- loop runs.
            rejected_count := rejected_count + 1;
            reasons := reasons || jsonb_build_object('reason', 'parse_error', 'detail', SQLERRM);
        END;
    END LOOP;

    RETURN jsonb_build_object(
        'ingested', ingested_count,
        'rejected', rejected_count,
        'reasons',  reasons
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION public.record_forecast_batch(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_forecast_batch(JSONB) FROM anon, authenticated;
-- Only service_role (used by /api/forecast/log) can call this.


-- ═══════════════════════════════════════════════════════════════
-- backfill_forecast_observations(field TEXT, valid_window TSTZRANGE,
--                                obs_payload JSONB)
-- ═══════════════════════════════════════════════════════════════
-- Validator-side helper. Given a field and a time window, plus a
-- JSONB array of { lat, lon, observation, obs_at } records, update
-- every matching forecast_log row whose observation is still NULL.
--
-- Called by /api/weather/skill (and future ML training pipelines)
-- after each weather_grid_cache refresh — once truth is in the
-- cache, we can score predictions made before it.
--
-- This is the only way to write observation/obs_at back into
-- forecast_log; the record_forecast_batch path never touches those
-- columns.
CREATE OR REPLACE FUNCTION public.backfill_forecast_observations(
    p_field        TEXT,
    p_window_start TIMESTAMPTZ,
    p_window_end   TIMESTAMPTZ,
    p_obs_payload  JSONB
) RETURNS INTEGER AS $$
DECLARE
    obs_rec        JSONB;
    v_lat          REAL;
    v_lon          REAL;
    v_obs          REAL;
    v_obs_at       TIMESTAMPTZ;
    total_updated  INTEGER := 0;
    rows_for_one   INTEGER;
BEGIN
    IF p_obs_payload IS NULL OR jsonb_typeof(p_obs_payload) <> 'array' THEN
        RAISE EXCEPTION 'p_obs_payload must be a JSONB array';
    END IF;
    IF length(p_field) = 0 OR length(p_field) > 64 THEN
        RAISE EXCEPTION 'p_field length out of range';
    END IF;

    FOR obs_rec IN SELECT * FROM jsonb_array_elements(p_obs_payload) LOOP
        BEGIN
            v_lat    := (obs_rec ->> 'lat')::REAL;
            v_lon    := (obs_rec ->> 'lon')::REAL;
            v_obs    := (obs_rec ->> 'observation')::REAL;
            v_obs_at := (obs_rec ->> 'obs_at')::TIMESTAMPTZ;

            IF v_lat IS NULL OR v_lon IS NULL
               OR v_obs IS NULL OR v_obs_at IS NULL THEN
                CONTINUE;
            END IF;

            v_lat := ROUND(v_lat::NUMERIC * 2) / 2;
            v_lon := ROUND(v_lon::NUMERIC * 2) / 2;

            UPDATE public.forecast_log
               SET observation = v_obs,
                   obs_at      = v_obs_at
             WHERE field       = p_field
               AND lat         = v_lat
               AND lon         = v_lon
               AND valid_at   >= p_window_start
               AND valid_at   <= p_window_end
               AND observation IS NULL;
            GET DIAGNOSTICS rows_for_one = ROW_COUNT;
            total_updated := total_updated + rows_for_one;
        EXCEPTION WHEN OTHERS THEN
            -- Skip the bad record; the rest of the batch still applies.
            CONTINUE;
        END;
    END LOOP;

    RETURN total_updated;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION public.backfill_forecast_observations(
    TEXT, TIMESTAMPTZ, TIMESTAMPTZ, JSONB
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.backfill_forecast_observations(
    TEXT, TIMESTAMPTZ, TIMESTAMPTZ, JSONB
) FROM anon, authenticated;


-- ═══════════════════════════════════════════════════════════════
-- Verification
-- ═══════════════════════════════════════════════════════════════
-- 1. Registry seeded?
--      SELECT model_id, name, family FROM public.forecaster_registry
--      ORDER BY model_id;
--
-- 2. Insert a single test prediction:
--      SELECT public.record_forecast_batch(jsonb_build_array(
--        jsonb_build_object(
--          'made_at',   now(),
--          'valid_at',  now() + interval '1 hour',
--          'lat',       40.0,
--          'lon',       -105.0,
--          'field',     'temperature_2m',
--          'model_id',  'PERSIST',
--          'value',     12.5,
--          'p10',       11.0,
--          'p50',       12.5,
--          'p90',       14.0
--        )
--      ));
--      -- → {"ingested":1,"rejected":0,"reasons":[]}
--
-- 3. Confirm privacy rounding (lat 40.0 → 40.0, lat 40.1 → 40.0):
--      SELECT lat, lon FROM public.forecast_log
--      ORDER BY id DESC LIMIT 1;
--
-- 4. Trim no-op until archive cron lands (PR #2):
--      SELECT public.trim_forecast_log();
--      -- → 0
-- ═══════════════════════════════════════════════════════════════


-- ═══════════════ FEATURE: aurora-subscribers ═══════════════

-- supabase-aurora-subscribers-migration.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- Anonymous aurora-alert email capture. No auth.users coupling.
--
-- Captures email from anonymous burst traffic (aurora / storm events) with
-- zero account friction. Every other email path in this repo requires a
-- Supabase JWT; this one deliberately does not — see AURORA_ALERT_CAPTURE_SPEC.md.
--
-- Security posture mirrors the telemetry surface (supabase-auth-funnel-migration.sql):
--   * RLS on, NO policies → anon/auth roles cannot touch the table directly.
--   * The edge function (api/subscribe/*.js) uses the service-role key, which
--     bypasses RLS; the three SECURITY DEFINER RPCs below ARE the public API.
--   * RPCs are EXECUTE-able by service_role only — NOT anon. The endpoint, not
--     the browser, calls them. This is stricter than the telemetry RPCs (which
--     are anon-callable) because there is no reason for a browser to reach the
--     subscription RPCs directly.
--   * search_path pinned to `public` to dodge the mutable-search-path advisor.
--
-- Privacy: email + UTM only. No IP, no fingerprint — matches the privacy floor
-- in ANALYTICS.md. Keep it that way.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.aurora_subscribers (
    id              uuid primary key default gen_random_uuid(),
    email           text not null,
    status          text not null default 'pending'
                        check (status in ('pending','confirmed','unsubscribed')),
    confirm_token   uuid not null default gen_random_uuid(),
    source          text,                       -- capturing page, e.g. 'earth'
    utm             jsonb,                       -- {source,medium,campaign}
    created_at      timestamptz not null default now(),
    confirmed_at    timestamptz,
    unsubscribed_at timestamptz
);

-- Case-insensitive uniqueness without the citext extension dependency.
create unique index if not exists aurora_subscribers_email_lower_uidx
    on public.aurora_subscribers (lower(email));
create index if not exists aurora_subscribers_token_idx
    on public.aurora_subscribers (confirm_token);
create index if not exists aurora_subscribers_status_idx
    on public.aurora_subscribers (status) where status = 'confirmed';

alter table public.aurora_subscribers enable row level security;
-- No policies → anon/auth roles cannot touch the table directly.
-- Service role (used by the edge fn) bypasses RLS; RPCs below are the API.

-- ── RPC: subscribe ────────────────────────────────────────────────────────
-- Idempotent. Always returns a token for a 'pending' row so the endpoint can
-- (re)send confirmation. For already-confirmed emails returns status only and
-- a NULL token (endpoint then sends nothing → no enumeration via email send).
create or replace function public.subscribe_aurora(
    p_email  text,
    p_source text default null,
    p_utm    jsonb default null
) returns table (out_status text, out_token uuid)
language plpgsql security definer set search_path = public as $$
declare
    v_email text := lower(trim(p_email));
    v_row   public.aurora_subscribers;
begin
    if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
        raise exception 'invalid_email' using errcode = '22023';
    end if;

    select * into v_row from public.aurora_subscribers
        where lower(email) = v_email;

    if not found then
        insert into public.aurora_subscribers (email, source, utm)
        values (v_email, p_source, p_utm)
        returning * into v_row;
        return query select 'pending'::text, v_row.confirm_token;
    elsif v_row.status = 'confirmed' then
        return query select 'already_confirmed'::text, null::uuid;
    else  -- pending or previously unsubscribed → re-arm as pending
        update public.aurora_subscribers
           set status          = 'pending',
               confirm_token   = gen_random_uuid(),
               source          = coalesce(p_source, source),
               utm             = coalesce(p_utm, utm),
               unsubscribed_at = null
         where id = v_row.id
        returning * into v_row;
        return query select 'pending'::text, v_row.confirm_token;
    end if;
end $$;

-- ── RPC: confirm ──────────────────────────────────────────────────────────
create or replace function public.confirm_aurora(p_token uuid)
returns table (out_email text, out_status text)
language plpgsql security definer set search_path = public as $$
declare v_row public.aurora_subscribers;
begin
    update public.aurora_subscribers
       set status = 'confirmed', confirmed_at = coalesce(confirmed_at, now())
     where confirm_token = p_token
       and status <> 'unsubscribed'
    returning * into v_row;

    if not found then
        return query select null::text, 'invalid'::text;
    else
        return query select v_row.email, 'confirmed'::text;
    end if;
end $$;

-- ── RPC: unsubscribe ──────────────────────────────────────────────────────
create or replace function public.unsubscribe_aurora(p_token uuid)
returns text
language plpgsql security definer set search_path = public as $$
begin
    update public.aurora_subscribers
       set status = 'unsubscribed', unsubscribed_at = now()
     where confirm_token = p_token;
    return 'ok';
end $$;

-- Expose only the RPCs to the service path. Unlike the telemetry RPCs, the
-- subscription RPCs are NOT granted to anon — the browser never calls them
-- directly; the service-role edge function does. This keeps the edge
-- function's rate-limit + honeypot from being bypassed by direct RPC calls.
--
-- NOTE: `REVOKE ... FROM PUBLIC` alone is INSUFFICIENT on this Supabase
-- project. Supabase installs ALTER DEFAULT PRIVILEGES that grant EXECUTE on
-- every new public function to `anon` and `authenticated` directly, so those
-- grants survive a PUBLIC revoke. We must revoke from them explicitly.
revoke all on function public.subscribe_aurora(text,text,jsonb)  from public;
revoke all on function public.confirm_aurora(uuid)               from public;
revoke all on function public.unsubscribe_aurora(uuid)           from public;
revoke execute on function public.subscribe_aurora(text,text,jsonb) from anon, authenticated;
revoke execute on function public.confirm_aurora(uuid)              from anon, authenticated;
revoke execute on function public.unsubscribe_aurora(uuid)          from anon, authenticated;
grant execute on function public.subscribe_aurora(text,text,jsonb) to service_role;
grant execute on function public.confirm_aurora(uuid)              to service_role;
grant execute on function public.unsubscribe_aurora(uuid)          to service_role;


-- ═══════════════ FEATURE: aurora-broadcast ═══════════════

-- supabase-aurora-broadcast-migration.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- Storm-broadcast plumbing for the aurora-alert audience (follow-on to
-- supabase-aurora-subscribers-migration.sql). See §8 of
-- AURORA_ALERT_CAPTURE_SPEC.md.
--
-- The cron (api/cron/aurora-storm-blast.js) reads NOAA Kp; when Kp ≥ 6 it
-- fires ONE Resend Broadcast to AURORA_AUDIENCE_ID. The debounce below turns
-- a multi-day storm into ONE email instead of five: a blast is claimed only
-- if there hasn't been one in the last ~12h.
--
-- Security posture matches the rest of the aurora surface: RLS on, no policies
-- (service-role-only), RPCs are the API and are EXECUTE-able by service_role
-- only (NOT anon/authenticated — Supabase default privileges grant those past
-- a bare REVOKE FROM PUBLIC, so we revoke explicitly).
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.aurora_broadcast_log (
    id                  uuid primary key default gen_random_uuid(),
    blasted_at          timestamptz not null default now(),
    kp                  numeric,
    storm_level         int,
    recipients          int,
    resend_broadcast_id text,
    metadata            jsonb
);

create index if not exists aurora_broadcast_log_blasted_at_idx
    on public.aurora_broadcast_log (blasted_at desc);

alter table public.aurora_broadcast_log enable row level security;
-- No policies → service-role-only.

-- ── RPC: try_claim_aurora_blast ───────────────────────────────────────────
-- Atomic debounce. Serializes concurrent cron ticks with a transaction-scoped
-- advisory lock, then inserts a claim row ONLY if the most recent blast is
-- older than p_window_hours. Returns the claim id so the cron can fill in the
-- broadcast id / recipient count after a successful send (or release it on
-- failure so the next tick retries).
create or replace function public.try_claim_aurora_blast(
    p_kp           numeric,
    p_storm_level  int,
    p_window_hours int default 12
) returns table (claimed boolean, claim_id uuid, last_blast_at timestamptz)
language plpgsql security definer set search_path = public as $$
declare
    v_last timestamptz;
    v_id   uuid;
begin
    perform pg_advisory_xact_lock(hashtext('aurora_storm_blast'));

    select max(blasted_at) into v_last from public.aurora_broadcast_log;

    if v_last is not null
       and v_last > now() - make_interval(hours => greatest(coalesce(p_window_hours, 12), 1)) then
        return query select false, null::uuid, v_last;
        return;
    end if;

    insert into public.aurora_broadcast_log (kp, storm_level)
    values (p_kp, p_storm_level)
    returning id into v_id;

    return query select true, v_id, v_last;
end $$;

-- ── RPC: record_aurora_blast ──────────────────────────────────────────────
-- Fill in send results on a claimed row (non-fatal best-effort from the cron).
create or replace function public.record_aurora_blast(
    p_id           uuid,
    p_broadcast_id text default null,
    p_recipients   int  default null,
    p_metadata     jsonb default null
) returns text
language plpgsql security definer set search_path = public as $$
begin
    update public.aurora_broadcast_log
       set resend_broadcast_id = coalesce(p_broadcast_id, resend_broadcast_id),
           recipients          = coalesce(p_recipients, recipients),
           metadata            = coalesce(p_metadata, metadata)
     where id = p_id;
    return 'ok';
end $$;

-- ── RPC: release_aurora_blast ─────────────────────────────────────────────
-- Roll back a claim when the Resend send failed, so the next cron tick can
-- retry during the same active storm instead of being suppressed for 12h.
create or replace function public.release_aurora_blast(p_id uuid)
returns text
language plpgsql security definer set search_path = public as $$
begin
    delete from public.aurora_broadcast_log where id = p_id;
    return 'ok';
end $$;

-- ── RPC: unsubscribe_aurora_by_email ──────────────────────────────────────
-- Reconcile path for Resend's native broadcast unsubscribe. The Resend
-- webhook (api/subscribe/resend-webhook.js) hands us an email, not a token,
-- so this flips our DB row to keep aurora_subscribers authoritative.
create or replace function public.unsubscribe_aurora_by_email(p_email text)
returns text
language plpgsql security definer set search_path = public as $$
begin
    update public.aurora_subscribers
       set status = 'unsubscribed', unsubscribed_at = now()
     where lower(email) = lower(trim(p_email))
       and status <> 'unsubscribed';
    return 'ok';
end $$;

-- ── RPC: unsubscribe_aurora (token) — return the email ────────────────────
-- Superseding the bare 'ok' version from the subscribers migration: the
-- token-unsubscribe endpoint (api/subscribe/unsubscribe.js) needs the email
-- back so it can also flip the matching Resend Audience contact. Same return
-- type (text), so CREATE OR REPLACE is safe.
create or replace function public.unsubscribe_aurora(p_token uuid)
returns text
language plpgsql security definer set search_path = public as $$
declare v_email text;
begin
    update public.aurora_subscribers
       set status = 'unsubscribed', unsubscribed_at = now()
     where confirm_token = p_token
    returning email into v_email;
    return v_email;   -- NULL when no row matched
end $$;

-- ── Grants: service-role-only ─────────────────────────────────────────────
revoke all on function public.try_claim_aurora_blast(numeric,int,int)        from public;
revoke all on function public.record_aurora_blast(uuid,text,int,jsonb)       from public;
revoke all on function public.release_aurora_blast(uuid)                     from public;
revoke all on function public.unsubscribe_aurora_by_email(text)              from public;
revoke execute on function public.try_claim_aurora_blast(numeric,int,int)    from anon, authenticated;
revoke execute on function public.record_aurora_blast(uuid,text,int,jsonb)   from anon, authenticated;
revoke execute on function public.release_aurora_blast(uuid)                 from anon, authenticated;
revoke execute on function public.unsubscribe_aurora_by_email(text)          from anon, authenticated;
revoke execute on function public.unsubscribe_aurora(uuid)                   from anon, authenticated;
grant execute on function public.try_claim_aurora_blast(numeric,int,int)     to service_role;
grant execute on function public.record_aurora_blast(uuid,text,int,jsonb)    to service_role;
grant execute on function public.release_aurora_blast(uuid)                  to service_role;
grant execute on function public.unsubscribe_aurora_by_email(text)           to service_role;
grant execute on function public.unsubscribe_aurora(uuid)                    to service_role;


-- ═══════════════ FEATURE: farside-maps ═══════════════

-- ═══════════════════════════════════════════════════════════════
-- Parker Physics — Far-Side Watch ingestion (run in Supabase SQL Editor)
-- ═══════════════════════════════════════════════════════════════
-- Phase 1 of the Far-Side Watch layer (see FAR_SIDE_WATCH.md). A 12-hourly,
-- image-shaped feed — the slowest bucket in the data architecture. The
-- /api/cron/farside-ingest worker pulls each new far-side map (GONG seismic
-- holography, opportunistically SolO/STEREO/HMI), parses it, runs the
-- classical detector, and upserts one row here per (source, observed_at).
--
-- Storage model:
--   - Numeric Carrington grid is stored inline as base64 Float32 (LE) in
--     grid_b64 — small enough at 12 h cadence, kept bounded by trim_farside_maps.
--   - The ORIGINAL upstream bytes (FITS/PNG) are archived to R2 for provenance
--     (raw_r2_key); R2 is optional and the worker degrades gracefully without it.
--   - detections jsonb holds the per-map detector output so the browser can
--     build the tracking watch-list from real history without re-downloading grids.
--
-- Security model (mirrors solar_wind_samples / forecast_log):
--   RLS ENABLED, ZERO POLICIES → service-role-only. The cron writes with the
--   service key; the browser reads through /api/solar/farside (which uses the
--   service key server-side). This is intentional — do NOT add a permissive
--   policy, it would expose the raw feed. The advisor "RLS enabled, no policy"
--   flag is a false positive here.
--
-- Safe to re-run.
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.farside_maps (
    id             BIGSERIAL    PRIMARY KEY,
    source         TEXT         NOT NULL,                 -- gong | solo | stereo | hmi
    observed_at    TIMESTAMPTZ  NOT NULL,                 -- map timestamp (FITS DATE-OBS or slot)
    ingested_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    carrington_l0  DOUBLE PRECISION,                      -- sub-Earth Carrington longitude
    carrington_b0  DOUBLE PRECISION,                      -- heliographic latitude of disc centre
    grid_nlon      INT,
    grid_nlat      INT,
    lat_min        INT,
    image_url      TEXT,                                  -- resolved upstream URL
    raw_r2_key     TEXT,                                  -- archived original bytes (FITS/PNG)
    grid_b64       TEXT,                                  -- base64 Float32 LE z-score grid (nullable)
    grid_sha256    TEXT,
    detections     JSONB        NOT NULL DEFAULT '[]'::jsonb,
    n_detections   INT          NOT NULL DEFAULT 0,
    n_strong       INT          NOT NULL DEFAULT 0,
    synthetic      BOOLEAN      NOT NULL DEFAULT FALSE,    -- TRUE only if no real upstream resolved
    meta           JSONB,
    UNIQUE (source, observed_at)
);

CREATE INDEX IF NOT EXISTS farside_maps_source_observed_idx
    ON public.farside_maps (source, observed_at DESC);

ALTER TABLE public.farside_maps ENABLE ROW LEVEL SECURITY;
-- No policies → service-role-only. (See header.)

-- ═══════════════════════════════════════════════════════════════
-- trim_farside_maps — retention. Keep the most recent p_keep rows PER source
-- (180 × 12 h ≈ 90 days). Called opportunistically at the end of each ingest
-- run. Service-role-only — revoked from anon/authenticated.
-- ═══════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.trim_farside_maps(p_keep INT DEFAULT 180)
RETURNS INT
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    WITH ranked AS (
        SELECT id, row_number() OVER (
            PARTITION BY source ORDER BY observed_at DESC
        ) AS rn
        FROM public.farside_maps
    ),
    del AS (
        DELETE FROM public.farside_maps
        WHERE id IN (SELECT id FROM ranked WHERE rn > p_keep)
        RETURNING 1
    )
    SELECT COALESCE(count(*), 0)::int FROM del;
$$;

REVOKE ALL ON FUNCTION public.trim_farside_maps(INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trim_farside_maps(INT) TO service_role;

COMMENT ON TABLE public.farside_maps IS
    'Far-Side Watch ingest archive (Phase 1). Service-role-only; written by '
    '/api/cron/farside-ingest, read via /api/solar/farside. RLS-no-policy is intentional.';


-- ═══════════════ FEATURE: spaceship-designs ═══════════════

-- ═══════════════════════════════════════════════════════════════
-- Parkers Physics — Space Ship Designer Saved Rockets Migration
-- ═══════════════════════════════════════════════════════════════
--
-- Run this in Supabase Dashboard → SQL Editor → New Query
-- (idempotent — safe to re-run).
--
-- Backs the "Hangar" on spaceship-designer.html: every signed-in
-- pilot gets their own roster of saved launch-vehicle designs. All
-- design + tuning parameters live in a single JSONB blob so the
-- schema never has to change as the designer gains knobs.
--
-- This mirrors supabase-satellite-designs-migration.sql exactly
-- (same shape, same per-plan caps, same RLS), but for launch
-- vehicles instead of on-orbit satellites.
--
-- Plan limits enforced via BEFORE INSERT trigger:
--   free      → 3 saved rockets
--   basic     → 25 saved rockets
--   advanced+ → 200 saved rockets
--
-- Admins and testers bypass the cap.
-- ═══════════════════════════════════════════════════════════════

-- ── 1. Table ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.spaceship_designs (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    description TEXT,
    design_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    is_public   BOOLEAN DEFAULT FALSE,
    best_score  DOUBLE PRECISION DEFAULT 0,
    created_at  TIMESTAMPTZ DEFAULT now(),
    updated_at  TIMESTAMPTZ DEFAULT now(),
    UNIQUE (user_id, name)
);

-- Fast per-user roster fetch (most-recent first).
CREATE INDEX IF NOT EXISTS idx_spaceship_designs_user
    ON public.spaceship_designs(user_id, updated_at DESC);

-- ── 2. Row Level Security ─────────────────────────────────────────
ALTER TABLE public.spaceship_designs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage own spaceship designs"
    ON public.spaceship_designs;
CREATE POLICY "Users manage own spaceship designs"
    ON public.spaceship_designs FOR ALL
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Anyone can view public spaceship designs"
    ON public.spaceship_designs;
CREATE POLICY "Anyone can view public spaceship designs"
    ON public.spaceship_designs FOR SELECT
    USING (is_public = TRUE OR auth.uid() = user_id);

-- ── 3. Enforce per-user cap on insert ─────────────────────────────
-- Reuses public.plan_design_limit(text) from the satellite-designs
-- migration if present; otherwise creates it (same map).
CREATE OR REPLACE FUNCTION public.plan_design_limit(p_plan TEXT)
RETURNS INTEGER AS $$
    SELECT CASE lower(coalesce(p_plan, 'free'))
        WHEN 'enterprise'  THEN 200
        WHEN 'institution' THEN 200
        WHEN 'advanced'    THEN 200
        WHEN 'educator'    THEN 200
        WHEN 'basic'       THEN 25
        ELSE 3
    END;
$$ LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION public.enforce_spaceship_design_limit()
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

    -- Admins / testers bypass the cap.
    IF user_role IN ('admin', 'superadmin', 'tester') THEN
        RETURN NEW;
    END IF;

    -- Re-saving an existing design is an UPDATE via upsert, but Postgres still
    -- fires this BEFORE INSERT trigger before detecting the ON CONFLICT. Skip
    -- the cap when the (user_id, name) row already exists, so a user AT their
    -- limit can still edit and re-save rockets they already own — only brand
    -- new names count against the quota.
    IF EXISTS (
        SELECT 1 FROM public.spaceship_designs
        WHERE user_id = NEW.user_id AND name = NEW.name
    ) THEN
        RETURN NEW;
    END IF;

    SELECT count(*) INTO current_count
    FROM public.spaceship_designs
    WHERE user_id = NEW.user_id;

    max_allowed := public.plan_design_limit(user_plan);

    IF current_count >= max_allowed THEN
        RAISE EXCEPTION
            'Saved-rocket limit reached (% of % for the % plan). Upgrade or delete a design.',
            current_count, max_allowed, coalesce(user_plan, 'free')
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS trg_enforce_spaceship_design_limit ON public.spaceship_designs;
CREATE TRIGGER trg_enforce_spaceship_design_limit
    BEFORE INSERT ON public.spaceship_designs
    FOR EACH ROW EXECUTE FUNCTION public.enforce_spaceship_design_limit();

-- ── 4. Keep updated_at fresh ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.touch_spaceship_design()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS trg_touch_spaceship_design ON public.spaceship_designs;
CREATE TRIGGER trg_touch_spaceship_design
    BEFORE UPDATE ON public.spaceship_designs
    FOR EACH ROW EXECUTE FUNCTION public.touch_spaceship_design();

-- ═══════════════════════════════════════════════════════════════
-- Done. Verify with:
--   SELECT * FROM public.spaceship_designs LIMIT 1;
-- ═══════════════════════════════════════════════════════════════


-- ═══════════════ FEATURE: aurora-outlook-cache ═══════════════

-- ═══════════════════════════════════════════════════════════════
-- Parker Physics — Aurora Outlook Cache (run in Supabase SQL Editor)
-- ═══════════════════════════════════════════════════════════════
-- Shared cache of the historically-driven 30-day Kp outlook
-- (AURORACLE_ML_PLAN.md §6, Phase 1). The outlook is GLOBAL — Kp is
-- the same for every user; only AurOracle's per-sky scoring is local —
-- so api/cron/aurora-outlook.js computes it once every 6 h and writes
-- one JSONB document here. /api/aurora/outlook returns the newest row
-- to browsers via the CDN; until this table exists, that endpoint
-- live-computes from NOAA so the feature still works.
--
--   aurora_outlook_cache
--     id            BIGSERIAL primary key
--     generated_at  when the cron computed this outlook
--     source        provider label ('noaa-45d+recurrence')
--     payload       JSONB { made_at, version, days:[{ i, date,
--                   kp_p10, kp_p50, kp_p90, driver }], meta }
--
-- Mirrors weather_grid_cache (service-role-only, RLS on with zero
-- policies). Safe to re-run (IF NOT EXISTS / CREATE OR REPLACE).
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.aurora_outlook_cache (
    id            BIGSERIAL    PRIMARY KEY,
    generated_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    source        TEXT         NOT NULL DEFAULT 'noaa-45d+recurrence',
    payload       JSONB        NOT NULL
);

CREATE INDEX IF NOT EXISTS aurora_outlook_cache_generated_at_idx
    ON public.aurora_outlook_cache (generated_at DESC);

-- RLS: server-only. The cron writer + read endpoint use the service_role
-- key (bypasses RLS); browsers must go through the cached edge endpoint.
-- No policies = no rows visible to anon/authenticated (correct — this is
-- internal cache data, same posture as weather_grid_cache; CLAUDE.md §4.2).
ALTER TABLE public.aurora_outlook_cache ENABLE ROW LEVEL SECURITY;

-- Retention: keep the last 240 rows (~60 days at the 6 h cadence) so the
-- Phase 2 skill accumulator has a backtest history of issued outlooks to
-- score against what NOAA later observed. Called opportunistically from
-- the cron after each insert.
CREATE OR REPLACE FUNCTION public.trim_aurora_outlook_cache()
RETURNS void AS $$
    DELETE FROM public.aurora_outlook_cache
    WHERE id NOT IN (
        SELECT id FROM public.aurora_outlook_cache
        ORDER BY generated_at DESC
        LIMIT 240
    );
$$ LANGUAGE sql
SET search_path = public, pg_temp;


-- ═══════════════════════════════════════════════════════════════
-- Tables that existed in production but in NO repo file (captured from
-- the live schema). Placed last so is_admin() (referenced by policies)
-- already exists from the bootstrap step above.
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.announcements (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  title text NOT NULL,
  body text,
  severity text DEFAULT 'info'::text,
  target_plan text DEFAULT 'all'::text,
  published boolean DEFAULT false,
  published_at timestamp with time zone,
  expires_at timestamp with time zone,
  created_by uuid,
  created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.beta_invite_uses (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  invite_id uuid NOT NULL,
  user_id uuid,
  email text,
  redeemed_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.beta_invites (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  code text NOT NULL,
  label text,
  max_uses integer DEFAULT 1,
  use_count integer DEFAULT 0,
  created_by uuid,
  expires_at timestamp with time zone,
  active boolean DEFAULT true,
  created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.farside_truth (
  id bigint GENERATED BY DEFAULT AS IDENTITY,
  case_id text NOT NULL,
  noaa_region integer,
  label text NOT NULL,
  east_limb_crossing timestamp with time zone NOT NULL,
  carrington_lon double precision,
  carrington_lat double precision,
  flare_productive boolean,
  source text NOT NULL DEFAULT 'manual'::text,
  notes text,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.feedback (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid,
  email text,
  category text DEFAULT 'general'::text,
  page text,
  message text NOT NULL,
  metadata jsonb DEFAULT '{}'::jsonb,
  status text DEFAULT 'new'::text,
  created_at timestamp with time zone DEFAULT now()
);

ALTER TABLE public.announcements ADD CONSTRAINT announcements_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);

ALTER TABLE public.announcements ADD CONSTRAINT announcements_pkey PRIMARY KEY (id);

ALTER TABLE public.announcements ADD CONSTRAINT announcements_severity_check CHECK ((severity = ANY (ARRAY['info'::text, 'success'::text, 'warning'::text, 'critical'::text])));

ALTER TABLE public.announcements ADD CONSTRAINT announcements_target_plan_check CHECK ((target_plan = ANY (ARRAY['all'::text, 'free'::text, 'basic'::text, 'advanced'::text])));

ALTER TABLE public.beta_invite_uses ADD CONSTRAINT beta_invite_uses_invite_id_fkey FOREIGN KEY (invite_id) REFERENCES beta_invites(id) ON DELETE CASCADE;

ALTER TABLE public.beta_invite_uses ADD CONSTRAINT beta_invite_uses_pkey PRIMARY KEY (id);

ALTER TABLE public.beta_invite_uses ADD CONSTRAINT beta_invite_uses_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.beta_invites ADD CONSTRAINT beta_invites_code_key UNIQUE (code);

ALTER TABLE public.beta_invites ADD CONSTRAINT beta_invites_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);

ALTER TABLE public.beta_invites ADD CONSTRAINT beta_invites_pkey PRIMARY KEY (id);

ALTER TABLE public.farside_truth ADD CONSTRAINT farside_truth_case_id_key UNIQUE (case_id);

ALTER TABLE public.farside_truth ADD CONSTRAINT farside_truth_pkey PRIMARY KEY (id);

ALTER TABLE public.feedback ADD CONSTRAINT feedback_category_check CHECK ((category = ANY (ARRAY['bug'::text, 'feature'::text, 'general'::text, 'praise'::text])));

ALTER TABLE public.feedback ADD CONSTRAINT feedback_pkey PRIMARY KEY (id);

ALTER TABLE public.feedback ADD CONSTRAINT feedback_status_check CHECK ((status = ANY (ARRAY['new'::text, 'reviewed'::text, 'resolved'::text, 'wontfix'::text])));

ALTER TABLE public.feedback ADD CONSTRAINT feedback_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS farside_truth_crossing_idx ON public.farside_truth USING btree (east_limb_crossing DESC);

ALTER TABLE public.announcements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.beta_invite_uses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.beta_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.farside_truth ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feedback ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can manage announcements" ON public.announcements;
CREATE POLICY "Admins can manage announcements" ON public.announcements AS PERMISSIVE FOR ALL TO public USING (is_admin());

DROP POLICY IF EXISTS "Users can view active announcements" ON public.announcements;
CREATE POLICY "Users can view active announcements" ON public.announcements AS PERMISSIVE FOR SELECT TO public USING (((published = true) AND ((expires_at IS NULL) OR (expires_at > now()))));

DROP POLICY IF EXISTS "Admins can view invite usage" ON public.beta_invite_uses;
CREATE POLICY "Admins can view invite usage" ON public.beta_invite_uses AS PERMISSIVE FOR SELECT TO public USING (is_admin());

DROP POLICY IF EXISTS "Anyone can redeem invites" ON public.beta_invite_uses;
CREATE POLICY "Anyone can redeem invites" ON public.beta_invite_uses AS PERMISSIVE FOR INSERT TO public WITH CHECK (true);

DROP POLICY IF EXISTS "Admins can manage invites" ON public.beta_invites;
CREATE POLICY "Admins can manage invites" ON public.beta_invites AS PERMISSIVE FOR ALL TO public USING (is_admin());

DROP POLICY IF EXISTS "Anyone can check invite codes" ON public.beta_invites;
CREATE POLICY "Anyone can check invite codes" ON public.beta_invites AS PERMISSIVE FOR SELECT TO public USING ((active = true));

DROP POLICY IF EXISTS farside_truth_public_read ON public.farside_truth;
CREATE POLICY farside_truth_public_read ON public.farside_truth AS PERMISSIVE FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "Admins can manage feedback" ON public.feedback;
CREATE POLICY "Admins can manage feedback" ON public.feedback AS PERMISSIVE FOR ALL TO public USING (is_admin());

DROP POLICY IF EXISTS "Anyone can submit feedback" ON public.feedback;
CREATE POLICY "Anyone can submit feedback" ON public.feedback AS PERMISSIVE FOR INSERT TO public WITH CHECK (true);

DROP POLICY IF EXISTS "Users can view own feedback" ON public.feedback;
CREATE POLICY "Users can view own feedback" ON public.feedback AS PERMISSIVE FOR SELECT TO public USING ((auth.uid() = user_id));
