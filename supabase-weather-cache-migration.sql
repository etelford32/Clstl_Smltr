-- ═══════════════════════════════════════════════════════════════
-- Parker Physics — Weather Grid Cache (run in Supabase SQL Editor)
-- ═══════════════════════════════════════════════════════════════
-- Creates a shared hourly cache of Open-Meteo grid data so every
-- visitor reads from one row instead of each browser hitting the
-- upstream API. Safe to re-run (IF NOT EXISTS).
--
--   weather_grid_cache — history of hourly grid snapshots
--     id           BIGSERIAL primary key
--     fetched_at   when the upstream fetch completed
--     source       provider label (open-meteo, etc.)
--     payload      JSONB array of per-location current-weather objects
--                  (same shape as Open-Meteo's multi-location response;
--                  originally 648 points, 2592 since the Vercel-cron
--                  writer took over)
--
-- Writer history: originally Supabase pg_cron (see
-- supabase-weather-pgcron-migration.sql); superseded by the Vercel cron
-- api/cron/refresh-weather-grid.js (hourly, sole writer, vercel.json).
-- /api/weather/grid returns the newest row to browsers via the CDN.
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.weather_grid_cache (
    id          BIGSERIAL PRIMARY KEY,
    fetched_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    source      TEXT        NOT NULL DEFAULT 'open-meteo',
    payload     JSONB       NOT NULL
);

CREATE INDEX IF NOT EXISTS weather_grid_cache_fetched_at_idx
    ON public.weather_grid_cache (fetched_at DESC);

-- RLS: table is server-only. The refresh/grid edge functions use the
-- service_role key (bypasses RLS). Block all anon/authenticated access so
-- browsers must go through the cached edge endpoint.
ALTER TABLE public.weather_grid_cache ENABLE ROW LEVEL SECURITY;

-- No policies = no rows visible to anon/authenticated roles.
-- (service_role bypasses RLS entirely, so the edge fns still work.)

-- Retention: keep the last 720 hourly rows (30 days — bumped from 72
-- by supabase-weather-cache-retention-migration.sql so Phase 4 NN
-- training has history to learn from; keep the two files in lockstep).
-- Called opportunistically from the refresh endpoint after each insert.
CREATE OR REPLACE FUNCTION public.trim_weather_grid_cache()
RETURNS void AS $$
    DELETE FROM public.weather_grid_cache
    WHERE id NOT IN (
        SELECT id FROM public.weather_grid_cache
        ORDER BY fetched_at DESC
        LIMIT 720
    );
$$ LANGUAGE sql
SET search_path = public, pg_temp;
