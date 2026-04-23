-- Parker Physics DSMC thermosphere schema extensions
-- Phase 1: satellite drag prediction
--
-- Applied on top of swmf/config/schema.sql. All tables are idempotent
-- (IF NOT EXISTS), so this file is safe to re-run.

-- ── Pipeline heartbeats ──────────────────────────────────────────────────────
-- Written by the Belay supervisor after every pitch attempt.
CREATE TABLE IF NOT EXISTS pipeline_heartbeat (
    id                 BIGSERIAL PRIMARY KEY,
    pitch              TEXT NOT NULL,
    outcome            TEXT NOT NULL CHECK (outcome IN ('ok', 'skip', 'error')),
    duration_ms        REAL,
    consecutive_fails  INT DEFAULT 0,
    consecutive_skips  INT DEFAULT 0,
    next_sleep_s       REAL,
    last_run_utc       TIMESTAMPTZ,
    last_ok_utc        TIMESTAMPTZ,
    last_error         TEXT,
    detail             JSONB,
    recorded_at        TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_heartbeat_pitch_ts
    ON pipeline_heartbeat (pitch, recorded_at DESC);

-- ── F10.7 daily solar radio flux (Penticton, 10.7 cm, 2800 MHz) ──────────────
-- Source: NOAA SWPC JSON / DRAO Penticton. Drives every empirical
-- thermosphere model. We keep both the observed flux and the 81-day
-- centered average (required by NRLMSISE-00).
CREATE TABLE IF NOT EXISTS f107_daily (
    id              BIGSERIAL PRIMARY KEY,
    date_utc        DATE UNIQUE NOT NULL,
    f107_obs_sfu    REAL,      -- observed daily value
    f107_adj_sfu    REAL,      -- adjusted to 1 AU
    f107_81day_avg  REAL,      -- centered 81-day average (MSIS F107A)
    source          TEXT DEFAULT 'NOAA/SWPC',
    ingested_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_f107_date ON f107_daily (date_utc DESC);

-- ── Ap/Kp geomagnetic indices (3-hourly Kp → daily Ap for MSIS) ──────────────
-- Source: NOAA/SWPC, GFZ Potsdam. Kp is a quasi-logarithmic 0–9 scale;
-- Ap is the linear equivalent used by MSIS.
CREATE TABLE IF NOT EXISTS ap_index_3h (
    id             BIGSERIAL PRIMARY KEY,
    timestamp_utc  TIMESTAMPTZ UNIQUE NOT NULL,
    kp             REAL,          -- 0.0–9.0
    ap             REAL,          -- linear equivalent
    source         TEXT DEFAULT 'NOAA/SWPC',
    ingested_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ap_ts ON ap_index_3h (timestamp_utc DESC);

-- ── Atmospheric density snapshots (model output) ─────────────────────────────
-- Results of an MSIS or SPARTA density call; used by Grafana to chart
-- ρ(alt) during storms and by the drag forecaster.
CREATE TABLE IF NOT EXISTS atmospheric_snapshots (
    id               BIGSERIAL PRIMARY KEY,
    valid_time_utc   TIMESTAMPTZ NOT NULL,
    altitude_km      REAL NOT NULL,
    lat_deg          REAL DEFAULT 0.0,
    lon_deg          REAL DEFAULT 0.0,
    density_kg_m3    REAL,
    temperature_K    REAL,
    scale_height_km  REAL,
    o_number_density REAL,     -- atomic O in m^-3 (dominant drag species)
    n2_number_density REAL,
    f107_sfu         REAL,
    ap               REAL,
    model            TEXT DEFAULT 'NRLMSISE-00',
    model_version    TEXT,
    ingested_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_atm_time_alt
    ON atmospheric_snapshots (valid_time_utc DESC, altitude_km);

-- ── TLE archive (weekly snapshots for hindcast validation) ───────────────────
CREATE TABLE IF NOT EXISTS tle_archive (
    id            BIGSERIAL PRIMARY KEY,
    norad_id      INT NOT NULL,
    epoch_utc     TIMESTAMPTZ NOT NULL,
    tle_line1     TEXT NOT NULL,
    tle_line2     TEXT NOT NULL,
    name          TEXT,
    bstar         REAL,          -- SGP4 drag term extracted from line1
    mean_motion   REAL,
    inclination   REAL,
    eccentricity  REAL,
    source        TEXT DEFAULT 'CelesTrak',
    ingested_at   TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (norad_id, epoch_utc)
);
CREATE INDEX IF NOT EXISTS idx_tle_norad_epoch ON tle_archive (norad_id, epoch_utc DESC);

-- ── Drag forecasts (per satellite per cycle) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS drag_forecasts (
    id                BIGSERIAL PRIMARY KEY,
    norad_id          INT NOT NULL,
    issued_at_utc     TIMESTAMPTZ NOT NULL,
    horizon_hours     REAL NOT NULL,
    initial_alt_km    REAL,
    predicted_alt_km  REAL,
    decay_rate_km_day REAL,
    f107_used         REAL,
    ap_used           REAL,
    density_model     TEXT DEFAULT 'NRLMSISE-00',
    tle_age_hours     REAL,
    reentry_risk      TEXT CHECK (reentry_risk IN ('low', 'elevated', 'high', 'imminent')),
    detail            JSONB
);
CREATE INDEX IF NOT EXISTS idx_drag_norad_issued
    ON drag_forecasts (norad_id, issued_at_utc DESC);
CREATE INDEX IF NOT EXISTS idx_drag_issued
    ON drag_forecasts (issued_at_utc DESC);
