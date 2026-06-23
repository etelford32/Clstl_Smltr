-- ═══════════════════════════════════════════════════════════════
-- Parker Physics — Aurora Outlook Cache (run in Supabase SQL Editor)
-- ═══════════════════════════════════════════════════════════════
-- Shared cache of the historically-driven 30-day Kp outlook
-- (AURORACLE_ML_PLAN.md §6, Phase 1). The outlook is GLOBAL — Kp is
-- the same for every user; only AurOracle's per-sky scoring is local —
-- so api/cron/aurora-outlook.js computes it once every 6 h and writes
-- one JSONB document here. /api/aurora/outlook returns the newest row
-- to browsers via the CDN; until this table exists, that endpoint
-- live-computes from NOAA so the feature still works.
--
--   aurora_outlook_cache
--     id            BIGSERIAL primary key
--     generated_at  when the cron computed this outlook
--     source        provider label ('noaa-45d+recurrence')
--     payload       JSONB { made_at, version, days:[{ i, date,
--                   kp_p10, kp_p50, kp_p90, driver }], meta }
--
-- Mirrors weather_grid_cache (service-role-only, RLS on with zero
-- policies). Safe to re-run (IF NOT EXISTS / CREATE OR REPLACE).
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.aurora_outlook_cache (
    id            BIGSERIAL    PRIMARY KEY,
    generated_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    source        TEXT         NOT NULL DEFAULT 'noaa-45d+recurrence',
    payload       JSONB        NOT NULL
);

CREATE INDEX IF NOT EXISTS aurora_outlook_cache_generated_at_idx
    ON public.aurora_outlook_cache (generated_at DESC);

-- RLS: server-only. The cron writer + read endpoint use the service_role
-- key (bypasses RLS); browsers must go through the cached edge endpoint.
-- No policies = no rows visible to anon/authenticated (correct — this is
-- internal cache data, same posture as weather_grid_cache; CLAUDE.md §4.2).
ALTER TABLE public.aurora_outlook_cache ENABLE ROW LEVEL SECURITY;

-- Retention: keep the last 240 rows (~60 days at the 6 h cadence) so the
-- Phase 2 skill accumulator has a backtest history of issued outlooks to
-- score against what NOAA later observed. Called opportunistically from
-- the cron after each insert.
CREATE OR REPLACE FUNCTION public.trim_aurora_outlook_cache()
RETURNS void AS $$
    DELETE FROM public.aurora_outlook_cache
    WHERE id NOT IN (
        SELECT id FROM public.aurora_outlook_cache
        ORDER BY generated_at DESC
        LIMIT 240
    );
$$ LANGUAGE sql
SET search_path = public, pg_temp;
