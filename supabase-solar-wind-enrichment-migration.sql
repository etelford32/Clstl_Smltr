-- supabase-solar-wind-enrichment-migration.sql
--
-- Pipeline enrichment: more useful data from fetches the cron already makes,
-- at ~zero added cost (see RING_CURRENT_SIMULATION_PLAN.md §7 Phase 2).
--
--   1. record_solar_wind_backfill(jsonb) — batch upsert of the FULL-DAY
--      RTSW series the cron already downloads every minute but previously
--      kept one row of. Fills gaps after outages/missed ticks, and fills
--      NULL fields on existing sparse rows without clobbering non-null
--      values. Also the write path for MAG-ONLY samples (speed IS NULL):
--      during the 2026-07-09/10 DSCOVR plasma outage the magnetometer
--      stayed live the whole time, but record_solar_wind_sample requires a
--      valid speed, so Bz — the ring-current driver — got a needless 24 h
--      hole. speed_km_s was already nullable in the table; only the write
--      path forbade it. record_solar_wind_sample is intentionally left
--      untouched (pipeline contract).
--   2. geomag_indices — hourly Kyoto Dst + 15-min Kp, piggybacked on the
--      existing cron (no new cron entries). Extends the observed-Dst record
--      beyond NOAA's rolling 1-day product window.
--   3. ring_current_log — O'Brien–McPherron model nowcast ledger written
--      server-side every 15 min. Joined against geomag_indices this gives a
--      continuously-measured model skill record (RMSE/bias by storm phase).
--   4. trim_solar_wind_enrichment() — 90-day retention for both new tables.
--
-- ADVISOR NOTE (intentional, matches forecast_log / solar_wind_samples /
-- weather_grid_cache): geomag_indices and ring_current_log have RLS ENABLED
-- with ZERO policies. They are service-role-only — written by the Vercel
-- cron, read by future RPCs. Do NOT add permissive policies.

-- ── 1. Batch backfill / mag-only upsert ─────────────────────────────────────
-- p_rows: JSON array of {"t": iso-timestamp, "v": speed_km_s|null,
--         "n": density_cc|null, "temp": temperature_k|null,
--         "bt":|"bz":|"bx":|"by": nT|null}
-- Rules: ≤ 1500 rows per call; t within (now()-26h, now()+10min); v NULL or
-- 100–3000 km/s (same plausibility band as record_solar_wind_sample); rows
-- carrying no data at all are skipped. Existing non-null values always win —
-- EXCLUDED values only fill NULLs, so a later mag pass can complete a
-- plasma-only row (and vice versa) without rewriting history.
CREATE OR REPLACE FUNCTION public.record_solar_wind_backfill(
    p_rows   jsonb,
    p_source text DEFAULT 'noaa-swpc'
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    clean_src TEXT;
    touched   integer;
BEGIN
    clean_src := COALESCE(NULLIF(substring(p_source FROM 1 FOR 32), ''), 'unknown');

    IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
        RAISE EXCEPTION 'p_rows must be a JSON array';
    END IF;
    IF jsonb_array_length(p_rows) > 1500 THEN
        RAISE EXCEPTION 'backfill batch too large: % rows (max 1500)', jsonb_array_length(p_rows);
    END IF;

    WITH parsed AS (
        SELECT
            (r ->> 't')::timestamptz                 AS observed_at,
            NULLIF(r ->> 'v',    'null')::double precision AS speed_km_s,
            NULLIF(r ->> 'n',    'null')::double precision AS density_cc,
            NULLIF(r ->> 'temp', 'null')::double precision AS temperature_k,
            NULLIF(r ->> 'bt',   'null')::double precision AS bt_nt,
            NULLIF(r ->> 'bz',   'null')::double precision AS bz_nt,
            NULLIF(r ->> 'bx',   'null')::double precision AS bx_nt,
            NULLIF(r ->> 'by',   'null')::double precision AS by_nt
        FROM jsonb_array_elements(p_rows) AS r
    ),
    valid AS (
        SELECT * FROM parsed
        WHERE observed_at IS NOT NULL
          AND observed_at >  now() - INTERVAL '26 hours'
          AND observed_at <= now() + INTERVAL '10 minutes'
          AND (speed_km_s IS NULL OR (speed_km_s >= 100 AND speed_km_s <= 3000))
          -- a row must carry SOMETHING: plasma or field
          AND (speed_km_s IS NOT NULL OR bz_nt IS NOT NULL OR bt_nt IS NOT NULL)
    )
    INSERT INTO public.solar_wind_samples
        (observed_at, source, speed_km_s, density_cc, temperature_k, bt_nt, bz_nt, bx_nt, by_nt)
    SELECT observed_at, clean_src, speed_km_s, density_cc, temperature_k, bt_nt, bz_nt, bx_nt, by_nt
    FROM valid
    ON CONFLICT (observed_at, source) DO UPDATE SET
        speed_km_s    = COALESCE(solar_wind_samples.speed_km_s,    EXCLUDED.speed_km_s),
        density_cc    = COALESCE(solar_wind_samples.density_cc,    EXCLUDED.density_cc),
        temperature_k = COALESCE(solar_wind_samples.temperature_k, EXCLUDED.temperature_k),
        bt_nt         = COALESCE(solar_wind_samples.bt_nt,         EXCLUDED.bt_nt),
        bz_nt         = COALESCE(solar_wind_samples.bz_nt,         EXCLUDED.bz_nt),
        bx_nt         = COALESCE(solar_wind_samples.bx_nt,         EXCLUDED.bx_nt),
        by_nt         = COALESCE(solar_wind_samples.by_nt,         EXCLUDED.by_nt)
    WHERE solar_wind_samples.speed_km_s    IS DISTINCT FROM COALESCE(solar_wind_samples.speed_km_s,    EXCLUDED.speed_km_s)
       OR solar_wind_samples.density_cc    IS DISTINCT FROM COALESCE(solar_wind_samples.density_cc,    EXCLUDED.density_cc)
       OR solar_wind_samples.temperature_k IS DISTINCT FROM COALESCE(solar_wind_samples.temperature_k, EXCLUDED.temperature_k)
       OR solar_wind_samples.bt_nt         IS DISTINCT FROM COALESCE(solar_wind_samples.bt_nt,         EXCLUDED.bt_nt)
       OR solar_wind_samples.bz_nt         IS DISTINCT FROM COALESCE(solar_wind_samples.bz_nt,         EXCLUDED.bz_nt)
       OR solar_wind_samples.bx_nt         IS DISTINCT FROM COALESCE(solar_wind_samples.bx_nt,         EXCLUDED.bx_nt)
       OR solar_wind_samples.by_nt         IS DISTINCT FROM COALESCE(solar_wind_samples.by_nt,         EXCLUDED.by_nt);

    GET DIAGNOSTICS touched = ROW_COUNT;
    RETURN touched;
END;
$$;

-- Service-role only: NOT part of the anonymous-telemetry surface.
REVOKE EXECUTE ON FUNCTION public.record_solar_wind_backfill(jsonb, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.record_solar_wind_backfill(jsonb, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.record_solar_wind_backfill(jsonb, text) FROM authenticated;

-- ── 2. Observed geomagnetic indices (Kyoto Dst hourly + Kp) ─────────────────
-- 'e2_mev' joined the kind list 2026-07-13: api/cron/sync-dataset.js archives
-- native-cadence GOES ≥2 MeV electron flux here (NOAA's 1-day file rolls
-- off; this doesn't). The original two-value CHECK rejected those rows with
-- 23514 errors on every sync run until the constraint was widened in prod.
CREATE TABLE IF NOT EXISTS public.geomag_indices (
    kind        text        NOT NULL CHECK (kind IN ('dst', 'kp', 'e2_mev')),
    t           timestamptz NOT NULL,
    value       double precision NOT NULL,
    source      text        NOT NULL DEFAULT 'noaa-swpc',
    ingested_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (kind, t)
);
-- Idempotent widen for databases created before 2026-07-13 (CREATE TABLE IF
-- NOT EXISTS won't touch an existing table's constraint).
ALTER TABLE public.geomag_indices DROP CONSTRAINT IF EXISTS geomag_indices_kind_check;
ALTER TABLE public.geomag_indices ADD CONSTRAINT geomag_indices_kind_check
    CHECK (kind IN ('dst', 'kp', 'e2_mev'));
ALTER TABLE public.geomag_indices ENABLE ROW LEVEL SECURITY;
-- Zero policies on purpose: service-role-only (see header note).

-- ── 3. Ring current model nowcast ledger ────────────────────────────────────
-- One row per model run (15-min cadence). anchor_* records the observed Dst
-- the free-run was anchored on, so skill joins are reproducible.
CREATE TABLE IF NOT EXISTS public.ring_current_log (
    t           timestamptz NOT NULL PRIMARY KEY,
    dst_model   double precision,
    dst_star    double precision,
    vbs         double precision,
    pdyn        double precision,
    energy_j    double precision,
    anchor_t    timestamptz,
    anchor_dst  double precision,
    feed        text,
    ingested_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.ring_current_log ENABLE ROW LEVEL SECURITY;
-- Zero policies on purpose: service-role-only (see header note).

-- ── 4. Retention (90 days ≈ 11k + 9k rows — trivial on the 1 GB tier) ───────
CREATE OR REPLACE FUNCTION public.trim_solar_wind_enrichment()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    DELETE FROM public.geomag_indices   WHERE t < now() - INTERVAL '90 days';
    DELETE FROM public.ring_current_log WHERE t < now() - INTERVAL '90 days';
$$;
REVOKE EXECUTE ON FUNCTION public.trim_solar_wind_enrichment() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.trim_solar_wind_enrichment() FROM anon;
REVOKE EXECUTE ON FUNCTION public.trim_solar_wind_enrichment() FROM authenticated;
