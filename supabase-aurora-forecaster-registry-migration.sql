-- ═══════════════════════════════════════════════════════════════
-- Parker Physics — AurOracle forecaster registry seed (SQL Editor)
-- ═══════════════════════════════════════════════════════════════
-- Registers the AurOracle month-outlook models so api/cron/aurora-outlook.js
-- can log their daily-Kp predictions to forecast_log via record_forecast_batch
-- (which rejects any model_id not present here). Phase 2 of
-- AURORACLE_ML_PLAN.md §6 — "record before predict / score before you ship ML."
--
-- Companion to supabase-forecast-accumulator-migration.sql (forecaster_registry
-- + forecast_log live there). Safe to re-run (ON CONFLICT DO NOTHING).
-- ═══════════════════════════════════════════════════════════════

INSERT INTO public.forecaster_registry (model_id, name, family, notes) VALUES
    ('AUR_PERSIST', 'AurOracle persistence',  'persistence',
        'Most recent observed daily-mean Kp, held flat across all leads. The baseline every other AurOracle model is scored against.'),
    ('AUR_NOAA45',  'NOAA 45-day Ap',         'nwp',
        'SWPC 45-day Ap forecast converted Ap->Kp. The p50 backbone of the month outlook.'),
    ('AUR_RECUR',   '27-day recurrence',      'analog',
        'Observed planetary-K shifted +27d (one solar rotation). The canonical medium-range analog.'),
    ('AUR_BLEND',   'AurOracle blend',        'blend',
        'Published month outlook: NOAA 45-day nudged toward the 27-day recurrence analog, with a climatological band.')
ON CONFLICT (model_id) DO NOTHING;
