-- ═══════════════════════════════════════════════════════════════════════════
-- supabase-weather-extremes-migration.sql
--
-- Global extreme-weather analysis over the 30-day weather_grid_cache archive.
-- Applied to project aijsboodkivnhzfstvdq on 2026-07-15.
--
-- WHAT THIS ADDS
--   • weather_extremes_cache — small hourly result table (one row per run,
--     last 48 kept). RLS enabled with ZERO policies: service-role-only, the
--     same intentional pattern as weather_grid_cache (CLAUDE.md §4.2 — the
--     advisor flag is a known false positive).
--   • compute_weather_extremes(window_days, decimate) — per-cell percentile
--     analysis (heat / cold / wind / precip) computed ENTIRELY inside
--     Postgres. The 30-day archive is ~120 MB of JSONB; shipping it to a
--     serverless function per request is a non-starter (measured 3.7 s per
--     channel-week just to unnest). In-database the hourly run is ~10-20 s,
--     which pg_cron absorbs without a statement-timeout ceiling.
--   • pg_cron job 'weather-extremes-hourly' at minute 20 (grid refresh runs
--     on the Vercel cron at minute 0; :20 gives it slack). pg_cron is the
--     right scheduler here because the job is pure SQL over in-database
--     data — no external fetch, so the Vercel cron surface (vercel.json)
--     is not involved. Registered alongside the existing prune-* jobs.
--
-- METHOD
--   History = every `decimate`-th hourly frame in the window, EXCLUDING the
--   newest frame (so "exceeds window max" means a genuine 30-day record).
--   Current = the newest frame. A cell is flagged when its current value
--   crosses its own per-cell percentile thresholds:
--     severity 1 ≥ p95   ·   severity 2 ≥ p99   ·   severity 3 > window max
--   (cold uses ≤ p05 / ≤ p01 / < window min).
--   Absolute floors keep the list meaningful to humans (a "p99 heat event"
--   at -20 °C in Antarctica is real climatology but not a heat wave):
--     heat ≥ 25 °C · cold ≤ 0 °C · wind ≥ 15 m/s (~gale) · precip ≥ 2 mm
--   Ranking inside each category is by exceedance beyond the p95/p05 edge.
--
-- Down-migration:
--   select cron.unschedule('weather-extremes-hourly');
--   drop function if exists public.compute_weather_extremes(int, int);
--   drop table if exists public.weather_extremes_cache;
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.weather_extremes_cache (
    id             bigint generated always as identity primary key,
    computed_at    timestamptz not null default now(),
    frame_time     timestamptz not null,
    window_days    int         not null,
    frames_sampled int         not null,
    payload        jsonb       not null
);

create index if not exists weather_extremes_cache_computed_at_idx
    on public.weather_extremes_cache (computed_at desc);

alter table public.weather_extremes_cache enable row level security;

-- Read-only anon SELECT (applied as follow-up migration
-- weather_extremes_public_read on 2026-07-15): this table carries DERIVED,
-- public-facing analysis — the same JSON /api/weather/extremes serves to
-- everyone — unlike the raw pipeline tables (weather_grid_cache et al.)
-- which stay intentionally service-role-only. The policy lets local dev
-- and the endpoint fall back to the publishable key.
create policy weather_extremes_public_read
    on public.weather_extremes_cache
    for select
    to anon, authenticated
    using (true);

create or replace function public.compute_weather_extremes(
    p_window_days int default 30,
    p_decimate    int default 3
) returns void
language plpgsql
set search_path = public, pg_temp
as $$
declare
    v_latest timestamptz;
begin
    select max(fetched_at) into v_latest from weather_grid_cache;
    if v_latest is null then
        return;   -- empty archive; nothing to analyse
    end if;

    with hist_frames as (
        select payload,
               row_number() over (order by fetched_at desc) as rn
        from weather_grid_cache
        where fetched_at > now() - make_interval(days => p_window_days)
          and fetched_at < v_latest
    ),
    sampled as (
        -- Every p_decimate-th frame. Decimation trades sample count for
        -- runtime; hourly frames are strongly autocorrelated so percentiles
        -- barely move (240 samples at decimate=3 over 30 days).
        select payload from hist_frames where rn % p_decimate = 0
    ),
    hist_cells as (
        -- Key cells by (lat, lon), NOT array position: the Open-Meteo and
        -- MET-Norway-fallback writers both emit the same 5° cell centres,
        -- but ordering is an implementation detail we refuse to depend on.
        select round((c->>'latitude')::numeric,  2) as lat,
               round((c->>'longitude')::numeric, 2) as lon,
               (c->'current'->>'temperature_2m')::real as t,
               (c->'current'->>'wind_speed_10m')::real as wind,
               (c->'current'->>'precipitation')::real  as precip
        from sampled s, jsonb_array_elements(s.payload) as c
    ),
    stats as (
        select lat, lon,
               count(t)      as n_t,
               avg(t)        as t_mean,
               percentile_cont(0.01) within group (order by t) as t_p01,
               percentile_cont(0.05) within group (order by t) as t_p05,
               percentile_cont(0.95) within group (order by t) as t_p95,
               percentile_cont(0.99) within group (order by t) as t_p99,
               min(t) as t_min,
               max(t) as t_max,
               percentile_cont(0.95) within group (order by wind) as w_p95,
               percentile_cont(0.99) within group (order by wind) as w_p99,
               max(wind) as w_max,
               percentile_cont(0.95) within group (order by precip) as pr_p95,
               percentile_cont(0.99) within group (order by precip) as pr_p99,
               max(precip) as pr_max
        from hist_cells
        group by lat, lon
    ),
    cur as (
        select round((c->>'latitude')::numeric,  2) as lat,
               round((c->>'longitude')::numeric, 2) as lon,
               (c->'current'->>'temperature_2m')::real as t,
               (c->'current'->>'wind_speed_10m')::real as wind,
               (c->'current'->>'precipitation')::real  as precip
        from weather_grid_cache w, jsonb_array_elements(w.payload) as c
        where w.fetched_at = v_latest
    ),
    joined as (
        select cur.lat, cur.lon, cur.t, cur.wind, cur.precip,
               s.n_t, s.t_mean, s.t_p01, s.t_p05, s.t_p95, s.t_p99,
               s.t_min, s.t_max, s.w_p95, s.w_p99, s.w_max,
               s.pr_p95, s.pr_p99, s.pr_max
        from cur
        join stats s using (lat, lon)
        where s.n_t >= 24        -- need a real distribution behind the claim
    ),
    heat as (
        select coalesce(jsonb_agg(jsonb_build_object(
                   'lat', lat, 'lon', lon,
                   'value', round(t::numeric, 1),
                   'p95',   round(t_p95::numeric, 1),
                   'p99',   round(t_p99::numeric, 1),
                   'wmax',  round(t_max::numeric, 1),
                   'mean',  round(t_mean::numeric, 1),
                   'sev',   case when t > t_max then 3
                                 when t >= t_p99 then 2 else 1 end
               ) order by (t - t_p95) desc), '[]'::jsonb) as j
        from (
            select * from joined
            where t is not null and t >= t_p95 and t >= 25
            order by (t - t_p95) desc limit 20
        ) q
    ),
    cold as (
        select coalesce(jsonb_agg(jsonb_build_object(
                   'lat', lat, 'lon', lon,
                   'value', round(t::numeric, 1),
                   'p05',   round(t_p05::numeric, 1),
                   'p01',   round(t_p01::numeric, 1),
                   'wmin',  round(t_min::numeric, 1),
                   'mean',  round(t_mean::numeric, 1),
                   'sev',   case when t < t_min then 3
                                 when t <= t_p01 then 2 else 1 end
               ) order by (t_p05 - t) desc), '[]'::jsonb) as j
        from (
            select * from joined
            where t is not null and t <= t_p05 and t <= 0
            order by (t_p05 - t) desc limit 20
        ) q
    ),
    wind_x as (
        select coalesce(jsonb_agg(jsonb_build_object(
                   'lat', lat, 'lon', lon,
                   'value', round(wind::numeric, 1),
                   'p95',   round(w_p95::numeric, 1),
                   'p99',   round(w_p99::numeric, 1),
                   'wmax',  round(w_max::numeric, 1),
                   'sev',   case when wind > w_max then 3
                                 when wind >= w_p99 then 2 else 1 end
               ) order by (wind - w_p95) desc), '[]'::jsonb) as j
        from (
            select * from joined
            where wind is not null and wind >= w_p95 and wind >= 15
            order by (wind - w_p95) desc limit 20
        ) q
    ),
    precip_x as (
        select coalesce(jsonb_agg(jsonb_build_object(
                   'lat', lat, 'lon', lon,
                   'value', round(precip::numeric, 2),
                   'p95',   round(pr_p95::numeric, 2),
                   'p99',   round(pr_p99::numeric, 2),
                   'wmax',  round(pr_max::numeric, 2),
                   'sev',   case when precip > pr_max then 3
                                 when precip >= pr_p99 then 2 else 1 end
               ) order by (precip - pr_p95) desc), '[]'::jsonb) as j
        from (
            select * from joined
            where precip is not null and precip >= pr_p95 and precip >= 2
            order by (precip - pr_p95) desc limit 20
        ) q
    ),
    summary as (
        select jsonb_build_object(
            'cells',          count(*),
            'heat_p95_cells', count(*) filter (where t    >= t_p95  and t >= 25),
            'cold_p05_cells', count(*) filter (where t    <= t_p05  and t <= 0),
            'wind_p95_cells', count(*) filter (where wind >= w_p95  and wind >= 15),
            'precip_p95_cells', count(*) filter (where precip >= pr_p95 and precip >= 2),
            'record_cells',   count(*) filter (where t > t_max or t < t_min
                                               or wind > w_max or precip > pr_max)
        ) as j
        from joined
    )
    insert into weather_extremes_cache
        (frame_time, window_days, frames_sampled, payload)
    select v_latest,
           p_window_days,
           (select count(*) from sampled),
           jsonb_build_object(
               'heat',    (select j from heat),
               'cold',    (select j from cold),
               'wind',    (select j from wind_x),
               'precip',  (select j from precip_x),
               'summary', (select j from summary),
               'units',   jsonb_build_object(
                   't', '°C', 'wind', 'm/s', 'precip', 'mm')
           );

    -- Keep 48 runs (~2 days) for debugging/trend; the reader only needs 1.
    delete from weather_extremes_cache
    where id not in (
        select id from weather_extremes_cache
        order by computed_at desc limit 48
    );
end;
$$;

-- NOT part of the anonymous-telemetry surface — cron (postgres role) and
-- service_role only, per the CLAUDE.md §8 SECURITY DEFINER heuristics.
revoke execute on function public.compute_weather_extremes(int, int)
    from public, anon, authenticated;

-- Hourly at :20 — the Vercel grid-refresh cron lands the new frame at :00,
-- typically committed by :01. cron.schedule() upserts by jobname, so
-- re-running this migration is safe.
select cron.schedule(
    'weather-extremes-hourly',
    '20 * * * *',
    $$select public.compute_weather_extremes()$$
);
