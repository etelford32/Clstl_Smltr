-- ═══════════════════════════════════════════════════════════════
-- Parker Physics — Tester Tier Migration
-- ═══════════════════════════════════════════════════════════════
--
-- Adds a "tester" plan tier alongside the existing
--   free / basic / educator / advanced / institution / enterprise
-- ladder.
--
-- Tester semantics:
--   - Comp tier for QA / early access / friends-and-family
--   - Mapped to TIER.PRO in js/config.js → full data depth
--   - Mapped to nav level 98 in js/nav.js → every menu item visible
--   - 1 default seat (it's a personal account, not a roster)
--   - 25-location cap (mirrors Advanced) so the testers can exercise
--     multi-location features
--   - Does NOT set attribution_required → no "Powered by" badge
--   - Does NOT escalate user_profiles.role — apply_invite_plan only
--     writes the plan column, so a tester invite cannot smuggle in
--     admin/superadmin privileges. Use the existing role column for
--     QA accounts that also need the admin tab.
--
-- Idempotent — safe to re-run. Run AFTER
-- supabase-tier-expansion-migration.sql.
-- ═══════════════════════════════════════════════════════════════

-- ── 1. Widen the user_profiles.plan CHECK constraint ──────────────
ALTER TABLE public.user_profiles
    DROP CONSTRAINT IF EXISTS user_profiles_plan_check;

ALTER TABLE public.user_profiles
    ADD CONSTRAINT user_profiles_plan_check
    CHECK (plan IN ('free', 'tester', 'basic', 'educator',
                    'advanced', 'institution', 'enterprise'));

-- ── 2. Widen the invite_codes.plan CHECK constraint ──────────────
ALTER TABLE public.invite_codes
    DROP CONSTRAINT IF EXISTS invite_codes_plan_check;

ALTER TABLE public.invite_codes
    ADD CONSTRAINT invite_codes_plan_check
    CHECK (plan IN ('free', 'tester', 'basic', 'educator',
                    'advanced', 'institution', 'enterprise'));

-- ── 3. Refresh tier_default_seats for the new tier ───────────────
-- Tester is a single-user comp; one seat is correct.
CREATE OR REPLACE FUNCTION public.tier_default_seats(p_plan TEXT)
RETURNS INTEGER AS $$
    SELECT CASE lower(coalesce(p_plan, 'free'))
        WHEN 'institution' THEN 200
        WHEN 'educator'    THEN 30
        WHEN 'enterprise'  THEN 1000
        WHEN 'advanced'    THEN 1
        WHEN 'basic'       THEN 1
        WHEN 'tester'      THEN 1
        ELSE 1
    END;
$$ LANGUAGE sql IMMUTABLE;

-- ── 4. Refresh plan_location_limit for the new tier ──────────────
-- Tester gets the Advanced cap so they can exercise multi-location
-- alerts and the saved-locations UI in QA.
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

-- tier_attribution_required is left as-is: it returns true ONLY for
-- 'educator', so 'tester' (and every other tier) correctly returns
-- FALSE without a code change.

-- ═══════════════════════════════════════════════════════════════
-- Verify with:
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conrelid = 'public.user_profiles'::regclass
--      AND conname  = 'user_profiles_plan_check';
--   -- Expect: ... plan IN ('free','tester','basic',...)
--
--   SELECT public.plan_location_limit('tester');     -- expect 25
--   SELECT public.tier_default_seats('tester');      -- expect 1
--   SELECT public.tier_attribution_required('tester'); -- expect false
--
--   -- End-to-end:
--   INSERT INTO public.invite_codes (code, plan)
--        VALUES ('TESTERX1', 'tester');
--   SELECT * FROM public.validate_invite('TESTERX1', NULL);
--   -- (sign in as that user, then)
--   SELECT * FROM public.apply_invite_plan(
--       (SELECT id FROM public.invite_codes WHERE code='TESTERX1'),
--       NULL
--   );
--   -- Expect (applied=true, plan='tester')
-- ═══════════════════════════════════════════════════════════════
