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
