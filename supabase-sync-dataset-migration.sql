-- supabase-sync-dataset-migration.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- The SYNCHRONIZED solar-wind ↔ geomagnetic minute dataset.
--
-- One row per UTC minute: L1 plasma/IMF alongside Kp, ap, Dst and the GOES
-- ≥2 MeV electron flux — every signal carrying its own native timestamp,
-- source tag, and an explicit flag ('ok' | 'held' | 'gap'; solar wind adds
-- 'mag_only'). Absence is recorded, never implied: a minute with no data is
-- still a row, flagged 'gap'. Flag/hold semantics live in ONE place —
-- api/_lib/sync-dataset-core.js (node-tested) — and the writer is
-- api/cron/sync-dataset.js (every 10 min, vercel.json crons).
--
-- RLS pattern: enabled with ZERO policies — service-role-only, written by
-- the cron, read through /api/ring-current/dataset. Same intentional shape
-- as solar_wind_samples / forecast_log / cme_* (CLAUDE.md §4.2): the
-- advisor's "RLS enabled, no policies" flag on this table is expected.
--
-- Growth: ~1 440 rows/day ≈ 0.3 MB/day. trim_sw_geomag_dataset() keeps a
-- 180-day ring (~55 MB) — called daily by the cron; deeper history stays in
-- omni_hourly (hourly, unbounded).

create table if not exists public.sw_geomag_dataset (
    t             timestamptz primary key,      -- the UTC minute

    -- L1 upstream (native 1-min: NOAA RTSW / geospace-propagated)
    sw_v_km_s     real,
    sw_n_cc       real,
    sw_temp_k     real,
    sw_bt_nt      real,
    sw_bz_nt      real,
    sw_bx_nt      real,
    sw_by_nt      real,
    sw_source     text,
    sw_flag       text not null default 'gap'
                  check (sw_flag in ('ok', 'mag_only', 'gap')),

    -- Estimated planetary Kp (native 1-min product)
    kp            real,
    kp_t          timestamptz,
    kp_source     text,
    kp_flag       text not null default 'gap'
                  check (kp_flag in ('ok', 'held', 'gap')),

    -- ap — DERIVED from the definitive 3-h planetary Kp via the standard
    -- Kp→ap table (js/ring-current-model.js kpToAp). ap_source says so.
    ap            real,
    ap_t          timestamptz,
    ap_source     text,
    ap_flag       text not null default 'gap'
                  check (ap_flag in ('ok', 'held', 'gap')),

    -- Kyoto quicklook Dst (native hourly)
    dst_nt        real,
    dst_t         timestamptz,
    dst_source    text,
    dst_flag      text not null default 'gap'
                  check (dst_flag in ('ok', 'held', 'gap')),

    -- GOES-primary integral electron flux ≥2 MeV (native 5-min), pfu
    e2_flux_pfu   real,
    e2_t          timestamptz,
    e2_source     text,
    e2_flag       text not null default 'gap'
                  check (e2_flag in ('ok', 'held', 'gap')),

    synced_at     timestamptz not null default now()
);

comment on table public.sw_geomag_dataset is
    'Synchronized solar-wind/geomagnetic dataset: one row per UTC minute — '
    'L1 plasma+IMF alongside Kp, ap (derived, labeled), Kyoto Dst and GOES '
    '≥2 MeV electron flux, each with native timestamp, source and explicit '
    'ok/held/gap flag (sw adds mag_only). Gap minutes ARE rows. Written by '
    '/api/cron/sync-dataset (10-min cadence, 3-h self-healing window, daily '
    '24-h deep pass); read via /api/ring-current/dataset. Service-role-only: '
    'RLS-no-policy is intentional (CLAUDE.md §4.2). 180-day ring via '
    'trim_sw_geomag_dataset().';

comment on column public.sw_geomag_dataset.ap_source is
    'Always a derivation label (kpToAp over the 3-h planetary Kp) — ap is '
    'never presented as a direct measurement.';

-- Time-range scans are the only access pattern; the PK index covers them.

alter table public.sw_geomag_dataset enable row level security;

-- 180-day ring buffer (parameterized for operator override).
create or replace function public.trim_sw_geomag_dataset(p_keep_days int default 180)
returns bigint
language sql
security definer
set search_path = public, pg_temp
as $$
    with gone as (
        delete from public.sw_geomag_dataset
        where t < now() - make_interval(days => greatest(7, p_keep_days))
        returning 1
    )
    select count(*) from gone;
$$;

-- Not part of the anonymous-telemetry surface (CLAUDE.md §8): service-role
-- and cron only.
revoke execute on function public.trim_sw_geomag_dataset(int) from public;
revoke execute on function public.trim_sw_geomag_dataset(int) from anon;
revoke execute on function public.trim_sw_geomag_dataset(int) from authenticated;
