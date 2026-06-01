-- ═══════════════════════════════════════════════════════════════
-- Parker Physics — Far-Side Watch ingestion (run in Supabase SQL Editor)
-- ═══════════════════════════════════════════════════════════════
-- Phase 1 of the Far-Side Watch layer (see FAR_SIDE_WATCH.md). A 12-hourly,
-- image-shaped feed — the slowest bucket in the data architecture. The
-- /api/cron/farside-ingest worker pulls each new far-side map (GONG seismic
-- holography, opportunistically SolO/STEREO/HMI), parses it, runs the
-- classical detector, and upserts one row here per (source, observed_at).
--
-- Storage model:
--   - Numeric Carrington grid is stored inline as base64 Float32 (LE) in
--     grid_b64 — small enough at 12 h cadence, kept bounded by trim_farside_maps.
--   - The ORIGINAL upstream bytes (FITS/PNG) are archived to R2 for provenance
--     (raw_r2_key); R2 is optional and the worker degrades gracefully without it.
--   - detections jsonb holds the per-map detector output so the browser can
--     build the tracking watch-list from real history without re-downloading grids.
--
-- Security model (mirrors solar_wind_samples / forecast_log):
--   RLS ENABLED, ZERO POLICIES → service-role-only. The cron writes with the
--   service key; the browser reads through /api/solar/farside (which uses the
--   service key server-side). This is intentional — do NOT add a permissive
--   policy, it would expose the raw feed. The advisor "RLS enabled, no policy"
--   flag is a false positive here.
--
-- Safe to re-run.
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.farside_maps (
    id             BIGSERIAL    PRIMARY KEY,
    source         TEXT         NOT NULL,                 -- gong | solo | stereo | hmi
    observed_at    TIMESTAMPTZ  NOT NULL,                 -- map timestamp (FITS DATE-OBS or slot)
    ingested_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    carrington_l0  DOUBLE PRECISION,                      -- sub-Earth Carrington longitude
    carrington_b0  DOUBLE PRECISION,                      -- heliographic latitude of disc centre
    grid_nlon      INT,
    grid_nlat      INT,
    lat_min        INT,
    image_url      TEXT,                                  -- resolved upstream URL
    raw_r2_key     TEXT,                                  -- archived original bytes (FITS/PNG)
    grid_b64       TEXT,                                  -- base64 Float32 LE z-score grid (nullable)
    grid_sha256    TEXT,
    detections     JSONB        NOT NULL DEFAULT '[]'::jsonb,
    n_detections   INT          NOT NULL DEFAULT 0,
    n_strong       INT          NOT NULL DEFAULT 0,
    synthetic      BOOLEAN      NOT NULL DEFAULT FALSE,    -- TRUE only if no real upstream resolved
    meta           JSONB,
    UNIQUE (source, observed_at)
);

CREATE INDEX IF NOT EXISTS farside_maps_source_observed_idx
    ON public.farside_maps (source, observed_at DESC);

ALTER TABLE public.farside_maps ENABLE ROW LEVEL SECURITY;
-- No policies → service-role-only. (See header.)

-- ═══════════════════════════════════════════════════════════════
-- trim_farside_maps — retention. Keep the most recent p_keep rows PER source
-- (180 × 12 h ≈ 90 days). Called opportunistically at the end of each ingest
-- run. Service-role-only — revoked from anon/authenticated.
-- ═══════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.trim_farside_maps(p_keep INT DEFAULT 180)
RETURNS INT
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    WITH ranked AS (
        SELECT id, row_number() OVER (
            PARTITION BY source ORDER BY observed_at DESC
        ) AS rn
        FROM public.farside_maps
    ),
    del AS (
        DELETE FROM public.farside_maps
        WHERE id IN (SELECT id FROM ranked WHERE rn > p_keep)
        RETURNING 1
    )
    SELECT COALESCE(count(*), 0)::int FROM del;
$$;

REVOKE ALL ON FUNCTION public.trim_farside_maps(INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trim_farside_maps(INT) TO service_role;

COMMENT ON TABLE public.farside_maps IS
    'Far-Side Watch ingest archive (Phase 1). Service-role-only; written by '
    '/api/cron/farside-ingest, read via /api/solar/farside. RLS-no-policy is intentional.';
