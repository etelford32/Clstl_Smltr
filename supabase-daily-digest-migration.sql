-- ═══════════════════════════════════════════════════════════════
-- Parker Physics — Daily Forecast Digest Migration
-- ═══════════════════════════════════════════════════════════════
--
-- Run in Supabase Dashboard → SQL Editor → New Query (idempotent).
--
-- Adds a per-saved-location opt-in for the daily "tomorrow's forecast"
-- email digest. The digest is gated to the `basic` plan tier in
-- application code (see api/cron/daily-forecast-digest.js).
--
-- Default OFF — opt-in. The cron skips locations where this is FALSE.
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE public.user_locations
    ADD COLUMN IF NOT EXISTS daily_digest_enabled BOOLEAN NOT NULL DEFAULT FALSE;

-- Partial index — the cron's primary query only scans rows where
-- the digest is on AND notifications + email are both enabled. A
-- partial index keeps the dashboard list/insert path index-free
-- (these flags are mostly false), and makes the cron's per-day scan
-- a single index range read.
CREATE INDEX IF NOT EXISTS idx_user_locations_digest_due
    ON public.user_locations(user_id)
    WHERE daily_digest_enabled = TRUE
      AND notify_enabled       = TRUE
      AND email_alerts_enabled = TRUE;
