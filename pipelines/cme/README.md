# pipelines/cme — CME forecasting/validation offline pipeline

Offline, auditable tooling for the CME hindcast validation program.
Design + phasing: `CME_FORECAST_VALIDATION_PLAN.md` (repo root).

This directory is the **offline half** of the loop. The **live half** already
exists and should not be duplicated here:

- `api/cron/validation-rerun.js` — daily CME arrival scoring → `validation_runs(kind='cme')`
- `js/validation-scoring.js` — `detectShockArrivals()` / `scoreCmeArrivals()`
- `js/cme-propagation.js` — drag-based model (Vršnak 2013) used by the dashboard
- `api/donki/cme.js` — DONKI CMEAnalysis + WSA-ENLIL proxy

## Step 0 — truth data pull

```bash
pip install requests pandas lxml
python step0_pull.py --self-test                    # offline; no network
python step0_pull.py --events phase1_hindcast_events.csv --outdir ./step0_out
python step0_pull.py --events phase1_hindcast_events.csv --only PP-HC-2024-0510
```

Pulls DONKI (CME kinematics, GST, IPS), CDAWeb HAPI OMNI (SYM-H, flow speed,
Bz, density, hourly Dst/Kp), and the Richardson–Cane ICME list; reconciles
them against the planning approximations in `phase1_hindcast_events.csv`;
writes a discrepancy report, a verified CSV, and `inserts.sql` targeting the
tables in `supabase-cme-validation-migration.sql`.

Every raw HTTP response is cached under `step0_out/raw/` with a sha256 +
timestamp sidecar, so the pull is reproducible and re-runs are free.

**Human review is part of the pipeline**: shock detections are labeled
`auto — CONFIRM MANUALLY`, and `inserts.sql` is meant to be read before it is
applied. Nothing here writes to Supabase directly.

### Event list conventions (`phase1_hindcast_events.csv`)

- `tier` A = pre-DONKI (2000–2005): DONKI returns nothing; launch kinematics
  must come from the LASCO CDAW catalog (flagged by the script, entered
  manually). OMNI/SYM-H truth still resolves automatically.
- `tier` B = DONKI era (2010+): fully automatic.
- `*_approx` columns are planning values — step0 replaces/flags them from
  primary sources and flips `verified_against_primary` only when the pull
  succeeded AND no discrepancy exceeded tolerance.
- Event IDs are `PP-HC-YYYY-MMDD` keyed on the **geomagnetic response date**,
  not the launch date.

## Outputs are not deployed

`pipelines/` is excluded in `.vercelignore`. Do not commit `step0_out/`
(gitignored) — commit only the verified CSV back into this directory after
review.
