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
