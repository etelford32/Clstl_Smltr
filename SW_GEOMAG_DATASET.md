# The Synchronized Solar-Wind ↔ Geomagnetic Dataset

`public.sw_geomag_dataset` — **one row per UTC minute**: L1 upstream
measurements alongside Kp, ap, Dst and the GOES ≥2 MeV electron flux, with
explicit per-signal provenance and gap flags. The archival substrate for
model training, validation and the B2G data product: a consumer can take
any minute and know exactly what was measured, what was carried, what was
derived, and what was missing.

## Design rules

1. **Absence is recorded, never implied.** A minute with no data is still a
   row, flagged `gap`. Consumers never have to infer outages from missing
   keys.
2. **Every value travels with its provenance.** Each signal carries `*_t`
   (native sample time), `*_source` (feed identity), `*_flag`. The hold
   distance of any carried value is `t − *_t` — computable, not hidden.
3. **Derived ≠ measured.** ap comes from `kpToAp()` over the definitive 3-h
   planetary Kp; its source string says `derived: kpToAp(…)`. Nothing
   derived is ever dressed as a measurement.
4. **One implementation of the semantics.** Parsers, flag policy, and CSV
   shape live in `api/_lib/sync-dataset-core.js`, node-tested by
   `tests/sync-dataset-core.mjs`. The writer cron and the read endpoint both
   import it — writer and reader cannot drift.

## Columns (per signal: value · `*_t` · `*_source` · `*_flag`)

| Signal | Columns | Native cadence | fresh → `ok` | hold → `held` | beyond → `gap` |
|---|---|---|---|---|---|
| L1 plasma/IMF | `sw_v_km_s, sw_n_cc, sw_temp_k, sw_bt_nt, sw_bz_nt, sw_bx_nt, sw_by_nt` | 1 min (RTSW) | per-minute presence | — | — |
| Kp (estimated) | `kp` | 1 min | ≤ 5 min | ≤ 180 min | null |
| ap (derived) | `ap` | 3 h blocks | ≤ 180 min | ≤ 300 min | null |
| Dst (Kyoto quicklook) | `dst_nt` | 1 h | ≤ 60 min | ≤ 360 min | null |
| e⁻ ≥2 MeV (GOES) | `e2_flux_pfu` | 5 min | ≤ 10 min | ≤ 60 min | null |

`sw_flag` is `ok` (plasma present) / `mag_only` (IMF kept through plasma
outages — Bz is the ring-current driver we must not lose) / `gap`.

## Writer — `/api/cron/sync-dataset` (every 10 min, vercel.json)

- Rebuilds the trailing **3 h** idempotently (PK upsert) — missed ticks
  ≤3 h self-heal. First run of each UTC day (or `?deep=1`) rebuilds **24 h**
  and rings the archive (`trim_sw_geomag_dataset()`, 180-day retention;
  ~0.3 MB/day, ≈55 MB steady state; deeper history stays in `omni_hourly`).
- Individual feed failures degrade to gap flags — that IS the honesty
  mechanism, not an error. Only all-feeds-down or a write failure marks the
  `sync_dataset` heartbeat failed (`pipeline_heartbeat` → pipeline-watchdog).
- Also archives native-cadence ≥2 MeV rows into `geomag_indices`
  (`kind='e2_mev'`) — NOAA's rolling 1-day file forgets; the archive doesn't.
- `?dry=1` computes and reports without writing.

## Reader — `/api/ring-current/dataset`

`?hours=6` (default) or `?start=ISO&end=ISO`, `&format=csv` for downloads.
Span cap 7 days/request. JSON responses carry the flag legend, source map,
and a per-signal gap summary; CSV carries the same per-row provenance
columns. CDN cache 5 min.

## Security posture

RLS enabled, zero policies — service-role-only, same intentional pattern as
`solar_wind_samples` / `forecast_log` (CLAUDE.md §4.2). The advisor flag on
this table is expected. `trim_sw_geomag_dataset()` is SECURITY DEFINER with
pinned `search_path`, EXECUTE revoked from `anon`/`authenticated` (not part
of the anonymous-telemetry surface).

## Provenance of the archive itself

- **2026-07-12** — table created (`supabase-sync-dataset-migration.sql`) and
  seeded with the trailing 6 h built from the production archives
  (`solar_wind_samples` + `geomag_indices`) under the same flag policy:
  360 minutes, sw 342 ok / 18 gap (real L1 outage minutes), kp 144 ok /
  216 held (the pre-existing 15-min Kp sampling shows as honest holds),
  dst 360 ok, ap/e2 all gap (no archived source before the cron ships).
  From the first cron run onward, rows are written exclusively through
  `sync-dataset-core.js`, and kp/ap/e2 coverage fills in.
