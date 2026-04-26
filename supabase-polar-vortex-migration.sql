-- ═══════════════════════════════════════════════════════════════
-- Parker Physics — Polar Vortex Snapshots (run in Supabase SQL Editor)
-- ═══════════════════════════════════════════════════════════════
-- Backing store for /api/weather/polar-vortex. Replaces the live
-- Open-Meteo GFS pressure-level fetch (which 503'd intermittently
-- whenever Open-Meteo's edge had issues) with a Vercel cron-fed
-- snapshot pulled directly from NOAA NOMADS' GrADS-DODS server
-- (OPeNDAP ASCII).
--
-- Why a snapshot table, not a per-tick ring buffer
-- ------------------------------------------------
-- The polar vortex is forecast every 6 h (matching GFS run cycles
-- 00/06/12/18 UTC) and the response covers 14 days. We don't need
-- 1-min granularity — one row per cycle is enough, and dedup'd by
-- the GFS run timestamp itself so a re-run of the cron just upserts.
--
-- Reader behaviour
-- ----------------
-- /api/weather/polar-vortex reads the newest row's `payload` JSONB,
-- which is pre-shaped to match the response envelope the dashboard
-- already consumes (current{}, forecast_d7{}, daily{}, etc). If the
-- table is empty or the snapshot is older than the freshness threshold,
-- the Edge endpoint falls back to live Open-Meteo so a cold deploy
-- still serves data.
--
-- Prerequisites:
--   1. supabase-pipeline-heartbeat-migration.sql
--   2. THIS FILE
--
-- Safe to re-run.
-- ═══════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════
-- polar_vortex_snapshots
-- ═══════════════════════════════════════════════════════════════
-- One row per published GFS run cycle (00/06/12/18 UTC). The cron
-- writer upserts on (cycle, source) so a retry doesn't accumulate
-- duplicates.
CREATE TABLE IF NOT EXISTS public.polar_vortex_snapshots (
    id          BIGSERIAL   PRIMARY KEY,
    cycle       TIMESTAMPTZ NOT NULL,           -- GFS run cycle the data is from
    fetched_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    source      TEXT        NOT NULL DEFAULT 'nomads-gfs',
    payload     JSONB       NOT NULL,           -- pre-shaped polar-vortex envelope
    UNIQUE (cycle, source)
);

CREATE INDEX IF NOT EXISTS polar_vortex_snapshots_cycle_idx
    ON public.polar_vortex_snapshots (cycle DESC);

ALTER TABLE public.polar_vortex_snapshots ENABLE ROW LEVEL SECURITY;
-- No anon/authenticated policies — Edge endpoint reads via service_role.

-- ═══════════════════════════════════════════════════════════════
-- trim_polar_vortex_snapshots()
-- ═══════════════════════════════════════════════════════════════
-- 30-day retention: 4 cycles/day × 30 days = 120 rows max. Tiny.
-- Called by the Vercel cron after each successful insert; no separate
-- pg_cron job needed.
CREATE OR REPLACE FUNCTION public.trim_polar_vortex_snapshots()
RETURNS void AS $$
    DELETE FROM public.polar_vortex_snapshots
     WHERE cycle < now() - INTERVAL '30 days';
$$ LANGUAGE sql SECURITY DEFINER;

REVOKE ALL ON FUNCTION public.trim_polar_vortex_snapshots() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.trim_polar_vortex_snapshots() FROM anon, authenticated;

-- ═══════════════════════════════════════════════════════════════
-- Verification
-- ═══════════════════════════════════════════════════════════════
-- 1. After /api/cron/refresh-polar-vortex runs once, confirm a row:
--      SELECT cycle, fetched_at, source,
--             jsonb_array_length(payload->'daily'->'time') AS forecast_days
--        FROM public.polar_vortex_snapshots
--       ORDER BY cycle DESC LIMIT 5;
--
-- 2. Heartbeat:
--      SELECT * FROM public.pipeline_heartbeat
--       WHERE pipeline_name = 'polar_vortex';
-- ═══════════════════════════════════════════════════════════════
