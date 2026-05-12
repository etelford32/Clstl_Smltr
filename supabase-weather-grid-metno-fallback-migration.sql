-- ═══════════════════════════════════════════════════════════════
-- Parker Physics — Weather Grid pg_cron MET Norway fallback
-- Run in Supabase SQL Editor AFTER:
--   • supabase-weather-pgcron-secondary-migration.sql
--     (which created refresh_weather_grid + the *:30 secondary cron job)
-- ═══════════════════════════════════════════════════════════════
-- The problem this fixes
-- ----------------------
-- The current pg_cron secondary (refresh-weather-grid-secondary at
-- *:30) calls refresh_weather_grid(), which only tries Open-Meteo
-- attempts. The original reason the primary writer was moved to
-- Vercel was that Supabase's shared egress IP keeps hitting Open-
-- Meteo's per-IP free-tier daily limit — so the pg_cron secondary
-- fails *for the same reason* whenever Open-Meteo is the bottleneck.
--
-- Net effect: when the Vercel cron is also down (or all of Open-Meteo
-- is degraded), nothing writes. weather_grid_cache stales for days
-- (the 8-day silent stall this branch is named after).
--
-- The fix
-- -------
-- Add a third attempt: MET Norway, a different upstream entirely
-- (no shared limit with Open-Meteo). MET Norway's locationforecast
-- endpoint is point-only — no multi-location URL — so we sample a
-- coarse 18×9 grid (162 points, 20° spacing) to keep wallclock
-- inside a sane pg_cron worker budget. ~150-300 ms per http_get
-- means 24-50 s for the full 162-point sweep.
--
-- The coarse rows are tagged source='met-norway-coarse:18x9' so the
-- frontend's existing `:WxH` source-tag parser (api/weather/grid.js
-- projectRow + js/weather-feed.js) renders them at the correct, if
-- lower, resolution. Renderer uses bilinear sampling so degraded
-- detail is graceful — better than 8-day-stale data.
--
-- We deliberately do NOT bilinear-upsample to 72×36 here:
--   • the upsample math is verbose enough in plpgsql to be its own
--     bug surface
--   • the frontend already infers W,H from `:WxH` and re-samples
--     into its texture, so leaving the row coarse is information-
--     preserving (operators can tell from the source tag that they're
--     looking at a fallback frame)
--
-- Safe to re-run (CREATE OR REPLACE).
-- ═══════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS http;

-- ═══════════════════════════════════════════════════════════════
-- _refresh_weather_grid_metno()  — internal coarse-grid writer
-- ═══════════════════════════════════════════════════════════════
-- Returns the inserted row id on success; RAISEs (and records a
-- pipeline failure) on any unrecoverable upstream condition. The
-- public wrapper refresh_weather_grid() calls this only after every
-- Open-Meteo attempt has failed.
--
-- Tolerance: up to MAX_MISSING null points before the attempt is
-- declared a failure. A handful of MET Norway 4xx/5xx blips per run
-- is normal at the 20 req/s ToS cap.
CREATE OR REPLACE FUNCTION public._refresh_weather_grid_metno()
RETURNS BIGINT AS $$
DECLARE
    GRID_W       constant int     := 18;
    GRID_H       constant int     := 9;
    GRID_DEG     constant numeric := 20.0;            -- 360/18
    LAT_ORIGIN   constant numeric := -80;              -- centred 9 cells, step 20°
    LON_ORIGIN   constant numeric := -170;             -- centred 18 cells, step 20°
    base_url     constant text    := 'https://api.met.no/weatherapi/locationforecast/2.0/compact';
    -- MET Norway ToS requires a contactable User-Agent.
    user_agent   constant text    := 'ParkerPhysics/1.0 (+https://parkersphysics.com; ops@parkersphysics.com)';
    MAX_MISSING  constant int     := 8;                -- ≤ ~5% of 162 cells

    j            int;
    i            int;
    pt_lat       numeric;
    pt_lon       numeric;
    pt_url       text;
    response_body text;
    pt_json      jsonb;
    inst         jsonb;
    next1        jsonb;
    cell         jsonb;
    payload      jsonb := '[]'::jsonb;
    miss_count   int := 0;
    last_err     text;
    inserted_id  bigint;
BEGIN
    FOR j IN 0 .. GRID_H - 1 LOOP
        FOR i IN 0 .. GRID_W - 1 LOOP
            pt_lat := LAT_ORIGIN + j * GRID_DEG;
            pt_lon := LON_ORIGIN + i * GRID_DEG;
            -- 4 dp max — MET Norway returns 403 on higher precision.
            pt_url := base_url
                   || '?lat=' || trim(to_char(pt_lat, 'FM999990.0000'))
                   || '&lon=' || trim(to_char(pt_lon, 'FM999990.0000'));

            BEGIN
                SELECT content INTO response_body
                  FROM http((
                      'GET',
                      pt_url,
                      ARRAY[
                          http_header('User-Agent', user_agent),
                          http_header('Accept', 'application/json')
                      ],
                      NULL,
                      NULL
                  )::http_request);
            EXCEPTION WHEN OTHERS THEN
                miss_count := miss_count + 1;
                last_err   := format('lat=%s lon=%s fetch: %s', pt_lat, pt_lon, SQLERRM);
                response_body := NULL;
            END;

            IF response_body IS NULL OR length(response_body) < 50 THEN
                miss_count := miss_count + 1;
                cell := NULL;
            ELSE
                BEGIN
                    pt_json := response_body::jsonb;
                    inst    := pt_json #> '{properties,timeseries,0,data,instant,details}';
                    next1   := pt_json #> '{properties,timeseries,0,data,next_1_hours,details}';
                    -- Build the per-location envelope shape downstream
                    -- consumers (js/weather-feed.js _extractCoarse) expect.
                    -- MET Norway compact gives sea-level pressure, not
                    -- surface — close enough for the heatmap render.
                    cell := jsonb_build_object(
                        'latitude',  pt_lat,
                        'longitude', pt_lon,
                        '__pressure_kind', 'mean_sea_level',
                        '__upsampled',     false,
                        'current', jsonb_build_object(
                            'temperature_2m',       inst -> 'air_temperature',
                            'relative_humidity_2m', inst -> 'relative_humidity',
                            'surface_pressure',     inst -> 'air_pressure_at_sea_level',
                            'wind_speed_10m',       inst -> 'wind_speed',
                            'wind_direction_10m',   inst -> 'wind_from_direction',
                            'cloud_cover_low',      inst -> 'cloud_area_fraction_low',
                            'cloud_cover_mid',      inst -> 'cloud_area_fraction_medium',
                            'cloud_cover_high',     inst -> 'cloud_area_fraction_high',
                            'precipitation',        next1 -> 'precipitation_amount'
                        )
                    );
                EXCEPTION WHEN OTHERS THEN
                    miss_count := miss_count + 1;
                    last_err   := format('lat=%s lon=%s parse: %s', pt_lat, pt_lon, SQLERRM);
                    cell := NULL;
                END;
            END IF;

            -- Backfill missing cell with last good cell or a null-current
            -- shell so the array's positional index stays correct. The
            -- frontend's _extractCoarse tolerates null fields per cell.
            IF cell IS NULL THEN
                cell := jsonb_build_object(
                    'latitude',  pt_lat,
                    'longitude', pt_lon,
                    '__missing', true,
                    'current',   '{}'::jsonb
                );
            END IF;

            payload := payload || jsonb_build_array(cell);

            -- Bail early if the run is clearly going to fail the
            -- tolerance check — saves the rest of the wallclock.
            IF miss_count > MAX_MISSING * 4 THEN
                PERFORM public.record_pipeline_failure(
                    'weather_grid',
                    format('met-norway-coarse: %s misses by cell %s/%s; last: %s',
                           miss_count, (j * GRID_W + i + 1), GRID_W * GRID_H,
                           COALESCE(last_err, 'unknown'))
                );
                RAISE EXCEPTION 'met-norway-coarse aborted: too many upstream misses (%)', miss_count;
            END IF;
        END LOOP;
    END LOOP;

    IF miss_count > MAX_MISSING THEN
        PERFORM public.record_pipeline_failure(
            'weather_grid',
            format('met-norway-coarse: %s/%s misses (>%s allowed); last: %s',
                   miss_count, GRID_W * GRID_H, MAX_MISSING,
                   COALESCE(last_err, 'unknown'))
        );
        RAISE EXCEPTION 'met-norway-coarse refresh failed: % misses', miss_count;
    END IF;

    -- Tag with grid dims so the frontend renders at 18×9 instead of
    -- assuming the canonical 72×36 — the `:WxH` suffix path in
    -- api/weather/grid.js projectRow handles this transparently.
    INSERT INTO public.weather_grid_cache (source, payload)
    VALUES ('met-norway-coarse:' || GRID_W::text || 'x' || GRID_H::text, payload)
    RETURNING id INTO inserted_id;

    PERFORM public.trim_weather_grid_cache();
    PERFORM public.record_pipeline_success(
        'weather_grid',
        'met-norway-coarse:' || GRID_W::text || 'x' || GRID_H::text
    );

    RETURN inserted_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION public._refresh_weather_grid_metno() FROM PUBLIC;
REVOKE ALL ON FUNCTION public._refresh_weather_grid_metno() FROM anon, authenticated;

-- ═══════════════════════════════════════════════════════════════
-- refresh_weather_grid()  — overwrite to chain MET Norway fallback
-- ═══════════════════════════════════════════════════════════════
-- Same shape as the secondary-migration version: try Open-Meteo
-- (default + gfs_seamless), but now on either an exhausted-quota
-- envelope or all-attempts-exhausted, fall through to MET Norway
-- before declaring failure. The MET Norway attempt records its own
-- success/failure heartbeat, so this wrapper just propagates its
-- result.
--
-- Behavior summary:
--   1. Try open-meteo (single 2592-point URL).
--   2. On daily-limit envelope → skip gfs_seamless (same exhausted IP),
--      jump straight to step 4.
--   3. Otherwise try open-meteo-gfs.
--   4. On any open-meteo failure → call _refresh_weather_grid_metno().
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
    daily_limit_hit boolean := false;
BEGIN
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

            -- Skip the gfs_seamless retry if the first open-meteo
            -- attempt already saw a daily-limit envelope (same IP,
            -- same exhausted quota — wastes ~8s of the worker budget
            -- that MET Norway needs).
            IF daily_limit_hit AND src_tag LIKE 'open-meteo%' THEN
                CONTINUE;
            END IF;

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

            IF jsonb_array_length(payload_json) = 1
                AND payload_json->0->>'error' = 'true' THEN
                last_err := format('%s upstream error: %s',
                                   src_tag, COALESCE(payload_json->0->>'reason', 'unknown'));
                payload_json := NULL;
                IF last_err ILIKE '%daily api request limit%' THEN
                    daily_limit_hit := true;
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
            EXIT;
        EXCEPTION WHEN OTHERS THEN
            last_err := format('%s %s', src_tag, SQLERRM);
            payload_json := NULL;
        END;
    END LOOP;

    -- Open-Meteo path won — write & return.
    IF payload_json IS NOT NULL AND win_source IS NOT NULL THEN
        INSERT INTO public.weather_grid_cache (source, payload)
        VALUES (win_source || ':' || GRID_W::text || 'x' || GRID_H::text, payload_json)
        RETURNING id INTO inserted_id;

        PERFORM public.trim_weather_grid_cache();
        PERFORM public.record_pipeline_success(
            'weather_grid',
            win_source || ':' || GRID_W::text || 'x' || GRID_H::text
        );
        RETURN inserted_id;
    END IF;

    -- Open-Meteo exhausted — fall through to MET Norway. Don't record
    -- a failure yet; the metno helper records its own success/failure
    -- and the only state we want surfaced to the operator is the final
    -- outcome of this run, not the intermediate Open-Meteo miss.
    RAISE NOTICE 'weather_grid: Open-Meteo exhausted (%) — falling through to MET Norway coarse',
                 COALESCE(last_err, 'unknown');

    RETURN public._refresh_weather_grid_metno();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION public.refresh_weather_grid() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.refresh_weather_grid() FROM anon, authenticated;

-- ═══════════════════════════════════════════════════════════════
-- Verification
-- ═══════════════════════════════════════════════════════════════
-- 1. Force the metno path directly (bypasses Open-Meteo entirely):
--      SELECT public._refresh_weather_grid_metno();
--    Expect: BIGINT id; weather_grid_cache gains a row with payload
--    length 162 and source = 'met-norway-coarse:18x9'.
--
-- 2. Full chain (Open-Meteo first, metno on miss):
--      SELECT public.refresh_weather_grid();
--    Should land an Open-Meteo row when the IP isn't capped, and a
--    'met-norway-coarse:18x9' row when it is.
--
-- 3. Heartbeat reflects the winning source:
--      SELECT pipeline_name, last_source, consecutive_fail,
--             EXTRACT(EPOCH FROM (now() - last_success_at))::int AS age_s
--        FROM public.pipeline_heartbeat
--       WHERE pipeline_name = 'weather_grid';
-- ═══════════════════════════════════════════════════════════════
