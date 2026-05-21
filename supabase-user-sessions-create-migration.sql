-- supabase-user-sessions-create-migration.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- Creates public.user_sessions + the session_heartbeat() RPC that
-- js/analytics.js calls every 60s. Isolated from the rest of
-- supabase-migration.sql so projects that only need this slice can apply
-- it on its own.
--
-- Idempotent: re-runs are no-ops. UNIQUE (session_id) is baked into the
-- CREATE TABLE so supabase-session-heartbeat-fix-migration.sql is never
-- needed on any project that runs THIS file first.
--
-- Dependencies: public.is_admin() (from supabase-admin.sql).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.user_sessions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id  TEXT UNIQUE NOT NULL,
    user_id     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    page_path   TEXT,
    user_agent  TEXT,
    started_at  TIMESTAMPTZ DEFAULT now(),
    last_seen   TIMESTAMPTZ DEFAULT now(),
    duration_s  INTEGER DEFAULT 0,
    ended       BOOLEAN DEFAULT false
);

-- Old projects may have the table without the UNIQUE constraint (that's
-- what supabase-session-heartbeat-fix-migration.sql exists to repair).
-- Add it here too so this file is sufficient on its own — guarded so
-- re-runs don't double-add the constraint.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname  = 'user_sessions_session_id_key'
           AND conrelid = 'public.user_sessions'::regclass
    ) THEN
        -- Dedupe before adding the constraint, or it'll fail if there
        -- are existing duplicate session_id rows. Keep the row with the
        -- most-recent last_seen per session_id.
        DELETE FROM public.user_sessions us
         USING (
            SELECT ctid,
                   ROW_NUMBER() OVER (
                       PARTITION BY session_id
                       ORDER BY last_seen DESC NULLS LAST,
                                started_at DESC NULLS LAST
                   ) AS rn
              FROM public.user_sessions
         ) r
         WHERE us.ctid = r.ctid AND r.rn > 1;

        ALTER TABLE public.user_sessions
            ADD CONSTRAINT user_sessions_session_id_key UNIQUE (session_id);
    END IF;
END $$;

ALTER TABLE public.user_sessions ENABLE ROW LEVEL SECURITY;

-- Policies — guarded so re-runs don't error on existing names.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
         WHERE schemaname = 'public'
           AND tablename  = 'user_sessions'
           AND policyname = 'Anyone can upsert sessions'
    ) THEN
        CREATE POLICY "Anyone can upsert sessions"
            ON public.user_sessions FOR ALL
            USING (true) WITH CHECK (true);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
         WHERE schemaname = 'public'
           AND tablename  = 'user_sessions'
           AND policyname = 'Admins can view all sessions'
    ) THEN
        CREATE POLICY "Admins can view all sessions"
            ON public.user_sessions FOR SELECT
            USING (public.is_admin());
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_user_sessions_active
    ON public.user_sessions (last_seen DESC) WHERE ended = false;


-- ── RPC: session_heartbeat ───────────────────────────────────────────────────
-- Called every 60s by js/analytics.js to keep last_seen fresh. The ON
-- CONFLICT clause is why session_id needs the UNIQUE constraint above.
CREATE OR REPLACE FUNCTION public.session_heartbeat(
    p_session_id TEXT,
    p_user_id    UUID DEFAULT NULL,
    p_page_path  TEXT DEFAULT NULL,
    p_user_agent TEXT DEFAULT NULL
) RETURNS VOID AS $$
BEGIN
    INSERT INTO public.user_sessions
        (session_id, user_id, page_path, user_agent, started_at, last_seen, ended)
    VALUES
        (p_session_id, p_user_id, p_page_path, p_user_agent, now(), now(), false)
    ON CONFLICT (session_id) DO UPDATE
        SET last_seen  = now(),
            user_id    = COALESCE(EXCLUDED.user_id,    user_sessions.user_id),
            page_path  = COALESCE(EXCLUDED.page_path,  user_sessions.page_path),
            duration_s = EXTRACT(EPOCH FROM (now() - user_sessions.started_at))::INTEGER;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL    ON FUNCTION public.session_heartbeat(TEXT, UUID, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.session_heartbeat(TEXT, UUID, TEXT, TEXT) TO anon, authenticated;

-- Verification:
--   SELECT to_regclass('public.user_sessions');                -- expect: public.user_sessions
--   SELECT conname FROM pg_constraint
--    WHERE conrelid = 'public.user_sessions'::regclass
--      AND contype  = 'u';                                     -- expect: user_sessions_session_id_key
--   SELECT public.session_heartbeat('test_sess_x');
--   SELECT session_id, last_seen FROM public.user_sessions WHERE session_id = 'test_sess_x';
--   DELETE FROM public.user_sessions WHERE session_id = 'test_sess_x';
