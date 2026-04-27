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
--
-- ── Order independence ────────────────────────────────────────────
-- The partial index below filters on `notify_enabled` and
-- `email_alerts_enabled`. Those columns are normally added by
-- supabase-multi-location-migration.sql; if you ran the digest
-- migration before that one, the original index creation would fail
-- with `42703: column "notify_enabled" does not exist`.
--
-- This migration now backfills both columns with the same defaults
-- supabase-multi-location-migration.sql uses (BOOLEAN DEFAULT TRUE),
-- so the digest migration runs cleanly regardless of order. You
-- still need to run supabase-multi-location-migration.sql separately
-- to get the per-plan location-cap trigger and the alert_config /
-- timezone columns the alert engine reads — those aren't backfilled
-- here on purpose because they have nontrivial side effects (the
-- cap trigger gates new INSERTs).
-- ═══════════════════════════════════════════════════════════════

-- ── 1. Columns ────────────────────────────────────────────────────
-- Backfill the dependency columns first (safe even if multi-location
-- migration already ran; ADD COLUMN IF NOT EXISTS is a no-op then).
ALTER TABLE public.user_locations
    ADD COLUMN IF NOT EXISTS notify_enabled       BOOLEAN DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS email_alerts_enabled BOOLEAN DEFAULT TRUE;

-- The actual new column for this migration.
ALTER TABLE public.user_locations
    ADD COLUMN IF NOT EXISTS daily_digest_enabled BOOLEAN NOT NULL DEFAULT FALSE;

-- ── 2. Partial index ──────────────────────────────────────────────
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
