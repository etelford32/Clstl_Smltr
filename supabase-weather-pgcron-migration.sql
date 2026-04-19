-- ═══════════════════════════════════════════════════════════════
-- Parker Physics — Weather Grid Refresh via pg_cron (run in Supabase SQL Editor)
-- ═══════════════════════════════════════════════════════════════
-- Schedules an hourly Open-Meteo fetch entirely inside Postgres so the
-- refresh cron isn't subject to Vercel Hobby's once-per-day cap. Vercel
-- Cron at /api/weather/refresh stays wired up as a daily safety net.
--
-- Architecture:
--   Supabase pg_cron (hourly)  ───▶  refresh_weather_grid()
--                                          ├─▶ http_get(open-meteo)
--                                          └─▶ INSERT weather_grid_cache
--   Vercel Cron     (daily)    ───▶  /api/weather/refresh  (same target row)
--   Browsers       (15 min)    ───▶  /api/weather/grid     (cached read)
--
-- Run order (one-time, in the Supabase SQL Editor):
--   1. supabase-weather-cache-migration.sql   — creates the table + trim fn
--   2. THIS FILE                              — extensions + refresh fn + schedule
--
-- Safe to re-run; everything uses CREATE OR REPLACE / IF NOT EXISTS,
-- and the cron job is unscheduled before being re-scheduled.
-- ═══════════════════════════════════════════════════════════════

-- ── Required extensions ────────────────────────────────────────
-- Both ship with Supabase but must be enabled per-project. If the
-- CREATE EXTENSION statements error out due to privileges, enable
-- them from the Supabase dashboard (Database → Extensions), then
-- re-run this file.
CREATE EXTENSION IF NOT EXISTS pg_cron;   -- scheduled jobs, cron syntax
CREATE EXTENSION IF NOT EXISTS http;      -- synchronous HTTP calls from plpgsql

-- ═══════════════════════════════════════════════════════════════
-- refresh_weather_grid()
--
-- Fetches the 648-location Open-Meteo grid in a single HTTP GET and
-- inserts the response array into weather_grid_cache.
--
-- Mirrors api/weather/refresh.js (the Vercel handler used by the
-- daily safety-net cron). If you change the variable list, the grid
-- geometry, or the units in either file, update both.
--
-- Returns: the inserted row id, or raises on upstream failure.
-- pg_cron records exceptions in cron.job_run_details so failed runs
-- are inspectable; the next scheduled tick retries automatically.
-- ═══════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.refresh_weather_grid()
RETURNS BIGINT AS $$
DECLARE
    GRID_W      constant int  := 36;
    GRID_H      constant int  := 18;
    base_url    constant text := 'https://api.open-meteo.com/v1/forecast';
    current_vars text;
    lat_csv      text;
    lon_csv      text;
    full_url     text;
    response_body text;
    payload_json jsonb;
    inserted_id  bigint;
BEGIN
    -- Build comma-separated lat / lon arrays in row-major order (lat
    -- varies slowest), matching js/weather-feed.js + api/weather/refresh.js
    -- byte-for-byte. PostgreSQL doesn't guarantee array_agg ordering
    -- without ORDER BY, so it's specified explicitly.
    SELECT array_to_string(array_agg((-85  + j * 10)::text ORDER BY j, i), ','),
           array_to_string(array_agg((-175 + i * 10)::text ORDER BY j, i), ',')
      INTO lat_csv, lon_csv
      FROM generate_series(0, GRID_H - 1) AS j
     CROSS JOIN generate_series(0, GRID_W - 1) AS i;

    current_vars := 'temperature_2m,relative_humidity_2m,surface_pressure,'
                 || 'wind_speed_10m,wind_direction_10m,'
                 || 'cloud_cover_low,cloud_cover_mid,cloud_cover_high,'
                 || 'precipitation,cape';

    full_url := base_url
             || '?latitude='        || lat_csv
             || '&longitude='       || lon_csv
             || '&current='         || current_vars
             || '&wind_speed_unit=ms'
             || '&timezone=UTC';

    -- Synchronous GET. http extension blocks ~1-3 s while Open-Meteo
    -- responds. pg_cron jobs run in background workers, so the block
    -- never affects user-facing queries.
    SELECT content INTO response_body
      FROM http_get(full_url);

    IF response_body IS NULL OR length(response_body) < 100 THEN
        RAISE EXCEPTION 'Open-Meteo returned empty response (length %)',
            COALESCE(length(response_body), 0);
    END IF;

    -- Open-Meteo returns an array for multi-location queries; coerce
    -- single-object responses to one-element arrays so /api/weather/grid
    -- always sees a list (matches the JS parser in weather-feed.js).
    payload_json := response_body::jsonb;
    IF jsonb_typeof(payload_json) <> 'array' THEN
        payload_json := jsonb_build_array(payload_json);
    END IF;

    INSERT INTO public.weather_grid_cache (source, payload)
    VALUES ('open-meteo', payload_json)
    RETURNING id INTO inserted_id;

    -- Trim history opportunistically (function from the prior migration).
    -- Failure here is non-fatal: a few extra rows = a few extra KB.
    PERFORM public.trim_weather_grid_cache();

    RETURN inserted_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Lock down: only the cron job (running as superuser) and explicit
-- service_role calls should invoke this. Browsers must never reach it.
REVOKE ALL ON FUNCTION public.refresh_weather_grid() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.refresh_weather_grid() FROM anon, authenticated;

-- ═══════════════════════════════════════════════════════════════
-- Schedule: top of every hour
-- ═══════════════════════════════════════════════════════════════
-- Idempotent: any existing schedule with this jobname is removed first
-- so this whole file is safe to re-run after editing the function body.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'refresh-weather-grid') THEN
        PERFORM cron.unschedule('refresh-weather-grid');
    END IF;
END $$;

SELECT cron.schedule(
    'refresh-weather-grid',
    '0 * * * *',
    $cron$ SELECT public.refresh_weather_grid(); $cron$
);

-- ═══════════════════════════════════════════════════════════════
-- Verification — paste these into the SQL Editor after first install
-- ═══════════════════════════════════════════════════════════════
-- 1. Trigger one run manually to confirm the function works end-to-end:
--      SELECT public.refresh_weather_grid();
--
-- 2. Confirm the schedule registered:
--      SELECT jobid, schedule, command, active
--        FROM cron.job
--       WHERE jobname = 'refresh-weather-grid';
--
-- 3. See recent automatic runs (after the first scheduled hour):
--      SELECT runid, status, return_message, start_time, end_time
--        FROM cron.job_run_details
--       WHERE jobid = (
--           SELECT jobid FROM cron.job WHERE jobname = 'refresh-weather-grid'
--       )
--       ORDER BY start_time DESC
--       LIMIT 10;
--
-- 4. Confirm rows are landing in weather_grid_cache:
--      SELECT id, fetched_at, source,
--             jsonb_array_length(payload) AS locations
--        FROM public.weather_grid_cache
--       ORDER BY fetched_at DESC
--       LIMIT 5;
-- ═══════════════════════════════════════════════════════════════
