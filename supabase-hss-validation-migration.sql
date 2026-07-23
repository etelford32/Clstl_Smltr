-- ─────────────────────────────────────────────────────────────────────────
-- HSS validation program — high-speed-stream arrival scoring
-- (2026-07-23, Stage S9 follow-through: "recording each detected hole's
-- predicted arrival window in the validation tables and scoring it
-- against the observed L1 speed rise").
--
-- Mirrors the cme_validation_program pattern exactly (see
-- CME_FORECAST_VALIDATION_PLAN.md): events are upserted from the HEK
-- SPoCA catalog by api/cron/validation-rerun.js, forecasts are
-- ISSUE-TIME-LOCKED (INSERT-only — a prediction is never edited after
-- the fact), and truth comes from the observed L1 speed rise in
-- solar_wind_samples with a data-coverage guard (no data ≠ no stream).
--
-- ADVISOR NOTE (intentional, same as cme_events et al.): RLS is enabled
-- with ZERO policies — these tables are service-role-only (written by
-- the cron, read by /api/cme/skill through the service key). Adding a
-- permissive policy would expose internal ledger data. Do not "fix".
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists public.hss_events (
    id            bigint generated always as identity primary key,
    hole_id       text not null unique,           -- HSS-YYYY-MM-DD-E22
    detected_at   timestamptz not null,
    stony_lon_deg double precision not null,      -- east-positive (stage convention)
    carr_lon_deg  double precision,
    lat_deg       double precision,
    source        text not null default 'hek-spoca',
    created_at    timestamptz not null default now()
);
alter table public.hss_events enable row level security;

create table if not exists public.hss_arrival_forecasts (
    id                bigint generated always as identity primary key,
    hole_id           text not null,
    model_id          text not null,              -- 'corotation-v1'
    issued_at         timestamptz not null default now(),
    predicted_arrival timestamptz not null,
    window_start      timestamptz not null,
    window_end        timestamptz not null,
    v_kms_assumed     double precision,
    created_at        timestamptz not null default now(),
    unique (hole_id, model_id)                    -- one locked issue per model
);
create index if not exists hss_forecasts_hole
    on public.hss_arrival_forecasts (hole_id);
alter table public.hss_arrival_forecasts enable row level security;

create table if not exists public.hss_l1_observations (
    id           bigint generated always as identity primary key,
    hole_id      text not null unique,
    arrived      boolean not null,
    arrival_at   timestamptz,                     -- first sustained speed rise
    v_before_kms double precision,                -- pre-window baseline (median)
    v_peak_kms   double precision,
    resolved_at  timestamptz not null default now()
);
alter table public.hss_l1_observations enable row level security;

-- Skill rollup, shaped to match cme_model_skill so the ONE scorecard
-- can merge both weathers (hits_12h here means "inside the ±1 d window").
create or replace view public.hss_model_skill as
select f.model_id,
       false as is_hindcast,
       count(*) filter (where o.arrived)                          as n_scored,
       avg(abs(extract(epoch from (o.arrival_at - f.predicted_arrival)) / 3600.0))
           filter (where o.arrived)                               as mae_hours,
       avg(extract(epoch from (o.arrival_at - f.predicted_arrival)) / 3600.0)
           filter (where o.arrived)                               as bias_hours,
       count(*) filter (where o.arrived
           and o.arrival_at between f.window_start and f.window_end) as hits_12h,
       count(*) filter (where not o.arrived)                      as false_alarms,
       0                                                          as misses
from public.hss_arrival_forecasts f
join public.hss_l1_observations o using (hole_id)
group by f.model_id;

-- 15-min L1 speed medians for truth resolution (mirrors
-- validation_pdyn_series). SECURITY DEFINER, service-role-only.
create or replace function public.validation_speed_series(p_days int default 16)
returns table (bucket timestamptz, speed_med double precision)
language sql
security definer
set search_path = public, pg_temp
as $$
    select date_trunc('hour', observed_at)
             + floor(extract(minute from observed_at) / 15) * interval '15 min' as bucket,
           percentile_cont(0.5) within group (order by speed_km_s) as speed_med
    from public.solar_wind_samples
    where observed_at > now() - make_interval(days => p_days)
      and speed_km_s is not null
    group by 1
    order by 1
$$;
revoke execute on function public.validation_speed_series(int) from anon, authenticated;
