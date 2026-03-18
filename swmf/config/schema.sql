-- Parker Physics SWMF database schema
-- Phase 0: run history + validation metrics + L1 observations

-- L1 observations (from DSCOVR/ACE NOAA SWPC JSON)
CREATE TABLE IF NOT EXISTS l1_observations (
    id             BIGSERIAL PRIMARY KEY,
    timestamp_utc  TIMESTAMPTZ NOT NULL,
    speed_kms      REAL,
    density_cc     REAL,
    temperature_k  REAL,
    bx_gsm_nT      REAL,
    by_gsm_nT      REAL,
    bz_gsm_nT      REAL,
    bt_nT          REAL,
    source         TEXT DEFAULT 'DSCOVR',
    ingested_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_l1_timestamp ON l1_observations (timestamp_utc DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_l1_unique_ts ON l1_observations (timestamp_utc, source);

-- BATS-R-US forecast runs
CREATE TABLE IF NOT EXISTS forecast_runs (
    id             BIGSERIAL PRIMARY KEY,
    run_id         TEXT UNIQUE NOT NULL,
    run_mode       TEXT NOT NULL CHECK (run_mode IN ('forecast', 'hindcast', 'mock')),
    start_time_utc TIMESTAMPTZ NOT NULL,
    forecast_hours REAL NOT NULL,
    mpi_nproc      INT,
    run_dir        TEXT,
    status         TEXT DEFAULT 'running' CHECK (status IN ('running', 'complete', 'failed')),
    sim_hours_done REAL,
    created_at     TIMESTAMPTZ DEFAULT NOW(),
    completed_at   TIMESTAMPTZ
);

-- Simulated Earth conditions (output from BATS-R-US at 215 R☉ sphere)
CREATE TABLE IF NOT EXISTS earth_conditions_sim (
    id             BIGSERIAL PRIMARY KEY,
    run_id         TEXT REFERENCES forecast_runs(run_id),
    sim_time_h     REAL NOT NULL,          -- hours from run start
    valid_time_utc TIMESTAMPTZ NOT NULL,   -- = run start + sim_time_h
    density_cc     REAL,
    vx_kms         REAL,
    vy_kms         REAL,
    vz_kms         REAL,
    bx_nT          REAL,
    by_nT          REAL,
    bz_nT          REAL,
    pressure_nPa   REAL
);
CREATE INDEX IF NOT EXISTS idx_ecs_valid_time ON earth_conditions_sim (valid_time_utc DESC);
CREATE INDEX IF NOT EXISTS idx_ecs_run_id     ON earth_conditions_sim (run_id);

-- Validation metrics (hindcast vs. observations)
CREATE TABLE IF NOT EXISTS validation_metrics (
    id               BIGSERIAL PRIMARY KEY,
    run_id           TEXT REFERENCES forecast_runs(run_id),
    event_name       TEXT,
    arrival_error_h  REAL,
    speed_error_pct  REAL,
    bz_error_nT      REAL,
    bz_sign_correct  BOOLEAN,
    kp_proxy_error   REAL,
    gate_pass        BOOLEAN,
    validation_score REAL,
    grade            TEXT,
    metrics_json     JSONB,
    validated_at     TIMESTAMPTZ DEFAULT NOW()
);

-- API request log (for rate limiting + usage analytics)
CREATE TABLE IF NOT EXISTS api_requests (
    id          BIGSERIAL PRIMARY KEY,
    endpoint    TEXT NOT NULL,
    method      TEXT NOT NULL,
    status_code INT,
    client_ip   TEXT,
    api_key     TEXT,
    latency_ms  REAL,
    requested_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_api_ts ON api_requests (requested_at DESC);

-- AR3842 event reference data
INSERT INTO validation_metrics (event_name, grade, gate_pass, metrics_json, validated_at)
VALUES (
    'AR3842 X9.0 2024-10-03 — reference record',
    'PENDING',
    FALSE,
    '{
      "flare_class": "X9.0",
      "flare_time": "2024-10-03T12:08:00Z",
      "cme_speed_kms": 2200,
      "obs_arrival": "2024-10-05T17:00:00Z",
      "obs_peak_speed_kms": 900,
      "obs_bz_min_nT": -29,
      "obs_dst_min_nT": -207,
      "obs_kp_max": 8.7
    }'::jsonb,
    NOW()
) ON CONFLICT DO NOTHING;
