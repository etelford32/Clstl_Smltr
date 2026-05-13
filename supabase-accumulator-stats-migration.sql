-- ═══════════════════════════════════════════════════════════════
-- Parker Physics — Accumulator stats RPC (run in Supabase SQL Editor)
-- ═══════════════════════════════════════════════════════════════
-- Companion to supabase-forecast-accumulator-migration.sql. Adds a
-- single SECURITY DEFINER function that returns aggregate counts
-- over forecast_log + forecast_archive_pointer for the admin
-- dashboard tile.
--
-- Why an RPC instead of letting the admin page COUNT() the tables
-- directly:
--   - forecast_log has RLS on with no SELECT policy (server-only).
--     Granting a SELECT policy to authenticated would expose row
--     contents, not just counts. The function returns just the
--     aggregates so RLS posture stays tight.
--   - The function checks the caller's user_profiles.role before
--     returning real numbers — non-admins get zeros so a leaked
--     anon key can't be used to enumerate prediction volume.
--
-- Safe to re-run.
-- ═══════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.get_accumulator_stats()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    caller_role TEXT;
    hot_total   INTEGER;
    hot_today   INTEGER;
    hot_24h     INTEGER;
    hot_oldest  TIMESTAMPTZ;
    archived_total       INTEGER;
    archived_days        INTEGER;
    archived_last_day    DATE;
    archived_last_bytes  BIGINT;
    archived_total_bytes BIGINT;
BEGIN
    -- Caller-role check. Without this, any signed-in user could call
    -- the RPC and observe how many predictions we're collecting —
    -- harmless on its own, but the tile is part of the operator
    -- surface, not a public number.
    SELECT role INTO caller_role
      FROM public.user_profiles
     WHERE id = auth.uid();

    -- NULL-safe role check. When auth.uid() is NULL (anon caller) the
    -- SELECT above leaves caller_role NULL, and `NULL NOT IN (...)`
    -- evaluates to NULL — which `IF NULL THEN ...` does NOT trigger,
    -- so we'd fall through to the authorized path. Explicitly handle.
    IF caller_role IS NULL
       OR caller_role NOT IN ('admin', 'superadmin') THEN
        -- Return a zero-shape payload so the admin tile's render path
        -- never has to special-case "denied". The admin page checks
        -- role independently before showing the card anyway.
        RETURN jsonb_build_object(
            'authorized',          FALSE,
            'hot_total',           0,
            'hot_today',           0,
            'hot_24h',             0,
            'hot_oldest',          NULL,
            'archived_total',      0,
            'archived_days',       0,
            'archived_last_day',   NULL,
            'archived_last_bytes', 0,
            'archived_total_bytes',0
        );
    END IF;

    SELECT COUNT(*),
           COUNT(*) FILTER (WHERE made_at::date = (now() AT TIME ZONE 'UTC')::date),
           COUNT(*) FILTER (WHERE made_at >= now() - INTERVAL '24 hours'),
           MIN(made_at)
      INTO hot_total, hot_today, hot_24h, hot_oldest
      FROM public.forecast_log;

    SELECT COALESCE(SUM(row_count), 0),
           COUNT(*),
           MAX(day),
           COALESCE(SUM(bytes), 0)
      INTO archived_total, archived_days, archived_last_day, archived_total_bytes
      FROM public.forecast_archive_pointer;

    SELECT bytes INTO archived_last_bytes
      FROM public.forecast_archive_pointer
     WHERE day = archived_last_day
     ORDER BY written_at DESC
     LIMIT 1;

    RETURN jsonb_build_object(
        'authorized',           TRUE,
        'hot_total',            hot_total,
        'hot_today',            hot_today,
        'hot_24h',              hot_24h,
        'hot_oldest',           hot_oldest,
        'archived_total',       archived_total,
        'archived_days',        archived_days,
        'archived_last_day',    archived_last_day,
        'archived_last_bytes',  COALESCE(archived_last_bytes, 0),
        'archived_total_bytes', archived_total_bytes,
        'as_of',                now()
    );
END;
$$;

-- authenticated may call. The function's internal role check is the
-- real gate; revoking from anon prevents wasted calls without a session.
REVOKE ALL ON FUNCTION public.get_accumulator_stats() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_accumulator_stats() FROM anon;
GRANT EXECUTE ON FUNCTION public.get_accumulator_stats() TO authenticated;

-- ═══════════════════════════════════════════════════════════════
-- Verification
-- ═══════════════════════════════════════════════════════════════
-- As superadmin (in SQL Editor, you bypass auth.uid() — to test the
-- gate behaviour, sign in as a non-admin user in the dashboard):
--      SELECT public.get_accumulator_stats();
-- ═══════════════════════════════════════════════════════════════
