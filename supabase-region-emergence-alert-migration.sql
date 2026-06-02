-- ═══════════════════════════════════════════════════════════════
-- Parker Physics — Far-Side Watch "region rotating into view" alert
-- (run in Supabase SQL Editor)
-- ═══════════════════════════════════════════════════════════════
-- Tier 5 (see FAR_SIDE_WATCH_NEXT_STEPS.md). Adds the user preference that gates
-- the new emergence alert in js/alert-engine.js. One column = one feature flag,
-- matching the existing notify_* convention on user_profiles.
--
--   notify_region_emergence     — opt-in toggle (default off; it's an
--                                 Advanced/operator feature)
--   region_emergence_lead_days  — fire when a tracked far-side region is forecast
--                                 to cross the east limb within this many days
--
-- Safe to re-run.
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE public.user_profiles
    ADD COLUMN IF NOT EXISTS notify_region_emergence    BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS region_emergence_lead_days INTEGER DEFAULT 5;
