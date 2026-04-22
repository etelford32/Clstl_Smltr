-- ═══════════════════════════════════════════════════════════════
-- Parker Physics — Solar Wind Samples (run in Supabase SQL Editor)
-- ═══════════════════════════════════════════════════════════════
-- Ring-buffer storage for NOAA DSCOVR/ACE real-time solar wind so
-- every visitor reads the same cached row instead of hammering
-- NOAA's WAF from their own browser. First instance of the shared
-- "time-series feed" template:
--
--     <feed>_samples     — ring buffer (this file)
--     trim_<feed>_samples()
--     refresh_<feed>()   — pg_cron writer  (separate file per feed)
--     record_pipeline_*  — shared heartbeat (pipeline-heartbeat migration)
--     /api/<feed>/latest — Vercel edge reader
--
-- Prerequisites (run in this order, one-time):
--   1. supabase-pipeline-heartbeat-migration.sql
--   2. THIS FILE
--   3. (pg_cron refresh job is scheduled at the bottom of this file)
--
-- Safe to re-run (CREATE … IF NOT EXISTS / CREATE OR REPLACE).
-- ═══════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pg_cron;   -- scheduled jobs
CREATE EXTENSION IF NOT EXISTS http;      -- synchronous HTTP from plpgsql

-- ═══════════════════════════════════════════════════════════════
-- solar_wind_samples
-- ═══════════════════════════════════════════════════════════════
-- One row = one 1-minute reading from NOAA rtsw_wind_1m.json.
-- `observed_at` is the timestamp NOAA reports for the sample (the
-- actual measurement time), not our insert time — so multiple inserts
-- of the same NOAA minute are harmlessly deduped by UNIQUE.
CREATE TABLE IF NOT EXISTS public.solar_wind_samples (
    id            BIGSERIAL PRIMARY KEY,
    observed_at   TIMESTAMPTZ NOT NULL,
    ingested_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    source        TEXT        NOT NULL DEFAULT 'noaa-swpc',
    speed_km_s    DOUBLE PRECISION,
    density_cc    DOUBLE PRECISION,
    temperature_k DOUBLE PRECISION,
    bt_nt         DOUBLE PRECISION,
    bz_nt         DOUBLE PRECISION,
    bx_nt         DOUBLE PRECISION,
    by_nt         DOUBLE PRECISION,
    UNIQUE (observed_at, source)
);

CREATE INDEX IF NOT EXISTS solar_wind_samples_observed_at_idx
    ON public.solar_wind_samples (observed_at DESC);

ALTER TABLE public.solar_wind_samples ENABLE ROW LEVEL SECURITY;
-- No policies = no direct anon/authenticated access. Browsers read via
-- /api/solar-wind/latest (service_role bypasses RLS) and write via the
-- record_solar_wind_sample RPC (SECURITY DEFINER, validates input).

-- ═══════════════════════════════════════════════════════════════
-- trim_solar_wind_samples()
-- ═══════════════════════════════════════════════════════════════
-- 7-day retention: at 1 sample/min that's ~10 080 rows. Called from
-- refresh_solar_wind() after each insert so we don't need a separate
-- cron job for cleanup.
CREATE OR REPLACE FUNCTION public.trim_solar_wind_samples()
RETURNS void AS $$
    DELETE FROM public.solar_wind_samples
     WHERE observed_at < now() - INTERVAL '7 days';
$$ LANGUAGE sql;

-- ═══════════════════════════════════════════════════════════════
-- record_solar_wind_sample(…)
-- ═══════════════════════════════════════════════════════════════
-- Browser write-through endpoint. js/wind-pipeline-feed.js calls this
-- via /api/solar-wind/ingest when pg_cron data ages out — any visitor
-- with the site open keeps the ring buffer warm for everyone. The
-- Vercel edge endpoint runs it with service_role, so no anon grant.
--
-- Validation is strict on purpose: a browser-callable write endpoint
-- without bounds is a free graffiti-board.
--   - observed_at must be within ±10 min of server time
--   - speed_km_s must be a plausible solar wind value (100-3000 km/s)
--   - density_cc, temperature_k, b*_nt accepted if finite & in range
--
-- Returns the inserted id, or NULL on ON CONFLICT DO NOTHING (same
-- minute already ingested by pg_cron — expected, not an error).
CREATE OR REPLACE FUNCTION public.record_solar_wind_sample(
    p_observed_at   TIMESTAMPTZ,
    p_source        TEXT,
    p_speed_km_s    DOUBLE PRECISION,
    p_density_cc    DOUBLE PRECISION  DEFAULT NULL,
    p_temperature_k DOUBLE PRECISION  DEFAULT NULL,
    p_bt_nt         DOUBLE PRECISION  DEFAULT NULL,
    p_bz_nt         DOUBLE PRECISION  DEFAULT NULL,
    p_bx_nt         DOUBLE PRECISION  DEFAULT NULL,
    p_by_nt         DOUBLE PRECISION  DEFAULT NULL
) RETURNS BIGINT AS $$
DECLARE
    inserted_id BIGINT;
    clean_src   TEXT;
BEGIN
    -- Bound the source label so a caller can't stuff arbitrary text.
    clean_src := COALESCE(NULLIF(substring(p_source FROM 1 FOR 32), ''), 'unknown');

    IF p_observed_at IS NULL
       OR p_observed_at > now() + INTERVAL '10 minutes'
       OR p_observed_at < now() - INTERVAL '10 minutes' THEN
        RAISE EXCEPTION 'observed_at out of plausible range: %', p_observed_at;
    END IF;

    IF p_speed_km_s IS NULL
       OR p_speed_km_s < 100
       OR p_speed_km_s > 3000 THEN
        RAISE EXCEPTION 'speed_km_s out of plausible range: %', p_speed_km_s;
    END IF;

    INSERT INTO public.solar_wind_samples
        (observed_at, source, speed_km_s, density_cc, temperature_k, bt_nt, bz_nt, bx_nt, by_nt)
    VALUES
        (p_observed_at, clean_src, p_speed_km_s, p_density_cc, p_temperature_k,
         p_bt_nt, p_bz_nt, p_bx_nt, p_by_nt)
    ON CONFLICT (observed_at, source) DO NOTHING
    RETURNING id INTO inserted_id;

    RETURN inserted_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION public.record_solar_wind_sample(
    TIMESTAMPTZ, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION,
    DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_solar_wind_sample(
    TIMESTAMPTZ, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION,
    DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION
) FROM anon, authenticated;

-- ═══════════════════════════════════════════════════════════════
-- refresh_solar_wind()
-- ═══════════════════════════════════════════════════════════════
-- Primary writer. Polls NOAA rtsw_wind_1m.json via the `http`
-- extension, parses the newest row, inserts it into
-- solar_wind_samples, and pokes the heartbeat.
--
-- Fails loudly (RAISE EXCEPTION) on any upstream hiccup so pg_cron
-- records the failure in cron.job_run_details AND the heartbeat
-- table via record_pipeline_failure(). The refresh function is the
-- only place that knows how to translate NOAA's fill sentinels, so
-- validation lives here rather than in the RPC.
CREATE OR REPLACE FUNCTION public.refresh_solar_wind()
RETURNS BIGINT AS $$
DECLARE
    NOAA_URL   constant text := 'https://services.swpc.noaa.gov/json/rtsw/rtsw_wind_1m.json';
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
    i              int;
BEGIN
    BEGIN
        SELECT content INTO response_body
          FROM http_get(NOAA_URL);
    EXCEPTION WHEN OTHERS THEN
        PERFORM public.record_pipeline_failure('solar_wind', SQLERRM);
        RAISE;
    END;

    IF response_body IS NULL OR length(response_body) < 50 THEN
        PERFORM public.record_pipeline_failure(
            'solar_wind',
            format('empty NOAA response (len=%s)', COALESCE(length(response_body), 0))
        );
        RAISE EXCEPTION 'NOAA rtsw_wind_1m empty response';
    END IF;

    BEGIN
        payload_json := response_body::jsonb;
    EXCEPTION WHEN OTHERS THEN
        PERFORM public.record_pipeline_failure('solar_wind', 'JSON parse failed: ' || SQLERRM);
        RAISE;
    END;

    IF jsonb_typeof(payload_json) <> 'array' OR jsonb_array_length(payload_json) = 0 THEN
        PERFORM public.record_pipeline_failure('solar_wind', 'NOAA payload not a non-empty array');
        RAISE EXCEPTION 'NOAA rtsw_wind_1m: payload not a non-empty array';
    END IF;

    -- Walk backwards from the newest row until we find one with a valid,
    -- positive speed (NOAA sometimes trails a few fill rows at the end).
    FOR i IN REVERSE jsonb_array_length(payload_json) - 1 .. 0 LOOP
        latest_row := payload_json -> i;
        speed_v    := NULLIF((latest_row ->> 'proton_speed'), '')::double precision;
        IF speed_v IS NULL THEN
            speed_v := NULLIF((latest_row ->> 'speed'), '')::double precision;
        END IF;
        -- Filter NOAA fill sentinels
        IF speed_v IS NOT NULL AND speed_v > -9990 AND speed_v < 1e20 AND speed_v > 0 THEN
            EXIT;
        END IF;
        latest_row := NULL;
    END LOOP;

    IF latest_row IS NULL THEN
        PERFORM public.record_pipeline_failure('solar_wind', 'no valid speed in NOAA payload');
        RAISE EXCEPTION 'NOAA rtsw_wind_1m: all rows have fill/invalid speed';
    END IF;

    -- NOAA time_tag is "YYYY-MM-DD HH:MM:SS.ms" (space separator, no tz).
    observed := (replace(latest_row ->> 'time_tag', ' ', 'T') || 'Z')::timestamptz;

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

    -- Apply NOAA fill sentinel filter to optional fields (invalid → NULL).
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

    RETURN inserted_id;  -- NULL on dedup (same minute already present) is fine
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION public.refresh_solar_wind() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.refresh_solar_wind() FROM anon, authenticated;

-- ═══════════════════════════════════════════════════════════════
-- Schedule: every minute  (NOAA's rtsw_wind_1m cadence)
-- ═══════════════════════════════════════════════════════════════
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'refresh-solar-wind') THEN
        PERFORM cron.unschedule('refresh-solar-wind');
    END IF;
END $$;

SELECT cron.schedule(
    'refresh-solar-wind',
    '* * * * *',
    $cron$ SELECT public.refresh_solar_wind(); $cron$
);

-- ═══════════════════════════════════════════════════════════════
-- Verification
-- ═══════════════════════════════════════════════════════════════
-- 1. Trigger one run manually:
--      SELECT public.refresh_solar_wind();
--
-- 2. Confirm schedule registered:
--      SELECT jobid, schedule, active
--        FROM cron.job WHERE jobname = 'refresh-solar-wind';
--
-- 3. Recent rows landing in the table:
--      SELECT observed_at, speed_km_s, density_cc, bz_nt
--        FROM public.solar_wind_samples
--       ORDER BY observed_at DESC LIMIT 10;
--
-- 4. Heartbeat status:
--      SELECT * FROM public.pipeline_heartbeat
--       WHERE pipeline_name = 'solar_wind';
-- ═══════════════════════════════════════════════════════════════
