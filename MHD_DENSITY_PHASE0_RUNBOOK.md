# Phase 0 runbook — Feb 2022 Starlink hindcast

Branch: `claude/mhd-density-product-planning-8KPQO`

This is the day-by-day script for running the first end-to-end real-data
hindcast on the Feb 2022 Starlink event. The plan in
`MHD_DENSITY_PRODUCT_PLAN.md` is the *why*; this is the *how*. By the
end of day 3 you should have either a green Phase-0 gate or a numeric
reason it failed.

## What you need before day 1

* Repo cloned, on `claude/mhd-density-product-planning-8KPQO`.
* Python 3.11+ for the harness modules. Only the stdlib is required for
  the fetch / fit code; the validator wants `msise00` for real numbers.
* The `dsmc/` and `swmf/` containers built (`docker compose build`)
  *if* you want NRLMSISE-00-grade densities. Without `msise00` the
  validator falls back to an inline exponential — fine for plumbing
  tests, **not** fine for the Phase-0 gate decision.
* SWMF / BATS-R-US compiled in the `swmf/` image. The runner expects
  `BATSRUS.exe` at the path `swmf/Dockerfile` builds it to.
* Outbound HTTPS to `spdf.gsfc.nasa.gov`, `kp.gfz-potsdam.de`,
  `thermosphere.tudelft.nl`.

If any of those is missing, stop here and fix it — the harness is now
the gate, the ops is the limiter.

## The five datasets we need on disk

| What | Source | Lands at | Cadence |
|---|---|---|---|
| L1 IMF (DSCOVR/Wind/ACE merged) | OMNI 1-min HRO | `swmf/fixtures/hindcast/feb_2022_starlink/imf_l1.dat` | 1 min |
| Ap (definitive) + F10.7 obs | GFZ Kp_ap_Ap_SN_F107 | `dsmc/fixtures/hindcast/feb_2022_starlink/historical_ap.csv` | 3 h |
| GRACE-FO neutral density (truth) | TU Delft v02 | `dsmc/fixtures/hindcast/feb_2022_starlink/grace_fo_density.csv` | per-orbit |
| MHD output (Φ_PC, HPI) | BATS-R-US, this run | `data/hindcast/feb_2022_starlink_hindcast.json` | 5 min |
| Pseudo-Ap fit (a, b, c) | this OLS step | `data/hindcast/feb_2022_starlink_pseudo_ap_fit.json` | 1 |

Window: `2022-02-03T00:00Z` → `2022-02-05T00:00Z` (48 h, covers ramp +
storm peak + start of recovery; the SSC is at ~2022-02-03T22:00Z).

## Day 1 — pull the inputs

All three fetchers support `--dry-run` to show the URLs without hitting
the network. Run dry first to confirm proxy/firewall, then for real.

### 1. L1 IMF from OMNI

```sh
cd swmf
python3 -m pipeline.fetch_omni_imf \
  --start 2022-02-03 --end 2022-02-05 \
  --out fixtures/hindcast/feb_2022_starlink/imf_l1.dat -v
```

Sanity check the output:

```sh
wc -l fixtures/hindcast/feb_2022_starlink/imf_l1.dat   # expect ≈ 2880 + 3 header lines
head -5 fixtures/hindcast/feb_2022_starlink/imf_l1.dat
```

The third line should be `#START`; rows after that are
`yr mo dy hr mn sc msec  Bx By Bz  Vx Vy Vz  N T`. SWMF
`#SOLARWINDFILE` directives consume that exact format.

### 2. Historical Ap + F10.7 from GFZ

```sh
cd dsmc
python3 -m pipeline.fetch_historical_indices \
  --start 2022-02-03 --end 2022-02-05 \
  --out fixtures/hindcast/feb_2022_starlink/historical_ap.csv -v
```

Expect 16 rows (8 × 3-hour bins × 2 days). The Ap values should rise
from ~5 on Feb 3 morning to ~50–60 around the SSC and stay elevated
through Feb 4.

### 3. GRACE-FO accelerometer density from TU Delft

The TU Delft URL pattern has shifted across re-processings. Verify the
current path on `http://thermosphere.tudelft.nl/` first (look for
"GRACE-FO" → "Density"), then plug it into the template:

```sh
python3 -m pipeline.fetch_grace_density \
  --start 2022-02-03 --end 2022-02-05 \
  --remote-template 'http://thermosphere.tudelft.nl/acceldata/GraceFO/v02/density/{Y}/grcfo_density_{Y}_{M}_{D}.txt' \
  --out fixtures/hindcast/feb_2022_starlink/grace_fo_density.csv -v
```

If the path 404s (likely; TU Delft re-organises occasionally), pull the
files manually with a browser or `wget -r`, drop them in
`raw/grace_fo/`, and switch to local mode:

```sh
python3 -m pipeline.fetch_grace_density \
  --start 2022-02-03 --end 2022-02-05 \
  --local-glob 'raw/grace_fo/grcfo_density_2022_02_*.txt' \
  --out fixtures/hindcast/feb_2022_starlink/grace_fo_density.csv -v
```

If the column order in the file header differs from
`t,alt_km,lat_deg,lon_deg,density_kg_m3`, pass `--columns` to reorder.

**Day 1 done when:** all three fixture files exist, are non-empty, and
their `head` and `tail` rows make physical sense (densities ~10⁻¹³
kg/m³ at GRACE-FO altitude during quiet, climbing 5–10× during storm
peak).

## Day 2 — run BATS-R-US in hindcast mode, fit the regression

### 4. Generate PARAM.in for the hindcast window

`swmf/pipeline/gen_param.py` already supports a hindcast mode.
Pre-flight against the IMF.dat we just wrote:

```sh
cd swmf
python3 -m pipeline.gen_param \
  --mode hindcast \
  --start 2022-02-03T00:00:00Z --end 2022-02-05T00:00:00Z \
  --imf-file fixtures/hindcast/feb_2022_starlink/imf_l1.dat \
  --out runs/feb_2022_starlink/PARAM.in
```

(Adjust to whatever flags `gen_param.py` actually exposes — the run dir
goes wherever `RUNS_DIR` points; default is `/data/runs`.)

### 5. Launch BATS-R-US

```sh
cd swmf
RUNS_DIR=runs python3 -m pipeline.run_forecast --once \
  --run-dir runs/feb_2022_starlink
```

48 h of simulated time on `MPI_NPROC=4` is a multi-hour wall-clock run.
Tail `runs/feb_2022_starlink/batsrus_stdout.log` for progress; the
runner kills on `IMF_MAX_AGE_MIN` warnings (harmless in hindcast).

### 6. Extract Φ_PC and HPI → write the hindcast JSON

This is the only Phase-0 module not yet written:
`swmf/pipeline/hindcast_runner._load_real_mhd()` currently raises
`NotImplementedError`. The job is to read the BATS-R-US ASCII output
in `runs/feb_2022_starlink/`, integrate the polar-cap potential and
the auroral particle-precipitation power, and emit one row per output
cadence.

Until that's wired, you can short-circuit by hand-converting the
SWMF/IM ionosphere output to the same JSON shape — fields:
`{t, phi_pc_kv, hpi_gw}`. Then save to
`data/hindcast/feb_2022_starlink_hindcast.json`.

After that, re-run the runner so the v0 placeholder regression fills
in `ap_pseudo`:

```sh
cd swmf
python3 -m pipeline.hindcast_runner --event feb_2022_starlink \
  --dry-run --fixtures fixtures/hindcast \
  --out ../data/hindcast
```

(`--dry-run` reads the JSON we just wrote in step 6 — the hand-written
real one — and runs `PseudoApFit` over it.)

### 7. Fit (a, b, c) by OLS against historical Ap

```sh
cd dsmc
python3 -m pipeline.fit_pseudo_ap \
  --hindcast ../data/hindcast/feb_2022_starlink_hindcast.json \
  --historical-ap fixtures/hindcast/feb_2022_starlink/historical_ap.csv \
  --out ../data/hindcast/feb_2022_starlink_pseudo_ap_fit.json -v
```

Read off the formula. **Sanity bounds:** for a real run we expect
`b ∈ [0.2, 0.8]` (Ap per kV of Φ_PC), `c ∈ [0.1, 0.6]` (Ap per GW of
HPI), and R² ≥ 0.7 on a single-event fit. If R² is much lower, either
the BATS-R-US run didn't capture the storm or the Ap pairing is
mistimed (3-hour bins vs 5-min MHD samples → check `_step_lookup`).

Plug the fitted `(a, b, c)` back into
`swmf/pipeline/hindcast_runner.PseudoApFit` (replace the
`v0-placeholder` defaults) and re-run the runner to update
`ap_pseudo` in the hindcast JSON. *(A future refinement: have the
runner accept a `--regression-json` flag so the fit feeds back without
a code edit.)*

**Day 2 done when:** `data/hindcast/feb_2022_starlink_hindcast.json`
contains real `phi_pc_kv`, `hpi_gw`, and post-fit `ap_pseudo`.

## Day 3 — validate, decide, write up

### 8. Score against GRACE-FO truth

```sh
cd dsmc
python3 -m pipeline.validate_density \
  --hindcast ../data/hindcast/feb_2022_starlink_hindcast.json \
  --truth fixtures/hindcast/feb_2022_starlink/grace_fo_density.csv \
  --historical-ap fixtures/hindcast/feb_2022_starlink/historical_ap.csv \
  --out ../data/hindcast -v
```

This must run in an environment with `msise00` installed
(`pip install msise00 sgp4`) — otherwise the inline fallback density
is too crude to compare. Confirm the log line says
`Density backend: pipeline.atmosphere`, not `inline-fallback`.

### 9. Read `data/hindcast/feb_2022_starlink_residuals.md`

The bottom of the file says **PASS** or **FAIL** against the 25 %
storm-time skill gate. Three buckets of outcome:

* **Skill ≥ 25 %:** Phase-0 gate cleared. Commit the hindcast outputs
  (they're under `data/hindcast/`, currently gitignored — copy what's
  reportable into the deck, not the repo). Move to Phase 1: do the
  same workflow for Gannon, then Halloween 2003, then the quiet
  control. If the regression coefficients change wildly across events,
  Phase 1 needs a multi-event joint fit instead of per-event.
* **Skill ≥ 0 % but < 25 %:** the wedge is real but underweight.
  Likely fixes, in priority order: (1) drop the 3-hour Ap step and
  fit against the underlying NOAA H-component magnetometer, which is
  finer-cadence and avoids the bin-edge aliasing in the OLS;
  (2) include solar-wind dynamic pressure in the regression
  (`Pdyn = ρ V²`); (3) tighten the storm-time mask threshold so the
  gate isn't being pulled down by recovery-phase samples where MSIS+Ap
  is actually fine.
* **Skill < 0 %:** candidate is *worse* than baseline. Almost always
  means the BATS-R-US run is wrong (bad PARAM.in, missing IMF gap,
  OMNI sentinel bleed). Check the IMF.dat header lines, replot Bz,
  and re-run.

### 10. One-page write-up

Drop into `MHD_DENSITY_PHASE0_RESULTS.md` (a peer of the plan):

* event window, fitted formula, R² on the fit
* gate result + storm-time skill %
* the residual histogram (eyeball; numpy not required — the JSON has
  per-sample residuals)
* what changed in the regression coefficients vs the v0 placeholder
* the next event we'd run

That doc plus the residuals JSON is what you take into a customer
conversation. Spire and Planet care about per-orbit drag accuracy;
SpaceX cares about the Feb 2022 hindcast specifically. The narrative
is: "here's the actual numbers from the actual storm."

## Re-runnability

Everything between step 1 and step 8 is idempotent. The fetchers
overwrite their output CSVs; the validator overwrites its outputs.
The one non-idempotent thing is the BATS-R-US run itself — clean
`runs/feb_2022_starlink/` before re-running if you change PARAM.in.

## What this does *not* do

* Doesn't refit MSIS internals; we drive MSIS with Ap*, full stop.
* Doesn't account for storm-time composition changes (O/N₂ ratio
  shifts can move ρ at 400 km by another 10–20 % beyond what Ap*
  captures — that's a Phase-2 concern).
* Doesn't touch the satellite-side drag forecast (`drag_forecast.py`).
  Phase 0 is density-vs-truth only; the per-spacecraft product is
  Phase 3.
