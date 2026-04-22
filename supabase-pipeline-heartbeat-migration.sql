-- ═══════════════════════════════════════════════════════════════
-- Parker Physics — Pipeline Heartbeat (run in Supabase SQL Editor)
-- ═══════════════════════════════════════════════════════════════
-- Shared, modular health-check layer for every time-series pipeline
-- (weather grid, solar wind, and any future feed following the same
-- pattern). Each pg_cron refresh function updates a single row here
-- on success so an operator can answer "is the pipeline alive?" with
-- one query instead of spelunking through cron.job_run_details.
--
-- Why a table, not cron.job_run_details:
--   cron.job_run_details logs every run (success + failure) and is
--   unindexed on jobname. A `SELECT MAX(last_success)` over it scans
--   the whole table. This table stores one row per pipeline — O(1)
--   to query from the UI, easy to expose via RLS for read-only.
--
-- Shape:
--   pipeline_name       text primary key  — stable key, e.g. 'solar_wind'
--   last_success_at     timestamptz       — last successful upstream fetch
--   last_failure_at     timestamptz       — last failed attempt (nullable)
--   last_failure_reason text              — plpgsql error message (nullable)
--   last_source         text              — which upstream won (e.g. 'open-meteo')
--   consecutive_fail    int               — failure streak; resets on success
--   updated_at          timestamptz       — moved by trigger
--
-- Usage inside a refresh function:
--   PERFORM public.record_pipeline_success('solar_wind', 'noaa-swpc');
--   -- or, inside EXCEPTION block:
--   PERFORM public.record_pipeline_failure('solar_wind', SQLERRM);
--
-- Safe to re-run.
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.pipeline_heartbeat (
    pipeline_name        TEXT        PRIMARY KEY,
    last_success_at      TIMESTAMPTZ,
    last_failure_at      TIMESTAMPTZ,
    last_failure_reason  TEXT,
    last_source          TEXT,
    consecutive_fail     INT         NOT NULL DEFAULT 0,
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RLS: anon/authenticated readers get a safe view of health for any
-- public status page; service_role (cron jobs) writes. Nobody outside
-- the server can write.
ALTER TABLE public.pipeline_heartbeat ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pipeline_heartbeat_public_read ON public.pipeline_heartbeat;
CREATE POLICY pipeline_heartbeat_public_read
    ON public.pipeline_heartbeat
    FOR SELECT
    TO anon, authenticated
    USING (true);

-- ═══════════════════════════════════════════════════════════════
-- record_pipeline_success / record_pipeline_failure
-- Small helpers so refresh functions don't each reimplement upsert.
-- ═══════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.record_pipeline_success(
    p_name   TEXT,
    p_source TEXT DEFAULT NULL
) RETURNS void AS $$
    INSERT INTO public.pipeline_heartbeat AS h
        (pipeline_name, last_success_at, last_source, consecutive_fail, updated_at)
    VALUES
        (p_name, now(), p_source, 0, now())
    ON CONFLICT (pipeline_name) DO UPDATE SET
        last_success_at  = now(),
        last_source      = COALESCE(EXCLUDED.last_source, h.last_source),
        consecutive_fail = 0,
        updated_at       = now();
$$ LANGUAGE sql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION public.record_pipeline_failure(
    p_name   TEXT,
    p_reason TEXT DEFAULT NULL
) RETURNS void AS $$
    INSERT INTO public.pipeline_heartbeat AS h
        (pipeline_name, last_failure_at, last_failure_reason, consecutive_fail, updated_at)
    VALUES
        (p_name, now(), p_reason, 1, now())
    ON CONFLICT (pipeline_name) DO UPDATE SET
        last_failure_at     = now(),
        last_failure_reason = p_reason,
        consecutive_fail    = h.consecutive_fail + 1,
        updated_at          = now();
$$ LANGUAGE sql SECURITY DEFINER;

REVOKE ALL ON FUNCTION public.record_pipeline_success(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_pipeline_failure(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_pipeline_success(TEXT, TEXT) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.record_pipeline_failure(TEXT, TEXT) FROM anon, authenticated;

-- ═══════════════════════════════════════════════════════════════
-- Verification
-- ═══════════════════════════════════════════════════════════════
-- 1. After the weather + solar-wind migrations run once, confirm rows:
--      SELECT pipeline_name, last_success_at, last_source, consecutive_fail
--        FROM public.pipeline_heartbeat
--       ORDER BY pipeline_name;
--
-- 2. Health query for the UI / status page:
--      SELECT pipeline_name,
--             EXTRACT(EPOCH FROM (now() - last_success_at))::int AS age_seconds,
--             consecutive_fail,
--             last_failure_reason
--        FROM public.pipeline_heartbeat;
-- ═══════════════════════════════════════════════════════════════
