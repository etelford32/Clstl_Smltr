-- ═══════════════════════════════════════════════════════════════
-- Parker Physics — Retention pg_cron + admin cron-status RPC
-- ═══════════════════════════════════════════════════════════════
-- Two related additions:
--
--   1. pg_cron jobs that prune analytics_events (180-day retention)
--      and alert_history (90-day retention) hourly. Without these
--      both tables grow without bound and chew through Supabase
--      Hobby's 8 GB cap in a few months of moderate traffic.
--
--   2. admin_get_cron_status() RPC that surfaces every scheduled
--      job's last-run status to the admin dashboard. Today,
--      cron.job_run_details only logs failures — nothing alerts
--      on them. The admin "Scheduled Jobs" card on the System tab
--      consumes this RPC and renders ✓/✗ per job.
--
-- Apply AFTER supabase-weather-pgcron-migration.sql (which is what
-- enables pg_cron in the first place) and AFTER
-- supabase-email-rate-limit-migration.sql (which already has its
-- own retention job).
--
-- Idempotent: cron jobs are unscheduled before being scheduled,
-- and the RPC is CREATE OR REPLACE.
-- ═══════════════════════════════════════════════════════════════


-- ── 1. Retention: analytics_events (180 days) ─────────────────
-- analytics_events has the highest write rate of any user-data
-- table — page views, custom events, every visitor. 180 days is
-- enough lookback for monthly comparisons + seasonal trend
-- analysis without keeping the long tail forever.
--
-- Pruning hourly is overkill for a daily-grain table but keeps
-- the autovacuum overhead low and bounds the worst-case bloat.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
        RAISE NOTICE 'pg_cron not installed — skipping schedule. Apply supabase-weather-pgcron-migration.sql first.';
        RETURN;
    END IF;

    -- analytics_events pruner
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'prune-analytics-events') THEN
        PERFORM cron.unschedule('prune-analytics-events');
    END IF;
    PERFORM cron.schedule(
        'prune-analytics-events',
        '27 * * * *',         -- 27 past every hour (off-peak from weather/email crons)
        $cron$
            DELETE FROM public.analytics_events
             WHERE created_at < now() - interval '180 days';
        $cron$
    );

    -- alert_history pruner — 90 days. Per-user fired alerts; users
    -- rarely look at history older than a few weeks, and admins
    -- have email_send_log for longer-window audit needs.
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'prune-alert-history') THEN
        PERFORM cron.unschedule('prune-alert-history');
    END IF;
    PERFORM cron.schedule(
        'prune-alert-history',
        '37 * * * *',
        $cron$
            DELETE FROM public.alert_history
             WHERE created_at < now() - interval '90 days';
        $cron$
    );
END $$;


-- ═══════════════════════════════════════════════════════════════
-- 2. admin_get_cron_status() RPC
-- ═══════════════════════════════════════════════════════════════
-- Returns one row per scheduled cron.job with its most-recent
-- run's status + 24-hour failure / total counts. SECURITY DEFINER
-- so the function can read cron.* (admin role isn't granted
-- access to that schema by default in Supabase).
--
-- The is_admin() guard inside the body is the actual access gate.
-- Non-admin callers get an empty result set, not an exception, so
-- the dashboard degrades gracefully if a tester loses admin rights
-- mid-session.
--
-- Returned columns (per job):
--   jobid                INT8     - cron internal id
--   jobname              TEXT     - the scheduled job name
--   schedule             TEXT     - the cron expression
--   active               BOOL     - false if temporarily disabled
--   command_preview      TEXT     - first 80 chars of the SQL
--   last_run_at          TS       - start_time of most recent run
--   last_run_status      TEXT     - 'succeeded' | 'failed' | 'running' | NULL
--   last_run_message     TEXT     - return_message from PostgreSQL
--   last_run_duration_s  NUMERIC  - end_time - start_time, seconds
--   recent_runs_24h      INT      - total runs in last 24h
--   recent_failures_24h  INT      - failures only

CREATE OR REPLACE FUNCTION public.admin_get_cron_status()
RETURNS TABLE (
    jobid                BIGINT,
    jobname              TEXT,
    schedule             TEXT,
    active               BOOLEAN,
    command_preview      TEXT,
    last_run_at          TIMESTAMPTZ,
    last_run_status      TEXT,
    last_run_message     TEXT,
    last_run_duration_s  NUMERIC,
    recent_runs_24h      BIGINT,
    recent_failures_24h  BIGINT
) AS $$
BEGIN
    -- Soft gate: non-admins get empty result, not an error. Means
    -- a stale dashboard session won't blow up — it just shows
    -- "no jobs found" while the user re-auths.
    IF NOT public.is_admin() THEN
        RETURN;
    END IF;

    -- pg_cron may not be installed in dev environments; return
    -- empty rather than erroring on the dashboard.
    IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
        RETURN;
    END IF;

    RETURN QUERY
    SELECT
        j.jobid,
        j.jobname::text,
        j.schedule::text,
        j.active,
        substring(j.command, 1, 80)::text                                       AS command_preview,
        last_run.start_time                                                     AS last_run_at,
        last_run.status::text                                                   AS last_run_status,
        last_run.return_message                                                 AS last_run_message,
        EXTRACT(EPOCH FROM (last_run.end_time - last_run.start_time))::numeric  AS last_run_duration_s,
        (SELECT count(*)
           FROM cron.job_run_details jrd
          WHERE jrd.jobid = j.jobid
            AND jrd.start_time > now() - interval '24 hours')                   AS recent_runs_24h,
        (SELECT count(*)
           FROM cron.job_run_details jrd
          WHERE jrd.jobid = j.jobid
            AND jrd.status = 'failed'
            AND jrd.start_time > now() - interval '24 hours')                   AS recent_failures_24h
      FROM cron.job j
 LEFT JOIN LATERAL (
              SELECT start_time, end_time, status, return_message
                FROM cron.job_run_details jrd
               WHERE jrd.jobid = j.jobid
            ORDER BY jrd.start_time DESC
               LIMIT 1
            ) last_run ON true
     ORDER BY j.jobname;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

REVOKE ALL ON FUNCTION public.admin_get_cron_status() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_get_cron_status() TO authenticated;


-- ═══════════════════════════════════════════════════════════════
-- Verification
-- ═══════════════════════════════════════════════════════════════
-- 1. Confirm the new prune jobs exist:
--      SELECT jobname, schedule, active
--        FROM cron.job
--       WHERE jobname IN ('prune-analytics-events', 'prune-alert-history')
--       ORDER BY jobname;
--
-- 2. Trigger a manual prune to confirm (deletes nothing if all
--    rows are recent; just exercises the SQL):
--      DELETE FROM public.analytics_events
--       WHERE created_at < now() - interval '180 days';
--      DELETE FROM public.alert_history
--       WHERE created_at < now() - interval '90 days';
--
-- 3. Test admin_get_cron_status from the dashboard:
--      In an admin browser session:
--        await supabase.rpc('admin_get_cron_status');
--      Expect: rows for 'refresh-weather-grid', 'prune-email-
--      send-log', 'prune-analytics-events', 'prune-alert-history',
--      each with last_run_status either NULL (never run) or
--      'succeeded' / 'failed'.
--
-- 4. Test non-admin call returns empty:
--      In an anon session:
--        await supabase.rpc('admin_get_cron_status');
--      Expect: empty array (no error).
-- ═══════════════════════════════════════════════════════════════
