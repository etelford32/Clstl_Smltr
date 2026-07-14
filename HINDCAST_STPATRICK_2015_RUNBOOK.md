# Hindcast runbook — St. Patrick's Day storm, 17 Mar 2015 (G4)

Event 1 of the hindcast database (`HINDCAST_BACKLOG.md`). Peer of
`MHD_DENSITY_PHASE0_GANNON_RUNBOOK.md` — same overall shape (pull inputs,
replay BATS-R-US, score), same frozen configuration
(`HINDCAST_DATABASE_STANDARD.md`, `hc-std-v1`). Canonical event id
everywhere: **`st_patrick_mar_2015`** (runner key, both fixture dirs,
output filenames).

**Why this event:** it is the community benchmark — the most-modeled storm
in the magnetosphere literature, with published SWMF/BATS-R-US, LFM and
OpenGGCM results to compare against. A credible Gannon result plus a
credible St. Patrick's result is what turns "one good run" into "a
validation database". Unlike the density-first Phase-0 events, the headline
deliverables here are **magnetospheric**: SYM-H/Dst reconstruction, the
two-step main phase, and CPCP bias.

## Storm anatomy (what the model has to reproduce)

* CME launch 2015-03-15 ~01:48 UT (AR 12297, C9.1 long-duration flare,
  partial-halo CME).
* **SSC at Earth 2015-03-17 ~04:45 UT** — sheath arrival.
* **Two-step main phase** (the event's signature): first SYM-H
  intensification during the sheath (morning of Mar 17, dip near −100 nT),
  a partial recovery around midday, then the deeper main phase as the
  magnetic-cloud core field turns strongly southward (Bz ≈ −25 to −30 nT
  sustained for hours).
* **SYM-H minimum ≈ −234 nT near 22:47 UT on Mar 17** (Kyoto final hourly
  Dst min ≈ −222 nT).
* Long recovery through Mar 18–19.
* March equinox: dipole tilt ≈ 0, near-maximal Russell–McPherron coupling.
  No config change needed — `#STARTTIME` carries the geometry — but it is
  part of why this storm couples so efficiently and why the modeling
  community standardized on it.

## Window and run parameters

| Parameter | Value | Why |
|---|---|---|
| Window | `2015-03-16T12:00Z → 2015-03-19T12:00Z` (72 h) | standard window rule: opens 16 h+ before the SSC, closes 37 h after SYM-H min |
| F10.7 | **114.3 sfu** | GFZ definitive at storm onset (Mar 17), from the staged `historical_ap.csv` (window range 113.6–117.2) |
| Peak 3-h ap in window | 179 (Mar 17 12–24 UT) | context: strong but far from Gannon's pinned 400 — no Ap-saturation story here, which is exactly why it's a clean benchmark |
| Variants | `gm_ie` baseline first, then `gm_ie_im` | the baseline repeats the Gannon GM+IE config exactly — controlled comparison |

## Pre-run predictions (frozen — recorded before any run)

From `HINDCAST_BACKLOG.md` Event 1; restated here so the run can't quietly
move the goalposts:

1. **GM+IE only:** Dst floor −30 to −60 nT (same fractional ring-current
   deficit as Gannon's −13/−518).
2. **GM+IE+IM (RCM2):** −170 to −220 nT, i.e. 75–90% of observed depth,
   consistent with published SWMF+RCM runs of this event.
3. **Density/velocity correlation ≥ 0.9** at L1-propagated lag (upstream
   data clean: Wind + ACE both healthy in this era).
4. **CPCP peak overpredicted 20–40%** vs PC-index/AMIE estimates (known
   BATS-R-US bias — we quantify ours instead of hiding it).

## Datasets, lands at

| What | Source | Lands at | Cadence |
|---|---|---|---|
| L1 IMF (OMNI HRO 1-min) | SPDF `omni_min201503.asc` | `swmf/fixtures/hindcast/st_patrick_mar_2015/imf_l1.dat` | 1 min |
| Ap definitive + F10.7 | GFZ | `dsmc/fixtures/hindcast/st_patrick_mar_2015/historical_ap.csv` — **already staged** (2015-03-15 → 03-21) | 3 h |
| Ground-mag (AE/AU/AL + SYM-H) | OMNI HRO 1-min (INTERMAGNET-derived) | `dsmc/fixtures/hindcast/st_patrick_mar_2015/ground_mag.csv` | 1 min |
| Kyoto official Dst (final) | WDC Kyoto | `dsmc/fixtures/hindcast/st_patrick_mar_2015/kyoto_dst.csv` (`t,dst_nt`) | 1 h |
| Wind + ACE L2 (gap cross-check) | SPDF | workstation-local `swmf/raw/` — not committed | 1 min |
| BATS-R-US output (Φ_PC, HPI) | this run | `data/hindcast/st_patrick_mar_2015_hindcast.json` (+ per-variant archive copy) | 5 min |
| Model Dst | `#GEOMAGINDICES` geoindex log → `parse_geoindex_log.py` (run 2+; run 1 predates the block → post-processing fallback) | `data/hindcast/st_patrick_mar_2015_model_dst.csv` (`t,dst_nt,kp`) | ≤ 5 min |
| CPCP reference (PC-index-derived) | PC(N) col 45 of the Day-1 OMNI monthly ASCII → `import_pc_index.py` (Ridley & Kihn 2004) | `dsmc/fixtures/hindcast/st_patrick_mar_2015/cpcp_reference.csv` (`t,phi_pc_kv,pc_n`) | 5 min |
| Scorecards | `pipeline/scorecard.py` | `data/hindcast/st_patrick_mar_2015_scorecard_{gm_ie,gm_ie_im}.json` | — |

## Day 1 — pull / verify inputs (workstation path)

SPDF/GFZ remain **403-blocked from the remote sandbox** (re-confirmed
2026-07-13 via the egress proxy — same uniform policy filter documented in
the Gannon runbook). Pull from a workstation:

```sh
# 1) OMNI 1-min — one monthly file covers the whole window
curl -fSL --create-dirs -o swmf/raw/omni/omni_min201503.asc \
  'https://spdf.gsfc.nasa.gov/pub/data/omni/high_res_omni/monthly_1min/omni_min201503.asc'

# 2) SWMF driver file
cd swmf && python3 -m pipeline.fetch_omni_imf \
  --start 2015-03-16 --end 2015-03-19 \
  --out fixtures/hindcast/st_patrick_mar_2015/imf_l1.dat

# 3) Ground-mag fixture — AE/SYM-H from the same OMNI monthly file,
#    canonicalised exactly as done for Gannon (AE↦sme, AU↦smu, AL↦sml,
#    SYM-H↦h_comp_mean; knipp Joule proxy):
cd dsmc && python3 -m pipeline.import_ground_mag \
  --in raw/omni/st_patrick_mar_2015.csv \
  --out fixtures/hindcast/st_patrick_mar_2015/ground_mag.csv \
  --start 2015-03-16T12:00:00Z --end 2015-03-19T12:00:00Z -v
```

**Data gate (do not launch without it):**

```sh
grep -c '9999' swmf/fixtures/hindcast/st_patrick_mar_2015/imf_l1.dat   # → 0
head -6 swmf/fixtures/hindcast/st_patrick_mar_2015/imf_l1.dat          # density col 14, Bz col 10
awk '$1 ~ /^[0-9]/{print $14}' …/imf_l1.dat | sort -n | sed -n '1p;$p' # strictly positive, ~1 → 40 /cc
awk '$1 ~ /^[0-9]/{print $10}' …/imf_l1.dat | sort -n | sed -n '1p;$p' # Bz within ± ~35 nT
```

**Watch-outs specific to this event:**

* **Two spacecraft cross-check (backlog task):** OMNI for Mar 2015 splices
  Wind and ACE. Both were healthy, so gaps should be rare — but check the
  spacecraft-ID column around the SSC (04:45 UT Mar 17) and across the
  sheath. If the shock timing in `imf_l1.dat` disagrees with the published
  SSC by more than ~5 min, cross-check against Wind MFI/SWE direct before
  blaming the model.
* **Sanity fingerprints for the fixture:** SSC density jump in the sheath
  (roughly 20–40 /cc), speed step ~400 → 550-600 km/s, MC Bz floor ≈
  −25 to −30 nT late Mar 17. SYM-H min in `ground_mag.csv` must read
  **−234 ± a few nT** — same eyeball check that validated the Gannon
  fixture at −518.
* The staged `historical_ap.csv` peaks at ap 179 — **not** pinned at 400.
  If a fetch refresh shows different values, GFZ definitive has been
  re-issued; note it, don't average.

**Day 1 done when:** `imf_l1.dat` + `ground_mag.csv` + `kyoto_dst.csv`
present, gates pass, fingerprints match.

## Day 2 — the two runs

Same container, same ladder, same solver recipe as Gannon (see the
load-bearing "Solver stability" section of the Gannon runbook — the
cold-start ladder, Boris-from-session-1, and CflExpl ≤ 0.65 rules all apply
verbatim).

```sh
cd swmf
# Baseline — GM+IE only, the controlled comparison against Gannon run 1:
python3 -m pipeline.gen_param gm_ie --no-im \
  --start 2015-03-16T12:00:00 --hours 72 \
  --event st_patrick_mar_2015 --f107 114.3 --nproc 4 --imf imf_l1.dat
python3 -m pipeline.run_forecast --launch-run-dir <RUN_DIR> \
  --nproc 4 --timeout-hours 24

# Coupled — GM+IE+IM(RCM2), same image that ran Gannon run 2:
python3 -m pipeline.gen_param gm_ie \
  --start 2015-03-16T12:00:00 --hours 72 \
  --event st_patrick_mar_2015 --f107 114.3 --nproc 10 --imf imf_l1.dat
python3 -m pipeline.run_forecast --launch-run-dir <RUN_DIR> \
  --nproc 10 --timeout-hours 24
```

(`swmf/run-gannon-hindcast.sh` chains these steps but is Gannon-specific;
run the steps individually, or generalize the script — optional, not
blocking.)

Extract Φ_PC/HPI after each run — for this event the runner key and the
run-dir label are the **same string**, no reversal trap:

```sh
python3 -m pipeline.hindcast_runner --event st_patrick_mar_2015 \
  --run-dir <RUN_DIR> --out ../data/hindcast -v
# archive per-variant before the next run overwrites (standard §4.2):
cp ../data/hindcast/st_patrick_mar_2015_hindcast.json \
   ../data/hindcast/st_patrick_mar_2015_hindcast.gm_ie.json
```

**Model Dst (standard §3.1 — resolved 2026-07-14):** both PARAM templates
now carry a session-3 `#GEOMAGINDICES` block, so any run generated from them
(the coupled run 2 onward) writes `GM/IO2/geoindex_e*.log`. Extract after
the run:

```sh
python3 -m pipeline.parse_geoindex_log --run-dir <RUN_DIR> \
  --start 2015-03-16T12:00:00Z --end 2015-03-19T12:00:00Z \
  --out ../data/hindcast/st_patrick_mar_2015_model_dst.csv
```

Note the gm_ie run 1 (2026-07-13) predates the block — its PARAM had no
geoindex output, so scoring P1 (the GM+IE Dst-floor prediction) still needs
the workstation Biot–Savart post-processing fallback, or stays unscored.
Run 2 gets the headline Dst deliverable natively.

## Day 3 — score

```sh
cd swmf
python3 -m pipeline.scorecard --event st_patrick_mar_2015 --variant gm_ie \
  --hindcast ../data/hindcast/st_patrick_mar_2015_hindcast.gm_ie.json \
  --model-dst ../data/hindcast/st_patrick_mar_2015_model_dst.csv \
  --obs-symh ../dsmc/fixtures/hindcast/st_patrick_mar_2015/ground_mag.csv:h_comp_mean_nt \
  --model-density <model_density.csv> --obs-density <obs_density.csv> \
  --model-velocity <model_velocity.csv> --obs-velocity <obs_velocity.csv> \
  --highlight "two-step main phase=<see below>" \
  --out ../data/hindcast -v
# then the same with --variant gm_ie_im against the coupled outputs
```

The density/velocity series pair is the same construction used for the
Gannon r = 0.96 baseline (workstation post-processing exports the aligned
model and observed CSVs; `scorecard.py` finds max Pearson r over ±60 min
lags and reports the lag).

**Event-specific highlight metric — two-step main phase.** Report three
booleans + two timing errors, condensed into the highlight string:

1. first intensification present (model SYM-H/Dst dips during the sheath
   interval, before ~12 UT Mar 17)?
2. partial recovery between the steps present?
3. second, deeper minimum present, and Δt vs the observed 22:47 UT
   minimum? (The scorecard's `dst_timing_error_min` captures the global
   minimum; the first-step Δt is read off the trace manually.)

Example: `--highlight "two-step main phase=2/2 steps, Δt1 +25 min, Δt2 −40 min"`.

**CPCP:** the reference series is now one workstation command — the PC(N)
index rides in the same OMNI monthly ASCII pulled on Day 1 (column 45):

```sh
cd dsmc && python3 -m pipeline.import_pc_index \
  --in ../swmf/raw/omni/omni_min201503.asc \
  --out fixtures/hindcast/st_patrick_mar_2015/cpcp_reference.csv \
  --start 2015-03-16T12:00:00Z --end 2015-03-19T12:00:00Z -v
```

Commit the fixture, then add
`--obs-cpcp ../dsmc/fixtures/hindcast/st_patrick_mar_2015/cpcp_reference.csv`
to the scorecard call — `cpcp_bias_pct` fills in and P4 gets its number.
Mind the conversion's documented caveats (±10–20% inherent; saturates
above PC ≈ 10); the published-values comparison below remains the
second, independent check.

Update the §3.2 scorecard table in `HINDCAST_DATABASE_STANDARD.md` with the
printed markdown rows, append a results section to
`MHD_DENSITY_PHASE0_RESULTS.md`, and tick `HINDCAST_BACKLOG.md`.

## Published model traces for the comparison figure (backlog task)

Target 3–4 traces alongside ours + Kyoto. Candidate sources, to verify at
pull time:

* CCMC runs-on-request archive for 2015-03-17 — SWMF/BATS-R-US(+RCM), LFM,
  and OpenGGCM entries exist for this storm; the CCMC interface exports Dst
  and CPCP time series per run.
* The 2015-03-17 community modeling-challenge literature (e.g. the
  Liemohn-led model-evaluation papers and the storm-specific SWMF+RCM
  studies) for published Dst/SYM-H traces and CPCP peaks — digitize from
  figures where no machine-readable series is published, and mark digitized
  traces as such in the figure caption.

Record every trace's provenance next to the figure data — this figure is
the credibility asset and will be scrutinized.

## What's different from Gannon (summary)

| Aspect | Gannon May 2024 | St. Patrick's Mar 2015 |
|---|---|---|
| Headline | Ap ceiling exposed; density skill | community benchmark; Dst/CPCP fidelity |
| Ap behaviour | pinned at 400 for ~24 h | peaks at 179 — no saturation story |
| Truth emphasis | GRACE-FO/Swarm density | SYM-H/Kyoto Dst + published model traces |
| F10.7 | 223–227 | 114.3 |
| L1 monitors | multi-CME compression, sentinel bleed | Wind + ACE clean; single CME |
| New metric | — | two-step main-phase timing |

## Concrete next step

Day-1 workstation pull (`omni_min201503.asc` → the three fixtures), then the
GM+IE baseline run. Everything downstream of the fixtures is already wired:
registry entry, scorecard tool, and this runbook shipped 2026-07-13.
