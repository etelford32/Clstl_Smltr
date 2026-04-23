-- ═══════════════════════════════════════════════════════════════
-- Parker Physics — Unschedule the weather_grid pg_cron job
-- Run in the Supabase SQL Editor AFTER the Vercel cron endpoint
-- (api/cron/refresh-weather-grid) has deployed and shown at least
-- one successful run in cron invocations.
-- ═══════════════════════════════════════════════════════════════
-- Why: Supabase's shared outbound IP hits Open-Meteo's per-IP free-tier
-- daily-call limit because of OTHER tenants (observed in
-- pipeline_heartbeat as "Daily API request limit exceeded"). The grid
-- refresh has been moved to /api/cron/refresh-weather-grid, which runs
-- from Vercel's edge egress IPs and so sidesteps that saturation.
--
-- What this migration does and doesn't do:
--   - UNSCHEDULES the 'refresh-weather-grid' pg_cron job so Supabase
--     stops hammering Open-Meteo from a capped IP.
--   - LEAVES the refresh_weather_grid() function in place. It's still
--     callable manually (SELECT public.refresh_weather_grid();) for
--     debugging or as a temporary fallback if the Vercel cron breaks.
--     Keeping the function itself is cheap — the only cost of the old
--     approach was the scheduled invocation.
--
-- Safe to re-run: DO blocks check for existence first.
-- ═══════════════════════════════════════════════════════════════

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'refresh-weather-grid') THEN
        PERFORM cron.unschedule('refresh-weather-grid');
        RAISE NOTICE 'Unscheduled pg_cron job: refresh-weather-grid';
    ELSE
        RAISE NOTICE 'No pg_cron job named refresh-weather-grid — nothing to do.';
    END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════
-- Verification
-- ═══════════════════════════════════════════════════════════════
-- 1. Confirm the schedule is gone:
--      SELECT jobid, jobname, schedule, active
--        FROM cron.job
--       WHERE jobname = 'refresh-weather-grid';
--    Expect: zero rows.
--
-- 2. Confirm the function still exists (for manual fallback):
--      SELECT proname
--        FROM pg_proc
--       WHERE proname = 'refresh_weather_grid';
--    Expect: one row.
--
-- 3. After the Vercel cron fires (top of hour) OR after a manual
--    POST to /api/cron/refresh-weather-grid, the heartbeat should
--    show a fresh success:
--      SELECT last_success_at, last_failure_at, last_source
--        FROM public.pipeline_heartbeat
--       WHERE pipeline_name = 'weather_grid';
-- ═══════════════════════════════════════════════════════════════
