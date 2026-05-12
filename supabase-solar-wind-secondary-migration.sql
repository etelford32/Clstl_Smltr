-- ═══════════════════════════════════════════════════════════════
-- Parker Physics — Solar Wind Secondary NOAA Source
-- Run in Supabase SQL Editor AFTER:
--   • supabase-solar-wind-migration.sql
--   • supabase-solar-wind-freshness-fix.sql
-- ═══════════════════════════════════════════════════════════════
-- The problem this fixes
-- ----------------------
-- refresh_solar_wind() currently polls a single NOAA endpoint
-- (rtsw_wind_1m.json — the DSCOVR real-time stream). The freshness
-- fix correctly RAISEs when that endpoint serves no row younger than
-- 30 min, which keeps stale data out of the cache, but it leaves the
-- pipeline with no way to recover until DSCOVR/RTSW comes back.
--
-- During the recent 1-day stall, NOAA's RTSW feed was lagging while
-- their plasma-2-hour product (a separate ingest pipeline carrying
-- ACE-derived plasma data) continued to update. We were effectively
-- offline despite a fresh source being available.
--
-- The fix
-- -------
-- Add a fallback to NOAA's products/solar-wind/plasma-2-hour.json
-- when the RTSW path returns no fresh row. Two ingest pipelines on
-- NOAA's side; an outage of one rarely takes both.
--
-- Trade-offs:
--   • The 2-hour product carries plasma fields only (speed, density,
--     temperature) — no IMF (Bx/By/Bz/Bt). Mag fields land NULL on
--     fallback rows. /api/solar-wind/latest already nullsafes these
--     (alertLevel uses `bz ?? 0`), so the dashboard degrades to
--     speed-only alerting for the duration of the RTSW outage.
--   • To preserve the IMF when only mag is available we'd also need
--     mag-2-hour.json — left for a follow-up migration. Speed/density
--     alone restores the page's primary "is the wind blowing?"
--     signal, which is the bigger user-visible regression.
--
-- The schema of the 2-hour product is array-of-arrays with the first
-- row as column headers:
--   [["time_tag","density","speed","temperature"],
--    ["2026-04-22 17:58:00","6.1","412.5","89000"], … ]
-- We index into the first row to find column positions defensively
-- so a NOAA column reorder doesn't silently corrupt our parser.
--
-- Source label on inserts: 'noaa-swpc-plasma2h' — distinct from the
-- primary 'noaa-swpc' so analytics / heartbeat surface which path won.
--
-- Safe to re-run (CREATE OR REPLACE).
-- ═══════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS http;

-- ═══════════════════════════════════════════════════════════════
-- _refresh_solar_wind_plasma2h()  — internal fallback writer
-- ═══════════════════════════════════════════════════════════════
-- Polls plasma-2-hour.json, parses the newest row that has a valid
-- positive speed and is within MAX_AGE of now, and inserts it into
-- solar_wind_samples with source='noaa-swpc-plasma2h'. Returns the
-- inserted id (or NULL on dedup); RAISEs on failure so the public
-- wrapper can decide whether to surface the error.
CREATE OR REPLACE FUNCTION public._refresh_solar_wind_plasma2h()
RETURNS BIGINT AS $$
DECLARE
    NOAA_URL       constant text     := 'https://services.swpc.noaa.gov/products/solar-wind/plasma-2-hour.json';
    MAX_AGE        constant interval := INTERVAL '30 minutes';
    response_body  text;
    payload_json   jsonb;
    header_row     jsonb;
    row_json       jsonb;
    col_density    int;
    col_speed      int;
    col_temp       int;
    col_time       int;
    n_rows         int;
    i              int;
    observed       timestamptz;
    speed_v        double precision;
    density_v      double precision;
    temperature_v  double precision;
    candidate_age  interval;
    inserted_id    bigint;
BEGIN
    BEGIN
        SELECT content INTO response_body
          FROM http_get(NOAA_URL);
    EXCEPTION WHEN OTHERS THEN
        PERFORM public.record_pipeline_failure('solar_wind', 'plasma2h fetch: ' || SQLERRM);
        RAISE;
    END;

    IF response_body IS NULL OR length(response_body) < 50 THEN
        PERFORM public.record_pipeline_failure(
            'solar_wind',
            format('plasma2h empty response (len=%s)', COALESCE(length(response_body), 0))
        );
        RAISE EXCEPTION 'plasma-2-hour empty response';
    END IF;

    BEGIN
        payload_json := response_body::jsonb;
    EXCEPTION WHEN OTHERS THEN
        PERFORM public.record_pipeline_failure('solar_wind', 'plasma2h parse: ' || SQLERRM);
        RAISE;
    END;

    IF jsonb_typeof(payload_json) <> 'array' OR jsonb_array_length(payload_json) < 2 THEN
        PERFORM public.record_pipeline_failure('solar_wind',
            'plasma2h payload not a 2+ element array');
        RAISE EXCEPTION 'plasma-2-hour payload too short';
    END IF;

    -- Header row → column indices. NOAA has been stable on this schema
    -- for years but defending against a reorder is cheap and avoids
    -- the silent-wrong-column failure mode.
    header_row := payload_json -> 0;
    col_time    := NULL;
    col_density := NULL;
    col_speed   := NULL;
    col_temp    := NULL;
    FOR i IN 0 .. jsonb_array_length(header_row) - 1 LOOP
        CASE header_row ->> i
            WHEN 'time_tag'    THEN col_time    := i;
            WHEN 'density'     THEN col_density := i;
            WHEN 'speed'       THEN col_speed   := i;
            WHEN 'temperature' THEN col_temp    := i;
            ELSE NULL;
        END CASE;
    END LOOP;

    IF col_time IS NULL OR col_speed IS NULL THEN
        PERFORM public.record_pipeline_failure('solar_wind',
            format('plasma2h missing required columns (time=%s speed=%s)', col_time, col_speed));
        RAISE EXCEPTION 'plasma-2-hour header missing time_tag/speed columns';
    END IF;

    n_rows := jsonb_array_length(payload_json);

    -- Walk newest → oldest skipping rows 0 (header). Same fill-sentinel
    -- + freshness logic as the RTSW path.
    FOR i IN REVERSE n_rows - 1 .. 1 LOOP
        row_json := payload_json -> i;
        speed_v  := NULLIF(row_json ->> col_speed, '')::double precision;

        IF speed_v IS NULL OR speed_v <= -9990 OR speed_v >= 1e20 OR speed_v <= 0 THEN
            CONTINUE;
        END IF;

        BEGIN
            -- 2-hour product time format: 'YYYY-MM-DD HH:MM:SS.mmm' UTC
            observed := (replace(row_json ->> col_time, ' ', 'T') || 'Z')::timestamptz;
        EXCEPTION WHEN OTHERS THEN
            CONTINUE;
        END;

        candidate_age := now() - observed;
        IF candidate_age > MAX_AGE THEN
            -- Already past freshness ceiling — older rows can only be
            -- worse. Bail.
            RAISE EXCEPTION 'plasma-2-hour: newest valid row is % old (>%)',
                            candidate_age, MAX_AGE;
        END IF;

        density_v := CASE
            WHEN col_density IS NOT NULL
            THEN NULLIF(row_json ->> col_density, '')::double precision
            ELSE NULL
        END;
        temperature_v := CASE
            WHEN col_temp IS NOT NULL
            THEN NULLIF(row_json ->> col_temp, '')::double precision
            ELSE NULL
        END;

        IF density_v     IS NOT NULL AND (density_v     <= -9990 OR density_v     > 1e20) THEN density_v     := NULL; END IF;
        IF temperature_v IS NOT NULL AND (temperature_v <= -9990 OR temperature_v > 1e20) THEN temperature_v := NULL; END IF;

        INSERT INTO public.solar_wind_samples
            (observed_at, source, speed_km_s, density_cc, temperature_k, bt_nt, bz_nt, bx_nt, by_nt)
        VALUES
            (observed, 'noaa-swpc-plasma2h', speed_v, density_v, temperature_v,
             NULL, NULL, NULL, NULL)
        ON CONFLICT (observed_at, source) DO NOTHING
        RETURNING id INTO inserted_id;

        PERFORM public.trim_solar_wind_samples();
        PERFORM public.record_pipeline_success('solar_wind', 'noaa-swpc-plasma2h');

        RETURN inserted_id;
    END LOOP;

    PERFORM public.record_pipeline_failure('solar_wind',
        'plasma-2-hour: no valid speed within ' || MAX_AGE::text || ' of now');
    RAISE EXCEPTION 'plasma-2-hour: no fresh valid row';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION public._refresh_solar_wind_plasma2h() FROM PUBLIC;
REVOKE ALL ON FUNCTION public._refresh_solar_wind_plasma2h() FROM anon, authenticated;

-- ═══════════════════════════════════════════════════════════════
-- refresh_solar_wind()  — overwrite to chain the secondary
-- ═══════════════════════════════════════════════════════════════
-- Same body as supabase-solar-wind-freshness-fix.sql, but on any
-- failure — including "no fresh valid row" — we now fall through to
-- _refresh_solar_wind_plasma2h() before propagating an exception.
--
-- The fall-through is wrapped in its own BEGIN/EXCEPTION so the RTSW
-- failure heartbeat we recorded earlier is not lost (the secondary's
-- own success call replaces it on success; its failure call would
-- double-count fail streaks, so we suppress that path's failure
-- heartbeat write and only let the success write happen).
CREATE OR REPLACE FUNCTION public.refresh_solar_wind()
RETURNS BIGINT AS $$
DECLARE
    NOAA_URL       constant text          := 'https://services.swpc.noaa.gov/json/rtsw/rtsw_wind_1m.json';
    MAX_AGE        constant interval      := INTERVAL '30 minutes';
    response_body  text;
    payload_json   jsonb;
    latest_row     jsonb;
    observed       timestamptz;
    speed_v        double precision;
    density_v      double precision;
    temperature_v  double precision;
    bt_v           double precision;
    bz_v           double precision;
    bx_v           double precision;
    by_v           double precision;
    inserted_id    bigint;
    candidate_age  interval;
    rtsw_ok        boolean := false;
    i              int;
BEGIN
    -- Block A: try the primary RTSW path, exactly as the freshness-fix
    -- migration left it. On any failure we set rtsw_ok=false and fall
    -- through to the secondary instead of RAISEing immediately.
    BEGIN
        SELECT content INTO response_body
          FROM http_get(NOAA_URL);

        IF response_body IS NULL OR length(response_body) < 50 THEN
            PERFORM public.record_pipeline_failure(
                'solar_wind',
                format('empty NOAA response (len=%s)', COALESCE(length(response_body), 0))
            );
        ELSE
            payload_json := response_body::jsonb;
            IF jsonb_typeof(payload_json) <> 'array' OR jsonb_array_length(payload_json) = 0 THEN
                PERFORM public.record_pipeline_failure('solar_wind', 'NOAA payload not a non-empty array');
            ELSE
                FOR i IN REVERSE jsonb_array_length(payload_json) - 1 .. 0 LOOP
                    latest_row := payload_json -> i;
                    speed_v    := NULLIF((latest_row ->> 'proton_speed'), '')::double precision;
                    IF speed_v IS NULL THEN
                        speed_v := NULLIF((latest_row ->> 'speed'), '')::double precision;
                    END IF;

                    IF speed_v IS NULL OR speed_v <= -9990 OR speed_v >= 1e20 OR speed_v <= 0 THEN
                        latest_row := NULL;
                        CONTINUE;
                    END IF;

                    BEGIN
                        observed := (replace(latest_row ->> 'time_tag', ' ', 'T') || 'Z')::timestamptz;
                    EXCEPTION WHEN OTHERS THEN
                        latest_row := NULL;
                        CONTINUE;
                    END;

                    candidate_age := now() - observed;
                    IF candidate_age > MAX_AGE THEN
                        latest_row := NULL;
                        EXIT;   -- newer rows aren't possible past this point
                    END IF;

                    EXIT;
                END LOOP;

                IF latest_row IS NOT NULL THEN
                    density_v     := NULLIF(latest_row ->> 'proton_density',     '')::double precision;
                    IF density_v IS NULL THEN density_v := NULLIF(latest_row ->> 'density', '')::double precision; END IF;
                    temperature_v := NULLIF(latest_row ->> 'proton_temperature', '')::double precision;
                    IF temperature_v IS NULL THEN temperature_v := NULLIF(latest_row ->> 'temperature', '')::double precision; END IF;
                    bt_v          := NULLIF(latest_row ->> 'bt',     '')::double precision;
                    bz_v          := NULLIF(latest_row ->> 'bz_gsm', '')::double precision;
                    IF bz_v IS NULL THEN bz_v := NULLIF(latest_row ->> 'bz', '')::double precision; END IF;
                    bx_v          := NULLIF(latest_row ->> 'bx_gsm', '')::double precision;
                    IF bx_v IS NULL THEN bx_v := NULLIF(latest_row ->> 'bx', '')::double precision; END IF;
                    by_v          := NULLIF(latest_row ->> 'by_gsm', '')::double precision;
                    IF by_v IS NULL THEN by_v := NULLIF(latest_row ->> 'by', '')::double precision; END IF;

                    IF density_v     IS NOT NULL AND (density_v     <= -9990 OR density_v     > 1e20) THEN density_v     := NULL; END IF;
                    IF temperature_v IS NOT NULL AND (temperature_v <= -9990 OR temperature_v > 1e20) THEN temperature_v := NULL; END IF;
                    IF bt_v          IS NOT NULL AND (bt_v          <= -9990 OR bt_v          > 1e20) THEN bt_v          := NULL; END IF;
                    IF bz_v          IS NOT NULL AND (bz_v          <= -9990 OR bz_v          > 1e20) THEN bz_v          := NULL; END IF;
                    IF bx_v          IS NOT NULL AND (bx_v          <= -9990 OR bx_v          > 1e20) THEN bx_v          := NULL; END IF;
                    IF by_v          IS NOT NULL AND (by_v          <= -9990 OR by_v          > 1e20) THEN by_v          := NULL; END IF;

                    INSERT INTO public.solar_wind_samples
                        (observed_at, source, speed_km_s, density_cc, temperature_k, bt_nt, bz_nt, bx_nt, by_nt)
                    VALUES
                        (observed, 'noaa-swpc', speed_v, density_v, temperature_v, bt_v, bz_v, bx_v, by_v)
                    ON CONFLICT (observed_at, source) DO NOTHING
                    RETURNING id INTO inserted_id;

                    PERFORM public.trim_solar_wind_samples();
                    PERFORM public.record_pipeline_success('solar_wind', 'noaa-swpc');
                    rtsw_ok := true;
                ELSE
                    PERFORM public.record_pipeline_failure(
                        'solar_wind',
                        format('no valid speed within %s of now in NOAA payload', MAX_AGE)
                    );
                END IF;
            END IF;
        END IF;
    EXCEPTION WHEN OTHERS THEN
        PERFORM public.record_pipeline_failure('solar_wind', 'rtsw block: ' || SQLERRM);
        rtsw_ok := false;
    END;

    IF rtsw_ok THEN
        RETURN inserted_id;
    END IF;

    -- Block B: RTSW path could not find a fresh row. Try the
    -- plasma-2-hour secondary. On its success the heartbeat flips
    -- back to green (last_source = 'noaa-swpc-plasma2h'); on its
    -- failure we let the secondary's own RAISE propagate, but suppress
    -- a duplicate failure-write since the RTSW path already wrote one.
    BEGIN
        RETURN public._refresh_solar_wind_plasma2h();
    EXCEPTION WHEN OTHERS THEN
        -- Both upstreams failed. The RTSW block already recorded a
        -- failure heartbeat; the secondary recorded its own. Re-raise
        -- so pg_cron logs the run as failed in cron.job_run_details.
        RAISE EXCEPTION 'solar_wind: both RTSW and plasma-2-hour failed (last secondary error: %)', SQLERRM;
    END;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION public.refresh_solar_wind() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.refresh_solar_wind() FROM anon, authenticated;

-- ═══════════════════════════════════════════════════════════════
-- Verification
-- ═══════════════════════════════════════════════════════════════
-- 1. Force the secondary path directly (bypasses RTSW entirely):
--      SELECT public._refresh_solar_wind_plasma2h();
--    Expect: BIGINT id (or NULL on dedup) when plasma-2-hour is fresh,
--    EXCEPTION 'no fresh valid row' when it is not.
--
-- 2. Full chain (RTSW first, plasma-2-hour on miss):
--      SELECT public.refresh_solar_wind();
--
-- 3. Heartbeat reflects which source won:
--      SELECT pipeline_name, last_source, consecutive_fail,
--             EXTRACT(EPOCH FROM (now() - last_success_at))::int AS age_s
--        FROM public.pipeline_heartbeat
--       WHERE pipeline_name = 'solar_wind';
--
-- 4. Confirm inserts carry the new source label during fallback:
--      SELECT observed_at, source, speed_km_s, bz_nt
--        FROM public.solar_wind_samples
--       WHERE source = 'noaa-swpc-plasma2h'
--       ORDER BY observed_at DESC LIMIT 5;
--    Expect bz_nt IS NULL on these rows (intentional — plasma2h
--    has no IMF channel; mag-2-hour follow-up needed for that).
-- ═══════════════════════════════════════════════════════════════
