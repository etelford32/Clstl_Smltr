-- ═══════════════════════════════════════════════════════════════
-- Parker Physics — session_heartbeat fix (run in Supabase SQL Editor)
-- ═══════════════════════════════════════════════════════════════
-- public.session_heartbeat() upserts into user_sessions with
-- ON CONFLICT (session_id), but the table was missing a UNIQUE on
-- session_id. Result: every heartbeat raised
--   "there is no unique or exclusion constraint matching the ON
--    CONFLICT specification"
-- and PostgREST returned HTTP 400. js/analytics.js retried every 60s
-- per visitor, flooding Vercel logs.
--
-- This migration:
--   1. Collapses any duplicate (session_id) rows — keep the row with
--      the greatest last_seen (longest-lived copy).
--   2. Adds the missing UNIQUE constraint.
--
-- Idempotent. Safe to re-run.
-- ═══════════════════════════════════════════════════════════════

BEGIN;

-- 1. Dedupe. ctid is the physical row id; ranking by last_seen DESC
--    keeps the most-recently-active row per session_id.
WITH ranked AS (
    SELECT ctid,
           ROW_NUMBER() OVER (
               PARTITION BY session_id
               ORDER BY last_seen DESC NULLS LAST, started_at DESC NULLS LAST
           ) AS rn
      FROM public.user_sessions
)
DELETE FROM public.user_sessions us
 USING ranked r
 WHERE us.ctid = r.ctid AND r.rn > 1;

-- 2. Add the constraint the upsert needs.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'user_sessions_session_id_key'
           AND conrelid = 'public.user_sessions'::regclass
    ) THEN
        ALTER TABLE public.user_sessions
            ADD CONSTRAINT user_sessions_session_id_key UNIQUE (session_id);
    END IF;
END $$;

COMMIT;

-- Verification:
--   SELECT conname FROM pg_constraint
--    WHERE conrelid = 'public.user_sessions'::regclass
--      AND contype  = 'u';
--   -- expect: user_sessions_session_id_key
