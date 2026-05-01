-- ═══════════════════════════════════════════════════════════════
-- Parker Physics — Weather Grid pg_cron Secondary Writer
-- Run in Supabase SQL Editor AFTER the Vercel cron rewrite
-- (api/cron/refresh-weather-grid.js) is deployed.
-- ═══════════════════════════════════════════════════════════════
-- Background — why pg_cron is back as a SECONDARY (not primary):
--
--   The Vercel cron is the primary writer. It runs hourly at *:00 from
--   Vercel's edge IP pool. When Open-Meteo's per-IP daily limit is hit
--   on Vercel's pool (a known shared-tenancy issue) the metno fallback
--   inside the Vercel cron handles it. But if the Vercel cron itself
--   is unhealthy (deploy-rollback, runtime upgrade, env var lost), we
--   used to have NO writer at all — that's how the pipeline went 4 days
--   stale.
--
--   This migration brings pg_cron back as a guarded secondary writer:
--
--     - Schedules at *:30, offset 30 minutes from the Vercel cron, so a
--       missed *:00 invocation gets a chance 30 minutes later instead
--       of waiting a full hour.
--     - The wrapper refresh_weather_grid_if_stale() inspects the latest
--       row in weather_grid_cache and SKIPS the upstream call if it's
--       newer than 45 minutes. So when the Vercel cron is healthy this
--       function is a near-no-op (one fast SELECT). It only burns
--       Open-Meteo quota when the primary path actually missed.
--     - Supabase's egress IP shares Open-Meteo's daily-limit pool with
--       other tenants. That's why this is the SECONDARY — it's a
--       safety net for Vercel-side outages, not a replacement.
--
-- Run order:
--   1. supabase-weather-cache-migration.sql (already applied)
--   2. supabase-pipeline-heartbeat-migration.sql (already applied)
--   3. supabase-weather-pgcron-migration.sql (already applied; this
--      file rewrites the function it created)
--   4. supabase-weather-unschedule-migration.sql (already applied)
--   5. THIS FILE — overwrites refresh_weather_grid() with the 72×36
--      version, creates the stale-guard wrapper, schedules at *:30
--
-- Safe to re-run.
-- ═══════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS http;

-- ═══════════════════════════════════════════════════════════════
-- refresh_weather_grid()  (overwrite of the 36×18 version)
--
-- 72×36 grid (5° spacing, centered cells: -87.5…87.5 × -177.5…177.5)
-- to match api/cron/refresh-weather-grid.js. Same Open-Meteo `current=`
-- variable list, no `cape` (which is hourly-only and broke the original
-- pgcron build). Tags `source` with `:WxH` so consumers parse grid dims
-- the same way they do for Vercel-cron rows.
-- ═══════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.refresh_weather_grid()
RETURNS BIGINT AS $$
DECLARE
    GRID_W       constant int  := 72;
    GRID_H       constant int  := 36;
    GRID_DEG     constant numeric := 5.0;
    LAT_ORIGIN   constant numeric := -87.5;
    LON_ORIGIN   constant numeric := -177.5;
    base_url     constant text := 'https://api.open-meteo.com/v1/forecast';
    current_vars text;
    lat_csv      text;
    lon_csv      text;
    base_params  text;
    attempts     text[];
    attempt_url  text;
    win_source   text;
    response_body text;
    payload_json jsonb;
    inserted_id  bigint;
    last_err     text;
BEGIN
    -- Build comma-separated lat / lon arrays in row-major order (lat
    -- varies slowest), matching js/weather-feed.js's consumer-side grid
    -- byte-for-byte.
    SELECT array_to_string(array_agg((LAT_ORIGIN + j * GRID_DEG)::text ORDER BY j, i), ','),
           array_to_string(array_agg((LON_ORIGIN + i * GRID_DEG)::text ORDER BY j, i), ',')
      INTO lat_csv, lon_csv
      FROM generate_series(0, GRID_H - 1) AS j
     CROSS JOIN generate_series(0, GRID_W - 1) AS i;

    current_vars := 'temperature_2m,relative_humidity_2m,surface_pressure,'
                 || 'wind_speed_10m,wind_direction_10m,'
                 || 'cloud_cover_low,cloud_cover_mid,cloud_cover_high,'
                 || 'precipitation';

    base_params := '?latitude='      || lat_csv
                || '&longitude='     || lon_csv
                || '&current='       || current_vars
                || '&wind_speed_unit=ms'
                || '&timezone=UTC';

    -- Single Open-Meteo URL with all 2592 lat/lon pairs. URL length is
    -- ~30 KB which Open-Meteo currently accepts (verified empirically).
    -- If they tighten that limit, switch to the chunked Vercel approach.
    attempts := ARRAY[
        'open-meteo'     || '|' || base_url || base_params,
        'open-meteo-gfs' || '|' || base_url || base_params || '&models=gfs_seamless'
    ];

    win_source   := NULL;
    payload_json := NULL;
    last_err     := NULL;

    FOREACH attempt_url IN ARRAY attempts LOOP
        DECLARE
            pipe_pos int;
            src_tag  text;
            url_str  text;
        BEGIN
            pipe_pos := position('|' in attempt_url);
            src_tag  := substr(attempt_url, 1, pipe_pos - 1);
            url_str  := substr(attempt_url, pipe_pos + 1);

            SELECT content INTO response_body
              FROM http_get(url_str);

            IF response_body IS NULL OR length(response_body) < 100 THEN
                last_err := format('%s empty response (length %s)',
                                   src_tag, COALESCE(length(response_body), 0));
                CONTINUE;
            END IF;

            payload_json := response_body::jsonb;
            IF jsonb_typeof(payload_json) <> 'array' THEN
                payload_json := jsonb_build_array(payload_json);
            END IF;

            -- Open-Meteo error envelope: { error: true, reason: "..." }
            -- jsonb returns single object → we wrapped it above. Detect
            -- by checking for an `error: true` element and rejecting.
            IF jsonb_array_length(payload_json) = 1
                AND payload_json->0->>'error' = 'true' THEN
                last_err := format('%s upstream error: %s',
                                   src_tag, COALESCE(payload_json->0->>'reason', 'unknown'));
                payload_json := NULL;
                -- Daily-limit envelopes mean retrying gfs_seamless is
                -- pointless — same exhausted IP. Bail out of the loop.
                IF last_err ILIKE '%daily api request limit%' THEN
                    EXIT;
                END IF;
                CONTINUE;
            END IF;

            IF jsonb_array_length(payload_json) = 0 THEN
                last_err := format('%s zero-length array', src_tag);
                payload_json := NULL;
                CONTINUE;
            END IF;

            IF jsonb_array_length(payload_json) <> GRID_W * GRID_H THEN
                last_err := format('%s length %s != %s',
                                   src_tag, jsonb_array_length(payload_json), GRID_W * GRID_H);
                payload_json := NULL;
                CONTINUE;
            END IF;

            win_source := src_tag;
            EXIT;   -- success
        EXCEPTION WHEN OTHERS THEN
            last_err := format('%s %s', src_tag, SQLERRM);
            payload_json := NULL;
        END;
    END LOOP;

    IF payload_json IS NULL OR win_source IS NULL THEN
        PERFORM public.record_pipeline_failure(
            'weather_grid',
            COALESCE(last_err, 'all weather sources exhausted (pg_cron secondary)')
        );
        RAISE EXCEPTION 'weather_grid pg_cron refresh failed: %', COALESCE(last_err, 'unknown');
    END IF;

    -- Tag source with grid dims so the frontend can parse :WxH the same
    -- way it does for Vercel-cron rows.
    INSERT INTO public.weather_grid_cache (source, payload)
    VALUES (win_source || ':' || GRID_W::text || 'x' || GRID_H::text, payload_json)
    RETURNING id INTO inserted_id;

    PERFORM public.trim_weather_grid_cache();
    PERFORM public.record_pipeline_success(
        'weather_grid',
        win_source || ':' || GRID_W::text || 'x' || GRID_H::text
    );

    RETURN inserted_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION public.refresh_weather_grid() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.refresh_weather_grid() FROM anon, authenticated;

-- ═══════════════════════════════════════════════════════════════
-- refresh_weather_grid_if_stale()
--
-- The actual cron entry point. Inspects the latest row and only fires
-- the upstream call if the cache is older than 45 minutes — so when
-- the Vercel cron is healthy, this is a fast no-op SELECT and we don't
-- double-write or burn Open-Meteo quota unnecessarily.
--
-- Returns the inserted row id when it ran a refresh, or NULL when it
-- skipped because the cache was fresh.
-- ═══════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.refresh_weather_grid_if_stale()
RETURNS BIGINT AS $$
DECLARE
    last_age INTERVAL;
BEGIN
    SELECT (now() - MAX(fetched_at)) INTO last_age
      FROM public.weather_grid_cache;

    -- 45 minute threshold matches the Vercel cron's hourly cadence + a
    -- generous slop window — anything older means the *:00 tick missed.
    IF last_age IS NULL OR last_age > INTERVAL '45 minutes' THEN
        RAISE NOTICE 'weather_grid_cache stale (% old) — running secondary refresh', last_age;
        RETURN public.refresh_weather_grid();
    ELSE
        RAISE NOTICE 'weather_grid_cache fresh (% old) — secondary refresh skipped', last_age;
        RETURN NULL;
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION public.refresh_weather_grid_if_stale() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.refresh_weather_grid_if_stale() FROM anon, authenticated;

-- ═══════════════════════════════════════════════════════════════
-- Schedule at *:30 — offset 30 minutes from the Vercel cron at *:00
-- ═══════════════════════════════════════════════════════════════
DO $$
BEGIN
    -- The unschedule migration removed any prior 'refresh-weather-grid'
    -- job; we're using a different jobname so the secondary stays
    -- distinct in cron.job_run_details for diagnostics.
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'refresh-weather-grid-secondary') THEN
        PERFORM cron.unschedule('refresh-weather-grid-secondary');
    END IF;
END $$;

SELECT cron.schedule(
    'refresh-weather-grid-secondary',
    '30 * * * *',
    $cron$ SELECT public.refresh_weather_grid_if_stale(); $cron$
);

-- ═══════════════════════════════════════════════════════════════
-- Verification
-- ═══════════════════════════════════════════════════════════════
-- 1. Manually fire once to sanity-check the new 72×36 path:
--      SELECT public.refresh_weather_grid();
--    Expect a BIGINT id; weather_grid_cache should gain a row with
--    payload length 2592 and source like 'open-meteo:72x36'.
--
-- 2. Confirm the schedule registered:
--      SELECT jobid, schedule, command, active
--        FROM cron.job
--       WHERE jobname = 'refresh-weather-grid-secondary';
--
-- 3. After the next *:30 tick, see whether it ran or skipped:
--      SELECT runid, status, return_message, start_time, end_time
--        FROM cron.job_run_details
--       WHERE jobid = (SELECT jobid FROM cron.job
--                       WHERE jobname = 'refresh-weather-grid-secondary')
--       ORDER BY start_time DESC LIMIT 5;
--    The return_message will contain the NOTICE text either way.
-- ═══════════════════════════════════════════════════════════════
