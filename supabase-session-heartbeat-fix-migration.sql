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
-- Idempotent AND safe on a database where public.user_sessions was
-- never created: the whole body is guarded by to_regclass(), so on a
-- partial/fresh project it raises a NOTICE and no-ops instead of
-- failing with 42P01 ("relation does not exist").
-- ═══════════════════════════════════════════════════════════════

BEGIN;

DO $$
BEGIN
    -- to_regclass() returns NULL (no error) when the table is absent,
    -- unlike a bare 'public.user_sessions'::regclass cast which throws.
    IF to_regclass('public.user_sessions') IS NULL THEN
        RAISE NOTICE
          'public.user_sessions does not exist — skipping session_heartbeat fix (nothing to do).';
        RETURN;
    END IF;

    -- 1. Dedupe. ctid is the physical row id; ranking by last_seen DESC
    --    keeps the most-recently-active row per session_id.
    DELETE FROM public.user_sessions us
     USING (
        SELECT ctid,
               ROW_NUMBER() OVER (
                   PARTITION BY session_id
                   ORDER BY last_seen DESC NULLS LAST, started_at DESC NULLS LAST
               ) AS rn
          FROM public.user_sessions
     ) r
     WHERE us.ctid = r.ctid AND r.rn > 1;

    -- 2. Add the constraint the upsert needs (guarded — re-run safe).
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
