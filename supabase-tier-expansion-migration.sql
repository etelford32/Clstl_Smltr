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
    CHECK (plan IN ('free', 'basic', 'educator', 'advanced', 'institution', 'enterprise'));

-- ── 2. Widen the invite_codes.plan CHECK constraint ──────────────
ALTER TABLE public.invite_codes
    DROP CONSTRAINT IF EXISTS invite_codes_plan_check;

ALTER TABLE public.invite_codes
    ADD CONSTRAINT invite_codes_plan_check
    CHECK (plan IN ('free', 'basic', 'educator', 'advanced', 'institution', 'enterprise'));

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
