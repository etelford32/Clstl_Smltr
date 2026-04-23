-- ═══════════════════════════════════════════════════════════════
-- Parker Physics — Weather Grid pg_cron FIX migration
-- Run AFTER supabase-weather-pgcron-migration.sql (this replaces
-- refresh_weather_grid() in place; the schedule row is untouched).
-- ═══════════════════════════════════════════════════════════════
-- Two bugs in the original refresh_weather_grid():
--
--   1. SSL connection timeout on the single giant 648-location URL.
--      One `http_get` call of ~5 KB URL + ~800 KB response trips
--      Supabase's `http` extension timeout (and in some regions,
--      Open-Meteo closes the TLS connection on long multi-location
--      reads). Observed in production:
--        ERROR: weather_grid refresh failed: open-meteo-gfs SSL
--        connection timeout
--      Fix: chunk the grid into CHUNK_SIZE-location batches, fetch
--      each batch sequentially, concatenate the JSON arrays in
--      row-major order before INSERT. Keeps URL length under ~1 KB
--      per request and each response under ~130 KB — well inside
--      every HTTP/TLS/timeout budget.
--
--   2. RAISE EXCEPTION at the end rolled back the
--      record_pipeline_failure() INSERT along with everything else,
--      so the admin UI + pipeline_heartbeat showed "never succeeded"
--      with no failure_reason. Operators couldn't see WHY pg_cron
--      was failing without spelunking through cron.job_run_details.
--      Fix: don't raise. Record the failure in pipeline_heartbeat
--      (that INSERT now commits) and RETURN NULL. pg_cron marks the
--      run as succeeded — the TRUTH is in pipeline_heartbeat, which
--      the admin dashboard reads directly.
--
-- Safe to re-run (CREATE OR REPLACE).
-- ═══════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.refresh_weather_grid()
RETURNS BIGINT AS $$
DECLARE
    GRID_W       constant int  := 36;
    GRID_H       constant int  := 18;
    GRID_N       constant int  := GRID_W * GRID_H;   -- 648
    -- Per-batch cap. 162 = exactly GRID_N/4 so we fetch in 4 equal
    -- batches. Open-Meteo handles this size comfortably; adjust
    -- smaller if upstream timeouts return.
    CHUNK_SIZE   constant int  := 162;
    base_url     constant text := 'https://api.open-meteo.com/v1/forecast';
    current_vars text;
    tail_params  text;
    attempts     text[];
    attempt      text;
    pipe_pos     int;
    src_tag      text;
    model_qs     text;
    merged       jsonb := '[]'::jsonb;
    chunk_json   jsonb;
    chunk_start  int;
    chunk_end    int;
    chunk_lat    text;
    chunk_lon    text;
    chunk_url    text;
    response_body text;
    win_source   text;
    inserted_id  bigint;
    last_err     text;
    chunk_failed boolean;
BEGIN
    current_vars := 'temperature_2m,relative_humidity_2m,surface_pressure,'
                 || 'wind_speed_10m,wind_direction_10m,'
                 || 'cloud_cover_low,cloud_cover_mid,cloud_cover_high,'
                 || 'precipitation,cape';

    tail_params := '&current='      || current_vars
                || '&wind_speed_unit=ms'
                || '&timezone=UTC';

    -- Primary = default Open-Meteo (seamless blend). Fallback = GFS-only
    -- via the same provider. Format: "<tag>|<extra_query_suffix>".
    attempts := ARRAY[
        'open-meteo|',
        'open-meteo-gfs|&models=gfs_seamless'
    ];

    win_source := NULL;
    last_err   := NULL;

    FOREACH attempt IN ARRAY attempts LOOP
        pipe_pos  := position('|' in attempt);
        src_tag   := substr(attempt, 1, pipe_pos - 1);
        model_qs  := substr(attempt, pipe_pos + 1);
        merged    := '[]'::jsonb;
        chunk_failed := false;

        FOR chunk_start IN 0 .. (GRID_N - 1) BY CHUNK_SIZE LOOP
            chunk_end := LEAST(chunk_start + CHUNK_SIZE - 1, GRID_N - 1);

            -- Build comma-separated lat/lon for THIS chunk in row-major order
            -- (lat varies slowest). idx = j * GRID_W + i, so:
            --   j = idx / GRID_W, i = idx % GRID_W
            --   lat = -85 + j * 10, lon = -175 + i * 10
            SELECT array_to_string(array_agg((-85  + (idx / GRID_W) * 10)::text ORDER BY idx), ','),
                   array_to_string(array_agg((-175 + (idx % GRID_W) * 10)::text ORDER BY idx), ',')
              INTO chunk_lat, chunk_lon
              FROM generate_series(chunk_start, chunk_end) AS idx;

            chunk_url := base_url
                      || '?latitude='  || chunk_lat
                      || '&longitude=' || chunk_lon
                      || tail_params
                      || model_qs;

            BEGIN
                SELECT content INTO response_body FROM http_get(chunk_url);

                IF response_body IS NULL OR length(response_body) < 100 THEN
                    last_err := format('%s chunk %s empty response (length %s)',
                                       src_tag, chunk_start,
                                       COALESCE(length(response_body), 0));
                    chunk_failed := true;
                    EXIT;
                END IF;

                chunk_json := response_body::jsonb;
                -- Open-Meteo returns an object for a single location (if the
                -- chunk somehow ended up size 1), an array otherwise.
                IF jsonb_typeof(chunk_json) <> 'array' THEN
                    chunk_json := jsonb_build_array(chunk_json);
                END IF;

                IF jsonb_array_length(chunk_json) = 0 THEN
                    last_err := format('%s chunk %s zero-length array',
                                       src_tag, chunk_start);
                    chunk_failed := true;
                    EXIT;
                END IF;

                -- Append this chunk's items to `merged` in order. `||` on
                -- jsonb arrays concatenates.
                merged := merged || chunk_json;
            EXCEPTION WHEN OTHERS THEN
                last_err := format('%s chunk %s: %s', src_tag, chunk_start, SQLERRM);
                chunk_failed := true;
                EXIT;
            END;
        END LOOP;

        -- Every chunk must succeed AND we must end up with exactly GRID_N
        -- items. Partial assembly is not useful — the JS consumer expects
        -- a full 648-item array in row-major order.
        IF NOT chunk_failed AND jsonb_array_length(merged) = GRID_N THEN
            win_source := src_tag;
            EXIT;
        END IF;
        -- Otherwise try the next attempt (e.g. gfs fallback).
        merged := '[]'::jsonb;
    END LOOP;

    IF win_source IS NULL THEN
        -- Record WHY we failed so the admin UI can show it. Must NOT raise
        -- an exception: that would roll back this INSERT too, leaving
        -- pipeline_heartbeat silent about the real cause (the original
        -- bug this migration fixes).
        PERFORM public.record_pipeline_failure(
            'weather_grid',
            COALESCE(last_err, 'all weather sources exhausted')
        );
        RETURN NULL;
    END IF;

    INSERT INTO public.weather_grid_cache (source, payload)
    VALUES (win_source, merged)
    RETURNING id INTO inserted_id;

    -- Opportunistic retention trim. Non-fatal if it errors.
    BEGIN
        PERFORM public.trim_weather_grid_cache();
    EXCEPTION WHEN OTHERS THEN
        -- Swallow — retention failures are nuisance, not an outage.
        NULL;
    END;

    PERFORM public.record_pipeline_success('weather_grid', win_source);

    RETURN inserted_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION public.refresh_weather_grid() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.refresh_weather_grid() FROM anon, authenticated;

-- ═══════════════════════════════════════════════════════════════
-- Verification — run after applying
-- ═══════════════════════════════════════════════════════════════
-- 1. Trigger a run manually (4 HTTP calls, ~8-12 s total):
--      SELECT public.refresh_weather_grid();
--    Expect a bigint (inserted row id) on success, NULL on failure.
--
-- 2. Check the heartbeat (this is the source of truth now):
--      SELECT pipeline_name, last_success_at, last_failure_at,
--             last_failure_reason, last_source, consecutive_fail
--        FROM public.pipeline_heartbeat
--       WHERE pipeline_name = 'weather_grid';
--
-- 3. Confirm the cache row landed with the right shape:
--      SELECT id, fetched_at, source,
--             jsonb_array_length(payload) AS locations
--        FROM public.weather_grid_cache
--       ORDER BY fetched_at DESC
--       LIMIT 3;
--    "locations" should be 648.
-- ═══════════════════════════════════════════════════════════════
