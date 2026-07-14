# Hindcast Database Standard — frozen config, scorecard, naming (v1)

> The "database" claim requires methodological consistency: every event is
> run with the same model configuration, scored with the same scorecard, and
> stored under the same naming convention. This document freezes all three.
> Version tag: **`hc-std-v1`** (2026-07-13). Any deviation from §2 on a real
> run must be listed in that run's results write-up and in the scorecard
> JSON's `config_deviations` field — an undocumented deviation invalidates
> the cross-event comparison.
>
> Peer docs: `HINDCAST_BACKLOG.md` (what to run, in what order, with pre-run
> predictions) and the per-event runbooks
> (`HINDCAST_STPATRICK_2015_RUNBOOK.md`, `MHD_DENSITY_PHASE0_RUNBOOK.md`,
> `MHD_DENSITY_PHASE0_GANNON_RUNBOOK.md`).

---

## 1. Event roster

| # | Runner key (`hindcast_runner --event`) | Window (UTC) | Class | Role |
|---|---|---|---|---|
| 0 | `may_2024_gannon` | 2024-05-10T12 → 05-13T12 (72 h) | G5 | Baseline reference — both runs complete |
| 1 | `st_patrick_mar_2015` | 2015-03-16T12 → 03-19T12 (72 h) | G4 | Community benchmark |
| 2 | `feb_2022_starlink` | 2022-02-03T00 → 02-05T00 (48 h)¹ | G1–G3 | B2G / drag anchor — coupled run complete |
| 3 | `september_2017` | 2017-09-06T12 → 09-09T12 (72 h) | G4 | Government relevance (Irma HF story) |

¹ Feb 2022 ran at 48 h before this standard froze the 72 h default; the run
is grandfathered. If it is ever rerun, widen to
`2022-02-01T12 → 2022-02-04T12` to capture both CMEs (backlog Event-2 task).

**Window rule for new events:** 72 h, opening ≥ 12 h before the first shock
arrival (the model needs quiet driven time after the relaxation ladder before
the storm hits), closing ≥ 24 h into recovery.

## 2. Frozen run configuration (`hc-std-v1`)

Two variants per event, both **required** for a database row — their
difference is the ring-current attribution, which is itself a headline
result:

| Variant tag | Components | Template | Generate with |
|---|---|---|---|
| `gm_ie` | GM (BATS-R-US) + IE (Ridley_serial) | `swmf/config/PARAM.in.GM_IE` | `gen_param gm_ie --no-im …` |
| `gm_ie_im` | GM + IE + IM (RCM2) | `swmf/config/PARAM.in.GM_IE_IM` | `gen_param gm_ie …` (IM on by default) |

Fixed parameters (already encoded in the two templates — listed here so a
change to the templates is recognizable as a standard-version bump, not a
tweak):

* **Software:** SWMF revision `5f7194214`, image `parkerphysics/swmf:gm-ie-im`
  (the image that ran Gannon run 2 and Feb 2022 run 1).
* **Grid:** domain −224 ≤ x ≤ 32 R_E, |y|, |z| ≤ 64 R_E; base resolution
  1.0 R_E, refined to 0.5 R_E inside r = 12 and 0.25 R_E inside r = 6;
  `rCurrents = 3.5 R_E`.
* **Solver:** Rusanov flux; three-session cold-start ladder
  (1st-order steady 700 iters → 2nd-order mc3 β=1.2 steady 1500 iters →
  time-accurate); **Boris correction ON from session 1**,
  `BorisClightFactor 0.02`; `CflExpl 0.6` in all sessions;
  `#MINIMUMPRESSURE` floor; non-conservative inside r = 6.
  The ladder and Boris placement are load-bearing — see the "Solver
  stability" section of `MHD_DENSITY_PHASE0_GANNON_RUNBOOK.md` before
  touching either template.
* **Coupling cadence (time-accurate session):** GM↔IE 5 s; GM↔IM 10 s
  two-way (`TauCoupleIm 20 s`); IE→IM 10 s. IM is OFF during the two
  relaxation sessions.
* **Driver:** OMNI HRO 1-min L1 IMF (`imf_l1.dat` via
  `pipeline/fetch_omni_imf.py`), sentinel-cleaned, gated per the runbook
  data gate (positive density, Bz in tens of nT).
* **F10.7:** GFZ definitive value at the storm-onset day, read from the
  event's `dsmc/fixtures/hindcast/<event>/historical_ap.csv` — passed as
  `gen_param gm_ie --f107 <value>`.
* **MPI ranks:** ≥ 4 with IM (GM gets N−3, IE the last two, IM shares);
  Gannon run 2 used 10 (GM 8 / IE 2 / IM shared) — use the same 10 when the
  host allows, and record the count in the results write-up.
* **Outputs:** GM log `RAW` @ 60 s; IE log @ 60 s (decimated to 5 min by
  `parse_ie_log.py`); IE pattern snapshot every 5 min; restart checkpoint
  every simulated hour.

## 3. Standard scorecard

Every event × variant gets the same six metrics. Computed by
`swmf/pipeline/scorecard.py` (stdlib-only; see `--help`), which writes the
JSON in §4 and prints a markdown row for the table below.

| Metric | Definition | Convention |
|---|---|---|
| `density_r` | Max Pearson r between model and observed density over lags in ±60 min | report r and the lag (min) at max; model series interpolated onto a 1-min grid over the overlap |
| `velocity_r` | Same, for bulk speed | same |
| `dst_depth_ratio` | `min(model Dst) / min(obs SYM-H)` over the window | 1.0 = perfect depth; the GM+IE-only deficit is expected and reported, not hidden |
| `dst_timing_error_min` | `t(model Dst min) − t(obs SYM-H min)` in minutes | negative = model bottoms early |
| `cpcp_bias_pct` | `100 · mean(model Φ_PC − ref) / mean(ref)` over the overlap; if no reference series, report model peak only | reference = PC-index-derived or AMIE, staged per event |
| *highlight* | One event-specific metric | defined in `HINDCAST_BACKLOG.md` per event (e.g. two-step timing for 2015; 210-km density enhancement for 2022; shock-arrival ± min and GEO-crossing yes/no for 2017) |

Observation sources (standard): SYM-H and AE from OMNI HRO 1-min via the
`import_ground_mag.py` canonical fixture (`h_comp_mean_nt` carries SYM-H);
official Dst from Kyoto WDC for the side-by-side figure; density/velocity
truth from the OMNI L1 series itself (propagated) or a virtual-satellite
extraction, per event runbook.

### 3.1 Model-Dst source — RESOLVED 2026-07-14 (option 1)

Both templates now carry a session-3 `#GEOMAGINDICES` block (180-min Kp
window, 60 s output — the SWPC v2 recipe). GM writes
`GM/IO2/geoindex_e<stamp>.log` with Kp and the Biot–Savart Dst;
`swmf/pipeline/parse_geoindex_log.py` extracts it to the canonical CSV:

```sh
python3 -m pipeline.parse_geoindex_log --run-dir <RUN_DIR> \
  --start <window-start> --end <window-end> \
  --out ../data/hindcast/<event>_model_dst.csv     # → t,dst_nt,kp @ 5 min
# then: scorecard.py … --model-dst ../data/hindcast/<event>_model_dst.csv
```

**This is output-only — the solution is untouched, so `hc-std-v1` is
retained** (the version guard exists to protect physics comparability, and
the physics is identical). Runs that predate the block (Gannon runs 1–2,
Feb 2022 run 1, St. Patrick's gm_ie run 1) have no geoindex log; their
model Dst still comes from workstation Biot–Savart post-processing (the
Gannon −13 nT path) or stays unscored. First run to get it natively: the
St. Patrick's `gm_ie_im` run 2.

**CPCP reference (the `cpcp_bias_pct` input) is also now one command** —
the PC(N) index ships inside the same OMNI monthly ASCII staged on Day 1
(column 45), converted via Ridley & Kihn (2004):

```sh
cd dsmc && python3 -m pipeline.import_pc_index \
  --in ../swmf/raw/omni/<omni_monthly>.asc \
  --out fixtures/hindcast/<event_id>/cpcp_reference.csv \
  --start <window-start> --end <window-end> -v
# then: scorecard.py … --obs-cpcp ../dsmc/fixtures/hindcast/<event_id>/cpcp_reference.csv
```

Mind the tool's documented caveats (±10–20% inherent uncertainty; linear
extrapolation overstates the reference above PC ≈ 10 where CPCP saturates —
re-examine before leaning on it for a G5).

### 3.2 Scorecard table (running)

| Event | Variant | density_r (lag) | velocity_r (lag) | dst_depth_ratio | dst_timing_err | cpcp | highlight |
|---|---|---|---|---|---|---|---|
| may_2024_gannon | gm_ie | **0.96** (20 min) | — | **0.025** (−13 / −518 nT) | — | peak 302 kV (5-min) | Ap* 524 vs Ap pinned 400 |
| may_2024_gannon | gm_ie_im | — | — | TBD (extract model Dst) | TBD | peak 307.3 kV | relaxation-model gate PASS +48% |
| st_patrick_mar_2015 | gm_ie | — | — | TBD (model Dst pending §3.1; obs −234 nT) | TBD | peak **148.3 kV** (5-min) | two-step: 2/2 driving episodes in Φ_PC (107 kV sheath / 42 kV lull / 148 kV MC) |
| st_patrick_mar_2015 | gm_ie_im | | | | | | |
| feb_2022_starlink | gm_ie_im | — | — | TBD | TBD | peak 70.6 kV | drag-force delta TBD |
| september_2017 | gm_ie | | | | | | |
| september_2017 | gm_ie_im | | | | | | |

(Gannon gm_ie density_r/dst values are the workstation-derived baseline
reference from the backlog; blank = run not yet done, — = not derived for
that run, TBD = run done, extraction pending.)

## 4. Storage & naming convention

### 4.1 Canonical event ids

New events use **one id everywhere** — runner key, both fixture dirs, output
filenames: `st_patrick_mar_2015`, `september_2017`.

Legacy split (load-bearing, do **not** unify — see `gen_param.py` inline
note and CLAUDE.md §5): runner key `may_2024_gannon` ↔ fixture dirs / bundle
`gannon_may_2024`. `feb_2022_starlink` is already consistent.

### 4.2 Locations

| What | Where | Committed? |
|---|---|---|
| Raw upstream pulls (OMNI monthly, GFZ, TU Delft, CDF) | `swmf/raw/`, `dsmc/raw/` | no (vercelignored; workstation-local) |
| SWMF driver + dry-run fixtures | `swmf/fixtures/hindcast/<event_id>/` (`imf_l1.dat`, optional `mhd_output.json`, `README.md` stating provenance) | yes |
| Index / truth fixtures | `dsmc/fixtures/hindcast/<event_id>/` (`historical_ap.csv`, `ground_mag.csv`, `*_density.csv`) | yes |
| Run directories (workstation) | `$RUNS_DIR/<variant>_<event_id>_<YYYYMMDDTHHMMSS>/` — the existing `gen_param` convention, now frozen | no |
| Hindcast timeseries (Φ_PC/HPI/Ap*) | `data/hindcast/<runner_key>_hindcast.json` = the **current best** run (what fitters and pages consume); per-variant archive copied to `data/hindcast/<runner_key>_hindcast.<variant>.json` before a new run overwrites it | yes |
| Pseudo-Ap fits | `data/hindcast/<runner_key>_pseudo_ap_fit*.json` | yes |
| Scorecards | `data/hindcast/<runner_key>_scorecard_<variant>.json` (one per event × variant, overwritten on re-run of the same variant) | yes |

### 4.3 Scorecard JSON schema

```json
{
  "schema": "pp.hindcast.scorecard.v1",
  "event_id": "st_patrick_mar_2015",
  "variant": "gm_ie",
  "config_version": "hc-std-v1",
  "config_deviations": [],
  "generated_utc": "…",
  "metrics": {
    "density":  {"r": 0.96, "lag_min": 20, "n": 4210},
    "velocity": {"r": null, "lag_min": null, "n": 0},
    "dst":      {"model_min_nt": -13.0, "obs_min_nt": -518.0,
                 "depth_ratio": 0.025, "timing_error_min": null},
    "cpcp":     {"model_peak_kv": 302.0, "obs_peak_kv": null,
                 "bias_pct": null},
    "highlight": {"label": "…", "value": "…"}
  },
  "inputs": { "<flag>": {"path": "…", "rows": 123} }
}
```

`null` means "input not provided", never "zero". The tool refuses to
overwrite a scorecard from a *different* `config_version` without
`--force` — that's the methodological-consistency guard.

## 5. Per-event workflow (checklist)

1. Stage fixtures (`historical_ap.csv` via `fetch_indices_offline`/GFZ,
   `imf_l1.dat` via `fetch_omni_imf` on a workstation, ground-mag via
   `import_ground_mag`). Data gate per the Gannon runbook.
2. Record pre-run predictions in `HINDCAST_BACKLOG.md` **before** the first
   run — the prediction ledger is part of the credibility story.
3. `gm_ie` baseline run (`--no-im`) → `hindcast_runner` → archive JSON →
   `scorecard.py` → fill §3.2 row.
4. `gm_ie_im` coupled run → same chain.
5. Results write-up appended to `MHD_DENSITY_PHASE0_RESULTS.md` (one section
   per event × run, same shape as the Gannon sections).
6. Tick the backlog; update the §3.2 table in place.
