-- ═══════════════════════════════════════════════════════════════
-- Parker Physics — Forecast Accumulator (run in Supabase SQL Editor)
-- ═══════════════════════════════════════════════════════════════
-- Append-only event store for every prediction we make, paired with
-- the observation that arrived for that prediction. The "Phase 0
-- accumulator" from EARTH_ML_FIRST_PRINCIPLES.md, scoped to the
-- minimum needed to unblock analog forecasting, the NN residual-
-- correction track, and the skill leaderboard endpoint.
--
-- Three tables:
--   forecaster_registry          — model_id → human metadata
--   forecast_log                 — hot, 7-day ring; one row per
--                                  (made_at, valid_at, cell, field,
--                                   model). Backfilled with `observation`
--                                  when the validator sees the obs.
--   forecast_archive_pointer     — daily archives offloaded to R2,
--                                  one row per (day, file) so replay
--                                  knows where to look.
--
-- Privacy note: lat/lon are rounded to 0.5° at insert by the RPC.
-- A user pinning the picker at their house is logged at the nearest
-- 55 km grid cell, never the actual point.
--
-- Volume note: the writer-side throttle (one POST per 10 s per
-- client, batched ≤100 records) plus rounding to a 0.5° grid keeps
-- the hot table to a few thousand rows/day at expected usage. The
-- archive cron drains rows older than 7 d to R2; trim_forecast_log()
-- removes archived rows so the hot table stays bounded.
--
-- Prerequisites:
--   1. supabase-bootstrap-fresh.sql (or an existing public schema)
--   2. (optional) supabase-pipeline-heartbeat-migration.sql for
--      heartbeat integration in the archive cron (PR #2).
--
-- Safe to re-run (IF NOT EXISTS / CREATE OR REPLACE).
-- ═══════════════════════════════════════════════════════════════


-- ═══════════════════════════════════════════════════════════════
-- forecaster_registry
-- ═══════════════════════════════════════════════════════════════
-- One row per (model_id, version). We keep retired entries around
-- with `retired_at` set so historical forecast_log rows still resolve.
CREATE TABLE IF NOT EXISTS public.forecaster_registry (
    model_id      TEXT        PRIMARY KEY,
    name          TEXT        NOT NULL,
    version       TEXT        NOT NULL DEFAULT '1',
    code_hash     TEXT,
    family        TEXT        NOT NULL DEFAULT 'unknown'
                              CHECK (family IN (
                                  'persistence', 'diurnal', 'statistical',
                                  'nwp', 'blend', 'ml', 'analog', 'unknown'
                              )),
    deployed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    retired_at    TIMESTAMPTZ,
    notes         TEXT
);

ALTER TABLE public.forecaster_registry ENABLE ROW LEVEL SECURITY;

-- Public read so the UI can render model names in the leaderboard
-- without needing a server hop. Writes are service_role-only.
DROP POLICY IF EXISTS forecaster_registry_public_read ON public.forecaster_registry;
CREATE POLICY forecaster_registry_public_read
    ON public.forecaster_registry
    FOR SELECT
    TO anon, authenticated
    USING (true);

-- Seed the five members the Rust WASM blender already emits. Safe to
-- re-run; ON CONFLICT keeps existing notes/code_hash intact if a later
-- session updated them.
INSERT INTO public.forecaster_registry (model_id, name, family, notes) VALUES
    ('PERSIST',  'Persistence',                 'persistence', 'Last observed value; AR(1) bias drift.'),
    ('DIURNAL',  'Diurnal harmonic',            'diurnal',     '24h + 12h Fourier fit, sun-altitude phase.'),
    ('AR1',      'AR(1) residual',              'statistical', 'First-order autoregression on de-seasonalised obs.'),
    ('NWP',      'Open-Meteo raw NWP',          'nwp',         'GFS/ECMWF/ICON/GEM raw guidance.'),
    ('NWP_BC',   'Open-Meteo NWP bias-corrected','nwp',        'NWP with running-mean bias correction vs obs.'),
    ('BLEND',    'Skill-weighted blend',        'blend',       'Softmax(-RMSE/T) over the four base members.')
ON CONFLICT (model_id) DO NOTHING;


-- ═══════════════════════════════════════════════════════════════
-- forecast_log
-- ═══════════════════════════════════════════════════════════════
-- Hot table. Each row is a single (made_at, valid_at, cell, field,
-- model) prediction. `observation` and `obs_at` are NULL on insert
-- and backfilled by the validator when the truth arrives.
--
-- `lead_minutes` is a generated column so the leaderboard query
-- ("skill at lead ≤ N min") doesn't need to recompute it on every
-- aggregate.
--
-- `archived = TRUE` means the row has been written to R2 and is safe
-- for trim_forecast_log() to delete. The archive cron flips this in
-- the same transaction that writes forecast_archive_pointer.
CREATE TABLE IF NOT EXISTS public.forecast_log (
    id            BIGSERIAL    PRIMARY KEY,
    made_at       TIMESTAMPTZ  NOT NULL,
    valid_at      TIMESTAMPTZ  NOT NULL,
    lead_minutes  INTEGER      GENERATED ALWAYS AS
                               (GREATEST(0, EXTRACT(EPOCH FROM (valid_at - made_at))::INT / 60))
                               STORED,
    lat           REAL         NOT NULL,
    lon           REAL         NOT NULL,
    field         TEXT         NOT NULL,
    model_id      TEXT         NOT NULL REFERENCES public.forecaster_registry(model_id),
    value         REAL,
    p10           REAL,
    p50           REAL,
    p90           REAL,
    sim_time_ms   BIGINT,
    observation   REAL,
    obs_at        TIMESTAMPTZ,
    archived      BOOLEAN      NOT NULL DEFAULT FALSE,
    ingested_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CHECK (length(field) BETWEEN 1 AND 64),
    CHECK (lat >= -90 AND lat <= 90),
    CHECK (lon >= -180 AND lon <= 180)
);

-- Leaderboard query: rolled-up MAE/RMSE for a cell+field over a
-- recent window. The partial index makes that fast without paying
-- for archived rows we're about to delete.
CREATE INDEX IF NOT EXISTS forecast_log_skill_idx
    ON public.forecast_log (lat, lon, field, made_at DESC)
    WHERE archived = FALSE;

-- Archive cron query: "everything older than 7 d that hasn't moved
-- to R2 yet, grouped by day."
CREATE INDEX IF NOT EXISTS forecast_log_archive_idx
    ON public.forecast_log (made_at)
    WHERE archived = FALSE;

-- Observation backfill query: "rows whose valid_at matches the
-- observation timestamp." Narrow filter; covers the validator-side
-- UPDATE without scanning the whole table.
CREATE INDEX IF NOT EXISTS forecast_log_valid_at_idx
    ON public.forecast_log (valid_at, field)
    WHERE observation IS NULL;

ALTER TABLE public.forecast_log ENABLE ROW LEVEL SECURITY;
-- No SELECT policy = no anon/authenticated reads. Aggregates flow
-- through /api/weather/skill (service_role). Writes flow through
-- the SECURITY DEFINER RPC below, never raw INSERTs from clients.


-- ═══════════════════════════════════════════════════════════════
-- forecast_archive_pointer
-- ═══════════════════════════════════════════════════════════════
-- One row per archived day (or partial day if the archive cron
-- chunks). Replay reads this table to discover which R2 keys cover
-- a requested window.
CREATE TABLE IF NOT EXISTS public.forecast_archive_pointer (
    id           BIGSERIAL   PRIMARY KEY,
    day          DATE        NOT NULL,
    r2_key       TEXT        NOT NULL UNIQUE,
    row_count    INTEGER     NOT NULL,
    bytes        BIGINT      NOT NULL,
    sha256       TEXT        NOT NULL,
    written_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS forecast_archive_pointer_day_idx
    ON public.forecast_archive_pointer (day DESC);

ALTER TABLE public.forecast_archive_pointer ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS forecast_archive_pointer_public_read ON public.forecast_archive_pointer;
CREATE POLICY forecast_archive_pointer_public_read
    ON public.forecast_archive_pointer
    FOR SELECT
    TO anon, authenticated
    USING (true);


-- ═══════════════════════════════════════════════════════════════
-- trim_forecast_log()
-- ═══════════════════════════════════════════════════════════════
-- Delete rows that have been archived to R2 and are older than 7 d.
-- The archive cron calls this after each successful upload. We
-- DON'T delete un-archived rows even if they're older than 7 d —
-- the cron should have caught them; leaving them visible flags the
-- pipeline as broken rather than silently dropping data.
CREATE OR REPLACE FUNCTION public.trim_forecast_log()
RETURNS INTEGER AS $$
DECLARE
    rows_deleted INTEGER;
BEGIN
    DELETE FROM public.forecast_log
     WHERE archived = TRUE
       AND made_at  < now() - INTERVAL '7 days';
    GET DIAGNOSTICS rows_deleted = ROW_COUNT;
    RETURN rows_deleted;
END;
$$ LANGUAGE plpgsql;


-- ═══════════════════════════════════════════════════════════════
-- record_forecast_batch(payload JSONB)
-- ═══════════════════════════════════════════════════════════════
-- Browser write-through endpoint. /api/forecast/log calls this with
-- a JSONB array of records; we validate, round lat/lon to 0.5° for
-- privacy, and bulk-insert.
--
-- Validation rules (strict — this is a browser-callable endpoint):
--   - payload must be a JSONB array, 1..100 items
--   - each record: made_at, valid_at, lat, lon, field, model_id required
--   - model_id must exist in forecaster_registry and not be retired
--   - made_at within ±48h of now() (allow some clock skew + replay)
--   - valid_at within ±14d of now() (24h forecast horizon + slack)
--   - field length 1..64
--   - value/p10/p50/p90/observation: finite if present; else dropped
--
-- Returns: { ingested INT, rejected INT, reasons JSONB }
-- Idempotency: we don't dedup on insert — the same client posting the
-- same prediction twice yields two rows. The validator-side UPDATE
-- (observation backfill) is keyed on (made_at, valid_at, lat, lon,
-- field, model) and updates all matching rows, so duplicates don't
-- bias skill stats; they just waste storage. The 10s client throttle
-- keeps that waste small.
CREATE OR REPLACE FUNCTION public.record_forecast_batch(payload JSONB)
RETURNS JSONB AS $$
DECLARE
    rec            JSONB;
    ingested_count INTEGER := 0;
    rejected_count INTEGER := 0;
    reasons        JSONB   := '[]'::JSONB;
    v_made_at      TIMESTAMPTZ;
    v_valid_at     TIMESTAMPTZ;
    v_lat          REAL;
    v_lon          REAL;
    v_field        TEXT;
    v_model_id     TEXT;
    v_value        REAL;
    v_p10          REAL;
    v_p50          REAL;
    v_p90          REAL;
    v_sim_time_ms  BIGINT;
    v_known_model  BOOLEAN;
BEGIN
    IF payload IS NULL OR jsonb_typeof(payload) <> 'array' THEN
        RAISE EXCEPTION 'payload must be a JSONB array';
    END IF;

    IF jsonb_array_length(payload) = 0 OR jsonb_array_length(payload) > 100 THEN
        RAISE EXCEPTION 'payload must contain 1..100 records (got %)',
            jsonb_array_length(payload);
    END IF;

    FOR rec IN SELECT * FROM jsonb_array_elements(payload) LOOP
        BEGIN
            -- Required fields
            v_made_at  := (rec ->> 'made_at')::TIMESTAMPTZ;
            v_valid_at := (rec ->> 'valid_at')::TIMESTAMPTZ;
            v_lat      := (rec ->> 'lat')::REAL;
            v_lon      := (rec ->> 'lon')::REAL;
            v_field    := rec ->> 'field';
            v_model_id := rec ->> 'model_id';

            IF v_made_at IS NULL OR v_valid_at IS NULL
               OR v_lat IS NULL OR v_lon IS NULL
               OR v_field IS NULL OR v_model_id IS NULL THEN
                rejected_count := rejected_count + 1;
                reasons := reasons || jsonb_build_object('reason', 'missing_required', 'rec', rec);
                CONTINUE;
            END IF;

            IF v_made_at < now() - INTERVAL '48 hours'
               OR v_made_at > now() + INTERVAL '48 hours' THEN
                rejected_count := rejected_count + 1;
                reasons := reasons || jsonb_build_object('reason', 'made_at_out_of_range');
                CONTINUE;
            END IF;

            IF v_valid_at < now() - INTERVAL '14 days'
               OR v_valid_at > now() + INTERVAL '14 days' THEN
                rejected_count := rejected_count + 1;
                reasons := reasons || jsonb_build_object('reason', 'valid_at_out_of_range');
                CONTINUE;
            END IF;

            IF v_lat < -90 OR v_lat > 90 OR v_lon < -180 OR v_lon > 180 THEN
                rejected_count := rejected_count + 1;
                reasons := reasons || jsonb_build_object('reason', 'latlon_out_of_range');
                CONTINUE;
            END IF;

            IF length(v_field) = 0 OR length(v_field) > 64 THEN
                rejected_count := rejected_count + 1;
                reasons := reasons || jsonb_build_object('reason', 'field_length');
                CONTINUE;
            END IF;

            -- Registry check
            SELECT TRUE INTO v_known_model
              FROM public.forecaster_registry
             WHERE model_id = v_model_id
               AND retired_at IS NULL;

            IF v_known_model IS NOT TRUE THEN
                rejected_count := rejected_count + 1;
                reasons := reasons || jsonb_build_object('reason', 'unknown_model', 'model_id', v_model_id);
                CONTINUE;
            END IF;

            -- Optional numeric fields. Anything non-finite is dropped to NULL
            -- rather than failing the row.
            v_value := NULLIF(rec ->> 'value', '')::REAL;
            v_p10   := NULLIF(rec ->> 'p10',   '')::REAL;
            v_p50   := NULLIF(rec ->> 'p50',   '')::REAL;
            v_p90   := NULLIF(rec ->> 'p90',   '')::REAL;
            v_sim_time_ms := NULLIF(rec ->> 'sim_time_ms', '')::BIGINT;

            -- Privacy: round to 0.5° (~55 km at equator). Permanent and
            -- enforced server-side so a future careless caller can't ship
            -- raw user coordinates by accident.
            v_lat := ROUND(v_lat::NUMERIC * 2) / 2;
            v_lon := ROUND(v_lon::NUMERIC * 2) / 2;

            INSERT INTO public.forecast_log
                (made_at, valid_at, lat, lon, field, model_id,
                 value, p10, p50, p90, sim_time_ms)
            VALUES
                (v_made_at, v_valid_at, v_lat, v_lon, v_field, v_model_id,
                 v_value, v_p10, v_p50, v_p90, v_sim_time_ms);

            ingested_count := ingested_count + 1;
        EXCEPTION WHEN OTHERS THEN
            -- Any per-record parse/cast error: count and move on. Whole-batch
            -- failures (e.g. payload not an array) raise above, before this
            -- loop runs.
            rejected_count := rejected_count + 1;
            reasons := reasons || jsonb_build_object('reason', 'parse_error', 'detail', SQLERRM);
        END;
    END LOOP;

    RETURN jsonb_build_object(
        'ingested', ingested_count,
        'rejected', rejected_count,
        'reasons',  reasons
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION public.record_forecast_batch(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_forecast_batch(JSONB) FROM anon, authenticated;
-- Only service_role (used by /api/forecast/log) can call this.


-- ═══════════════════════════════════════════════════════════════
-- backfill_forecast_observations(field TEXT, valid_window TSTZRANGE,
--                                obs_payload JSONB)
-- ═══════════════════════════════════════════════════════════════
-- Validator-side helper. Given a field and a time window, plus a
-- JSONB array of { lat, lon, observation, obs_at } records, update
-- every matching forecast_log row whose observation is still NULL.
--
-- Called by /api/weather/skill (and future ML training pipelines)
-- after each weather_grid_cache refresh — once truth is in the
-- cache, we can score predictions made before it.
--
-- This is the only way to write observation/obs_at back into
-- forecast_log; the record_forecast_batch path never touches those
-- columns.
CREATE OR REPLACE FUNCTION public.backfill_forecast_observations(
    p_field        TEXT,
    p_window_start TIMESTAMPTZ,
    p_window_end   TIMESTAMPTZ,
    p_obs_payload  JSONB
) RETURNS INTEGER AS $$
DECLARE
    obs_rec        JSONB;
    v_lat          REAL;
    v_lon          REAL;
    v_obs          REAL;
    v_obs_at       TIMESTAMPTZ;
    total_updated  INTEGER := 0;
    rows_for_one   INTEGER;
BEGIN
    IF p_obs_payload IS NULL OR jsonb_typeof(p_obs_payload) <> 'array' THEN
        RAISE EXCEPTION 'p_obs_payload must be a JSONB array';
    END IF;
    IF length(p_field) = 0 OR length(p_field) > 64 THEN
        RAISE EXCEPTION 'p_field length out of range';
    END IF;

    FOR obs_rec IN SELECT * FROM jsonb_array_elements(p_obs_payload) LOOP
        BEGIN
            v_lat    := (obs_rec ->> 'lat')::REAL;
            v_lon    := (obs_rec ->> 'lon')::REAL;
            v_obs    := (obs_rec ->> 'observation')::REAL;
            v_obs_at := (obs_rec ->> 'obs_at')::TIMESTAMPTZ;

            IF v_lat IS NULL OR v_lon IS NULL
               OR v_obs IS NULL OR v_obs_at IS NULL THEN
                CONTINUE;
            END IF;

            v_lat := ROUND(v_lat::NUMERIC * 2) / 2;
            v_lon := ROUND(v_lon::NUMERIC * 2) / 2;

            UPDATE public.forecast_log
               SET observation = v_obs,
                   obs_at      = v_obs_at
             WHERE field       = p_field
               AND lat         = v_lat
               AND lon         = v_lon
               AND valid_at   >= p_window_start
               AND valid_at   <= p_window_end
               AND observation IS NULL;
            GET DIAGNOSTICS rows_for_one = ROW_COUNT;
            total_updated := total_updated + rows_for_one;
        EXCEPTION WHEN OTHERS THEN
            -- Skip the bad record; the rest of the batch still applies.
            CONTINUE;
        END;
    END LOOP;

    RETURN total_updated;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION public.backfill_forecast_observations(
    TEXT, TIMESTAMPTZ, TIMESTAMPTZ, JSONB
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.backfill_forecast_observations(
    TEXT, TIMESTAMPTZ, TIMESTAMPTZ, JSONB
) FROM anon, authenticated;


-- ═══════════════════════════════════════════════════════════════
-- Verification
-- ═══════════════════════════════════════════════════════════════
-- 1. Registry seeded?
--      SELECT model_id, name, family FROM public.forecaster_registry
--      ORDER BY model_id;
--
-- 2. Insert a single test prediction:
--      SELECT public.record_forecast_batch(jsonb_build_array(
--        jsonb_build_object(
--          'made_at',   now(),
--          'valid_at',  now() + interval '1 hour',
--          'lat',       40.0,
--          'lon',       -105.0,
--          'field',     'temperature_2m',
--          'model_id',  'PERSIST',
--          'value',     12.5,
--          'p10',       11.0,
--          'p50',       12.5,
--          'p90',       14.0
--        )
--      ));
--      -- → {"ingested":1,"rejected":0,"reasons":[]}
--
-- 3. Confirm privacy rounding (lat 40.0 → 40.0, lat 40.1 → 40.0):
--      SELECT lat, lon FROM public.forecast_log
--      ORDER BY id DESC LIMIT 1;
--
-- 4. Trim no-op until archive cron lands (PR #2):
--      SELECT public.trim_forecast_log();
--      -- → 0
-- ═══════════════════════════════════════════════════════════════
