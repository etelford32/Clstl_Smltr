-- ═══════════════════════════════════════════════════════════════
-- Parker Physics — DB-backed email rate limit + send analytics
-- ═══════════════════════════════════════════════════════════════
-- Replaces the in-memory rate counter that previously lived in
-- api/alerts/email.js. The in-memory version was per-edge-function-
-- instance, so a determined caller could bypass the limit by hitting
-- different Vercel POPs (each with its own isolate) or by triggering
-- cold-starts. This version is global, atomic, and per-user.
--
-- Same table doubles as the email send log used by the admin
-- dashboard — every send attempt (allowed AND throttled) gets one
-- row, so admins can audit volume, top recipients, and rate-limit
-- events without standing up a separate analytics table.
--
-- Apply order: AFTER supabase-schema.sql. Idempotent
-- (CREATE TABLE IF NOT EXISTS / CREATE OR REPLACE FUNCTION).
-- ═══════════════════════════════════════════════════════════════


-- ── 1. email_send_log table ─────────────────────────────────────
-- One row per send ATTEMPT (allowed or throttled).
--
-- endpoint  : 'alerts' | 'invites' | future endpoints
-- user_id   : the JWT caller. For alerts that's the recipient. For
--             invites it's the issuing admin (recipient is in
--             recipient_email).
-- throttled : true if the rate limit rejected this attempt. Stored
--             so the admin dashboard can surface the count and so
--             abuse patterns are visible historically.
-- metadata  : JSONB for endpoint-specific data: severity for alerts,
--             plan tier for invites, etc. Schema-less so adding a
--             new endpoint doesn't require ALTER TABLE.

CREATE TABLE IF NOT EXISTS public.email_send_log (
    id              BIGSERIAL    PRIMARY KEY,
    sent_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
    endpoint        TEXT         NOT NULL,
    user_id         UUID         REFERENCES auth.users(id) ON DELETE SET NULL,
    recipient_email TEXT,
    subject         TEXT,
    throttled       BOOLEAN      NOT NULL DEFAULT false,
    metadata        JSONB        NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_email_send_log_user_endpoint_time
    ON public.email_send_log (user_id, endpoint, sent_at DESC);

CREATE INDEX IF NOT EXISTS idx_email_send_log_sent_at
    ON public.email_send_log (sent_at DESC);

ALTER TABLE public.email_send_log ENABLE ROW LEVEL SECURITY;

-- Admins (and only admins) can read the log. service_role bypasses
-- RLS, which is how the endpoints write rows.
DROP POLICY IF EXISTS "Admins can view email send log"
    ON public.email_send_log;
CREATE POLICY "Admins can view email send log"
    ON public.email_send_log FOR SELECT
    USING (public.is_admin());


-- ── 2. try_send_email_quota(...) RPC ────────────────────────────
-- Atomically: check whether the caller is under their per-user/per-
-- endpoint limit, then INSERT a log row (with throttled set
-- appropriately). Returns TRUE if the caller may proceed to send.
--
-- Per-user serialization via pg_advisory_xact_lock prevents the
-- check-then-insert race that would otherwise let two concurrent
-- requests both pass when the user is exactly at the limit. The lock
-- is keyed on (user_id, endpoint) so different users / endpoints
-- don't contend with each other.
--
-- Throttled rows are NOT counted toward the limit (`throttled = false`
-- in the count predicate) so a user who is currently rate-limited
-- doesn't keep ratcheting their own throttle count. Throttled rows
-- still log for the admin dashboard.
--
-- Defaults: 10 sends per 3600 s. Callers can pass per-endpoint
-- limits (api/invites/send uses a higher limit since admins issue
-- many invites in a launch burst).

CREATE OR REPLACE FUNCTION public.try_send_email_quota(
    p_user_id         UUID,
    p_endpoint        TEXT,
    p_recipient       TEXT    DEFAULT NULL,
    p_subject         TEXT    DEFAULT NULL,
    p_metadata        JSONB   DEFAULT '{}'::jsonb,
    p_limit           INT     DEFAULT 10,
    p_window_seconds  INT     DEFAULT 3600
) RETURNS BOOLEAN AS $$
DECLARE
    v_count   INT;
    v_allowed BOOLEAN;
BEGIN
    -- Cheap per-(user, endpoint) lock. Releases automatically at
    -- transaction end (i.e. immediately after this RPC returns).
    PERFORM pg_advisory_xact_lock(
        hashtext(COALESCE(p_user_id::text, '') || ':' || p_endpoint)
    );

    SELECT count(*) INTO v_count
      FROM public.email_send_log
     WHERE user_id  = p_user_id
       AND endpoint = p_endpoint
       AND throttled = false
       AND sent_at > now() - (p_window_seconds || ' seconds')::interval;

    v_allowed := v_count < p_limit;

    INSERT INTO public.email_send_log
        (endpoint, user_id, recipient_email, subject, throttled, metadata)
    VALUES
        (p_endpoint, p_user_id, p_recipient, p_subject, NOT v_allowed,
         COALESCE(p_metadata, '{}'::jsonb));

    RETURN v_allowed;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION public.try_send_email_quota(
    UUID, TEXT, TEXT, TEXT, JSONB, INT, INT
) FROM PUBLIC, anon, authenticated;
-- service_role keeps EXECUTE by default (it's the postgres role).


-- ── 3. Optional: pg_cron retention (90 days) ────────────────────
-- The log will accumulate ~thousands of rows per active week. Keep
-- 90 days of history; older rows are pruned hourly. If pg_cron isn't
-- enabled in this project, run it manually:
--   DELETE FROM public.email_send_log WHERE sent_at < now() - interval '90 days';

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
        PERFORM cron.unschedule('prune-email-send-log')
          WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'prune-email-send-log');
        PERFORM cron.schedule(
            'prune-email-send-log',
            '17 * * * *',  -- 17 minutes past every hour (off-peak from weather refresh)
            $cron$
                DELETE FROM public.email_send_log
                 WHERE sent_at < now() - interval '90 days';
            $cron$
        );
    END IF;
END $$;


-- ═══════════════════════════════════════════════════════════════
-- Verification
-- ═══════════════════════════════════════════════════════════════
-- 1. Table + index exist:
--      \d public.email_send_log
--
-- 2. RPC works:
--      SELECT public.try_send_email_quota(
--          '00000000-0000-0000-0000-000000000000'::uuid,
--          'test', 'test@example.com', 'Test', '{}'::jsonb, 2, 60);
--      -- Run 3 times in quick succession; first 2 return true,
--      -- 3rd returns false. All 3 leave rows in the log.
--      DELETE FROM public.email_send_log WHERE endpoint = 'test';
--
-- 3. Admin dashboard read access:
--      As an admin, query: SELECT count(*) FROM public.email_send_log;
--      As anon: should error with permission denied.
-- ═══════════════════════════════════════════════════════════════
