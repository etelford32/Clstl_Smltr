-- supabase-solar-wind-cron-handoff.sql
--
-- Hands solar-wind ingestion off from pg_cron to the Vercel cron
-- api/cron/refresh-solar-wind.js.
--
-- Why: the pg_cron job ('refresh-solar-wind', scheduled in
-- supabase-solar-wind-migration.sql) ran public.refresh_solar_wind()
-- every minute, which http_get()s NOAA's full-day rtsw_wind_1m.json
-- (~1-2 MB) inside a Postgres backend and parses it into jsonb to
-- insert one row. Measured at handoff (2026-06-13, pg_stat_statements):
-- 73,889 calls, 12,358 s total execution, ~72.7M shared-block accesses
-- — the dominant compute/memory load on the 1 GB instance and the
-- driver of the Supabase memory warnings. The Vercel cron does the
-- fetch + parse off-instance and writes via record_solar_wind_sample().
--
-- ── Step 1 — applied at handoff time (2026-06-13), BEFORE the Vercel
--    cron deployed: reduce cadence 1 min → 5 min so data keeps flowing
--    through the cutover at ~20% of the old cost. Already executed
--    against aijsboodkivnhzfstvdq; kept here for the record.
SELECT cron.alter_job(
    (SELECT jobid FROM cron.job WHERE jobname = 'refresh-solar-wind'),
    schedule := '*/5 * * * *'
);

-- ── Step 2 — run AFTER the deploy containing
--    api/cron/refresh-solar-wind.js is live in production and
--    pipeline_heartbeat shows fresh 'solar_wind' successes (check
--    last_success_at advancing every minute):
--
--      SELECT cron.unschedule('refresh-solar-wind');
--
-- public.refresh_solar_wind() is intentionally LEFT IN PLACE as a
-- manual fallback (SELECT public.refresh_solar_wind();) for when the
-- Vercel surface is down. Do not drop it.
--
-- Rollback: if the Vercel cron misbehaves, re-enable the old cadence:
--
--      SELECT cron.schedule('refresh-solar-wind', '* * * * *',
--                           $$ SELECT public.refresh_solar_wind(); $$);
