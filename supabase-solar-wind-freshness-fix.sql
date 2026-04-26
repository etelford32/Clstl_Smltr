-- ═══════════════════════════════════════════════════════════════
-- Parker Physics — Solar Wind Freshness Gate (run after the
-- supabase-solar-wind-migration.sql baseline)
-- ═══════════════════════════════════════════════════════════════
-- Bug we're fixing
-- ----------------
-- Previous refresh_solar_wind() walked NOAA's payload from newest
-- to oldest looking for ANY row with a valid speed, and inserted
-- whatever it found. When NOAA's RTSW telemetry has an extended
-- gap (instrument outage, ground-station issue, weekend backlog),
-- the most-recent valid row can be hours or days old. The cron
-- still found it, inserted it, recorded a heartbeat success, and
-- returned without complaint.
--
-- Net effect: pipeline_heartbeat showed `solar_wind` healthy
-- (last_success_at = 1 min ago, consecutive_fail = 0), but
-- /api/solar-wind/latest showed data 1 day stale because no fresh
-- row was ever ingested.
--
-- The fix
-- -------
-- Enforce a freshness ceiling: the row we accept must be within
-- MAX_AGE of now(). NOAA rtsw_wind_1m updates every minute; 30 min
-- is generous enough to absorb legitimate retransmits but tight
-- enough that a real upstream outage flips the heartbeat to
-- critical within one cron tick of going stale.
--
-- Safe to re-run (CREATE OR REPLACE).
-- ═══════════════════════════════════════════════════════════════

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
    -- positive speed AND a timestamp within MAX_AGE of now(). The age
    -- check is what was missing previously — the old loop accepted any
    -- numerically valid row, even days-old ones.
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

        -- Freshness check: row's observed_at must be within MAX_AGE.
        BEGIN
            observed := (replace(latest_row ->> 'time_tag', ' ', 'T') || 'Z')::timestamptz;
        EXCEPTION WHEN OTHERS THEN
            latest_row := NULL;
            CONTINUE;
        END;

        candidate_age := now() - observed;
        IF candidate_age > MAX_AGE THEN
            -- Newest valid row is already too old — entire payload is stale.
            -- No point walking further back; older rows can only be older.
            latest_row := NULL;
            EXIT;
        END IF;

        EXIT;  -- found a fresh, valid row
    END LOOP;

    IF latest_row IS NULL THEN
        PERFORM public.record_pipeline_failure(
            'solar_wind',
            format('no valid speed within %s of now in NOAA payload', MAX_AGE)
        );
        RAISE EXCEPTION 'NOAA rtsw_wind_1m: no fresh valid row (newest ≤ % old required)', MAX_AGE;
    END IF;

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

    RETURN inserted_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION public.refresh_solar_wind() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.refresh_solar_wind() FROM anon, authenticated;

-- ═══════════════════════════════════════════════════════════════
-- Verification
-- ═══════════════════════════════════════════════════════════════
-- 1. Trigger one run manually:
--      SELECT public.refresh_solar_wind();
--    Expect: BIGINT id (or NULL on dedup) when NOAA is fresh,
--    EXCEPTION 'no fresh valid row' when NOAA is stalled.
--
-- 2. Confirm a stalled upstream now flips the heartbeat:
--      SELECT pipeline_name, last_success_at, last_failure_at,
--             consecutive_fail, last_failure_reason
--        FROM public.pipeline_heartbeat
--       WHERE pipeline_name = 'solar_wind';
--
-- 3. Confirm /api/solar-wind/latest now reflects reality
--    (age_min should match observed_at of the newest sample):
--      SELECT observed_at, speed_km_s, EXTRACT(EPOCH FROM (now() - observed_at))/60 AS age_min
--        FROM public.solar_wind_samples
--       ORDER BY observed_at DESC LIMIT 5;
-- ═══════════════════════════════════════════════════════════════
