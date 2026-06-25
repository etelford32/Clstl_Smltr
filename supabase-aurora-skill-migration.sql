-- ═══════════════════════════════════════════════════════════════
-- Parker Physics — AurOracle skill leaderboard RPC (SQL Editor)
-- ═══════════════════════════════════════════════════════════════
-- Aggregates matured planetary-Kp predictions in forecast_log into a per-model
-- skill summary for /api/aurora/skill. Phase 2 of AURORACLE_ML_PLAN.md §6: prove
-- the historically-driven baseline beats persistence BEFORE the Phase 3 Kp-LSTM
-- enters as a scored member.
--
-- forecast_log has RLS on with no SELECT policy (server-only), so aggregates
-- must flow through a SECURITY DEFINER function — like get_accumulator_stats.
-- This one returns only aggregate skill numbers (no row contents), so it's a
-- safe public trust signal; the /api/aurora/skill edge fn calls it service_role.
--
-- Skill = Murphy skill score vs a reference: 1 - MSE_model / MSE_reference.
--   skill_vs_persist > 0  → beats "tomorrow looks like today"
--   skill_vs_recur   > 0  → beats raw 27-day recurrence
-- All models are logged for the same valid days each cron run, so MSEs are on
-- matched samples and the comparison is fair.
--
-- Safe to re-run (CREATE OR REPLACE).
-- ═══════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.aurora_forecast_skill()
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
WITH matured AS (
    SELECT model_id,
           (valid_at AT TIME ZONE 'UTC')::date AS valid_day,
           COALESCE(p50, value) AS pred,
           observation          AS obs
    FROM public.forecast_log
    WHERE field = 'kp_planetary'
      AND observation IS NOT NULL
      AND COALESCE(p50, value) IS NOT NULL
),
agg AS (
    SELECT model_id,
           count(*)                              AS n,
           avg(abs(pred - obs))                  AS mae,
           sqrt(avg(power(pred - obs, 2)))       AS rmse,
           avg(pred - obs)                       AS bias,
           avg(power(pred - obs, 2))             AS mse
    FROM matured
    GROUP BY model_id
),
ref AS (
    SELECT max(mse) FILTER (WHERE model_id = 'AUR_PERSIST') AS mse_persist,
           max(mse) FILTER (WHERE model_id = 'AUR_RECUR')   AS mse_recur
    FROM agg
),
blend AS (
    SELECT count(*) AS n,
           count(*) FILTER (WHERE abs(pred - obs) <= 1.0) AS hits
    FROM matured WHERE model_id = 'AUR_BLEND'
)
SELECT jsonb_build_object(
    'as_of',         now(),
    'field',         'kp_planetary',
    'n_matured',     (SELECT COALESCE(sum(n), 0) FROM agg),
    'matured_days',  (SELECT count(DISTINCT valid_day) FROM matured),
    'blend_hits',    (SELECT hits FROM blend),
    'blend_n',       (SELECT n FROM blend),
    'blend_hit_rate',(SELECT CASE WHEN n > 0 THEN round((hits::numeric / n), 3) END FROM blend),
    'models', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
            'model_id',         a.model_id,
            'name',             r.name,
            'family',           r.family,
            'n',                a.n,
            'mae',              round(a.mae::numeric, 3),
            'rmse',             round(a.rmse::numeric, 3),
            'bias',             round(a.bias::numeric, 3),
            'skill_vs_persist', CASE WHEN ref.mse_persist > 0 THEN round((1 - a.mse / ref.mse_persist)::numeric, 3) END,
            'skill_vs_recur',   CASE WHEN ref.mse_recur   > 0 THEN round((1 - a.mse / ref.mse_recur)::numeric, 3) END
        ) ORDER BY a.model_id)
        FROM agg a
        LEFT JOIN public.forecaster_registry r ON r.model_id = a.model_id
        CROSS JOIN ref
    ), '[]'::jsonb)
);
$$;

-- Aggregates only (no row contents). The /api/aurora/skill edge fn calls this
-- with the service_role key; lock everyone else out.
REVOKE ALL ON FUNCTION public.aurora_forecast_skill() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.aurora_forecast_skill() TO service_role;

-- ═══════════════════════════════════════════════════════════════
-- Verification (SQL Editor bypasses the grant):
--   SELECT public.aurora_forecast_skill();
--   -- → {"n_matured":0,"matured_days":0,"models":[], ...} until forecasts mature
-- ═══════════════════════════════════════════════════════════════
