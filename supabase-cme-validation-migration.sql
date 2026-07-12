-- supabase-cme-validation-migration.sql
-- Durable per-event storage for the CME forecasting/validation program
-- (design: CME_FORECAST_VALIDATION_PLAN.md; offline truth pull:
-- pipelines/cme/step0_pull.py).
--
-- NOT YET APPLIED. Review, then apply via the Supabase MCP apply_migration.
--
-- Motivation: the existing daily CME study (api/cron/validation-rerun.js →
-- validation_runs kind='cme') recomputes forecasts from the current DONKI
-- window at scoring time and keeps only aggregate scores. That leaves four
-- gaps this migration closes:
--   1. no durable per-CME record            → cme_events
--   2. no issue-time-locked forecasts       → cme_arrival_forecasts
--   3. no authoritative external truth      → cme_l1_observations +
--      (truth = self-detected shocks only)     cme_geomag_observations
--   4. no per-model arrival skill ledger    → cme_model_skill view
--
-- ACCESS MODEL (same as validation_runs / forecast_log — CLAUDE.md §4.2):
-- RLS enabled with ZERO policies on all four tables, deliberately. Written
-- by the cron and the reviewed step0 inserts (service role), read through
-- edge endpoints (service role). Do NOT add permissive policies; the
-- advisor flag is a known false positive here.

-- ── 1. cme_events — one row per physical CME we track ──────────────────────
CREATE TABLE IF NOT EXISTS public.cme_events (
    event_id      TEXT PRIMARY KEY,           -- PP-HC-YYYY-MMDD (hindcast) or PP-RT-... (realtime)
    donki_id      TEXT,                       -- DONKI associatedCMEID when available
    launch_time_utc         TIMESTAMPTZ NOT NULL,
    source_region TEXT,                       -- e.g. 'AR13664 S17W27'
    cme_type      TEXT,                       -- DONKI type (S/C/O/R/ER) or 'halo'
    speed_kms_3d  DOUBLE PRECISION,           -- 3D (deprojected) speed at 21.5 Rs
    half_width_deg          DOUBLE PRECISION,
    direction_lat_deg       DOUBLE PRECISION,
    direction_lon_deg       DOUBLE PRECISION,
    is_earth_directed       BOOLEAN,
    is_hindcast   BOOLEAN NOT NULL DEFAULT FALSE,
    characterization_source TEXT NOT NULL DEFAULT 'DONKI'
        CHECK (characterization_source IN ('DONKI', 'CDAW', 'MANUAL')),
    notes         TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cme_events_launch ON public.cme_events (launch_time_utc DESC);

-- ── 2. cme_arrival_forecasts — issue-time-locked predictions ───────────────
-- The record-before-predict discipline the weather side already has
-- (forecast_log): a forecast row is INSERTed when the forecast is made and
-- NEVER updated. Scoring fills a separate observation table and joins.
CREATE TABLE IF NOT EXISTS public.cme_arrival_forecasts (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id      TEXT NOT NULL REFERENCES public.cme_events(event_id),
    model_id      TEXT NOT NULL,              -- 'dbm-v1' | 'ballistic-v1' | 'enlil' | 'swpc' ...
    issued_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Arrival prediction (the primary scored quantity):
    predicted_arrival_utc   TIMESTAMPTZ NOT NULL,
    arrival_window_early    TIMESTAMPTZ,      -- e.g. DBM ±15% transit band
    arrival_window_late     TIMESTAMPTZ,
    predicted_hit  BOOLEAN NOT NULL DEFAULT TRUE,  -- FALSE = forecast says it misses Earth
    -- Impact-magnitude predictions (scored against cme_geomag_observations):
    predicted_speed_at_l1   DOUBLE PRECISION,
    predicted_kp_max        DOUBLE PRECISION,
    predicted_dst_min_nt    DOUBLE PRECISION,
    -- Provenance: model inputs frozen at issue time, for exact replay
    inputs        JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS cme_arrival_forecasts_event
    ON public.cme_arrival_forecasts (event_id, model_id, issued_at DESC);

-- ── 3. Truth tables — filled by reviewed step0 inserts + the live cron ─────
CREATE TABLE IF NOT EXISTS public.cme_l1_observations (
    event_id      TEXT PRIMARY KEY REFERENCES public.cme_events(event_id),
    shock_arrival_utc       TIMESTAMPTZ,      -- NULL when arrived=false or no clear shock
    icme_start_utc          TIMESTAMPTZ,      -- Richardson–Cane boundary when available
    icme_end_utc            TIMESTAMPTZ,
    observed_speed_kms      DOUBLE PRECISION,
    observed_bz_min_nt      DOUBLE PRECISION,
    observed_density_max    DOUBLE PRECISION,
    arrived       BOOLEAN NOT NULL,           -- FALSE rows score false-alarm forecasts
    source        TEXT NOT NULL DEFAULT 'OMNI'
        CHECK (source IN ('OMNI', 'RTSW', 'RC_LIST', 'MANUAL')),
    confirmed_by_human      BOOLEAN NOT NULL DEFAULT FALSE,
    notes         TEXT,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.cme_geomag_observations (
    event_id      TEXT PRIMARY KEY REFERENCES public.cme_events(event_id),
    symh_min_nt   DOUBLE PRECISION,
    symh_min_utc  TIMESTAMPTZ,
    dst_min_nt    DOUBLE PRECISION,           -- OMNI2 hourly (ingests Kyoto WDC)
    kp_max        DOUBLE PRECISION,
    source        TEXT NOT NULL DEFAULT 'OMNI',
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.cme_events              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cme_arrival_forecasts   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cme_l1_observations     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cme_geomag_observations ENABLE ROW LEVEL SECURITY;
-- No policies: service-role-only by design (see header).

-- ── 4. Per-model skill ledger ───────────────────────────────────────────────
-- One row per (model, hindcast-vs-realtime): timing MAE/bias over scored
-- forecasts. Read by /api/cme/skill for the dashboard leaderboard. A view,
-- not a table — always consistent with the underlying forecasts/truth.
CREATE OR REPLACE VIEW public.cme_model_skill
WITH (security_invoker = false) AS
SELECT
    f.model_id,
    e.is_hindcast,
    count(*)                                   AS n_scored,
    count(*) FILTER (WHERE o.arrived AND f.predicted_hit
        AND abs(extract(epoch FROM (f.predicted_arrival_utc - o.shock_arrival_utc))) <= 43200)
                                               AS hits_12h,
    avg(abs(extract(epoch FROM (f.predicted_arrival_utc - o.shock_arrival_utc))) / 3600.0)
        FILTER (WHERE o.arrived AND o.shock_arrival_utc IS NOT NULL)
                                               AS mae_hours,
    avg(extract(epoch FROM (f.predicted_arrival_utc - o.shock_arrival_utc)) / 3600.0)
        FILTER (WHERE o.arrived AND o.shock_arrival_utc IS NOT NULL)
                                               AS bias_hours,   -- + = predicted late
    count(*) FILTER (WHERE f.predicted_hit AND NOT o.arrived)   AS false_alarms,
    count(*) FILTER (WHERE NOT f.predicted_hit AND o.arrived)   AS misses
FROM public.cme_arrival_forecasts f
JOIN public.cme_events e USING (event_id)
JOIN public.cme_l1_observations o USING (event_id)
GROUP BY f.model_id, e.is_hindcast;

-- The view runs as owner (postgres) over zero-policy tables, matching the
-- service-role-only access model: PostgREST exposes it only to service role
-- because anon/authenticated get no grants.
REVOKE ALL ON public.cme_model_skill FROM anon;
REVOKE ALL ON public.cme_model_skill FROM authenticated;
