-- ═══════════════════════════════════════════════════════════════
-- Parker Physics — Weather Grid Cache retention bump (72 h → 720 h)
-- ═══════════════════════════════════════════════════════════════
-- Phase 4 of WEATHER_FORECAST_PLAN.md ("Server-trained NN model")
-- needs ≥ 30 days of hourly grid history to train on. The data only
-- accumulates from the day this ships, so the bump lands well before
-- the training pipeline exists.
--
-- Size check before applying (2026-06-11): avg payload 163 kB/row
-- (TOASTed JSONB), so 720 rows ≈ 115 MB against a 47 MB database on
-- the 500 MB free tier. Re-measure before bumping further.
--
-- Replaces the trim function from supabase-weather-cache-migration.sql
-- (LIMIT 72). That file's copy has been updated in lockstep so
-- re-running it does not silently revert this retention. The function
-- is called opportunistically by api/cron/refresh-weather-grid.js
-- after each hourly insert.
-- ═══════════════════════════════════════════════════════════════

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
