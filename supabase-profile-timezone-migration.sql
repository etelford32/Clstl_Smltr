-- ═══════════════════════════════════════════════════════════════
-- Parker Physics — Profile Timezone Column Migration
-- ═══════════════════════════════════════════════════════════════
--
-- Run this in Supabase Dashboard → SQL Editor → New Query
-- (idempotent — safe to re-run).
--
-- Adds an account-level `timezone` column to `user_profiles`. The
-- account page (account.html → js/account.js) lets users pick a
-- display timezone used to format alert times in emails and the
-- dashboard. Per-location timezone overrides on `user_locations`
-- already exist (multi-location migration); the account-level
-- value is the fallback when a location does not specify one.
--
-- Without this column, saving the Profile card on /account fails
-- with: "Could not find the 'timezone' column of 'user_profiles'
-- in the schema cache".
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE public.user_profiles
    ADD COLUMN IF NOT EXISTS timezone TEXT;

-- ── Notify PostgREST so the schema cache picks up the new column
-- immediately (otherwise clients see the missing-column error until
-- the next automatic reload). NOTIFY is harmless if PostgREST is
-- not running.
NOTIFY pgrst, 'reload schema';
