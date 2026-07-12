-- supabase-validation-runs-migration.sql
-- Storage + data plumbing for the DAILY validation re-run
-- (api/cron/validation-rerun.js): each run re-scores the back-mapping
-- attribution and the 27-day recurrence hindcast over the rolling
-- solar_wind_samples window and appends one row per study.
--
-- ACCESS MODEL (same as forecast_log / solar_wind_samples — documented in
-- CLAUDE.md §4.2): RLS enabled with ZERO policies, deliberately. The table
-- is written by the cron (service role) and read by the edge endpoint
-- /api/ring-current/validation (service role). Do NOT add permissive
-- policies; the advisor flag is a known false positive here.

CREATE TABLE IF NOT EXISTS public.validation_runs (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ran_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    kind          TEXT NOT NULL CHECK (kind IN ('backmap', 'recurrence')),
    window_start  TIMESTAMPTZ NOT NULL,
    window_end    TIMESTAMPTZ NOT NULL,
    -- Headline numbers, queryable without unpacking jsonb:
    n_forecasts   INTEGER,
    hits          INTEGER,
    hit_rate      DOUBLE PRECISION,
    mae_days      DOUBLE PRECISION,   -- recurrence timing MAE (null for backmap)
    skill         DOUBLE PRECISION,   -- vs chance (backmap ±20°) / vs random (recurrence)
    -- Full study output for the reports/endpoint:
    metrics       JSONB NOT NULL DEFAULT '{}'::jsonb,
    detail        JSONB
);

CREATE INDEX IF NOT EXISTS validation_runs_kind_ran_at
    ON public.validation_runs (kind, ran_at DESC);

ALTER TABLE public.validation_runs ENABLE ROW LEVEL SECURITY;
-- No policies: service-role-only by design (see header).

-- 6-hour median wind buckets over the last p_days days — the exact input
-- shape the scoring engine takes. SECURITY DEFINER so the cron can call it
-- through PostgREST RPC; NOT part of the anonymous telemetry surface, so
-- EXECUTE is revoked from anon/authenticated (CLAUDE.md §8).
CREATE OR REPLACE FUNCTION public.validation_wind_buckets(p_days INTEGER DEFAULT 16)
RETURNS TABLE (bucket TIMESTAMPTZ, v_med DOUBLE PRECISION, n BIGINT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT date_trunc('day', observed_at)
             + make_interval(hours => 6 * floor(extract(hour FROM observed_at) / 6)::int) AS bucket,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY speed_km_s) AS v_med,
           count(*) AS n
    FROM solar_wind_samples
    WHERE observed_at > now() - make_interval(days => GREATEST(1, LEAST(60, p_days)))
      AND speed_km_s BETWEEN 150 AND 1200
    GROUP BY 1
    ORDER BY 1;
$$;

REVOKE EXECUTE ON FUNCTION public.validation_wind_buckets(INTEGER) FROM anon;
REVOKE EXECUTE ON FUNCTION public.validation_wind_buckets(INTEGER) FROM authenticated;

-- ── Addendum (applied as migration validation_runs_cme_kind) ────────────────
-- Third self-scoring loop: CME arrival verification (predicted ETA —
-- WSA-ENLIL preferred, ballistic cross-check — vs the actual Pdyn shock
-- detection). kind gains 'cme'; validation_pdyn_series feeds the shock
-- detector with 15-min dynamic-pressure medians (Pdyn = 1.6726e-6·n·v²,
-- the same constant as js/ring-current-model.js PHYS.MP_FACTOR).

ALTER TABLE public.validation_runs DROP CONSTRAINT IF EXISTS validation_runs_kind_check;
ALTER TABLE public.validation_runs
    ADD CONSTRAINT validation_runs_kind_check CHECK (kind IN ('backmap', 'recurrence', 'cme'));

CREATE OR REPLACE FUNCTION public.validation_pdyn_series(p_days INTEGER DEFAULT 16)
RETURNS TABLE (bucket TIMESTAMPTZ, pdyn_med DOUBLE PRECISION, n BIGINT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT date_trunc('hour', observed_at)
             + make_interval(mins => 15 * floor(extract(minute FROM observed_at) / 15)::int) AS bucket,
           percentile_cont(0.5) WITHIN GROUP (
               ORDER BY 1.6726e-6 * density_cc * speed_km_s * speed_km_s) AS pdyn_med,
           count(*) AS n
    FROM solar_wind_samples
    WHERE observed_at > now() - make_interval(days => GREATEST(1, LEAST(60, p_days)))
      AND speed_km_s BETWEEN 150 AND 1200
      AND density_cc BETWEEN 0.05 AND 200
    GROUP BY 1
    ORDER BY 1;
$$;

REVOKE EXECUTE ON FUNCTION public.validation_pdyn_series(INTEGER) FROM anon;
REVOKE EXECUTE ON FUNCTION public.validation_pdyn_series(INTEGER) FROM authenticated;
