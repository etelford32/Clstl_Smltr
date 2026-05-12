-- ─────────────────────────────────────────────────────────────────────────────
-- supabase-auth-failures-migration.sql
--
-- Captures failed sign-in attempts so the admin Onboarding > Auth flow
-- card can show a real failure rate instead of the retry-count proxy
-- it's been using.
--
-- Why a separate table?
--   activation_events has FK auth.users(id) and RLS that requires
--   auth.uid() = user_id for every insert. A failed sign-in has, by
--   definition, no auth.uid() — Supabase Auth never minted a JWT.
--   We can't just bend the RLS open because that would let any visitor
--   write to activation_events. The clean separation: a no-FK,
--   no-RLS-write table fed only by a SECURITY DEFINER RPC that the
--   edge function calls with the service-role key.
--
-- Privacy:
--   We never store the plaintext email. The edge function hashes the
--   email with a server-side pepper (HMAC-SHA-256) before calling the
--   RPC; the table only ever sees the digest. Operators can still
--   count "distinct emails that failed" via COUNT(DISTINCT email_hash)
--   because the same plaintext always produces the same digest, but
--   they cannot reverse-engineer who tried to log in.
--
-- Idempotent. Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.auth_failures (
    id          BIGSERIAL PRIMARY KEY,
    email_hash  TEXT NOT NULL,           -- HMAC-SHA-256(email, pepper)
    reason      TEXT,                    -- supabase error message, truncated to 200ch
    ua_short    TEXT,                    -- first 80 chars of User-Agent (for OS/browser bucket)
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_auth_failures_email_time
    ON public.auth_failures(email_hash, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_auth_failures_time
    ON public.auth_failures(created_at DESC);

ALTER TABLE public.auth_failures ENABLE ROW LEVEL SECURITY;

-- Read: admins only. The table is privacy-sensitive (it's a list of
-- failed login attempts) so locking SELECT down to admin is the safe
-- default; the edge function uses the service-role key for inserts so
-- no INSERT policy is needed.
DROP POLICY IF EXISTS "Admins read auth failures" ON public.auth_failures;
CREATE POLICY "Admins read auth failures"
    ON public.auth_failures FOR SELECT
    USING (public.is_admin());


-- ── log_auth_failure RPC ───────────────────────────────────────────────────
-- Called by the edge function api/auth/log-failure. Rate-limits per
-- email_hash to keep an attacker from flooding the table with garbage.
-- Returns true on insert, false on rate-limit or invalid input.
--
-- The rate limit is intentionally loose (10 / hour / hash) — we want
-- to capture genuine retry storms, not throttle them. Real abuse
-- patterns (one-attacker-many-emails) get caught at the edge by the
-- service-key + origin allow-list.

CREATE OR REPLACE FUNCTION public.log_auth_failure(
    p_email_hash TEXT,
    p_reason     TEXT DEFAULT NULL,
    p_ua_short   TEXT DEFAULT NULL,
    p_limit      INT  DEFAULT 10
) RETURNS BOOLEAN AS $$
DECLARE
    v_recent INT;
BEGIN
    IF p_email_hash IS NULL OR length(p_email_hash) < 16 THEN
        RETURN FALSE;
    END IF;

    SELECT COUNT(*) INTO v_recent
      FROM public.auth_failures
     WHERE email_hash = p_email_hash
       AND created_at > now() - INTERVAL '1 hour';

    IF v_recent >= p_limit THEN
        RETURN FALSE;
    END IF;

    INSERT INTO public.auth_failures (email_hash, reason, ua_short)
    VALUES (p_email_hash, LEFT(COALESCE(p_reason, ''), 200), LEFT(COALESCE(p_ua_short, ''), 80));
    RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Anon executes via the service-role key in the edge function, so we
-- don't grant authenticated EXECUTE here — only the service role can
-- call it (default for SECURITY DEFINER + REVOKE on PUBLIC).
REVOKE ALL ON FUNCTION public.log_auth_failure(TEXT, TEXT, TEXT, INT) FROM PUBLIC;


-- ── Refresh auth_flow_metrics() to UNION in the failure counts ─────────────
-- The activation_events branch keeps reading the same five events it
-- did before (signup, signin_succeeded, returning_user_session,
-- welcome_email_sent — and signin_failed, which never has rows there
-- but is harmless to keep in the IN-list). The auth_failures branch
-- is added below it so the JS fetcher sees a single 'signin_failed'
-- row with real numbers.
--
-- Distinct-user count for failures is COUNT(DISTINCT email_hash) —
-- so a user who failed five times and finally succeeded counts as
-- one in both signinSuccesses and signinFailures, which is exactly
-- what the admin card wants ("how many distinct people hit a failure?").

CREATE OR REPLACE FUNCTION public.auth_flow_metrics(p_days INT DEFAULT 30)
RETURNS TABLE(
    event       TEXT,
    user_count  BIGINT,
    event_count BIGINT
) AS $$
    SELECT event,
           COUNT(DISTINCT user_id)  AS user_count,
           COUNT(*)                 AS event_count
      FROM public.activation_events
     WHERE event IN ('signup',
                     'signin_succeeded',
                     'returning_user_session',
                     'welcome_email_sent')
       AND created_at > now() - (p_days || ' days')::interval
     GROUP BY event
    UNION ALL
    SELECT 'signin_failed'                  AS event,
           COUNT(DISTINCT email_hash)       AS user_count,
           COUNT(*)                         AS event_count
      FROM public.auth_failures
     WHERE created_at > now() - (p_days || ' days')::interval
    ORDER BY event;
$$ LANGUAGE sql SECURITY DEFINER STABLE;

GRANT EXECUTE ON FUNCTION public.auth_flow_metrics(INT) TO authenticated;


-- Smoke test (run after applying):
--   -- Manual fail row (replace HMAC_DIGEST with a 64-char hex string):
--   SELECT public.log_auth_failure('a'||repeat('b',63), 'invalid_credentials', 'Mozilla/5.0…');
--   -- Should populate the admin card with one user_count for signin_failed:
--   SELECT * FROM public.auth_flow_metrics(30);
